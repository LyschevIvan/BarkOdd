import { createMonitor } from './media.js';

const APP_BASE = new URL('./', import.meta.url);

const $ = (id) => document.getElementById(id);
const GUEST_STORAGE_KEY = 'barkodd.guest.v2';
let auth = { mode: null, user: null };
let authTimer = null;
let authView = 'login';
let authEpoch = 0;
let authRefreshSequence = 0;
let identityBusy = false;
const DEFAULT_SETTINGS = { threshold: 0.06, quietMs: 5000, snapshotIntervalMs: 30000 };
const photoCache = new Map();
let bindings = readBindings();
let active = null;
let api = null;
let monitor = null;
let room = null;
let generation = 0;
let navigationSequence = 0;
let pollTimer = null;
let clockTimer = null;
let qrURL = null;
let toastTimer = null;
let hostRunning = false;
let viewerWatching = false;
let viewerLive = false;
let mediaBusy = false;
let mediaMessage = '';
let serverReachable = true;
let historySignature = '';
let historyLimit = 12;
let settingsLoaded = false;
let settingsDirty = false;
let latestPhoto = null;
let photoEpoch = 0;
let liveFrameURL = null;
let liveFrameTimer = null;
let pendingLiveFrame = null;
let decodingLiveFrame = null;
let mediaTransport = 'websocket';

class APIError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

function authActor() { return { epoch: authEpoch, id: auth.user?.id || null }; }
function sameActor(actor) { return actor.epoch === authEpoch && actor.id === (auth.user?.id || null); }
function beginIdentityChange() { authEpoch += 1; return authActor(); }
function setIdentityBusy(value) {
  identityBusy = value;
  for (const selector of ['#code-form button', '#login-form button', '#register-form button', '#password-form button', '#logout']) {
    document.querySelector(selector).disabled = value;
  }
}
function storageKey() { return auth.user ? `barkodd.account.v2.${auth.user.id}` : GUEST_STORAGE_KEY; }
function emptyBindings() { return { role: null, host: null, viewer: null, rooms: {} }; }
function readBindings() {
  try {
    const data = JSON.parse(localStorage.getItem(storageKey()) || '{}');
    const valid = entry => entry && typeof entry.id === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(entry.id) && (entry.account === true ? !!auth.user : typeof entry.viewerToken === 'string');
    const clean = entry => valid(entry) ? { id: entry.id, ...(entry.account ? { account: true } : {}), ...(typeof entry.viewerToken === 'string' ? { viewerToken: entry.viewerToken } : {}) } : null;
    const rooms = {};
    if (auth.user && data.rooms && typeof data.rooms === 'object') for (const entry of Object.values(data.rooms)) { const binding = clean(entry); if (binding?.account) rooms[binding.id] = binding; }
    return { role: ['host', 'viewer'].includes(data.role) ? data.role : null, host: clean(data.host), viewer: clean(data.viewer), rooms };
  } catch (_) { return emptyBindings(); }
}
function saveBindings() {
  try { localStorage.setItem(storageKey(), JSON.stringify(bindings)); }
  catch (_) { toast('Браузер не разрешил сохранить привязку. После перезагрузки понадобится ссылка.'); }
}
function saveGuest(binding) {
  try { localStorage.setItem(GUEST_STORAGE_KEY, JSON.stringify({ role: 'viewer', viewer: binding })); localStorage.setItem('barkodd.guest-active.v2', 'true'); }
  catch (_) { /* Guest links remain usable without browser storage. */ }
}
function renderAccount() {
  const user = auth.user;
  $('account-tools').hidden = !user;
  $('account-tools').dataset.userId = user?.id || '';
  $('account-name').textContent = auth.mode === 'none' ? 'Общий кабинет' : user?.username || '';
  $('logout').hidden = auth.mode === 'none';
  $('password-toggle').hidden = !user || user.role !== 'user';
  $('auth-panel').hidden = !!user || !auth.mode || auth.mode === 'none';
  $('account-panel').hidden = !user;
  $('choose-host').hidden = !user;
  $('users-toggle').hidden = auth.mode !== 'multi_user' || user?.role !== 'admin';
  $('auth-tabs').hidden = auth.mode !== 'multi_user';
  $('auth-description').textContent = auth.mode === 'multi_user' ? 'Войдите или зарегистрируйтесь. Гостевые ссылки открываются без входа.' : 'Код владельца нужен только для входа. Гостевые ссылки открываются без входа.';
  $('code-form').hidden = !!user || !(auth.mode === 'admin_code' || authView === 'admin');
  $('login-form').hidden = !!user || auth.mode !== 'multi_user' || authView !== 'login';
  $('register-form').hidden = !!user || auth.mode !== 'multi_user' || authView !== 'register';
  $('password-panel').hidden = true;
  if (!user) { $('owned-rooms').replaceChildren(); $('users-list').replaceChildren(); $('users-panel').hidden = true; }
}
async function loadRooms() {
  if (!auth.user) return;
  const actor = authActor();
  const navigation = navigationSequence;
  try {
    const data = await request('api/rooms');
    if (!sameActor(actor) || navigation !== navigationSequence) return;
    $('owned-rooms').replaceChildren();
    $('rooms-empty').hidden = data.rooms.length > 0;
    for (const entry of data.rooms) {
      const card = textElement('article', 'owned-room', '');
      const info = textElement('div', 'room-info', '');
      info.append(textElement('h3', '', entry.name), textElement('p', 'field-hint', entry.monitoring ? 'Наблюдение включено' : entry.online ? 'Устройство в сети' : 'Устройство не в сети'));
      const actions = textElement('div', 'account-actions', '');
      for (const [role, label] of [['host', 'Устройство питомца'], ['viewer', 'Просмотр']]) {
        const button = textElement('button', 'button button-secondary', label);
        button.type = 'button';
        button.addEventListener('click', () => void openRoom(role, bindings.rooms[entry.id] || { id: entry.id, account: true }, actor));
        actions.append(button);
      }
      card.append(info, actions);
      $('owned-rooms').append(card);
    }
  } catch (error) {
    if (!sameActor(actor) || navigation !== navigationSequence) return;
    if ([401, 403].includes(error.status)) await loseAccount(undefined, actor);
    else showError(error.message, true);
  }
}
async function loseAccount(message = 'Сессия завершена. Войдите снова, чтобы открыть свои комнаты.', actor = authActor()) {
  if (!sameActor(actor) || !auth.user) return;
  beginIdentityChange();
  auth.user = null;
  authView = 'login';
  bindings = readBindings();
  renderAccount();
  await showWelcome(message);
}
async function refreshAuth() {
  if (identityBusy) return;
  const actor = authActor();
  const sequence = ++authRefreshSequence;
  try {
    const state = await request('api/auth');
    if (!sameActor(actor) || sequence !== authRefreshSequence || identityBusy) return;
    if (state.user?.id === auth.user?.id && state.mode === auth.mode) return;
    beginIdentityChange();
    auth = state;
    authView = 'login';
    bindings = readBindings();
    renderAccount();
    // Guest QR access stays independent from a revoked account session.
    if (active && !active.binding.account) return;
    await showWelcome(state.user ? '' : 'Сессия завершена. Войдите снова, чтобы открыть свои комнаты.');
  } catch (_) { /* Room polling reports temporary network loss. */ }
}
async function authenticate(form, path, body) {
  if (identityBusy) return;
  const actor = beginIdentityChange();
  setIdentityBusy(true);
  for (const input of form.querySelectorAll('input[type=password]')) input.value = '';
  showError('', true);
  try {
    const result = await request(path, { method: 'POST', body });
    if (!sameActor(actor)) return;
    beginIdentityChange();
    auth.user = result.user;
    bindings = readBindings();
    renderAccount();
    await showWelcome();
  } catch (error) { if (sameActor(actor)) showError(error.message, true); }
  finally { setIdentityBusy(false); }
}

