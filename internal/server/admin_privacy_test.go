package server

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
)

func TestAdminCannotReadOtherUsersMediaOrIssueGuestLinks(t *testing.T) {
	s, err := New(Config{DataDir: t.TempDir(), AuthMode: "multi_user", AdminCode: testOwnerKey})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	alice, _ := registeredAccount(t, s, "alice")
	bob, _ := registeredAccount(t, s, "bob")
	admin := accountLogin(t, s)
	var created struct{ ID, ViewerToken string }
	decode(t, accountRequest(t, s, "POST", "/api/rooms", map[string]string{"name": "Alice private camera"}, alice, "", 201), &created)
	path := "/api/rooms/" + created.ID
	accountRequest(t, s, "POST", path+"/heartbeat", map[string]any{"sessionId": "event-camera", "monitoring": true}, alice, "", 200)
	var event Event
	decode(t, accountRequest(t, s, "POST", path+"/events", eventBody("private-photo", photo(42)), alice, "", 200), &event)
	photoPath := path + "/events/" + event.ID + "/photo"
	ownerPhoto := accountRequest(t, s, "GET", photoPath, nil, alice, "", 200)
	if ownerPhoto.Header().Get("Content-Type") != "image/jpeg" || ownerPhoto.Body.Len() == 0 {
		t.Fatal("owner photo fixture is unavailable")
	}
	qrBody := map[string]string{"viewerToken": created.ViewerToken, "origin": "http://example.com"}
	accountRequest(t, s, "POST", path+"/qr", qrBody, alice, "", 200)

	for _, actor := range []struct {
		name   string
		cookie *http.Cookie
	}{{"admin", admin}, {"other user", bob}} {
		t.Run(actor.name, func(t *testing.T) {
			for _, route := range []struct {
				method, path string
				body         any
			}{
				{"GET", path, nil},
				{"GET", photoPath, nil},
				{"POST", path + "/pairing", nil},
				{"POST", path + "/qr", qrBody},
			} {
				accountRequest(t, s, route.method, route.path, route.body, actor.cookie, "", 401)
			}
			// A viewer link deliberately shared by the owner remains a guest capability.
			shared := accountRequest(t, s, "GET", photoPath, nil, actor.cookie, created.ViewerToken, 200)
			if !bytes.Equal(shared.Body.Bytes(), ownerPhoto.Body.Bytes()) {
				t.Fatal("explicitly shared photo differs from owner's photo")
			}
			accountRequest(t, s, "POST", path+"/pairing", nil, actor.cookie, created.ViewerToken, 403)
		})
	}

	var own struct{ ID string }
	decode(t, accountRequest(t, s, "POST", "/api/rooms", map[string]string{"name": "Admin own camera"}, admin, "", 201), &own)
	var listed struct{ Rooms []struct{ ID string } }
	decode(t, accountRequest(t, s, "GET", "/api/rooms", nil, admin, "", 200), &listed)
	if len(listed.Rooms) != 1 || listed.Rooms[0].ID != own.ID {
		t.Fatalf("admin room list includes another user's room: %+v", listed.Rooms)
	}
	accountRequest(t, s, "GET", "/api/rooms/"+own.ID, nil, admin, "", 200)
}

func TestAdminCannotJoinOtherUsersStreamWithoutGuestLink(t *testing.T) {
	for _, transport := range []string{"websocket", "webrtc"} {
		t.Run(transport, func(t *testing.T) {
			s, err := New(Config{DataDir: t.TempDir(), AuthMode: "multi_user", AdminCode: testOwnerKey, MediaTransport: transport})
			if err != nil {
				t.Fatal(err)
			}
			h := httptest.NewServer(s.Handler())
			t.Cleanup(func() { s.Close(); h.Close() })
			alice, _ := registeredAccount(t, s, "alice")
			admin := accountLogin(t, s)
			var created struct{ ID, ViewerToken string }
			decode(t, accountRequest(t, s, "POST", "/api/rooms", map[string]string{"name": "Alice live camera"}, alice, "", 201), &created)
			path := "/api/rooms/" + created.ID
			accountRequest(t, s, "POST", path+"/heartbeat", map[string]any{"sessionId": "camera", "monitoring": true}, alice, "", 200)
			dial := func(cookie *http.Cookie) *websocket.Conn {
				t.Helper()
				ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
				defer cancel()
				c, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(h.URL, "http")+path+"/stream", &websocket.DialOptions{HTTPHeader: http.Header{"Origin": []string{h.URL}, "Cookie": []string{cookie.String()}}})
				if err != nil {
					t.Fatal(err)
				}
				t.Cleanup(func() { c.CloseNow() })
				return c
			}
			source := dial(alice)
			wsSend(t, source, map[string]any{"type": "auth", "role": "host", "sessionId": "camera"})
			wsJSON(t, source, "ready")
			wsJSON(t, source, "viewers")

			for _, role := range []string{"viewer", "host"} {
				c := dial(admin)
				wsSend(t, c, map[string]any{"type": "auth", "role": role, "sessionId": "camera"})
				if rejected := wsJSON(t, c, "error"); rejected["status"] != float64(401) {
					t.Fatalf("admin %s joined another user's %s stream: %v", role, transport, rejected)
				}
				wsClosed(t, c, websocket.StatusPolicyViolation)
			}

			shared := dial(admin)
			wsSend(t, shared, map[string]any{"type": "auth", "role": "viewer", "token": created.ViewerToken})
			ready := wsJSON(t, shared, "ready")
			if ready["role"] != "viewer" {
				t.Fatalf("shared link granted a non-viewer role: %v", ready)
			}
			wsJSON(t, shared, "source")
			wsJSON(t, source, "viewers")
			if transport == "websocket" {
				frame := jpegFrame(42)
				wsWrite(t, source, websocket.MessageBinary, frame)
				wsFrame(t, shared, frame)
			} else {
				wsSend(t, source, rtcSignal(ready["clientId"].(string), "offer"))
				wsJSON(t, shared, "signal")
			}
		})
	}
}
