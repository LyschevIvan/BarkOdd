# Event Interval and Photo Reliability Implementation Plan

> **For agentic workers:** Use test-driven-development and verification-before-completion. Keep changes uncommitted.

**Goal:** Prevent alternating empty cards within the photo interval while retaining legitimate photo-less events.

**Architecture:** Group noise bursts within the interval in the client detector. Confirm capture only after JPEG success and retain uploads until the server acknowledges photoAt.

**Tech Stack:** Existing JavaScript browser app, Node tests, Playwright, Go server.

**Spec:** `docs/superpowers/specs/2026-11-07-photo-history-design.md`

## Global Constraints

- Preserve photo-less history when a camera is unavailable, stored data and server API/rate limits.
- Keep continuous noise grouping and real-time last-noise updates.
- Work in current checkout without commits, push or deployment.

## Review Focus

- Five seconds of silence alone must not create an empty card during cooldown.
- The episode interval applies even when no photo has ever succeeded.
- Unavailable camera or encoding error must not consume a successful-photo interval.
- HTTP 200 without photo acceptance must not discard a JPEG or newer noise updates.
- Confirmation and concurrent newer JPEGs must preserve global cooldown and pending work.

## Task 1: Capture and upload retry

- [x] Reproduce unready camera and encoding failure in detector/media tests.
- [x] Confirm capture in `web/media.js` only after JPEG success using `web/noise.js`.
- [x] Reproduce HTTP 200 photo rejection, retain unacknowledged JPEG and synchronize cooldown after acceptance; cover concurrent updates.
- [x] Run `npm test` (13 detector, 19 audio, 50 media, 28 RTC passed).

## Task 2: Group noise within interval

- [x] Add failing detector/media tests for bursts inside the interval, a later eligible burst and no-camera history.
- [x] Gate new episode IDs by quiet time plus elapsed interval from the latest episode/capture/acknowledgement.
- [x] Run `npm test`, update README and detector contract documentation (18 detector, 19 audio, 52 media, 28 RTC passed).

## Final verification

- [x] Run existing browser end-to-end capture test and Go tests; inspect diff and obtain independent review.

Validation: `npm test` passed all 117 tests. `GOCACHE=/private/tmp/barkodd-go-build go test ./...` passed outside the sandbox (HTTP/WebSocket test listeners require local ports). Browser tests `noise bursts within` and `on-demand video, photos` passed, 2/2, against the updated local server. `git diff --check` passed. No commit or deployment performed.

## Review record

Independent review found a delayed-photo acknowledgement race during silence: clearing the episode before the reply could produce a new empty card inside the extended interval. Reproduced in detector and monitor tests, then fixed by evaluating the new episode only when the next noise burst qualifies. Full unit suite passes after the fix.

Real-browser regression reproduced the original problem against the earlier embedded app: the second synthetic burst produced two events, one without a photo. The same regression passes against the updated app: one photographed event with an updated last-noise time.