async function request(url, { method = 'GET', body, token, blob = false, actorID = !token && !url.startsWith('api/auth') ? auth.user?.id : null } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    if (actorID) headers['X-BarkOdd-User'] = actorID;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetch(new URL(url, APP_BASE), { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: controller.signal, cache: 'no-store', credentials: 'same-origin', referrerPolicy: 'no-referrer' });
    if (!response.ok) {
      let message = `Ошибка сервера (${response.status})`;
      try { const data = await response.json(); if (data.error) message = String(data.error); } catch (_) { /* Non-JSON proxy error. */ }
      throw new APIError(message, response.status);
    }
    return blob ? await response.blob() : response.status === 204 ? null : await response.json();
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('Сервер долго не отвечает. Проверьте подключение к интернету.');
    if (error instanceof TypeError) throw new Error('Нет связи с сервером. Проверьте подключение к интернету.');
    throw error;
  } finally { clearTimeout(timeout); }
}

function roomAPI(binding, role) {
  const actor = authActor();
  const base = `api/rooms/${encodeURIComponent(binding.id)}`;
  const token = binding.account ? '' : binding.viewerToken;
  const call = (path, options = {}) => request(base + path, { ...options, token, actorID: binding.account ? actor.id : null }).catch(error => {
    if (error.status === 401 && sameActor(actor) && active?.binding === binding) void invalidateSession(error);
    throw error;
  });
  const streamURL = new URL(`${base}/stream`, APP_BASE);
  streamURL.protocol = streamURL.protocol === 'https:' ? 'wss:' : 'ws:';
  return {
    streamURL: streamURL.href,
    token,
    get: (path = '') => call(path),
    post: (path, body) => call(path, { method: 'POST', body }),
    put: (path, body) => call(path, { method: 'PUT', body }),
    blob: (path, body) => call(path, { method: body === undefined ? 'GET' : 'POST', body, blob: true }),
  };
}

function clearLiveFrame() {
  clearTimeout(liveFrameTimer);
  liveFrameTimer = null;
  pendingLiveFrame = null;
  viewerLive = false;
  if (decodingLiveFrame) {
    const entry = decodingLiveFrame;
    decodingLiveFrame = null;
    clearTimeout(entry.timer);
    entry.image.removeAttribute('src');
    URL.revokeObjectURL(entry.url);
  }
  $('live-frame').hidden = true;
  $('live-frame').removeAttribute('src');
  if (liveFrameURL) URL.revokeObjectURL(liveFrameURL);
  liveFrameURL = null;
}

function receiveLiveFrame(blob) {
  if (!blob) { clearLiveFrame(); renderMedia(); return; }
  if (!active || active.role !== 'viewer' || !viewerWatching) return;
  // Keep only the newest waiting frame and one decoder, even on a slow device.
  pendingLiveFrame = blob;
  decodeLiveFrame();
}

function decodeLiveFrame() {
  if (decodingLiveFrame || !pendingLiveFrame) return;
  const image = new Image();
  const entry = { image, url: URL.createObjectURL(pendingLiveFrame), timer: null };
  pendingLiveFrame = null;
  decodingLiveFrame = entry;
  const finish = (decoded) => {
    if (decodingLiveFrame !== entry) return;
    decodingLiveFrame = null;
    clearTimeout(entry.timer);
    image.removeAttribute('src');
    if (decoded && active?.role === 'viewer' && viewerWatching) {
      const previousURL = liveFrameURL;
      liveFrameURL = entry.url;
      $('live-frame').src = entry.url;
      if (previousURL) URL.revokeObjectURL(previousURL);
      viewerLive = true;
      clearTimeout(liveFrameTimer);
      liveFrameTimer = setTimeout(() => { clearLiveFrame(); renderMedia(); }, 3000);
      renderMedia();
    } else {
      URL.revokeObjectURL(entry.url);
    }
    decodeLiveFrame();
  };
  entry.timer = setTimeout(() => finish(false), 2000);
  image.src = entry.url;
  image.decode().then(() => finish(true), () => finish(false));
}

function showError(message, welcome = !active) {
  const target = $(welcome ? 'welcome-alert' : 'dashboard-alert');
  target.textContent = message;
  target.hidden = !message;
}

function toast(message) {
  clearTimeout(toastTimer);
  $('toast').textContent = message;
  $('toast').hidden = false;
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, 4200);
}

function dateValue(value) { const d = value ? new Date(value) : null; return d && !Number.isNaN(d.getTime()) ? d : null; }
function fullDate(value) { const d = dateValue(value); return d ? new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(d) : 'Время неизвестно'; }
function shortDate(value) { const d = dateValue(value); return d ? new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(d) : 'Время неизвестно'; }
function relativeTime(value) {
  const d = dateValue(value);
  if (!d) return 'Пока не было';
  const seconds = Math.max(0, Math.floor((Date.now() - d.getTime()) / 1000));
  if (seconds < 15) return 'Только что';
  if (seconds < 60) return `${seconds} сек. назад`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} мин. назад`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} ч. назад`;
  return new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short' }).format(d);
}

