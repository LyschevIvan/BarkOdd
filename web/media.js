import { NoiseDetector } from './noise.js';
import { NoiseCalibration, CALIBRATION_DURATION_MS } from './calibration.js';
import { createRTC } from './rtc.js';
import { createAudioCapture, createAudioPlayer, AUDIO_PACKET_BYTES } from './audio.js';

const noop = () => {};
const now = () => performance.now();
const uuid = () => globalThis.crypto?.randomUUID?.() || `client-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
const cancelled = () => Object.assign(new Error('Наблюдение остановлено'), { cancelled: true });
const MAX_FRAME_BYTES = 200 * 1024;
const TURN_REFRESH_MS = 45 * 60 * 1000;

export function createMonitor({ api, onStatus = noop, onAudioStatus = noop, onLevel = noop, onInputStatus = noop, onCalibration = noop, onLocalStream = noop, onFrame = noop, onTransport = noop, onRemoteStream = noop, onError = noop }) {
  let host = null;
  let calibrationPreview = null;
  let viewer = null;
  let destroyed = false;
  let lastStatus = '';
  let currentFrame = null;
  const errors = new Map();
  const wantsAudio = state => state.mode === 'audio' || state.mode === 'audio-video';
  const wantsVideo = state => state.mode !== 'audio';

  function audioStatus(state, kind, message) {
    if (!state.active || !wantsAudio(state)) return;
    if (state.outputBlocked && kind !== 'blocked' && kind !== 'error') return;
    emit(onAudioStatus, { kind, message });
  }

  function clearAudio(state) {
    state.audioRevision = (state.audioRevision || 0) + 1;
    cancelTimer(state, state.audioTimer);
    state.audioReceived = false;
    state.player?.reset();
    audioStatus(state, 'connecting', 'Ожидаем звук с устройства питомца…');
  }

  function emit(callback, value) {
    // A rendering error must not stop microphone processing or leave devices open.
    try { callback(value); } catch (error) { console.error(error); }
  }

  function status(kind, message) {
    const key = `${kind}:${message}`;
    if (lastStatus === key || destroyed) return;
    lastStatus = key;
    emit(onStatus, { kind, message });
  }

  function report(error) {
    if (error?.cancelled || destroyed) return;
    error = error instanceof Error ? error : new Error(String(error));
    const previous = errors.get(error.message) ?? -Infinity;
    if (now() - previous < 10000) return;
    if (errors.size >= 20) errors.delete(errors.keys().next().value);
    errors.set(error.message, now());
    emit(onError, error);
  }

  function frame(blob) {
    if (currentFrame === blob) return;
    currentFrame = blob;
    emit(onFrame, blob);
  }

  function session() {
    return { active: true, timers: new Set(), requests: new Set(), socket: null, ready: false, viewers: 0, audioViewers: 0, retryDelay: 500, authFailed: false };
  }

  function later(state, delay, callback) {
    if (!state.active) return;
    const timer = setTimeout(() => {
      state.timers.delete(timer);
      if (state.active) callback();
    }, delay);
    state.timers.add(timer);
    return timer;
  }

  function cancelTimer(state, timer) {
    clearTimeout(timer);
    state.timers.delete(timer);
  }

  function request(state, method, path, body) {
    if (!state.active) return Promise.reject(cancelled());
    return new Promise((resolve, reject) => {
      let complete = false;
      const finish = (error, value) => {
        if (complete) return;
        complete = true;
        clearTimeout(timer);
        state.requests.delete(abort);
        error ? reject(error) : resolve(value);
      };
      const abort = () => finish(cancelled());
      const timer = setTimeout(() => finish(new Error('Сервер не отвечает. Повторяем подключение.')), 12000);
      state.requests.add(abort);
      Promise.resolve().then(() => {
        if (!state.active) throw cancelled();
        return api[method](path, body);
      }).then(value => finish(null, value), finish);
    });
  }

  function loop(state, delay, task, failure = report) {
    const tick = async () => {
      if (!state.active) return;
      try { await task(); } catch (error) { if (state.active) failure(error); }
      finally { later(state, delay, tick); }
    };
    void tick();
  }

  function closeSocket(state) {
    const socket = state.socket;
    state.socket = null;
    state.ready = false;
    state.viewers = 0;
    state.audioViewers = 0;
    state.capture?.setEnabled(false);
    if (state.role === 'viewer') clearAudio(state);
    state.rtc?.close();
    state.rtc = null;
    state.remoteStream = null;
    cancelTimer(state, state.connectTimer);
    cancelTimer(state, state.iceRefreshTimer);
    if (!socket) return;
    socket.onopen = null;
    socket.onmessage = null;
    socket.onerror = null;
    socket.onclose = null;
    socket.close(1000);
  }

  function stopSession(state) {
    if (!state) return;
    state.active = false;
    for (const timer of state.timers) clearTimeout(timer);
    state.timers.clear();
    for (const abort of [...state.requests]) abort();
    closeSocket(state);
  }

  function clearFrame(state) {
    cancelTimer(state, state.frameTimer);
    frame(null);
  }

  function accessDenied(state, message, code = 403) {
    if (state.authFailed) return;
    state.authFailed = true;
    closeSocket(state);
    if (state.role === 'viewer') clearFrame(state);
    else void stopHost();
    const error = new Error(message || 'Доступ к трансляции закрыт. Откройте новую ссылку с устройства питомца.');
    error.status = code;
    error.sessionEnded = state.role === 'host' && (code === 403 || code === 409);
    status('error', error.message);
    report(error);
  }

  function hostRequestFailed(state, error) {
    if ([401, 403, 404, 409].includes(error.status)) { accessDenied(state, error.message, error.status); return; }
    report(error);
    status('offline', 'Нет связи с сервером. Камера и обнаружение звука продолжают работать.');
  }

  function applyHistoryVersion(state, version, initialHeartbeat = false) {
    if (!Number.isSafeInteger(version) || version < 0) return;
    if (state.historyVersion !== undefined && version <= state.historyVersion) return;
    // Samples captured before the first healthy heartbeat belong to the new session.
    // Every subsequent history version invalidates all queued noise and photos.
    if (initialHeartbeat) {
      for (const entry of state.events.values()) entry.noise.historyVersion = version;
    } else {
      state.events.clear();
      // The deleted photo must not delay the first sound's photo in the new
      // history. Keep the settings and running media, start a fresh episode.
      state.detector = new NoiseDetector(state.detector);
    }
    state.historyVersion = version;
  }

  async function refreshHost(state) {
    const monitoring = healthySource(state);
    const saved = await request(state, 'post', '/heartbeat', { monitoring, sessionId: state.sessionId });
    if (!state.active) return;
    if (monitoring || state.sessionEstablished) {
      applyHistoryVersion(state, saved?.historyVersion, monitoring && !state.sessionEstablished);
    }
    if (monitoring) state.sessionEstablished = true;
    // Restarts forget server-side session state, and a pause heartbeat cannot
    // establish a replacement session. Authenticate only after a healthy
    // heartbeat; an already connected socket may remain during a pause.
    if (monitoring && healthySource(state)) connectSocket(state);
    if (state.ready && !state.transportError && monitoring && healthySource(state)) status('monitoring', 'Наблюдение работает. Оставьте эту вкладку открытой.');
  }

  function retrySocket(state) {
    if (!state.active || state.authFailed || state.reconnectTimer) return;
    const delay = state.retryDelay;
    state.retryDelay = Math.min(5000, state.retryDelay * 2);
    state.reconnectTimer = later(state, delay, () => {
      state.reconnectTimer = null;
      if (state.role === 'viewer') connectSocket(state);
      else void refreshHost(state).catch(error => {
        if (!state.active) return;
        if ([401, 403, 404, 409].includes(error.status)) hostRequestFailed(state, error);
        else { report(error); retrySocket(state); }
      });
    });
  }

  function connectSocket(state) {
    if (!state.active || state.authFailed || state.socket || state.reconnectTimer) return;
    let socket;
    try { socket = new WebSocket(api.streamURL); }
    catch (error) { report(error); retrySocket(state); return; }
    state.socket = socket;
    state.ready = false;
    state.sourceOnline = false;
    state.sourceMonitoring = false;
    state.pendingControl = null;
    socket.binaryType = 'arraybuffer';
    const current = () => state.active && state.socket === socket;
    const lost = code => {
      if (!current()) return;
      closeSocket(state);
      if (state.role === 'viewer') clearFrame(state);
      if (code === 1008) { accessDenied(state); return; }
      status('offline', 'Нет связи с сервером. Повторяем подключение.');
      retrySocket(state);
    };
    state.connectTimer = later(state, 6000, () => lost());
    socket.onopen = () => {
      if (!current()) return;
      const auth = { type: 'auth', role: state.role, token: api.token };
      if (state.role === 'host') auth.sessionId = state.sessionId;
      else if (state.mode !== 'video') auth.mode = state.mode;
      try { socket.send(JSON.stringify(auth)); } catch (_) { lost(); }
    };
    socket.onclose = event => lost(event.code);
    // Browsers follow an error with close; retain its code so an auth failure
    // cannot accidentally become a transient retry. The handshake has a timeout.
    socket.onerror = noop;
    function applyControl(message) {
      if (state.role === 'host') {
        const count = message.videoCount ?? message.count;
        state.viewers = Number.isInteger(count) ? Math.max(0, Math.min(6, count)) : 0;
        state.audioViewers = Number.isInteger(message.audioCount) ? Math.max(0, Math.min(6, message.audioCount)) : 0;
        syncAudioCapture(state);
      } else {
        if (state.sourceId !== message.sourceId || !message.online || !message.monitoring) clearAudio(state);
        state.sourceId = message.sourceId;
        state.sourceOnline = message.online === true;
        state.sourceMonitoring = message.monitoring === true;
      }
      state.rtc?.updateState(message);
      if (state.transportError) return;
      if (state.role === 'viewer') {
        if (!state.sourceOnline || !state.sourceMonitoring) {
          clearFrame(state);
          status('offline', state.sourceOnline ? 'Наблюдение на устройстве питомца остановлено' : 'Устройство питомца не в сети');
        } else if (!currentFrame && !state.remoteStream) status('connecting', wantsVideo(state) ? 'Ожидаем кадры с устройства питомца…' : 'Ожидаем звук с устройства питомца…');
      }
    }
    socket.onmessage = event => {
      if (!current()) return;
      if (typeof event.data !== 'string') {
        if (state.role !== 'viewer' || !state.ready || state.transport !== 'websocket' || !state.sourceOnline || !state.sourceMonitoring) return;
        let data = event.data;
        if (data instanceof ArrayBuffer) {
          const bytes = new Uint8Array(data);
          if (bytes[0] === 66 && bytes[1] === 75 && bytes[2] === 65 && bytes[3] === 49) {
            if (!wantsAudio(state) || data.byteLength !== AUDIO_PACKET_BYTES || !state.player?.enqueue(data)) return;
            state.audioReceived = true;
            cancelTimer(state, state.audioTimer);
            audioStatus(state, 'live', 'Слушаем звук дома');
            state.audioTimer = later(state, 3000, () => clearAudio(state));
            return;
          }
          data = new Blob([data], { type: 'image/jpeg' });
        }
        if (!wantsVideo(state) || !(data instanceof Blob) || !data.size || data.size > MAX_FRAME_BYTES) return;
        cancelTimer(state, state.frameTimer);
        // WebSocket binary blobs have no MIME type. Set it before the UI decodes.
        frame(data.type === 'image/jpeg' ? data : new Blob([data], { type: 'image/jpeg' }));
        status('live', 'Прямая трансляция');
        state.frameTimer = later(state, 3000, () => {
          frame(null);
          status('connecting', 'Нет новых кадров. Ожидаем устройство питомца…');
        });
        return;
      }
      let message;
      try { message = JSON.parse(event.data); } catch (_) { lost(); return; }
      if (!message || typeof message !== 'object') { lost(); return; }
      if (message.type === 'error') {
        if ([400, 401, 403, 404, 409].includes(message.status)) accessDenied(state, message.message, message.status);
        else lost();
      } else if (message.type === 'ready' && message.role === state.role) {
        state.rtc?.close();
        state.rtc = null;
        if (state.role === 'viewer') clearAudio(state);
        state.ready = true;
        state.transport = message.mediaTransport || 'websocket';
        cancelTimer(state, state.iceRefreshTimer);
        state.transportError = false;
        emit(onTransport, state.transport);
        state.retryDelay = 500;
        cancelTimer(state, state.connectTimer);
        if (state.role === 'viewer') clearFrame(state);
        if (state.transport === 'webrtc') {
          try {
            state.rtc = createRTC({
              role: state.role, clientId: message.clientId, iceServers: message.iceServers,
              stream: state.stream, mode: state.mode,
              send: signal => {
                if (current() && state.ready && socket.readyState === 1) {
                  try { socket.send(JSON.stringify(signal)); } catch (_) { lost(); }
                }
              },
              onStream: stream => { state.remoteStream = stream; emit(onRemoteStream, stream); },
              onAudioStream: stream => { if (current()) state.player?.setStream(stream); },
              onAudioStatus: (kind, message) => { if (current()) { state.audioReceived = kind === 'live'; audioStatus(state, kind, message); } },
              onStatus: status,
              onError: report,
            });
            if (state.role === 'host') state.rtc.setPublishing(healthySource(state));
            const hasTURN = message.iceServers?.some(server => {
              const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
              return urls.some(url => typeof url === 'string' && /^turns?:/i.test(url));
            });
            // Server-issued TURN credentials last one hour. Renew control before
            // then so new peers receive fresh credentials, including hosts which
            // have kept capture running for days. Normal host retry authenticates
            // only after a successful heartbeat and tears down the old peers.
            if (hasTURN) state.iceRefreshTimer = later(state, TURN_REFRESH_MS, () => lost(1012));
          } catch (error) { state.transportError = true; report(error); status('error', error.message); }
        }
        if (state.role === 'host' && !state.transportError && healthySource(state)) status('monitoring', 'Наблюдение работает. Оставьте эту вкладку открытой.');
        if (state.pendingControl) applyControl(state.pendingControl);
      } else if ((state.role === 'host' && message.type === 'viewers') || (state.role === 'viewer' && message.type === 'source')) {
        // Some server states precede ready. Apply them before accepting offers so
        // the first signal has the same authorization state as the server.
        if (!state.ready) state.pendingControl = message;
        else applyControl(message);
      } else if (state.ready && state.transport === 'webrtc' && message.type === 'signal') {
        state.rtc?.signal(message);
      }
    };
  }

  function healthySource(state) {
    return !audioInputIssue(state) && state.stream.getTracks().every(track => track.readyState === 'live' && track.enabled && !track.muted);
  }

  function canSendAudio(state) {
    return state.active && state.ready && state.transport === 'websocket' && state.socket?.readyState === 1 && state.audioViewers > 0 && healthySource(state);
  }

  function syncAudioCapture(state) {
    const enabled = canSendAudio(state);
    if (state.capture) { state.capture.setEnabled(enabled); return; }
    if (!enabled || state.capturePending || state.captureFailed) return;
    state.capturePending = true;
    void createAudioCapture({
      context: state.audio, source: state.source,
      onPacket: packet => {
        if (!canSendAudio(state) || state.socket.bufferedAmount > AUDIO_PACKET_BYTES * 3) return;
        try { state.socket.send(packet); } catch (error) { report(error); }
      },
      onError: error => { if (state.active) report(error); },
    }).then(capture => {
      if (!state.active) { capture.close(); return; }
      state.capture = capture;
      capture.setEnabled(canSendAudio(state));
    }).catch(error => {
      if (state.active) { state.captureFailed = true; report(error); }
    }).finally(() => { state.capturePending = false; });
  }

  function canSendFrame(state, socket) {
    return state.active && state.ready && state.transport === 'websocket' && state.socket === socket && socket?.readyState === 1 && state.viewers > 0 && healthySource(state);
  }

  async function sendFrame(state) {
    const socket = state.socket;
    const video = state.video;
    if (!canSendFrame(state, socket) || socket.bufferedAmount >= MAX_FRAME_BYTES || video.readyState < 2 || !video.videoWidth || !video.videoHeight) return;
    const canvas = state.liveCanvas;
    const ratio = Math.min(1, 960 / Math.max(video.videoWidth, video.videoHeight));
    canvas.width = Math.max(1, Math.round(video.videoWidth * ratio));
    canvas.height = Math.max(1, Math.round(video.videoHeight * ratio));
    for (let size = 0; size < 3; size++) {
      canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
      for (const quality of [0.65, 0.45, 0.3]) {
        const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', quality));
        // Encoding is asynchronous: stop, reconnect or the last viewer leaving
        // can invalidate this frame before it is ready.
        if (!canSendFrame(state, socket)) return;
        if (blob?.type === 'image/jpeg' && blob.size > 0 && blob.size <= MAX_FRAME_BYTES) {
          if (socket.bufferedAmount + blob.size <= MAX_FRAME_BYTES) socket.send(blob);
          return;
        }
      }
      canvas.width = Math.max(1, Math.floor(canvas.width * 0.7));
      canvas.height = Math.max(1, Math.floor(canvas.height * 0.7));
    }
  }

  function snapshot(state) {
    const video = state.video;
    if (!video || video.readyState < 2 || !video.videoWidth || !video.videoHeight) return null;
    const canvas = state.canvas;
    const ratio = Math.min(1, 960 / Math.max(video.videoWidth, video.videoHeight));
    canvas.width = Math.max(1, Math.round(video.videoWidth * ratio));
    canvas.height = Math.max(1, Math.round(video.videoHeight * ratio));
    for (let size = 0; size < 3; size++) {
      canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
      for (const quality of [0.82, 0.65, 0.45]) {
        const photo = canvas.toDataURL('image/jpeg', quality);
        const payload = photo.slice(photo.indexOf(',') + 1);
        const bytes = Math.floor(payload.length * 3 / 4) - (payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0);
        if (photo.startsWith('data:image/jpeg;base64,') && bytes <= 400 * 1024) return photo;
      }
      canvas.width = Math.max(1, Math.floor(canvas.width * 0.7));
      canvas.height = Math.max(1, Math.floor(canvas.height * 0.7));
    }
    return null;
  }

  function audioInputIssue(state) {
    if (state.audio.state !== 'running') return 'Браузер приостановил обработку звука. Вернитесь к вкладке устройства питомца. Если звук не восстановится, остановите и снова включите наблюдение.';
    const tracks = state.stream.getAudioTracks().filter(track => track.readyState === 'live');
    if (!tracks.length) return 'Микрофон недоступен. Проверьте подключение и запустите наблюдение снова.';
    const enabled = tracks.filter(track => track.enabled);
    if (!enabled.length) return 'Микрофон выключен. Проверьте устройство и запустите наблюдение снова.';
    if (enabled.every(track => track.muted)) return 'Браузер временно заглушил микрофон. Проверьте доступ к нему в браузере и системе.';
    return null;
  }

  function finishCalibration(state, result) {
    if (!state?.calibration) return;
    state.calibration = null;
    // Break the unfinished noise candidate, preserving episode/photo deadlines.
    state.detector.process(0, now());
    emit(onCalibration, result);
  }

  function inputStatus(state, message = '') {
    if (state.inputMessage === message) return;
    state.inputMessage = message;
    emit(onInputStatus, { available: !message, message });
  }

  function finishCalibrationPreview(state, result) {
    if (!state?.active) return;
    state.active = false;
    const current = calibrationPreview === state;
    if (current) calibrationPreview = null;
    for (const timer of state.timers) clearTimeout(timer);
    state.timers.clear();
    for (const [target, type, listener] of state.listeners) target.removeEventListener(type, listener);
    state.listeners.length = 0;
    state.stream?.getTracks().forEach(track => track.stop());
    state.source?.disconnect();
    state.analyser?.disconnect();
    if (state.audio) void state.audio.close().catch(noop);
    if (!current || destroyed) return;
    inputStatus(state, 'Микрофон выключен.');
    emit(onLevel, 0);
    emit(onCalibration, result);
  }

  function previewInputIssue(state) {
    if (state.audio.state !== 'running') return 'Браузер приостановил звук. Вернитесь к вкладке и повторите калибровку.';
    const tracks = state.stream.getAudioTracks();
    if (!tracks.some(track => track.readyState === 'live' && track.enabled && !track.muted)) {
      return 'Микрофон недоступен или выключен. Проверьте его и повторите калибровку.';
    }
    return null;
  }

  function sampleCalibrationPreview(state) {
    if (!state.active || calibrationPreview !== state) return;
    try {
      const issue = previewInputIssue(state);
      if (issue) {
        finishCalibrationPreview(state, { kind: 'error', message: issue });
        return;
      }
      state.analyser.getFloatTimeDomainData(state.samples);
      let squares = 0;
      for (const value of state.samples) squares += value * value;
      const level = Math.min(1, Math.sqrt(squares / state.samples.length));
      inputStatus(state);
      emit(onLevel, level);
      const result = state.calibration.add(level, now());
      if (result.kind === 'calibrating') emit(onCalibration, result);
      else finishCalibrationPreview(state, result);
    } catch (_) {
      finishCalibrationPreview(state, { kind: 'error', message: 'Не удалось измерить фон. Проверьте микрофон и повторите калибровку.' });
    }
    later(state, 50, () => sampleCalibrationPreview(state));
  }

  function calibrationMicrophoneError(cause) {
    const explanations = {
      NotAllowedError: 'Разрешите доступ к микрофону в настройках браузера и повторите калибровку.',
      NotFoundError: 'Микрофон не найден. Подключите его и повторите калибровку.',
      NotReadableError: 'Не удалось включить микрофон. Проверьте, не занят ли он другим приложением.',
      OverconstrainedError: 'Выбранный микрофон недоступен. Выберите другой микрофон.',
    };
    return { kind: 'error', message: explanations[cause?.name] || cause?.message || 'Не удалось включить микрофон. Повторите калибровку.' };
  }

  async function openCalibrationMicrophone(state, audioDeviceId) {
    const current = () => state.active && calibrationPreview === state && !destroyed;
    const listen = (target, type, listener) => {
      target.addEventListener(type, listener);
      state.listeners.push([target, type, listener]);
    };
    try {
      listen(document, 'visibilitychange', () => {
        if (document.visibilityState !== 'visible') finishCalibrationPreview(state, { kind: 'cancelled', message: 'Калибровка отменена: вкладка скрыта. Вернитесь и повторите замер.' });
      });
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('Микрофон доступен только через HTTPS или localhost.');
      const Audio = globalThis.AudioContext || globalThis.webkitAudioContext;
      if (!Audio) throw new Error('Этот браузер не поддерживает обработку звука.');
      state.audio = new Audio();
      // Start resuming within the click activation; permission and resume may
      // settle in either order. Neither consumes the five-second sample window.
      const resumed = Promise.resolve(state.audio.resume()).then(() => true, cause => {
        if (current()) finishCalibrationPreview(state, calibrationMicrophoneError(cause));
        return false;
      });
      const stream = await navigator.mediaDevices.getUserMedia({
        video: false,
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, ...(audioDeviceId ? { deviceId: { exact: audioDeviceId } } : {}) },
      });
      if (!current()) { stream.getTracks().forEach(track => track.stop()); return; }
      state.stream = stream;
      for (const track of stream.getAudioTracks()) {
        for (const type of ['ended', 'mute']) listen(track, type, () => {
          finishCalibrationPreview(state, { kind: 'error', message: 'Доступ к микрофону прерван. Проверьте его и повторите калибровку.' });
        });
      }
      if (!await resumed || !current()) return;
      const issue = previewInputIssue(state);
      if (issue) { finishCalibrationPreview(state, { kind: 'error', message: issue }); return; }
      listen(state.audio, 'statechange', () => {
        if (state.audio.state !== 'running') finishCalibrationPreview(state, { kind: 'error', message: 'Браузер приостановил звук. Вернитесь к вкладке и повторите калибровку.' });
      });
      state.source = state.audio.createMediaStreamSource(stream);
      state.analyser = state.audio.createAnalyser();
      state.analyser.fftSize = 2048;
      state.analyser.smoothingTimeConstant = 0;
      state.samples = new Float32Array(state.analyser.fftSize);
      state.source.connect(state.analyser);
      state.calibration = new NoiseCalibration(now());
      emit(onCalibration, { kind: 'calibrating', remainingMs: CALIBRATION_DURATION_MS, progress: 0 });
      sampleCalibrationPreview(state);
    } catch (cause) {
      if (current()) finishCalibrationPreview(state, calibrationMicrophoneError(cause));
    }
  }

  function startCalibration({ audioDeviceId } = {}) {
    if (destroyed || calibrationPreview?.active) return false;
    if (!host?.active) {
      if (document.visibilityState !== 'visible') {
        emit(onCalibration, { kind: 'error', message: 'Откройте вкладку устройства питомца для калибровки.' });
        return false;
      }
      const state = { active: true, timers: new Set(), listeners: [] };
      calibrationPreview = state;
      emit(onCalibration, { kind: 'starting', message: 'Включаем микрофон. Разрешите доступ к нему в браузере…' });
      void openCalibrationMicrophone(state, audioDeviceId);
      return true;
    }
    const state = host;
    if (!state?.active || !state.stream || state.calibration) return false;
    const issue = audioInputIssue(state);
    if (issue || document.visibilityState !== 'visible') {
      emit(onCalibration, { kind: 'error', message: issue || 'Откройте вкладку устройства питомца для калибровки.' });
      return false;
    }
    state.calibration = new NoiseCalibration(now());
    state.detector.process(0, now());
    emit(onCalibration, { kind: 'calibrating', remainingMs: CALIBRATION_DURATION_MS, progress: 0 });
    return true;
  }

  function cancelCalibration() {
    finishCalibrationPreview(calibrationPreview, { kind: 'cancelled', message: 'Калибровка отменена. Порог не изменён.' });
    finishCalibration(host, { kind: 'cancelled', message: 'Калибровка отменена. Порог не изменён.' });
  }

  function sample(state) {
    if (!state.active) return;
    try {
      state.rtc?.setPublishing(healthySource(state));
      syncAudioCapture(state);
      const inputIssue = audioInputIssue(state);
      inputStatus(state, inputIssue || '');
      if (inputIssue) {
        finishCalibration(state, { kind: 'error', message: `Калибровка прервана. ${inputIssue}` });
        // Suspended audio or an unavailable input can leave a retained waveform.
        // It must never become a new noise event or a nonzero microphone level.
        state.detector.process(0, now());
        emit(onLevel, 0);
        status('error', inputIssue);
        return;
      }
      state.analyser.getFloatTimeDomainData(state.samples);
      let squares = 0;
      for (const value of state.samples) squares += value * value;
      const level = Math.min(1, Math.sqrt(squares / state.samples.length));
      emit(onLevel, level);
      if (state.calibration) {
        if (document.visibilityState !== 'visible') {
          finishCalibration(state, { kind: 'cancelled', message: 'Калибровка отменена: вкладка скрыта. Вернитесь и повторите замер.' });
        } else {
          const result = state.calibration.add(level, now());
          if (result.kind === 'calibrating') emit(onCalibration, result);
          else finishCalibration(state, result);
        }
        return;
      }
      const event = state.detector.process(level, now());
      if (event) {
        const entry = state.events.get(event.episodeId) || { capture: null };
        if (event.takePhoto) {
          try {
            const captured = snapshot(state);
            if (captured) {
              entry.capture = { photo: captured, photoAt: new Date().toISOString() };
              state.detector.photoCaptured(now());
            }
          } catch (error) { report(error); }
        }
        const payload = { sessionId: state.sessionId, episodeId: event.episodeId, level, detectedAt: new Date().toISOString() };
        if (state.historyVersion !== undefined) payload.historyVersion = state.historyVersion;
        entry.noise = payload;
        entry.pendingNoise = true;
        state.events.set(event.episodeId, entry);
        if (state.events.size > 12) state.events.delete(state.events.keys().next().value);
      }
    } catch (error) {
      inputStatus(state, 'Не удалось получить уровень микрофона.');
      finishCalibration(state, { kind: 'error', message: 'Не удалось измерить фон. Проверьте микрофон и повторите калибровку.' });
      report(error);
    }
    finally { later(state, 50, () => sample(state)); }
  }

  async function flushEvents(state) {
    if (!state.ready) return;
    let entry, capture;
    for (const [id, queued] of state.events) {
      if (Date.now() - Date.parse(queued.noise.detectedAt) >= 24 * 60 * 60 * 1000) {
        state.events.delete(id);
        continue;
      }
      if (queued.capture && Date.now() - Date.parse(queued.capture.photoAt) >= 24 * 60 * 60 * 1000) queued.capture = null;
      if (!queued.pendingNoise && !queued.capture) {
        state.events.delete(id);
        continue;
      }
      // Fresh noise takes priority over an older retry-only JPEG. Requests stay
      // sequential at 500ms, independent of the local camera capture interval.
      if (queued.pendingNoise) {
        entry = queued; capture = queued.capture; break;
      }
      if (!entry && queued.capture) { entry = queued; capture = queued.capture; }
    }
    if (!entry) return;
    const noise = entry.noise;
    const payload = { ...noise };
    if (capture) { payload.photo = capture.photo; payload.photoAt = capture.photoAt; }
    const saved = await request(state, 'post', '/events', payload);
    if (!state.active) return;
    applyHistoryVersion(state, saved?.historyVersion);
    if (state.historyVersion !== undefined && payload.historyVersion !== state.historyVersion) return;
    if (entry.noise === noise) entry.pendingNoise = false;
    if (capture) {
      const disposition = saved?.photoStatus;
      const legacy = disposition === undefined;
      const accepted = disposition === 'accepted' || disposition === 'duplicate' ||
        (legacy && !saved?.discarded && !saved?.photoDiscarded && Date.parse(saved?.photoAt) >= Date.parse(capture.photoAt));
      const discarded = disposition === 'discarded' || saved?.discarded || saved?.photoDiscarded;
      if (accepted || discarded) {
        if (entry.capture === capture) entry.capture = null;
      }
    }
    if (!entry.pendingNoise && !entry.capture && state.events.get(payload.episodeId) === entry) state.events.delete(payload.episodeId);
  }

  async function acquireWakeLock(state) {
    if (!state.active || state.wakeLock || state.wakePending || document.visibilityState !== 'visible' || !navigator.wakeLock) return;
    state.wakePending = true;
    try {
      const lock = await navigator.wakeLock.request('screen');
      if (!state.active) { await lock.release(); return; }
      state.wakeLock = lock;
      lock.addEventListener('release', () => { if (state.wakeLock === lock) state.wakeLock = null; });
    } catch (_) { /* Optional: the UI explains that the laptop must remain awake. */ }
    finally { state.wakePending = false; }
  }

  function mediaError(error) {
    const explanations = {
      NotAllowedError: 'Разрешите доступ к камере и микрофону в настройках браузера.',
      NotFoundError: 'Камера или микрофон не найдены. Подключите оба устройства.',
      NotReadableError: 'Не удалось включить камеру или микрофон. Проверьте, не заняты ли они другим приложением.',
      OverconstrainedError: 'Выбранное устройство недоступно. Выберите другую камеру или микрофон.',
    };
    return explanations[error?.name] ? new Error(explanations[error.name]) : error;
  }

  async function startHost({ videoDeviceId, videoFacingMode, audioDeviceId, settings } = {}) {
    if (destroyed) throw new Error('Наблюдение уже закрыто');
    if (host?.active) return;
    cancelCalibration();
    const state = session();
    host = state;
    state.role = 'host';
    state.sessionId = uuid();
    state.events = new Map();
    state.detector = new NoiseDetector(settings);
    status('starting', 'Включаем камеру и микрофон…');
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('Камера и микрофон доступны только через HTTPS или localhost.');
      if (!globalThis.WebSocket) throw new Error('Этот браузер не поддерживает видеотрансляцию через WebSocket.');
      const Audio = globalThis.AudioContext || globalThis.webkitAudioContext;
      if (!Audio) throw new Error('Этот браузер не поддерживает обработку звука.');
      // Resume during the start click, before device permission can consume activation.
      state.audio = new Audio();
      void state.audio.resume().catch(error => { if (state.active) report(error); });
      const camera = videoDeviceId ? { deviceId: { exact: videoDeviceId } }
        : videoFacingMode ? { facingMode: { exact: videoFacingMode } } : {};
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 }, ...camera },
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, ...(audioDeviceId ? { deviceId: { exact: audioDeviceId } } : {}) },
      });
      if (!state.active) { stream.getTracks().forEach(track => track.stop()); return; }
      state.stream = stream;
      state.video = document.createElement('video');
      state.video.muted = true;
      state.video.autoplay = true;
      state.video.playsInline = true;
      state.video.srcObject = stream;
      state.canvas = document.createElement('canvas');
      state.liveCanvas = document.createElement('canvas');
      state.source = state.audio.createMediaStreamSource(stream);
      state.analyser = state.audio.createAnalyser();
      state.analyser.fftSize = 2048;
      state.analyser.smoothingTimeConstant = 0;
      state.samples = new Float32Array(state.analyser.fftSize);
      state.source.connect(state.analyser);
      // A blocked resume can remain pending. Sampling reports the suspension
      // and keeps the source offline while the user can still stop observation.
      await state.video.play();
      if (!state.active) return;
      for (const track of stream.getTracks()) {
        track.onended = () => {
          if (!state.active) return;
          void stopHost().then(() => {
            const error = new Error('Доступ к камере или микрофону потерян. Запустите наблюдение снова.');
            report(error);
            status('error', error.message);
          });
        };
      }
      state.visibility = () => {
        if (document.visibilityState !== 'visible') finishCalibration(state, { kind: 'cancelled', message: 'Калибровка отменена: вкладка скрыта. Вернитесь и повторите замер.' });
        if (document.visibilityState !== 'visible' || !state.active) return;
        void acquireWakeLock(state);
        void state.audio.resume().catch(report);
      };
      document.addEventListener('visibilitychange', state.visibility);
      void acquireWakeLock(state);
      emit(onLocalStream, stream);
      sample(state);
      // The loop awaits each encode before scheduling another capture.
      loop(state, 200, () => sendFrame(state));
      loop(state, 500, () => flushEvents(state), error => hostRequestFailed(state, error));
      loop(state, 5000, () => refreshHost(state), error => hostRequestFailed(state, error));
    } catch (cause) {
      const error = mediaError(cause);
      if (state.active) {
        await stopHost();
        report(error);
        status('error', error.message);
        throw error;
      }
    }
  }

  async function stopHost() {
    cancelCalibration();
    const state = host;
    if (!state) return;
    inputStatus(state, 'Микрофон выключен.');
    host = null;
    stopSession(state);
    state.capture?.close();
    if (state.visibility) document.removeEventListener('visibilitychange', state.visibility);
    state.stream?.getTracks().forEach(track => { track.onended = null; track.stop(); });
    if (state.video) { state.video.pause(); state.video.srcObject = null; }
    state.source?.disconnect();
    state.analyser?.disconnect();
    state.events.clear();
    emit(onLocalStream, null);
    emit(onLevel, 0);
    status('idle', 'Наблюдение остановлено');
    const cleanup = [state.audio?.close(), state.wakeLock?.release()].filter(Boolean);
    // A separate short-lived session lets stop be retried without retaining devices.
    const closing = session();
    cleanup.push((async () => {
      try { await request(closing, 'post', '/heartbeat', { monitoring: false, stopped: true, sessionId: state.sessionId }); }
      catch (error) { report(error); }
      finally { stopSession(closing); }
    })());
    await Promise.allSettled(cleanup);
  }

  async function startViewer({ mode = 'video' } = {}) {
    if (destroyed) throw new Error('Наблюдение уже закрыто');
    if (!['video', 'audio', 'audio-video'].includes(mode)) throw new Error('Неизвестный режим трансляции');
    if (viewer?.active && viewer.mode === mode) return;
    // Teardown is synchronous, including silencing queued audio. Do not await
    // here: AudioContext.resume must retain the button's user activation.
    void stopViewer();
    if (!globalThis.WebSocket) throw new Error('Этот браузер не поддерживает видеотрансляцию через WebSocket.');
    const state = session();
    state.role = 'viewer';
    state.mode = mode;
    viewer = state;
    if (wantsAudio(state)) {
      try {
        state.player = createAudioPlayer({ onStatus: value => {
          if (!state.active) return;
          state.outputBlocked = value.kind === 'blocked' || value.kind === 'error';
          if (value.kind === 'waiting' && state.audioReceived) audioStatus(state, 'live', 'Слушаем звук дома');
          else audioStatus(state, value.kind, value.message);
        } });
        void resumeAudio();
      } catch (error) {
        state.outputBlocked = true;
        audioStatus(state, 'error', error.message);
      }
    } else emit(onAudioStatus, { kind: 'idle', message: 'Звук выключен' });
    status('connecting', 'Проверяем устройство питомца…');
    connectSocket(state);
  }

  async function stopViewer() {
    const state = viewer;
    if (!state) return;
    viewer = null;
    stopSession(state);
    void state.player?.close();
    clearFrame(state);
    emit(onAudioStatus, { kind: 'idle', message: 'Звук выключен' });
    status('idle', 'Прямая трансляция выключена');
  }

  async function resumeAudio() {
    const state = viewer;
    if (!state?.active || !state.player) return;
    const revision = state.audioRevision || 0;
    const resumed = await state.player.resume();
    if (!resumed || !state.active || revision !== (state.audioRevision || 0)) return;
    audioStatus(state, state.audioReceived ? 'live' : 'connecting', state.audioReceived ? 'Слушаем звук дома' : 'Ожидаем звук с устройства питомца…');
  }

  function updateSettings(settings) {
    host?.detector.updateSettings(settings);
  }

  async function destroy() {
    destroyed = true;
    await Promise.allSettled([stopHost(), stopViewer()]);
    errors.clear();
  }

  function updateHistoryVersion(version) {
    if (host?.active) applyHistoryVersion(host, version);
  }

  return { startHost, stopHost, startViewer, stopViewer, resumeAudio, updateSettings, updateHistoryVersion, startCalibration, cancelCalibration, destroy };
}
