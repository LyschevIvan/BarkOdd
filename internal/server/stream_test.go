package server

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"image"
	"image/jpeg"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"
)

type streamFixture struct {
	*fixture
	http *httptest.Server
}

func setupStream(t *testing.T) *streamFixture {
	f := setup(t)
	h := httptest.NewServer(f.s.Handler())
	t.Cleanup(func() { f.s.Close(); h.Close() })
	return &streamFixture{f, h}
}
func (f *streamFixture) dial() *websocket.Conn {
	f.t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), time.Second*3)
	defer cancel()
	c, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(f.http.URL, "http")+f.path("/stream"), &websocket.DialOptions{HTTPHeader: http.Header{"Origin": []string{f.http.URL}, "Cookie": []string{f.ensureCookie().String()}}})
	if err != nil {
		f.t.Fatalf("WebSocket upgrade: %v", err)
	}
	f.t.Cleanup(func() { c.CloseNow() })
	return c
}
func wsSend(t *testing.T, c *websocket.Conn, value any) {
	t.Helper()
	data, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	wsWrite(t, c, websocket.MessageText, data)
}
func wsWrite(t *testing.T, c *websocket.Conn, kind websocket.MessageType, data []byte) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if err := c.Write(ctx, kind, data); err != nil {
		t.Fatal(err)
	}
}
func wsRead(t *testing.T, c *websocket.Conn) (websocket.MessageType, []byte) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	kind, data, err := c.Read(ctx)
	if err != nil {
		t.Fatal(err)
	}
	return kind, data
}
func wsJSON(t *testing.T, c *websocket.Conn, typ string) map[string]any {
	t.Helper()
	kind, data := wsRead(t, c)
	if kind != websocket.MessageText {
		t.Fatalf("want %s control, got binary", typ)
	}
	var v map[string]any
	if err := json.Unmarshal(data, &v); err != nil {
		t.Fatal(err)
	}
	if v["type"] != typ {
		t.Fatalf("want %s, got %s", typ, data)
	}
	return v
}
func wsClosed(t *testing.T, c *websocket.Conn, want websocket.StatusCode) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	_, _, err := c.Read(ctx)
	if websocket.CloseStatus(err) != want {
		t.Fatalf("close: %v, want %v", err, want)
	}
}
func (f *streamFixture) auth(role, session string) *websocket.Conn {
	f.t.Helper()
	c := f.dial()
	token := f.viewer
	if role == "host" {
		token = ""
	}
	wsSend(f.t, c, map[string]any{"type": "auth", "role": role, "token": token, "sessionId": session})
	if got := wsJSON(f.t, c, "ready"); got["role"] != role {
		f.t.Fatal(got)
	}
	return c
}
func (f *streamFixture) beat(session string, monitoring, stopped bool) {
	f.call("POST", f.path("/heartbeat"), f.host, map[string]any{"sessionId": session, "monitoring": monitoring, "stopped": stopped}, 200)
}
func jpegFrame(red uint8) []byte {
	data, _ := base64.StdEncoding.DecodeString(strings.TrimPrefix(photo(red), "data:image/jpeg;base64,"))
	return data
}
func wsFrame(t *testing.T, c *websocket.Conn, want []byte) {
	t.Helper()
	for i := 0; i < 6; i++ {
		kind, data := wsRead(t, c)
		if kind == websocket.MessageBinary {
			if !bytes.Equal(data, want) {
				t.Fatal("wrong JPEG bytes")
			}
			return
		}
	}
	t.Fatal("no binary JPEG")
}

