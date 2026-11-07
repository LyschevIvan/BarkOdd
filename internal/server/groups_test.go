package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
)

type groupResponse struct {
	ID, Name  string
	CreatedAt time.Time
	Members   []struct {
		ID, Username string
		Disabled     bool
	}
	Cameras []struct {
		ID, Name           string
		Online, Monitoring bool
	}
}

type cameraCreated struct {
	ID, OwnerID, HostToken, ViewerToken, GroupID string
}

func createTestGroup(t *testing.T, s *Server, cookie *http.Cookie) groupResponse {
	t.Helper()
	var group groupResponse
	decode(t, accountRequest(t, s, "POST", "/api/groups", map[string]string{"name": "Home"}, cookie, "", 201), &group)
	if group.ID == "" || group.Name != "Home" || group.CreatedAt.IsZero() || len(group.Members) != 1 || group.Cameras == nil || len(group.Cameras) != 0 {
		t.Fatalf("invalid newly created group: %+v", group)
	}
	return group
}

func createGroupCamera(t *testing.T, s *Server, cookie *http.Cookie, groupID, name string) cameraCreated {
	t.Helper()
	var camera cameraCreated
	decode(t, accountRequest(t, s, "POST", "/api/groups/"+groupID+"/cameras", map[string]string{"name": name}, cookie, "", 201), &camera)
	if camera.ID == "" || camera.OwnerID == "" || camera.GroupID != groupID || camera.HostToken == "" || camera.ViewerToken == "" {
		t.Fatalf("invalid camera response: %+v", camera)
	}
	return camera
}

func shareTestGroup(t *testing.T, s *Server, cookie *http.Cookie, path, username string) groupResponse {
	t.Helper()
	var group groupResponse
	decode(t, accountRequest(t, s, "POST", path+"/members", map[string]string{"username": username}, cookie, "", 200), &group)
	return group
}

