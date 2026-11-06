package server

import (
	"bufio"
	"bytes"
	"context"
	"crypto/subtle"
	"encoding/json"
	"image/jpeg"
	"io"
	"net"
	"net/http"
	"net/url"
	"slices"
	"sort"
	"strings"
	"time"

	"github.com/coder/websocket"
)

const (
	maxFrameBytes      = 200 * 1024
	maxRoomViewers     = 6
	maxPendingStreams  = 32
	maxTotalStreams    = maxRooms*(maxRoomViewers+1) + maxPendingStreams
	streamAuthTimeout  = 5 * time.Second
	streamWriteTimeout = 2 * time.Second
	streamPingInterval = 10 * time.Second
	streamFreshness    = 15 * time.Second
	// A small burst absorbs browser scheduling jitter; sustained input is 5 fps.
	streamFramesPerSecond = 5
)

type streamClose struct {
	code    websocket.StatusCode
	status  int
	message string
}
type liveFrame struct {
	data   []byte
	source *streamClient
	epoch  uint64
}

// Except channels and conn, these fields are protected by Server.mu.
// Channels are never closed: notification and shutdown can race with cleanup.
type streamClient struct {
	conn                          *websocket.Conn
	transport                     net.Conn
	roomID, role, hash, sessionID string
	clientID                      string
	signals                       chan queuedSignal
	signalBytes                   int
	lastSignal                    time.Time
	signalCredit                  float64
	pairingVersion                uint64
	authenticated, closing        bool
	frames                        chan liveFrame
	changed                       chan struct{}
	ready                         chan struct{}
	stop                          chan streamClose
	lastFrame                     time.Time
	frameCredit                   float64
	writeCancel                   context.CancelFunc
}

func (s *Server) serveStream(w http.ResponseWriter, r *http.Request, roomID string) {
	if r.Method != http.MethodGet {
		fail(w, 405, "Метод не поддерживается")
		return
	}
	if !storageID.MatchString(roomID) {
		fail(w, 404, "Комната не найдена")
		return
	}
	// Keys belong in the first encrypted message, never in proxy/access-log URLs.
	if r.URL.RawQuery != "" || r.URL.ForceQuery {
		fail(w, 400, "Параметры WebSocket URL не поддерживаются")
		return
	}
	if !s.streamOriginAllowed(r) {
		fail(w, 403, "Недопустимый источник запроса")
		return
	}
	c := &streamClient{roomID: roomID, frames: make(chan liveFrame, 1), changed: make(chan struct{}, 1), ready: make(chan struct{}, 1), stop: make(chan streamClose, 1), frameCredit: 2, signals: make(chan queuedSignal, maxSignalQueue), signalCredit: signalBurst}
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		fail(w, 503, "Сервер завершает работу")
		return
	}
	if s.rooms[roomID] == nil {
		s.mu.Unlock()
		fail(w, 404, "Комната не найдена")
		return
	}
	if s.pendingStreams >= maxPendingStreams || len(s.streams) >= maxTotalStreams {
		s.mu.Unlock()
		fail(w, 429, "Слишком много ожидающих подключений")
		return
	}
	s.pendingStreams++
	s.streams[c] = struct{}{}
	s.streamWG.Add(1)
	s.mu.Unlock()
	defer s.streamWG.Done()
	defer s.removeStream(c)
	// Origin is checked above against an exact scheme+host. The library's default
	// same-host exception alone would allow proxy-host origins beside PUBLIC_URL.
	upgrade := &streamUpgradeWriter{ResponseWriter: w}
	conn, err := websocket.Accept(upgrade, r, &websocket.AcceptOptions{InsecureSkipVerify: true, CompressionMode: websocket.CompressionDisabled})
	if err != nil {
		return
	}
	c.conn = conn
	c.transport = upgrade.conn
	defer conn.CloseNow()
	conn.SetReadLimit(4096)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	writerDone := make(chan struct{})
	go func() { defer close(writerDone); defer cancel(); s.streamWriter(ctx, c) }()
	timer := time.AfterFunc(streamAuthTimeout, func() {
		s.mu.Lock()
		if !c.authenticated {
			s.closeStreamLocked(c, streamClose{code: 1008, status: 401, message: "Истекло время авторизации"})
		}
		s.mu.Unlock()
	})
	kind, data, err := readStreamMessage(ctx, conn)
	if err == nil {
		err = s.authenticateStream(c, kind, data)
	}
	timer.Stop()
	if err == nil {
		if s.config.MediaTransport == "webrtc" {
			conn.SetReadLimit(maxSignalBytes)
		} else {
			conn.SetReadLimit(maxFrameBytes)
		}
		for {
			kind, data, err = readStreamMessage(ctx, conn)
			if err != nil {
				break
			}
			accepted := false
			if s.config.MediaTransport == "webrtc" {
				accepted = s.receiveSignal(c, kind, data)
			} else {
				accepted = s.receiveFrame(c, kind, data)
			}
			if !accepted {
				break
			}
		}
	}
	s.mu.Lock()
	s.closeStreamLocked(c, streamClose{code: 1000})
	s.mu.Unlock()
	<-writerDone
}

