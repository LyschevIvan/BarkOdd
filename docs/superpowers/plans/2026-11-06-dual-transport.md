# Dual transport implementation plan

> **For agentic workers:** use superpowers:subagent-driven-development for separated server and media tasks; root owns UI/deployment integration and real-browser verification.

**Goal:** selectable WebSocket/WebRTC transport at server setup.
**Architecture:** shared authenticated WS carries JPEG or RTC signaling; shared room/device/event lifecycle; default websocket.
**Tech Stack:** existing Go1.23/coder-websocket/vanilla JS; browser RTCPeerConnection.
**Spec:** docs/superpowers/specs/2026-11-06-dual-transport-design.md

## Global constraints

No commits, no external deployment. Current directory has no own Git repo; preserve existing files and data. Keep prefix support, auth, bounded resources, microphone fixes. One server-wide mode; no automatic fallback; video-only RTC. User's request to add both server options is the scope; routine implementation choices follow the spec without additional approval checkpoints.

## Review focus

- Revocation must stop host P2P output even if viewer ignores control messages.
- Restart/stale heartbeat cannot turn transient disconnect into permanent auth failure.
- RTC async completions and ICE candidates cannot revive replaced/stopped peer.
- Modes must not accidentally enable both media paths or send audio.
- Config errors, missing TURN and physical network limits must be reported accurately.

## Task1: Backend (independent)

Files internal/server/{server,stream,rtc,rtc_test,stream_test}.go; configuration tests.
Interfaces exactly as spec: Config fields, roomState mediaTransport, ready/clientIds, source/viewer state, signal relay.

- [x] Add red tests for default/invalid mode, metadata/ICE and signaling delivery/isolation/mode rejection.
- [x] Implement validated config/ICE credentials and authenticated bounded relay. Keep JPEG defaults and all old tests.
- [x] Test roster/lease/revocation, stale host session, queue/rate bounds; run Go race/vet.

## Task2: Browser media (independent, protocol from spec)

Files web/media.js, web/rtc.js, tests/media.test.mjs, tests/rtc.test.mjs. New rtc helper internal interface chosen by implementer, public createMonitor callbacks per spec. Root will add rtc.test to package script if created.

- [x] Add failing transport/RTC lifecycle tests, preserve19media/9noise tests.
- [x] Implement video-only RTC negotiation, bounded candidate queue, host roster/lease, source pause/reconnect, stale-frame handling and generation cancellation.
- [x] Select mode from ready; preserve WS no-RTC environment and heartbeat-before-reconnect. Run JS suite.

## Task3: Root UI/config/deploy

Files cmd/barkodd/main{,_test}.go, web/app.js/index.html/styles.css, .env.example, compose.yaml, deploy/compose.macmini.example.yaml, README.md/docs/design.md, tests/browser.spec.js/playwright.config.js.

- [x] Add failing cmd config and dual browser acceptance checks.
- [x] Parse env into validated Config; wire both Compose variants, document optional existing/self-host TURN and restart without data removal.
- [x] Display incoming RTC video and transport note; clear streams on mode change/stop/navigation. Keep JPEG view.
- [x] Browser test each mode including prefix, snapshots, mic pause, revocation with uncooperative viewer, and restart; default WS with RTC disabled.

## Task4: Review and completion

- [x] Independent review server/media/config/privacy/lifecycle; repair concrete findings.
- [x] Go race/vet, JS, both browser modes, Docker build/smoke. Update local8080 preview only; report actual validation scope.

## Verified outcome

Go race/vet pass; 9 noise +26 media +13 RTC tests pass. Browser acceptance: 3 tests for WebSocket with RTC absent, 3 for real WebRTC, both through /barkodd/. Real server restart after >15s and setting switches RTC→WS→RTC recover without page reload, preserving room/key. Independent review found expired TURN credentials on long-lived host; fixed45min renewal with regression, scoped review clean. Docker image built and both modes smoke-tested. Local8080 preview updated with default WebSocket; external server unchanged.

No commits. No external TURN/mobile-network validation claimed. Temporary test processes/containers stopped.
