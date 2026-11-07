package server

import (
	"bytes"
	"context"
	"encoding/binary"
	"testing"
	"time"

	"github.com/coder/websocket"
)

// The fixture is deliberately independent of the production packet constants.
func pcmPacket(sequence uint32) []byte {
	data := make([]byte, 3208)
	copy(data, "BKA1")
	binary.LittleEndian.PutUint32(data[4:8], sequence)
	for i := 8; i < len(data); i += 2 {
		binary.LittleEndian.PutUint16(data[i:i+2], uint16(i))
	}
	return data
}

func audioViewer(t *testing.T, f *streamFixture, mode string) (*websocket.Conn, string) {
	t.Helper()
	c := f.dial()
	auth := map[string]any{"type": "auth", "role": "viewer", "token": f.viewer}
	if mode != "default" {
		auth["mode"] = mode
	}
	wsSend(t, c, auth)
	ready := wsJSON(t, c, "ready")
	wsJSON(t, c, "source")
	return c, ready["clientId"].(string)
}

func assertNoMedia(t *testing.T, c *websocket.Conn) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 150*time.Millisecond)
	defer cancel()
	for {
		kind, _, err := c.Read(ctx)
		if err != nil {
			return
		}
		if kind == websocket.MessageBinary {
			t.Fatal("received unrequested or stale media")
		}
	}
}

func TestStreamSubscriptionModesAndRoster(t *testing.T) {
	for _, transport := range []string{"websocket", "webrtc"} {
		t.Run(transport, func(t *testing.T) {
			f := setupStream(t)
			if transport == "webrtc" {
				f = setupRTC(t, "secret")
			}
			f.beat("camera", true, false)
			h := f.auth("host", "camera")
			initial := wsJSON(t, h, "viewers")
			if initial["videoCount"] != float64(0) || initial["audioCount"] != float64(0) {
				t.Fatal("missing empty subscription counts", initial)
			}
			wantModes := map[string]string{}
			var last map[string]any
			for _, mode := range []string{"default", "video", "audio", "audio-video"} {
				_, id := audioViewer(t, f, mode)
				if mode == "default" {
					mode = "video"
				}
				wantModes[id] = mode
				last = wsJSON(t, h, "viewers")
			}
			if last["count"] != float64(4) || last["videoCount"] != float64(3) || last["audioCount"] != float64(2) || len(last["ids"].([]any)) != 4 {
				t.Fatal(last)
			}
			modes, ok := last["modes"].(map[string]any)
			if !ok || len(modes) != 4 {
				t.Fatal("missing viewer modes", last)
			}
			for id, want := range wantModes {
				if modes[id] != want {
					t.Fatalf("viewer %s mode = %v, want %s", id, modes[id], want)
				}
			}
		})
	}
}

func TestStreamSubscriptionModeValidation(t *testing.T) {
	for _, role := range []string{"viewer", "host"} {
		for _, mode := range []any{"", "unknown", nil, 1, true, "audio", "video", "audio-video"} {
			if role == "viewer" && (mode == "audio" || mode == "video" || mode == "audio-video") {
				continue
			}
			t.Run(role+"/"+stringifyMode(mode), func(t *testing.T) {
				f := setupStream(t)
				f.beat("camera", true, false)
				c := f.dial()
				token := f.viewer
				if role == "host" {
					token = ""
				}
				wsSend(t, c, map[string]any{"type": "auth", "role": role, "token": token, "sessionId": "camera", "mode": mode})
				if got := wsJSON(t, c, "error"); got["status"] != float64(400) {
					t.Fatal(got)
				}
				wsClosed(t, c, websocket.StatusPolicyViolation)
			})
		}
	}
}

func stringifyMode(mode any) string {
	if mode == nil {
		return "null"
	}
	if text, ok := mode.(string); ok {
		return text
	}
	return "non-string"
}

func TestStreamAudioAndVideoReachOnlyRequestedViewers(t *testing.T) {
	f := setupStream(t)
	f.beat("camera", true, false)
	h := f.auth("host", "camera")
	wsJSON(t, h, "viewers")
	audio, _ := audioViewer(t, f, "audio")
	wsJSON(t, h, "viewers")
	video, _ := audioViewer(t, f, "default")
	wsJSON(t, h, "viewers")
	both, _ := audioViewer(t, f, "audio-video")
	wsJSON(t, h, "viewers")
	var other struct{ ID, ViewerToken string }
	decode(t, f.call("POST", "/api/rooms", testOwnerKey, map[string]any{"name": "Другой питомец"}, 201), &other)
	g := &streamFixture{fixture: &fixture{t: t, s: f.s, room: other.ID, viewer: other.ViewerToken}, http: f.http}
	isolated, _ := audioViewer(t, g, "audio-video")
	frame, packet := jpegFrame(45), pcmPacket(17)
	wsWrite(t, h, websocket.MessageBinary, frame)
	wsFrame(t, video, frame)
	wsFrame(t, both, frame)
	wsWrite(t, h, websocket.MessageBinary, packet)
	wsFrame(t, audio, packet)
	wsFrame(t, both, packet)
	assertNoMedia(t, audio)
	assertNoMedia(t, video)
	assertNoMedia(t, both)
	assertNoMedia(t, isolated)
}

