package server

import (
	"context"
	"crypto/hmac"
	"crypto/sha1"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
)

func TestMediaTransportConfig(t *testing.T) {
	for _, tc := range []struct {
		name    string
		config  Config
		wantErr bool
	}{
		{"default", Config{}, false},
		{"unknown", Config{MediaTransport: "udp"}, true},
		{"rtc default", Config{MediaTransport: "webrtc"}, false},
		{"unused ice", Config{TURNURLs: []string{"bad"}, TURNUsername: "partial"}, false},
		{"bad stun", Config{MediaTransport: "webrtc", STUNURLs: []string{"https://example.com"}}, true},
		{"bad turn", Config{MediaTransport: "webrtc", TURNURLs: []string{"turn:example.com/path"}, TURNSecret: "secret"}, true},
		{"missing auth", Config{MediaTransport: "webrtc", TURNURLs: []string{"turn:example.com"}}, true},
		{"partial auth", Config{MediaTransport: "webrtc", TURNUsername: "user"}, true},
		{"conflicting auth", Config{MediaTransport: "webrtc", TURNSecret: "secret", TURNUsername: "user", TURNPassword: "password"}, true},
		{"static auth", Config{MediaTransport: "webrtc", TURNURLs: []string{"turns:example.com:5349?transport=tcp"}, TURNUsername: "user", TURNPassword: "password"}, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			tc.config.DataDir = t.TempDir()
			s, err := New(tc.config)
			if (err != nil) != tc.wantErr {
				t.Fatalf("error %v, wantErr %v", err, tc.wantErr)
			}
			if s != nil {
				defer s.Close()
				if s.config.MediaTransport == "" {
					t.Fatal("missing default transport")
				}
			}
		})
	}
}