func TestGroupMembersManageIndependentCameras(t *testing.T) {
	s, err := New(Config{DataDir: t.TempDir(), AuthMode: "multi_user", AdminCode: testOwnerKey})
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()

	alice, aliceID := registeredAccount(t, s, "alice")
	bob, bobID := registeredAccount(t, s, "bob")
	admin := accountLogin(t, s)
	group := createTestGroup(t, s, alice)
	path := "/api/groups/" + group.ID
	if group.Members[0].ID != aliceID || group.Members[0].Username != "alice" || group.Members[0].Disabled {
		t.Fatal(group.Members)
	}
	a := createGroupCamera(t, s, alice, group.ID, "Kitchen")
	aPath := "/api/rooms/" + a.ID
	for _, cookie := range []*http.Cookie{bob, admin} {
		var list struct{ Groups []groupResponse }
		decode(t, accountRequest(t, s, "GET", "/api/groups", nil, cookie, "", 200), &list)
		if list.Groups == nil || len(list.Groups) != 0 {
			t.Fatalf("foreign room leaked: %+v", list)
		}
		accountRequest(t, s, "GET", path, nil, cookie, "", 401)
		accountRequest(t, s, "POST", path+"/cameras", map[string]string{"name": "Unauthorized"}, cookie, "", 401)
	}
	accountRequest(t, s, "GET", path, nil, alice, a.ViewerToken, 401)
	accountRequest(t, s, "POST", path+"/members", map[string]string{"username": "bob"}, alice, a.ViewerToken, 401)
	group = shareTestGroup(t, s, alice, path, "Bob")
	if len(group.Members) != 2 || group.Members[1].ID != bobID || group.Members[1].Username != "bob" {
		t.Fatal(group.Members)
	}
	b := createGroupCamera(t, s, bob, group.ID, "Living room")
	if a.ID == b.ID || a.OwnerID != aliceID || b.OwnerID != bobID || a.ViewerToken == b.ViewerToken {
		t.Fatal("camera identities are not independent")
	}
	bPath := "/api/rooms/" + b.ID
	accountRequest(t, s, "GET", bPath, nil, nil, a.ViewerToken, 401)

	for _, camera := range []struct {
		path   string
		cookie *http.Cookie
	}{
		{aPath, alice}, {bPath, bob},
	} {
		accountRequest(t, s, "POST", camera.path+"/heartbeat", map[string]any{"sessionId": "event-camera", "monitoring": true}, camera.cookie, "", 200)
		accountRequest(t, s, "POST", camera.path+"/events", eventBody("noise", photo(30)), camera.cookie, "", 200)
	}
	accountRequest(t, s, "POST", aPath+"/heartbeat", map[string]any{"sessionId": "event-camera", "monitoring": true}, bob, "", 403)
	accountRequest(t, s, "POST", aPath+"/events", eventBody("wrong-account", ""), bob, "", 403)
	var rooms struct{ Rooms []struct{ ID string } }
	decode(t, accountRequest(t, s, "GET", "/api/rooms", nil, bob, "", 200), &rooms)
	if len(rooms.Rooms) != 2 {
		t.Fatal(rooms)
	}
	var list struct{ Groups []groupResponse }
	decode(t, accountRequest(t, s, "GET", "/api/groups", nil, bob, "", 200), &list)
	if len(list.Groups) != 1 || len(list.Groups[0].Cameras) != 2 || !list.Groups[0].Cameras[0].Monitoring || !list.Groups[0].Cameras[1].Online {
		t.Fatal(list)
	}

	accountRequest(t, s, "PUT", aPath+"/settings", map[string]any{"threshold": 0.1, "snapshotIntervalMs": 30000}, bob, "", 200)
	accountRequest(t, s, "POST", aPath+"/heartbeat", map[string]any{"sessionId": "new-source", "monitoring": true}, alice, "", 200)
	for _, check := range []struct {
		path       string
		eventCount int
		threshold  float64
	}{
		{aPath, 0, 0.1}, {bPath, 1, 0.01},
	} {
		var state struct {
			GroupID, GroupName string
			EventCount         int
			Settings           Settings
			Monitoring         bool
		}
		decode(t, accountRequest(t, s, "GET", check.path, nil, bob, "", 200), &state)
		if state.GroupID != group.ID || state.GroupName != "Home" || state.EventCount != check.eventCount || state.Settings.Threshold != check.threshold || !state.Monitoring {
			t.Fatalf("camera state changed across cameras: %+v", state)
		}
	}
	accountRequest(t, s, "DELETE", path+"/members/"+aliceID, nil, bob, "", 200)
	accountRequest(t, s, "GET", aPath, nil, alice, "", 401)
	accountRequest(t, s, "GET", aPath, nil, bob, "", 200)
	accountRequest(t, s, "DELETE", path+"/members/"+bobID, nil, bob, "", 409)
}

func groupSocket(t *testing.T, endpoint, cameraPath string, cookie *http.Cookie, role, token, session string) *websocket.Conn {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	headers := http.Header{"Origin": []string{endpoint}}
	if cookie != nil {
		headers.Set("Cookie", cookie.String())
	}
	socket, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(endpoint, "http")+cameraPath+"/stream", &websocket.DialOptions{HTTPHeader: headers})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { socket.CloseNow() })
	wsSend(t, socket, map[string]any{"type": "auth", "role": role, "token": token, "sessionId": session})
	wsJSON(t, socket, "ready")
	return socket
}

