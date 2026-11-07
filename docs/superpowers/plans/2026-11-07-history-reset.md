# History reset implementation plan

> **For agentic workers:** Use test-driven implementation and verification-before-completion. Backend and frontend changes have separate ownership; review the integrated result.

**Goal:** Put the last photo first on mobile and clear noisy moments manually or at a new monitoring start.

**Architecture:** Owner-only DELETE events atomically clears stored history. Persist monitoring-session identity so reconnects keep history. Guard delayed uploads and UI responses against resurrecting cleared content.

**Tech Stack:** Existing Go server, vanilla JavaScript/CSS, Node unit tests and Playwright browser checks.

**Spec:** `docs/superpowers/specs/2026-11-07-history-reset-design.md`

## Global constraints

- Preserve current uncommitted changes; no commits or deployment.
- Keep 200-event / 7-day retention and room access controls.
- New starts clear history; stops and reconnections preserve it.
- Manual clear does not stop capture or revoke links.

## Review focus

- Delayed noise/photo uploads after clear cannot resurrect old content.
- Heartbeat with the same session after server restart preserves history.
- Disk-write failures preserve previous history and session state.
- Late polling/photo fetches cannot restore cleared UI or cross room/account navigation.
- Guest viewers cannot clear; an owner in either viewing role can.

## Task 1: Server history lifecycle

Files: `internal/server/server.go`, `events.go`, new `history.go`, focused Go tests.

- [x] Add failing tests for owner clear, guest denial, photo deletion, persistence, new-start clear, same-session resume, delayed uploads and failed writes.
- [x] Implement DELETE `/api/rooms/:id/events`, persistent session/clear boundary, and safe heartbeat integration.
- [x] Verify focused tests and full Go suite including race detection.

## Task 2: UI and upload queue

Files: `web/index.html`, `web/styles.css`, `web/app.js`, `web/media.js`, browser and media tests.

- [x] Add behavioral regressions for manual clear/cancel/failure, automatic start reset and mobile photo ordering.
- [x] Move the single photo panel responsively; add owner clear action and explanatory copy.
- [x] Guard obsolete polling/photo completions and acknowledge discarded uploads without losing newer noise.
- [x] Verify Node suite and browser scenarios with isolated temporary server data.

## Task 3: Review and documentation

- [x] Independently review integrated changes, fix actionable findings.
- [x] Update README/API notes and record final verification.

Review corrections: timestamp-only clear boundaries were insufficient under clock skew; added persisted `historyVersion` handshake and tests for ahead/behind clocks. Photo dialog requests now survive unrelated history updates while still rejecting removed photos. Startup samples wait for the first healthy session handshake; manual DELETE acknowledgement immediately updates the local monitor version.

Final verification: `npm test` passed 134 tests (18 detector, 19 audio, 69 media, 28 RTC). Ten focused Go history tests and full `go test -race ./...` passed; `go vet ./...`, build, JavaScript syntax and `git diff --check` passed. Four browser scenarios passed (history lifecycle/mobile layout, delayed photo opening, noise grouping, media pause/reconnect/revocation); the two history/photo scenarios passed again against the final build after startup and local-clear fixes. Initial layout and photo-opening regressions were observed failing against earlier builds. Independent final review found no remaining actionable issues. Browser checks used isolated temporary data and synthetic camera/microphone; no deployment or commits.
