package server

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func startEventSession(f *fixture) {
	f.call("POST", f.path("/heartbeat"), f.host, map[string]any{"sessionId": "event-camera", "monitoring": true}, 200)
}

func eventBody(episode, picture string) map[string]any {
	return map[string]any{"sessionId": "event-camera", "episodeId": episode, "level": 0.4, "photo": picture}
}

func (f *fixture) eventHTTPRequest(t *testing.T, path, token string, body any) *http.Request {
	t.Helper()
	data, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	r := httptest.NewRequest("POST", path, bytes.NewReader(data))
	f.authenticateRequest(r, token)
	r.Header.Set("Content-Type", "application/json")
	return r
}

func TestEventRateBudgetRefillsAndIsPerRoom(t *testing.T) {
	f := setup(t)
	startEventSession(f)
	for i := 0; i < 3; i++ {
		f.call("POST", f.path("/events"), f.host, eventBody(fmt.Sprintf("noise-%d", i), ""), 200)
	}
	f.call("POST", f.path("/events"), f.host, eventBody("limited", ""), 429)
	var second struct{ ID, HostToken string }
	decode(t, f.call("POST", "/api/rooms", testOwnerKey, map[string]any{"name": "second"}, 201), &second)
	path := "/api/rooms/" + second.ID
	f.call("POST", path+"/heartbeat", second.HostToken, map[string]any{"sessionId": "event-camera", "monitoring": true}, 200)
	f.call("POST", path+"/events", second.HostToken, eventBody("independent", ""), 200)
	f.now = f.now.Add(499 * time.Millisecond)
	f.call("POST", f.path("/events"), f.host, eventBody("too-early", ""), 429)
	f.now = f.now.Add(time.Millisecond)
	f.call("POST", f.path("/events"), f.host, eventBody("refilled", ""), 200)
	f.call("POST", f.path("/events"), f.host, eventBody("limited-again", ""), 429)
	if f.state()["eventCount"] != float64(4) {
		t.Fatal("rate-limited requests changed history")
	}
}

func TestInvalidEventPhotosConsumeBudgetAndReleaseAdmission(t *testing.T) {
	f := setup(t)
	startEventSession(f)
	for i := 0; i < 3; i++ {
		f.call("POST", f.path("/events"), f.host, eventBody("invalid", "data:image/jpeg;base64,aGVsbG8="), 400)
	}
	f.call("POST", f.path("/events"), f.host, eventBody("limited", photo(40)), 429)
	f.now = f.now.Add(500 * time.Millisecond)
	f.call("POST", f.path("/events"), f.host, eventBody("allowed", photo(40)), 200)
	if f.state()["eventCount"] != float64(1) {
		t.Fatal("invalid pictures were persisted")
	}
}

func TestEventRecentPhotoDoesNotSkipJPEGValidation(t *testing.T) {
	f := setup(t)
	startEventSession(f)
	var first Event
	decode(t, f.call("POST", f.path("/events"), f.host, eventBody("noise", photo(40)), 200), &first)
	data, err := base64.StdEncoding.DecodeString(strings.TrimPrefix(photo(90), "data:image/jpeg;base64,"))
	if err != nil {
		t.Fatal(err)
	}
	corrupt := "data:image/jpeg;base64," + base64.StdEncoding.EncodeToString(data[:len(data)-12])
	f.now = f.now.Add(time.Second)
	f.call("POST", f.path("/events"), f.host, eventBody("noise", corrupt), 400)
	var updated Event
	decode(t, f.call("POST", f.path("/events"), f.host, eventBody("noise", ""), 200), &updated)
	if !updated.LastNoiseAt.After(first.LastNoiseAt) || updated.PhotoAt == nil || !updated.PhotoAt.Equal(*first.PhotoAt) {
		t.Fatal("noise-only update failed to preserve photo and merge noise", first, updated)
	}
}

