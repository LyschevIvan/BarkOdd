# Camera Photo Interval Implementation Plan

> **For agentic workers:** Apply test-driven development, preserve existing authorized changes, and commit/deploy only when explicitly requested.

**Goal:** Make the camera the sole owner of the user photo interval; server stores and confirms captures.

**Architecture:** One monotonic local capture timestamp. Explicit acknowledgements only clear matching queued captures; server admission uses auth, validation and technical request limits, never the configured snapshot interval.

**Tech Stack:** Existing Go server and vanilla JavaScript, node tests and Playwright.

**Spec:** `docs/superpowers/specs/2026-11-14-camera-photo-interval-design.md`

## Global Constraints

- Preserve HEAD45ab2c6 continuous-noise moments and this chat's history-clear bugfix.
- Keep auth/session/historyVersion checks, 2 requests/s burst3, decode caps and 400KiB JPEG limit.
- Keep queue bounded12 episodes/24h; no extra dependencies; commit/deploy only on explicit user request.
- Remove the superseded server schedule instead of retaining two optional implementations.

## Review Focus

- Delayed/lost/duplicate ACK must not move local capture time or delete newer JPEGs.
- Offline photos arriving close together all persist, subject only to request limits.
- Clear and in-flight stale replies must not restore deleted history or restart devices.
- Settings changes alter camera cadence; stale UI requests cannot overwrite a just-saved interval.
- JPEG validation and technical request/decode limits remain active after removing cooldown checks.

### Task 1: Server acceptance

Files: internal/server/events.go, history.go, server.go and relevant tests.

- [x] Change tests to reproduce immediate backlog acceptance, duplicate/stale-photo handling and JPEG validation independent of interval.
- [x] Remove all server scheduling state/responses/helpers; retain explicit none/accepted/duplicate/discarded acknowledgements.
- [x] Run targeted tests, full Go suite and diff check.

### Task 2: Camera timing and queue

Files: web/noise.js, web/media.js, tests/noise.test.mjs, tests/media.test.mjs.

- [x] Reproduce network-ACK independence with capture times 150,10150,20150ms; test actual settings changes and offline drain.
- [x] Remove policy synchronization and ACK timer effects; retain exact capture matching, history reset and fair bounded queue.
- [x] Run npm test and inspect all failures.

### Task 3: UI, browser and documentation

Files: web/app.js, tests/browser.spec.js, tests/microphone.spec.js, README.md, docs/design.md.

- [x] Remove unused policy plumbing; protect new settings from a delayed previous poll.
- [x] Reproduce delayed-response capture drift and upload backlog waiting against prior binary, then verify fixed behavior in real browser with synthetic devices.
- [x] Verify continuous photos, history clearing, settings and live sound; independently review diff.
- [x] Record final verification and report local-only result.

## Progress

- User approved camera-only timing on 2026-11-14; it supersedes the server-policy design prepared earlier in this chat.
- Continuing in current feature branch with authorized uncommitted work; no history-changing git commands.

- Complete: camera-only capture timing; server accepts/deduplicates valid uploads without snapshot-interval admission; old scheduling fields/helpers/plumbing removed. Exact capture ACKs, fair bounded queue and history-clear reset retained.
- RED→GREEN: changed server acceptance/validation cases and four media timing regressions failed before simplification. Browser upload-backlog test failed on the previous binary (about10s added between uploads) and passed on the final one (under3s). Delayed room poll test failed by losing a short sound, then passed after invalidating pre-save polls. Delayed-response cadence already passed on the previous policy binary and remains a regression check.
- Final validation: npm test157/157 (20 detector,27 audio,82 media,28 RTC); full Go suite passed; go vet passed; 11 targeted browser cases passed; git diff --check passed.
- Browser cases cover response/upload delays, continued noise, both history-clear routes, photo deduplication/display stability, noise grouping, saved settings/stale polls and live sound during clear.
- Independent read-only review: no actionable findings. Proposed empty-JPEG retention race was checked and withdrawn because7d retention versus24h timestamp admission, reservation and history checks make that scenario unreachable under supported inputs.
- Temporary test server stopped. Implementation was completed locally; user subsequently explicitly requested a commit and deployment.

- Release preparation: fresh `npm test`157/157 and uncached full Go suite passed; staged scope reviewed and no unrelated files found.
