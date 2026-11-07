package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

const authTestCode = "01234567890123456789012345678901"
const authTestPassword = "a long correct password"

func authTestServer(t *testing.T, mode string) *Server {
	t.Helper()
	s, err := New(Config{AuthMode: mode, AdminCode: authTestCode, DataDir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	return s
}
func authRequest(s *Server, method, path, body string, cookie *http.Cookie) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, path, strings.NewReader(body))
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("Origin", "http://example.com")
	if cookie != nil {
		r.AddCookie(cookie)
	}
	w := httptest.NewRecorder()
	s.serveAuth(w, r)
	return w
}
func authRegister(t *testing.T, s *Server, name string) (*http.Cookie, string) {
	t.Helper()
	w := authRequest(s, "POST", "/api/auth/register", `{"username":"`+name+`","password":"`+authTestPassword+`"}`, nil)
	if w.Code != 201 {
		t.Fatalf("register: %d %s", w.Code, w.Body)
	}
	var b struct {
		User authUser `json:"user"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &b); err != nil {
		t.Fatal(err)
	}
	return w.Result().Cookies()[0], b.User.ID
}
func authAdmin(t *testing.T, s *Server) *http.Cookie {
	t.Helper()
	w := authRequest(s, "POST", "/api/auth/login", `{"code":"`+authTestCode+`"}`, nil)
	if w.Code != 200 {
		t.Fatalf("admin: %d %s", w.Code, w.Body)
	}
	return w.Result().Cookies()[0]
}

func TestAuthConfig(t *testing.T) {
	for _, tc := range []struct {
		mode, code, legacy string
		ok                 bool
	}{{"none", "", "", true}, {"admin_code", authTestCode, "", true}, {"multi_user", "", authTestCode, true}, {"", authTestCode, "", true}, {"none", authTestCode, "different", false}, {"wrong", authTestCode, "", false}, {"admin_code", "", "", false}, {"multi_user", "short", "", false}} {
		c := Config{AuthMode: tc.mode, AdminCode: tc.code, RoomCreationKey: tc.legacy}
		err := validateAuthConfig(&c)
		if (err == nil) != tc.ok {
			t.Errorf("%+v err=%v", tc, err)
		}
		if err == nil && tc.mode == "" && c.AuthMode != "admin_code" {
			t.Error("missing default")
		}
	}
}
func TestAuthRegistrationCookieAndPersistence(t *testing.T) {
	s := authTestServer(t, "multi_user")
	cookie, id := authRegister(t, s, "Alice")
	if !cookie.HttpOnly || cookie.SameSite != http.SameSiteStrictMode || cookie.Path != "/" || cookie.MaxAge != 30*24*60*60 {
		t.Fatalf("cookie: %+v", cookie)
	}
	w := authRequest(s, "GET", "/api/auth", "", cookie)
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"username":"alice"`) {
		t.Fatalf("identity: %s", w.Body)
	}
	data, err := os.ReadFile(filepath.Join(s.config.DataDir, "auth", "users.json"))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(data), authTestPassword) || strings.Contains(w.Body.String(), "passwordHash") || strings.Contains(string(data), cookie.Value) {
		t.Fatal("secret leaked")
	}
	s2, err := New(s.config)
	if err != nil {
		t.Fatal(err)
	}
	defer s2.Close()
	if s2.auth.users[id] == nil {
		t.Fatal("user missing after restart")
	}
	w = authRequest(s2, "GET", "/api/auth", "", cookie)
	if !strings.Contains(w.Body.String(), `"user":null`) {
		t.Fatal("sessions persisted")
	}
	w = authRequest(s2, "POST", "/api/auth/login", `{"username":"ALICE","password":"`+authTestPassword+`"}`, nil)
	if w.Code != 200 {
		t.Fatalf("restart login %d %s", w.Code, w.Body)
	}
}
func TestAuthDuplicateRegistrationAndModes(t *testing.T) {
	s := authTestServer(t, "multi_user")
	var wg sync.WaitGroup
	codes := make(chan int, 2)
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			codes <- authRequest(s, "POST", "/api/auth/register", `{"username":"same","password":"`+authTestPassword+`"}`, nil).Code
		}()
	}
	wg.Wait()
	close(codes)
	n := 0
	for code := range codes {
		if code == 201 {
			n++
		} else if code != 409 {
			t.Fatalf("duplicate status %d", code)
		}
	}
	if n != 1 {
		t.Fatalf("created %d", n)
	}
	for _, mode := range []string{"none", "admin_code"} {
		other := authTestServer(t, mode)
		if w := authRequest(other, "POST", "/api/auth/register", `{"username":"same","password":"`+authTestPassword+`"}`, nil); w.Code != 403 {
			t.Fatalf("register allowed %s: %d", mode, w.Code)
		}
	}
}
func TestAuthLogoutExpiryAndPermissions(t *testing.T) {
	s := authTestServer(t, "multi_user")
	cookie, _ := authRegister(t, s, "alice")
	if w := authRequest(s, "GET", "/api/admin/users", "", cookie); w.Code != 403 {
		t.Fatalf("nonadmin %d", w.Code)
	}
	if w := authRequest(s, "POST", "/api/auth/logout", `{}`, cookie); w.Code != 200 {
		t.Fatal(w.Code)
	}
	if w := authRequest(s, "GET", "/api/auth", "", cookie); !strings.Contains(w.Body.String(), `"user":null`) {
		t.Fatal("logout kept session")
	}
	cookie, _ = authRegister(t, s, "bobby")
	s.mu.Lock()
	for _, sess := range s.auth.sessions {
		sess.ExpiresAt = s.now().Add(-time.Second)
	}
	s.expireSessionsLocked()
	s.mu.Unlock()
	if w := authRequest(s, "GET", "/api/auth", "", cookie); !strings.Contains(w.Body.String(), `"user":null`) {
		t.Fatal("expired session valid")
	}
}
func TestAuthAdminDisableAndUserPasswordChange(t *testing.T) {
	s := authTestServer(t, "multi_user")
	cookie, id := authRegister(t, s, "alice")
	admin := authAdmin(t, s)
	w := authRequest(s, "PUT", "/api/admin/users/"+id, `{"disabled":true}`, admin)
	if w.Code != 200 {
		t.Fatalf("disable %d %s", w.Code, w.Body)
	}
	if s.ownerEnabledLocked(id) {
		t.Fatal("disabled owner enabled")
	}
	if w = authRequest(s, "GET", "/api/auth", "", cookie); !strings.Contains(w.Body.String(), `"user":null`) {
		t.Fatal("disable kept session")
	}
	authRequest(s, "PUT", "/api/admin/users/"+id, `{"disabled":false}`, admin)
	w = authRequest(s, "POST", "/api/auth/login", `{"username":"alice","password":"`+authTestPassword+`"}`, nil)
	if w.Code != 200 {
		t.Fatalf("password fails after reenable: %s", w.Body)
	}
	cookie = w.Result().Cookies()[0]
	w = authRequest(s, "POST", "/api/auth/password", `{"currentPassword":"`+authTestPassword+`","newPassword":"another secure password"}`, cookie)
	if w.Code != 200 {
		t.Fatal(w.Code)
	}
	if w = authRequest(s, "GET", "/api/auth", "", cookie); !strings.Contains(w.Body.String(), `"user":null`) {
		t.Fatal("password change kept session")
	}
	if w = authRequest(s, "POST", "/api/auth/login", `{"username":"alice","password":"`+authTestPassword+`"}`, nil); w.Code != 401 {
		t.Fatal("old password works after password change")
	}
	if w = authRequest(s, "POST", "/api/auth/login", `{"username":"alice","password":"another secure password"}`, nil); w.Code != 200 {
		t.Fatalf("new password fails: %s", w.Body)
	}
}

