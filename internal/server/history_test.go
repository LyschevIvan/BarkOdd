package server

import (
	"github.com/coder/websocket"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func restartHistoryServer(t *testing.T, f *fixture) {
	t.Helper()
	if err := f.s.Close(); err != nil {
		t.Fatal(err)
	}
	next, err := New(Config{DataDir: f.dir, RoomCreationKey: testOwnerKey, Now: func() time.Time { return f.now }})
	if err != nil {
		t.Fatal(err)
	}
	f.s = next
}

func historyBeat(f *fixture, session string, monitoring, stopped bool, status int) {
	f.t.Helper()
	f.call("POST", f.path("/heartbeat"), f.host, map[string]any{"sessionId": session, "monitoring": monitoring, "stopped": stopped}, status)
}

func assertHistoryEmpty(t *testing.T, f *fixture) {
	t.Helper()
	state := f.state()
	if state["eventCount"] != float64(0) || state["lastNoiseAt"] != nil {
		t.Fatal("history not empty", state)
	}
}

func TestHistoryClearRequiresOwnerAndKeepsRoomRunning(t *testing.T) {
	f := setup(t)
	old := f.event("old", photo(30))
	original := f.state()
	f.call("DELETE", f.path("/events"), "", nil, 401)
	f.call("DELETE", f.path("/events"), f.viewer, nil, 403)
	if f.state()["eventCount"] != float64(1) {
		t.Fatal("unauthorized clear changed history")
	}
	f.now = f.now.Add(time.Second)
	var cleared struct {
		OK             bool `json:"ok"`
		CleanupPending bool `json:"cleanupPending"`
	}
	decode(t, f.call("DELETE", f.path("/events"), f.host, nil, 200), &cleared)
	if !cleared.OK || cleared.CleanupPending {
		t.Fatal("unexpected clear result", cleared)
	}
	assertHistoryEmpty(t, f)
	state := f.state()
	for _, field := range []string{"sessionId", "monitoring", "pairingVersion", "online"} {
		if state[field] != original[field] {
			t.Fatalf("clear changed %s", field)
		}
	}
	f.call("GET", f.path("/events/"+old["id"].(string)+"/photo"), f.viewer, nil, 404)
	files, _ := filepath.Glob(filepath.Join(f.dir, "photos", "*.jpg"))
	if len(files) != 0 {
		t.Fatal("clear left photo", files)
	}
	f.now = f.now.Add(time.Second)
	next := f.event("new", photo(40))
	if next["hasPhoto"] != false {
		t.Fatal("manual clear reset photo cooldown", next)
	}
	restartHistoryServer(t, f)
	if f.state()["eventCount"] != float64(1) {
		t.Fatal("history change not persisted")
	}
}

func TestHistoryResetsOnlyOnNewMonitoringStart(t *testing.T) {
	f := setup(t)
	old := f.event("old", photo(30))
	historyBeat(f, "test-camera", false, false, 200)
	historyBeat(f, "test-camera", true, false, 200)
	f.now = f.now.Add(time.Minute)
	historyBeat(f, "test-camera", true, false, 200)
	if f.state()["eventCount"] != float64(1) {
		t.Fatal("pause or reconnect cleared history")
	}
	restartHistoryServer(t, f)
	historyBeat(f, "test-camera", true, false, 200)
	if f.state()["eventCount"] != float64(1) {
		t.Fatal("server restart cleared same camera session")
	}
	historyBeat(f, "test-camera", false, true, 200)
	if f.state()["eventCount"] != float64(1) {
		t.Fatal("stop cleared history")
	}
	historyBeat(f, "new-camera", false, false, 200)
	if f.state()["eventCount"] != float64(1) {
		t.Fatal("unhealthy new source cleared history")
	}
	historyBeat(f, "new-camera", true, false, 200)
	assertHistoryEmpty(t, f)
	f.call("GET", f.path("/events/"+old["id"].(string)+"/photo"), f.viewer, nil, 404)
	var next map[string]any
	decode(t, f.call("POST", f.path("/events"), f.host, map[string]any{"sessionId": "new-camera", "episodeId": "new", "level": 0.3, "photo": photo(60)}, 200), &next)
	if next["hasPhoto"] != true {
		t.Fatal("new session could not capture first photo", next)
	}
	historyBeat(f, "test-camera", true, false, 200)
	if state := f.state(); state["eventCount"] != float64(1) || state["sessionId"] != "new-camera" {
		t.Fatal("old heartbeat reset new session", state)
	}
	restartHistoryServer(t, f)
	historyBeat(f, "test-camera", true, false, 200)
	if f.state()["eventCount"] != float64(1) {
		t.Fatal("old heartbeat reset new session after restart")
	}
	historyBeat(f, "new-camera", true, false, 200)
	if f.state()["eventCount"] != float64(1) {
		t.Fatal("same session lost history after restart")
	}
}

func TestHistoryClearDiscardsDelayedNoiseAndOldPhoto(t *testing.T) {
	f := setup(t)
	startEventSession(f)
	oldAt := f.now
	f.call("POST", f.path("/events"), f.host, eventBody("old", photo(30)), 200)
	f.now = f.now.Add(time.Minute)
	f.call("DELETE", f.path("/events"), f.host, nil, 200)
	restartHistoryServer(t, f)
	historyBeat(f, "event-camera", true, false, 200)
	f.now = f.now.Add(time.Second)
	body := eventBody("old", photo(40))
	body["detectedAt"], body["photoAt"] = oldAt, oldAt
	var result map[string]any
	decode(t, f.call("POST", f.path("/events"), f.host, body, 200), &result)
	if result["discarded"] != true {
		t.Fatal("old queued noise not discarded", result)
	}
	assertHistoryEmpty(t, f)
	body["detectedAt"] = f.now
	decode(t, f.call("POST", f.path("/events"), f.host, body, 200), &result)
	if result["photoDiscarded"] != true || result["hasPhoto"] != false || f.state()["eventCount"] != float64(1) {
		t.Fatal("new noise did not discard only old photo", result)
	}
	body["photoAt"] = f.now
	result = nil
	decode(t, f.call("POST", f.path("/events"), f.host, body, 200), &result)
	if result["hasPhoto"] != true || result["photoDiscarded"] == true {
		t.Fatal("discarded photo consumed cooldown", result)
	}
}

func TestHistoryClearInvalidatesAlreadyReservedEvent(t *testing.T) {
	f := setup(t)
	startEventSession(f)
	request, body, reservation := reserveEventForTest(t, f, f.path(""), f.host)
	// Even an accepted future client clock cannot resurrect an upload already in flight.
	body.detectedAt, body.photoAt = f.now.Add(4*time.Second), f.now.Add(4*time.Second)
	f.call("DELETE", f.path("/events"), f.host, nil, 200)
	response := httptest.NewRecorder()
	f.s.commitEvent(response, request, reservation, body, jpegFrame(40))
	var result map[string]any
	decode(t, response, &result)
	if response.Code != 200 || result["discarded"] != true {
		t.Fatal("reserved event survived clear", response.Code, result)
	}
	assertHistoryEmpty(t, f)
	files, _ := filepath.Glob(filepath.Join(f.dir, "photos", "*.jpg"))
	if len(files) != 0 {
		t.Fatal("reserved upload restored photo", files)
	}
}

func TestHistoryClearAndNewStartPreserveStateOnSaveFailure(t *testing.T) {
	f := setup(t)
	old := f.event("old", photo(30))
	path := filepath.Join(f.dir, f.room+".json")
	if err := os.Rename(path, path+".backup"); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(path, 0700); err != nil {
		t.Fatal(err)
	}
	f.call("DELETE", f.path("/events"), f.host, nil, 500)
	historyBeat(f, "replacement", true, false, 500)
	if state := f.state(); state["eventCount"] != float64(1) || state["sessionId"] != "test-camera" || state["lastNoiseAt"] != old["lastNoiseAt"] {
		t.Fatal("failed save mutated room", state)
	}
	f.call("GET", f.path("/events/"+old["id"].(string)+"/photo"), f.viewer, nil, 200)
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(path+".backup", path); err != nil {
		t.Fatal(err)
	}
	historyBeat(f, "test-camera", true, false, 200)
	if f.state()["monitoring"] != true {
		t.Fatal("failed new start retired old source")
	}
}

func TestHistoryClearRetriesPhotoCleanupAfterRestart(t *testing.T) {
	f := setup(t)
	f.event("old", photo(20))
	files, _ := filepath.Glob(filepath.Join(f.dir, "photos", "*.jpg"))
	path := files[0]
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(path, 0700); err != nil {
		t.Fatal(err)
	}
	blocker := filepath.Join(path, "blocker")
	if err := os.WriteFile(blocker, []byte("x"), 0600); err != nil {
		t.Fatal(err)
	}
	var result struct {
		OK             bool `json:"ok"`
		CleanupPending bool `json:"cleanupPending"`
	}
	decode(t, f.call("DELETE", f.path("/events"), f.host, nil, 200), &result)
	if !result.OK || !result.CleanupPending {
		t.Fatal("photo cleanup failure hidden", result)
	}
	assertHistoryEmpty(t, f)
	restartHistoryServer(t, f)
	if err := os.Remove(blocker); err != nil {
		t.Fatal(err)
	}
	f.now = f.now.Add(time.Minute)
	fresh := f.event("fresh", photo(70))
	if fresh["hasPhoto"] != true {
		t.Fatal("new photo missing", fresh)
	}
	if err := f.s.sweep(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatal("old photo cleanup not retried", err)
	}
	f.call("GET", f.path("/events/"+fresh["id"].(string)+"/photo"), f.viewer, nil, 200)
}

func TestHistoryClearUsesPreciseTimestampBoundary(t *testing.T) {
	f := setup(t)
	startEventSession(f)
	f.now = f.now.Add(250 * time.Microsecond)
	f.call("DELETE", f.path("/events"), f.host, nil, 200)
	for _, detectedAt := range []time.Time{f.now.Truncate(time.Millisecond), f.now} {
		body := eventBody("boundary", "")
		body["detectedAt"] = detectedAt
		var result map[string]any
		decode(t, f.call("POST", f.path("/events"), f.host, body, 200), &result)
		if result["discarded"] != true {
			t.Fatal("clear boundary allowed old sample", detectedAt, result)
		}
	}
	f.now = f.now.Add(time.Millisecond)
	body := eventBody("after-boundary", "")
	body["detectedAt"] = f.now.Truncate(time.Millisecond)
	var result map[string]any
	decode(t, f.call("POST", f.path("/events"), f.host, body, 200), &result)
	if result["id"] == nil || result["discarded"] == true {
		t.Fatal("new millisecond sample discarded", result)
	}
}

func TestHistoryNewStartAcceptsSamplesCapturedBeforeHeartbeat(t *testing.T) {
	f := setup(t)
	f.event("old", photo(20))
	capturedAt := f.now.Add(time.Second)
	f.now = f.now.Add(2 * time.Second)
	historyBeat(f, "new-camera", true, false, 200)
	body := map[string]any{"sessionId": "new-camera", "episodeId": "new", "level": 0.4, "detectedAt": capturedAt, "photoAt": capturedAt, "photo": photo(80)}
	var result map[string]any
	decode(t, f.call("POST", f.path("/events"), f.host, body, 200), &result)
	if result["hasPhoto"] != true || f.state()["eventCount"] != float64(1) {
		t.Fatal("queued initial sample discarded", result)
	}
}

func TestHistoryClearPreservesConnectedVideoStream(t *testing.T) {
	f := setupStream(t)
	f.event("old", photo(20))
	host := f.auth("host", "test-camera")
	wsJSON(t, host, "viewers")
	viewer := f.auth("viewer", "")
	wsJSON(t, viewer, "source")
	wsJSON(t, host, "viewers")
	f.call("DELETE", f.path("/events"), f.host, nil, 200)
	frame := jpegFrame(90)
	wsWrite(t, host, websocket.MessageBinary, frame)
	wsFrame(t, viewer, frame)
	assertHistoryEmpty(t, f.fixture)
}

func TestHistoryVersionRejectsDelayedUploadsDespiteClockSkew(t *testing.T) {
	f := setup(t)
	var started struct {
		HistoryVersion uint64 `json:"historyVersion"`
	}
	decode(t, f.call("POST", f.path("/heartbeat"), f.host, map[string]any{"sessionId": "event-camera", "monitoring": true}, 200), &started)
	queued := eventBody("queued-before-clear", photo(30))
	queued["detectedAt"], queued["photoAt"] = f.now.Add(4*time.Second), f.now.Add(4*time.Second)
	queued["historyVersion"] = started.HistoryVersion
	var cleared struct {
		HistoryVersion uint64 `json:"historyVersion"`
	}
	decode(t, f.call("DELETE", f.path("/events"), f.host, nil, 200), &cleared)
	f.now = f.now.Add(time.Second)
	var stale map[string]any
	decode(t, f.call("POST", f.path("/events"), f.host, queued, 200), &stale)
	if stale["discarded"] != true || stale["historyVersion"] != float64(cleared.HistoryVersion) {
		t.Fatal("ahead-clock queued upload restored history", stale)
	}
	assertHistoryEmpty(t, f)
	if cleared.HistoryVersion <= started.HistoryVersion {
		t.Fatal("clear did not advance version")
	}
	current := eventBody("new-after-clear", photo(90))
	current["historyVersion"] = cleared.HistoryVersion
	current["detectedAt"], current["photoAt"] = f.now.Add(-time.Hour), f.now.Add(-time.Hour)
	var fresh map[string]any
	decode(t, f.call("POST", f.path("/events"), f.host, current, 200), &fresh)
	if fresh["hasPhoto"] != true || fresh["discarded"] == true {
		t.Fatal("new behind-clock upload rejected", fresh)
	}
	restartHistoryServer(t, f)
	var resumed struct {
		HistoryVersion uint64 `json:"historyVersion"`
	}
	decode(t, f.call("POST", f.path("/heartbeat"), f.host, map[string]any{"sessionId": "event-camera", "monitoring": true}, 200), &resumed)
	if resumed.HistoryVersion != cleared.HistoryVersion {
		t.Fatal("reconnect changed persisted history version")
	}
	stale = nil
	decode(t, f.call("POST", f.path("/events"), f.host, queued, 200), &stale)
	if stale["discarded"] != true || f.state()["eventCount"] != float64(1) {
		t.Fatal("restart lost clear boundary", stale)
	}
}