func TestGroupRevocationKeepsOtherOwnersPublishing(t *testing.T) {
	for _, revoke := range []string{"remove", "disable"} {
		t.Run(revoke, func(t *testing.T) {
			s, err := New(Config{DataDir: t.TempDir(), AuthMode: "multi_user", AdminCode: testOwnerKey})
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { s.Close() })
			server := httptest.NewServer(s.Handler())
			t.Cleanup(server.Close)
			alice, aliceID := registeredAccount(t, s, "alice")
			bob, bobID := registeredAccount(t, s, "bob")
			admin := accountLogin(t, s)
			group := createTestGroup(t, s, alice)
			path := "/api/groups/" + group.ID
			shareTestGroup(t, s, alice, path, "bob")
			// Source ownership must follow the publishing account, regardless
			// of which member originally created the camera.
			a := createGroupCamera(t, s, bob, group.ID, "Kitchen")
			b := createGroupCamera(t, s, alice, group.ID, "Living room")
			aPath, bPath := "/api/rooms/"+a.ID, "/api/rooms/"+b.ID
			beat := map[string]any{"sessionId": "event-camera", "monitoring": true}
			accountRequest(t, s, "POST", aPath+"/heartbeat", beat, alice, "", 200)
			accountRequest(t, s, "POST", bPath+"/heartbeat", beat, bob, "", 200)
			aliceSource := groupSocket(t, server.URL, aPath, alice, "host", "", "event-camera")
			wsJSON(t, aliceSource, "viewers")
			bobSource := groupSocket(t, server.URL, bPath, bob, "host", "", "event-camera")
			wsJSON(t, bobSource, "viewers")
			aliceViewer := groupSocket(t, server.URL, bPath, alice, "viewer", "", "")
			wsJSON(t, aliceViewer, "source")
			wsJSON(t, bobSource, "viewers")
			guest := groupSocket(t, server.URL, bPath, nil, "viewer", b.ViewerToken, "")
			wsJSON(t, guest, "source")
			wsJSON(t, bobSource, "viewers")

			var event Event
			decode(t, accountRequest(t, s, "POST", bPath+"/events", eventBody("original", photo(30)), bob, "", 200), &event)
			photoPath := bPath + "/events/" + event.ID + "/photo"
			accountRequest(t, s, "GET", photoPath, nil, alice, "", 200)
			inflight := httptest.NewRequest("POST", aPath+"/events", nil)
			inflight.AddCookie(alice)
			lateEvent := &eventPayload{SessionID: "event-camera"}
			response := httptest.NewRecorder()
			reservation := s.reserveEvent(response, inflight, a.ID, lateEvent)
			if reservation == nil {
				t.Fatalf("could not reserve event before revocation: %s", response.Body.String())
			}
			defer reservation.release()
			if revoke == "remove" {
				accountRequest(t, s, "DELETE", path+"/members/"+aliceID, nil, bob, "", 200)
			} else {
				accountRequest(t, s, "PUT", "/api/admin/users/"+aliceID, map[string]bool{"disabled": true}, admin, "", 200)
			}
			s.commitEvent(response, inflight, reservation, lateEvent, nil)
			if response.Code != 401 {
				t.Fatalf("event reserved before revocation was not rejected: %s", response.Body.String())
			}
			for _, socket := range []*websocket.Conn{aliceSource, aliceViewer} {
				if message := wsJSON(t, socket, "error"); message["status"] != float64(401) {
					t.Fatal(message)
				}
				wsClosed(t, socket, websocket.StatusPolicyViolation)
			}
			accountRequest(t, s, "GET", photoPath, nil, alice, "", 401)
			accountRequest(t, s, "POST", aPath+"/events", eventBody("late", ""), alice, "", 401)
			accountRequest(t, s, "GET", aPath, nil, nil, a.ViewerToken, 200)
			accountRequest(t, s, "GET", photoPath, nil, nil, b.ViewerToken, 200)
			accountRequest(t, s, "POST", bPath+"/heartbeat", beat, bob, "", 200)
			frame := jpegFrame(40)
			wsWrite(t, bobSource, websocket.MessageBinary, frame)
			wsFrame(t, guest, frame)
			var state struct{ Online, Monitoring bool }
			decode(t, accountRequest(t, s, "GET", aPath, nil, bob, "", 200), &state)
			if state.Online || state.Monitoring {
				t.Fatal("revoked owner still marked online")
			}
			accountRequest(t, s, "PUT", "/api/admin/users/"+bobID, map[string]bool{"disabled": true}, admin, "", 200)
			accountRequest(t, s, "GET", bPath, nil, nil, b.ViewerToken, 401)
		})
	}
}