function parsePairingLink(value) {
  let link;
  try { link = new URL(value, APP_BASE); } catch (_) { throw new Error('Не удалось прочитать ссылку. Скопируйте её целиком с устройства питомца.'); }
  if (link.origin !== location.origin) throw new Error('Эта ссылка ведёт на другой сервер BarkOdd. Откройте её напрямую в браузере.');
  const params = new URLSearchParams(link.hash.slice(1));
  const id = params.get('room');
  const viewerToken = params.get('key');
  if (!id || !/^[a-zA-Z0-9_-]{1,128}$/.test(id) || !viewerToken || viewerToken.length > 256) throw new Error('В ссылке не хватает комнаты или ключа. Скопируйте полную ссылку с устройства питомца.');
  return { id, viewerToken };
}

function pairingLink() {
  if (!active || active.role !== 'host' || !active.binding.viewerToken) return null;
  const link = new URL(APP_BASE);
  link.searchParams.set('role', 'viewer');
  link.hash = new URLSearchParams({ room: active.binding.id, key: active.binding.viewerToken }).toString();
  return link.href;
}

async function releaseRoom() {
  generation += 1;
  photoEpoch += 1;
  clearTimeout(pollTimer);
  clearInterval(clockTimer);
  const previous = monitor;
  monitor = null;
  active = null;
  room = null;
  api = null;
  $('camera-video').srcObject = null;
  $('camera-video').muted = true;
  $('camera-video').hidden = true;
  $('remote-video').pause();
  $('remote-video').srcObject = null;
  $('remote-video').hidden = true;
  mediaTransport = 'websocket';
  clearLiveFrame();
  $('photo-dialog').close();
  $('dialog-photo').removeAttribute('src');
  for (const entry of photoCache.values()) if (entry.url) URL.revokeObjectURL(entry.url);
  photoCache.clear();
  if (qrURL) URL.revokeObjectURL(qrURL);
  qrURL = null;
  $('pairing-qr').removeAttribute('src');
  $('pairing-qr').hidden = true;
  $('latest-photo').removeAttribute('src');
  $('latest-photo-panel').hidden = true;
  hostRunning = false;
  viewerWatching = false;
  viewerLive = false;
  mediaBusy = false;
  mediaMessage = '';
  historySignature = '';
  historyLimit = 12;
  settingsLoaded = false;
  settingsDirty = false;
  latestPhoto = null;
  try { if (previous) await previous.destroy(); } catch (_) { /* Teardown remains local when the server is unavailable. */ }
}

async function showWelcome(message = '') {
  const actor = authActor();
  const navigation = ++navigationSequence;
  await releaseRoom();
  if (navigation !== navigationSequence || !sameActor(actor)) return;
  $('dashboard').hidden = true;
  $('welcome').hidden = false;
  $('switch-role').hidden = true;
  $('setup-panel').hidden = true;
  $('choose-host').classList.remove('selected');
  $('choose-viewer').classList.remove('selected');
  $('forget-binding').hidden = !bindings.host && !bindings.viewer;
  showError(message, true);
  document.title = 'BarkOdd — рядом, даже издалека';
  renderAccount();
  if (auth.user) await loadRooms();
}

async function invalidateSession(error) {
  if (!active) return;
  if (active.binding.account && error.status !== 404) { await loseAccount(); return; }
  const role = active.role;
  if (active.binding.account) { delete bindings.rooms[active.binding.id]; bindings[role] = null; bindings.role = null; saveBindings(); }
  else { try { localStorage.removeItem(GUEST_STORAGE_KEY); } catch (_) {} if (!auth.user) bindings = emptyBindings(); }
  await showWelcome(error.status === 404 ? 'Комната не найдена. Создайте новую комнату или получите актуальную ссылку.' : role === 'viewer' ? 'Ссылка больше не действует. На устройстве питомца получите новую ссылку или QR-код.' : 'Ключ управления больше не действует. Создайте новую комнату на этом устройстве.');
}

