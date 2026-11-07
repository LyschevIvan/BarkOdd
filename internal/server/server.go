// Package server implements BarkOdd's authenticated room API and media relay.
package server

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"sort"
	"strings"
	"sync"
	"time"
)

const (
	maxRooms      = 100
	maxEvents     = 200
	maxPhotoBytes = 400 * 1024
	retention     = 7 * 24 * time.Hour
)

var identifier = regexp.MustCompile(`^[A-Za-z0-9_.-]{1,128}$`)
var storageID = regexp.MustCompile(`^[A-Za-z0-9_-]{16}$`)

type Config struct {
	AuthMode        string
	AdminCode       string
	RoomCreationKey string
	DataDir         string
	PublicURL       string
	Now             func() time.Time
	MediaTransport  string
	// STUNURLs defaults in WebRTC mode when nil; an explicit empty slice disables STUN.
	STUNURLs     []string
	TURNURLs     []string
	TURNSecret   string
	TURNUsername string
	TURNPassword string
}

const (
	minNoiseThreshold     = 0.0005
	maxNoiseThreshold     = 0.5
	defaultNoiseThreshold = 0.01
)

type Settings struct {
	Threshold          float64 `json:"threshold"`
	QuietMS            int     `json:"quietMs"`
	SnapshotIntervalMS int     `json:"snapshotIntervalMs"`
}

type Event struct {
	ID          string     `json:"id"`
	StartedAt   time.Time  `json:"startedAt"`
	LastNoiseAt time.Time  `json:"lastNoiseAt"`
	PhotoAt     *time.Time `json:"photoAt"`
	HasPhoto    bool       `json:"hasPhoto"`
	Level       float64    `json:"level"`
}

type storedEvent struct {
	Event
	EpisodeID string `json:"episodeId"`
	PhotoFile string `json:"photoFile,omitempty"`
}

type room struct {
	OwnerID             string        `json:"ownerId"`
	GroupID             string        `json:"groupId"`
	SourceOwnerID       string        `json:"-"`
	SourceAuthSession   string        `json:"-"`
	OwnerApproved       bool          `json:"ownerApproved"`
	ID                  string        `json:"id"`
	Name                string        `json:"name"`
	CreatedAt           time.Time     `json:"createdAt"`
	HostHash            string        `json:"hostHash"`
	ViewerHash          string        `json:"viewerHash"`
	PairingVersion      uint64        `json:"pairingVersion"`
	Settings            Settings      `json:"settings"`
	LastNoiseAt         *time.Time    `json:"lastNoiseAt"`
	LastPhotoAt         *time.Time    `json:"lastPhotoAt"`
	Events              []storedEvent `json:"events"`
	HistorySessionID    string        `json:"historySessionId,omitempty"`
	HistoryVersion      uint64        `json:"historyVersion"`
	HistoryClearedAt    *time.Time    `json:"historyClearedAt,omitempty"`
	PhotoCleanupPending bool          `json:"photoCleanupPending,omitempty"`
	LastSeenAt          *time.Time    `json:"-"`
	Monitoring          bool          `json:"-"`
	SessionID           string        `json:"-"`
	RetiredSessions     []string      `json:"retiredSessions,omitempty"`
	source              *streamClient
	viewers             map[*streamClient]struct{}
	streamEpoch         uint64
	rtcEpoch            uint64
	eventBusy           bool
	eventCredit         float64
	eventCreditAt       time.Time
}

type Server struct {
	auth              authState
	mu                sync.Mutex
	config            Config
	rooms             map[string]*room
	groups            map[string]*group
	deletedGroups     map[string][]string
	closed            bool
	stop              chan struct{}
	stopped           chan struct{}
	streams           map[*streamClient]struct{}
	pendingStreams    int
	eventPhotoDecodes int
	streamWG          sync.WaitGroup
}

