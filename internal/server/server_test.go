package server

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"

	qrcode "github.com/skip2/go-qrcode"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

type fixture struct {
	cookieMu           sync.Mutex
	cookie             *http.Cookie
	cookieServer       *Server
	t                  *testing.T
	s                  *Server
	now                time.Time
	dir                string
	room, host, viewer string
}

// Legacy fixture calls name the host capability to select an owner request.
// Production authorization never accepts that capability; explicit auth tests
// use raw requests to exercise rejection of leaked host tokens.
func (f *fixture) ensureCookie() *http.Cookie {
	f.cookieMu.Lock()
	defer f.cookieMu.Unlock()
	if f.cookieServer != f.s {
		origin := "http://example.com"
		if f.s.config.PublicURL != "" {
			u, _ := url.Parse(f.s.config.PublicURL)
			origin = u.Scheme + "://" + u.Host
		}
		r := httptest.NewRequest("POST", origin+"/api/auth/login", strings.NewReader(`{"code":"`+testOwnerKey+`"}`))
		r.Header.Set("Origin", origin)
		w := httptest.NewRecorder()
		f.s.Handler().ServeHTTP(w, r)
		if w.Code != 200 {
			f.t.Fatalf("fixture login: %d %s", w.Code, w.Body.String())
		}
		for _, c := range w.Result().Cookies() {
			if c.Name == "barkodd_session" {
				f.cookie = c
			}
		}
		if f.cookie == nil {
			f.t.Fatal("missing fixture cookie")
		}
		f.cookieServer = f.s
	}
	return f.cookie
}
func (f *fixture) authenticateRequest(r *http.Request, token string) {
	origin := "http://" + r.Host
	if f.s.config.PublicURL != "" {
		u, _ := url.Parse(f.s.config.PublicURL)
		origin = u.Scheme + "://" + u.Host
	}
	r.Header.Set("Origin", origin)
	owner := token == testOwnerKey || (f.host != "" && token == f.host)
	if !owner && token != "" {
		f.s.mu.Lock()
		for _, room := range f.s.rooms {
			if room.HostHash == tokenHash(token) {
				owner = true
				break
			}
		}
		f.s.mu.Unlock()
	}
	if owner {
		r.AddCookie(f.ensureCookie())
	} else if token != "" {
		r.Header.Set("Authorization", "Bearer "+token)
	}
}

func setup(t *testing.T) *fixture {
	t.Helper()
	f := &fixture{t: t, now: time.Date(2026, 11, 5, 12, 0, 0, 0, time.UTC), dir: t.TempDir()}
	var err error
	f.s, err = New(Config{DataDir: f.dir, RoomCreationKey: testOwnerKey, Now: func() time.Time { return f.now }})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { f.s.Close() })
	r := f.call("POST", "/api/rooms", testOwnerKey, map[string]any{"name": "Барбос"}, 201)
	var room struct{ ID, HostToken, ViewerToken string }
	decode(t, r, &room)
	f.room, f.host, f.viewer = room.ID, room.HostToken, room.ViewerToken
	if f.room == "" || f.host == "" || f.host == f.viewer {
		t.Fatal("missing or shared credentials")
	}
	return f
}
func TestNoiseSensitivitySettingsPersistAcrossRestart(t *testing.T) {
	for _, threshold := range []float64{0.0005, 0.06, 0.5} {
		t.Run(fmt.Sprint(threshold), func(t *testing.T) {
			f := setup(t)
			if got := f.state()["settings"].(map[string]any)["threshold"]; got != 0.01 {
				t.Errorf("new room threshold = %v, want 0.01", got)
			}
			f.call("PUT", f.path("/settings"), f.host, map[string]any{"threshold": threshold, "snapshotIntervalMs": 30000}, 200)
			for _, invalid := range []float64{0.00049, 0, 0.50001} {
				f.call("PUT", f.path("/settings"), f.host, map[string]any{"threshold": invalid, "snapshotIntervalMs": 30000}, 400)
				if got := f.state()["settings"].(map[string]any)["threshold"]; got != threshold {
					t.Fatalf("rejected threshold %v changed setting to %v", invalid, got)
				}
			}
			if err := f.s.Close(); err != nil {
				t.Fatal(err)
			}
			next, err := New(Config{DataDir: f.dir, RoomCreationKey: testOwnerKey, Now: func() time.Time { return f.now }})
			if err != nil {
				t.Fatal(err)
			}
			f.s = next
			if got := f.state()["settings"].(map[string]any)["threshold"]; got != threshold {
				t.Fatalf("reloaded room threshold = %v, want %v", got, threshold)
			}
		})
	}
}

