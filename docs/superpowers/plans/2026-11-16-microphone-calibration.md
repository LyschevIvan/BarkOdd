# Microphone-only Calibration Implementation Plan

> Execute in the existing checkout. Independent media lifecycle and browser test work is delegated; root owns UI, integration, verification and release.

**Goal:** Calibrate with only a microphone before observation, preserving history and keeping the existing live-host path.

**Spec:** ../specs/2026-11-16-microphone-calibration-design.md

**Architecture:** createMonitor owns a temporary microphone session with synchronous acceptance and asynchronous permission acquisition. No host session or network side effects are created. UI observes starting/calibrating/terminal state and presents the draft as before.

## Tasks

- [x] Media lifecycle: tests first, then extend startCalibration({audioDeviceId}) and resource cleanup, keep active-host reuse. Stop/destroy/startHost must cancel pending standalone acquisition. Test late resolve, errors, interruptions and no heartbeat/events/video.
- [x] UI: enable calibration before capture, show live meter during standalone sampling, lock conflicting controls during request/measurement, update explanatory copy and guide. Preserve saving and generation guards.
- [x] Browser verification: denied camera with working microphone, standalone result/save/reload, pending cancel/late permission, microphone denial/retry, unchanged history, existing active-host regressions.
- [x] Review and release preparation: npm suite, Go checks, relevant browser suite, independent review and a rollback backup. Commit the verified result and deploy that exact revision to Mac mini; verify public assets afterwards.

## Decisions

The current user correction clarifies the behavior of the same feature; the preceding explicit commit/deployment authorization remains in force. No new dependencies, backend/storage changes or always-on microphone preview.


## Verification

- Media TDD: 17 new standalone cases fail before implementation, then 106 media tests pass. Full npm suite: 204 passing tests.
- Browser TDD: initial standalone test fails on the disabled pre-observation button; final nine scenarios pass (45.5s) using synthetic media against local WebRTC. Existing history remains byte-for-byte unchanged; no capture heartbeat/event requests are made.
- Go race tests, go vet, JavaScript syntax and git diff --check pass. Independent review found no actionable issues. Mobile screenshot inspected at375px.
- Test correction: standalone duration is asserted using performance.now, the detector's clock, instead of a separately initialized synthetic AudioContext clock. Production duration remains5seconds.
- Current Mac mini source, image ID, volume identity and TURN state were backed up before the authorized release.
