package server

import (
	"strings"
	"testing"
	"time"
)

func TestRTCViewerFloodCannotCloseCamera(t *testing.T) {
	f, accepted := setupGatedRTC(t)
	f.beat("camera", true, false)
	h, hr := rtcAuth(t, f, "host", "camera")
	hostTCP := <-accepted
	wsJSON(t, h, "viewers")
	v, _ := rtcAuth(t, f, "viewer", "")
	<-accepted
	wsJSON(t, v, "source")
	wsJSON(t, h, "viewers")
	f.s.mu.Lock()
	source := f.s.rooms[f.room].source
	var attacker *streamClient
	for c := range f.s.rooms[f.room].viewers {
		attacker = c
	}
	f.s.mu.Unlock()
	hostTCP.block.Store(true)
	msg := rtcSignal(hr["clientId"].(string), "candidate")
	msg["signal"].(map[string]any)["candidate"] = map[string]any{"candidate": strings.Repeat("x", 60*1024)}
	wsSend(t, v, msg)
	select {
	case <-hostTCP.entered:
	case <-time.After(time.Second):
		t.Fatal("expected slow camera connection")
	}
	for i := 0; i < 5; i++ {
		wsSend(t, v, msg)
	}
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		f.s.mu.Lock()
		closed, attackerValid := source.closing, f.s.validStreamLocked(attacker)
		f.s.mu.Unlock()
		if closed {
			t.Fatal("viewer overflow disconnected camera")
		}
		if !attackerValid {
			f.s.mu.Lock()
			active := f.s.sourceActiveLocked(f.s.rooms[f.room])
			f.s.mu.Unlock()
			if !active {
				t.Fatal("camera no longer active")
			}
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("overflowing viewer was not disconnected")
}
