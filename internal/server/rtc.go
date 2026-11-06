package server

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha1"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/url"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/coder/websocket"
)

const (
	maxSignalBytes      = 64 * 1024
	maxSignalQueue      = 64
	maxSignalQueueBytes = 256 * 1024
	signalRate          = 40
	signalBurst         = 80
)

type iceServer struct {
	URLs       []string `json:"urls"`
	Username   string   `json:"username,omitempty"`
	Credential string   `json:"credential,omitempty"`
}

func validateMediaConfig(c *Config) error {
	if c.MediaTransport == "" {
		c.MediaTransport = "websocket"
	}
	if c.MediaTransport != "websocket" && c.MediaTransport != "webrtc" {
		return errors.New("MEDIA_TRANSPORT must be websocket or webrtc")
	}
	if c.MediaTransport == "websocket" {
		return nil
	}
	if (c.TURNUsername == "") != (c.TURNPassword == "") {
		return errors.New("TURN_USERNAME and TURN_PASSWORD must be supplied together")
	}
	if c.TURNSecret != "" && (c.TURNUsername != "" || c.TURNPassword != "") {
		return errors.New("TURN_SECRET cannot be combined with static TURN credentials")
	}
	if len(c.TURNURLs) > 0 && c.TURNSecret == "" && c.TURNUsername == "" {
		return errors.New("TURN_URLS requires TURN_SECRET or TURN_USERNAME/TURN_PASSWORD")
	}
	if c.STUNURLs == nil {
		c.STUNURLs = []string{"stun:stun.l.google.com:19302"}
	}
	for _, group := range []struct {
		name    string
		urls    []string
		schemes []string
	}{
		{"STUN_URLS", c.STUNURLs, []string{"stun", "stuns"}},
		{"TURN_URLS", c.TURNURLs, []string{"turn", "turns"}},
	} {
		for _, raw := range group.urls {
			if !validICEURL(raw, group.schemes) {
				return fmt.Errorf("invalid %s URL", group.name)
			}
		}
	}
	// Keep owned slices independent of callers after validation.
	c.STUNURLs = slices.Clone(c.STUNURLs)
	c.TURNURLs = slices.Clone(c.TURNURLs)
	return nil
}

func validICEURL(raw string, schemes []string) bool {
	if strings.ContainsAny(raw, " \t\r\n#") {
		return false
	}
	u, err := url.Parse(raw)
	if err != nil || u == nil || !slices.Contains(schemes, u.Scheme) || u.Opaque == "" || u.Host != "" || u.Fragment != "" {
		return false
	}
	endpoint := u.Opaque
	if strings.ContainsAny(endpoint, "/@%\\") {
		return false
	}
	host, err := url.Parse("//" + endpoint)
	if err != nil || host.Hostname() == "" || host.User != nil || host.Path != "" {
		return false
	}
	if strings.Contains(host.Hostname(), ":") && net.ParseIP(host.Hostname()) == nil {
		return false
	}
	if net.ParseIP(host.Hostname()) == nil {
		hostname := strings.TrimSuffix(host.Hostname(), ".")
		if len(hostname) > 253 {
			return false
		}
		for _, label := range strings.Split(hostname, ".") {
			if len(label) == 0 || len(label) > 63 || label[0] == '-' || label[len(label)-1] == '-' {
				return false
			}
			for _, r := range label {
				if !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '-') {
					return false
				}
			}
		}
	}
	if strings.HasSuffix(endpoint, ":") {
		return false
	}
	if port := host.Port(); port != "" {
		n, err := strconv.Atoi(port)
		if err != nil || n < 1 || n > 65535 {
			return false
		}
	}
	if u.RawQuery != "" || u.ForceQuery {
		if u.Scheme != "turn" && u.Scheme != "turns" {
			return false
		}
		if u.RawQuery != "transport=udp" && u.RawQuery != "transport=tcp" {
			return false
		}
	}
	return true
}

func (s *Server) iceServers(clientID string, ownerApproved bool) []iceServer {
	servers := make([]iceServer, 0, 2)
	if len(s.config.STUNURLs) > 0 {
		servers = append(servers, iceServer{URLs: s.config.STUNURLs})
	}
	if len(s.config.TURNURLs) > 0 && ownerApproved {
		turn := iceServer{URLs: s.config.TURNURLs, Username: s.config.TURNUsername, Credential: s.config.TURNPassword}
		if s.config.TURNSecret != "" {
			turn.Username = strconv.FormatInt(s.now().Add(time.Hour).Unix(), 10) + ":" + clientID
			mac := hmac.New(sha1.New, []byte(s.config.TURNSecret))
			_, _ = mac.Write([]byte(turn.Username))
			turn.Credential = base64.StdEncoding.EncodeToString(mac.Sum(nil))
		}
		servers = append(servers, turn)
	}
	return servers
}