func setupRTC(t *testing.T, secret string) *streamFixture {
	t.Helper()
	f := setup(t)
	f.s.Close()
	s, err := New(Config{DataDir: f.dir, RoomCreationKey: testOwnerKey, Now: func() time.Time { return f.now }, MediaTransport: "webrtc", TURNURLs: []string{"turn:relay.example:3478?transport=udp"}, TURNSecret: secret})
	if err != nil {
		t.Fatal(err)
	}
	f.s = s
	h := httptest.NewServer(s.Handler())
	t.Cleanup(func() { s.Close(); h.Close() })
	return &streamFixture{f, h}
}
func rtcAuth(t *testing.T, f *streamFixture, role, session string) (*websocket.Conn, map[string]any) {
	t.Helper()
	c := f.dial()
	token := f.viewer
	if role == "host" {
		token = f.host
	}
	wsSend(t, c, map[string]any{"type": "auth", "role": role, "sessionId": session, "token": token})
	return c, wsJSON(t, c, "ready")
}
func rtcSignal(target, typ string) map[string]any {
	signal := map[string]any{"type": typ}
	if typ == "candidate" {
		signal["candidate"] = nil
	} else {
		signal["sdp"] = "v=0\r\n"
	}
	return map[string]any{"type": "signal", "target": target, "connectionId": "connection-1", "signal": signal}
}
func rtcReadType(t *testing.T, c *websocket.Conn, typ string) map[string]any {
	t.Helper()
	for i := 0; i < 15; i++ {
		kind, data := wsRead(t, c)
		if kind != websocket.MessageText {
			t.Fatal("binary in RTC")
		}
		var message map[string]any
		decodeJSON(t, data, &message)
		if message["type"] == typ {
			return message
		}
	}
	t.Fatalf("no %s", typ)
	return nil
}
func decodeJSON(t *testing.T, data []byte, v any) {
	t.Helper()
	if err := json.Unmarshal(data, v); err != nil {
		t.Fatal(err)
	}
}
func TestRTCReadyMetadataCredentialsAndSignalOrder(t *testing.T) {
	f := setupRTC(t, "shared-secret")
	f.beat("camera", true, false)
	if got := f.state()["mediaTransport"]; got != "webrtc" {
		t.Fatal(got)
	}
	h, hr := rtcAuth(t, f, "host", "camera")
	wsJSON(t, h, "viewers")
	v, vr := rtcAuth(t, f, "viewer", "")
	source := wsJSON(t, v, "source")
	roster := wsJSON(t, h, "viewers")
	hid, _ := hr["clientId"].(string)
	vid, _ := vr["clientId"].(string)
	if hid == "" || vid == "" || hid == vid || hr["mediaTransport"] != "webrtc" || source["sourceId"] != hid || roster["monitoring"] != true {
		t.Fatal(hr, vr, source, roster)
	}
	ids := roster["ids"].([]any)
	if len(ids) != 1 || ids[0] != vid {
		t.Fatal(ids)
	}
	ice := hr["iceServers"].([]any)
	if len(ice) != 2 {
		t.Fatal(ice)
	}
	turn := ice[1].(map[string]any)
	username := turn["username"].(string)
	if !strings.HasPrefix(username, fmt.Sprint(f.now.Unix()+3600)+":") {
		t.Fatal(username)
	}
	mac := hmac.New(sha1.New, []byte("shared-secret"))
	mac.Write([]byte(username))
	if turn["credential"] != base64.StdEncoding.EncodeToString(mac.Sum(nil)) || strings.Contains(fmt.Sprint(hr), "shared-secret") {
		t.Fatal(hr)
	}
	wsSend(t, h, rtcSignal(vid, "offer"))
	offer := rtcReadType(t, v, "signal")
	if offer["from"] != hid || offer["connectionId"] != "connection-1" {
		t.Fatal(offer)
	}
	wsSend(t, v, rtcSignal(hid, "answer"))
	if answer := rtcReadType(t, h, "signal"); answer["from"] != vid {
		t.Fatal(answer)
	}
	f.beat("camera", true, false)
	if source := rtcReadType(t, v, "source"); source["sourceId"] != hid {
		t.Fatal("heartbeat changed RTC identity", source)
	}
	// Periodic unchanged control state renews the six-second browser lease.
	rtcReadType(t, v, "source")
}
func TestRTCRejectsWrongMediaAndSignalRoles(t *testing.T) {
	for _, tc := range []struct {
		name, mode, role, typ string
		binary                bool
	}{
		{"rtc jpeg", "webrtc", "host", "", true}, {"viewer offer", "webrtc", "viewer", "offer", false}, {"host answer", "webrtc", "host", "answer", false}, {"ws signal", "websocket", "host", "offer", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var f *streamFixture
			if tc.mode == "webrtc" {
				f = setupRTC(t, "secret")
			} else {
				f = setupStream(t)
			}
			f.beat("camera", true, false)
			h, hr := rtcAuth(t, f, "host", "camera")
			wsJSON(t, h, "viewers")
			v, vr := rtcAuth(t, f, "viewer", "")
			wsJSON(t, v, "source")
			wsJSON(t, h, "viewers")
			c, target := h, vr["clientId"]
			if tc.role == "viewer" {
				c, target = v, hr["clientId"]
			}
			if tc.binary {
				wsWrite(t, c, websocket.MessageBinary, jpegFrame(1))
			} else {
				wsSend(t, c, rtcSignal(fmt.Sprint(target), tc.typ))
			}
			e := rtcReadType(t, c, "error")
			if e["status"] != float64(400) && e["status"] != float64(403) {
				t.Fatal(e)
			}
			wsClosed(t, c, websocket.StatusPolicyViolation)
		})
	}
}
func TestRTCRevocationUpdatesHostRoster(t *testing.T) {
	f := setupRTC(t, "secret")
	f.beat("camera", true, false)
	h, _ := rtcAuth(t, f, "host", "camera")
	wsJSON(t, h, "viewers")
	v, _ := rtcAuth(t, f, "viewer", "")
	wsJSON(t, v, "source")
	wsJSON(t, h, "viewers")
	f.call("POST", f.path("/pairing"), f.host, nil, 200)
	if state := rtcReadType(t, h, "viewers"); state["count"] != float64(0) || len(state["ids"].([]any)) != 0 {
		t.Fatal(state)
	}
	rtcReadType(t, v, "error")
	wsClosed(t, v, websocket.StatusPolicyViolation)
}
func TestRTCSignalSizeLimit(t *testing.T) {
	f := setupRTC(t, "secret")
	f.beat("camera", true, false)
	h, _ := rtcAuth(t, f, "host", "camera")
	wsJSON(t, h, "viewers")
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	_ = h.Write(ctx, websocket.MessageText, []byte(strings.Repeat("x", 64*1024+1)))
	wsClosed(t, h, websocket.StatusMessageTooBig)
}

func TestRTCExplicitlyDisabledSTUN(t *testing.T) {
	s, err := New(Config{DataDir: t.TempDir(), MediaTransport: "webrtc", STUNURLs: []string{}})
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if servers := s.iceServers("client", true); len(servers) != 0 {
		t.Fatal("empty STUN config should avoid external STUN", servers)
	}
}