func (f *fixture) path(s string) string { return "/api/rooms/" + f.room + s }
func (f *fixture) call(method, path, token string, body any, status int) *httptest.ResponseRecorder {
	f.t.Helper()
	var data []byte
	var err error
	if body != nil {
		data, err = json.Marshal(body)
		if err != nil {
			f.t.Fatal(err)
		}
	}
	r := httptest.NewRequest(method, path, bytes.NewReader(data))
	r.RemoteAddr = "192.0.2.1:1234"
	f.authenticateRequest(r, token)
	r.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	f.s.Handler().ServeHTTP(w, r)
	if w.Code != status {
		f.t.Fatalf("%s %s status %d, want %d: %s", method, path, w.Code, status, w.Body.String())
	}
	return w
}
func decode(t *testing.T, w *httptest.ResponseRecorder, v any) {
	t.Helper()
	if err := json.Unmarshal(w.Body.Bytes(), v); err != nil {
		t.Fatal(err)
	}
}
func (f *fixture) state() map[string]any {
	r := f.call("GET", f.path(""), f.viewer, nil, 200)
	var v map[string]any
	decode(f.t, r, &v)
	return v
}
func photo(red uint8) string {
	im := image.NewRGBA(image.Rect(0, 0, 8, 8))
	for y := 0; y < 8; y++ {
		for x := 0; x < 8; x++ {
			im.Set(x, y, color.RGBA{R: red, A: 255})
		}
	}
	var b bytes.Buffer
	jpeg.Encode(&b, im, nil)
	return "data:image/jpeg;base64," + base64.StdEncoding.EncodeToString(b.Bytes())
}
func (f *fixture) event(id string, pic string) map[string]any {
	f.call("POST", f.path("/heartbeat"), f.host, map[string]any{"sessionId": "test-camera", "monitoring": true}, 200)
	b := map[string]any{"sessionId": "test-camera", "episodeId": id, "level": 0.3}
	if pic != "" {
		b["photo"] = pic
	}
	r := f.call("POST", f.path("/events"), f.host, b, 200)
	var v map[string]any
	decode(f.t, r, &v)
	return v
}

// Rejecting a viewer write must leave both settings and history untouched.
func TestRoleSeparationAndPairingRevocation(t *testing.T) {
	f := setup(t)
	f.call("GET", f.path(""), "", nil, 401)
	f.call("GET", f.path(""), "wrong", nil, 401)
	for _, route := range []string{"/events", "/heartbeat", "/pairing", "/qr"} {
		f.call("POST", f.path(route), f.viewer, map[string]any{}, 403)
	}
	f.call("PUT", f.path("/settings"), f.viewer, map[string]any{"threshold": 0.1, "snapshotIntervalMs": 10000}, 403)
	f.call("PUT", f.path("/settings"), f.host, map[string]any{"threshold": 0.12, "snapshotIntervalMs": 10000}, 200)
	if f.state()["settings"].(map[string]any)["threshold"] != 0.12 {
		t.Fatal("settings not applied")
	}
	r := f.call("POST", f.path("/pairing"), f.host, nil, 200)
	var v struct{ ViewerToken string }
	decode(t, r, &v)
	f.call("GET", f.path(""), f.viewer, nil, 401)
	f.viewer = v.ViewerToken
	f.state()
}

func TestHeartbeatExpiresAndRestartDoesNotAppearOnline(t *testing.T) {
	f := setup(t)
	if f.state()["online"] != false {
		t.Fatal("new room online")
	}
	f.call("POST", f.path("/heartbeat"), f.host, map[string]any{"monitoring": true, "sessionId": "session-one"}, 200)
	if s := f.state(); s["online"] != true || s["monitoring"] != true || s["sessionId"] != "session-one" {
		t.Fatal(s)
	}
	f.now = f.now.Add(16 * time.Second)
	if s := f.state(); s["online"] != false || s["monitoring"] != false {
		t.Fatal(s)
	}
	f.call("POST", f.path("/heartbeat"), f.host, map[string]any{"monitoring": true, "sessionId": "session-two"}, 200)
	f.s.Close()
	var err error
	f.s, err = New(Config{DataDir: f.dir, RoomCreationKey: testOwnerKey, Now: func() time.Time { return f.now }})
	if err != nil {
		t.Fatal(err)
	}
	if s := f.state(); s["online"] != false || s["monitoring"] != false {
		t.Fatal("restart kept live state", s)
	}
}

