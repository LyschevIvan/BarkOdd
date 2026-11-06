# Auth Modes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Track checked tasks here. User explicitly authorized complete implementation and subsequently requested commits on 2026-11-07; no further plan approval required.

**Goal:** Implement none, admin_code and multi_user authentication with self-registration and guest QR viewing.
**Architecture:** Server-side opaque cookie sessions identify owners; room capabilities authorize guests only. Owner IDs persist alongside rooms. Auth JSON lives under DATA_DIR/auth; WebSocket and event paths revalidate access.
**Tech Stack:** Go 1.23, vanilla JS, existing WebSocket/WebRTC transports, golang.org/x/crypto Argon2id, Playwright.
**Spec:** docs/superpowers/specs/2026-11-06-auth-modes-design.md

## Global Constraints
- Commits authorized by the user on 2026-11-07. No push, production deploy or destructive data migration.
- Work in existing checkout on codex/auth-modes. Separate file ownership permits concurrent implementation per developer delegation instruction.
- AUTH_MODE defaults admin_code; protected modes require valid 32–128 URL-safe ADMIN_CODE with ROOM_CREATION_KEY compatibility.
- Self-registration only in multi_user, user owns only their rooms, admin cannot inspect other users' media.
- Preserve guest links and transports; no silent viewer key rotation. Disable/revoke applies to HTTP, events and active streams.
- 30 day memory sessions; registration cap1000; existing room cap100.

## Review Focus
- Cookie plus stale/foreign bearer must never elevate guest access; task2 auth tests.
- Logout/block/password reset during photo decode or active RTC immediately invalidates authority; task2 concurrency tests.
- New browser opens existing room without knowing room secrets; task3 browser test.
- Subpath deployment scopes cookies and relative APIs correctly; task3 browser test.
- Failed disk writes/concurrent duplicate signup cannot create inconsistent users or rooms; task1 tests.

### Task 1: Users, passwords and sessions
Files: new internal/server/auth.go, auth_storage.go, auth_test.go; go.mod/go.sum only. Other backend files owned by root.
- [x] Write failing config, registration, unique login, session, admin permission, password reset and persistence tests.
- [x] Implement auth hooks and endpoints in the contract below; verify Argon2id API via fetched docs and pin Go1.23-compatible crypto version.
- [x] Verify focused Go tests, including failed persistence, rate limits, unknown user and session revocation.
- [x] Independent task review and fix findings.

### Task 2: Room, event and stream integration (root)
Files: internal/server/server.go, http.go, storage.go, owner.go, events.go, stream.go, existing Go tests; cmd/barkodd/main.go and main_test.go.
- [x] Add ownership and room list, request principal policy, session-based host/owner-viewer, guest-only token precedence.
- [x] Test and implement source/session revocation across stream and event paths; migrate legacy rooms and adapt old tests to sessions without weakening capability regression coverage.
- [x] Wire config + same-origin mutation checks; startup error/alias tests.
- [x] Run Go suite/race/vet and review integration.

### Task 3: UI and browser tests
Files: web/app.js, index.html, styles.css, new auth UI module if useful, tests/browser.spec.js, microphone.spec.js, new auth browser test, playwright.config.js. Media tests remain root-owned.
- [x] Add failing browser scenarios: none login-free, code login, self-register two isolated users, admin block/reset, guest QR.
- [x] Implement account bootstrap/login/register/logout/password, own room list/open/create, admin user controls. Keep existing device/media UI.
- [x] Namespace saved bindings by user, no stored admin/password, guests independent. Session loss stops capture and returns to login. Missing viewer token shows explicit regeneration action.
- [x] Update existing browser fixtures to authenticate; run local browser suites with root-provided test servers.
- [x] Independent UI review and fix findings.

### Task 4: Docs and final verification (root)
Files: README.md, .env.example, compose.yaml, deploy/compose.macmini.example.yaml, docs/design.md.
- [x] Document launch examples all3 modes, public signup, guest links, migration, limits and cookie sessions.
- [x] Go race/vet, Node, Playwright all3 modes and both transports; prefix coverage.
- [x] Final independent review; resolve findings, record validation, deliver working tree without commits.