func TestLegacyCameraMigratesWithHistoryAndGuestAccess(t *testing.T) {
	f := setup(t)
	event := f.event("preserved", photo(22))
	state := f.state()
	f.s.Close()
	path := filepath.Join(f.dir, f.room+".json")
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var old map[string]json.RawMessage
	if err := json.Unmarshal(data, &old); err != nil {
		t.Fatal(err)
	}
	if groupID, ok := state["groupId"].(string); ok {
		if err := os.Remove(filepath.Join(f.dir, "groups", groupID+".json")); err != nil {
			t.Fatal(err)
		}
	}
	delete(old, "groupId")
	delete(old, "ownerId")
	data, err = json.Marshal(old)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, data, 0600); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 3; i++ {
		f.s, err = New(Config{DataDir: f.dir, RoomCreationKey: testOwnerKey, Now: func() time.Time { return f.now }})
		if err != nil {
			t.Fatal(err)
		}
		var state struct {
			GroupID, GroupName string
			Events             []Event
		}
		decode(t, f.call("GET", f.path(""), f.viewer, nil, 200), &state)
		if state.GroupID == "" || state.GroupName != "Барбос" || len(state.Events) != 1 || state.Events[0].ID != event["id"] {
			t.Fatalf("legacy camera state after restart: %+v", state)
		}
		f.call("GET", f.path("/events/"+state.Events[0].ID+"/photo"), f.viewer, nil, 200)
		var groups struct{ Groups []groupResponse }
		decode(t, f.call("GET", "/api/groups", f.host, nil, 200), &groups)
		if len(groups.Groups) != 1 || groups.Groups[0].ID != state.GroupID || len(groups.Groups[0].Cameras) != 1 {
			t.Fatal(groups)
		}
		f.s.Close()
		if i == 0 {
			// Simulate an interrupted migration after the group is persisted
			// but before the camera's reference to it is written.
			if err := os.WriteFile(path, data, 0600); err != nil {
				t.Fatal(err)
			}
		}
	}
}

func TestGroupDeletionSurvivesCameraCleanupFailure(t *testing.T) {
	dir := t.TempDir()
	config := Config{DataDir: dir, AuthMode: "none"}
	s, err := New(config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	group := createTestGroup(t, s, nil)
	a := createGroupCamera(t, s, nil, group.ID, "Kitchen")
	b := createGroupCamera(t, s, nil, group.ID, "Living room")
	path := "/api/groups/" + group.ID
	blocked := filepath.Join(dir, a.ID+".deleted")
	if err := os.Mkdir(blocked, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(blocked, "block"), []byte("blocked rename"), 0600); err != nil {
		t.Fatal(err)
	}
	accountRequest(t, s, "DELETE", path, nil, nil, "", 202)
	for i := 0; i < 2; i++ {
		accountRequest(t, s, "GET", path, nil, nil, "", 404)
		for _, camera := range []cameraCreated{a, b} {
			accountRequest(t, s, "GET", "/api/rooms/"+camera.ID, nil, nil, camera.ViewerToken, 404)
		}
		if i == 0 {
			s.Close()
			next, err := New(config)
			if err != nil {
				t.Fatal(err)
			}
			s = next
		}
	}
	if err := os.RemoveAll(blocked); err != nil {
		t.Fatal(err)
	}
	s.mu.Lock()
	err = s.sweep()
	s.mu.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	for _, pattern := range []string{"*.json", "*.deleted", "groups/*.json", "groups/*.deleted"} {
		paths, err := filepath.Glob(filepath.Join(dir, pattern))
		if err != nil || len(paths) != 0 {
			t.Fatalf("remaining %s after retry: %v %v", pattern, paths, err)
		}
	}
}
