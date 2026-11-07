package server

import (
	"bytes"
	"time"
)

const (
	// BKA1, a little-endian uint32 sequence, and 100 ms of mono PCM16 at 16 kHz.
	audioPacketBytes      = 8 + 1600*2
	audioPacketsPerSecond = 10
	audioBurst            = 3
	maxAudioQueue         = 5
	audioMaxAge           = 500 * time.Millisecond
)

type liveAudio struct {
	data     []byte
	source   *streamClient
	epoch    uint64
	received time.Time
}

func (c *streamClient) subscriptionMode() string {
	if c.mode == "" {
		return "video"
	}
	return c.mode
}

func (c *streamClient) wantsVideo() bool { return c.subscriptionMode() != "audio" }
func (c *streamClient) wantsAudio() bool { return c.mode == "audio" || c.mode == "audio-video" }

func (s *Server) receiveAudio(c *streamClient, data []byte) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.validStreamLocked(c) {
		return false
	}
	if c.role != "host" {
		s.closeStreamLocked(c, streamClose{code: 1008, status: 403, message: "Зритель не может публиковать звук"})
		return false
	}
	// Validate even when the sender has exhausted its media budget.
	if len(data) != audioPacketBytes || !bytes.Equal(data[:4], []byte("BKA1")) {
		s.closeStreamLocked(c, streamClose{code: 1008, status: 400, message: "Недопустимый аудиопакет"})
		return false
	}
	now := time.Now()
	if !c.lastAudio.IsZero() {
		c.audioCredit = min(audioBurst, c.audioCredit+now.Sub(c.lastAudio).Seconds()*audioPacketsPerSecond)
	}
	c.lastAudio = now
	if c.audioCredit < 1 {
		return true
	}
	c.audioCredit--
	r := s.rooms[c.roomID]
	if !s.sourceActiveLocked(r) {
		return true
	}
	packet := liveAudio{data: data, source: c, epoch: r.streamEpoch, received: now}
	for viewer := range r.viewers {
		if !viewer.wantsAudio() || !s.validStreamLocked(viewer) {
			continue
		}
		// A slow viewer loses the oldest audio; it never blocks another viewer
		// or displaces that viewer's independently bounded JPEG queue.
		select {
		case viewer.audio <- packet:
		default:
			select {
			case <-viewer.audio:
			default:
			}
			select {
			case viewer.audio <- packet:
			default:
			}
		}
	}
	return true
}

// Called immediately before socket delivery, under the same mutex used by
// revocation, source changes and registration of the cancellable write.
func (s *Server) validAudioLocked(c *streamClient, packet liveAudio) bool {
	r := s.rooms[c.roomID]
	return c.role == "viewer" && c.wantsAudio() && s.validStreamLocked(c) && r != nil &&
		r.source == packet.source && r.streamEpoch == packet.epoch && s.sourceActiveLocked(r) &&
		time.Since(packet.received) < audioMaxAge
}

// Revoke queued and in-flight sound immediately on viewer/source invalidation.
// Canceling a blocked WebSocket write closes that transport; its normal cleanup
// removes the viewer, allowing the browser to reconnect with current state.
func (s *Server) discardAudioLocked(c *streamClient) {
	if c.audioWriting && c.writeCancel != nil {
		c.writeCancel()
	}
	for {
		select {
		case <-c.audio:
		default:
			return
		}
	}
}
