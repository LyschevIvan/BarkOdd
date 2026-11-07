package server

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"errors"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strings"
	"time"
	"unicode/utf8"

	"golang.org/x/crypto/argon2"
)

const (
	authOwnerID     = "owner"
	authCookieName  = "barkodd_session"
	maxAuthUsers    = 1000
	authSessionTTL  = 30 * 24 * time.Hour
	maxAuthSessions = 4096
	maxUserSessions = 32
)

var errAuthSessionsFull = errors.New("session capacity reached")

var authUsernamePattern = regexp.MustCompile(`^[A-Za-z0-9_.-]{3,32}$`)

type authUser struct {
	ID           string    `json:"id"`
	Username     string    `json:"username"`
	Role         string    `json:"role"`
	Disabled     bool      `json:"disabled"`
	CreatedAt    time.Time `json:"createdAt"`
	PasswordHash string    `json:"-"`
	Salt         string    `json:"-"`
}
type authSession struct {
	UserID               string
	CreatedAt, ExpiresAt time.Time
}
type authAttempt struct {
	Start time.Time
	Count int
}
type authState struct {
	users     map[string]*authUser
	sessions  map[string]*authSession
	attempts  map[string]authAttempt
	hashSlots chan struct{}
}

var authOwner = authUser{ID: authOwnerID, Username: "admin", Role: "admin"}

func validateAuthConfig(c *Config) error {
	if c.AuthMode == "" {
		c.AuthMode = "admin_code"
	}
	if c.AuthMode != "none" && c.AuthMode != "admin_code" && c.AuthMode != "multi_user" {
		return errors.New("AUTH_MODE must be none, admin_code or multi_user")
	}
	if c.AdminCode != "" && c.RoomCreationKey != "" && c.AdminCode != c.RoomCreationKey {
		return errors.New("ADMIN_CODE and ROOM_CREATION_KEY must match when both are configured")
	}
	if c.AdminCode == "" {
		c.AdminCode = c.RoomCreationKey
	}
	if (c.AuthMode != "none" || c.AdminCode != "") && !ownerKeyFormat.MatchString(c.AdminCode) {
		return errors.New("ADMIN_CODE must contain 32–128 URL-safe characters in protected auth modes")
	}
	c.RoomCreationKey = c.AdminCode
	return nil
}
func validAuthUsername(name string) bool {
	return authUsernamePattern.MatchString(name) && !strings.EqualFold(name, "admin")
}
func validAuthPassword(password string) bool {
	n := utf8.RuneCountInString(password)
	return utf8.ValidString(password) && n >= 12 && n <= 128 && len(password) <= 512
}
func authPasswordHash(password, salt string) string {
	b, _ := hex.DecodeString(salt)
	return hex.EncodeToString(argon2.IDKey([]byte(password), b, 3, 64*1024, 4, 32))
}
func newAuthPassword(password string) (string, string, error) {
	salt := make([]byte, 16)
	if _, err := rand.Read(salt); err != nil {
		return "", "", err
	}
	encoded := hex.EncodeToString(salt)
	return authPasswordHash(password, encoded), encoded, nil
}
func authPasswordMatches(u *authUser, password string) bool {
	return subtle.ConstantTimeCompare([]byte(authPasswordHash(password, u.Salt)), []byte(u.PasswordHash)) == 1
}
func (s *Server) sessionKey(r *http.Request) string {
	c, err := r.Cookie(authCookieName)
	if err != nil || len(c.Value) != 43 {
		return ""
	}
	return tokenHash(c.Value)
}
func (s *Server) principalLocked(r *http.Request) *authUser {
	var user *authUser
	if s.config.AuthMode == "none" {
		user = &authOwner
	} else {
		user = s.sessionUserLocked(s.sessionKey(r))
	}
	if expected := r.Header.Values("X-BarkOdd-User"); len(expected) != 0 {
		if len(expected) != 1 || expected[0] == "" || user == nil || expected[0] != user.ID {
			return nil
		}
	}
	return user
}
func (s *Server) sessionUserLocked(key string) *authUser {
	sess := s.auth.sessions[key]
	if sess == nil {
		return nil
	}
	if !s.now().Before(sess.ExpiresAt) {
		s.revokeSessionLocked(key)
		return nil
	}
	if sess.UserID == authOwnerID {
		return &authOwner
	}
	u := s.auth.users[sess.UserID]
	if u == nil || u.Disabled {
		s.revokeSessionLocked(key)
		return nil
	}
	return u
}
func (s *Server) ownerEnabledLocked(id string) bool {
	if id == authOwnerID {
		return true
	}
	u := s.auth.users[id]
	return s.config.AuthMode == "multi_user" && u != nil && !u.Disabled
}
func (s *Server) revokeSessionLocked(key string) {
	if _, ok := s.auth.sessions[key]; !ok {
		return
	}
	delete(s.auth.sessions, key)
	s.invalidateAuthLocked(key, "")
}
func (s *Server) expireSessionsLocked() {
	for key, sess := range s.auth.sessions {
		if !s.now().Before(sess.ExpiresAt) {
			s.revokeSessionLocked(key)
		}
	}
}
func (s *Server) revokeUserSessionsLocked(id string) {
	for key, sess := range s.auth.sessions {
		if sess.UserID == id {
			s.revokeSessionLocked(key)
		}
	}
}
func (s *Server) createAuthSessionLocked(id string) (string, error) {
	token, err := randomID(32)
	if err != nil {
		return "", err
	}
	s.expireSessionsLocked()
	count := 0
	oldest := ""
	for key, sess := range s.auth.sessions {
		if sess.UserID == id {
			count++
			if oldest == "" || sess.CreatedAt.Before(s.auth.sessions[oldest].CreatedAt) {
				oldest = key
			}
		}
	}
	if count < maxUserSessions && len(s.auth.sessions) >= maxAuthSessions {
		return "", errAuthSessionsFull
	}
	if count >= maxUserSessions {
		s.revokeSessionLocked(oldest)
	}
	now := s.now()
	s.auth.sessions[tokenHash(token)] = &authSession{UserID: id, CreatedAt: now, ExpiresAt: now.Add(authSessionTTL)}
	return token, nil
}
func (s *Server) authCookie(w http.ResponseWriter, r *http.Request, token string) {
	path := "/"
	secure := r.TLS != nil
	if u, err := url.Parse(s.config.PublicURL); err == nil && s.config.PublicURL != "" {
		if u.Path != "" {
			path = strings.TrimSuffix(u.Path, "/") + "/"
		}
		secure = secure || u.Scheme == "https"
	}
	c := &http.Cookie{Name: authCookieName, Value: token, Path: path, HttpOnly: true, Secure: secure, SameSite: http.SameSiteStrictMode, MaxAge: int(authSessionTTL / time.Second), Expires: s.now().Add(authSessionTTL)}
	if token == "" {
		c.MaxAge = -1
		c.Expires = time.Unix(1, 0)
	}
	http.SetCookie(w, c)
}
func sortedAuthUsers(users map[string]*authUser) []*authUser {
	out := make([]*authUser, 0, len(users))
	for _, u := range users {
		out = append(out, u)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Username < out[j].Username })
	return out
}

