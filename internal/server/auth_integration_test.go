package server

import (
	"bytes"
	"context"
	"encoding/json"
	"github.com/coder/websocket"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func accountRequest(t *testing.T, s *Server, method, path string, body any, cookie *http.Cookie, token string, want int) *httptest.ResponseRecorder {
	t.Helper()
	data, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	r := httptest.NewRequest(method, "http://example.com"+path, bytes.NewReader(data))
	r.Header.Set("Origin", "http://example.com")
	r.Header.Set("Content-Type", "application/json")
	if cookie != nil {
		r.AddCookie(cookie)
	}
	if token != "" {
		r.Header.Set("Authorization", "Bearer "+token)
	}
	w := httptest.NewRecorder()
	s.Handler().ServeHTTP(w, r)
	if w.Code != want {
		t.Fatalf("%s %s: got %d want %d: %s", method, path, w.Code, want, w.Body.String())
	}
	return w
}
func accountLogin(t *testing.T, s *Server) *http.Cookie {
	t.Helper()
	w := accountRequest(t, s, "POST", "/api/auth/login", map[string]string{"code": testOwnerKey}, nil, "", 200)
	for _, c := range w.Result().Cookies() {
		if c.Name == "barkodd_session" {
			return c
		}
	}
	t.Fatal("login did not set session")
	return nil
}
func TestAccountRoomAuthorizationAndGuestPrecedence(t *testing.T) {
	s, err := New(Config{DataDir: t.TempDir(), RoomCreationKey: testOwnerKey})
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	cookie := accountLogin(t, s)
	w := accountRequest(t, s, "POST", "/api/rooms", map[string]string{"name": "private"}, cookie, "", 201)
	var created struct{ ID, HostToken, ViewerToken string }
	decode(t, w, &created)
	path := "/api/rooms/" + created.ID
	accountRequest(t, s, "GET", path, nil, nil, created.HostToken, 401)
	accountRequest(t, s, "GET", path, nil, cookie, "", 200)
	accountRequest(t, s, "GET", path, nil, nil, created.ViewerToken, 200)
	accountRequest(t, s, "PUT", path+"/settings", map[string]any{"threshold": 0.1, "snapshotIntervalMs": 30000}, cookie, created.ViewerToken, 403)
	accountRequest(t, s, "GET", path, nil, cookie, "invalid-bearer", 401)
	accountRequest(t, s, "POST", "/api/auth/logout", nil, cookie, "", 200)
	accountRequest(t, s, "GET", path, nil, cookie, "", 401)
	accountRequest(t, s, "GET", path, nil, nil, created.ViewerToken, 200)
}

func registeredAccount(t *testing.T, s *Server, name string) (*http.Cookie, string) {
	t.Helper()
	w := accountRequest(t, s, "POST", "/api/auth/register", map[string]string{"username": name, "password": "correct horse battery"}, nil, "", 201)
	var response struct{ User struct{ ID string } }
	decode(t, w, &response)
	for _, c := range w.Result().Cookies() {
		if c.Name == "barkodd_session" {
			return c, response.User.ID
		}
	}
	t.Fatal("missing registration cookie")
	return nil, ""
}
func TestMultiUserRoomIsolationAndDisable(t *testing.T) {
	s, err := New(Config{DataDir: t.TempDir(), AuthMode: "multi_user", AdminCode: testOwnerKey})
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	alice, id := registeredAccount(t, s, "alice")
	bob, _ := registeredAccount(t, s, "bob")
	admin := accountLogin(t, s)
	w := accountRequest(t, s, "POST", "/api/rooms", map[string]string{"name": "Alice home"}, alice, "", 201)
	var created struct{ ID, HostToken, ViewerToken string }
	decode(t, w, &created)
	path := "/api/rooms/" + created.ID
	accountRequest(t, s, "GET", path, nil, bob, "", 401)
	accountRequest(t, s, "GET", path, nil, admin, "", 401)
	accountRequest(t, s, "GET", path, nil, bob, created.HostToken, 401)
	for _, cookie := range []*http.Cookie{bob, admin} {
		var list struct{ Rooms []any }
		decode(t, accountRequest(t, s, "GET", "/api/rooms", nil, cookie, "", 200), &list)
		if len(list.Rooms) != 0 {
			t.Fatal("other owner's room leaked")
		}
	}
	accountRequest(t, s, "GET", path, nil, bob, created.ViewerToken, 200)
	accountRequest(t, s, "POST", path+"/heartbeat", map[string]any{"sessionId": "cam", "monitoring": true}, alice, "", 200)
	accountRequest(t, s, "PUT", "/api/admin/users/"+id, map[string]bool{"disabled": true}, admin, "", 200)
	accountRequest(t, s, "GET", path, nil, alice, "", 401)
	accountRequest(t, s, "GET", path, nil, nil, created.ViewerToken, 401)
	accountRequest(t, s, "POST", path+"/events", map[string]any{"sessionId": "cam", "episodeId": "late", "level": 0.5}, alice, "", 401)
	s.mu.Lock()
	r := s.rooms[created.ID]
	if r.Monitoring || r.LastSeenAt != nil {
		t.Error("disabled camera still online")
	}
	s.mu.Unlock()
	accountRequest(t, s, "PUT", "/api/admin/users/"+id, map[string]bool{"disabled": false}, admin, "", 200)
	accountRequest(t, s, "GET", path, nil, nil, created.ViewerToken, 200)
	accountRequest(t, s, "GET", path, nil, alice, "", 401) // Reenabling must not revive revoked sessions.
}
func TestNoneModeRoomsRequireOriginButNotLogin(t *testing.T) {
	s, err := New(Config{DataDir: t.TempDir(), AuthMode: "none"})
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	accountRequest(t, s, "POST", "/api/rooms", map[string]string{"name": "home"}, nil, "", 201)
	accountRequest(t, s, "GET", "/api/rooms", nil, nil, "", 200)
	for _, origin := range []string{"", "null", "https://evil.example"} {
		r := httptest.NewRequest("POST", "http://example.com/api/rooms", bytes.NewBufferString(`{"name":"attack"}`))
		if origin != "" {
			r.Header.Set("Origin", origin)
		}
		w := httptest.NewRecorder()
		s.Handler().ServeHTTP(w, r)
		if w.Code != 403 {
			t.Fatalf("origin %q accepted", origin)
		}
	}
	accountRequest(t, s, "POST", "/api/auth/register", map[string]string{"username": "alice", "password": "correct horse battery"}, nil, "", 403)
}
func TestAccountLogoutClosesSourceAcrossTransports(t *testing.T) {
	for _, mode := range []string{"websocket", "webrtc"} {
		t.Run(mode, func(t *testing.T) {
			var f *streamFixture
			if mode == "webrtc" {
				f = setupRTC(t, "test-only")
			} else {
				f = setupStream(t)
			}
			f.beat("camera", true, false)
			source := f.auth("host", "camera")
			wsJSON(t, source, "viewers")
			guest := f.auth("viewer", "")
			wsJSON(t, guest, "source")
			wsJSON(t, source, "viewers")
			cookie := f.ensureCookie()
			accountRequest(t, f.s, "POST", "/api/auth/logout", map[string]any{}, cookie, "", 200)
			if msg := wsJSON(t, source, "error"); msg["status"] != float64(401) {
				t.Fatal(msg)
			}
			accountRequest(t, f.s, "POST", f.path("/heartbeat"), map[string]any{"sessionId": "camera", "monitoring": true}, cookie, "", 401)
			accountRequest(t, f.s, "GET", f.path(""), nil, nil, f.viewer, 200)
			f.s.mu.Lock()
			if f.s.rooms[f.room].Monitoring || f.s.sourceActiveLocked(f.s.rooms[f.room]) {
				t.Error("logged-out source still active")
			}
			f.s.mu.Unlock()
		})
	}
}

func TestStreamRejectsAuthorizationHeaderEvenWithOwnerCookie(t *testing.T) {
	f := setupStream(t)
	f.beat("camera", true, false)
	for _, token := range []string{"", "wrong", f.host, f.viewer} {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		c, r, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(f.http.URL, "http")+f.path("/stream"), &websocket.DialOptions{HTTPHeader: http.Header{"Origin": []string{f.http.URL}, "Cookie": []string{f.ensureCookie().String()}, "Authorization": []string{token}}})
		cancel()
		if c != nil {
			c.CloseNow()
		}
		if err == nil || r == nil || r.StatusCode != 400 {
			t.Fatalf("Authorization-bearing upgrade accepted: response=%v error=%v", r, err)
		}
	}
}

func TestRotatingGuestLinkKeepsAccountViewerConnected(t *testing.T) {
	f := setupStream(t)
	f.beat("camera", true, false)
	host := f.auth("host", "camera")
	wsJSON(t, host, "viewers")
	viewer := f.dial()
	wsSend(t, viewer, map[string]any{"type": "auth", "role": "viewer"})
	wsJSON(t, viewer, "ready")
	wsJSON(t, viewer, "source")
	wsJSON(t, host, "viewers")
	f.call("POST", f.path("/pairing"), f.host, nil, 200)
	wsWrite(t, host, websocket.MessageBinary, jpegFrame(22))
	wsFrame(t, viewer, jpegFrame(22))
}