// These tests catch upgrades accidentally passing through the JSON buffering
// path, unauthenticated fanout, missing role checks and altered JPEG payloads.
func TestStreamAuthenticatedBinaryDeliveryAndViewerCount(t *testing.T) {
	f := setupStream(t)
	f.beat("camera", true, false)
	host := f.auth("host", "camera")
	if v := wsJSON(t, host, "viewers"); v["count"] != float64(0) {
		t.Fatal(v)
	}
	viewer := f.auth("viewer", "")
	if v := wsJSON(t, viewer, "source"); v["online"] != true || v["monitoring"] != true {
		t.Fatal(v)
	}
	if v := wsJSON(t, host, "viewers"); v["count"] != float64(1) {
		t.Fatal(v)
	}
	frame := jpegFrame(20)
	wsWrite(t, host, websocket.MessageBinary, frame)
	wsFrame(t, viewer, frame)
	viewer.CloseNow()
	if v := wsJSON(t, host, "viewers"); v["count"] != float64(0) {
		t.Fatal(v)
	}
}
func TestStreamAuthRejectsInvalidCredentialsAndRoles(t *testing.T) {
	for _, tc := range []struct {
		name, role, token, session string
		status                     int
	}{
		{"bad key", "viewer", "wrong", "", 401}, {"viewer as host", "host", "viewer", "camera", 403}, {"old host key", "viewer", "old-host", "", 401}, {"invalid role", "admin", "host", "", 400}, {"missing session", "host", "host", "", 400}, {"unknown session", "host", "host", "unknown", 403},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := setupStream(t)
			f.beat("camera", true, false)
			c := f.dial()
			token := tc.token
			if token == "old-host" {
				token = f.host
			}
			if token == "host" {
				token = ""
			}
			if token == "viewer" {
				token = f.viewer
			}
			wsSend(t, c, map[string]any{"type": "auth", "role": tc.role, "token": token, "sessionId": tc.session})
			if v := wsJSON(t, c, "error"); v["status"] != float64(tc.status) {
				t.Fatal(v)
			}
			wsClosed(t, c, websocket.StatusPolicyViolation)
		})
	}
}
func TestStreamRejectsOriginAndQueryCredentials(t *testing.T) {
	f := setupStream(t)
	for _, tc := range []struct {
		origin, query string
		status        int
	}{{"https://evil.example", "", 403}, {"", "", 403}, {f.http.URL, "?token=" + f.viewer, 400}, {f.http.URL + "/path", "", 403}} {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		c, r, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(f.http.URL, "http")+f.path("/stream")+tc.query, &websocket.DialOptions{HTTPHeader: http.Header{"Origin": []string{tc.origin}}})
		cancel()
		if c != nil {
			c.CloseNow()
		}
		if err == nil || r == nil || r.StatusCode != tc.status {
			t.Fatalf("origin %q query %q: response %v error %v", tc.origin, tc.query, r, err)
		}
	}
}
func TestStreamViewerCannotPublish(t *testing.T) {
	f := setupStream(t)
	v := f.auth("viewer", "")
	wsJSON(t, v, "source")
	wsWrite(t, v, websocket.MessageBinary, jpegFrame(1))
	if e := wsJSON(t, v, "error"); e["status"] != float64(403) {
		t.Fatal(e)
	}
	wsClosed(t, v, websocket.StatusPolicyViolation)
}
func TestStreamAuthTimeoutReleasesConnection(t *testing.T) {
	f := setupStream(t)
	c := f.dial()
	ctx, cancel := context.WithTimeout(context.Background(), 7*time.Second)
	defer cancel()
	_, data, err := c.Read(ctx)
	if err != nil {
		t.Fatal(err)
	}
	var v map[string]any
	if json.Unmarshal(data, &v) != nil || v["type"] != "error" || v["status"] != float64(401) {
		t.Fatal(string(data))
	}
	wsClosed(t, c, websocket.StatusPolicyViolation)
}
func TestStreamPauseResumeAndTerminalStop(t *testing.T) {
	f := setupStream(t)
	f.beat("camera", true, false)
	h := f.auth("host", "camera")
	wsJSON(t, h, "viewers")
	v := f.auth("viewer", "")
	wsJSON(t, v, "source")
	wsJSON(t, h, "viewers")
	f.beat("camera", false, false)
	if state := wsJSON(t, h, "viewers"); state["monitoring"] != false {
		t.Fatal(state)
	}
	if state := wsJSON(t, v, "source"); state["monitoring"] != false {
		t.Fatal(state)
	}
	wsWrite(t, h, websocket.MessageBinary, jpegFrame(1))
	// Wait until the server has consumed the paused frame before resuming over
	// the independent HTTP connection. TCP write completion is not an ack.
	awaitStream(t, func() bool { f.s.mu.Lock(); defer f.s.mu.Unlock(); return !f.s.rooms[f.room].source.lastFrame.IsZero() })
	f.beat("camera", true, false)
	if state := wsJSON(t, h, "viewers"); state["monitoring"] != true {
		t.Fatal(state)
	}
	if state := wsJSON(t, v, "source"); state["monitoring"] != true {
		t.Fatal(state)
	}
	time.Sleep(210 * time.Millisecond)
	frame := jpegFrame(2)
	wsWrite(t, h, websocket.MessageBinary, frame)
	wsFrame(t, v, frame)
	f.beat("camera", false, true)
	wsClosed(t, h, websocket.StatusNormalClosure)
	if state := wsJSON(t, v, "source"); state["monitoring"] != false {
		t.Fatal(state)
	}
	c := f.dial()
	wsSend(t, c, map[string]any{"type": "auth", "role": "host", "token": "", "sessionId": "camera"})
	if e := wsJSON(t, c, "error"); e["status"] != float64(403) {
		t.Fatal(e)
	}
	wsClosed(t, c, websocket.StatusPolicyViolation)
}
func TestStreamPairingRevocationClosesOldViewer(t *testing.T) {
	f := setupStream(t)
	f.beat("camera", true, false)
	h := f.auth("host", "camera")
	wsJSON(t, h, "viewers")
	v := f.auth("viewer", "")
	wsJSON(t, v, "source")
	wsJSON(t, h, "viewers")
	response := f.call("POST", f.path("/pairing"), f.host, nil, 200)
	var pair struct{ ViewerToken string }
	decode(t, response, &pair)
	if e := wsJSON(t, v, "error"); e["status"] != float64(401) {
		t.Fatal(e)
	}
	wsClosed(t, v, websocket.StatusPolicyViolation)
	if count := wsJSON(t, h, "viewers"); count["count"] != float64(0) {
		t.Fatal(count)
	}
	f.viewer = pair.ViewerToken
	fresh := f.auth("viewer", "")
	wsJSON(t, fresh, "source")
	wsJSON(t, h, "viewers")
	frame := jpegFrame(3)
	wsWrite(t, h, websocket.MessageBinary, frame)
	wsFrame(t, fresh, frame)
}
func TestStreamCloseStopsActiveAndPendingSockets(t *testing.T) {
	f := setupStream(t)
	v := f.auth("viewer", "")
	wsJSON(t, v, "source")
	pending := f.dial()
	done := make(chan struct{})
	go func() { f.s.Close(); close(done) }()
	wsClosed(t, v, websocket.StatusServiceRestart)
	wsClosed(t, pending, websocket.StatusServiceRestart)
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("Server.Close leaked stream goroutines")
	}
}