func TestEventMergePhotosAndPersistence(t *testing.T) {
	f := setup(t)
	first := f.event("episode-one", photo(30))
	photoAt := first["photoAt"]
	f.now = f.now.Add(2 * time.Second)
	second := f.event("episode-one", photo(60))
	if second["id"] != first["id"] || second["photoAt"] == photoAt || second["lastNoiseAt"] == first["lastNoiseAt"] {
		t.Fatal(first, second)
	}
	f.now = f.now.Add(2 * time.Second)
	third := f.event("episode-two", photo(90))
	if third["hasPhoto"] != true {
		t.Fatal("a recent photo blocked a new episode photo")
	}
	f.now = f.now.Add(30 * time.Second)
	fourth := f.event("episode-one", photo(120))
	if fourth["photoAt"] == photoAt {
		t.Fatal("photo never refreshed")
	}
	f.now = f.now.Add(time.Second)
	fifth := f.event("episode-one", "")
	if fifth["photoAt"] != fourth["photoAt"] {
		t.Fatal("photo timestamp changed without photo")
	}
	id := first["id"].(string)
	r := f.call("GET", f.path("/events/"+id+"/photo"), f.viewer, nil, 200)
	if r.Header().Get("Cache-Control") != "no-store" || r.Header().Get("Content-Type") != "image/jpeg" {
		t.Fatal(r.Header())
	}
	if _, err := jpeg.Decode(bytes.NewReader(r.Body.Bytes())); err != nil {
		t.Fatal(err)
	}
	f.s.Close()
	var err error
	f.s, err = New(Config{DataDir: f.dir, RoomCreationKey: testOwnerKey, Now: func() time.Time { return f.now }})
	if err != nil {
		t.Fatal(err)
	}
	s := f.state()
	if s["eventCount"] != float64(2) || s["lastNoiseAt"] != fifth["lastNoiseAt"] {
		t.Fatal(s)
	}
	f.call("GET", f.path("/events/"+id+"/photo"), f.viewer, nil, 200)
	files, _ := filepath.Glob(filepath.Join(f.dir, "*.json"))
	for _, file := range files {
		b, _ := os.ReadFile(file)
		if bytes.Contains(b, []byte(f.host)) || bytes.Contains(b, []byte(f.viewer)) {
			t.Fatal("plaintext credentials on disk")
		}
	}
}

func TestValidationRejectsBadBodiesAndImages(t *testing.T) {
	f := setup(t)
	f.call("POST", f.path("/heartbeat"), f.host, map[string]any{"sessionId": "test-camera", "monitoring": true}, 200)
	for _, body := range []any{map[string]any{"threshold": 0, "snapshotIntervalMs": 30000}, map[string]any{"threshold": 0.1, "snapshotIntervalMs": 1}, map[string]any{"threshold": 0.1}} {
		f.call("PUT", f.path("/settings"), f.host, body, 400)
	}
	for _, body := range []any{map[string]any{"sessionId": "test-camera", "episodeId": "../bad", "level": 0.1}, map[string]any{"sessionId": "test-camera", "episodeId": "fine", "level": 2}, map[string]any{"sessionId": "test-camera", "episodeId": "fine", "level": 0.2, "photo": "data:image/jpeg;base64,aGVsbG8="}, map[string]any{"sessionId": "test-camera", "episodeId": "fine", "level": 0.2, "photo": "data:image/png;base64,aGVsbG8="}} {
		f.call("POST", f.path("/events"), f.host, body, 400)
	}
	f.call("POST", f.path("/events"), f.host, map[string]any{"sessionId": "test-camera", "episodeId": "fine", "level": 0.2, "photo": "data:image/jpeg;base64," + base64.StdEncoding.EncodeToString(make([]byte, 401*1024))}, 413)
	f.call("POST", f.path("/heartbeat"), f.host, map[string]any{"monitoring": true}, 400)
	r := httptest.NewRequest("POST", "/api/rooms", strings.NewReader(`{"name":"ok"} {"name":"second"}`))
	f.authenticateRequest(r, testOwnerKey)
	w := httptest.NewRecorder()
	f.s.Handler().ServeHTTP(w, r)
	if w.Code != 400 {
		t.Fatal("trailing JSON accepted", w.Code)
	}
	if f.state()["eventCount"] != float64(0) {
		t.Fatal("invalid request mutated history")
	}
}