async function chooseRole(role) {
  showError('', true);
  if (role === 'host' && !auth.user) return;
  $('setup-panel').hidden = false;
  $('host-form').hidden = role !== 'host';
  $('viewer-form').hidden = role !== 'viewer';
  $('choose-host').classList.toggle('selected', role === 'host');
  $('choose-viewer').classList.toggle('selected', role === 'viewer');
  $(role === 'host' ? 'room-name' : 'viewer-link').focus({ preventScroll: true });
  $('setup-panel').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

async function openRoom(role, binding, actor = authActor()) {
  if (!sameActor(actor) || binding.account && !auth.user || identityBusy) return;
  const navigation = ++navigationSequence;
  await releaseRoom();
  if (navigation !== navigationSequence || !sameActor(actor)) return;
  active = { role, binding };
  const current = generation;
  api = roomAPI(binding, role);
  if (binding.account) {
    try { localStorage.removeItem('barkodd.guest-active.v2'); } catch (_) {}
    bindings[role] = binding;
    bindings.rooms[binding.id] = binding;
    bindings.role = role;
    saveBindings();
  } else { saveGuest(binding); }
  serverReachable = true;
  $('welcome').hidden = true;
  $('dashboard').hidden = false;
  $('switch-role').hidden = false;
  $('role-label').textContent = role === 'host' ? 'Устройство питомца' : 'Устройство человека';
  $('room-title').textContent = 'Подключаемся…';
  $('host-settings').hidden = role !== 'host';
  $('pairing-panel').hidden = role !== 'host';
  $('host-note').hidden = role !== 'host';
  $('viewer-note').hidden = role !== 'viewer';
  $('stream-note').hidden = role !== 'viewer';
  $('video-heading-text').textContent = role === 'host' ? 'Камера питомца' : 'Камера дома';
  $('event-history').replaceChildren();
  $('history-empty').hidden = false;
  $('event-count').textContent = '0';
  $('last-noise-value').textContent = 'Пока не было';
  $('last-noise-detail').textContent = 'Здесь появится время события';
  $('settings-feedback').textContent = '';
  $('local-pairing-hint').hidden = !['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
  showError('');
  monitor = createMonitor({
    api,
    onTransport(mode) {
      if (generation !== current) return;
      if (mediaTransport !== mode) {
        clearLiveFrame();
        $('remote-video').pause();
        $('remote-video').srcObject = null;
      }
      mediaTransport = mode;
      renderMedia();
    },
    onStatus(status) {
      if (generation !== current) return;
      mediaMessage = status.message || '';
      if (role === 'host') {
        if (status.kind === 'monitoring') hostRunning = true;
        if (status.kind === 'idle') hostRunning = false;
      } else {
        viewerLive = status.kind === 'live';
      }
      renderMedia();
    },
    onLevel(value) {
      if (generation !== current) return;
      const level = Math.max(0, Math.min(1, value));
      $('sound-level-bar').style.width = `${Math.min(100, Math.sqrt(level) * 100)}%`;
      $('sound-level-value').textContent = hostRunning ? level > 0 && level < 0.01 ? '<1%' : `${Math.round(level * 100)}%` : '—';
    },
    onLocalStream(stream) {
      if (generation !== current || role !== 'host') return;
      $('camera-video').srcObject = stream;
      $('camera-video').muted = true;
      hostRunning = !!stream;
      renderMedia();
      if (stream) { $('camera-video').play().catch(() => {}); loadDevices(); }
    },
    onFrame(blob) {
      if (generation !== current || role !== 'viewer') return;
      receiveLiveFrame(blob);
    },
    onRemoteStream(stream) {
      if (generation !== current || role !== 'viewer') return;
      const video = $('remote-video');
      if (video.srcObject !== stream) video.srcObject = stream;
      if (!stream) { video.pause(); viewerLive = false; }
      else video.play().catch(() => showError('Не удалось воспроизвести видео. Выключите и включите просмотр.'));
      renderMedia();
    },
    onError(error) {
      if (generation !== current) return;
      if ((!error.sessionEnded || error.status === 401) && [401, 403, 404].includes(error.status)) { void invalidateSession(error); return; }
      showError(error.message || 'Не удалось подключиться к камере. Попробуйте ещё раз.');
    },
  });
  renderMedia();
  await pollRoom(current);
  if (generation !== current) return;
  if (role === 'host') { void loadPairingQR(); void loadDevices(); }
  clockTimer = setInterval(() => { if (room) renderTimes(); }, 10000);
}

async function pollRoom(current) {
  if (current !== generation || !api) return;
  try {
    const state = await api.get('');
    if (current !== generation) return;
    const wasOffline = !serverReachable;
    serverReachable = true;
    room = state;
    $('owner-approval').hidden = !room.turnAuthorizationRequired;
    $('approval-form').hidden = active.role !== 'host';
    $('delete-room-panel').hidden = active.role !== 'host';
    if (room.mediaTransport === 'websocket' || room.mediaTransport === 'webrtc') mediaTransport = room.mediaTransport;
    $('room-title').textContent = room.name;
    document.title = `${room.name} · BarkOdd`;
    if (wasOffline) showError('');
    if (active.role === 'host' && !settingsLoaded) { fillSettings(room.settings || DEFAULT_SETTINGS); settingsLoaded = true; }
    if (active.role === 'host' && !settingsDirty) monitor.updateSettings(room.settings || DEFAULT_SETTINGS);
    renderTimes();
    renderStatus();
    renderHistory();
    renderMedia();
  } catch (error) {
    if (current !== generation) return;
    if ([401, 403, 404].includes(error.status)) { await invalidateSession(error); return; }
    serverReachable = false;
    renderStatus();
    renderMedia();
    showError('Нет связи с сервером. Показаны последние полученные данные; пробуем подключиться снова.');
  } finally {
    if (current === generation && active) pollTimer = setTimeout(() => void pollRoom(current), 2000);
  }
}

function renderStatus() {
  let state = 'idle';
  let text = 'Подключаемся';
  if (!serverReachable) { state = 'offline'; text = 'Нет связи с сервером'; }
  else if (room) {
    if (!room.online) { state = 'offline'; text = active.role === 'host' && !hostRunning ? 'Наблюдение выключено' : 'Устройство не в сети'; }
    else if (room.monitoring) { state = 'online'; text = 'Наблюдение включено'; }
    else { text = 'Наблюдение выключено'; }
  }
  $('room-status').dataset.state = state;
  $('room-status-text').textContent = text;
}

function renderTimes() {
  $('last-noise-value').textContent = relativeTime(room.lastNoiseAt);
  $('last-noise-detail').textContent = room.lastNoiseAt ? fullDate(room.lastNoiseAt) : 'Здесь появится время события';
  $('event-count').textContent = String(room.eventCount || (room.events || []).length);
}

function renderMedia() {
  if (!active) return;
  const isHost = active.role === 'host';
  const video = $('camera-video');
  const remoteVideo = $('remote-video');
  const rtc = mediaTransport === 'webrtc';
  const remoteOnline = serverReachable && room && room.online && room.monitoring;
  if (!isHost && !rtc && (!viewerWatching || !viewerLive || !remoteOnline)) clearLiveFrame();
  const visible = isHost ? !!video.srcObject && hostRunning : !!(rtc ? remoteVideo.srcObject : liveFrameURL) && viewerWatching && viewerLive && remoteOnline;
  video.hidden = !isHost || !visible;
  remoteVideo.hidden = isHost || !rtc || !visible;
  $('live-frame').hidden = isHost || rtc || !visible;
  $('stream-note').textContent = rtc ? 'WebRTC · без прямого звука' : 'WebSocket · до 5 кадров/с · без прямого звука';
  $('video-placeholder').hidden = visible;
  $('video-corner').hidden = !visible;
  $('video-corner-text').textContent = isHost ? 'ЛОКАЛЬНЫЙ ПРЕДПРОСМОТР' : 'ПРЯМО СЕЙЧАС';
  $('video-mode').textContent = visible ? isHost ? 'НАБЛЮДЕНИЕ' : 'В ПРЯМОМ ЭФИРЕ' : mediaBusy ? 'ПОДКЛЮЧЕНИЕ' : 'КАМЕРА ВЫКЛЮЧЕНА';
  const running = isHost ? hostRunning : viewerWatching;
  $('capture-button').disabled = mediaBusy;
  $('capture-button').querySelector('span').textContent = mediaBusy ? 'Подключаемся…' : isHost ? running ? 'Остановить наблюдение' : 'Включить наблюдение' : running ? 'Выключить видео' : 'Включить видео';
  $('capture-button').querySelector('use').setAttribute('href', running ? '#i-stop' : '#i-play');
  $('video-device').disabled = isHost && (hostRunning || mediaBusy);
  $('audio-device').disabled = isHost && (hostRunning || mediaBusy);
  const microphoneLabel = isHost && video.srcObject?.getAudioTracks()[0]?.label;
  $('device-hint').textContent = hostRunning ? `${microphoneLabel ? `Микрофон: ${microphoneLabel}. ` : ''}Чтобы сменить камеру или микрофон, остановите наблюдение.` : 'Названия устройств появятся после разрешения доступа.';
  if (isHost) {
    $('video-placeholder-title').textContent = mediaBusy ? 'Устраиваемся поудобнее' : 'Тихое место для вашего друга';
    $('video-placeholder-text').textContent = mediaBusy ? 'Разрешите доступ к камере и микрофону в браузере.' : 'Включите наблюдение, когда будете готовы.';
    $('media-status').textContent = mediaMessage || (hostRunning ? 'Слушаем звуки и сохраняем домашние моменты' : 'Камера и микрофон выключены');
  } else {
    if (!serverReachable) {
      $('video-placeholder-title').textContent = 'Проверяем связь';
      $('video-placeholder-text').textContent = 'Сервер пока недоступен. Последние события остаются в истории.';
    } else if (room && (!room.online || !room.monitoring)) {
      $('video-placeholder-title').textContent = room.online ? 'Наблюдение на паузе' : 'Устройство питомца не в сети';
      $('video-placeholder-text').textContent = room.online ? 'На домашнем устройстве нужно включить наблюдение.' : 'Проверьте домашний интернет, открытую вкладку и режим сна ноутбука.';
    } else {
      $('video-placeholder-title').textContent = viewerWatching ? 'Соединяем вас с домом' : 'Питомец ближе, чем кажется';
      $('video-placeholder-text').textContent = viewerWatching ? 'Подключаем камеру. Это может занять несколько секунд.' : 'Нажмите «Включить видео», чтобы заглянуть. История доступна и без видео.';
    }
    $('media-status').textContent = viewerWatching ? !remoteOnline ? 'Ждём устройство питомца. Подключимся автоматически.' : mediaMessage || 'Соединяемся с домашней камерой' : 'Видео выключено · история продолжает обновляться';
  }
}

function fillSettings(settings) {
  const range = Math.round(1 + 99 * Math.log(0.5 / settings.threshold) / Math.log(100));
  $('sensitivity').value = String(Math.max(1, Math.min(100, range)));
  const select = $('snapshot-interval');
  if (![...select.options].some((option) => Number(option.value) === settings.snapshotIntervalMs)) {
    select.add(new Option(`${settings.snapshotIntervalMs / 1000} секунд`, String(settings.snapshotIntervalMs)));
  }
  select.value = String(settings.snapshotIntervalMs);
  renderSensitivity();
}

function renderSensitivity() {
  const value = Number($('sensitivity').value);
  $('sensitivity-value').textContent = value < 34 ? 'Низкая' : value < 70 ? 'Средняя' : 'Высокая';
}

async function loadDevices() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
  const current = generation;
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    if (current !== generation || !active || active.role !== 'host') return;
    for (const [kind, id, label] of [['videoinput', 'video-device', 'Камера'], ['audioinput', 'audio-device', 'Микрофон']]) {
      const select = $(id);
      const selected = select.value;
      select.replaceChildren(new Option(`${label} по умолчанию`, ''));
      devices.filter((device) => device.kind === kind && device.deviceId).forEach((device, index) => select.add(new Option(device.label || `${label} ${index + 1}`, device.deviceId)));
      if ([...select.options].some((option) => option.value === selected)) select.value = selected;
    }
  } catch (_) { /* The browser may hide devices until capture is allowed. */ }
}