func awaitStream(t *testing.T, condition func() bool) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if condition() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("stream state did not settle")
}

func TestStreamReplacedAndExpiredSourcesCannotPublish(t *testing.T) {
	for _, mode := range []string{"replaced", "expired"} {
		t.Run(mode, func(t *testing.T) {
			f := setupStream(t)
			f.beat("first", true, false)
			h := f.auth("host", "first")
			wsJSON(t, h, "viewers")
			v := f.auth("viewer", "")
			wsJSON(t, v, "source")
			wsJSON(t, h, "viewers")
			if mode == "replaced" {
				f.beat("second", true, false)
				wsClosed(t, h, websocket.StatusNormalClosure)
			} else {
				f.s.mu.Lock()
				f.now = f.now.Add(16 * time.Second)
				f.s.mu.Unlock()
			}
			if state := wsJSON(t, v, "source"); state["online"] != false || state["monitoring"] != false {
				t.Fatal(state)
			}
			if mode == "expired" {
				wsWrite(t, h, websocket.MessageBinary, jpegFrame(11))
				awaitStream(t, func() bool { f.s.mu.Lock(); defer f.s.mu.Unlock(); return !f.s.rooms[f.room].source.lastFrame.IsZero() })
			}
			f.beat("second", true, false)
			fresh := f.auth("host", "second")
			wsJSON(t, fresh, "viewers")
			if state := wsJSON(t, v, "source"); state["monitoring"] != true {
				t.Fatal(state)
			}
			frame := jpegFrame(22)
			wsWrite(t, fresh, websocket.MessageBinary, frame)
			wsFrame(t, v, frame)
		})
	}
}
func TestStreamNewViewerDoesNotReceivePreviousFrame(t *testing.T) {
	f := setupStream(t)
	f.beat("camera", true, false)
	h := f.auth("host", "camera")
	wsJSON(t, h, "viewers")
	first := f.auth("viewer", "")
	wsJSON(t, first, "source")
	wsJSON(t, h, "viewers")
	old := jpegFrame(23)
	wsWrite(t, h, websocket.MessageBinary, old)
	wsFrame(t, first, old)
	second := f.auth("viewer", "")
	wsJSON(t, second, "source")
	wsJSON(t, h, "viewers")
	frame := jpegFrame(44)
	wsWrite(t, h, websocket.MessageBinary, frame)
	wsFrame(t, second, frame)
}
func TestStreamPublicURLOriginThroughSubpathProxy(t *testing.T) {
	f := setup(t)
	f.s.Close()
	var err error
	f.s, err = New(Config{DataDir: f.dir, RoomCreationKey: testOwnerKey, PublicURL: "https://camera.example/barkodd/"})
	if err != nil {
		t.Fatal(err)
	}
	proxy := httptest.NewServer(http.StripPrefix("/barkodd", f.s.Handler()))
	t.Cleanup(func() { f.s.Close(); proxy.Close() })
	endpoint := "ws" + strings.TrimPrefix(proxy.URL, "http") + "/barkodd" + f.path("/stream")
	for _, origin := range []string{proxy.URL, "http://camera.example", "https://camera.example.evil", "https://camera.example"} {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second*3)
		c, response, err := websocket.Dial(ctx, endpoint, &websocket.DialOptions{HTTPHeader: http.Header{"Origin": []string{origin}}})
		cancel()
		if origin != "https://camera.example" {
			if c != nil {
				c.CloseNow()
			}
			if err == nil || response.StatusCode != 403 {
				t.Fatalf("accepted proxy/foreign origin %q", origin)
			}
			continue
		}
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { c.CloseNow() })
		wsSend(t, c, map[string]any{"type": "auth", "role": "viewer", "token": f.viewer})
		wsJSON(t, c, "ready")
		wsJSON(t, c, "source")
	}
}
func TestStreamBoundsViewersAndPendingAuthentication(t *testing.T) {
	t.Run("viewers", func(t *testing.T) {
		f := setupStream(t)
		for i := 0; i < 6; i++ {
			v := f.auth("viewer", "")
			wsJSON(t, v, "source")
		}
		c := f.dial()
		wsSend(t, c, map[string]any{"type": "auth", "role": "viewer", "token": f.viewer})
		if v := wsJSON(t, c, "error"); v["status"] != float64(429) {
			t.Fatal(v)
		}
		wsClosed(t, c, websocket.StatusPolicyViolation)
	})
	t.Run("pending auth", func(t *testing.T) {
		f := setupStream(t)
		for i := 0; i < 32; i++ {
			f.dial()
		}
		ctx, cancel := context.WithTimeout(context.Background(), time.Second*3)
		defer cancel()
		c, r, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(f.http.URL, "http")+f.path("/stream"), &websocket.DialOptions{HTTPHeader: http.Header{"Origin": []string{f.http.URL}}})
		if c != nil {
			c.CloseNow()
		}
		if err == nil || r == nil || r.StatusCode != 429 {
			t.Fatal("unbounded unauthenticated sockets", r, err)
		}
		// An unauthenticated pool cannot hold the room mutex or prevent HTTP API use.
		f.beat("healthy", true, false)
	})
}
func TestStreamRejectsOversizedAndInvalidJPEG(t *testing.T) {
	encoded := func(width, height int) []byte {
		var b bytes.Buffer
		if err := jpeg.Encode(&b, image.NewGray(image.Rect(0, 0, width, height)), nil); err != nil {
			t.Fatal(err)
		}
		return b.Bytes()
	}
	for _, tc := range []struct {
		name  string
		data  []byte
		close websocket.StatusCode
	}{
		{"not jpeg", []byte("not an image"), 1008}, {"too wide", encoded(1281, 2), 1008}, {"too tall", encoded(2, 1281), 1008}, {"too many pixels", encoded(1280, 721), 1008}, {"too many bytes", append(jpegFrame(1), make([]byte, 200*1024)...), 1009},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := setupStream(t)
			f.beat("camera", true, false)
			h := f.auth("host", "camera")
			wsJSON(t, h, "viewers")
			wsWrite(t, h, websocket.MessageBinary, tc.data)
			if tc.close == 1008 {
				if v := wsJSON(t, h, "error"); v["status"] != float64(400) {
					t.Fatal(v)
				}
			}
			wsClosed(t, h, tc.close)
		})
	}
}
func TestStreamRetiredTransportEndpointsAreGone(t *testing.T) {
	f := setup(t)
	f.call("GET", f.path("/ice"), f.viewer, nil, 404)
	f.call("GET", f.path("/signals"), f.viewer, nil, 404)
	f.call("POST", f.path("/signals"), f.host, map[string]any{}, 404)
}

