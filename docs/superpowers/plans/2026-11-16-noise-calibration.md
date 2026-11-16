# Noise Calibration Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans; independent algorithm work and final review may be delegated. The follow-up authorizes the root agent to commit and deploy to Mac mini.

**Goal:** Add explicit background calibration, fine threshold adjustment, and an accurate threshold marker.

**Architecture:** A pure calibration module calculates a robust threshold. The camera monitor owns calibration lifecycle and suppresses new detections during sampling. UI edits a draft threshold and persists the exact value using the existing settings API.

**Tech Stack:** Existing Go server, vanilla JavaScript/CSS, Node assertions and Playwright.

**Spec:** ../specs/2026-11-16-noise-calibration-design.md

## Global Constraints

- Preserve API/storage, photo interval scheduling, queued events and old exact thresholds.
- No new dependencies. Work in the existing feature checkout; the root agent handles the explicitly authorized commit and Mac mini deployment after verification.
- Calibration is 5000 ms; sample gaps >1000 ms fail; ≥75 valid samples required; threshold is p90 × 2 clamped to 0.0005…0.5, with zero signal/insufficient headroom rejected.
- Save is explicit; cancellation/errors cannot change existing or draft settings.

## Review Focus

- Stop/restart, room change and stale callbacks must never apply an old calibration.
- Muted/unavailable/suspended microphone and hidden tab must cancel without fake silence samples.
- Settings save failure and polling must preserve draft values and the active threshold marker.
- Continuous real noise must retain existing event/photo timing outside calibration.
- Exact custom threshold survives reload and saving only photo interval; mobile controls fit.

### Task 1: Calibration math and scale helpers

**Files:** Create web/calibration.js and tests/calibration.test.mjs; extend package.json test script.
**Interfaces:** `NoiseCalibration(startedAt).add(level, now)` returns `{kind:'calibrating', remainingMs, progress}` or `{kind:'complete', noiseFloor, threshold}` or `{kind:'error', message}`. Export `CALIBRATION_DURATION_MS`, `thresholdToSlider(threshold)`, `sliderToThreshold(value)`, `levelPosition(level)`, `formatLevel(level)`.

- [x] Write/run failing tests for stable low background, isolated peaks, invalid/zero samples, sparse sampling, long gaps, excessive background, and terminal states.
- [x] Implement bounded robust estimator and logarithmic slider (0…100, maps 0.0005…0.5) / meter (-80…0 dBFS, positions 0…100) with precise Russian percentage formatting.
- [x] Verify unit suite; no side effects or browser dependencies.

### Task 2: Camera lifecycle and settings UI

**Files:** web/media.js, web/app.js, web/index.html, web/styles.css, tests/media.test.mjs, tests/microphone.spec.js.
**Interfaces:** `createMonitor` accepts `onCalibration` and `onInputStatus({available, message})`; returns `startCalibration()` and `cancelCalibration()`. Callback kinds: calibrating/complete/error/cancelled; start returns false if host cannot sample. Preserve source/history and detector timestamps.

- [x] Add failing integration tests for sample completion, event suppression, capture continuity and cancellation/error paths.
- [x] Implement monitor lifecycle; reuse pure estimator, cancel on invalid input/stop/hidden document; return complete threshold without auto-applying it.
- [x] Add browser tests for draft calibration, manual correction, active/draft marker, custom persistence, failure/cancel, mobile layout.
- [x] Implement controls and draft threshold handling, accurate meter, save lock and stale response guards.
- [x] Run integration/browser tests with synthetic media, inspect desktop/mobile screenshots.

### Task 3: Verification and guidance

**Files:** docs/guide.md, this plan.

- [x] Document calibration steps and recalibration conditions.
- [x] Run npm test, Go race tests/vet, targeted microphone browser suite and relevant UI regressions.
- [x] Independent diff review; fix relevant findings and rerun affected checks.
- [x] Record verification and report local completion without implying server deployment or real-microphone verification.

## Progress

Design follows the user's selected approach. Routine details above are implementation decisions. Current checkout is clean on codex/auth-modes; editing in place avoids a redundant worktree and preserves the user's working context.


Task 1 complete: pure estimator/helpers, 23 passing tests after failing-first checks.

Task 2 complete: explicit sampling lifecycle, exact drafts, active/draft markers, persistence and mobile layout. UI TDD red reproduced missing range; original five browser tests pass.

Task 3 complete (initial 12-second version): npm test passes 187 tests (20 detector, 23 calibration, 27 audio, 89 media, 28 RTC); Go race and vet pass. Existing browser/microphone suite: 20 pass, 1 auth-only test skipped in AUTH_MODE=none. Final calibration browser suite: 6 passed in 52.7s, including local microphone recovery while heartbeat fails. Desktop/mobile screenshots inspected; no overflow at 375px.

Review finding fixed: generic server/media status must not control local calibration readiness. New onInputStatus callback reports local input health independently; mute→unmute while heartbeat503 has failing-then-passing media and browser coverage. Reviewer confirmed fix.

Ruling: photo deadline test allows the existing one-second noise update window after calibration cancellation; fixed timestamp equality incorrectly assumed the update phase never changes. Restart fixture reopens its synthetic tracks to represent a new getUserMedia stream; no production bypass.

Environment: initial sandbox Go run could not bind httptest ports; reran race suite with local-network permission. Browser tests use installed /opt/homebrew/bin/node because default Node14 is too old for Playwright. The initial 12-second implementation was verified without a production deployment or commit.

Follow-up (2026-11-16): the user requested a shorter calibration and explicitly authorized a commit and Mac mini rollout, superseding the initial no-commit/no-deployment scope. The final duration is 5 seconds with at least 75 valid samples; the 1000ms maximum gap and p90 × 2 estimator remain unchanged. Duration-related unit and media tests failed first on the 12-second implementation (13 calibration and 6 media failures), then all 187 npm tests passed after the change. The 74/75-sample boundary is covered; browser timing checks and user-facing copy now use 5 seconds. The root agent performs browser verification, commit and rollout separately.

Release verification for the 5-second version: npm test — 187 passed; go test -race ./... and go vet ./... — passed; calibration Playwright suite against a local WebRTC server — 6 passed in 38.8s. The browser assertion permits delivery of pre-calibration queued events, checking their detection timestamps rather than requiring server state to remain identical. Independent duration review found no issues. Mac mini's source and current image ID were backed up before the authorized release.