// Keep the underlying connection only to impose a hard close-handshake
// deadline; the WebSocket library owns all framing, reads, and writes.
type streamUpgradeWriter struct {
	http.ResponseWriter
	conn net.Conn
}

func (w *streamUpgradeWriter) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	conn, rw, err := http.NewResponseController(w.ResponseWriter).Hijack()
	if err == nil {
		w.conn = conn
	}
	return conn, rw, err
}

// Wait indefinitely for an idle connection (ping handles liveness), but bound
// partial-message uploads after their first data frame by a separate deadline.
func readStreamMessage(ctx context.Context, c *websocket.Conn) (websocket.MessageType, []byte, error) {
	readCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	kind, reader, err := c.Reader(readCtx)
	if err != nil {
		return 0, nil, err
	}
	timer := time.AfterFunc(streamWriteTimeout, cancel)
	defer timer.Stop()
	data, err := io.ReadAll(reader)
	return kind, data, err
}

func (s *Server) streamOriginAllowed(r *http.Request) bool {
	raw := r.Header.Values("Origin")
	if len(raw) != 1 {
		return false
	}
	u, err := url.Parse(raw[0])
	if err != nil || u == nil || u.Host == "" || u.User != nil || u.Path != "" || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" || strings.Contains(raw[0], "#") || (u.Scheme != "https" && u.Scheme != "http") {
		return false
	}
	scheme, host := "http", r.Host
	if r.TLS != nil {
		scheme = "https"
	}
	if s.config.PublicURL != "" {
		public, _ := url.Parse(s.config.PublicURL)
		scheme, host = public.Scheme, public.Host
	}
	return u.Scheme == scheme && strings.EqualFold(u.Host, host)
}

type streamAuth struct {
	Type      string `json:"type"`
	Role      string `json:"role"`
	Token     string `json:"token"`
	SessionID string `json:"sessionId,omitempty"`
}