// A gated connection models a viewer whose TCP receive window has stopped
// advancing, without relying on platform-specific loopback socket buffer sizes.
// All HTTP and WebSocket parsing still uses the real server and library.
type gatedStreamConn struct {
	net.Conn
	block   atomic.Bool
	entered chan struct{}
	release chan struct{}
	closed  chan struct{}
	once    sync.Once
}

func (c *gatedStreamConn) Write(data []byte) (int, error) {
	if c.block.Load() {
		select {
		case c.entered <- struct{}{}:
		default:
		}
		select {
		case <-c.release:
		case <-c.closed:
			return 0, net.ErrClosed
		}
	}
	return c.Conn.Write(data)
}
func (c *gatedStreamConn) Close() error { c.once.Do(func() { close(c.closed) }); return c.Conn.Close() }

type gatedStreamListener struct {
	net.Listener
	accepted chan *gatedStreamConn
}

func (l *gatedStreamListener) Accept() (net.Conn, error) {
	c, err := l.Listener.Accept()
	if err != nil {
		return nil, err
	}
	gate := &gatedStreamConn{Conn: c, entered: make(chan struct{}, 1), release: make(chan struct{}), closed: make(chan struct{})}
	l.accepted <- gate
	return gate, nil
}
func setupGatedStream(t *testing.T) (*streamFixture, chan *gatedStreamConn) {
	f := setup(t)
	h := httptest.NewUnstartedServer(f.s.Handler())
	listener := &gatedStreamListener{Listener: h.Listener, accepted: make(chan *gatedStreamConn, 10)}
	h.Listener = listener
	h.Start()
	t.Cleanup(func() { f.s.Close(); h.Close() })
	return &streamFixture{f, h}, listener.accepted
}
func TestStreamSlowViewerDoesNotBlockFastViewerOrRooms(t *testing.T) {
	f, accepted := setupGatedStream(t)
	f.beat("camera", true, false)
	h := f.auth("host", "camera")
	<-accepted
	wsJSON(t, h, "viewers")
	fast := f.auth("viewer", "")
	<-accepted
	wsJSON(t, fast, "source")
	wsJSON(t, h, "viewers")
	slow := f.auth("viewer", "")
	slowTCP := <-accepted
	wsJSON(t, slow, "source")
	wsJSON(t, h, "viewers")
	slowTCP.block.Store(true)
	first := jpegFrame(1)
	wsWrite(t, h, websocket.MessageBinary, first)
	wsFrame(t, fast, first)
	select {
	case <-slowTCP.entered:
	case <-time.After(time.Second):
		t.Fatal("slow viewer write was not attempted")
	}
	// Existing room heartbeats and another room must work while slow I/O waits.
	other := f.call("POST", "/api/rooms", testOwnerKey, map[string]any{"name": "Другой питомец"}, 201)
	var room struct{ ID, HostToken string }
	decode(t, other, &room)
	f.call("POST", "/api/rooms/"+room.ID+"/heartbeat", room.HostToken, map[string]any{"monitoring": true, "sessionId": "other"}, 200)
	f.beat("camera", true, false)
	var latest []byte
	for i := 2; i <= 5; i++ {
		time.Sleep(210 * time.Millisecond)
		latest = jpegFrame(uint8(i))
		wsWrite(t, h, websocket.MessageBinary, latest)
		wsFrame(t, fast, latest)
	}
	close(slowTCP.release)
	// The in-flight frame can finish, followed only by the latest queued one.
	wsFrame(t, slow, first)
	wsFrame(t, slow, latest)
}
func TestStreamStalledViewerWriteClosesAtDeadline(t *testing.T) {
	f, accepted := setupGatedStream(t)
	f.beat("camera", true, false)
	h := f.auth("host", "camera")
	<-accepted
	wsJSON(t, h, "viewers")
	slow := f.auth("viewer", "")
	tcp := <-accepted
	wsJSON(t, slow, "source")
	wsJSON(t, h, "viewers")
	tcp.block.Store(true)
	wsWrite(t, h, websocket.MessageBinary, jpegFrame(1))
	select {
	case <-tcp.closed:
	case <-time.After(3 * time.Second):
		t.Fatal("stalled write did not close")
	}
	if count := wsJSON(t, h, "viewers"); count["count"] != float64(0) {
		t.Fatal(count)
	}
}
func TestStreamBurstIsDroppedAndSustainedRateRecovers(t *testing.T) {
	f := setupStream(t)
	f.beat("camera", true, false)
	h := f.auth("host", "camera")
	wsJSON(t, h, "viewers")
	v := f.auth("viewer", "")
	wsJSON(t, v, "source")
	wsJSON(t, h, "viewers")
	frames := make(chan []byte, 32)
	readDone := make(chan struct{})
	go func() {
		defer close(readDone)
		for {
			kind, data, err := v.Read(context.Background())
			if err != nil {
				return
			}
			if kind == websocket.MessageBinary {
				frames <- data
			}
		}
	}()
	t.Cleanup(func() { v.CloseNow(); <-readDone })
	for i := 0; i < 20; i++ {
		wsWrite(t, h, websocket.MessageBinary, jpegFrame(5))
	}
	// Consume the initial allowance, then establish that an immediate burst did
	// not reach the viewer. A later frame must be accepted after refill.
	time.Sleep(100 * time.Millisecond)
	if got := len(frames); got > 2 || got == 0 {
		t.Fatalf("burst delivered %d frames", got)
	}
	for len(frames) > 0 {
		<-frames
	}
	time.Sleep(150 * time.Millisecond)
	want := jpegFrame(9)
	wsWrite(t, h, websocket.MessageBinary, want)
	select {
	case got := <-frames:
		if !bytes.Equal(got, want) {
			t.Fatal("rate limiter replayed stale frame")
		}
	case <-time.After(time.Second):
		t.Fatal("rate limiter did not recover")
	}
}

