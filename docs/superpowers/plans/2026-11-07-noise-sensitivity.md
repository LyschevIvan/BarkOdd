# Noise sensitivity implementation plan

> **For agentic workers:** Use test-driven-development and verification-before-completion. Tasks use checkbox tracking.

**Goal:** Detect quieter sound and expose five clear choices.

**Architecture:** Keep numeric threshold storage and raw RMS processing. Widen the supported range consistently and map legacy thresholds to dropdown choices.

**Tech Stack:** Vanilla JavaScript, Go, existing Node and Playwright tests.

**Spec:** `docs/superpowers/specs/2026-11-07-noise-sensitivity-design.md`

## Constraints and review focus

Commit only on explicit user request; no deployment. Keep the old upper bound, existing room values, transient filter and photo throttling. Verify persistence, invalid thresholds, live sensitivity changes, legacy settings when saving only photo interval, and narrow-screen layout.

## Tasks

- [x] Server: first reproduce rejection of `0.0005` in `internal/server/server_test.go`; update API and storage bounds in `server.go` / `storage.go`, with default `0.01`; test restart persistence and rejection without mutation.
- [x] Detector: reproduce missed sustained RMS `0.002` at threshold `0.0005` in `tests/noise.test.mjs`; lower the bound in `web/noise.js`, keep transient handling and validate quiet input through the monitor in `tests/media.test.mjs`.
- [x] UI: replace the range in `web/index.html`, wire nearest-preset display and explicit selection in `web/app.js`, remove unused slider styles. Keep exact legacy values when sensitivity was not changed.
- [x] Browser: use real Web Audio with a quiet synthetic tone to check saving, live reaction, reload, all five choices and legacy settings. No real devices.
- [x] Verification: run `npm test`, `go test ./...`, Playwright suite; inspect desktop/mobile screenshots and obtain independent review of the diff.

## Verification results

`npm test`: 55 passed (12 detector, 30 media, 13 RTC). `go test ./...`: passed. Chromium browser suite in admin_code/WebSocket mode: 18 passed, 4 multi-user cases skipped by configuration. Quiet real Web Audio, all presets, reload, legacy values and delayed save passed. Desktop/mobile settings screenshots inspected; no clipping or horizontal overflow. Independent review found a save race; controls are now disabled until the request completes, with a passing regression test. No deployment.