func New(config Config) (*Server, error) {
	if err := validateAuthConfig(&config); err != nil {
		return nil, err
	}
	if err := validateMediaConfig(&config); err != nil {
		return nil, err
	}
	if config.DataDir == "" {
		config.DataDir = "data"
	}
	if config.Now == nil {
		config.Now = time.Now
	}
	if config.PublicURL != "" {
		origin, err := validPublicURL(config.PublicURL)
		if err != nil {
			return nil, fmt.Errorf("PUBLIC_URL: %w", err)
		}
		config.PublicURL = origin
	}
	if err := os.MkdirAll(filepath.Join(config.DataDir, "photos"), 0700); err != nil {
		return nil, err
	}
	s := &Server{
		config: config, rooms: make(map[string]*room), groups: make(map[string]*group),
		deletedGroups: make(map[string][]string), streams: make(map[*streamClient]struct{}),
		stop: make(chan struct{}), stopped: make(chan struct{}),
	}
	if err := s.initAuth(); err != nil {
		return nil, err
	}
	if err := s.initGroups(); err != nil {
		return nil, err
	}
	s.retryRoomDeletions()
	files, err := filepath.Glob(filepath.Join(config.DataDir, "*.json"))
	if err != nil {
		return nil, err
	}
	for _, file := range files {
		fileInfo, err := os.Stat(file)
		if err != nil {
			return nil, err
		}
		if fileInfo.Size() > 1024*1024 {
			return nil, fmt.Errorf("room metadata too large: %s", filepath.Base(file))
		}
		data, err := os.ReadFile(file)
		if err != nil {
			return nil, err
		}
		var r room
		if err = json.Unmarshal(data, &r); err != nil {
			return nil, fmt.Errorf("invalid room %s: %w", filepath.Base(file), err)
		}
		if err = validateStored(&r); err != nil {
			return nil, fmt.Errorf("invalid room %s: %w", filepath.Base(file), err)
		}
		if filepath.Base(file) != r.ID+".json" {
			return nil, errors.New("room filename does not match ID")
		}
		groupID := r.GroupID
		if groupID == "" {
			groupID = r.ID
		}
		if cameras, deleted := s.deletedGroups[groupID]; deleted {
			s.deletedGroups[groupID] = append(cameras, r.ID)
			continue
		}
		if r.Events == nil {
			r.Events = []storedEvent{}
		}
		// Rooms created before pairing versions existed start at version one.
		if r.PairingVersion == 0 {
			r.PairingVersion = 1
		}
		if r.GroupID == "" {
			if err := s.migrateLegacyCamera(&r); err != nil {
				return nil, fmt.Errorf("migrate camera %s: %w", r.ID, err)
			}
		} else if s.groups[r.GroupID] == nil || s.groupUserLocked(r.OwnerID) == nil {
			return nil, fmt.Errorf("camera %s references unknown group or creator", r.ID)
		}
		s.rooms[r.ID] = &r
	}
	if len(s.rooms) > maxRooms {
		return nil, fmt.Errorf("storage contains more than %d cameras", maxRooms)
	}
	if err = s.saveAuthUsersLocked(s.auth.users); err != nil {
		return nil, err
	}
	if err = s.verifyPhotos(); err != nil {
		return nil, err
	}
	if err = s.sweep(); err != nil {
		return nil, err
	}
	go s.cleanupLoop()
	return s, nil
}

func (s *Server) Handler() http.Handler { return http.HandlerFunc(s.serveHTTP) }
func (s *Server) Close() error {
	s.mu.Lock()
	if !s.closed {
		s.closed = true
		close(s.stop)
		for c := range s.streams {
			s.closeStreamLocked(c, streamClose{code: 1012})
		}
	}
	s.mu.Unlock()
	<-s.stopped
	s.streamWG.Wait()
	return nil
}
func (s *Server) now() time.Time { return s.config.Now().UTC() }

func (s *Server) handleAPI(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	if r.URL.Path == "/healthz" {
		if r.Method != http.MethodGet {
			fail(w, 405, "Метод не поддерживается")
			return
		}
		writeJSON(w, 200, map[string]string{"status": "ok"})
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		fail(w, 503, "Сервер завершает работу")
		return
	}
	parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/"), "/")
	if len(parts) >= 2 && parts[0] == "api" && parts[1] == "groups" {
		s.handleGroupsLocked(w, r, parts)
		return
	}
	if r.URL.Path == "/api/rooms" {
		if r.Method != http.MethodPost && r.Method != http.MethodGet {
			fail(w, 405, "Метод не поддерживается")
			return
		}
		user := s.principalLocked(r)
		if user == nil || len(r.Header.Values("Authorization")) != 0 {
			fail(w, 401, "Войдите, чтобы открыть свои комнаты")
			return
		}
		if r.Method == http.MethodGet {
			s.listRooms(w, user.ID)
			return
		}
		s.createRoom(w, r, user.ID, "")
		return
	}
	if len(parts) < 3 || parts[0] != "api" || parts[1] != "rooms" || !storageID.MatchString(parts[2]) {
		fail(w, 404, "Комната или адрес не найдены")
		return
	}
	room, ok := s.rooms[parts[2]]
	if !ok {
		fail(w, 404, "Комната не найдена")
		return
	}
	role, owner := s.authorizeLocked(r, room)
	if role == "" {
		fail(w, 401, "Неверный или отозванный ключ комнаты")
		return
	}
	route := strings.Join(parts[3:], "/")
	if (r.Method == http.MethodPost && (route == "events" || route == "heartbeat" || route == "pairing" || route == "qr" || route == "approval")) || (r.Method == http.MethodPut && route == "settings") || (r.Method == http.MethodDelete && (route == "" || route == "events")) {
		if role != "host" {
			fail(w, 403, "Действие доступно только устройству питомца")
			return
		}
	}
	switch {
	case route == "events" && r.Method == http.MethodDelete:
		s.clearHistory(w, room)
	case route == "" && r.Method == http.MethodDelete:
		s.deleteRoom(w, room)
	case route == "approval" && r.Method == http.MethodPost:
		s.approveRoom(w, r, room)
	case route == "" && r.Method == http.MethodGet:
		s.roomState(w, room)
	case route == "settings" && r.Method == http.MethodPut:
		s.updateSettings(w, r, room)
	case route == "heartbeat" && r.Method == http.MethodPost:
		s.heartbeat(w, r, room, owner.ID)
	case len(parts) == 6 && parts[3] == "events" && parts[5] == "photo" && r.Method == http.MethodGet:
		s.getPhoto(w, r, room, parts[4])
	case route == "pairing" && r.Method == http.MethodPost:
		s.pairing(w, room)
	case route == "qr" && r.Method == http.MethodPost:
		s.qr(w, r, room)
	default:
		fail(w, 404, "Адрес или метод не поддерживается")
	}
}