async function loadPairingQR() {
  if (!active || active.role !== 'host') return;
  const current = generation;
  const token = active.binding.viewerToken;
  $('qr-placeholder').hidden = false;
  $('pairing-qr').hidden = true;
  $('qr-placeholder').textContent = token ? 'Готовим QR-код…' : 'Создайте новую ссылку. Прежние гостевые ссылки перестанут работать.';
  $('copy-link').disabled = !token;
  if (!token) return;
  try {
    const blob = await api.blob('/qr', { viewerToken: token, origin: location.origin });
    if (current !== generation || token !== active.binding.viewerToken) return;
    if (qrURL) URL.revokeObjectURL(qrURL);
    qrURL = URL.createObjectURL(blob);
    $('pairing-qr').src = qrURL;
    $('pairing-qr').hidden = false;
    $('qr-placeholder').hidden = true;
  } catch (error) {
    if (current !== generation) return;
    $('qr-placeholder').textContent = 'QR-код не загрузился. Можно скопировать ссылку ниже.';
    if ([400, 403].includes(error.status) && active?.binding.account) {
      delete active.binding.viewerToken;
      saveBindings();
      $('copy-link').disabled = true;
      $('qr-placeholder').textContent = 'Ключ просмотра изменился. Создайте новую ссылку: прежние ссылки перестанут работать.';
    }
  }
}

function photoKey(event) { return `${event.id}:${event.photoAt || ''}`; }

function fetchPhoto(event) {
  const key = photoKey(event);
  if (photoCache.has(key)) return photoCache.get(key).promise;
  const current = generation;
  const entry = { url: null, promise: null };
  entry.promise = api.blob(`/events/${encodeURIComponent(event.id)}/photo`).then((blob) => {
    if (current !== generation || photoCache.get(key) !== entry) return null;
    entry.url = URL.createObjectURL(blob);
    return entry.url;
  }).catch((error) => {
    if (current === generation) {
      photoCache.delete(key);
      // Retry on the next state poll even if the event history is unchanged.
      historySignature = '';
      if ([401, 403].includes(error.status)) void invalidateSession(error);
    }
    return null;
  });
  photoCache.set(key, entry);
  return entry.promise;
}

function textElement(tag, className, value) {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = value;
  return node;
}