## Progress / rulings
- Baseline before implementation: go test ./... and npm test passed (Go needs local ports outside sandbox).
- Plan/spec approved by explicit implementation request. Worktree creation is unnecessary for shared workspace; feature branch isolates changes without moving user's checkout.
- Preflight Task1↔2: auth hooks/types below; root alone edits shared Server fields, agent alone auth files. Task2↔3: HTTP contract below; no shared file edits. Task1↔3: response fields below. Task4 overlaps docs only after integration. Each task matches approved spec.

# Auth integration contract
Shared workdir: the repository root; commits authorized on 2026-11-07, no push or additional worktrees.
Auth modes none/admin_code/multi_user; ADMIN_CODE and legacy ROOM_CREATION_KEY alias, default admin_code, validate startup. Reserved owner ID "owner"; admin principal username "admin", role "admin" (shared identity). Multi users randomID(12) role user. username ASCII [a-zA-Z0-9_.-]{3,32}, normalized lowercase, admin reserved; password 12-128 Unicode characters max512 bytes, never trim password. Login unknown/wrong generic401.
HTTP contract (JSON):
GET api/auth -> {mode, user: {id,username,role,disabled?}|null}; in none implicit owner always returned.
POST api/auth/login {code} for admin in protected modes OR {username,password} multi_user; response {user}, cookie.
POST api/auth/register {username,password} multi_user only ->201 {user}, cookie; immediate login.
POST api/auth/logout {} ->200 {ok:true}; clear current session.
POST api/auth/password {currentPassword,newPassword} regular users only ->200 {ok:true}, revoke sessions + clear cookie.
GET api/admin/users -> {users:[{id,username,role,disabled,createdAt}]}; admin+multi only.
PUT api/admin/users/{id} {disabled:bool} ->200 {user}; target regular users only.
POST api/admin/users/{id}/password {password} ->200 {ok:true}; revoke all target sessions.
GET api/rooms -> {rooms:[{id,name,createdAt,online,monitoring}]} own only, session/none; no room secrets.
POST api/rooms {name} ->201 existing {id,ownerId,hostToken,viewerToken}; session/none required. hostToken kept compatibility output but NEVER authorizes protected or none mode. Frontend owned-room binding {id, account:true, viewerToken?}; use cookie, no bearer for owner HTTP and owner WS. Guest binding {id,viewerToken}; bearer for HTTP and token in WS.
POST api/rooms/{id}/approval {} requires owner session/none, no ownerKey header needed. Other room endpoints unchanged.
Origin/CSRF: all POST/PUT/DELETE in ALL modes require exact valid Origin from PUBLIC_URL origin or request origin using same existing streamOriginAllowed rules. Browser fetch default Origin supplies this. Test helpers must add matching Origin; no special token required.
Session cookie name barkodd_session; HttpOnly SameSiteStrict, Path derived PUBLIC_URL path else /, Secure when TLS or PUBLIC_URL https. MaxAge30days. Sessions memory only, fixed expiry; server restart clears. No bearer session support. Authorization header if present always guest-only, must match viewer hash; do not fall back to cookie for invalid bearer.
Root-owned shared declarations in server.go:
Config.AuthMode string, Config.AdminCode string; RoomCreationKey retained.
room.OwnerID string `json:"ownerId"`; room.SourceAuthSession string runtime only for heartbeat-source ownership revocation.
Server.auth authState (type declared by auth agent).
Auth agent implementation hooks (all *Locked require s.mu held):
validateAuthConfig(*Config) error
(s *Server) initAuth() error // startup AFTER Now, DataDir normalization, BEFORE room load. creates auth store, maps, limiters.
(s *Server) validateRoomOwners() error // AFTER all room loads; migrate empty OwnerID to owner idempotently via s.save; reject unknown user IDs and multi->single with any regular accounts; verify startup mode metadata if needed.
(s *Server) serveAuth(w,r) // called outside global mutex for /api/auth and /api/auth/* /api/admin/*; own locking; hash checks outside mutex.
(s *Server) principalLocked(r *http.Request) *authUser // guest header ignored here; caller authorize handles header priority. Returns implicit owner for none, else live session user.
(s *Server) sessionKey(r *http.Request) string // hashed cookie token or empty. used for WS snapshot; hash only session map keys.
(s *Server) sessionUserLocked(key string) *authUser // live nonexpired enabled user or nil; owner special.
(s *Server) ownerEnabledLocked(ownerID string) bool
(s *Server) revokeSessionLocked(key string) // remove session; invalidate matching streams/sources via root hook below.
(s *Server) expireSessionsLocked() // invoked cleanup loop and stream checks; removes expired sessions and root hook.
authUser fields ID, Username, Role, Disabled, CreatedAt; serialized safe user response MUST NOT include hash/salt.
Root hook: (s *Server) invalidateAuthLocked(sessionKey, ownerID string) // if ownerID nonempty disable owner all streams + sources (guests included); else current session streams/sources only. Caller owns mutex.
All auth routes use same fail/writeJSON helpers; JSON body <=4096 readJSON; method errors405, forbidden403. User cap1000, session cap 4096 total/32 per-user (evict oldest for user cap) and bounded login/register rate+hash concurrency. Atomic store DATA_DIR/auth/users.json, strict schema validation. Disk failure doesn't mutate live users. Blocking owner disconnect includes sources. Logout event writes denied after expensive decode via principal recheck.

