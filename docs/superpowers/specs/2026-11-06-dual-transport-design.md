# Выбор видео при настройке сервера BarkOdd

По запросу пользователя сервер должен поддерживать два варианта передачи видео: WebSocket или WebRTC. Выбор общий для экземпляра приложения, задаётся при запуске. Существующий WebSocket остаётся режимом по умолчанию. Одна UI, комнаты, ключи, QR, детектор и история в обоих вариантах.

## Подходы

- Выбор в конфигурации сервера соответствует запросу: `MEDIA_TRANSPORT=websocket|webrtc`; браузеры получают режим сервера. Это выбранное направление.
- Выбор отдельно для каждой комнаты создаёт дополнительную настройку и не нужен для поставленной задачи.
- Автоматический fallback между режимами скрывал бы фактическую настройку сети; в эту версию не входит.

## Поведение

WebSocket сохраняет JPEG до5fps через сервер, без TURN. WebRTC передаёт кодированное видео между браузерами либо через настроенный TURN. Служебный WS остаётся в обоих режимах для авторизации и управления соединениями. Только видео: звук микрофона используется локально детектором, добавление прослушивания не входит в изменение транспорта.

Смена переменной требует перезапуска сервера; актуальная страница узнаёт новый режим при WS reconnect. Ключи и данные не меняются. Неизвестный режим — ошибка конфигурации при старте. HTTPS и поддержка `/barkodd/` сохраняются. Внешний сервер не обновляем.

## Конфигурация

`Config.MediaTransport string` (`websocket` default); `STUNURLs []string`, `TURNURLs []string`, `TURNSecret`, `TURNUsername`, `TURNPassword string`.

Env: `MEDIA_TRANSPORT`, `STUN_URLS`, `TURN_URLS` (comma-separated), `TURN_SECRET` либо пара `TURN_USERNAME`/`TURN_PASSWORD`. Default STUN — `stun:stun.l.google.com:19302` только в WebRTC. URL scheme/format, частичные credentials и несовместимые auth options проверяются в WebRTC. TURN временные credentials HMAC-SHA1, TTL3600s; shared secret никогда не выдаётся браузеру. Непустой TURN URL требует credentials. WebSocket игнорирует неиспользуемые ICE-настройки.

## Общий WS-контракт

Тот же `/api/rooms/:id/stream`, auth/Origin/role/session/heartbeat/лимиты/Close сохраняются. `GET room` дополнительно `mediaTransport`. Ответ `ready` включает `{type:"ready",role,mediaTransport,clientId,iceServers}`; iceServers только WebRTC. `clientId` — случайный серверный ID этого сокета, уникальный у host и viewer.

Host получает `{type:"viewers",count,ids:[viewerClientId...],monitoring:boolean}`; viewer получает `{type:"source",online,monitoring,sourceId:hostClientId|""}`. В RTC режиме эти авторизованные состояния приходят не реже раза в секунду, даже без изменений. Клиент закрывает peers при потере WS или отсутствии состояния6s. Host удаляет peers при исчезновении viewer ID, прекращая P2P после отзыва ключа. Viewer закрывает peer при sourceId change/offline/pause. RTC identity НЕ использует streamEpoch, который меняется на обычном heartbeat.

WebSocket-mode принимает только прежние binary JPEG. WebRTC-mode принимает только text signaling:
`{type:"signal",target:clientId,connectionId:string,signal:{type:"offer"|"answer"|"candidate",sdp?:string,candidate?:RTCIceCandidateInit|null}}`.

Relay доставляет `{type:"signal",from:clientId,connectionId,signal}`; from назначает сервер. Offer только host→viewer, answer только viewer→host, candidate в обе стороны. Target только текущий противоположный участник своей комнаты; source должен быть fresh+monitoring. Старый/ушедший target тихо пропускается (нормальная гонка выхода), malformed/чужие роли — policy error. Очередь signaling ограничена64 сообщениями и256КиБ на клиента; max message64КиБ; rate limit40/s с burst80. Переполнение/зависшая запись закрывает соединение, не блокирует комнаты. Перед записью повторно проверить актуальность source/target/socket IDs и роли.

## Клиент

`createMonitor` сохраняет общий capture/detector/heartbeat/event lifecycle. Новые callbacks: `onTransport(mode)` и `onRemoteStream(MediaStream|null)`. JPEG callback `onFrame` сохранён. WS ready выбирает нужный transport при каждом reconnect. RTC-поддержка проверяется только для WebRTC, JPEG работает при отсутствующем RTCPeerConnection.

RTC helper отдельный `web/rtc.js`. Только host создаёт offers; на viewer ID один peer. Каждый offer получает новый connectionId. Кандидаты до remoteDescription временно сохраняются с пределом128; stale connectionId/async completions игнорируются. Только video tracks добавляются в peer, microphone tracks не передаются. Пауза/стоп/отзыв/потеря control lease уничтожает peers. Healthy host reconnect всегда предварён успешным heartbeat (существующее исправление сохраняется).

RTC live подтверждается поступлением декодированных кадров, не одним ICE connected. 3с без новых кадров убирают изображение, connection failure инициирует восстановление с ограниченной задержкой. По выходу/смене режима — закрыть peers, таймеры и MediaStream callbacks. В UI отдельное remote video для RTC; note отражает выбранный режим, без клиентского переключателя.

## Проверка

Go: default/invalid config, ICE auth/credentials generation, ready/state, roles/target isolation, disabled-mode rejection, limits/revocation/reconnect, прежний WS suite/race. JS: прежние19media+9noise, RTC negotiation/candidate ordering/cancel/lease/video-only и смена транспорта. Browser: оба режима через `/barkodd/`, включение/выключение, snapshots, mic pause/resume, server restart/reconnect, отзыв ключа со стороны host даже когда viewer игнорирует дальнейшие сообщения. Реальное соединение через мобильного оператора и внешний TURN нельзя заявлять проверенными локальными тестами.