func (s *Server) authenticateStream(c *streamClient, kind websocket.MessageType, data []byte) error {
	var auth streamAuth
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	valid := kind == websocket.MessageText && decoder.Decode(&auth) == nil && decoder.Decode(new(any)) == io.EOF && auth.Type == "auth" && (auth.Role == "host" || auth.Role == "viewer") && len(auth.Token) > 0 && len(auth.Token) <= 128
	s.mu.Lock()
	defer s.mu.Unlock()
	reject := func(status int, message string) error {
		s.closeStreamLocked(c, streamClose{code: 1008, status: status, message: message})
		return errStreamRejected{}
	}
	if c.closing || s.closed {
		return errStreamRejected{}
	}
	if !valid {
		return reject(400, "Некорректное сообщение авторизации")
	}
	current := s.rooms[c.roomID]
	if current == nil {
		return reject(401, "Комната недоступна")
	}
	hash := tokenHash(auth.Token)
	role := ""
	if subtle.ConstantTimeCompare([]byte(hash), []byte(current.HostHash)) == 1 {
		role = "host"
	}
	if subtle.ConstantTimeCompare([]byte(hash), []byte(current.ViewerHash)) == 1 {
		role = "viewer"
	}
	if role == "" {
		return reject(401, "Неверный или отозванный ключ комнаты")
	}
	if role != auth.Role {
		return reject(403, "Ключ не соответствует роли клиента")
	}
	clientID, err := randomID(16)
	if err != nil {
		return reject(500, "Не удалось создать идентификатор соединения")
	}
	c.clientID = clientID
	if role == "host" {
		if !identifier.MatchString(auth.SessionID) {
			return reject(400, "Укажите идентификатор сессии камеры")
		}
		if current.SessionID != auth.SessionID || slices.Contains(current.RetiredSessions, auth.SessionID) {
			return reject(403, "Сессия камеры завершена или заменена")
		}
		if !s.roomFreshLocked(current) {
			return reject(403, "Сессия камеры неактивна")
		}
		if current.source != nil {
			s.closeStreamLocked(current.source, streamClose{code: 1000})
		}
		current.source = c
		current.streamEpoch++
		current.rtcEpoch++
	} else {
		if len(current.viewers) >= maxRoomViewers {
			return reject(429, "Достигнут лимит зрителей комнаты")
		}
		if current.viewers == nil {
			current.viewers = make(map[*streamClient]struct{})
		}
		current.viewers[c] = struct{}{}
	}
	c.role, c.hash, c.sessionID, c.pairingVersion = role, hash, auth.SessionID, current.PairingVersion
	c.authenticated = true
	s.pendingStreams--
	c.ready <- struct{}{}
	s.notifyRoomLocked(current)
	return nil
}

type errStreamRejected struct{}

func (errStreamRejected) Error() string { return "stream rejected" }

func (s *Server) roomFreshLocked(r *room) bool {
	return r.LastSeenAt != nil && s.now().Sub(*r.LastSeenAt) < streamFreshness
}
func (s *Server) validStreamLocked(c *streamClient) bool {
	if c.closing || !c.authenticated || s.closed {
		return false
	}
	r := s.rooms[c.roomID]
	if r == nil {
		return false
	}
	if c.role == "viewer" {
		return c.hash == r.ViewerHash && c.pairingVersion == r.PairingVersion
	}
	return c == r.source && c.hash == r.HostHash && c.sessionID == r.SessionID && !slices.Contains(r.RetiredSessions, c.sessionID)
}
func (s *Server) sourceActiveLocked(r *room) bool {
	return r.source != nil && s.validStreamLocked(r.source) && s.roomFreshLocked(r) && r.Monitoring
}

