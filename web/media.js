import { NoiseDetector } from './noise.js';
import { createRTC } from './rtc.js';

const noop = () => {};
const now = () => performance.now();
const uuid = () => globalThis.crypto?.randomUUID?.() || `client-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
const cancelled = () => Object.assign(new Error('Наблюдение остановлено'), { cancelled: true });
const MAX_FRAME_BYTES = 200 * 1024;
const TURN_REFRESH_MS = 45 * 60 * 1000;

export function createMonitor({ api, onStatus = noop, onLevel = noop, onLocalStream = noop, onFrame = noop, onTransport = noop, onRemoteStream = noop, onError = noop }) {
  let host = null;
  let viewer = null;
  let destroyed = false;
  let lastStatus = '';
  let currentFrame = null;
  const errors = new Map();

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
    return { active: true, timers: new Set(), requests: new Set(), socket: null, ready: false, viewers: 0, retryDelay: 500, authFailed: false };
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

  async function refreshHost(state) {
    const monitoring = healthySource(state);
    await request(state, 'post', '/heartbeat', { monitoring, sessionId: state.sessionId });
    if (!state.active) return;
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
    socket.binaryType = 'blob';
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
      try { socket.send(JSON.stringify(auth)); } catch (_) { lost(); }
    };
    socket.onclose = event => lost(event.code);
    // Browsers follow an error with close; retain its code so an auth failure
    // cannot accidentally become a transient retry. The handshake has a timeout.
    socket.onerror = noop;
    function applyControl(message) {
      if (state.role === 'host') {
        state.viewers = Number.isInteger(message.count) ? Math.max(0, Math.min(6, message.count)) : 0;
      } else {
        state.sourceOnline = message.online === true;
        state.sourceMonitoring = message.monitoring === true;
      }
      state.rtc?.updateState(message);
      if (state.transportError) return;
      if (state.role === 'viewer') {
        if (!state.sourceOnline || !state.sourceMonitoring) {
          clearFrame(state);
          status('offline', state.sourceOnline ? 'Наблюдение на устройстве питомца остановлено' : 'Устройство питомца не в сети');
        } else if (!currentFrame && !state.remoteStream) status('connecting', 'Ожидаем кадры с устройства питомца…');
      }
    }
    socket.onmessage = event => {
      if (!current()) return;
      if (typeof event.data !== 'string') {
        if (state.role !== 'viewer' || !state.ready || state.transport !== 'websocket' || !state.sourceOnline || !state.sourceMonitoring) return;
        if (!(event.data instanceof Blob) || !event.data.size || event.data.size > MAX_FRAME_BYTES) return;
        cancelTimer(state, state.frameTimer);
        // WebSocket binary blobs have no MIME type. Set it before the UI decodes.
        frame(event.data.type === 'image/jpeg' ? event.data : new Blob([event.data], { type: 'image/jpeg' }));
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
              stream: state.stream,
              send: signal => {
                if (current() && state.ready && socket.readyState === 1) {
                  try { socket.send(JSON.stringify(signal)); } catch (_) { lost(); }
                }
              },
              onStream: stream => { state.remoteStream = stream; emit(onRemoteStream, stream); },
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
    if (state.audio.state !== 'running') return 'Браузер приостановил обработку звука. Вернитесь к вкладке устройства питомца.';
    const tracks = state.stream.getAudioTracks().filter(track => track.readyState === 'live');
    if (!tracks.length) return 'Микрофон недоступен. Проверьте подключение и запустите наблюдение снова.';
    const enabled = tracks.filter(track => track.enabled);
    if (!enabled.length) return 'Микрофон выключен. Проверьте устройство и запустите наблюдение снова.';
    if (enabled.every(track => track.muted)) return 'Браузер временно заглушил микрофон. Проверьте доступ к нему в браузере и системе.';
    return null;
  }

  function sample(state) {
    if (!state.active) return;
    try {
      state.rtc?.setPublishing(healthySource(state));
      const inputIssue = audioInputIssue(state);
      if (inputIssue) {
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
      const event = state.detector.process(level, now());
      if (event) {
        const previous = state.events.get(event.episodeId);
        let photo = previous?.photo;
        let photoAt = previous?.photoAt;
        if (event.takePhoto) {
          try {
            const captured = snapshot(state);
            if (captured) { photo = captured; photoAt = new Date().toISOString(); }
          } catch (error) { report(error); }
        }
        const payload = { sessionId: state.sessionId, episodeId: event.episodeId, level, detectedAt: new Date().toISOString() };
        if (photo) { payload.photo = photo; payload.photoAt = photoAt; }
        state.events.set(event.episodeId, payload);
        if (state.events.size > 12) state.events.delete(state.events.keys().next().value);
      }
    } catch (error) { report(error); }
    finally { later(state, 50, () => sample(state)); }
  }

  async function flushEvents(state) {
    if (!state.ready) return;
    const payload = state.events.values().next().value;
    if (!payload) return;
    if (Date.now() - Date.parse(payload.detectedAt) >= 24 * 60 * 60 * 1000) {
      state.events.delete(payload.episodeId);
      return;
    }
    if (payload.photo && Date.now() - Date.parse(payload.photoAt) >= 24 * 60 * 60 * 1000) {
      delete payload.photo;
      delete payload.photoAt;
    }
    await request(state, 'post', '/events', payload);
    if (!state.active) return;
    const current = state.events.get(payload.episodeId);
    if (current === payload) state.events.delete(payload.episodeId);
    else if (current?.photo === payload.photo && current?.photoAt === payload.photoAt) {
      delete current.photo;
      delete current.photoAt;
    }
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

  async function startHost({ videoDeviceId, audioDeviceId, settings } = {}) {
    if (destroyed) throw new Error('Наблюдение уже закрыто');
    if (host?.active) return;
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
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 }, ...(videoDeviceId ? { deviceId: { exact: videoDeviceId } } : {}) },
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
      state.audio = new Audio();
      state.source = state.audio.createMediaStreamSource(stream);
      state.analyser = state.audio.createAnalyser();
      state.analyser.fftSize = 2048;
      state.analyser.smoothingTimeConstant = 0;
      state.samples = new Float32Array(state.analyser.fftSize);
      state.source.connect(state.analyser);
      await Promise.all([state.audio.resume(), state.video.play()]);
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
    const state = host;
    if (!state) return;
    host = null;
    stopSession(state);
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

  async function startViewer() {
    if (destroyed) throw new Error('Наблюдение уже закрыто');
    if (viewer?.active) return;
    if (!globalThis.WebSocket) throw new Error('Этот браузер не поддерживает видеотрансляцию через WebSocket.');
    const state = session();
    state.role = 'viewer';
    viewer = state;
    status('connecting', 'Проверяем устройство питомца…');
    connectSocket(state);
  }

  async function stopViewer() {
    const state = viewer;
    if (!state) return;
    viewer = null;
    stopSession(state);
    clearFrame(state);
    status('idle', 'Прямая трансляция выключена');
  }

  function updateSettings(settings) {
    host?.detector.updateSettings(settings);
  }

  async function destroy() {
    destroyed = true;
    await Promise.allSettled([stopHost(), stopViewer()]);
    errors.clear();
  }

  return { startHost, stopHost, startViewer, stopViewer, updateSettings, destroy };
}