func TestStreamAudioRejectsMalformedPacketsAndViewerPublishing(t *testing.T) {
	for _, tc := range []struct {
		name string
		data []byte
	}{
		{"short header", []byte("BKA1")},
		{"short payload", pcmPacket(1)[:3207]},
		{"oversized payload", append(pcmPacket(1), 0)},
		{"unknown version", append([]byte("BKA2"), pcmPacket(1)[4:]...)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := setupStream(t)
			f.beat("camera", true, false)
			h := f.auth("host", "camera")
			wsJSON(t, h, "viewers")
			wsWrite(t, h, websocket.MessageBinary, tc.data)
			if got := wsJSON(t, h, "error"); got["status"] != float64(400) {
				t.Fatal(got)
			}
			wsClosed(t, h, websocket.StatusPolicyViolation)
		})
	}
	f := setupStream(t)
	v, _ := audioViewer(t, f, "audio")
	wsWrite(t, v, websocket.MessageBinary, pcmPacket(1))
	if got := wsJSON(t, v, "error"); got["status"] != float64(403) {
		t.Fatal(got)
	}
	wsClosed(t, v, websocket.StatusPolicyViolation)
}

func TestStreamAudioRateLimitIsIndependentOfJPEG(t *testing.T) {
	f := setupStream(t)
	f.beat("camera", true, false)
	h := f.auth("host", "camera")
	wsJSON(t, h, "viewers")
	v, _ := audioViewer(t, f, "audio-video")
	wsJSON(t, h, "viewers")
	// Consume the JPEG burst; accepting audio must not depend on that budget.
	for i := range 2 {
		frame := jpegFrame(uint8(i))
		wsWrite(t, h, websocket.MessageBinary, frame)
		wsFrame(t, v, frame)
	}
	for sequence := uint32(1); sequence <= 3; sequence++ {
		packet := pcmPacket(sequence)
		wsWrite(t, h, websocket.MessageBinary, packet)
		wsFrame(t, v, packet)
	}
	for sequence := uint32(4); sequence <= 20; sequence++ {
		wsWrite(t, h, websocket.MessageBinary, pcmPacket(sequence))
	}
	time.Sleep(220 * time.Millisecond)
	frame := jpegFrame(9)
	wsWrite(t, h, websocket.MessageBinary, frame)
	wsFrame(t, v, frame)
	packet := pcmPacket(21)
	wsWrite(t, h, websocket.MessageBinary, packet)
	kind, got := wsRead(t, v)
	if kind != websocket.MessageBinary || !bytes.Equal(got, packet) {
		t.Fatal("audio rate limit replayed a burst or did not recover")
	}
}

func streamByID(t *testing.T, f *streamFixture, id string) *streamClient {
	t.Helper()
	f.s.mu.Lock()
	defer f.s.mu.Unlock()
	for c := range f.s.streams {
		if c.clientID == id {
			return c
		}
	}
	t.Fatal("missing authenticated stream", id)
	return nil
}