func TestRetentionRemovesOldAndExcessEventsAndPhotos(t *testing.T) {
	f := setup(t)
	old := f.event("old", photo(30))
	f.now = f.now.Add(8 * 24 * time.Hour)
	if f.state()["eventCount"] != float64(0) {
		t.Fatal("expired history returned")
	}
	f.call("GET", f.path("/events/"+old["id"].(string)+"/photo"), f.viewer, nil, 404)
	first := f.event("event-0", "")
	for i := 1; i <= 200; i++ {
		f.now = f.now.Add(time.Second)
		f.event(fmt.Sprintf("event-%d", i), "")
	}
	s := f.state()
	if s["eventCount"] != float64(200) {
		t.Fatal(s["eventCount"])
	}
	for _, event := range s["events"].([]any) {
		if event.(map[string]any)["id"] == first["id"] {
			t.Fatal("oldest event not evicted")
		}
	}
}

func TestQRConfiguration(t *testing.T) {
	f := setup(t)
	f.call("POST", f.path("/qr"), f.host, map[string]any{"viewerToken": f.viewer, "origin": "javascript:alert(1)"}, 400)
	f.call("POST", f.path("/qr"), f.host, map[string]any{"viewerToken": "wrong", "origin": "https://example.com"}, 400)
	r := f.call("POST", f.path("/qr"), f.host, map[string]any{"viewerToken": f.viewer, "origin": "https://example.com"}, 200)
	if _, err := png.Decode(bytes.NewReader(r.Body.Bytes())); err != nil {
		t.Fatal(err)
	}
}

func TestCorruptStorageFailsClosed(t *testing.T) {
	f := setup(t)
	f.s.Close()
	files, err := filepath.Glob(filepath.Join(f.dir, "*.json"))
	if err != nil || len(files) == 0 {
		t.Fatal("no persistence file")
	}
	if err = os.WriteFile(files[0], []byte(`{broken`), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err = New(Config{DataDir: f.dir, RoomCreationKey: testOwnerKey}); err == nil {
		t.Fatal("corrupt data silently discarded")
	}
}

func TestRoomCapacityLimitAndConcurrentAccess(t *testing.T) {
	f := setup(t)
	limited := false
	for i := 0; i < maxRooms; i++ {
		r := httptest.NewRequest("POST", "/api/rooms", strings.NewReader(`{"name":"test"}`))
		f.authenticateRequest(r, testOwnerKey)
		r.RemoteAddr = "192.0.2.1:9999"
		w := httptest.NewRecorder()
		f.s.Handler().ServeHTTP(w, r)
		if w.Code == 429 {
			limited = true
			break
		}
		if w.Code != 201 {
			t.Fatal(w.Code, w.Body.String())
		}
	}
	if !limited {
		t.Fatal("no room capacity limit")
	}
	var wg sync.WaitGroup
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			r := httptest.NewRequest("GET", f.path(""), nil)
			r.Header.Set("Authorization", "Bearer "+f.viewer)
			w := httptest.NewRecorder()
			f.s.Handler().ServeHTTP(w, r)
			if w.Code != http.StatusOK {
				t.Error(w.Code)
			}
		}()
	}
	wg.Wait()
}