// All fanout consists of non-blocking queue operations. Immutable frame bytes
// are shared among viewers; at most one queued frame is retained per viewer.
func (s *Server) receiveFrame(c *streamClient, kind websocket.MessageType, data []byte) bool {
	s.mu.Lock()
	if !s.validStreamLocked(c) {
		s.mu.Unlock()
		return false
	}
	if c.role != "host" {
		s.closeStreamLocked(c, streamClose{code: 1008, status: 403, message: "Зритель не может публиковать кадры"})
		s.mu.Unlock()
		return false
	}
	if kind != websocket.MessageBinary {
		s.closeStreamLocked(c, streamClose{code: 1008, status: 400, message: "Ожидается JPEG-кадр"})
		s.mu.Unlock()
		return false
	}
	now := time.Now()
	if !c.lastFrame.IsZero() {
		c.frameCredit = min(2, c.frameCredit+now.Sub(c.lastFrame).Seconds()*streamFramesPerSecond)
	}
	c.lastFrame = now
	if c.frameCredit < 1 {
		s.mu.Unlock()
		return true
	}
	c.frameCredit--
	r := s.rooms[c.roomID]
	active := s.sourceActiveLocked(r)
	epoch := r.streamEpoch
	s.mu.Unlock()
	if !active {
		return true
	}
	// Header parsing and validation happen outside the shared room lock.
	config, err := jpeg.DecodeConfig(bytes.NewReader(data))
	if len(data) > maxFrameBytes || err != nil || config.Width < 1 || config.Height < 1 || config.Width > 1280 || config.Height > 1280 || config.Width*config.Height > 1280*720 {
		s.mu.Lock()
		s.closeStreamLocked(c, streamClose{code: 1008, status: 400, message: "Недопустимый JPEG-кадр"})
		s.mu.Unlock()
		return false
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	r = s.rooms[c.roomID]
	if r == nil || !s.validStreamLocked(c) || !s.sourceActiveLocked(r) || r.streamEpoch != epoch {
		return true
	}
	frame := liveFrame{data: data, source: c, epoch: epoch}
	for viewer := range r.viewers {
		if !s.validStreamLocked(viewer) {
			continue
		}
		select {
		case viewer.frames <- frame:
		default:
			select {
			case <-viewer.frames:
			default:
			}
			select {
			case viewer.frames <- frame:
			default:
			}
		}
	}
	return true
}

// Only this goroutine writes data/control messages for a client. Socket writes,
// pings and the closing handshake never hold Server.mu.
func (s *Server) streamWriter(ctx context.Context, c *streamClient) {
	defer c.conn.CloseNow()
	stateTick := time.NewTicker(time.Second)
	defer stateTick.Stop()
	pingTick := time.NewTicker(streamPingInterval)
	defer pingTick.Stop()
	ready := false
	lastState := ""
	var signals <-chan queuedSignal
	write := func(kind websocket.MessageType, data []byte) error {
		writeCtx, cancelWrite := context.WithTimeout(ctx, streamWriteTimeout)
		defer cancelWrite()
		s.mu.Lock()
		if c.closing {
			s.mu.Unlock()
			return context.Canceled
		}
		c.writeCancel = cancelWrite
		s.mu.Unlock()
		err := c.conn.Write(writeCtx, kind, data)
		s.mu.Lock()
		c.writeCancel = nil
		s.mu.Unlock()
		return err
	}
	state := func(force bool) bool {
		s.mu.Lock()
		if !s.validStreamLocked(c) {
			s.mu.Unlock()
			return true
		}
		r := s.rooms[c.roomID]
		var message any
		if c.role == "host" {
			ids := make([]string, 0, len(r.viewers))
			for viewer := range r.viewers {
				if s.validStreamLocked(viewer) {
					ids = append(ids, viewer.clientID)
				}
			}
			sort.Strings(ids)
			message = map[string]any{"type": "viewers", "count": len(ids), "ids": ids, "monitoring": s.sourceActiveLocked(r)}
		} else {
			online := r.source != nil && s.validStreamLocked(r.source) && s.roomFreshLocked(r)
			sourceID := ""
			if online {
				sourceID = r.source.clientID
			}
			message = map[string]any{"type": "source", "online": online, "monitoring": online && r.Monitoring, "sourceId": sourceID}
		}
		data, _ := json.Marshal(message)
		s.mu.Unlock()
		if !force && string(data) == lastState {
			return true
		}
		if err := write(websocket.MessageText, data); err != nil {
			return false
		}
		lastState = string(data)
		return true
	}
	finish := func(reason streamClose) {
		if reason.status != 0 {
			data, _ := json.Marshal(map[string]any{"type": "error", "status": reason.status, "message": reason.message})
			writeCtx, cancelWrite := context.WithTimeout(ctx, streamWriteTimeout)
			_ = c.conn.Write(writeCtx, websocket.MessageText, data)
			cancelWrite()
		}
		// Bound the library close handshake even when no Reader is pending.
		timer := time.AfterFunc(streamWriteTimeout, func() { _ = c.transport.Close() })
		defer timer.Stop()
		_ = c.conn.Close(reason.code, "")
	}
	// A revocation can race with a ready/state write. Drain its close reason
	// even when the canceled write makes the main loop return first.
	defer func() {
		select {
		case reason := <-c.stop:
			finish(reason)
		default:
		}
	}()
	for {
		// Prefer revocation/stop over a queued frame when both are ready.
		select {
		case reason := <-c.stop:
			finish(reason)
			return
		default:
		}
		select {
		case reason := <-c.stop:
			finish(reason)
			return
		case <-ctx.Done():
			return
		case <-c.ready:
			message := map[string]any{"type": "ready", "role": c.role, "mediaTransport": s.config.MediaTransport, "clientId": c.clientID}
			if s.config.MediaTransport == "webrtc" {
				s.mu.Lock()
				message["iceServers"] = s.iceServers(c.clientID, s.rooms[c.roomID] != nil && s.rooms[c.roomID].OwnerApproved)
				s.mu.Unlock()
			}
			data, _ := json.Marshal(message)
			if err := write(websocket.MessageText, data); err != nil {
				return
			}
			ready = true
			signals = c.signals
			if !state(false) {
				return
			}
		case <-c.changed:
			if ready && !state(false) {
				return
			}
		case <-stateTick.C:
			if ready && !state(s.config.MediaTransport == "webrtc") {
				return
			}
		case <-pingTick.C:
			pingCtx, cancel := context.WithTimeout(ctx, streamWriteTimeout)
			err := c.conn.Ping(pingCtx)
			cancel()
			if err != nil {
				return
			}
		case signal := <-signals:
			s.mu.Lock()
			c.signalBytes -= len(signal.data)
			allowed := s.validSignalLocked(signal)
			s.mu.Unlock()
			if !allowed {
				continue
			}
			// Deliver current authenticated roster/source before signaling, even if
			// its asynchronous change notification has not been selected yet.
			if !state(false) {
				return
			}
			s.mu.Lock()
			allowed = s.validSignalLocked(signal)
			s.mu.Unlock()
			if allowed {
				if err := write(websocket.MessageText, signal.data); err != nil {
					return
				}
			}
		case frame := <-c.frames:
			s.mu.Lock()
			r := s.rooms[c.roomID]
			allowed := ready && s.validStreamLocked(c) && r != nil && r.source == frame.source && r.streamEpoch == frame.epoch && s.sourceActiveLocked(r)
			s.mu.Unlock()
			if allowed {
				if err := write(websocket.MessageBinary, frame.data); err != nil {
					return
				}
			}
		}
	}
}

func (s *Server) notifyRoomLocked(r *room) {
	if r.source != nil {
		select {
		case r.source.changed <- struct{}{}:
		default:
		}
	}
	for c := range r.viewers {
		select {
		case c.changed <- struct{}{}:
		default:
		}
	}
}
func (s *Server) closeStreamLocked(c *streamClient, reason streamClose) {
	if c.closing {
		return
	}
	c.closing = true
	if c.writeCancel != nil {
		// Context cancellation only signals the transport goroutine; no socket
		// I/O or waiting takes place while the room mutex is held.
		c.writeCancel()
	}
	if r := s.rooms[c.roomID]; r != nil {
		if r.source == c {
			r.source = nil
			r.streamEpoch++
			r.rtcEpoch++
		}
		delete(r.viewers, c)
		s.notifyRoomLocked(r)
	}
	c.stop <- reason
}
func (s *Server) removeStream(c *streamClient) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.closeStreamLocked(c, streamClose{code: 1000})
	delete(s.streams, c)
	if !c.authenticated {
		s.pendingStreams--
	}
}
func (s *Server) refreshSourceLocked(r *room) {
	// Invalidate queued frames across pause/resume and session transitions.
	r.streamEpoch++
	if r.source != nil && (r.source.sessionID != r.SessionID || slices.Contains(r.RetiredSessions, r.source.sessionID)) {
		s.closeStreamLocked(r.source, streamClose{code: 1000})
	}
	s.notifyRoomLocked(r)
}