func TestRTCSignalIsolationAndMalformedPayload(t *testing.T) {
	for _, tc := range []struct {
		name      string
		malformed bool
	}{
		{"other room", false}, {"malformed", true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := setupRTC(t, "secret")
			f.beat("camera", true, false)
			h, _ := rtcAuth(t, f, "host", "camera")
			wsJSON(t, h, "viewers")
			var room struct{ ID, ViewerToken string }
			decode(t, f.call("POST", "/api/rooms", testOwnerKey, map[string]any{"name": "Другой питомец"}, 201), &room)
			g := &streamFixture{fixture: &fixture{t: t, s: f.s, room: room.ID, viewer: room.ViewerToken}, http: f.http}
			other, ready := rtcAuth(t, g, "viewer", "")
			wsJSON(t, other, "source")
			message := rtcSignal(ready["clientId"].(string), "offer")
			if tc.malformed {
				message["from"] = "spoofed"
			}
			wsSend(t, h, message)
			e := rtcReadType(t, h, "error")
			want := float64(403)
			if tc.malformed {
				want = 400
			}
			if e["status"] != want {
				t.Fatal(e)
			}
			wsClosed(t, h, websocket.StatusPolicyViolation)
		})
	}
}

func TestRTCDepartureAndPauseDiscardSignals(t *testing.T) {
	f := setupRTC(t, "secret")
	f.beat("camera", true, false)
	h, hr := rtcAuth(t, f, "host", "camera")
	wsJSON(t, h, "viewers")
	v, vr := rtcAuth(t, f, "viewer", "")
	wsJSON(t, v, "source")
	wsJSON(t, h, "viewers")
	// Missing targets are ordinary disconnect races and must leave sender usable.
	wsSend(t, h, rtcSignal("departed-client", "offer"))
	f.beat("camera", false, false)
	for rtcReadType(t, h, "viewers")["monitoring"] != false {
	}
	wsSend(t, h, rtcSignal(vr["clientId"].(string), "offer"))
	wsSend(t, v, rtcSignal(hr["clientId"].(string), "answer"))
	// Wait for both paused signals to be consumed before independent HTTP resume.
	awaitStream(t, func() bool {
		f.s.mu.Lock()
		defer f.s.mu.Unlock()
		r := f.s.rooms[f.room]
		for c := range r.viewers {
			return !r.source.lastSignal.IsZero() && !c.lastSignal.IsZero()
		}
		return false
	})
	f.beat("camera", true, false)
	for rtcReadType(t, v, "source")["monitoring"] != true {
	}
	wsSend(t, h, rtcSignal(vr["clientId"].(string), "offer"))
	if got := rtcReadType(t, v, "signal"); got["from"] != hr["clientId"] {
		t.Fatal(got)
	}
}

func TestRTCSignalFIFOAndRateLimit(t *testing.T) {
	f := setupRTC(t, "secret")
	f.beat("camera", true, false)
	h, _ := rtcAuth(t, f, "host", "camera")
	wsJSON(t, h, "viewers")
	v, vr := rtcAuth(t, f, "viewer", "")
	wsJSON(t, v, "source")
	wsJSON(t, h, "viewers")
	for i := 0; i < 20; i++ {
		message := rtcSignal(vr["clientId"].(string), "candidate")
		message["connectionId"] = fmt.Sprint("connection-", i)
		wsSend(t, h, message)
	}
	for i := 0; i < 20; i++ {
		if got := rtcReadType(t, v, "signal")["connectionId"]; got != fmt.Sprint("connection-", i) {
			t.Fatal("out-of-order signaling", got, i)
		}
	}
	// Unknown destinations consume the same per-sender budget without filling a
	// receiver queue. The burst is 80 messages, refilling at 40 per second.
	for i := 0; i < 100; i++ {
		data, _ := json.Marshal(rtcSignal("gone", "candidate"))
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		err := h.Write(ctx, websocket.MessageText, data)
		cancel()
		if err != nil {
			break
		}
	}
	if e := rtcReadType(t, h, "error"); e["status"] != float64(429) {
		t.Fatal(e)
	}
	wsClosed(t, h, websocket.StatusPolicyViolation)
}