func (s *Server) createRoom(w http.ResponseWriter, r *http.Request, ownerID, groupID string) {
	name, ok := readRoomName(w, r)
	if !ok {
		return
	}
	now := s.now()
	if len(s.rooms) >= maxRooms {
		fail(w, 429, "Достигнут лимит камер сервера")
		return
	}
	if groupID == "" && len(s.groups) >= maxGroups {
		fail(w, 429, "Достигнут лимит комнат сервера")
		return
	}
	id, err := randomID(12)
	if err != nil {
		fail(w, 500, "Не удалось создать ключ")
		return
	}
	host, err := randomID(32)
	if err != nil {
		fail(w, 500, "Не удалось создать ключ")
		return
	}
	viewer, err := randomID(32)
	if err != nil {
		fail(w, 500, "Не удалось создать ключ")
		return
	}
	var newGroup *group
	if groupID == "" {
		groupID = id
		newGroup = &group{ID: groupID, Name: name, CreatedAt: now, MemberIDs: []string{ownerID}}
		if err := s.saveGroup(newGroup); err != nil {
			fail(w, 500, "Не удалось сохранить комнату")
			return
		}
	}
	room := &room{OwnerID: ownerID, GroupID: groupID, OwnerApproved: true, ID: id, Name: name, CreatedAt: now, HostHash: tokenHash(host), ViewerHash: tokenHash(viewer), PairingVersion: 1, Settings: Settings{Threshold: defaultNoiseThreshold, QuietMS: 5000, SnapshotIntervalMS: 30000}, Events: []storedEvent{}}
	if err = s.save(room); err != nil {
		if newGroup != nil {
			path := s.groupPath(newGroup.ID, ".json")
			if os.Remove(path) == nil {
				syncDirectory(filepath.Dir(path))
			}
		}
		fail(w, 500, "Не удалось сохранить комнату")
		return
	}
	if newGroup != nil {
		s.groups[newGroup.ID] = newGroup
	}
	s.rooms[id] = room
	writeJSON(w, 201, map[string]string{"id": id, "ownerId": ownerID, "hostToken": host, "viewerToken": viewer, "groupId": groupID})
}

func (s *Server) roomState(w http.ResponseWriter, r *room) {
	if !s.prune(w, r) {
		return
	}
	online := s.roomFreshLocked(r)
	events := make([]Event, len(r.Events))
	for i, v := range r.Events {
		events[i] = v.Event
	}
	sort.SliceStable(events, func(i, j int) bool { return events[i].LastNoiseAt.After(events[j].LastNoiseAt) })
	var session any
	if r.SessionID != "" {
		session = r.SessionID
	}
	writeJSON(w, 200, map[string]any{"turnAuthorizationRequired": s.config.MediaTransport == "webrtc" && len(s.config.TURNURLs) > 0 && !r.OwnerApproved, "mediaTransport": s.config.MediaTransport, "id": r.ID, "name": r.Name, "groupId": r.GroupID, "groupName": s.groups[r.GroupID].Name, "createdAt": r.CreatedAt, "lastSeenAt": r.LastSeenAt, "online": online, "monitoring": online && r.Monitoring, "sessionId": session, "pairingVersion": r.PairingVersion, "lastNoiseAt": r.LastNoiseAt, "settings": r.Settings, "eventCount": len(events), "events": events})
}