- Task1 report: /tmp/barkodd-auth-core-report.md; backend task review /tmp/barkodd-auth-backend-review.md clean (spec+quality). No commits by design.
- Root regression fixes: reject any Authorization header on WS upgrade and account mutations (including empty); HTTP never falls back to cookie for supplied bearer. Close revoked sockets with terminal401 before retiring source to preserve frontend terminal handling.
- Integration tests prove user/admin room isolation, blocked-owner guest denial, unchanged guest access after logout, source closure for WebSocket/WebRTC, and same-origin requirement in none mode.

Expected actor: account-bound frontend requests send X-BarkOdd-User captured from the displayed account. principalLocked rejects supplied actor mismatches with cookie principal; logout also guards before revocation. Missing header remains valid for direct API clients. GET auth + login/register are unbound. Creation includes ownerId; frontend checks it before retaining viewerToken. This closes shared-cookie cross-tab identity races.

- Task3 review round1: delayed room-create/auth responses and failed-storage legacy migration found; UI implementer fixing with deterministic RED→GREEN browser cases. Final review additionally covers cross-tab shared cookie: expected actor X-BarkOdd-User validated in server and captured by client, ownerId included in create response.
- Root Go1.23.4 full suite passed24.109s; full race after guest rotation passed32.619s; both Compose config --quiet checks passed. Final expected-actor focused race passed3.070s; final full-tree rerun pending.

- Task3 complete: /tmp/barkodd-auth-ui-report.md; final reviewer /tmp/barkodd-auth-final-review.md gives spec+quality PASS. Multi_user12/12, none6pass6skip, code media6/6; deterministic response-race and failed-storage migration tests were observed red then green. Expected actor cross-tab regression passes.
- Final server race suite passed33.444s, vet and51 Node tests passed. Both Compose definitions validate. Remaining: root browser RTC and subpath validation harness /tmp/barkodd-auth-final-checks.py.


## Final validation — complete

- `go test -race ./...`: PASS, server33.444s on final expected-actor code.
- `go vet ./...`, `git diff --check`, JS syntax: PASS.
- Go1.23.4 compatibility full suite: PASS (server24.109s).
- `npm test`:51 passed (9 detector,29 media,13 RTC).
- Final UI multi_user suite:12 passed; none:6 passed/6 inapplicable skipped; admin_code media/microphone:6 passed.
- Root fresh binary: WebRTC media/microphone6 passed35.3s; WebSocket+auth at `/barkodd/`:13 passed/4 inapplicable skipped39.6s; multi_user self-registration/isolation/password/block/reset at `/barkodd/`:1 passed2.9s.
- Both Compose definitions: `docker compose config --quiet` PASS.
- Backend, UI and final whole-change reviews: compliance and quality PASS; all actionable findings resolved.
- Browser artifacts/logs: `a temporary directory`; temporary servers shut down by harness. Earlier UI test servers also stopped.
- Delivered as uncommitted working changes on `codex/auth-modes`; no deployment or history-changing integration performed.

## Commit handoff — 2026-11-07

User explicitly requested commits after implementation. Changes are grouped into implementation/configuration/tests and documentation. Control checks: Go race suite, vet, Node tests, and whitespace validation. No push or deployment requested.
