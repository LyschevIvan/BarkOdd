# Видео через сервер без WebRTC

Пользователь согласовал JPEG-кадры через WebSocket вместо WebRTC. Реализуем 5 кадров/с, без прямого звука; детектор шума, события/снимки, комнаты и QR сохраняются. Не менять существующую поддержку размещения в `/barkodd/`, недоступного/заглушённого микрофона и сохранённые комнаты. Источник — ноутбук с открытой страницей; камера по-прежнему требует HTTPS или localhost.

## Протокол между клиентом и сервером

- Один endpoint `GET /api/rooms/:id/stream` с upgrade в WebSocket. Проверять Origin (origin PUBLIC_URL, либо same-host для локального запуска), не доверять произвольному Origin. Upgrade должен обходить JSON buffering и глобальную блокировку HTTP handler.
- После открытия клиент в течение 5 с отправляет JSON `{type:"auth",role:"host"|"viewer",token,sessionId?}`. Ключ только в первом сообщении, не в URL. Для host обязателен sessionId текущего запуска камеры; роли должны соответствовать токену. До авторизации никаких кадров и состояния комнаты.
- Сервер отвечает `{type:"ready",role}`; host получает `{type:"viewers",count:N}` сразу и при подключении/уходе зрителей. Viewer получает `{type:"source",online:boolean,monitoring:boolean}` при подключении и изменениях состояния источника (допустима периодическая отправка ≤2 с).
- Сервер при ошибке по возможности посылает `{type:"error",status:401|403|400|...,message}` и закрывает соединение. Auth/revoked key — close code1008, normal stop1000; transient shutdown1012/1013 допустимы.
- Host отправляет binary raw JPEG, сервер пересылает binary raw JPEG всем авторизованным зрителям этой комнаты. Viewer не может публиковать binary. На комнату один источник; новый корректный sessionId заменяет старый. Старые retired sessions отвергать. Не доставлять кадры неактивного/неактуального источника (heartbeat/sessionId).
- Не более 200 KiB/frame, максимум 1280x1280 и 1280*720 pixels, валидный JPEG header. Ограничить приём около 5 fps (допускается небольшой jitter), число клиентов (1 host + 6 viewers/room), ожидающих auth и все очереди. Slow viewer не блокирует host, соседние комнаты или быстрых viewers: очередь только последнего кадра, write deadline порядка2с, закрытие зависшего соединения. No socket I/O under global room mutex.
- Без viewers источник не кодирует и не отправляет live-кадры. Сервер не хранит video-кадры на диске и не отдаёт старый кадр новому зрителю.
- Отзыв ключа немедленно закрывает старые viewer-сокеты на стороне сервера. Check hash/version + room/session validity перед fanout/записью. Server.Close закрывает hijacked соединения и освобождает goroutines. Heartbeat stopped:true окончательно закрывает source; временный monitoring:false допускает восстановление той же сессии.
- Keepalive сервера с ping/pong и deadlines; клиент reconnect 0.5–5с с ограниченным backoff. Viewer убирает застывший кадр через 3с без новых кадров. Ошибки auth прекращают retry и показывают понятное сообщение.

## Клиентский интерфейс для независимых модулей

`roomAPI` дополнительно отдаёт `streamURL` (ws/wss URL, созданный относительно APP_BASE с сохранением `/barkodd/`) и `token`. Методы get/post/put/blob остаются прежними.

`createMonitor({api,onStatus,onLevel,onLocalStream,onFrame,onError})`:
- callbacks прежние, кроме `onRemoteStream` заменяется на `onFrame(Blob|null)` для viewer;
- startHost/startViewer/stopHost/stopViewer/updateSettings/destroy остаются;
- host локальный preview использует MediaStream; viewer `<img id="live-frame">`, не video/MediaStream;
- кадры source 5fps, longest side960, JPEG quality0.65 (понижать при необходимости), max200KiB. Предыдущая кодировка должна завершиться прежде следующей, bufferedAmount ограничен; старые кадры пропускать;
- шумовая камера/микрофон и heartbeat продолжаются без просмотра; очередь событий и детектор сохраняются. Захват кадров только при count>0 и доступных media. Свой canvas для live, не конфликтующий со snapshot canvas.
- отсутствие прямого звука отражено в UI; убрать неработающую кнопку mute, текст «послушать» и обещания живого звука.

## Выполнение и проверки

- [x] Backend: новый WS relay, auth/role/origin/frame limits, pressure, revocation/lifecycle tests red→green; удалить ICE/signaling/TURN runtime API/config, сохранить QR и предыдущие room/mic regressions.
- [x] Media: заменить RTC на WS, сохранить microphone fixes; JS tests red→green для без-viewers, delivery/reconnect/stop, frame bounds/backpressure. Никаких RTCPeerConnection или /signals /ice.
- [x] UI: `<img>` viewer с bounded blob URL lifecycle, корректный статус/старый кадр, убрать живой звук, сохранить subpath.
- [x] Root: убрать TURN из cmd/env/Compose, переписать документацию; HTTPS/WSS используют существующий443. Подготовить upgrade без удаления volume/комнат.
- [x] Browser: RTCPeerConnection намеренно disabled, реальные fake media→JPEG через WS; кадры меняются; stop viewer прекращает upload; offline/resume, source pause, key revocation, snapshots, `/barkodd/` prefix и microphone regression. Go race/vet/build, JS, Docker.

Работа в текущем каталоге (собственного git repo нет), без коммитов. Существующее внешнее размещение описано в README, но live deployment и остановка его TURN не выполняются без согласованного отдельного действия. Финальная локальная версия должна быть проверена и готова к обновлению сервера.

## Результат проверки

- `go test -race ./...`, `go vet ./...`, сборка Go и Docker прошли.
- JS: 9 тестов детектора и 19 медиамодуля.
- Playwright: 3 сценария прошли через `/barkodd/`, `RTCPeerConnection` выключен для просмотра.
- Дополнительно проверен перезапуск отдельного реального Go-процесса после простоя >15 секунд: источник и зритель подключились автоматически, сохранённая комната и ключи работают.
- Независимый review обнаружил и помог закрыть восстановление host-сессии после рестарта и старт с временно недоступным микрофоном; оставшихся блокирующих замечаний нет.
- Docker smoke: healthz и embedded WS-клиент доступны. Локальный предпросмотр на 127.0.0.1:8080 обновлён. Внешний Mac mini не обновлялся; инструкция готова в README.