function renderHistory() {
  const events = room.events || [];
  const signature = JSON.stringify(events) + ':' + historyLimit;
  if (signature === historySignature) return;
  historySignature = signature;
  const current = generation;
  const epoch = ++photoEpoch;
  const visible = events.slice(0, historyLimit);
  const last = events.find((event) => event.hasPhoto);
  const wantedKeys = new Set(visible.filter((event) => event.hasPhoto).map(photoKey));
  if (last) wantedKeys.add(photoKey(last));
  for (const [key, entry] of photoCache) {
    if (!wantedKeys.has(key)) { if (entry.url) URL.revokeObjectURL(entry.url); photoCache.delete(key); }
  }
  $('history-empty').hidden = events.length > 0;
  $('event-history').replaceChildren();
  $('more-events').hidden = events.length <= historyLimit;
  for (const event of visible) {
    const card = document.createElement('article');
    card.className = 'event-card';
    card.dataset.eventId = event.id;
    if (event.hasPhoto) {
      const button = document.createElement('button');
      button.className = 'event-photo-button';
      button.setAttribute('aria-label', `Открыть фото: ${fullDate(event.photoAt)}`);
      const image = document.createElement('img');
      image.alt = `Домашний момент, ${shortDate(event.photoAt)}`;
      image.hidden = true;
      const loading = textElement('span', 'photo-loading', 'Загружаем момент…');
      button.append(loading, image);
      card.append(button);
      button.addEventListener('click', () => void openPhoto(event));
      void fetchPhoto(event).then((url) => {
        if (current !== generation || epoch !== photoEpoch) return;
        if (url) { image.src = url; image.hidden = false; loading.hidden = true; }
        else loading.textContent = 'Фото не загрузилось';
      });
    }
    const info = document.createElement('div');
    info.className = 'event-info';
    const title = textElement('h3', '', 'Шум дома');
    const date = textElement('time', 'event-date', shortDate(event.startedAt));
    date.dateTime = event.startedAt;
    date.title = fullDate(event.startedAt);
    const detail = textElement('span', 'event-detail', `Последний звук: ${fullDate(event.lastNoiseAt)}`);
    info.append(title, date, detail);
    if (event.hasPhoto && event.photoAt) info.append(textElement('span', 'event-detail', `Фото: ${fullDate(event.photoAt)}`));
    card.append(info);
    if (!event.hasPhoto) card.append(textElement('div', 'event-no-photo', 'Событие без фотографии'));
    $('event-history').append(card);
  }
  latestPhoto = last || null;
  $('latest-photo-panel').hidden = !last;
  if (last) {
    $('latest-photo').hidden = true;
    $('latest-photo-time').textContent = fullDate(last.photoAt);
    $('latest-photo-time').dateTime = last.photoAt;
    void fetchPhoto(last).then((url) => {
      if (current !== generation || epoch !== photoEpoch) return;
      if (url) { $('latest-photo').src = url; $('latest-photo').hidden = false; }
      else $('latest-photo-panel').hidden = true;
    });
  }
}

async function openPhoto(event) {
  const current = generation;
  const url = await fetchPhoto(event);
  if (current !== generation) return;
  if (!url) { toast('Фото не загрузилось. Попробуйте ещё раз.'); return; }
  $('dialog-photo').src = url;
  $('dialog-photo-caption').textContent = `Шум дома · снимок ${fullDate(event.photoAt)}`;
  if (!$('photo-dialog').open) $('photo-dialog').showModal();
}

async function toggleCapture() {
  if (!monitor || mediaBusy) return;
  const current = generation;
  const currentMonitor = monitor;
  const isHost = active.role === 'host';
  mediaBusy = true;
  showError('');
  renderMedia();
  try {
    if (isHost) {
      if (hostRunning) { await currentMonitor.stopHost(); if (generation === current) hostRunning = false; }
      else {
        if (!window.isSecureContext) throw new Error('Камера доступна только по HTTPS или на localhost. Откройте BarkOdd по защищённому адресу.');
        await currentMonitor.startHost({ videoDeviceId: $('video-device').value || undefined, audioDeviceId: $('audio-device').value || undefined, settings: room ? room.settings : DEFAULT_SETTINGS });
        if (generation === current) hostRunning = true;
      }
    } else {
      if (viewerWatching) { viewerWatching = false; viewerLive = false; await currentMonitor.stopViewer(); }
      else { viewerWatching = true; await currentMonitor.startViewer(); }
    }
  } catch (error) {
    if (generation !== current) return;
    if (!isHost) viewerWatching = false;
    showError(error.message || 'Не удалось включить камеру. Проверьте разрешения браузера.');
  } finally {
    if (generation === current) { mediaBusy = false; renderMedia(); }
  }
}

async function copyLink() {
  const link = pairingLink();
  if (!link) return;
  try {
    if (!navigator.clipboard || !navigator.clipboard.writeText) throw new Error('Clipboard unavailable');
    await navigator.clipboard.writeText(link);
    toast('Ссылка скопирована. Откройте её на другом устройстве.');
  } catch (_) {
    const input = document.createElement('textarea');
    input.value = link;
    input.style.position = 'fixed';
    input.style.left = '-9999px';
    document.body.append(input);
    input.select();
    let copied = false;
    try { copied = document.execCommand('copy'); } catch (_) { /* Fallback below. */ }
    input.remove();
    if (copied) toast('Ссылка скопирована.');
    else window.prompt('Скопируйте ссылку на комнату:', link);
  }
}