// Bounds both attempt memory and expensive hashing before taking a hash slot.
func (s *Server) allowAuthAttemptLocked(r *http.Request, kind, name string) bool {
	now := s.now()
	for k, a := range s.auth.attempts {
		if now.Sub(a.Start) >= time.Minute {
			delete(s.auth.attempts, k)
		}
	}
	ip := r.RemoteAddr
	if host, _, err := net.SplitHostPort(ip); err == nil {
		ip = host
	}
	keys := []string{"global", kind + ":" + ip}
	limits := []int{100, 30}
	if kind == "register" {
		limits[1] = 5
	}
	if name != "" {
		keys = append(keys, "name:"+name)
		limits = append(limits, 10)
	}
	for i, key := range keys {
		a, ok := s.auth.attempts[key]
		if (!ok && len(s.auth.attempts) >= 1024) || a.Count >= limits[i] {
			return false
		}
	}
	for _, key := range keys {
		a := s.auth.attempts[key]
		if a.Start.IsZero() {
			a.Start = now
		}
		a.Count++
		s.auth.attempts[key] = a
	}
	return true
}
func (s *Server) authHashSlot(w http.ResponseWriter, r *http.Request, kind, name string) bool {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		fail(w, 503, "Сервер завершает работу")
		return false
	}
	ok := s.allowAuthAttemptLocked(r, kind, name)
	s.mu.Unlock()
	if !ok {
		fail(w, 429, "Слишком много попыток. Повторите позже")
		return false
	}
	select {
	case s.auth.hashSlots <- struct{}{}:
		return true
	default:
		fail(w, 429, "Слишком много попыток. Повторите позже")
		return false
	}
}
func (s *Server) serveAuth(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	path := r.URL.Path
	switch path {
	case "/api/auth":
		if r.Method != "GET" {
			fail(w, 405, "Метод не поддерживается")
			return
		}
		s.mu.Lock()
		defer s.mu.Unlock()
		if s.closed {
			fail(w, 503, "Сервер завершает работу")
			return
		}
		writeJSON(w, 200, map[string]any{"mode": s.config.AuthMode, "user": s.principalLocked(r)})
	case "/api/auth/login":
		if r.Method != "POST" {
			fail(w, 405, "Метод не поддерживается")
			return
		}
		s.authLogin(w, r)
	case "/api/auth/register":
		if r.Method != "POST" {
			fail(w, 405, "Метод не поддерживается")
			return
		}
		s.authRegister(w, r)
	case "/api/auth/logout":
		if r.Method != "POST" {
			fail(w, 405, "Метод не поддерживается")
			return
		}
		if len(r.Header.Values("Authorization")) != 0 {
			fail(w, 403, "Для управления учётной записью требуется сессия")
			return
		}
		var body struct{}
		if !readJSON(w, r, 4096, &body) {
			return
		}
		s.mu.Lock()
		if len(r.Header.Values("X-BarkOdd-User")) != 0 && s.principalLocked(r) == nil {
			s.mu.Unlock()
			fail(w, 401, "Аккаунт изменился. Обновите страницу и повторите действие")
			return
		}
		s.revokeSessionLocked(s.sessionKey(r))
		s.mu.Unlock()
		s.authCookie(w, r, "")
		writeJSON(w, 200, map[string]bool{"ok": true})
	case "/api/auth/password":
		if r.Method != "POST" {
			fail(w, 405, "Метод не поддерживается")
			return
		}
		s.authChangePassword(w, r)
	default:
		if strings.HasPrefix(path, "/api/admin/") {
			s.authAdminRoute(w, r)
		} else {
			fail(w, 404, "Адрес не найден")
		}
	}
}
func (s *Server) authLogin(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Code     string `json:"code"`
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if !readJSON(w, r, 4096, &body) {
		return
	}
	if s.config.AuthMode == "none" {
		fail(w, 403, "Вход не требуется")
		return
	}
	name := strings.ToLower(body.Username)
	if !s.authHashSlot(w, r, "login", name) {
		return
	}
	defer func() { <-s.auth.hashSlots }()
	var user *authUser
	if body.Code != "" {
		if body.Username != "" || body.Password != "" {
			fail(w, 400, "Выберите способ входа")
			return
		}
		if subtle.ConstantTimeCompare([]byte(tokenHash(body.Code)), []byte(tokenHash(s.config.AdminCode))) == 1 {
			user = &authOwner
		}
	} else if s.config.AuthMode == "multi_user" {
		s.mu.Lock()
		for _, u := range s.auth.users {
			if u.Username == name {
				user = u
				break
			}
		}
		s.mu.Unlock()
		if !validAuthPassword(body.Password) || !validAuthUsername(body.Username) {
			user = nil
		} else if user == nil {
			authPasswordHash(body.Password, "00000000000000000000000000000000")
		} else if !authPasswordMatches(user, body.Password) {
			user = nil
		}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		fail(w, 503, "Сервер завершает работу")
		return
	}
	if user == nil || user.Disabled || (user.ID != authOwnerID && s.auth.users[user.ID] != user) {
		fail(w, 401, "Неверные данные для входа")
		return
	}
	token, err := s.createAuthSessionLocked(user.ID)
	if err != nil {
		if errors.Is(err, errAuthSessionsFull) {
			fail(w, 429, "Достигнут лимит сессий сервера")
		} else {
			fail(w, 500, "Не удалось создать сессию")
		}
		return
	}
	s.authCookie(w, r, token)
	writeJSON(w, 200, map[string]any{"user": user})
}
func (s *Server) authRegister(w http.ResponseWriter, r *http.Request) {
	if s.config.AuthMode != "multi_user" {
		fail(w, 403, "Регистрация недоступна")
		return
	}
	var body struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if !readJSON(w, r, 4096, &body) {
		return
	}
	if !validAuthUsername(body.Username) || !validAuthPassword(body.Password) {
		fail(w, 400, "Логин: 3–32 символа A-Z, a-z, 0-9, _, . или -; пароль: 12–128 символов")
		return
	}
	name := strings.ToLower(body.Username)
	if !s.authHashSlot(w, r, "register", name) {
		return
	}
	defer func() { <-s.auth.hashSlots }()
	hash, salt, err := newAuthPassword(body.Password)
	if err != nil {
		fail(w, 500, "Не удалось создать пароль")
		return
	}
	id, err := randomID(12)
	if err != nil {
		fail(w, 500, "Не удалось создать пользователя")
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		fail(w, 503, "Сервер завершает работу")
		return
	}
	for _, u := range s.auth.users {
		if u.Username == name {
			fail(w, 409, "Логин уже занят")
			return
		}
	}
	if len(s.auth.users) >= maxAuthUsers {
		fail(w, 429, "Достигнут лимит пользователей сервера")
		return
	}
	u := &authUser{ID: id, Username: name, Role: "user", CreatedAt: s.now(), PasswordHash: hash, Salt: salt}
	users := cloneAuthUsers(s.auth.users)
	users[id] = u
	token, err := s.createAuthSessionLocked(id)
	if err != nil {
		if errors.Is(err, errAuthSessionsFull) {
			fail(w, 429, "Достигнут лимит сессий сервера")
		} else {
			fail(w, 500, "Не удалось создать сессию")
		}
		return
	}
	if err = s.saveAuthUsersLocked(users); err != nil {
		s.revokeSessionLocked(tokenHash(token))
		fail(w, 500, "Не удалось сохранить пользователя")
		return
	}
	s.auth.users = users
	s.authCookie(w, r, token)
	writeJSON(w, 201, map[string]any{"user": u})
}
func (s *Server) authChangePassword(w http.ResponseWriter, r *http.Request) {
	if len(r.Header.Values("Authorization")) != 0 {
		fail(w, 403, "Для управления учётной записью требуется сессия")
		return
	}
	var body struct {
		CurrentPassword string `json:"currentPassword"`
		NewPassword     string `json:"newPassword"`
	}
	if !readJSON(w, r, 4096, &body) {
		return
	}
	s.mu.Lock()
	u := s.principalLocked(r)
	s.mu.Unlock()
	if u == nil || u.Role != "user" {
		fail(w, 403, "Действие доступно только пользователю")
		return
	}
	if !validAuthPassword(body.NewPassword) || !validAuthPassword(body.CurrentPassword) {
		fail(w, 400, "Пароль должен содержать 12–128 символов")
		return
	}
	if !s.authHashSlot(w, r, "password", u.Username) {
		return
	}
	defer func() { <-s.auth.hashSlots }()
	if !authPasswordMatches(u, body.CurrentPassword) {
		fail(w, 401, "Неверные данные для входа")
		return
	}
	hash, salt, err := newAuthPassword(body.NewPassword)
	if err != nil {
		fail(w, 500, "Не удалось создать пароль")
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed || s.principalLocked(r) != u || s.auth.users[u.ID] != u {
		fail(w, 401, "Сессия завершена")
		return
	}
	updated := *u
	updated.PasswordHash = hash
	updated.Salt = salt
	users := cloneAuthUsers(s.auth.users)
	users[u.ID] = &updated
	if err = s.saveAuthUsersLocked(users); err != nil {
		fail(w, 500, "Не удалось сохранить пароль")
		return
	}
	s.auth.users = users
	s.revokeUserSessionsLocked(u.ID)
	s.authCookie(w, r, "")
	writeJSON(w, 200, map[string]bool{"ok": true})
}
func (s *Server) authAdminRoute(w http.ResponseWriter, r *http.Request) {
	if len(r.Header.Values("Authorization")) != 0 {
		fail(w, 403, "Для управления учётной записью требуется сессия")
		return
	}
	s.mu.Lock()
	u := s.principalLocked(r)
	allowed := !s.closed && s.config.AuthMode == "multi_user" && u != nil && u.Role == "admin"
	s.mu.Unlock()
	if !allowed {
		fail(w, 403, "Действие доступно только администратору")
		return
	}
	if r.URL.Path == "/api/admin/users" {
		if r.Method != "GET" {
			fail(w, 405, "Метод не поддерживается")
			return
		}
		s.mu.Lock()
		defer s.mu.Unlock()
		if s.principalLocked(r) == nil {
			fail(w, 403, "Сессия завершена")
			return
		}
		writeJSON(w, 200, map[string]any{"users": sortedAuthUsers(s.auth.users)})
		return
	}
	parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/api/admin/users/"), "/")
	if !strings.HasPrefix(r.URL.Path, "/api/admin/users/") || len(parts) != 1 || !storageID.MatchString(parts[0]) {
		fail(w, 404, "Пользователь не найден")
		return
	}
	id := parts[0]
	if r.Method != "PUT" {
		fail(w, 405, "Метод не поддерживается")
		return
	}
	// Administrators may disable accounts, but must not set credentials that
	// would let them sign in as another user and access that user's media.
	var body struct {
		Disabled *bool `json:"disabled"`
	}
	if !readJSON(w, r, 4096, &body) {
		return
	}
	if body.Disabled == nil {
		fail(w, 400, "Укажите disabled")
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	actor := s.principalLocked(r)
	if s.closed || actor == nil || actor.Role != "admin" {
		fail(w, 403, "Сессия завершена")
		return
	}
	target := s.auth.users[id]
	if target == nil {
		fail(w, 404, "Пользователь не найден")
		return
	}
	updated := *target
	updated.Disabled = *body.Disabled
	users := cloneAuthUsers(s.auth.users)
	users[id] = &updated
	if err := s.saveAuthUsersLocked(users); err != nil {
		fail(w, 500, "Не удалось сохранить пользователя")
		return
	}
	s.auth.users = users
	if updated.Disabled {
		s.revokeUserSessionsLocked(id)
		s.invalidateAuthLocked("", id)
	}
	writeJSON(w, 200, map[string]any{"user": &updated})
}