func TestStreamRevocationCancelsBlockedFrameImmediately(t *testing.T) {
	f, accepted := setupGatedStream(t)
	f.beat("camera", true, false)
	h := f.auth("host", "camera")
	<-accepted
	wsJSON(t, h, "viewers")
	slow := f.auth("viewer", "")
	tcp := <-accepted
	wsJSON(t, slow, "source")
	wsJSON(t, h, "viewers")
	tcp.block.Store(true)
	wsWrite(t, h, websocket.MessageBinary, jpegFrame(1))
	select {
	case <-tcp.entered:
	case <-time.After(time.Second):
		t.Fatal("frame write did not block")
	}
	f.call("POST", f.path("/pairing"), f.host, nil, 200)
	select {
	case <-tcp.closed:
	case <-time.After(500 * time.Millisecond):
		t.Fatal("revoked viewer still has an active frame write")
	}
	if count := wsJSON(t, h, "viewers"); count["count"] != float64(0) {
		t.Fatal(count)
	}
}

func TestStreamCloseBoundsUnresponsiveCloseHandshake(t *testing.T) {
	f := setupStream(t)
	c := f.dial()
	wsSend(t, c, map[string]any{"type": "auth", "role": "viewer", "token": "wrong"})
	awaitStream(t, func() bool {
		f.s.mu.Lock()
		defer f.s.mu.Unlock()
		for stream := range f.s.streams {
			if stream.closing {
				return true
			}
		}
		return false
	})
	done := make(chan struct{})
	go func() { f.s.Close(); close(done) }()
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		c.CloseNow()
		<-done
		t.Fatal("close handshake exceeded shutdown deadline")
	}
}