type rtcPayload struct {
	Type      string          `json:"type"`
	SDP       *string         `json:"sdp,omitempty"`
	Candidate json.RawMessage `json:"candidate,omitempty"`
}
type rtcEnvelope struct {
	Type         string     `json:"type"`
	Target       string     `json:"target"`
	ConnectionID string     `json:"connectionId"`
	Signal       rtcPayload `json:"signal"`
}
type queuedSignal struct {
	data     []byte
	from, to *streamClient
	epoch    uint64
}

func decodeStrictJSON(data []byte, v any) bool {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	return decoder.Decode(v) == nil && decoder.Decode(new(any)) == io.EOF
}
func validRTCPayload(p rtcPayload) bool {
	switch p.Type {
	case "offer", "answer":
		return p.SDP != nil && len(*p.SDP) > 0 && len(p.Candidate) == 0
	case "candidate":
		if p.SDP != nil || len(p.Candidate) == 0 {
			return false
		}
		if bytes.Equal(bytes.TrimSpace(p.Candidate), []byte("null")) {
			return true
		}
		var candidate struct {
			Candidate        *string `json:"candidate"`
			SDPMid           *string `json:"sdpMid"`
			SDPMLineIndex    *uint16 `json:"sdpMLineIndex"`
			UsernameFragment *string `json:"usernameFragment"`
		}
		return decodeStrictJSON(p.Candidate, &candidate) && candidate.Candidate != nil
	}
	return false
}

func (s *Server) receiveSignal(c *streamClient, kind websocket.MessageType, data []byte) bool {
	var message rtcEnvelope
	valid := kind == websocket.MessageText && len(data) <= maxSignalBytes && decodeStrictJSON(data, &message) && message.Type == "signal" && identifier.MatchString(message.Target) && identifier.MatchString(message.ConnectionID) && validRTCPayload(message.Signal)
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.validStreamLocked(c) {
		return false
	}
	reject := func(status int, text string) bool {
		s.closeStreamLocked(c, streamClose{code: 1008, status: status, message: text})
		return false
	}
	if !valid {
		return reject(400, "Некорректное сообщение WebRTC")
	}
	if message.Signal.Type == "offer" && c.role != "host" || message.Signal.Type == "answer" && c.role != "viewer" {
		return reject(403, "Недопустимая роль WebRTC")
	}
	now := time.Now()
	if !c.lastSignal.IsZero() {
		c.signalCredit = min(signalBurst, c.signalCredit+now.Sub(c.lastSignal).Seconds()*signalRate)
	}
	c.lastSignal = now
	if c.signalCredit < 1 {
		return reject(429, "Слишком много сообщений WebRTC")
	}
	c.signalCredit--
	r := s.rooms[c.roomID]
	if !s.sourceActiveLocked(r) {
		return true
	}
	var target *streamClient
	if c.role == "viewer" {
		if r.source.clientID == message.Target {
			target = r.source
		}
	} else {
		for viewer := range r.viewers {
			if viewer.clientID == message.Target {
				target = viewer
				break
			}
		}
	}
	if target == nil {
		// A departed target is an ordinary disconnect race. Current same-role or
		// cross-room sockets are an authorization error, never a relay target.
		for other := range s.streams {
			if other.clientID == message.Target && s.validStreamLocked(other) {
				return reject(403, "Недопустимый адресат WebRTC")
			}
		}
		return true
	}
	if !s.validStreamLocked(target) {
		return true
	}
	outgoing, _ := json.Marshal(map[string]any{"type": "signal", "from": c.clientID, "connectionId": message.ConnectionID, "signal": message.Signal})
	if len(outgoing) > maxSignalBytes {
		return reject(400, "Сообщение WebRTC слишком большое")
	}
	if len(target.signals) >= maxSignalQueue || target.signalBytes+len(outgoing) > maxSignalQueueBytes {
		if c.role == "viewer" {
			// A viewer must not disconnect the shared camera by filling its queue.
			return reject(429, "Переполнена очередь сообщений зрителя")
		}
		s.closeStreamLocked(target, streamClose{code: 1008, status: 429, message: "Переполнена очередь WebRTC"})
		return true
	}
	target.signalBytes += len(outgoing)
	target.signals <- queuedSignal{data: outgoing, from: c, to: target, epoch: r.rtcEpoch}
	return true
}
func (s *Server) validSignalLocked(signal queuedSignal) bool {
	r := s.rooms[signal.to.roomID]
	if r == nil || signal.from.roomID != signal.to.roomID || !s.validStreamLocked(signal.from) || !s.validStreamLocked(signal.to) || !s.sourceActiveLocked(r) || r.rtcEpoch != signal.epoch {
		return false
	}
	if signal.from.role == "host" {
		_, ok := r.viewers[signal.to]
		return r.source == signal.from && signal.to.role == "viewer" && ok
	}
	_, ok := r.viewers[signal.from]
	return r.source == signal.to && signal.from.role == "viewer" && ok
}