$('choose-host').addEventListener('click', () => void chooseRole('host'));
$('choose-viewer').addEventListener('click', () => void chooseRole('viewer'));
$('switch-role').addEventListener('click', async () => {
  try { localStorage.removeItem('barkodd.guest-active.v2'); } catch (_) {}
  bindings.role = null;
  saveBindings();
  await showWelcome();
  window.scrollTo({ top: 0, behavior: 'smooth' });
});
$('forget-binding').addEventListener('click', async () => {
  bindings = emptyBindings();
  try { localStorage.removeItem(GUEST_STORAGE_KEY); } catch (_) {}
  saveBindings();
  await showWelcome();
  toast('Привязки удалены из этого браузера. Ссылки на комнаты продолжают действовать.');
});
$('host-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!auth.user || identityBusy) return;
  const actor = authActor();
  const navigation = navigationSequence;
  const name = $('room-name').value.trim();
  if (!name) { showError('Дайте комнате название.', true); return; }
  const button = event.currentTarget.querySelector('button');
  button.disabled = true;
  showError('', true);
  try {
    const result = await request('api/rooms', { method: 'POST', body: { name } });
    if (!sameActor(actor) || navigation !== navigationSequence) return;
    if (result.ownerId !== actor.id) { await refreshAuth(); return; }
    await openRoom('host', { id: result.id, account: true, viewerToken: result.viewerToken }, actor);
  } catch (error) {
    if (!sameActor(actor) || navigation !== navigationSequence) return;
    if (error.status === 401) await refreshAuth();
    if (sameActor(actor) && navigation === navigationSequence) showError(error.message, !active);
  }
  finally { button.disabled = false; }
});
$('approval-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (active?.role !== 'host') return;
  const current = generation;
  try {
    await request(`api/rooms/${encodeURIComponent(active.binding.id)}/approval`, { method: 'POST', body: {} });
    if (current === generation) { await pollRoom(current); toast('Комната подтверждена владельцем.'); }
  } catch (error) { if (current === generation) showError(error.message); }
});
$('delete-room').addEventListener('click', async () => {
  if (active?.role !== 'host') return;
  if (!window.confirm('Удалить комнату, всю историю и фотографии? Ссылки перестанут работать. Это действие нельзя отменить.')) return;
  const current = generation;
  const { id } = active.binding;
  const button = $('delete-room');
  button.disabled = true;
  try {
    await monitor?.stopHost();
    if (current !== generation) return;
    const result = await request(`api/rooms/${encodeURIComponent(id)}`, { method: 'DELETE' });
    delete bindings.rooms[id];
    for (const role of ['host', 'viewer']) { if (bindings[role]?.id === id) bindings[role] = null; }
    if (!bindings[bindings.role]) bindings.role = null;
    saveBindings();
    if (current === generation) {
      await showWelcome();
      toast(result.cleanupPending ? 'Доступ к комнате закрыт. Сервер повторит очистку фотографий.' : 'Комната, история и фотографии удалены.');
    }
  } catch (error) { if (current === generation) showError(error.message); }
  finally { button.disabled = false; }
});
$('viewer-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  try { const binding = parsePairingLink($('viewer-link').value.trim()); $('viewer-link').value = ''; await openRoom('viewer', binding); }
  catch (error) { showError(error.message, true); }
});
$('capture-button').addEventListener('click', () => void toggleCapture());
$('sensitivity').addEventListener('input', () => { settingsDirty = true; renderSensitivity(); $('settings-feedback').textContent = 'Есть несохранённые изменения'; });
$('snapshot-interval').addEventListener('change', () => { settingsDirty = true; $('settings-feedback').textContent = 'Есть несохранённые изменения'; });
$('settings-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!api || !active || active.role !== 'host') return;
  const current = generation;
  $('save-settings').disabled = true;
  try {
    const threshold = Number((0.5 * Math.pow(0.01, (Number($('sensitivity').value) - 1) / 99)).toFixed(5));
    const settings = await api.put('/settings', { threshold, snapshotIntervalMs: Number($('snapshot-interval').value) });
    if (current !== generation) return;
    if (room) room.settings = settings;
    monitor.updateSettings(settings);
    settingsDirty = false;
    $('settings-feedback').textContent = 'Настройки сохранены';
    toast('Настройки наблюдения сохранены');
  } catch (error) { if (current === generation) showError(error.message); }
  finally { $('save-settings').disabled = false; }
});
$('copy-link').addEventListener('click', () => void copyLink());
$('regenerate-key').addEventListener('click', async () => {
  if (!api || !active || active.role !== 'host') return;
  if (!window.confirm('Создать новую гостевую ссылку? Все прежние ссылки и QR-коды перестанут работать.')) return;
  const current = generation;
  $('regenerate-key').disabled = true;
  try {
    const result = await api.post('/pairing', {});
    if (current !== generation) return;
    active.binding.viewerToken = result.viewerToken;
    bindings.host = active.binding;
    saveBindings();
    await loadPairingQR();
    toast('Новая ссылка готова. Старая больше не действует.');
  } catch (error) { if (current === generation) showError(error.message); }
  finally { $('regenerate-key').disabled = false; }
});
$('more-events').addEventListener('click', () => { historyLimit += 12; if (room) renderHistory(); });
$('latest-photo-button').addEventListener('click', () => { if (latestPhoto) void openPhoto(latestPhoto); });
$('close-photo').addEventListener('click', () => $('photo-dialog').close());
$('photo-dialog').addEventListener('click', (event) => { if (event.target === $('photo-dialog')) $('photo-dialog').close(); });
if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) navigator.mediaDevices.addEventListener('devicechange', () => void loadDevices());
window.addEventListener('pagehide', () => { clearLiveFrame(); if (monitor) void monitor.destroy(); });
window.addEventListener('pageshow', (event) => {
  if (event.persisted && active) void openRoom(active.role, active.binding);
});