func TestAuthAdminCannotResetUserPassword(t *testing.T) {
	s := authTestServer(t, "multi_user")
	cookie, id := authRegister(t, s, "alice")
	admin := authAdmin(t, s)
	w := authRequest(s, "POST", "/api/admin/users/"+id+"/password", `{"password":"admin chosen password"}`, admin)
	if w.Code != 404 {
		t.Errorf("admin password reset: got %d, want 404", w.Code)
	}
	if w = authRequest(s, "GET", "/api/auth", "", cookie); !strings.Contains(w.Body.String(), `"id":"`+id+`"`) {
		t.Error("rejected password reset revoked the user's session")
	}
	if w = authRequest(s, "POST", "/api/auth/login", `{"username":"alice","password":"admin chosen password"}`, nil); w.Code != 401 {
		t.Error("administrator can impersonate the user with a chosen password")
	}
	if w = authRequest(s, "POST", "/api/auth/login", `{"username":"alice","password":"`+authTestPassword+`"}`, nil); w.Code != 200 {
		t.Errorf("rejected password reset changed the user's password: %s", w.Body)
	}
}
func TestAuthFailedPersistenceLeavesLiveUser(t *testing.T) {
	s := authTestServer(t, "multi_user")
	_, id := authRegister(t, s, "alice")
	admin := authAdmin(t, s)
	path := filepath.Join(s.config.DataDir, "auth", "users.json")
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(path, 0700); err != nil {
		t.Fatal(err)
	}
	w := authRequest(s, "PUT", "/api/admin/users/"+id, `{"disabled":true}`, admin)
	if w.Code != 500 || s.auth.users[id].Disabled {
		t.Fatalf("failed save mutated state %d", w.Code)
	}
	w = authRequest(s, "POST", "/api/auth/register", `{"username":"bobby","password":"`+authTestPassword+`"}`, nil)
	if w.Code != 500 || len(s.auth.users) != 1 {
		t.Fatalf("failed signup mutated state %d", w.Code)
	}
}
func TestAuthLoginErrorsAndValidation(t *testing.T) {
	s := authTestServer(t, "multi_user")
	authRegister(t, s, "alice")
	unknown := authRequest(s, "POST", "/api/auth/login", `{"username":"unknown","password":"wrong password"}`, nil)
	wrong := authRequest(s, "POST", "/api/auth/login", `{"username":"alice","password":"wrong password"}`, nil)
	if unknown.Code != 401 || wrong.Code != 401 || unknown.Body.String() != wrong.Body.String() {
		t.Fatalf("credential enumeration: %d %d", unknown.Code, wrong.Code)
	}
	for _, body := range []string{`{"username":"admin","password":"a long correct password"}`, `{"username":"x","password":"a long correct password"}`, `{"username":"valid","password":"short"}`, `{"username":"valid","password":"a long correct password","role":"admin"}`} {
		if w := authRequest(s, "POST", "/api/auth/register", body, nil); w.Code != 400 {
			t.Fatalf("invalid accepted %d %s", w.Code, body)
		}
	}
}