func TestEventPreparationDoesNotHoldRoomMutex(t *testing.T) {
	f := setup(t)
	startEventSession(f)
	preparing, release := make(chan struct{}), make(chan struct{})
	var calls atomic.Int32
	now := f.now
	f.s.config.Now = func() time.Time {
		// The first clock read checks cookie expiry under lock; the second
		// belongs to event parsing, which must stay outside the room mutex.
		if calls.Add(1) == 2 {
			close(preparing)
			<-release
		}
		return now
	}
	done := make(chan int, 1)
	request := f.eventHTTPRequest(t, f.path("/events"), f.host, eventBody("noise", photo(40)))
	go func() {
		response := httptest.NewRecorder()
		f.s.Handler().ServeHTTP(response, request)
		done <- response.Code
	}()
	defer func() {
		close(release)
		if status := <-done; status != 200 {
			t.Errorf("event status = %d", status)
		}
	}()
	<-preparing
	heartbeat := f.eventHTTPRequest(t, f.path("/heartbeat"), f.host, map[string]any{"sessionId": "event-camera", "monitoring": true})
	fastDone := make(chan int, 1)
	go func() {
		response := httptest.NewRecorder()
		f.s.Handler().ServeHTTP(response, heartbeat)
		fastDone <- response.Code
	}()
	select {
	case status := <-fastDone:
		if status != 200 {
			t.Errorf("heartbeat status = %d", status)
		}
	case <-time.After(time.Second):
		t.Error("event preparation held the shared mutex and blocked heartbeat")
	}
}

func reserveEventForTest(t *testing.T, f *fixture, path, token string) (*http.Request, *eventPayload, *eventReservation) {
	t.Helper()
	r := f.eventHTTPRequest(t, path+"/events", token, eventBody("reserved", photo(60)))
	w := httptest.NewRecorder()
	body := f.s.parseEvent(w, r)
	if body == nil {
		t.Fatal(w.Code, w.Body.String())
	}
	roomID := strings.TrimPrefix(path, "/api/rooms/")
	reservation := f.s.reserveEvent(w, r, roomID, body)
	if reservation == nil {
		t.Fatal(w.Code, w.Body.String())
	}
	t.Cleanup(reservation.release)
	return r, body, reservation
}

// DecodeConfig reads normally; the next read after rewind blocks inside the
// real jpeg.Decode call. No test-only callback is installed on the server.
type gatedJPEGReader struct {
	*bytes.Reader
	decoding bool
	started  chan struct{}
	release  chan struct{}
}

func (r *gatedJPEGReader) Seek(offset int64, whence int) (int64, error) {
	position, err := r.Reader.Seek(offset, whence)
	r.decoding = true
	return position, err
}

func (r *gatedJPEGReader) Read(data []byte) (int, error) {
	if r.decoding {
		r.decoding = false
		close(r.started)
		<-r.release
	}
	return r.Reader.Read(data)
}

func TestEventDecodeReservationDoesNotBlockOtherRooms(t *testing.T) {
	f := setup(t)
	startEventSession(f)
	var other struct{ ID, HostToken string }
	decode(t, f.call("POST", "/api/rooms", testOwnerKey, map[string]any{"name": "other"}, 201), &other)
	otherPath := "/api/rooms/" + other.ID
	f.call("POST", otherPath+"/heartbeat", other.HostToken, map[string]any{"sessionId": "event-camera", "monitoring": true}, 200)
	request, body, reservation := reserveEventForTest(t, f, f.path(""), f.host)
	picture, err := base64.StdEncoding.DecodeString(strings.TrimPrefix(body.Photo, "data:image/jpeg;base64,"))
	if err != nil {
		t.Fatal(err)
	}
	reader := &gatedJPEGReader{Reader: bytes.NewReader(picture), started: make(chan struct{}), release: make(chan struct{})}
	decoded := make(chan error, 1)
	go func() { decoded <- validateEventJPEG(reader) }()
	decoderReleased := false
	defer func() {
		if !decoderReleased {
			close(reader.release)
			if err := <-decoded; err != nil {
				t.Error(err)
			}
		}
	}()
	<-reader.started
	for _, tc := range []struct {
		path, token string
		body        any
		status      int
	}{
		{f.path("/events"), f.host, eventBody("concurrent", ""), 429},
		{f.path("/heartbeat"), f.host, map[string]any{"sessionId": "event-camera", "monitoring": true}, 200},
		{otherPath + "/events", other.HostToken, eventBody("other-room", photo(30)), 200},
	} {
		r := f.eventHTTPRequest(t, tc.path, tc.token, tc.body)
		completed := make(chan int, 1)
		go func() {
			w := httptest.NewRecorder()
			f.s.Handler().ServeHTTP(w, r)
			completed <- w.Code
		}()
		select {
		case status := <-completed:
			if status != tc.status {
				t.Fatalf("during decode %s: status %d, want %d", tc.path, status, tc.status)
			}
		case <-time.After(time.Second):
			t.Fatal("JPEG decoding blocked another request")
		}
	}
	close(reader.release)
	decoderReleased = true
	if err := <-decoded; err != nil {
		t.Fatal(err)
	}
	// Complete through the same commit phase as HTTP and prove admission can be
	// released independently of the lifetime of the response writer.
	w := httptest.NewRecorder()
	f.s.commitEvent(w, request, reservation, body, picture)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	reservation.release()
	f.call("POST", f.path("/events"), f.host, eventBody("after-release", ""), 200)
}