$('login-toggle').addEventListener('click', () => { authView = 'login'; renderAccount(); });
$('register-toggle').addEventListener('click', () => { authView = 'register'; renderAccount(); });
$('admin-login-toggle').addEventListener('click', () => { authView = 'admin'; renderAccount(); });
$('code-form').addEventListener('submit', event => { event.preventDefault(); void authenticate(event.currentTarget, 'api/auth/login', { code: $('login-code').value }); });
$('login-form').addEventListener('submit', event => { event.preventDefault(); void authenticate(event.currentTarget, 'api/auth/login', { username: $('login-username').value, password: $('login-password').value }); });
$('register-form').addEventListener('submit', event => {
  event.preventDefault();
  if ($('register-password').value !== $('register-confirm').value) { showError('Пароли не совпадают.', true); return; }
  void authenticate(event.currentTarget, 'api/auth/register', { username: $('register-username').value, password: $('register-password').value });
});
$('refresh-rooms').addEventListener('click', () => void loadRooms());
$('logout').addEventListener('click', async () => {
  if (identityBusy || !auth.user) return;
  const actor = beginIdentityChange();
  setIdentityBusy(true);
  // Stop local capture immediately; the server revokes this session independently.
  const teardown = releaseRoom();
  try {
    await request('api/auth/logout', { method: 'POST', body: {}, actorID: actor.id });
    await teardown;
    if (sameActor(actor)) await loseAccount('Вы вышли из аккаунта.', actor);
  } catch (error) { if (sameActor(actor)) await showWelcome(error.message); }
  finally { setIdentityBusy(false); }
});
$('password-toggle').addEventListener('click', async () => {
  const actor = authActor();
  if (active) await showWelcome();
  if (sameActor(actor)) $('password-panel').hidden = !$('password-panel').hidden;
});
$('password-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (identityBusy || !auth.user) return;
  const body = { currentPassword: $('current-password').value, newPassword: $('new-password').value };
  $('current-password').value = ''; $('new-password').value = '';
  const actor = beginIdentityChange();
  setIdentityBusy(true);
  try {
    await request('api/auth/password', { method: 'POST', body, actorID: actor.id });
    if (sameActor(actor)) await loseAccount('Пароль изменён. Войдите с новым паролем.', actor);
  } catch (error) { if (sameActor(actor)) showError(error.message, true); }
  finally { setIdentityBusy(false); }
});
async function loadUsers() {
  const actor = authActor();
  const navigation = navigationSequence;
  const current = () => sameActor(actor) && navigation === navigationSequence;
  const data = await request('api/admin/users');
  if (!actor.id || !current()) return;
  $('users-list').replaceChildren();
  for (const user of data.users.filter(user => user.role === 'user')) {
    const card = textElement('article', 'user-card', '');
    card.append(textElement('h3', '', user.username), textElement('p', 'field-hint', user.disabled ? 'Учётная запись заблокирована' : 'Учётная запись активна'));
    const toggle = textElement('button', 'button button-secondary', user.disabled ? 'Разблокировать' : 'Заблокировать');
    toggle.type = 'button';
    toggle.addEventListener('click', async () => {
      if (!current()) return;
      toggle.disabled = true;
      try { await request(`api/admin/users/${encodeURIComponent(user.id)}`, { method: 'PUT', body: { disabled: !user.disabled }, actorID: actor.id }); if (current()) await loadUsers(); }
      catch (error) { if (current()) { showError(error.message, true); toggle.disabled = false; } }
    });
    const form = textElement('form', 'input-action', '');
    const input = document.createElement('input');
    input.type = 'password'; input.minLength = 12; input.maxLength = 256; input.required = true; input.autocomplete = 'new-password'; input.placeholder = 'Новый пароль'; input.setAttribute('aria-label', `Новый пароль для ${user.username}`);
    const reset = textElement('button', 'button button-secondary', 'Сбросить пароль'); reset.type = 'submit';
    form.append(input, reset);
    form.addEventListener('submit', async event => {
      event.preventDefault();
      if (!current()) return;
      const password = input.value; input.value = ''; reset.disabled = true;
      try { await request(`api/admin/users/${encodeURIComponent(user.id)}/password`, { method: 'POST', body: { password }, actorID: actor.id }); if (current()) toast('Пароль сброшен. Сессии пользователя завершены.'); }
      catch (error) { if (current()) showError(error.message, true); }
      finally { if (current()) reset.disabled = false; }
    });
    card.append(toggle, form); $('users-list').append(card);
  }
}
$('users-toggle').addEventListener('click', async () => {
  const actor = authActor();
  $('users-panel').hidden = !$('users-panel').hidden;
  if (!$('users-panel').hidden) try { await loadUsers(); } catch (error) { if (sameActor(actor)) showError(error.message, true); }
});

function readSavedGuest() {
  try {
    if (localStorage.getItem('barkodd.guest-active.v2') !== 'true') return null;
    const binding = JSON.parse(localStorage.getItem(GUEST_STORAGE_KEY) || '{}').viewer;
    return binding && /^[a-zA-Z0-9_-]{1,128}$/.test(binding.id) && typeof binding.viewerToken === 'string' ? { id: binding.id, viewerToken: binding.viewerToken } : null;
  } catch (_) { return null; }
}

function migrateLegacyBindings() {
  const key = 'barkodd.binding.v1';
  let legacy;
  try { legacy = JSON.parse(localStorage.getItem(key) || 'null'); } catch (_) { return; }
  if (!legacy) return;
  const safe = entry => entry && typeof entry.id === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(entry.id) && typeof entry.viewerToken === 'string' && entry.viewerToken.length > 0 && entry.viewerToken.length <= 256;
  const clean = entry => ({ id: entry.id, viewerToken: entry.viewerToken });
  const recovery = { role: legacy.role === 'viewer' ? 'viewer' : null };
  let copied = true;
  if (safe(legacy.host)) {
    recovery.host = clean(legacy.host);
    try {
      const accountKey = 'barkodd.account.v2.owner';
      let saved;
      try { saved = JSON.parse(localStorage.getItem(accountKey) || '{}'); } catch (_) { saved = {}; }
      if (!saved || typeof saved !== 'object' || Array.isArray(saved)) saved = {};
      if (!saved.rooms || typeof saved.rooms !== 'object' || Array.isArray(saved.rooms)) saved.rooms = {};
      const existing = saved.rooms[legacy.host.id];
      if (!existing?.viewerToken) saved.rooms[legacy.host.id] = { ...clean(legacy.host), account: true };
      else if (existing.viewerToken !== legacy.host.viewerToken) copied = false;
      localStorage.setItem(accountKey, JSON.stringify(saved));
    } catch (_) { copied = false; }
  }
  if (safe(legacy.viewer)) {
    recovery.viewer = clean(legacy.viewer);
    try {
      const existing = localStorage.getItem(GUEST_STORAGE_KEY);
      if (!existing) localStorage.setItem(GUEST_STORAGE_KEY, JSON.stringify({ role: 'viewer', viewer: clean(legacy.viewer) }));
      else if (JSON.parse(existing).viewer?.viewerToken !== legacy.viewer.viewerToken) copied = false;
      if (legacy.role === 'viewer') localStorage.setItem('barkodd.guest-active.v2', 'true');
    } catch (_) { copied = false; }
  }
  try {
    if (copied) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(recovery));
  } catch (_) { /* Keep the sole recoverable viewer key if storage is unavailable. */ }
}

async function initialize() {
  const actor = authActor();
  migrateLegacyBindings();
  try {
    const state = await request('api/auth');
    if (!sameActor(actor)) return;
    beginIdentityChange(); auth = state; bindings = readBindings(); renderAccount();
  }
  catch (error) { await showWelcome(error.message); return; }
  if (!authTimer) authTimer = setInterval(() => void refreshAuth(), 10000);
  if (location.hash.includes('room=') || location.hash.includes('key=')) {
    try {
      const binding = parsePairingLink(location.href);
      history.replaceState(null, '', location.pathname);
      await openRoom('viewer', binding);
    } catch (error) { await showWelcome(error.message); }
  } else if (readSavedGuest()) {
    await openRoom('viewer', readSavedGuest());
  } else if (bindings.role && bindings[bindings.role]?.account) {
    await openRoom(bindings.role, bindings[bindings.role]);
  } else {
    await showWelcome();
    if (new URLSearchParams(location.search).get('role') === 'viewer') await chooseRole('viewer');
  }
}

void initialize();
