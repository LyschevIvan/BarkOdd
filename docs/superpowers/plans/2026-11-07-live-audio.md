# Live Audio Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Independent live video and sound controls in both server transport modes.
**Architecture:** Viewer subscription mode travels in existing authenticated socket handshake. WebRTC sends requested tracks; WebSocket sends bounded PCM packets alongside existing JPEG. Separate audio playback is not gated on decoded video.
**Tech Stack:** Go, vanilla JavaScript, WebRTC, Web Audio / AudioWorklet, Playwright.
**Spec:** `docs/superpowers/specs/2026-11-07-live-audio-design.md` (approved).

## Global Constraints

- Preserve current uncommitted auth/privacy changes; work in existing `codex/auth-modes` checkout, no commits/push/deploy.
- Audio-only viewing stops video transmission to that viewer; host camera remains for snapshots.
- No recording, viewer microphone, new runtime dependencies, or changes to server-wide transport selection.
- Test with synthetic devices; retain authorization/revocation/room isolation and bounded queues.

## Shared Interfaces

- Viewer auth adds `mode: 'video' | 'audio' | 'audio-video'`; omission defaults to video. Host must omit it. Reconnect to change mode.
- Host roster retains `ids`/`count`, adds `modes: { [clientId]: mode }`, `videoCount`, `audioCount`.
- Audio packet: 3208 bytes; ASCII `BKA1` at bytes 0..3, uint32 sequence little-endian at 4..7, 1600 signed PCM16 little-endian samples at 8..3207. Mono 16000 Hz, 100 ms. JPEG remains unchanged. Separate audio limits/queues; discard stale audio.
- `createRTC` adds `mode = 'video'`, `onAudioStream(stream|null)`, `onAudioStatus(kind,message)`. Existing `onStream` remains decoded VIDEO only. Host uses roster `modes` to select tracks.
- `web/audio.js`: `encodeAudioPacket(samples,sequence)`, `decodeAudioPacket(ArrayBuffer)` returning `{samples: Float32Array, sequence}` or null; exports `AUDIO_PACKET_BYTES`, `AUDIO_SAMPLE_RATE`, `AUDIO_SAMPLES`.
- `createAudioCapture({context,source,onPacket,onError})` async returns `{setEnabled(bool), close()}`; shares source AudioContext. `createAudioPlayer({onStatus})` returns `{resume(), enqueue(ArrayBuffer), setStream(MediaStream|null), reset(), close()}`. `onStatus({kind,message})` reports blocked/error/waiting, not invented receipt of live data. Constructor/resume must be called in user gesture; buffers bound to <=500 ms; reset immediately silences all output.
- `createMonitor` adds `onAudioStatus({kind,message})`; `startViewer({mode = 'video'} = {})` replaces current viewer on mode changes; `resumeAudio()` retries browser playback. Audio stream received via RTC goes to the shared player. UI maintains independently `viewerWatching` (video requested) and `viewerListening` (audio requested).

## Review Focus

1. Quiet rooms must not be treated as disconnected: audio liveness uses packet progress, not volume (RTC/browser tests).
2. Mode changes and stale async callbacks must never restart stopped sound (media tests).
3. Revoked access must clear queued sound as well as close transport (server/player/browser tests).
4. Audio-first/video-first arrivals and frozen video must leave independent sound working (RTC tests).
5. Unsupported worklets/autoplay denial must leave video usable and expose retry/error honestly (player/media/browser tests).

## Task 1: Server subscriptions and audio relay

**Files:** `internal/server/stream.go`, new `internal/server/audio.go`, new `internal/server/audio_test.go`, relevant existing stream/RTC tests if needed.
**Interfaces:** Shared auth/roster/packet contract above; RTC signaling unchanged.
- [x] Write failing tests for three modes/default/invalid/host mode, selective JPEG/audio fanout, malformed packet rejection, independent rate limits, bounded queue and stale/revoked packet suppression.
- [x] Run targeted Go tests and observe feature failure.
- [x] Add mode validation, roster counts, audio recognition/validation/rate limiting/queue/write checks without relaxing existing controls.
- [x] Run Go suite and race tests; report results. No commits.

## Task 2: WebRTC selected tracks and audio reception

**Files:** `web/rtc.js`, `tests/rtc.test.mjs` only.
**Interfaces:** `createRTC` extension above; `onStream` remains video-only display lifecycle; independent audio callbacks.
- [x] Add failing tests for exact tracks in each mode, mixed viewers, audio arrival orders, audio liveness under silence, video freeze with audio, stale callbacks/close and no-audio regression.
- [x] Run `node tests/rtc.test.mjs` and observe new failures.
- [x] Implement selected tracks, independent audio stream/packet stats monitoring and cleanup, retaining existing video/lease recovery.
- [x] Run RTC tests and report results. No commits.

## Task 3: PCM capture and playback

**Files:** new `web/audio.js`, new `web/audio-worklet.js`, new `tests/audio.test.mjs` only.
**Interfaces:** Shared packet and capture/player exports above. Worklet URL must resolve under app subpath.
- [x] Add failing codec, resampling, bounded playback, suspended context/retry, reset/close, stale sequence tests; use actual algorithms with browser boundaries mocked only as needed.
- [x] Run `node tests/audio.test.mjs`, observe missing behavior.
- [x] Implement fixed packet codec, worklet conversion, bounded playback scheduling and stream playback through AudioContext; output host graph stays silent.
- [x] Run audio tests and report results. No commits.

## Task 4: Monitor lifecycle, interface, documentation and end-to-end behavior

**Files:** `web/media.js`, `web/app.js`, `web/index.html`, `web/styles.css`, `tests/media.test.mjs`, `tests/browser.spec.js`, new `tests/audio.spec.js`, `playwright.config.js`, `package.json`, `README.md`.
**Interfaces:** Consumes tasks 1–3; exports monitor contract above. New controls `#audio-button`, `#audio-status`, `#audio-retry`.
- [x] Add failing media/browser tests for auth mode/reconnect, audio-only/no-video traffic, combinations/switching, real audio samples, blocked retry, cleanup, snapshots and mobile layout.
- [x] Run tests to establish new behavior fails.
- [x] Integrate socket PCM/capture/player and requested channel lifecycle with guards against stale promises.
- [x] Add independent buttons/labels/status and retry; preserve host workflow and unrelated user edits. Update documentation.
- [x] Run JS + Go suites, browser tests in both transports through `/barkodd/`, inspect screenshots; fix verified failures.
- [x] Independent code review; address findings and rerun affected checks. Record actual outcomes, leave changes uncommitted.


## Verification outcome (2026-11-07)

- `npm test`: 96 passed (12 detector, 19 audio, 37 media, 28 RTC).
- `GOCACHE=/tmp/barkodd-go-cache go test -race ./...`: passed.
- Full Playwright suite through `/barkodd/`: WebSocket 19 passed / 4 multi-user-only skipped; WebRTC 19 passed / 4 multi-user-only skipped (`AUTH_MODE=admin_code`).
- Both audio browser scenarios measure fresh audible output after each transition, verify audio-only sends no video, check playback pause/retry, reconnect, snapshots, mobile width and access revocation. Screenshots inspected.
- Independent review findings fixed: automatic RTC playback-resume status and bounded worklet delivery with capture-age rejection. Browser-discovered Chromium decoder activation fixed with retained muted audio element; AudioContext remains sole audible output. Scoped re-review clean.
- Unrelated auth/privacy edits preserved. No commits, push or deployment. Local test processes stopped after verification.
