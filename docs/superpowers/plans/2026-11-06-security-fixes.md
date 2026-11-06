# Security Fixes Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans. Implement sequentially; no commits.

**Goal:** Устранить пять проблем аудита.
**Architecture:** Закрытая регистрация и подтверждение legacy TURN, строгая сессия capture, bounded event processing, изоляция очередей, host-only deletion.
**Tech Stack:** Go net/http, coder/websocket, vanilla JS; без новых зависимостей.
**Spec:** docs/superpowers/specs/2026-11-06-security-fixes-design.md

## Global Constraints

- Текущая директория, без Git-операций над home и без deployment.
- Ключ владельца не сохраняется в браузере. Существующие ссылки и данные не удалять автоматически.
- Тесты сначала; работать по очереди.

## Review Focus

- Незаданный/неверный owner key и старые анонимно созданные комнаты не выдают TURN.
- Отложенное событие старой сессии не проходит после смены источника, в том числе после decode.
- Отказ/ошибка JPEG освобождает занятый слот, не нарушает соседнюю комнату.
- Медленный зритель не отключает источник; злонамеренный зритель не остаётся подключённым после overflow.
- Удаление комнаты при активных sockets и ошибка filesystem не оставляют видимость успешного удаления.

## Tasks

1. [x] Закрыть создание/legacy TURN: server Config/auth + tests, cmd env + tests, UI creation/approval, Compose/env/README и browser fixtures. Проверить disabled/wrong/right key, legacy approval, существующую ссылку после restart.
2. [x] Остановить retired capture: media.js/tests; sessionId в events, server guards/tests. Проверить terminal WS/HTTP rejection, stale события и normal pause/resume.
3. [x] Ограничить обработку событий: отдельный этап авторизации/лимита под lock, decode вне lock, commit с повторной проверкой. Проверить bounded concurrency, cooldown, stale session, malformed JPEG и нагрузку другой комнаты.
4. [x] Изолировать WebRTC overflow: rtc.go и gated tests для злонамеренного viewer и медленного viewer.
5. [x] Убрать anonymous proxy quota и добавить безопасное удаление комнаты: server/storage, UI, tests/docs; verify viewer denied, deletion releases slot, active streams revoked, filesystem failure.
6. [x] Итоговые Go/JS/browser проверки и независимый read-only review всего diff.

## Execution ledger

- Baseline: аудит подтвердил все пять сценариев; go test -race, go vet и npm test прошли до изменений.
- Ruling: работать inline в текущем каталоге, снимок во временном каталоге; своего Git здесь нет. Subagents используются для read-only review, чтобы сохранить последовательность исправлений.

- Task 1: complete. Default-deny creation RED→GREEN; independent owner-key and legacy TURN/approval checks pass; full go test ./... green. Explicit host approval chosen instead of env allowlist. UI/browser verification remains in final integrated pass.

- Task 2: complete. RED reproduced live devices/events after403 and acceptance of missing session. GREEN: full Go suite, 29 media tests. Added browser replacement regression for final pass. HTTP403 also stops capture; session failures preserve host binding.
- Ruling: task3 delegated to event-pipeline implementer after task2 backend was green; root prepares browser regressions and docs, leaving its Go files untouched.

- Browser validation (steps1–2): owner-key rejection/no persistence and real-browser source replacement both passed in Chromium with synthetic media.

- Task 3: complete. Event RED→GREEN; full Go suite and targeted race green. 2 events/s burst3, one event per room, four photo decoders globally; parse/decode outside shared mutex; commit revalidates authority/session.
- Task 4: complete. Viewer flood RED camera disconnected→GREEN camera active, offender removed. Existing FIFO/rate and slow-viewer queue tests remain green.

- Task 5: complete. Registration no longer shares proxy IP quota; owner-auth+100-room cap remain. Host DELETE frees capacity, revokes host/viewer/pending connections; .deleted supports interrupted and failed photo cleanup. RED→GREEN deletion, capacity and recovery tests; UI confirm and binding removal verified in browser.
- Final review: independent reviewer found one Important issue: filepath.Glob hides directory read errors. Fixed with os.ReadDir; TestRoomDeletionPreservesRetryMarkerWhenPhotoDirectoryUnreadable RED (200 false success) → GREEN (202 pending, marker kept, later retry succeeds).
- Final verification: go test -race ./... PASS (server22.505s), go vet ./... PASS, npm test PASS (9 detector +29 media +13 RTC), Playwright12/12 across websocket/webrtc under /barkodd/; only synthetic camera/microphone and temporary data. Local test processes stopped.
- Final scope: no commits, pushes or production deployment. External TURN session revocation/rotation remains an operator deployment action documented in README; this task changes local application code.
- Final rulings: temporary snapshot replaces Git worktree because this directory has no own repository; explicit host+owner approval replaces a static legacy allowlist so existing QR survives without silently trusting old anonymous rooms; source events require reloaded clients with sessionId. No deferred code-review findings.