func TestDelayedUploadPreservesCaptureTimeAndCannotRegressNoise(t *testing.T) {
	f := setup(t)
	f.call("POST", f.path("/heartbeat"), f.host, map[string]any{"sessionId": "test-camera", "monitoring": true}, 200)
	captured := f.now.Add(-10 * time.Minute)
	send := func(detected, photographed time.Time, picture string, status int) map[string]any {
		body := map[string]any{"sessionId": "test-camera", "episodeId": "delayed", "level": 0.2, "detectedAt": detected.Format(time.RFC3339Nano)}
		if picture != "" {
			body["photo"] = picture
			body["photoAt"] = photographed.Format(time.RFC3339Nano)
		}
		r := f.call("POST", f.path("/events"), f.host, body, status)
		var event map[string]any
		decode(t, r, &event)
		return event
	}
	first := send(captured, captured, photo(40), 200)
	if first["startedAt"] != captured.Format(time.RFC3339Nano) || first["lastNoiseAt"] != first["startedAt"] || first["photoAt"] != first["startedAt"] {
		t.Fatal(first)
	}
	newer := captured.Add(5 * time.Minute)
	f.now = f.now.Add(31 * time.Second)
	second := send(newer, newer, photo(70), 200)
	f.now = f.now.Add(31 * time.Second)
	older := send(captured.Add(time.Minute), captured, photo(20), 200)
	if older["lastNoiseAt"] != second["lastNoiseAt"] || older["photoAt"] != second["photoAt"] || f.state()["lastNoiseAt"] != second["lastNoiseAt"] {
		t.Fatal("late retry regressed timestamps", second, older)
	}
	send(f.now.Add(-25*time.Hour), captured, "", 400)
	send(f.now.Add(time.Minute), captured, "", 400)
	send(f.now, f.now.Add(time.Minute), photo(30), 400)
}

func TestStartupPrunesExpiredPhotosWithoutRoomRead(t *testing.T) {
	f := setup(t)
	f.event("expired", photo(30))
	f.s.Close()
	f.now = f.now.Add(8 * 24 * time.Hour)
	var err error
	f.s, err = New(Config{DataDir: f.dir, RoomCreationKey: testOwnerKey, Now: func() time.Time { return f.now }})
	if err != nil {
		t.Fatal(err)
	}
	photos, err := filepath.Glob(filepath.Join(f.dir, "photos", "*.jpg"))
	if err != nil || len(photos) != 0 {
		t.Fatal("startup retained expired photos", photos, err)
	}
}

func TestFailedPersistenceDoesNotMutateLiveStateOrLeakPhoto(t *testing.T) {
	f := setup(t)
	f.call("POST", f.path("/heartbeat"), f.host, map[string]any{"sessionId": "test-camera", "monitoring": true}, 200)
	path := filepath.Join(f.dir, f.room+".json")
	previous, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if err = os.Rename(path, path+".backup"); err != nil {
		t.Fatal(err)
	}
	if err = os.Mkdir(path, 0700); err != nil {
		t.Fatal(err)
	}
	f.call("PUT", f.path("/settings"), f.host, map[string]any{"threshold": 0.4, "snapshotIntervalMs": 10000}, 500)
	f.call("POST", f.path("/events"), f.host, map[string]any{"sessionId": "test-camera", "episodeId": "failed", "level": 0.2, "photo": photo(40)}, 500)
	state := f.state()
	if state["settings"].(map[string]any)["threshold"] != 0.01 || state["eventCount"] != float64(0) {
		t.Fatal("failed save changed live data", state)
	}
	photos, err := filepath.Glob(filepath.Join(f.dir, "photos", "*.jpg"))
	if err != nil || len(photos) != 0 {
		t.Fatal("failed save leaked photo", photos, err)
	}
	backup, err := os.ReadFile(path + ".backup")
	if err != nil || !bytes.Equal(previous, backup) {
		t.Fatal("previous state damaged", err)
	}
}

func TestDelayedStopCannotStopNewCameraSession(t *testing.T) {
	f := setup(t)
	f.call("POST", f.path("/heartbeat"), f.host, map[string]any{"monitoring": true, "sessionId": "old-session"}, 200)
	f.now = f.now.Add(time.Second)
	f.call("POST", f.path("/heartbeat"), f.host, map[string]any{"monitoring": true, "sessionId": "new-session"}, 200)
	lastSeen := f.state()["lastSeenAt"]
	f.now = f.now.Add(time.Second)
	f.call("POST", f.path("/heartbeat"), f.host, map[string]any{"monitoring": false, "sessionId": "old-session"}, 200)
	state := f.state()
	if state["monitoring"] != true || state["sessionId"] != "new-session" || state["lastSeenAt"] != lastSeen {
		t.Fatal("delayed stop changed new session", state)
	}
	f.call("POST", f.path("/heartbeat"), f.host, map[string]any{"monitoring": false, "sessionId": "new-session"}, 200)
	if f.state()["monitoring"] != false {
		t.Fatal("current session cannot stop")
	}
}

