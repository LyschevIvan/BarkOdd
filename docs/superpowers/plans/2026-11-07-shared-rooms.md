# Shared rooms implementation plan

> **For agentic workers:** Use superpowers:subagent-driven-development for implementation and independent review. Local commits authorized by the user's follow-up; no push or deployment.

**Goal:** Общая комната с несколькими равноправными хозяевами и независимыми камерами.

**Architecture:** Группа владеет членством, существующие room являются камерами.
Медиатранспорты и адреса камер сохраняются. UI группирует камеры в комнаты.

**Tech Stack:** Existing Go server, JSON storage, vanilla JS, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-07-shared-rooms-design.md`.

## Global Constraints

- Работать в текущей ветке codex/auth-modes; исходное дерево чистое.
- Локальные коммиты разрешены отдельным запросом пользователя после проверки.
  Без push, новых зависимостей и развёртывания.
- Сохранять старые ссылки, историю и оба медиатранспорта.
- Все права проверяются сервером; новый админский доступ не вводится.
- Камеры независимы; последний хозяин комнаты не удаляется.

## Review Focus

- Удалённый хозяин с уже открытыми HTTP/WS запросами теряет доступ.
- Блокировка одного хозяина не останавливает камеры остальных.
- Ошибка записи/перезапуск не воскрешает удалённую группу и не теряет историю.
- Медленные ответы после переключения аккаунта не показывают чужие камеры.
- Гость и посторонний аккаунт не могут менять участников и камеры.

### Task 1: Groups, migration and authorization

**Files:** internal/server/groups.go (new), groups_test.go (new), server.go,
owner.go, auth.go, auth_storage.go, stream.go, deletion.go, storage.go as needed.

**Interfaces:** implement the exact HTTP contract in the spec; existing media
API keeps camera IDs and payloads. Frontend depends only on these HTTP fields.

- [x] Write tests for group creation, sharing, two independent cameras, outsider
  rejection, removal, last-member protection and migration; observe failures.
- [x] Add durable group storage and shared authorization used by HTTP/WS/events.
- [x] Check restart, failed writes, blocking, active source revocation and guest
  access; implement deletion and preserve existing behavior for single owners.
- [x] Run Go suite, report tests and any limitations for integration review.

### Task 2: Shared room interface

**Files:** web/app.js, web/index.html, web/styles.css; optional focused web module.

**Interfaces:** consumes Task 1 group API. Preserve existing camera dashboard
and role controls/IDs so existing flows and browser tests remain valid.

- [x] Build rooms with named camera entries and add-camera action.
- [x] Add member list and add/remove owner controls for multi_user.
- [x] Add camera switching in viewer dashboard and room creation with initial
  camera. Keep guest viewing restricted to one camera.
- [x] Preserve auth/navigation race guards, capture cleanup and mobile layout.
- [x] Validate with integration tests from Task 3 and existing browser tests.

### Task 3: Integration and review

**Files:** tests/shared-rooms.spec.js (new), playwright.config.js, README.md.

- [x] Add browser tests for two owners/two sources, viewing and membership
  revocation; run before implementation to confirm missing behavior.
- [x] Document rooms, cameras, owner sharing, migration and guest scope.
- [x] Run go test -race ./..., npm test, browser suites with both transports.
- [x] Review changed code independently, fix findings, verify resulting diff.

## Progress and rulings

- 2026-11-07: scenario confirmed by user; proceed with local implementation.
- Existing feature branch is used; no git-history mutations.
- Server and frontend are independent behind the written HTTP contract and may
  be implemented in parallel; integration tests and review remain separate.


## Verification results

- Initial server and browser tests failed before the corresponding feature was
  implemented; existing Go/JS baseline passed.
- Final `GOCACHE=/tmp/barkodd-shared-go-cache go test -race ./... -count=1`:
  passed, server package 49.731 s. `go vet ./...` and build passed.
- `npm test`: 134 JS cases passed; syntax and `git diff --check` passed.
- Complete multi_user browser suite through `/barkodd/`: WebSocket 28/28,
  WebRTC 28/28. The latter used the final server build.
- After final invalidation consolidation, WebSocket auth 12/12 and shared-room
  scenario 1/1 passed against the final build on fresh servers. Their combined
  shortened invocation initially hit the existing 5 registrations/min/IP limit;
  restarting with fresh test data/state resolved the setup failure without
  modifying production limits.
- Existing auth suite: none 6 passed / 6 mode skips; admin_code 8 passed / 4 mode
  skips. Both used isolated data. Desktop and 390 px mobile shared-room layouts
  visually inspected; no horizontal overflow.
- Independent review and scoped review of final backend changes found no
  actionable defects. Added coverage for in-flight event revocation and partial
  legacy migration. Temporary servers/proxy stopped.
- No deployment, dependency changes or production-data changes. Local commits
  authorized by the user's subsequent request after implementation verification.

## Implementation details

- An empty group is supported: deleting its last camera retains the group and
  its members. Interrupted legacy POST creation can likewise leave an empty
  group if the process exits between group and camera disk writes; ordinary
  failed camera writes roll the group back.
- Existing guest links remain independent of account membership. The interface
  explains reissuing links when that access also needs revocation.
