package server

import (
	"encoding/json"
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
		accountRequest(t, s, "POST", "/api/rooms", map[string]string{"name": "home"}, nil, token, 401)
	}
	cookie := accountLogin(t, s)
	w := accountRequest(t, s, "POST", "/api/rooms", map[string]string{"name": "home"}, cookie, "", 201)
	if strings.Contains(w.Body.String(), testOwnerKey) {
		t.Fatal("owner key exposed")
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
	f.call("POST", f.path("/approval"), f.viewer, nil, 403)
	accountRequest(t, f.s, "POST", f.path("/approval"), nil, nil, f.host, 401)
	f.call("POST", f.path("/approval"), f.host, nil, 200)
	_, ready = rtcAuth(t, f, "viewer", "")
	data, _ := json.Marshal(ready)
	if !strings.Contains(string(data), "credential") {
		t.Fatal("approved room has no TURN credentials")
	}
}

func TestRoomCreationClosedWithoutOwnerKey(t *testing.T) {
	if s, err := New(Config{DataDir: t.TempDir()}); err == nil {
		s.Close()
		t.Fatal("protected mode started without admin code")
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
	f.s, err = New(Config{DataDir: f.dir, RoomCreationKey: testOwnerKey, MediaTransport: "webrtc", STUNURLs: []string{}, TURNURLs: []string{"turn:relay.example:3478"}, TURNSecret: "test-only"})
	if err != nil {
		t.Fatal(err)
	}
	if f.state()["turnAuthorizationRequired"] != false {
		t.Fatal("trusted room lost approval")
	}
	if !f.s.rooms[f.room].OwnerApproved {
		t.Fatal("approval not persisted")
	}
	accountRequest(t, f.s, "POST", "/api/rooms", map[string]string{"name": "closed"}, nil, testOwnerKey, 401)
}

func TestInvalidOwnerKeyFailsConfiguration(t *testing.T) {
	for _, key := range []string{"short", strings.Repeat("x", 129), strings.Repeat("a", 32) + " ", strings.Repeat("a", 31) + "\n"} {
		if s, err := New(Config{DataDir: t.TempDir(), RoomCreationKey: key}); err == nil {
			s.Close()
			t.Fatal("accepted invalid owner key")
		}
	}
}