func TestPairingVersionPersists(t *testing.T) {
	f := setup(t)
	if f.state()["pairingVersion"] != float64(1) {
		t.Fatal("new pairing version missing")
	}
	r := f.call("POST", f.path("/pairing"), f.host, nil, 200)
	var result struct{ ViewerToken string }
	decode(t, r, &result)
	f.viewer = result.ViewerToken
	if f.state()["pairingVersion"] != float64(2) {
		t.Fatal("rotation did not change pairing version")
	}
	f.s.Close()
	var err error
	f.s, err = New(Config{DataDir: f.dir, RoomCreationKey: testOwnerKey, Now: func() time.Time { return f.now }})
	if err != nil {
		t.Fatal(err)
	}
	if f.state()["pairingVersion"] != float64(2) {
		t.Fatal("restart lost pairing version")
	}

}

func TestLateHeartbeatCannotReviveRetiredSession(t *testing.T) {
	for _, scenario := range []string{"stopped", "replaced", "stop-before-first-start"} {
		t.Run(scenario, func(t *testing.T) {
			f := setup(t)
			beat := func(id string, monitoring bool) {
				f.call("POST", f.path("/heartbeat"), f.host, map[string]any{"sessionId": id, "monitoring": monitoring, "stopped": !monitoring}, 200)
			}
			switch scenario {
			case "stopped":
				beat("old-session", true)
				beat("old-session", false)
			case "replaced":
				beat("old-session", true)
				beat("new-session", true)
			case "stop-before-first-start":
				beat("old-session", false)
			}
			before := f.state()
			f.now = f.now.Add(time.Second)
			beat("old-session", true)
			after := f.state()
			for _, key := range []string{"sessionId", "lastSeenAt", "monitoring"} {
				if before[key] != after[key] {
					t.Fatalf("retired heartbeat changed %s: %v -> %v", key, before[key], after[key])
				}
			}
		})
	}
}

func TestSuspendedCameraSessionCanResumeUntilTerminalStop(t *testing.T) {
	f := setup(t)
	beat := func(monitoring bool) {
		f.call("POST", f.path("/heartbeat"), f.host, map[string]any{"sessionId": "camera-session", "monitoring": monitoring}, 200)
	}
	beat(true)
	beat(false)
	if f.state()["monitoring"] != false {
		t.Fatal("suspension still shown as monitoring")
	}
	beat(true)
	if f.state()["monitoring"] != true {
		t.Fatal("temporary suspension permanently retired session")
	}
	f.call("POST", f.path("/heartbeat"), f.host, map[string]any{"sessionId": "camera-session", "monitoring": true, "stopped": true}, 400)
	if f.state()["monitoring"] != true {
		t.Fatal("contradictory stop changed live session")
	}
	f.call("POST", f.path("/heartbeat"), f.host, map[string]any{"sessionId": "camera-session", "monitoring": false, "stopped": true}, 200)
	beat(true)
	if f.state()["monitoring"] != false {
		t.Fatal("terminal stop permitted stale resume")
	}
}

func TestSlowRequestBodyDoesNotBlockAuthenticatedState(t *testing.T) {
	for _, route := range []string{"create", "heartbeat", "events", "settings"} {
		t.Run(route, func(t *testing.T) {
			f := setup(t)
			reader, writer := io.Pipe()
			path, method := f.path("/"+route), "POST"
			if route == "create" {
				path = "/api/rooms"
			}
			if route == "settings" {
				method = "PUT"
			}
			request := httptest.NewRequest(method, path, reader)
			request.Header.Set("Origin", "http://example.com")
			request.Header.Set("Content-Type", "application/json")
			if route != "create" {
				f.authenticateRequest(request, f.host)
			}
			slowDone := make(chan struct{})
			go func() { defer close(slowDone); f.s.Handler().ServeHTTP(httptest.NewRecorder(), request) }()
			defer func() { writer.CloseWithError(io.ErrUnexpectedEOF); <-slowDone }()
			if _, err := writer.Write([]byte(`{"`)); err != nil {
				t.Fatal(err)
			}
			fastDone := make(chan int, 1)
			go func() {
				request := httptest.NewRequest("GET", f.path(""), nil)
				request.Header.Set("Authorization", "Bearer "+f.viewer)
				response := httptest.NewRecorder()
				f.s.Handler().ServeHTTP(response, request)
				fastDone <- response.Code
			}()
			select {
			case status := <-fastDone:
				if status != 200 {
					t.Fatal(status)
				}
			case <-time.After(time.Second):
				t.Error("partial request blocked authenticated state")
			}
		})
	}
}