func TestAuthSessionsBoundedAndNoBearerSession(t *testing.T) {
	s := authTestServer(t, "multi_user")
	cookie, id := authRegister(t, s, "alice")
	r := httptest.NewRequest("GET", "/api/auth", nil)
	r.Header.Set("Authorization", "Bearer "+cookie.Value)
	s.mu.Lock()
	if s.principalLocked(r) != nil {
		t.Error("bearer authenticated session")
	}
	now := s.now()
	s.auth.sessions = make(map[string]*authSession)
	for i := 0; i < 32; i++ {
		s.auth.sessions[string(rune(i+1))] = &authSession{UserID: id, CreatedAt: now.Add(time.Duration(i-32) * time.Second), ExpiresAt: now.Add(time.Hour)}
	}
	_, err := s.createAuthSessionLocked(id)
	if err != nil {
		t.Fatal(err)
	}
	if len(s.auth.sessions) != 32 || s.auth.sessions[string(rune(1))] != nil {
		t.Error("per-user cap did not evict oldest")
	}
	s.auth.sessions = make(map[string]*authSession)
	for i := 0; i < 4096; i++ {
		s.auth.sessions[string(rune(i+1))] = &authSession{UserID: "other", CreatedAt: now.Add(time.Duration(i-4096) * time.Second), ExpiresAt: now.Add(time.Hour)}
	}
	_, err = s.createAuthSessionLocked(id)
	if err == nil {
		t.Error("global cap accepted another session")
	}
	if len(s.auth.sessions) != 4096 || s.auth.sessions[string(rune(1))] == nil {
		t.Error("global cap evicted an existing session")
	}
	s.mu.Unlock()
}
func TestAuthRateLimitsHashSlotsAndUserCap(t *testing.T) {
	s := authTestServer(t, "multi_user")
	r := httptest.NewRequest("POST", "/api/auth/login", nil)
	s.mu.Lock()
	for i := 0; i < 10; i++ {
		if !s.allowAuthAttemptLocked(r, "login", "alice") {
			t.Error("early limit")
		}
	}
	if s.allowAuthAttemptLocked(r, "login", "alice") {
		t.Error("unbounded named attempts")
	}
	s.auth.attempts = map[string]authAttempt{}
	for i := 0; i < 1100; i++ {
		r.RemoteAddr = string(rune(i + 1))
		s.allowAuthAttemptLocked(r, "login", string(rune(i+1)))
	}
	if len(s.auth.attempts) > 1024 {
		t.Errorf("unbounded attempts %d", len(s.auth.attempts))
	}
	s.auth.attempts = map[string]authAttempt{}
	s.mu.Unlock()
	s.auth.hashSlots <- struct{}{}
	s.auth.hashSlots <- struct{}{}
	w := authRequest(s, "POST", "/api/auth/login", `{"username":"alice","password":"a long correct password"}`, nil)
	<-s.auth.hashSlots
	<-s.auth.hashSlots
	if w.Code != 429 {
		t.Fatalf("unbounded hash work: %d", w.Code)
	}
	s.mu.Lock()
	for i := 0; i < 1000; i++ {
		s.auth.users[string(rune(i+1))] = &authUser{Username: "existing"}
	}
	s.mu.Unlock()
	w = authRequest(s, "POST", "/api/auth/register", `{"username":"alice","password":"a long correct password"}`, nil)
	if w.Code != 429 || len(s.auth.users) != 1000 {
		t.Fatalf("user cap %d", w.Code)
	}
}
func TestAuthCookieSubpathSecureAndNone(t *testing.T) {
	s := authTestServer(t, "none")
	w := authRequest(s, "GET", "/api/auth", "", nil)
	if !strings.Contains(w.Body.String(), `"id":"owner"`) {
		t.Fatalf("none principal: %s", w.Body)
	}
	s.config.PublicURL = "https://example.com/barkodd"
	r := httptest.NewRequest("POST", "https://example.com/barkodd/api/auth/login", nil)
	w = httptest.NewRecorder()
	s.authCookie(w, r, "test")
	c := w.Result().Cookies()[0]
	if !c.Secure || c.Path != "/barkodd/" {
		t.Fatalf("prefix cookie %+v", c)
	}
	w = httptest.NewRecorder()
	s.authCookie(w, r, "")
	c = w.Result().Cookies()[0]
	if c.MaxAge != -1 || c.Path != "/barkodd/" {
		t.Fatalf("clear cookie %+v", c)
	}
}
func TestAuthPasswordUnicodeAndWhitespace(t *testing.T) {
	s := authTestServer(t, "multi_user")
	password := "  секретный пароль  "
	body := `{"username":"alice","password":"` + password + `"}`
	if w := authRequest(s, "POST", "/api/auth/register", body, nil); w.Code != 201 {
		t.Fatalf("unicode rejected: %d", w.Code)
	}
	if w := authRequest(s, "POST", "/api/auth/login", body, nil); w.Code != 200 {
		t.Fatalf("whitespace lost: %d", w.Code)
	}
	if w := authRequest(s, "POST", "/api/auth/login", `{"username":"alice","password":"секретный пароль"}`, nil); w.Code != 401 {
		t.Fatal("password trimmed")
	}
	for _, password := range []string{strings.Repeat("a", 129), strings.Repeat("a", 11), strings.Repeat("я", 129)} {
		if validAuthPassword(password) {
			t.Error("invalid password accepted")
		}
	}
}
func TestAuthStoreRejectsMalformedAndModeDowngrade(t *testing.T) {
	s := authTestServer(t, "multi_user")
	authRegister(t, s, "alice")
	config := s.config
	config.AuthMode = "none"
	if other, err := New(config); err == nil {
		other.Close()
		t.Fatal("mode downgrade exposed accounts")
	}
	path := filepath.Join(s.config.DataDir, "auth", "users.json")
	original, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	for _, bad := range []string{`{"version":2,"mode":"multi_user","users":[]}`, `{"version":1,"mode":"multi_user","users":[],"secret":true}`, `{"version":1,"mode":"multi_user","users":null}`, strings.Replace(string(original), `"role":"user"`, `"role":"admin"`, 1), strings.Replace(string(original), `"passwordHash":"`, `"passwordHash":"xx`, 1), string(original) + `{}`} {
		if err = os.WriteFile(path, []byte(bad), 0600); err != nil {
			t.Fatal(err)
		}
		if other, err := New(s.config); err == nil {
			other.Close()
			t.Fatalf("malformed auth accepted %s", bad)
		}
	}
}