func setupGatedRTC(t *testing.T) (*streamFixture, chan *gatedStreamConn) {
	t.Helper()
	f := setup(t)
	f.s.Close()
	s, err := New(Config{DataDir: f.dir, RoomCreationKey: testOwnerKey, Now: func() time.Time { return f.now }, MediaTransport: "webrtc", STUNURLs: []string{}})
	if err != nil {
		t.Fatal(err)
	}
	f.s = s
	h := httptest.NewUnstartedServer(s.Handler())
	listener := &gatedStreamListener{Listener: h.Listener, accepted: make(chan *gatedStreamConn, 10)}
	h.Listener = listener
	h.Start()
	t.Cleanup(func() { s.Close(); h.Close() })
	return &streamFixture{f, h}, listener.accepted
}
func TestRTCQueueBoundsAndStalledWriter(t *testing.T) {
	for _, mode := range []string{"messages", "bytes", "deadline"} {
		t.Run(mode, func(t *testing.T) {
			f, accepted := setupGatedRTC(t)
			f.beat("camera", true, false)
			h, _ := rtcAuth(t, f, "host", "camera")
			<-accepted
			wsJSON(t, h, "viewers")
			v, vr := rtcAuth(t, f, "viewer", "")
			tcp := <-accepted
			wsJSON(t, v, "source")
			wsJSON(t, h, "viewers")
			tcp.block.Store(true)
			wsSend(t, h, rtcSignal(vr["clientId"].(string), "offer"))
			select {
			case <-tcp.entered:
			case <-time.After(time.Second):
				t.Fatal("signal write did not block")
			}
			if mode != "deadline" {
				n := 65
				size := 1
				if mode == "bytes" {
					n = 5
					size = 60 * 1024
				}
				for i := 0; i < n; i++ {
					message := rtcSignal(vr["clientId"].(string), "offer")
					message["signal"].(map[string]any)["sdp"] = strings.Repeat("s", size)
					wsSend(t, h, message)
				}
			}
			select {
			case <-tcp.closed:
			case <-time.After(3 * time.Second):
				t.Fatal("stalled/overflowed signaling did not close")
			}
			for state := rtcReadType(t, h, "viewers"); ; state = rtcReadType(t, h, "viewers") {
				if state["count"] == float64(0) {
					break
				}
			}
			f.beat("camera", true, false)
		})
	}
}

func TestRTCReplacedHostHasNewSocketIdentity(t *testing.T) {
	f := setupRTC(t, "secret")
	f.beat("camera", true, false)
	h, first := rtcAuth(t, f, "host", "camera")
	wsJSON(t, h, "viewers")
	v, _ := rtcAuth(t, f, "viewer", "")
	wsJSON(t, v, "source")
	wsJSON(t, h, "viewers")
	fresh, second := rtcAuth(t, f, "host", "camera")
	wsJSON(t, fresh, "viewers")
	wsClosed(t, h, websocket.StatusNormalClosure)
	if second["clientId"] == first["clientId"] {
		t.Fatal("reused RTC socket identity")
	}
	for source := rtcReadType(t, v, "source"); ; source = rtcReadType(t, v, "source") {
		if source["online"] == true {
			if source["sourceId"] != second["clientId"] {
				t.Fatal(source)
			}
			break
		}
	}
}

func TestMediaICEURLValidation(t *testing.T) {
	for _, raw := range []string{"stun:", "stun://host:3478", "stun:host:0", "stun:host:65536", "stun:user@host", "stun:host/path", "stun:host?transport=udp", "stun:host#fragment", "stun:host:garbage", "stun:host:", "stun:bad..host", "stun:-bad.host", "stun:bad-.host"} {
		t.Run(raw, func(t *testing.T) {
			s, err := New(Config{DataDir: t.TempDir(), MediaTransport: "webrtc", STUNURLs: []string{raw}})
			if s != nil {
				s.Close()
			}
			if err == nil {
				t.Fatal("invalid ICE URL accepted", raw)
			}
		})
	}
	for _, raw := range []string{"stun:localhost", "stun:stun.example:3478", "stuns:[2001:db8::1]:5349", "stun:127.0.0.1:3478"} {
		t.Run(raw, func(t *testing.T) {
			s, err := New(Config{DataDir: t.TempDir(), MediaTransport: "webrtc", STUNURLs: []string{raw}})
			if err != nil {
				t.Fatal(err)
			}
			s.Close()
		})
	}
}
func TestWebsocketReadyDefaultsAndNoICE(t *testing.T) {
	f := setupStream(t)
	c, ready := rtcAuth(t, f, "viewer", "")
	wsJSON(t, c, "source")
	if ready["mediaTransport"] != "websocket" || ready["clientId"] == "" || ready["iceServers"] != nil || f.state()["mediaTransport"] != "websocket" {
		t.Fatal(ready)
	}
}

func TestRTCRelayDoesNotExpandPastMessageLimit(t *testing.T) {
	f := setupRTC(t, "secret")
	f.beat("camera", true, false)
	h, _ := rtcAuth(t, f, "host", "camera")
	wsJSON(t, h, "viewers")
	v, vr := rtcAuth(t, f, "viewer", "")
	wsJSON(t, v, "source")
	wsJSON(t, h, "viewers")
	// A short raw JSON string can grow when encoding escapes HTML characters.
	// Enforce the message cap after encoding too, rather than exceeding it on
	// the receiving socket or letting one oversized relay consume its queue.
	raw := fmt.Sprintf(`{"type":"signal","target":%q,"connectionId":"expand","signal":{"type":"offer","sdp":"%s"}}`, vr["clientId"], strings.Repeat("<", 12*1024))
	wsWrite(t, h, websocket.MessageText, []byte(raw))
	e := rtcReadType(t, h, "error")
	if e["status"] != float64(400) {
		t.Fatal(e)
	}
	wsClosed(t, h, websocket.StatusPolicyViolation)
}
