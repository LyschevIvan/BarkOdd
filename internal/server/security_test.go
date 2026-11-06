package server

import (
	"encoding/json"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const testOwnerKey = "test-owner-key-0123456789abcdef0123456789"

func TestRoomCreationRequiresIndependentOwnerCredential(t *testing.T) {
	s, err := New(Config{DataDir: t.TempDir(), RoomCreationKey: testOwnerKey})
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	for _, token := range []string{"", "wrong", testOwnerKey} {
		r := httptest.NewRequest("POST", "/api/rooms", strings.NewReader(`{"name":"home"}`))
		if token != "" {
			r.Header.Set("Authorization", "Bearer "+token)
		}
		w := httptest.NewRecorder()
		s.Handler().ServeHTTP(w, r)
		want := 403
		if token == testOwnerKey {
			want = 201
		}
		if w.Code != want {
			t.Fatalf("creation got %d want %d", w.Code, want)
		}
		if strings.Contains(w.Body.String(), testOwnerKey) {
			t.Fatal("owner key exposed")
		}
	}
}

func TestLegacyRoomRequiresOwnerApprovalBeforeTURN(t *testing.T) {
	f := setupRTC(t, "test-turn-secret")
	f.s.mu.Lock()
	f.s.rooms[f.room].OwnerApproved = false
	if err := f.s.save(f.s.rooms[f.room]); err != nil {
		t.Fatal(err)
	}
	f.s.mu.Unlock()
	c, ready := rtcAuth(t, f, "viewer", "")
	for _, entry := range ready["iceServers"].([]any) {
		if _, ok := entry.(map[string]any)["credential"]; ok {
			t.Fatal("legacy room received TURN credentials")
		}
	}
	c.CloseNow()
	for _, tc := range []struct {
		token, owner string
		want         int
	}{{f.viewer, testOwnerKey, 403}, {f.host, "wrong", 403}, {f.host, testOwnerKey, 200}} {
		r := httptest.NewRequest("POST", f.path("/approval"), nil)
		r.Header.Set("Authorization", "Bearer "+tc.token)
		r.Header.Set("X-BarkOdd-Owner-Key", tc.owner)
		w := httptest.NewRecorder()
		f.s.Handler().ServeHTTP(w, r)
		if w.Code != tc.want {
			t.Fatalf("approval got %d want %d", w.Code, tc.want)
		}
	}
	_, ready = rtcAuth(t, f, "viewer", "")
	data, _ := json.Marshal(ready)
	if !strings.Contains(string(data), "credential") {
		t.Fatal("approved room has no TURN credentials")
	}
}

func TestRoomCreationClosedWithoutOwnerKey(t *testing.T) {
	s, err := New(Config{DataDir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	r := httptest.NewRequest("POST", "/api/rooms", strings.NewReader(`{"name":"stranger"}`))
	w := httptest.NewRecorder()
	s.Handler().ServeHTTP(w, r)
	if w.Code != 403 {
		t.Fatalf("public creation status = %d, want 403", w.Code)
	}
}

func TestEventsRejectMissingAndRetiredSourceSession(t *testing.T) {
	f := setup(t)
	f.call("POST", f.path("/heartbeat"), f.host, map[string]any{"sessionId": "old", "monitoring": true}, 200)
	f.call("POST", f.path("/events"), f.host, map[string]any{"episodeId": "noise", "level": 0.2}, 403)
	f.call("POST", f.path("/heartbeat"), f.host, map[string]any{"sessionId": "new", "monitoring": true}, 200)
	f.call("POST", f.path("/events"), f.host, map[string]any{"sessionId": "old", "episodeId": "noise", "level": 0.2}, 403)
	f.call("POST", f.path("/events"), f.host, map[string]any{"sessionId": "new", "episodeId": "noise", "level": 0.2}, 200)
	f.call("POST", f.path("/heartbeat"), f.host, map[string]any{"sessionId": "new", "monitoring": false, "stopped": true}, 200)
	f.call("POST", f.path("/events"), f.host, map[string]any{"sessionId": "new", "episodeId": "late", "level": 0.2}, 403)
	if f.state()["eventCount"] != float64(1) {
		t.Fatal("retired event persisted")
	}
}

func TestOwnerApprovalAndRoomTokensSurviveRestart(t *testing.T) {
	f := setup(t)
	data, err := os.ReadFile(filepath.Join(f.dir, f.room+".json"))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(data), testOwnerKey) {
		t.Fatal("owner credential on disk")
	}
	f.s.Close()
	f.s, err = New(Config{DataDir: f.dir, MediaTransport: "webrtc", STUNURLs: []string{}, TURNURLs: []string{"turn:relay.example:3478"}, TURNSecret: "test-only"})
	if err != nil {
		t.Fatal(err)
	}
	if f.state()["turnAuthorizationRequired"] != false {
		t.Fatal("trusted room lost approval")
	}
	if !f.s.rooms[f.room].OwnerApproved {
		t.Fatal("approval not persisted")
	}
	f.call("POST", "/api/rooms", testOwnerKey, map[string]any{"name": "closed"}, 403)
}

func TestInvalidOwnerKeyFailsConfiguration(t *testing.T) {
	for _, key := range []string{"short", strings.Repeat("x", 129), strings.Repeat("a", 32) + " ", strings.Repeat("a", 31) + "\n"} {
		if s, err := New(Config{DataDir: t.TempDir(), RoomCreationKey: key}); err == nil {
			s.Close()
			t.Fatal("accepted invalid owner key")
		}
	}
}