func TestAuthAccountMutationsRejectBearerWithCookie(t *testing.T) {
	s := authTestServer(t, "multi_user")
	cookie, id := authRegister(t, s, "alice")
	admin := authAdmin(t, s)
	for _, tc := range []struct {
		method, path, body string
		cookie             *http.Cookie
	}{{"GET", "/api/admin/users", "", admin}, {"PUT", "/api/admin/users/" + id, `{"disabled":false}`, admin}, {"POST", "/api/auth/password", `{"currentPassword":"a long correct password","newPassword":"new long correct password"}`, cookie}} {
		for _, header := range []string{"Bearer invalid", ""} {
			r := httptest.NewRequest(tc.method, tc.path, strings.NewReader(tc.body))
			r.AddCookie(tc.cookie)
			r.Header.Set("Authorization", header)
			w := httptest.NewRecorder()
			s.serveAuth(w, r)
			if w.Code != 403 {
				t.Errorf("Authorization %q fell back to cookie: %s %d", header, tc.path, w.Code)
			}
		}
	}
}
func TestAuthRegistrationAtSessionCapDoesNotCreateUser(t *testing.T) {
	s := authTestServer(t, "multi_user")
	s.mu.Lock()
	now := s.now()
	for i := 0; i < 4096; i++ {
		s.auth.sessions[string(rune(i+1))] = &authSession{UserID: "owner", CreatedAt: now, ExpiresAt: now.Add(time.Hour)}
	}
	s.mu.Unlock()
	w := authRequest(s, "POST", "/api/auth/register", `{"username":"alice","password":"a long correct password"}`, nil)
	if w.Code != 429 || len(s.auth.users) != 0 {
		t.Fatalf("partial registration at session cap: %d users%d", w.Code, len(s.auth.users))
	}
}