func TestStreamAudioSlowViewerQueueIsBoundedAndDoesNotDisplaceJPEG(t *testing.T) {
	f, accepted := setupGatedStream(t)
	f.beat("camera", true, false)
	h := f.auth("host", "camera")
	<-accepted
	wsJSON(t, h, "viewers")
	fast, _ := audioViewer(t, f, "audio-video")
	<-accepted
	wsJSON(t, h, "viewers")
	slow, id := audioViewer(t, f, "audio-video")
	tcp := <-accepted
	wsJSON(t, h, "viewers")
	c := streamByID(t, f, id)
	tcp.block.Store(true)
	first, latest := jpegFrame(1), jpegFrame(2)
	wsWrite(t, h, websocket.MessageBinary, first)
	wsFrame(t, fast, first)
	select {
	case <-tcp.entered:
	case <-time.After(time.Second):
		t.Fatal("JPEG write did not block")
	}
	wsWrite(t, h, websocket.MessageBinary, latest)
	wsFrame(t, fast, latest)
	for sequence := uint32(1); sequence <= 7; sequence++ {
		if sequence > 1 {
			time.Sleep(105 * time.Millisecond)
		}
		packet := pcmPacket(sequence)
		wsWrite(t, h, websocket.MessageBinary, packet)
		wsFrame(t, fast, packet)
	}
	f.s.mu.Lock()
	audioCount, videoCount := len(c.audio), len(c.frames)
	f.s.mu.Unlock()
	if audioCount != 5 || videoCount != 1 {
		t.Fatalf("slow viewer queue has %d audio and %d JPEG packets, want 5 and 1", audioCount, videoCount)
	}
	close(tcp.release)
	wsFrame(t, slow, first)
	wantAudio := uint32(3)
	gotJPEG := false
	for i := 0; i < 6; i++ {
		kind, got := wsRead(t, slow)
		if kind != websocket.MessageBinary {
			t.Fatal("unexpected state change")
		}
		if bytes.Equal(got, latest) {
			if gotJPEG {
				t.Fatal("duplicate JPEG")
			}
			gotJPEG = true
			continue
		}
		if !bytes.Equal(got, pcmPacket(wantAudio)) {
			t.Fatalf("wrong retained audio; want sequence %d", wantAudio)
		}
		wantAudio++
	}
	if !gotJPEG || wantAudio != 8 {
		t.Fatal("lost an independent media queue")
	}
}

func TestStreamAudioQueuedDataIsDiscardedAcrossSourceChanges(t *testing.T) {
	for _, transition := range []string{"age", "pause", "replacement", "expired"} {
		t.Run(transition, func(t *testing.T) {
			f, accepted := setupGatedStream(t)
			f.beat("camera", true, false)
			h := f.auth("host", "camera")
			<-accepted
			wsJSON(t, h, "viewers")
			v, id := audioViewer(t, f, "audio-video")
			tcp := <-accepted
			wsJSON(t, h, "viewers")
			c := streamByID(t, f, id)
			tcp.block.Store(true)
			frame := jpegFrame(1)
			wsWrite(t, h, websocket.MessageBinary, frame)
			select {
			case <-tcp.entered:
			case <-time.After(time.Second):
				t.Fatal("JPEG write did not block")
			}
			wsWrite(t, h, websocket.MessageBinary, pcmPacket(1))
			awaitStream(t, func() bool { return len(c.audio) == 1 })
			switch transition {
			case "age":
				time.Sleep(550 * time.Millisecond)
			case "pause":
				f.beat("camera", false, false)
				f.beat("camera", true, false)
			case "replacement":
				h = f.auth("host", "camera")
				<-accepted
				wsJSON(t, h, "viewers")
			case "expired":
				f.s.mu.Lock()
				f.now = f.now.Add(16 * time.Second)
				f.s.mu.Unlock()
			}
			close(tcp.release)
			wsFrame(t, v, frame)
			if transition == "expired" {
				assertNoMedia(t, v)
				return
			}
			packet := pcmPacket(2)
			wsWrite(t, h, websocket.MessageBinary, packet)
			wsFrame(t, v, packet)
		})
	}
}

func TestStreamAudioRevocationClearsQueueAndCancelsBlockedWrite(t *testing.T) {
	for _, transition := range []string{"viewer-revoked", "source-paused", "source-replaced"} {
		t.Run(transition, func(t *testing.T) {
			f, accepted := setupGatedStream(t)
			f.beat("camera", true, false)
			h := f.auth("host", "camera")
			<-accepted
			wsJSON(t, h, "viewers")
			_, id := audioViewer(t, f, "audio")
			tcp := <-accepted
			wsJSON(t, h, "viewers")
			c := streamByID(t, f, id)
			tcp.block.Store(true)
			wsWrite(t, h, websocket.MessageBinary, pcmPacket(1))
			select {
			case <-tcp.entered:
			case <-time.After(time.Second):
				t.Fatal("audio write did not block")
			}
			wsWrite(t, h, websocket.MessageBinary, pcmPacket(2))
			awaitStream(t, func() bool { return len(c.audio) == 1 })
			switch transition {
			case "viewer-revoked":
				f.call("POST", f.path("/pairing"), f.host, nil, 200)
			case "source-paused":
				f.beat("camera", false, false)
			case "source-replaced":
				f.beat("replacement", true, false)
			}
			select {
			case <-tcp.closed:
			case <-time.After(200 * time.Millisecond):
				t.Fatal("invalidated audio write was not canceled promptly")
			}
			if len(c.audio) != 0 {
				t.Fatal("invalidated audio remains queued")
			}
		})
	}
}