func TestEventPhotoDecodeLimitIsGlobalAndReleasesCapacity(t *testing.T) {
	f := setup(t)
	startEventSession(f)
	type credentials struct{ ID, HostToken string }
	rooms := []credentials{{ID: f.room, HostToken: f.host}}
	for i := 0; i < 4; i++ {
		var created credentials
		decode(t, f.call("POST", "/api/rooms", testOwnerKey, map[string]any{"name": fmt.Sprintf("room-%d", i)}, 201), &created)
		f.call("POST", "/api/rooms/"+created.ID+"/heartbeat", created.HostToken, map[string]any{"sessionId": "event-camera", "monitoring": true}, 200)
		rooms = append(rooms, created)
	}
	var reservations []*eventReservation
	for _, room := range rooms[:4] {
		_, _, reservation := reserveEventForTest(t, f, "/api/rooms/"+room.ID, room.HostToken)
		reservations = append(reservations, reservation)
	}
	fifth := rooms[4]
	path := "/api/rooms/" + fifth.ID + "/events"
	f.call("POST", path, fifth.HostToken, eventBody("limited-photo", photo(40)), 429)
	f.call("POST", path, fifth.HostToken, eventBody("noise-without-photo", ""), 200)
	reservations[0].release()
	f.call("POST", path, fifth.HostToken, eventBody("released-capacity", photo(40)), 200)
}

func TestEventCommitRechecksRoomAuthorizationAndSession(t *testing.T) {
	for _, tc := range []struct {
		name       string
		invalidate func(*fixture)
		status     int
	}{
		{"session-replaced", func(f *fixture) {
			f.call("POST", f.path("/heartbeat"), f.host, map[string]any{"sessionId": "replacement", "monitoring": true}, 200)
		}, 403},
		{"session-retired", func(f *fixture) {
			f.call("POST", f.path("/heartbeat"), f.host, map[string]any{"sessionId": "event-camera", "monitoring": false, "stopped": true}, 200)
		}, 403},
		{"room-deleted", func(f *fixture) {
			f.s.mu.Lock()
			delete(f.s.rooms, f.room)
			f.s.mu.Unlock()
		}, 404},
		{"room-replaced", func(f *fixture) {
			f.s.mu.Lock()
			replacement := *f.s.rooms[f.room]
			f.s.rooms[f.room] = &replacement
			f.s.mu.Unlock()
		}, 403},
		{"host-revoked", func(f *fixture) {
			f.s.mu.Lock()
			f.s.revokeSessionLocked(tokenHash(f.cookie.Value))
			f.s.mu.Unlock()
		}, 401},
		{"server-closed", func(f *fixture) { f.s.Close() }, 503},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := setup(t)
			startEventSession(f)
			request, body, reservation := reserveEventForTest(t, f, f.path(""), f.host)
			picture, err := base64.StdEncoding.DecodeString(strings.TrimPrefix(body.Photo, "data:image/jpeg;base64,"))
			if err != nil || validateEventJPEG(bytes.NewReader(picture)) != nil {
				t.Fatal("invalid test photo", err)
			}
			tc.invalidate(f)
			w := httptest.NewRecorder()
			f.s.commitEvent(w, request, reservation, body, picture)
			if w.Code != tc.status {
				t.Fatalf("commit status %d, want %d: %s", w.Code, tc.status, w.Body.String())
			}
			f.s.mu.Lock()
			count := len(reservation.current.Events)
			f.s.mu.Unlock()
			if count != 0 {
				t.Fatal("invalidated event mutated history")
			}
			photos, err := filepath.Glob(filepath.Join(f.dir, "photos", "*.jpg"))
			if err != nil || len(photos) != 0 {
				t.Fatal("invalidated event saved a photo", photos, err)
			}
		})
	}
}

func TestEventCommitPreservesConcurrentSettings(t *testing.T) {
	f := setup(t)
	startEventSession(f)
	r, body, reservation := reserveEventForTest(t, f, f.path(""), f.host)
	f.call("PUT", f.path("/settings"), f.host, map[string]any{"threshold": 0.12, "snapshotIntervalMs": 10000}, 200)
	w := httptest.NewRecorder()
	f.s.commitEvent(w, r, reservation, body, jpegFrame(60))
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	if f.state()["settings"].(map[string]any)["threshold"] != 0.12 {
		t.Fatal("event commit overwrote concurrent settings")
	}
}