func TestAuthLogoutRejectsAuthorizationWithoutRevokingCookie(t *testing.T) {
	s := authTestServer(t, "multi_user")
	cookie, _ := authRegister(t, s, "alice")
	for _, header := range []string{"Bearer invalid", ""} {
		r := httptest.NewRequest("POST", "/api/auth/logout", strings.NewReader(`{}`))
		r.AddCookie(cookie)
		r.Header.Set("Authorization", header)
		w := httptest.NewRecorder()
		s.serveAuth(w, r)
		if w.Code != 403 {
			t.Errorf("logout accepted Authorization %q: %d", header, w.Code)
		}
		if len(w.Result().Cookies()) != 0 {
			t.Error("rejected logout changed cookie")
		}
		identity := authRequest(s, "GET", "/api/auth", "", cookie)
		if !strings.Contains(identity.Body.String(), `"username":"alice"`) {
			t.Error("rejected logout revoked session")
		}
	}
}

func TestAuthExpectedUserPreventsCrossTabAccountWrites(t *testing.T) {
	s := authTestServer(t, "multi_user")
	_, aliceID := authRegister(t, s, "alice")
	bob, bobID := authRegister(t, s, "bobby")
	admin := authAdmin(t, s)
	request := func(method, path, body string, cookie *http.Cookie, expected []string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, path, strings.NewReader(body))
		r.Header.Set("Origin", "http://example.com")
		r.Header.Set("Content-Type", "application/json")
		r.AddCookie(cookie)
		for _, value := range expected {
			r.Header.Add("X-BarkOdd-User", value)
		}
		w := httptest.NewRecorder()
		s.Handler().ServeHTTP(w, r)
		return w
	}
	for _, tc := range []struct {
		method, path, body string
		cookie             *http.Cookie
	}{
		{"GET", "/api/rooms", "", bob},
		{"POST", "/api/rooms", `{"name":"Must not create for Bob"}`, bob},
		{"GET", "/api/admin/users", "", admin},
		{"PUT", "/api/admin/users/" + bobID, `{"disabled":true}`, admin},
		{"POST", "/api/auth/logout", `{}`, bob},
		{"POST", "/api/auth/password", `{"currentPassword":"a long correct password","newPassword":"another long correct password"}`, bob},
	} {
		w := request(tc.method, tc.path, tc.body, tc.cookie, []string{aliceID})
		if w.Code != 401 && w.Code != 403 {
			t.Errorf("stale actor accepted %s %s: %d", tc.method, tc.path, w.Code)
		}
		if tc.path == "/api/auth/logout" && len(w.Result().Cookies()) != 0 {
			t.Error("stale logout changed actual session cookie")
		}
	}
	if len(s.rooms) != 0 {
		t.Error("stale tab created another user's room")
	}
	if state := authRequest(s, "GET", "/api/auth", "", bob); !strings.Contains(state.Body.String(), `"username":"bobby"`) {
		t.Fatal("stale tab revoked actual Bob session")
	}
	for _, bad := range [][]string{{""}, {bobID, bobID}} {
		w := request("GET", "/api/rooms", "", bob, bad)
		if w.Code != 401 && w.Code != 403 {
			t.Errorf("invalid expected header accepted: %q %d", bad, w.Code)
		}
		w = request("POST", "/api/auth/logout", `{}`, bob, bad)
		if w.Code != 401 || len(w.Result().Cookies()) != 0 {
			t.Errorf("invalid actor logout affected session: %q %d", bad, w.Code)
		}
	}
	if w := request("GET", "/api/rooms", "", bob, []string{bobID}); w.Code != 200 {
		t.Errorf("correct actor rejected %d", w.Code)
	}
	if w := request("POST", "/api/rooms", `{"name":"Bob room"}`, bob, []string{bobID}); w.Code != 201 {
		t.Errorf("correct actor create rejected %d %s", w.Code, w.Body)
	}
	if w := request("POST", "/api/auth/logout", `{}`, bob, []string{bobID}); w.Code != 200 {
		t.Errorf("correct actor logout rejected %d", w.Code)
	}
}

func TestAuthExpectedUserAppliesToImplicitOwner(t *testing.T) {
	s := authTestServer(t, "none")
	r := httptest.NewRequest("GET", "/api/auth", nil)
	r.Header.Set("X-BarkOdd-User", "other")
	s.mu.Lock()
	if s.principalLocked(r) != nil {
		t.Error("none mode ignored stale actor")
	}
	r.Header.Set("X-BarkOdd-User", "owner")
	if s.principalLocked(r) == nil {
		t.Error("none owner rejected")
	}
	s.mu.Unlock()
}