func (s *Server) updateSettings(w http.ResponseWriter, r *http.Request, current *room) {
	var body struct {
		Threshold          *float64 `json:"threshold"`
		SnapshotIntervalMS *int     `json:"snapshotIntervalMs"`
	}
	if !readJSON(w, r, 4096, &body) {
		return
	}
	if body.Threshold == nil || body.SnapshotIntervalMS == nil || *body.Threshold < minNoiseThreshold || *body.Threshold > maxNoiseThreshold || *body.SnapshotIntervalMS < 10000 || *body.SnapshotIntervalMS > 300000 {
		fail(w, 400, "Некорректный порог или интервал фотографий")
		return
	}
	updated := *current
	updated.Settings.Threshold = *body.Threshold
	updated.Settings.SnapshotIntervalMS = *body.SnapshotIntervalMS
	if err := s.save(&updated); err != nil {
		fail(w, 500, "Не удалось сохранить настройки")
		return
	}
	*current = updated
	writeJSON(w, 200, current.Settings)
}

func (s *Server) heartbeat(w http.ResponseWriter, r *http.Request, current *room, ownerID string) {
	var body struct {
		Monitoring *bool  `json:"monitoring"`
		SessionID  string `json:"sessionId"`
		Stopped    bool   `json:"stopped"`
	}
	if !readJSON(w, r, 4096, &body) {
		return
	}
	if body.Monitoring == nil || !identifier.MatchString(body.SessionID) {
		fail(w, 400, "Укажите состояние и идентификатор сессии камеры")
		return
	}
	if body.Stopped && *body.Monitoring {
		fail(w, 400, "Завершённая сессия не может продолжать наблюдение")
		return
	}
	// Retired camera sessions may still have HTTP requests in flight. Neither a
	// delayed start nor a delayed stop may replace or refresh the current session.
	if slices.Contains(current.RetiredSessions, body.SessionID) {
		writeHeartbeat(w, current)
		return
	}
	if body.SessionID == current.SessionID && current.SourceOwnerID != ownerID {
		fail(w, 403, "Сессия камеры принадлежит другому хозяину")
		return
	}
	updated := *current
	updated.RetiredSessions = slices.Clone(current.RetiredSessions)
	if !*body.Monitoring && current.SessionID != "" && current.SessionID != body.SessionID {
		if body.Stopped {
			retireSession(&updated, body.SessionID)
			if err := s.save(&updated); err != nil {
				fail(w, 500, "Не удалось сохранить завершение наблюдения")
				return
			}
			*current = updated
		}
		writeHeartbeat(w, current)
		return
	}
	if current.SessionID != "" && current.SessionID != body.SessionID {
		retireSession(&updated, current.SessionID)
	}
	// A suspended AudioContext reports monitoring:false but can resume this
	// session. Only an explicit terminal stop retires its identifier.
	if body.Stopped {
		retireSession(&updated, body.SessionID)
	}
	if current.Monitoring != *body.Monitoring || current.SessionID != body.SessionID || !s.roomFreshLocked(current) {
		updated.rtcEpoch++
	}
	now := s.now()
	newStart := *body.Monitoring && current.HistorySessionID != body.SessionID
	if newStart {
		if current.HistorySessionID != "" {
			retireSession(&updated, current.HistorySessionID)
		}
		updated = emptiedHistory(&updated)
		updated.HistorySessionID = body.SessionID
		// Samples may already be queued while the initial heartbeat connects.
		// The new session identity excludes old uploads without discarding them.
		updated.HistoryClearedAt = nil
		updated.LastPhotoAt = nil
	}
	updated.LastSeenAt = &now
	updated.Monitoring = *body.Monitoring
	updated.SessionID = body.SessionID
	updated.SourceOwnerID = ownerID
	updated.SourceAuthSession = s.sessionKey(r)
	if newStart || body.Stopped {
		if err := s.save(&updated); err != nil {
			fail(w, 500, "Не удалось сохранить запуск или остановку наблюдения")
			return
		}
	}
	*current = updated
	if newStart {
		s.retryHistoryCleanup(current)
	}
	s.refreshSourceLocked(current)
	writeHeartbeat(w, current)
}

func writeHeartbeat(w http.ResponseWriter, current *room) {
	writeJSON(w, 200, map[string]any{"ok": true, "historyVersion": current.HistoryVersion})
}