type gatedResponse struct {
	*httptest.ResponseRecorder
	writing chan struct{}
	release chan struct{}
}

func (w *gatedResponse) Write(data []byte) (int, error) {
	close(w.writing)
	<-w.release
	return w.ResponseRecorder.Write(data)
}

func TestSlowResponseDoesNotBlockHeartbeat(t *testing.T) {
	f := setup(t)
	response := &gatedResponse{ResponseRecorder: httptest.NewRecorder(), writing: make(chan struct{}), release: make(chan struct{})}
	request := httptest.NewRequest("GET", f.path(""), nil)
	request.Header.Set("Authorization", "Bearer "+f.viewer)
	slowDone := make(chan struct{})
	go func() { defer close(slowDone); f.s.Handler().ServeHTTP(response, request) }()
	defer func() { close(response.release); <-slowDone }()
	<-response.writing
	fastDone := make(chan int, 1)
	go func() {
		request := httptest.NewRequest("POST", f.path("/heartbeat"), strings.NewReader(`{"monitoring":true,"sessionId":"active"}`))
		f.authenticateRequest(request, f.host)
		request.Header.Set("Content-Type", "application/json")
		out := httptest.NewRecorder()
		f.s.Handler().ServeHTTP(out, request)
		fastDone <- out.Code
	}()
	select {
	case status := <-fastDone:
		if status != 200 {
			t.Fatal(status)
		}
	case <-time.After(time.Second):
		t.Error("slow response blocked heartbeat")
	}
}

// The QR must point at the externally visible directory even though the proxy
// strips that directory from requests before they reach the server.
func TestQRPreservesPublicSubpath(t *testing.T) {
	for _, publicURL := range []string{"https://dog.example.com/barkodd", "https://dog.example.com/barkodd/", "https://dog.example.com"} {
		t.Run(publicURL, func(t *testing.T) {
			f := setup(t)
			f.s.Close()
			next, err := New(Config{DataDir: f.dir, RoomCreationKey: testOwnerKey, PublicURL: publicURL})
			if err != nil {
				t.Fatal(err)
			}
			f.s = next
			response := f.call("POST", f.path("/qr"), f.host, map[string]any{"viewerToken": f.viewer, "origin": "https://ignored.example"}, 200)
			prefix := "https://dog.example.com/"
			if strings.Contains(publicURL, "barkodd") {
				prefix += "barkodd/"
			}
			expected, err := qrcode.Encode(prefix+"?role=viewer#key="+url.QueryEscape(f.viewer)+"&room="+url.QueryEscape(f.room), qrcode.Medium, 320)
			if err != nil {
				t.Fatal(err)
			}
			if !bytes.Equal(response.Body.Bytes(), expected) {
				t.Fatal("QR does not encode the public pairing URL")
			}
		})
	}
}

func TestPublicURLRejectsUnsafeSubpaths(t *testing.T) {
	for _, publicURL := range []string{
		"https://user:password@example.com/barkodd/", "https://example.com/barkodd/?x=1", "https://example.com/barkodd/#key=secret",
		"https://example.com/barkodd/../other", "https://example.com/barkodd/./", "https://example.com/barkodd//other",
		"https://example.com/barkodd/%2e%2e/other", "https://example.com/barkodd%2fother", "https://example.com/barkodd%5cother", "https://example.com/barkodd%252fother",
		"https://example.com/barkodd/?", "https://example.com/barkodd/#", "https://example.com/barkodd/with space", "https://example.com/barkodd/\\other",
	} {
		t.Run(publicURL, func(t *testing.T) {
			s, err := New(Config{DataDir: t.TempDir(), RoomCreationKey: testOwnerKey, PublicURL: publicURL})
			if err == nil {
				s.Close()
				t.Fatal("accepted unsafe PUBLIC_URL")
			}
		})
	}
}
