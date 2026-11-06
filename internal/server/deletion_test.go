package server

import (
	"github.com/coder/websocket"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestOwnerCreationDoesNotShareProxyQuota(t *testing.T) {
	f := setup(t)
	for i := 0; i < 8; i++ {
		f.call("POST", "/api/rooms", testOwnerKey, map[string]any{"name": "home"}, 201)
	}
}

func TestRoomDeletionReleasesCapacity(t *testing.T) {
	f := setup(t)
	for i := 1; i < 100; i++ {
		f.call("POST", "/api/rooms", testOwnerKey, map[string]any{"name": "home"}, 201)
	}
	f.call("POST", "/api/rooms", testOwnerKey, map[string]any{"name": "full"}, 429)
	f.call("DELETE", f.path(""), f.host, nil, 200)
	f.call("POST", "/api/rooms", testOwnerKey, map[string]any{"name": "available"}, 201)
}

func TestRoomDeletionClosesAuthenticatedAndPendingStreams(t *testing.T) {
	f := setupStream(t)
	f.beat("camera", true, false)
	h := f.auth("host", "camera")
	wsJSON(t, h, "viewers")
	v := f.auth("viewer", "")
	wsJSON(t, v, "source")
	wsJSON(t, h, "viewers")
	pending := f.dial()
	f.call("DELETE", f.path(""), f.host, nil, 200)
	for _, c := range []*websocket.Conn{h, v, pending} {
		wsJSON(t, c, "error")
		wsClosed(t, c, websocket.StatusPolicyViolation)
	}
}

func TestRoomDeletionRejectsEventReservedBeforeDeletion(t *testing.T) {
	f := setup(t)
	f.call("POST", f.path("/heartbeat"), f.host, map[string]any{"sessionId": "event-camera", "monitoring": true}, 200)
	request, body, reservation := reserveEventForTest(t, f, f.path(""), f.host)
	f.call("DELETE", f.path(""), f.host, nil, 200)
	w := httptest.NewRecorder()
	f.s.commitEvent(w, request, reservation, body, jpegFrame(20))
	if w.Code != 404 {
		t.Fatalf("event after deletion got %d", w.Code)
	}
	paths, _ := filepath.Glob(filepath.Join(f.dir, "photos", "*.jpg"))
	if len(paths) != 0 {
		t.Fatal("event recreated deleted photo")
	}
}

func TestRoomDeletionReportsPendingPhotoCleanupAndRetries(t *testing.T) {
	f := setup(t)
	f.event("noise", photo(20))
	paths, _ := filepath.Glob(filepath.Join(f.dir, "photos", "*.jpg"))
	path := paths[0]
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(path, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(path, "block"), []byte("x"), 0600); err != nil {
		t.Fatal(err)
	}
	response := f.call("DELETE", f.path(""), f.host, nil, 202)
	var result map[string]bool
	decode(t, response, &result)
	if !result["cleanupPending"] {
		t.Fatal("cleanup failure hidden")
	}
	if err := os.Remove(filepath.Join(path, "block")); err != nil {
		t.Fatal(err)
	}
	if err := f.s.sweep(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatal("cleanup not retried")
	}
}

func TestRoomDeletionRequiresHostAndRemovesData(t *testing.T) {
	f := setup(t)
	f.event("noise", photo(20))
	f.call("DELETE", f.path(""), "", nil, 401)
	f.call("DELETE", f.path(""), f.viewer, nil, 403)
	f.state()
	f.call("DELETE", f.path(""), f.host, nil, 200)
	f.call("GET", f.path(""), f.host, nil, 404)
	for _, pattern := range []string{"*.json", "*.deleted", "photos/*.jpg"} {
		paths, err := filepath.Glob(filepath.Join(f.dir, pattern))
		if err != nil || len(paths) != 0 {
			t.Fatalf("remaining %s: %v %v", pattern, paths, err)
		}
	}
	f.s.Close()
	var err error
	f.s, err = New(Config{DataDir: f.dir})
	if err != nil {
		t.Fatal(err)
	}
	f.call("GET", f.path(""), f.viewer, nil, 404)
}

func TestFailedRoomDeletionPreservesAccess(t *testing.T) {
	f := setup(t)
	marker := filepath.Join(f.dir, f.room+".deleted")
	if err := os.Mkdir(marker, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(marker, "block"), []byte("x"), 0600); err != nil {
		t.Fatal(err)
	}
	f.call("DELETE", f.path(""), f.host, nil, 500)
	f.state()
}

func TestInterruptedRoomDeletionFinishesOnRestart(t *testing.T) {
	f := setup(t)
	f.event("noise", photo(20))
	f.s.Close()
	if err := os.Rename(filepath.Join(f.dir, f.room+".json"), filepath.Join(f.dir, f.room+".deleted")); err != nil {
		t.Fatal(err)
	}
	var err error
	f.s, err = New(Config{DataDir: f.dir})
	if err != nil {
		t.Fatal(err)
	}
	f.call("GET", f.path(""), f.host, nil, 404)
	photos, _ := filepath.Glob(filepath.Join(f.dir, "photos", "*.jpg"))
	if len(photos) != 0 {
		t.Fatal("deleted room photos remained")
	}
	if _, err = os.Stat(filepath.Join(f.dir, f.room+".deleted")); !os.IsNotExist(err) {
		t.Fatal("deletion marker remained")
	}
}

func TestRoomDeletionPreservesRetryMarkerWhenPhotoDirectoryUnreadable(t *testing.T) {
	f := setup(t)
	f.event("noise", photo(20))
	photos := filepath.Join(f.dir, "photos")
	if err := os.Chmod(photos, 0000); err != nil {
		t.Fatal(err)
	}
	defer os.Chmod(photos, 0700)
	if _, err := os.ReadDir(photos); err == nil {
		t.Skip("test requires filesystem permission enforcement")
	}
	f.call("DELETE", f.path(""), f.host, nil, 202)
	if _, err := os.Stat(filepath.Join(f.dir, f.room+".deleted")); err != nil {
		t.Fatal("lost cleanup marker", err)
	}
	if err := os.Chmod(photos, 0700); err != nil {
		t.Fatal(err)
	}
	files, _ := os.ReadDir(photos)
	if len(files) != 1 {
		t.Fatal("test photo missing before retry")
	}
	if err := f.s.sweep(); err != nil {
		t.Fatal(err)
	}
	files, _ = os.ReadDir(photos)
	if len(files) != 0 {
		t.Fatal("retry left deleted photo")
	}
}