func retireSession(current *room, id string) {
	if slices.Contains(current.RetiredSessions, id) {
		return
	}
	if len(current.RetiredSessions) >= 128 {
		copy(current.RetiredSessions, current.RetiredSessions[1:])
		current.RetiredSessions = current.RetiredSessions[:127]
	}
	current.RetiredSessions = append(current.RetiredSessions, id)
}

func (s *Server) pairing(w http.ResponseWriter, current *room) {
	token, err := randomID(32)
	if err != nil {
		fail(w, 500, "Не удалось создать ключ")
		return
	}
	updated := *current
	updated.ViewerHash = tokenHash(token)
	updated.PairingVersion++
	if err = s.save(&updated); err != nil {
		fail(w, 500, "Не удалось обновить ключ")
		return
	}
	*current = updated
	for c := range current.viewers {
		if c.ownerID == "" {
			s.closeStreamLocked(c, streamClose{code: 1008, status: 401, message: "Ключ просмотра отозван"})
		}
	}
	s.notifyRoomLocked(current)
	writeJSON(w, 200, map[string]string{"viewerToken": token})
}

func (s *Server) authorizeLocked(r *http.Request, room *room) (string, *authUser) {
	raw := r.Header.Get("Authorization")
	if len(r.Header.Values("Authorization")) == 0 {
		if user := s.principalLocked(r); user != nil && s.groupMemberLocked(s.groups[room.GroupID], user.ID) {
			return "host", user
		}
		return "", nil
	}
	if !s.guestCameraAllowedLocked(room) || !strings.HasPrefix(raw, "Bearer ") || len(raw) > 128 {
		return "", nil
	}
	hash := tokenHash(strings.TrimPrefix(raw, "Bearer "))
	if subtle.ConstantTimeCompare([]byte(hash), []byte(room.ViewerHash)) == 1 {
		return "viewer", nil
	}
	return "", nil
}
func randomID(n int) (string, error) {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}
func tokenHash(value string) string {
	sum := sha256.Sum256([]byte(value))
	return hex.EncodeToString(sum[:])
}
func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
func fail(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]string{"error": message})
}
func readJSON(w http.ResponseWriter, r *http.Request, max int64, value any) bool {
	if content := r.Header.Get("Content-Type"); content != "" {
		mediaType, _, err := mime.ParseMediaType(content)
		if err != nil || mediaType != "application/json" {
			fail(w, 415, "Ожидается JSON")
			return false
		}
	}
	r.Body = http.MaxBytesReader(w, r.Body, max)
	defer r.Body.Close()
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(value); err != nil {
		var large *http.MaxBytesError
		if errors.As(err, &large) {
			fail(w, 413, "Запрос слишком большой")
		} else {
			fail(w, 400, "Некорректный JSON запроса")
		}
		return false
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		var large *http.MaxBytesError
		if errors.As(err, &large) {
			fail(w, 413, "Запрос слишком большой")
		} else {
			fail(w, 400, "В запросе должен быть один JSON объект")
		}
		return false
	}
	return true
}

func validOrigin(value string) (string, error) {
	u, err := url.Parse(value)
	if err != nil || u == nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") || u.User != nil || u.RawQuery != "" || u.Fragment != "" || (u.Path != "" && u.Path != "/") {
		return "", errors.New("ожидается http(s) origin без пути, параметров и ключей")
	}
	return u.Scheme + "://" + u.Host, nil
}

// PUBLIC_URL is an explicitly configured application directory. Keep request-
// supplied origins strict, and accept only unambiguous path segments here.
func validPublicURL(value string) (string, error) {
	u, err := url.Parse(value)
	if err != nil || u == nil {
		return "", errors.New("ожидается безопасный http(s) URL приложения")
	}
	origin, err := validOrigin(u.Scheme + "://" + u.Host)
	if err != nil || u.User != nil || u.Opaque != "" || u.RawQuery != "" || u.ForceQuery || strings.Contains(value, "#") || u.RawPath != "" {
		return "", errors.New("ожидается http(s) URL без параметров, ключей и учетных данных")
	}
	path := strings.TrimSuffix(u.Path, "/")
	if path != "" {
		for _, segment := range strings.Split(strings.TrimPrefix(path, "/"), "/") {
			if segment == "" || segment == "." || segment == ".." {
				return "", errors.New("недопустимый путь PUBLIC_URL")
			}
			for _, char := range segment {
				if !(char >= 'a' && char <= 'z' || char >= 'A' && char <= 'Z' || char >= '0' && char <= '9' || strings.ContainsRune("-._~", char)) {
					return "", errors.New("недопустимый путь PUBLIC_URL")
				}
			}
		}
	}
	return origin + path, nil
}
