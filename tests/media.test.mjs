import { strict as assert } from 'assert';
import { createMonitor } from '../web/media.js';

// Only browser and HTTP boundaries are fake; monitor and noise qualification are real.
function target(properties = {}) {
  const listeners = new Map();
  return Object.assign(properties, {
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(listener);
    },
    removeEventListener(type, listener) { listeners.get(type)?.delete(listener); },
    dispatchEvent(event) {
      this[`on${event.type}`]?.(event);
      for (const listener of listeners.get(event.type) || []) listener(event);
    },
  });
}

function eventResult(body, photoAt = body.photoAt ?? null) {
  return { id: body.episodeId, startedAt: body.detectedAt, lastNoiseAt: body.detectedAt, photoAt, hasPhoto: !!photoAt, level: body.level };
}

function environment({ muted = false, enabled = true, audioLevel = 0.25, videoReady = false, encodeDelay = 0, frameBytes = 12000, deferredMedia = false, deferredWake = false, rtc = false } = {}) {
  const originals = new Map();
  const replace = (name, value) => {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  };
  let time = 0;
  let wallClockOffset = 0;
  let nextTimer = 0;
  const timers = new Map();
  const levels = [];
  const posts = [];
  const errors = [];
  const statuses = [];
  const frames = [];
  const sockets = [];
  const encodes = [];
  const canvases = [];
  const videos = [];
  const peers = [];
  const localStreams = [];
  const transports = [];
  const remoteStreams = [];
  const audioStatuses = [];
  const playbacks = [];
  const worklets = [];
  const mediaConstraints = [];
  const calibrations = [];
  const inputStatuses = [];
  let mediaRequests = 0;
  let pendingMedia, rejectMedia;
  let pendingWake;
  let releasedLocks = 0;
  let heartbeatResponse = () => Promise.resolve();
  let eventResponse = body => Promise.resolve(eventResult(body));
  let snapshotResponse = () => 'data:image/jpeg;base64,/9j/2Q==';
  let resumeResponse = null;
  let audioPlayResponse = () => Promise.resolve();
  const wakeLock = target({ release() { releasedLocks++; this.dispatchEvent({ type: 'release' }); return Promise.resolve(); } });
  class FrameBlob {
    constructor(parts = [], { type = '' } = {}) { this.size = parts.reduce((size, part) => size + (part.byteLength ?? part.size ?? part.length), 0); this.type = type; }
  }
  replace('Blob', FrameBlob);
  class Socket {
    constructor(url) { this.url = url; this.readyState = 0; this.bufferedAmount = 0; this.sent = []; sockets.push(this); }
    send(data) { assert.equal(this.readyState, 1); this.sent.push({ data, at: time }); }
    close(code = 1000) { this.readyState = 3; this.closeCode = code; this.onclose?.({ code }); }
    open() { this.readyState = 1; this.onopen?.(); }
    receive(data) { this.onmessage?.({ data: typeof data === 'object' && !(data instanceof FrameBlob) && !(data instanceof ArrayBuffer) ? JSON.stringify(data) : data }); }
    binary() { return this.sent.filter(item => item.data instanceof FrameBlob); }
  }
  replace('WebSocket', Socket);
  const track = kind => target({
    kind, enabled: kind === 'audio' ? enabled : true, muted: kind === 'audio' && muted, readyState: 'live',
    stop() { this.readyState = 'ended'; },
    getSettings() { return { deviceId: `fake-${kind}` }; },
  });
  const microphone = track('audio');
  const camera = track('video');
  const stream = {
    getTracks: () => [camera, microphone],
    getAudioTracks: () => [microphone],
    getVideoTracks: () => [camera],
  };
  const node = () => ({ connect() {}, disconnect() {} });
  let audioContext;
  class AudioContext {
    constructor() { target(this); this.state = 'running'; this.sampleRate = 48000; this.destination = node(); this.audioWorklet = { addModule: async () => {} }; audioContext = this; }
    get currentTime() { return time / 1000; }
    createMediaStreamSource() { return node(); }
    createGain() { return { ...node(), gain: { value: 1 } }; }
    createBuffer(channels, length, rate) { const data = new Float32Array(length); return { duration: length / rate, copyToChannel(samples) { data.set(samples); }, getChannelData: () => data }; }
    createBufferSource() { const source = { ...node(), start(at) { this.at = at; playbacks.push(this); }, stop() { this.stopped = true; } }; return source; }
    createAnalyser() {
      // Retained samples must not become an event while their input is muted.
      return { ...node(), getFloatTimeDomainData: samples => samples.fill(audioLevel) };
    }
    resume() { this.state = 'running'; return resumeResponse ? resumeResponse(this) : Promise.resolve(); }
    close() { this.state = 'closed'; return Promise.resolve(); }
  }
  replace('AudioWorkletNode', class {
    constructor() { this.port = { onmessage: null, postMessage() {}, close() {} }; worklets.push(this); }
    connect() {} disconnect() {}
  });
  replace('setTimeout', (callback, delay = 0) => {
    const id = ++nextTimer;
    timers.set(id, { at: time + delay, callback });
    return id;
  });
  replace('clearTimeout', id => timers.delete(id));
  replace('performance', { now: () => time });
  const NativeDate = Date;
  const startedAt = NativeDate.UTC(2026, 0, 1);
  replace('Date', class extends NativeDate {
    constructor(...args) { super(...(args.length ? args : [startedAt + time + wallClockOffset])); }
    static now() { return startedAt + time + wallClockOffset; }
  });
  replace('navigator', {
    mediaDevices: { getUserMedia: constraints => {
      mediaRequests++;
      mediaConstraints.push(constraints);
      if (!deferredMedia) return Promise.resolve(stream);
      return new Promise((resolve, reject) => { pendingMedia = resolve; rejectMedia = reject; });
    } },
    wakeLock: { request: () => deferredWake ? new Promise(resolve => { pendingWake = resolve; }) : Promise.resolve(wakeLock) },
  });
  replace('AudioContext', AudioContext);
  replace('MediaStream', class {
    constructor(tracks = []) { this.tracks = [...tracks]; }
    addTrack(track) { this.tracks.push(track); }
    removeTrack(track) { this.tracks = this.tracks.filter(item => item !== track); }
    getAudioTracks() { return this.tracks.filter(track => track.kind === 'audio'); }
    getTracks() { return this.tracks; }
  });
  class Peer {
    constructor() { this.tracks = []; peers.push(this); }
    addTrack(track) { this.tracks.push(track); }
    async createOffer() { return { type: 'offer', sdp: 'host-offer' }; }
    async createAnswer() { return { type: 'answer', sdp: 'viewer-answer' }; }
    async setLocalDescription(description) { this.localDescription = description; }
    async setRemoteDescription(description) { this.remoteDescription = description; }
    async addIceCandidate() {}
    close() { this.closed = true; }
  }
  replace('RTCPeerConnection', rtc ? Peer : undefined);
  replace('document', target({
    visibilityState: 'visible',
    createElement(name) {
      if (name === 'canvas') {
        const canvas = {
          width: 0, height: 0,
          getContext: () => ({ drawImage() {} }),
          toDataURL: () => snapshotResponse(),
          toBlob(callback, type, quality) {
            encodes.push({ canvas, width: canvas.width, height: canvas.height, quality, at: time });
            const size = typeof frameBytes === 'function' ? frameBytes({ quality, width: canvas.width, height: canvas.height }) : frameBytes;
            const done = () => callback(new FrameBlob([new Uint8Array(size)], { type }));
            if (encodeDelay) setTimeout(done, encodeDelay); else done();
          },
        };
        canvases.push(canvas);
        return canvas;
      }
      assert.ok(name === 'video' || name === 'audio');
      const element = {
        readyState: videoReady ? 4 : 0, videoWidth: videoReady ? 1920 : 0, videoHeight: videoReady ? 1080 : 0,
        play: () => name === 'audio' ? audioPlayResponse() : Promise.resolve(),
        pause() {},
      };
      if (name === 'video') videos.push(element);
      return element;
    },
  }));
  const monitor = createMonitor({
    api: {
      streamURL: 'wss://example.test/barkodd/api/rooms/room-id/stream', token: 'secret-key',
      get: async () => ({ signals: [], cursor: 0, pairingVersion: 1 }),
      post: async (path, body) => {
        posts.push({ path, body: { ...body }, at: time });
        if (path === '/heartbeat' && !body.stopped) return heartbeatResponse(body);
        if (path === '/events') return eventResponse(body);
      },
    },
    onLevel: level => levels.push(level),
    onLocalStream: stream => localStreams.push(stream),
    onTransport: mode => transports.push(mode),
    onRemoteStream: stream => remoteStreams.push(stream),
    onFrame: frame => frames.push(frame),
    onError: error => errors.push(error),
    onStatus: status => statuses.push(status),
    onAudioStatus: status => audioStatuses.push(status),
    onCalibration: status => calibrations.push(status),
    onInputStatus: status => inputStatuses.push(status),
  });
  // Drain chained async API callbacks between each virtual timer.
  const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
  const advance = async duration => {
    const end = time + duration;
    await settle();
    while (true) {
      const next = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      timers.delete(next[0]);
      time = next[1].at;
      next[1].callback();
      await settle();
    }
    time = end;
    await settle();
  };
  return {
    monitor, levels, posts, errors, statuses, frames, sockets, encodes, canvases, peers, localStreams, transports, remoteStreams, stream, advance, settle, audioStatuses, playbacks, worklets, mediaConstraints, calibrations, inputStatuses,
    mediaRequests: () => mediaRequests,
    openSocket(role) {
      assert.ok(sockets.length > 0, 'monitor must connect to the WebSocket endpoint');
      const socket = sockets[sockets.length - 1];
      socket.open();
      socket.receive({ type: 'ready', role });
      return socket;
    },
    onHeartbeat(callback) { heartbeatResponse = callback; },
    onEvent(callback) { eventResponse = callback; },
    onSnapshot(callback) { snapshotResponse = callback; },
    onResume(callback) { resumeResponse = callback; },
    onAudioPlay(callback) { audioPlayResponse = callback; },
    resolveMedia() { pendingMedia(stream); },
    denyMedia() { rejectMedia(Object.assign(new Error('permission denied'), { name: 'NotAllowedError' })); },
    resolveWake() { pendingWake(wakeLock); },
    releasedLocks: () => releasedLocks,
    timerCount: () => timers.size,
    shiftWallClock(duration) { wallClockOffset += duration; },
    setEnabled(value) { microphone.enabled = value; },
    setAudioLevel(value) { audioLevel = value; },
    setVideoReady(value) {
      for (const video of videos) Object.assign(video, { readyState: value ? 4 : 0, videoWidth: value ? 1920 : 0, videoHeight: value ? 1080 : 0 });
    },
    setAudioState(value) { audioContext.state = value; },
    transitionAudio(value) { audioContext.state = value; audioContext.onstatechange?.(); },
    setMuted(value) {
      microphone.muted = value;
      microphone.dispatchEvent({ type: value ? 'mute' : 'unmute' });
    },
    async cleanup() {
      try { await monitor.destroy(); }
      finally {
        for (const [name, descriptor] of originals) {
          if (descriptor) Object.defineProperty(globalThis, name, descriptor);
          else delete globalThis[name];
        }
      }
    },
  };
}

let passed = 0;
let failed = 0;
async function test(name, options, run) {
  const env = environment(options);
  try {
    await run(env);
    assert.deepEqual(env.errors, [], 'the monitor must not report unexpected errors');
    passed++;
    console.log(`ok - ${name}`);
  } catch (error) {
    failed++;
    console.error(`not ok - ${name}\n${error.stack}`);
  } finally { await env.cleanup(); }
}

for (const mode of ['environment', 'user']) {
  await test(`host can request the ${mode} camera without an enumerated device ID`, {}, async env => {
    await env.monitor.startHost({ videoFacingMode: mode, audioDeviceId: 'selected-microphone' });
    const { video, audio } = env.mediaConstraints[0];
    assert.deepEqual(video.facingMode, { exact: mode });
    assert.equal(video.deviceId, undefined, 'facing selection must not be restricted to the default camera ID');
    assert.deepEqual(audio.deviceId, { exact: 'selected-microphone' });
    assert.equal(env.localStreams[0], env.stream);
  });
}

await test('explicit camera ID takes precedence over facing preference', {}, async env => {
  await env.monitor.startHost({ videoDeviceId: 'external-camera', videoFacingMode: 'environment' });
  const { video } = env.mediaConstraints[0];
  assert.deepEqual(video.deviceId, { exact: 'external-camera' });
  assert.equal(video.facingMode, undefined, 'a selected USB camera need not report a facing mode');
});

await test('raising sensitivity detects quiet input live and preserves the measured event level', { audioLevel: 0.002 }, async env => {
  await env.monitor.startHost({ settings: { threshold: 0.003 } });
  await env.settle();
  env.openSocket('host');
  await env.advance(1000);
  assert.equal(env.posts.filter(post => post.path === '/events').length, 0);
  env.monitor.updateSettings({ threshold: 0.0005 });
  await env.advance(1000);
  const events = env.posts.filter(post => post.path === '/events');
  assert.ok(events.length > 0, 'quiet input must create an event without restarting capture');
  assert.ok(Math.abs(events[0].body.level - 0.002) < 0.000001, 'sensitivity must not amplify stored levels');
});

await test('calibration samples background without events or stream restart and only proposes a threshold', { audioLevel: 0.001 }, async env => {
  await env.monitor.startHost({ settings: { threshold: 0.0005 } });
  await env.settle();
  env.openSocket('host');
  assert.equal(typeof env.monitor.startCalibration, 'function', 'monitor must support explicit calibration');
  assert.equal(env.monitor.startCalibration(), true);
  assert.equal(env.monitor.startCalibration(), false, 'a second click must not restart the running measurement');
  await env.advance(4950);
  assert.equal(env.calibrations[env.calibrations.length - 1].kind, 'calibrating');
  assert.equal(env.posts.filter(post => post.path === '/events').length, 0);
  await env.advance(50);
  const result = env.calibrations[env.calibrations.length - 1];
  assert.equal(result.kind, 'complete');
  assert.ok(Math.abs(result.threshold - 0.002) < 0.000001);
  assert.equal(env.mediaRequests(), 1, 'calibration must reuse capture');
  assert.ok(env.stream.getTracks().every(track => track.readyState === 'live'));
  await env.advance(1100);
  assert.ok(env.posts.some(post => post.path === '/events'), 'old threshold still applies until explicitly saved');
  env.monitor.updateSettings({ threshold: result.threshold });
  await env.advance(1000);
  const count = env.posts.filter(post => post.path === '/events').length;
  await env.advance(1100);
  assert.equal(env.posts.filter(post => post.path === '/events').length, count, 'saved threshold must exclude the measured background');
  env.setAudioLevel(0.004);
  await env.advance(1100);
  assert.ok(env.posts.filter(post => post.path === '/events').length > count, 'sound above calibrated threshold still triggers');
});

await test('cancelled calibration preserves queued events and the next photo deadline', { audioLevel: 0.001, videoReady: true }, async env => {
  await env.monitor.startHost({ settings: { threshold: 0.0005, snapshotIntervalMs: 10000 } });
  await env.settle();
  await env.advance(200); // A real event is captured before the measurement starts.
  assert.equal(typeof env.monitor.startCalibration, 'function');
  assert.equal(env.monitor.startCalibration(), true);
  env.openSocket('host');
  await env.advance(4800);
  const uploads = () => env.posts.filter(post => post.path === '/events');
  assert.equal(uploads().length, 1, 'preexisting event is delivered while calibration suppresses new events');
  assert.equal(uploads()[0].body.photoAt, '2026-01-01T00:00:00.150Z');
  env.monitor.cancelCalibration();
  assert.equal(env.calibrations[env.calibrations.length - 1].kind, 'cancelled');
  await env.advance(5000);
  assert.equal(uploads().filter(post => post.body.photo).length, 1, 'calibration must not reset the photo cooldown');
  await env.advance(600);
  assert.equal(uploads().filter(post => post.body.photo).length, 2);
  const nextPhotoAt = Date.parse(uploads().filter(post => post.body.photo)[1].body.photoAt);
  assert.ok(nextPhotoAt >= Date.parse('2026-01-01T00:00:10.150Z'));
  assert.ok(nextPhotoAt < Date.parse('2026-01-01T00:00:11.150Z'), 'next sample/update window must capture the due photo');
});

for (const interruption of ['mute', 'suspend', 'hide', 'stop']) {
  await test(`calibration interruption (${interruption}) cannot complete with stale or unavailable input`, { audioLevel: 0.001 }, async env => {
    assert.equal(typeof env.monitor.startCalibration, 'function');
    assert.equal(env.monitor.startCalibration(), false, 'stopped capture cannot calibrate');
    await env.monitor.startHost();
    assert.equal(env.monitor.startCalibration(), true);
    await env.advance(1000);
    if (interruption === 'mute') env.setMuted(true);
    if (interruption === 'suspend') env.setAudioState('suspended');
    if (interruption === 'hide') { document.visibilityState = 'hidden'; document.dispatchEvent({ type: 'visibilitychange' }); }
    if (interruption === 'stop') await env.monitor.stopHost();
    await env.advance(5000);
    assert.ok(['cancelled', 'error'].includes(env.calibrations[env.calibrations.length - 1].kind));
    assert.equal(env.calibrations.filter(result => result.kind === 'complete').length, 0);
    if (interruption === 'mute') env.setMuted(false);
    if (interruption === 'suspend') env.setAudioState('running');
    if (interruption === 'hide') document.visibilityState = 'visible';
    if (interruption === 'stop') {
      // This fixture returns the same synthetic stream on every getUserMedia call.
      // Model newly opened physical tracks before restarting the real monitor.
      for (const track of env.stream.getTracks()) track.readyState = 'live';
      await env.monitor.startHost();
    }
    assert.equal(env.monitor.startCalibration(), true, 'a fresh measurement is possible after recovery');
    await env.advance(5000);
    assert.equal(env.calibrations[env.calibrations.length - 1].kind, 'complete');
  });
}

await test('local input availability recovers offline so calibration does not depend on a server heartbeat', { audioLevel: 0.001 }, async env => {
  env.onHeartbeat(() => Promise.reject(new Error('test server offline')));
  await env.monitor.startHost();
  await env.settle();
  assert.ok(env.inputStatuses.some(state => state.available), 'working local input must be available without a heartbeat');
  env.setMuted(true);
  await env.advance(100);
  assert.equal(env.inputStatuses[env.inputStatuses.length - 1].available, false);
  env.setMuted(false);
  await env.advance(100);
  assert.equal(env.inputStatuses[env.inputStatuses.length - 1].available, true, 'unmute must enable local calibration while server is still offline');
  assert.equal(env.monitor.startCalibration(), true);
  await env.advance(5000);
  assert.equal(env.calibrations[env.calibrations.length - 1].kind, 'complete');
  await env.monitor.stopHost();
  assert.equal(env.inputStatuses[env.inputStatuses.length - 1].available, false);
  assert.ok(env.errors.length > 0 && env.errors.every(error => error.message === 'test server offline'));
  env.errors.length = 0;
});

await test('a live muted microphone reports monitoring=false and recovers on unmute', { muted: true }, async env => {
  await env.monitor.startHost();
  await env.settle();
  const heartbeats = () => env.posts.filter(post => post.path === '/heartbeat');
  const lastHeartbeat = () => heartbeats()[heartbeats().length - 1].body;
  assert.ok(heartbeats().length > 0, 'host must send a heartbeat');
  assert.equal(lastHeartbeat().monitoring, false, 'a live but muted microphone is not monitoring');
  await env.advance(5100);
  assert.match(env.statuses[env.statuses.length - 1].message, /браузер.*микрофон|микрофон.*браузер/i, 'status must identify the browser-muted input');
  assert.notEqual(env.statuses[env.statuses.length - 1].kind, 'monitoring', 'heartbeats must not replace the microphone warning');
  env.setMuted(false);
  await env.advance(5100);
  assert.equal(lastHeartbeat().monitoring, true, 'unmuting must restore monitoring without restarting');
});

await test('muted input cannot turn retained analyser data into noise; unmute resumes detection', { muted: true }, async env => {
  await env.monitor.startHost();
  await env.advance(1100);
  const events = () => env.posts.filter(post => post.path === '/events');
  assert.equal(events().length, 0, 'muted input must not upload false noise events from a retained waveform');
  assert.ok(env.levels.length > 0 && env.levels.every(level => level === 0), 'muted input must show zero microphone level');
  env.setMuted(false);
  await env.advance(5100);
  env.openSocket('host');
  await env.advance(600);
  assert.ok(env.levels.some(level => level > 0.2), 'unmuting must restore live microphone levels');
  assert.ok(events().length > 0, 'sustained sound after unmute must produce a noise event');
});

async function assertUnavailableThenRecovered(env, recover) {
  await env.advance(5100);
  assert.equal(env.posts.filter(post => post.path === '/events').length, 0, 'unavailable input must not upload false noise events');
  assert.ok(env.levels.length > 0 && env.levels.every(level => level === 0), 'unavailable input must report zero level');
  const heartbeats = () => env.posts.filter(post => post.path === '/heartbeat');
  assert.ok(heartbeats().length > 0, 'host must continue reporting its state');
  assert.equal(heartbeats()[heartbeats().length - 1].body.monitoring, false, 'unavailable input must not be reported as monitoring');
  assert.notEqual(env.statuses[env.statuses.length - 1].kind, 'monitoring', 'normal heartbeats must not hide input failure');
  recover();
  await env.advance(5100);
  env.openSocket('host');
  await env.advance(600);
  assert.ok(env.levels.some(level => level > 0.2), 'available input must resume sampling');
  assert.ok(env.posts.some(post => post.path === '/events'), 'available input must resume noise events');
  assert.equal(heartbeats()[heartbeats().length - 1].body.monitoring, true, 'available input must resume monitoring');
}

await test('disabled microphone stops noise and monitoring, then recovers when enabled', { enabled: false }, async env => {
  await env.monitor.startHost();
  await env.settle();
  await assertUnavailableThenRecovered(env, () => {
    assert.match(env.statuses[env.statuses.length - 1].message, /выключен|отключен/i, 'status must identify the disabled input');
    env.setEnabled(true);
  });
});

await test('suspended audio rejects retained samples and recovers when resumed', {}, async env => {
  await env.monitor.startHost();
  await env.settle();
  env.setAudioState('suspended');
  env.levels.length = 0;
  env.posts.length = 0;
  await assertUnavailableThenRecovered(env, () => {
    assert.match(env.statuses[env.statuses.length - 1].message, /приостановил|приостановлен/i, 'status must identify suspended audio');
    env.setAudioState('running');
  });
});

await test('host activates audio during the start click before permission resolves', { deferredMedia: true }, async env => {
  let inGesture = true;
  env.onResume(audio => {
    if (inGesture) return Promise.resolve();
    audio.state = 'suspended';
    return new Promise(() => {});
  });
  void env.monitor.startHost();
  inGesture = false;
  env.resolveMedia();
  await env.settle();
  assert.equal(env.posts.find(post => post.path === '/heartbeat')?.body.monitoring, true, 'permission delay must not leave the host without active audio');
  assert.ok(env.levels.some(level => level > 0));
});

await test('a pending audio resume exposes the suspended input and leaves host controls available', {}, async env => {
  let finished = false;
  env.onResume(audio => {
    audio.state = 'suspended';
    return new Promise(() => {});
  });
  void env.monitor.startHost().then(() => { finished = true; });
  await env.settle();
  assert.equal(finished, true, 'startup must not wait indefinitely for browser audio');
  assert.equal(env.statuses[env.statuses.length - 1].kind, 'error');
  assert.match(env.statuses[env.statuses.length - 1].message, /приостановил|приостановлен/i);
  assert.equal(env.posts.find(post => post.path === '/heartbeat')?.body.monitoring, false);
  env.setAudioState('running');
  await env.advance(5000);
  assert.equal(env.posts.filter(post => post.path === '/heartbeat').pop().body.monitoring, true);
  assert.equal(env.sockets.length, 1);
});

await test('denied device permission closes the host audio context while resume is pending', { deferredMedia: true }, async env => {
  let context;
  env.onResume(audio => {
    context = audio;
    return new Promise(() => {});
  });
  const starting = env.monitor.startHost();
  env.denyMedia();
  await assert.rejects(starting, /доступ к камере и микрофону/i);
  assert.equal(env.errors.length, 1);
  env.errors.length = 0;
  assert.equal(context?.state, 'closed', 'permission denial must release audio resources opened on click');
});


await test('an unready camera retries on the next noise update and successful photos respect the configured interval', {}, async env => {
  await env.monitor.startHost({ settings: { snapshotIntervalMs: 10000 } });
  await env.settle();
  env.openSocket('host');
  const events = () => env.posts.filter(post => post.path === '/events');
  const photos = () => events().filter(post => post.body.photo);
  await env.advance(500);
  assert.equal(events().length, 1, 'noise must still be reported while the camera starts');
  assert.equal(photos().length, 0);
  env.setVideoReady(true);
  await env.advance(1000);
  assert.equal(photos().length, 1, 'the next qualified update must upload a photo instead of waiting the full interval');
  assert.equal(photos()[0].body.photo, 'data:image/jpeg;base64,/9j/2Q==');
  assert.ok(photos()[0].body.photoAt);
  await env.advance(9500);
  assert.equal(photos().length, 1, 'successful capture must start the configured cooldown');
  await env.advance(1500);
  assert.equal(photos().length, 2, 'continued noise must upload the next photo after ten seconds');
});

await test('working camera groups separated bursts inside the interval and the next episode includes a photo', { videoReady: true }, async env => {
  await env.monitor.startHost({ settings: { snapshotIntervalMs: 10000 } });
  await env.settle();
  env.openSocket('host');
  const events = () => env.posts.filter(post => post.path === '/events');
  await env.advance(500);
  const first = events()[0].body;
  assert.ok(first.photo);
  env.setAudioLevel(0);
  await env.advance(5000);
  env.setAudioLevel(0.25);
  await env.advance(500);
  assert.equal(events().length, 2, 'each sustained burst must still report its noise');
  assert.equal(events()[1].body.episodeId, first.episodeId, 'a pause must not create an empty history card during the interval');
  env.setAudioLevel(0);
  await env.advance(5000);
  env.setAudioLevel(0.25);
  await env.advance(500);
  assert.equal(events().length, 3);
  assert.notEqual(events()[2].body.episodeId, first.episodeId);
  assert.ok(events()[2].body.photo, 'the first update of the next eligible episode must include its captured photo');
});

await test('a delayed photo confirmation during silence cannot postpone the next burst photo', { videoReady: true }, async env => {
  let confirm;
  env.onEvent(body => new Promise(resolve => { confirm = () => resolve(eventResult(body)); }));
  await env.monitor.startHost({ settings: { snapshotIntervalMs: 10000 } });
  await env.settle();
  env.openSocket('host');
  await env.advance(500);
  env.setAudioLevel(0);
  await env.advance(10000);
  confirm();
  env.onEvent(body => Promise.resolve(eventResult(body)));
  await env.settle();
  env.setAudioLevel(0.25);
  await env.advance(500);
  const events = env.posts.filter(post => post.path === '/events');
  assert.equal(events.length, 2);
  assert.ok(events[0].body.photo);
  assert.notEqual(events[1].body.episodeId, events[0].body.episodeId, 'the next burst must use the interval from local capture');
  assert.ok(events[1].body.photo, 'a late ACK cannot defer a locally eligible photo');
});

await test('a snapshot encoding error retries on the next qualified noise update', { videoReady: true }, async env => {
  env.onSnapshot(() => { throw new Error('Camera frame unavailable'); });
  await env.monitor.startHost();
  await env.settle();
  env.openSocket('host');
  await env.advance(500);
  assert.equal(env.errors.length, 1);
  assert.equal(env.errors.pop().message, 'Camera frame unavailable');
  assert.ok(env.posts.some(post => post.path === '/events' && !post.body.photo));
  env.onSnapshot(() => 'data:image/jpeg;base64,/9j/2Q==');
  await env.advance(1000);
  assert.ok(env.posts.some(post => post.path === '/events' && post.body.photo === 'data:image/jpeg;base64,/9j/2Q=='));
});

for (const previousPhotoAt of [null, '2025-12-31T23:59:50.000Z']) {
  await test(`HTTP success with ${previousPhotoAt ? 'an older' : 'no'} photo timestamp keeps the photo queued until accepted`, { videoReady: true }, async env => {
    let accepted = false;
    env.onEvent(body => Promise.resolve(eventResult(body, accepted ? body.photoAt : previousPhotoAt)));
    await env.monitor.startHost();
    await env.settle();
    env.openSocket('host');
    await env.advance(500);
    env.setAudioLevel(0);
    const uploads = () => env.posts.filter(post => post.path === '/events');
    const first = uploads()[0].body;
    assert.ok(first.photo);
    accepted = true;
    await env.advance(500);
    assert.equal(uploads().length, 2, 'a cooldown rejection must be retried by the serial upload loop');
    assert.deepEqual(uploads()[1].body, first, 'retry must retain the captured JPEG and its timestamp');
    await env.advance(500);
    assert.equal(uploads().length, 2, 'acceptance must remove the queued photo');
  });
}

await test('legacy photo acceptance leaves cooldown anchored to local capture', { videoReady: true }, async env => {
  let accept;
  env.onEvent(body => new Promise(resolve => { accept = () => resolve(eventResult(body)); }));
  await env.monitor.startHost({ settings: { snapshotIntervalMs: 10000 } });
  await env.settle();
  env.openSocket('host');
  await env.advance(2500);
  const photos = () => env.posts.filter(post => post.path === '/events' && post.body.photo);
  assert.equal(photos().length, 1);
  accept();
  env.onEvent(body => Promise.resolve(eventResult(body)));
  await env.settle();
  await env.advance(8000);
  assert.equal(photos().length, 2, 'a late ACK must not add its latency to the capture interval');
  assert.equal(Date.parse(photos()[1].body.photoAt) - Date.parse(photos()[0].body.photoAt), 10000);
});

for (const accepted of [false, true]) {
  await test(`a ${accepted ? 'confirmed' : 'rejected'} photo response preserves newer noise sampled during the request`, { videoReady: true }, async env => {
    let finish;
    env.onEvent(body => new Promise(resolve => { finish = () => resolve(eventResult(body, accepted ? body.photoAt : null)); }));
    await env.monitor.startHost();
    await env.settle();
    env.openSocket('host');
    await env.advance(500);
    env.setAudioLevel(0.4);
    await env.advance(1000);
    finish();
    env.onEvent(body => Promise.resolve(eventResult(body)));
    await env.settle();
    await env.advance(500);
    const uploads = env.posts.filter(post => post.path === '/events');
    assert.equal(uploads.length, 2);
    assert.ok(uploads[1].body.level > 0.39);
    assert.ok(Date.parse(uploads[1].body.detectedAt) > Date.parse(uploads[0].body.detectedAt));
    assert.equal(!!uploads[1].body.photo, !accepted, 'only a confirmed photo may be removed from the newer noise update');
  });
}

await test('confirming an older in-flight photo keeps a newer captured photo pending', { videoReady: true }, async env => {
  let finish;
  env.onEvent(body => new Promise(resolve => { finish = () => resolve(eventResult(body)); }));
  await env.monitor.startHost({ settings: { snapshotIntervalMs: 10000 } });
  await env.settle();
  env.openSocket('host');
  await env.advance(10500);
  finish();
  env.onEvent(body => Promise.resolve(eventResult(body)));
  await env.settle();
  await env.advance(1000);
  const uploads = env.posts.filter(post => post.path === '/events' && post.body.photo);
  assert.equal(uploads.length, 2);
  assert.ok(uploads[1].body.photo);
  assert.notEqual(uploads[1].body.episodeId, uploads[0].body.episodeId);
  assert.ok(Date.parse(uploads[1].body.photoAt) > Date.parse(uploads[0].body.photoAt));
});

for (const rejection of [
  { name: 'discarded event', response: () => ({ discarded: true }) },
  { name: 'discarded photo', response: body => ({ ...eventResult(body, null), photoDiscarded: true }) },
]) {
  await test(`a ${rejection.name} response removes the exact queued upload`, { videoReady: true }, async env => {
    env.onEvent(body => Promise.resolve(rejection.response(body)));
    await env.monitor.startHost();
    await env.settle();
    env.openSocket('host');
    await env.advance(500);
    env.setAudioLevel(0);
    await env.advance(1500);
    const uploads = env.posts.filter(post => post.path === '/events');
    assert.equal(uploads.length, 1, 'history clearing must permanently discard the outdated upload instead of retrying it');
    assert.ok(uploads[0].body.photo);
  });

  await test(`a ${rejection.name} response preserves newer noise without its matching old photo`, { videoReady: true }, async env => {
    let finish;
    env.onEvent(body => new Promise(resolve => { finish = () => resolve(rejection.response(body)); }));
    await env.monitor.startHost();
    await env.settle();
    env.openSocket('host');
    await env.advance(500);
    env.setAudioLevel(0.4);
    await env.advance(1000);
    env.setAudioLevel(0);
    finish();
    env.onEvent(body => Promise.resolve(eventResult(body)));
    await env.settle();
    await env.advance(500);
    const uploads = env.posts.filter(post => post.path === '/events');
    assert.equal(uploads.length, 2, 'the response must remove only the submitted noise update');
    assert.ok(uploads[0].body.photo);
    assert.equal(uploads[1].body.episodeId, uploads[0].body.episodeId);
    assert.ok(uploads[1].body.level > 0.39);
    assert.ok(Date.parse(uploads[1].body.detectedAt) > Date.parse(uploads[0].body.detectedAt));
    assert.equal(uploads[1].body.photo, undefined, 'new noise must not resend the photo discarded by history clearing');
    assert.equal(uploads[1].body.photoAt, undefined);
  });

  await test(`a ${rejection.name} response retains an identical JPEG captured at a newer time`, { videoReady: true }, async env => {
    let finish;
    env.onEvent(body => new Promise(resolve => { finish = () => resolve(rejection.response(body)); }));
    await env.monitor.startHost({ settings: { snapshotIntervalMs: 10000 } });
    await env.settle();
    env.openSocket('host');
    await env.advance(10500);
    env.setAudioLevel(0);
    finish();
    env.onEvent(body => Promise.resolve(eventResult(body)));
    await env.settle();
    await env.advance(1000);
    const uploads = env.posts.filter(post => post.path === '/events' && post.body.photo);
    assert.equal(uploads.length, 2);
    assert.ok(uploads[1].body.photo);
    assert.notEqual(uploads[1].body.episodeId, uploads[0].body.episodeId);
    assert.equal(uploads[1].body.photo, uploads[0].body.photo, 'a static camera may produce the same JPEG for distinct captures');
    assert.ok(Date.parse(uploads[1].body.photoAt) > Date.parse(uploads[0].body.photoAt), 'the response must only discard the submitted capture timestamp');
  });
}

await test('discarding a photo with a newer stored photo timestamp does not extend capture cooldown', { videoReady: true }, async env => {
  let finish;
  env.onEvent(body => new Promise(resolve => {
    finish = () => resolve({ ...eventResult(body, new Date().toISOString()), photoDiscarded: true });
  }));
  await env.monitor.startHost({ settings: { snapshotIntervalMs: 10000 } });
  await env.settle();
  env.openSocket('host');
  await env.advance(5500);
  finish();
  env.onEvent(body => Promise.resolve(eventResult(body)));
  await env.settle();
  await env.advance(5000);
  const photos = env.posts.filter(post => post.path === '/events' && post.body.photo);
  assert.equal(photos.length, 2, 'discarding an old photo must not postpone the next capture to an interval after the response');
  assert.ok(Date.parse(photos[1].body.photoAt) > Date.parse(photos[0].body.photoAt));
});

for (const historyVersion of [0, 7]) {
  await test(`the initial heartbeat stamps queued noise and photos with history version ${historyVersion}`, { videoReady: true }, async env => {
    let finishHeartbeat;
    env.onHeartbeat(() => new Promise(resolve => { finishHeartbeat = resolve; }));
    await env.monitor.startHost();
    await env.advance(500);
    env.setAudioLevel(0);
    assert.equal(env.posts.filter(post => post.path === '/events').length, 0);
    finishHeartbeat({ ok: true, historyVersion });
    await env.settle();
    env.openSocket('host');
    await env.advance(500);
    const uploads = env.posts.filter(post => post.path === '/events');
    assert.equal(uploads.length, 1, 'noise sampled while the initial heartbeat is pending must be retained');
    assert.equal(uploads[0].body.historyVersion, historyVersion);
    assert.ok(uploads[0].body.photo);
    assert.ok(Date.parse(uploads[0].body.detectedAt) < Date.now() - 500);
  });
}

await test('an initially muted source retains its first short burst until the healthy heartbeat establishes history', { muted: true, videoReady: true }, async env => {
  env.onHeartbeat(body => Promise.resolve({ ok: true, historyVersion: body.monitoring ? 4 : 3 }));
  env.onEvent(body => Promise.resolve({ ...eventResult(body), historyVersion: 4 }));
  await env.monitor.startHost();
  await env.settle();
  env.setMuted(false);
  await env.advance(500);
  env.setAudioLevel(0);
  await env.advance(4500);
  env.openSocket('host');
  await env.advance(500);
  const uploads = env.posts.filter(post => post.path === '/events');
  assert.equal(uploads.length, 1, 'a paused startup heartbeat must not assign the previous history to the first burst');
  assert.ok(uploads[0].body.photo);
  assert.equal(uploads[0].body.historyVersion, 4);
  assert.ok(Date.parse(uploads[0].body.detectedAt) < Date.UTC(2026, 0, 1) + 500);
});

await test('a late initial paused heartbeat cannot replace the version established by a healthy retry', { muted: true, videoReady: true }, async env => {
  let finishPausedHeartbeat;
  env.onHeartbeat(body => body.monitoring
    ? Promise.resolve({ ok: true, historyVersion: 4 })
    : new Promise(resolve => { finishPausedHeartbeat = resolve; }));
  env.onEvent(body => Promise.resolve({ ...eventResult(body), historyVersion: 4 }));
  await env.monitor.startHost();
  await env.settle();
  env.setMuted(false);
  await env.advance(500);
  env.setAudioLevel(0);
  await env.advance(11500);
  assert.equal(env.errors.length, 1, 'the serial heartbeat loop must time out before it can retry');
  env.errors.length = 0;
  await env.advance(5000);
  finishPausedHeartbeat({ ok: true, historyVersion: 3 });
  await env.settle();
  env.openSocket('host');
  await env.advance(500);
  const uploads = env.posts.filter(post => post.path === '/events');
  assert.equal(uploads.length, 1);
  assert.equal(uploads[0].body.historyVersion, 4);
  assert.ok(uploads[0].body.photo);
});

await test('a paused heartbeat can clear obsolete queued noise after the source session is established', { videoReady: true }, async env => {
  env.onHeartbeat(body => Promise.resolve({ ok: true, historyVersion: body.monitoring ? 3 : 4 }));
  let finishUpload;
  env.onEvent(body => new Promise(resolve => { finishUpload = () => resolve({ ...eventResult(body), historyVersion: 3 }); }));
  await env.monitor.startHost();
  await env.settle();
  env.openSocket('host');
  await env.advance(1500);
  env.setMuted(true);
  await env.advance(3500);
  finishUpload();
  env.onEvent(body => Promise.resolve({ ...eventResult(body), historyVersion: 4 }));
  await env.settle();
  await env.advance(500);
  const uploads = () => env.posts.filter(post => post.path === '/events');
  assert.equal(uploads().length, 1, 'established sessions must adopt clear acknowledgements while input is paused');
  env.setMuted(false);
  await env.advance(1000);
  assert.equal(uploads()[1].body.historyVersion, 4);
  assert.ok(uploads()[1].body.photo, 'the first sound after clearing needs a fresh photo');
  assert.ok(Date.parse(uploads()[1].body.photoAt) >= Date.UTC(2026, 0, 1) + 5000);
});

await test('a local history clear gives the next short burst a fresh photo without restarting capture', { videoReady: true }, async env => {
  env.onHeartbeat(() => Promise.resolve({ ok: true, historyVersion: 3 }));
  let finishUpload;
  env.onEvent(() => new Promise(resolve => { finishUpload = resolve; }));
  await env.monitor.startHost();
  await env.settle();
  env.openSocket('host');
  await env.advance(1500);
  env.setAudioLevel(0);
  await env.advance(600);
  env.monitor.updateHistoryVersion(4);
  finishUpload({ discarded: true, historyVersion: 4 });
  env.onEvent(body => Promise.resolve({ ...eventResult(body), historyVersion: 4 }));
  await env.settle();
  env.setAudioLevel(0.4);
  await env.advance(500);
  env.setAudioLevel(0);
  await env.advance(500);
  const uploads = env.posts.filter(post => post.path === '/events');
  assert.equal(uploads.length, 2, 'the first short burst after local clearing must survive without waiting for another heartbeat');
  assert.equal(uploads[1].body.historyVersion, 4);
  assert.ok(uploads[1].body.level > 0.39);
  assert.ok(uploads[1].body.photo, 'a short burst must not wait for the deleted photo cooldown');
  assert.ok(Date.parse(uploads[1].body.photoAt) > Date.parse(uploads[0].body.photoAt), 'the old JPEG timestamp must not survive clearing');
  assert.notEqual(uploads[1].body.episodeId, uploads[0].body.episodeId);
  assert.equal(env.mediaRequests(), 1);
  assert.ok(env.stream.getTracks().every(track => track.readyState === 'live'));
});

await test('a newer heartbeat version allows a fresh photo and restarts only the photo interval', { videoReady: true }, async env => {
  env.onHeartbeat(() => Promise.resolve({ ok: true, historyVersion: 3 }));
  let finishUpload;
  env.onEvent(body => new Promise(resolve => { finishUpload = () => resolve({ ...eventResult(body), historyVersion: 3 }); }));
  await env.monitor.startHost({ settings: { snapshotIntervalMs: 10000 } });
  await env.settle();
  env.openSocket('host');
  await env.advance(1500);
  env.setAudioLevel(0);
  env.onHeartbeat(() => Promise.resolve({ ok: true, historyVersion: 4 }));
  await env.advance(3500);
  finishUpload();
  env.onEvent(body => Promise.resolve({ ...eventResult(body), historyVersion: 4 }));
  await env.settle();
  await env.advance(500);
  const uploads = () => env.posts.filter(post => post.path === '/events');
  assert.equal(uploads().length, 1, 'a newer history version must remove every obsolete queued update');
  assert.equal(uploads()[0].body.historyVersion, 3, 'the old payload must keep the version from its sample');
  assert.equal(env.mediaRequests(), 1);
  assert.ok(env.stream.getTracks().every(track => track.readyState === 'live'));
  env.setAudioLevel(0.4);
  await env.advance(500);
  assert.equal(uploads().length, 2);
  assert.equal(uploads()[1].body.historyVersion, 4);
  assert.ok(uploads()[1].body.photo, 'remote clearing must allow a fresh photo at the first new sound');
  assert.ok(Date.parse(uploads()[1].body.photoAt) >= Date.UTC(2026, 0, 1) + 5500);
  await env.advance(5500);
  assert.equal(uploads().filter(post => post.body.photo).length, 2, 'the new photo must start a normal interval');
  await env.advance(5500);
  const photos = uploads().filter(post => post.body.photo);
  assert.equal(photos.length, 3);
  assert.ok(photos.slice(1).every(post => post.body.historyVersion === 4));
});

await test('a discarded upload advances history version and removes all noise sampled under the previous version', { videoReady: true }, async env => {
  env.onHeartbeat(() => Promise.resolve({ ok: true, historyVersion: 3 }));
  let finishUpload;
  env.onEvent(() => new Promise(resolve => { finishUpload = resolve; }));
  await env.monitor.startHost();
  await env.settle();
  env.openSocket('host');
  await env.advance(1500);
  env.setAudioLevel(0);
  finishUpload({ discarded: true, historyVersion: 4 });
  env.onEvent(body => Promise.resolve({ ...eventResult(body), historyVersion: 4 }));
  await env.settle();
  await env.advance(500);
  const uploads = () => env.posts.filter(post => post.path === '/events');
  assert.equal(uploads().length, 1, 'newer noise sampled before the version change is also obsolete');
  env.setAudioLevel(0.4);
  await env.advance(500);
  assert.equal(uploads().length, 2);
  assert.equal(uploads()[1].body.historyVersion, 4);
  assert.ok(uploads()[1].body.photo);
  assert.ok(Date.parse(uploads()[1].body.photoAt) > Date.parse(uploads()[0].body.photoAt), 'the new version must capture a fresh photo');
});

await test('a delayed heartbeat cannot downgrade a newer version learned from a discarded upload', { videoReady: true }, async env => {
  env.onHeartbeat(() => Promise.resolve({ ok: true, historyVersion: 3 }));
  let finishUpload;
  env.onEvent(() => new Promise(resolve => { finishUpload = resolve; }));
  await env.monitor.startHost();
  await env.settle();
  env.openSocket('host');
  let finishHeartbeat;
  env.onHeartbeat(() => new Promise(resolve => { finishHeartbeat = resolve; }));
  await env.advance(5500);
  finishUpload({ discarded: true, historyVersion: 5 });
  env.onEvent(body => Promise.resolve({ ...eventResult(body), historyVersion: 5 }));
  await env.settle();
  finishHeartbeat({ ok: true, historyVersion: 4 });
  await env.settle();
  await env.advance(1000);
  const uploads = env.posts.filter(post => post.path === '/events');
  assert.ok(uploads.length > 1);
  assert.ok(uploads.slice(1).every(post => post.body.historyVersion === 5), 'an older heartbeat must not replace the newer history version');
});

await test('a delayed discarded response cannot downgrade history or remove noise sampled after a newer heartbeat', { videoReady: true }, async env => {
  env.onHeartbeat(() => Promise.resolve({ ok: true, historyVersion: 3 }));
  let finishUpload;
  env.onEvent(() => new Promise(resolve => { finishUpload = resolve; }));
  await env.monitor.startHost();
  await env.settle();
  env.openSocket('host');
  await env.advance(500);
  env.onHeartbeat(() => Promise.resolve({ ok: true, historyVersion: 5 }));
  await env.advance(5500);
  env.setAudioLevel(0);
  finishUpload({ discarded: true, historyVersion: 4 });
  env.onEvent(body => Promise.resolve({ ...eventResult(body), historyVersion: 5 }));
  await env.settle();
  await env.advance(500);
  const uploads = env.posts.filter(post => post.path === '/events');
  assert.equal(uploads.length, 2, 'a stale discarded response must preserve the current version queue');
  assert.equal(uploads[1].body.historyVersion, 5);
  assert.ok(uploads[1].body.photo);
  assert.ok(Date.parse(uploads[1].body.photoAt) >= Date.UTC(2026, 0, 1) + 5000, 'a stale reply must not remove the new history photo');
  assert.ok(Date.parse(uploads[1].body.detectedAt) >= Date.UTC(2026, 0, 1) + 5000);
});

for (const input of ['silent', 'muted']) {
  await test(`camera recovery does not take a photo while the microphone is ${input}`, {}, async env => {
    await env.monitor.startHost({ settings: { snapshotIntervalMs: 10000 } });
    await env.settle();
    env.openSocket('host');
    await env.advance(500);
    env.setVideoReady(true);
    if (input === 'silent') env.setAudioLevel(0); else env.setMuted(true);
    await env.advance(11000);
    assert.equal(env.posts.filter(post => post.path === '/events' && post.body.photo).length, 0);
    if (input === 'silent') env.setAudioLevel(0.25); else env.setMuted(false);
    await env.advance(1500);
    assert.equal(env.posts.filter(post => post.path === '/events' && post.body.photo).length, 1);
  });
}

await test('host authenticates with the current session and avoids live encoding without viewers', { videoReady: true }, async env => {
  await env.monitor.startHost();
  await env.settle();
  const socket = env.openSocket('host');
  const heartbeat = env.posts.find(post => post.path === '/heartbeat');
  assert.equal(socket.url, 'wss://example.test/barkodd/api/rooms/room-id/stream');
  assert.deepEqual(JSON.parse(socket.sent[0].data), { type: 'auth', role: 'host', token: 'secret-key', sessionId: heartbeat.body.sessionId });
  await env.advance(1400);
  assert.equal(env.encodes.length, 0, 'idle watching must not consume a live encoder');
  assert.ok(env.posts.some(post => post.path === '/events'), 'noise detection must run without viewers');
  socket.receive({ type: 'viewers', count: 1 });
  await env.advance(1000);
  assert.equal(socket.binary().length, 5, 'send at most five fresh frames per second');
  assert.ok(env.encodes.every(frame => frame.width === 960 && frame.height === 540 && frame.quality === 0.65));
  socket.receive({ type: 'viewers', count: 0 });
  const count = env.encodes.length;
  await env.advance(1000);
  assert.equal(env.encodes.length, count, 'last viewer leaving must stop live encoding');
});

await test('host skips frames while socket buffer is full and while microphone input is unavailable', { videoReady: true }, async env => {
  await env.monitor.startHost();
  await env.settle();
  const socket = env.openSocket('host');
  socket.receive({ type: 'viewers', count: 1 });
  socket.bufferedAmount = 300 * 1024;
  await env.advance(600);
  assert.equal(env.encodes.length, 0, 'backpressure must avoid encoding stale frames');
  socket.bufferedAmount = 0;
  env.setMuted(true);
  await env.advance(600);
  assert.equal(socket.binary().length, 0, 'unhealthy sources must not publish frames');
  env.setMuted(false);
  await env.advance(600);
  assert.ok(socket.binary().length > 0, 'source recovery must resume frames on the same socket');
});

await test('slow JPEG encoding never overlaps and an in-flight frame cannot escape after stop', { videoReady: true, encodeDelay: 550 }, async env => {
  await env.monitor.startHost();
  await env.settle();
  const socket = env.openSocket('host');
  socket.receive({ type: 'viewers', count: 1 });
  await env.advance(500);
  assert.equal(env.encodes.length, 1, 'a pending encoder must not launch another');
  await env.monitor.stopHost();
  await env.advance(600);
  assert.equal(socket.binary().length, 0, 'stop must discard an unfinished encoding');
  assert.equal(socket.readyState, 3);
  assert.ok(env.stream.getTracks().every(track => track.readyState === 'ended'));
  assert.equal(env.localStreams[env.localStreams.length - 1], null);
  assert.equal(env.posts[env.posts.length - 1].body.stopped, true, 'stop heartbeat must terminally retire this source');
  assert.equal(env.releasedLocks(), 1);
  assert.equal(env.timerCount(), 0, 'stopping must release reconnect, sampling and stale-frame timers');
});

await test('live JPEG quality is reduced to fit the frame budget and uses a separate canvas', { videoReady: true, frameBytes: ({ quality }) => quality > 0.5 ? 250 * 1024 : 170 * 1024 }, async env => {
  await env.monitor.startHost();
  await env.settle();
  const socket = env.openSocket('host');
  socket.receive({ type: 'viewers', count: 1 });
  await env.advance(600);
  assert.ok(socket.binary().length > 0);
  assert.ok(socket.binary().every(({ data }) => data.type === 'image/jpeg' && data.size <= 200 * 1024));
  assert.ok(env.encodes.some(frame => frame.quality < 0.65), 'oversized encodings must be reduced');
  assert.ok(env.encodes.every(frame => frame.canvas !== env.canvases[0]), 'live encoding cannot share the mutable snapshot canvas');
  assert.ok(env.posts.some(post => post.path === '/events' && post.body.photo), 'noise snapshots remain available');
});

await test('oversized JPEGs are dropped after bounded retries', { videoReady: true, frameBytes: 250 * 1024 }, async env => {
  await env.monitor.startHost();
  await env.settle();
  const socket = env.openSocket('host');
  socket.receive({ type: 'viewers', count: 1 });
  await env.advance(200);
  assert.equal(socket.binary().length, 0);
  assert.ok(env.encodes.length > 0 && env.encodes.length <= 9, 'one tick must have a bounded encoding budget');
});

await test('viewer authenticates, receives JPEGs, clears frozen frames and recovers', {}, async env => {
  await env.monitor.startViewer();
  const socket = env.openSocket('viewer');
  assert.deepEqual(JSON.parse(socket.sent[0].data), { type: 'auth', role: 'viewer', token: 'secret-key' });
  socket.receive({ type: 'source', online: true, monitoring: true });
  const frame = new Blob([new Uint8Array(120)], { type: 'image/jpeg' });
  socket.receive(frame);
  assert.equal(env.frames[env.frames.length - 1], frame);
  assert.equal(env.statuses[env.statuses.length - 1].kind, 'live');
  await env.advance(3001);
  assert.equal(env.frames[env.frames.length - 1], null, 'a frozen frame must disappear after three seconds');
  socket.receive(frame);
  assert.equal(env.frames[env.frames.length - 1], frame);
  socket.receive({ type: 'source', online: true, monitoring: false });
  assert.equal(env.frames[env.frames.length - 1], null, 'paused source must clear the picture immediately');
  assert.equal(env.statuses[env.statuses.length - 1].kind, 'offline');
  socket.receive(frame);
  assert.equal(env.frames[env.frames.length - 1], null, 'late frames from paused sources must be ignored');
  socket.receive({ type: 'source', online: true, monitoring: true });
  socket.receive(frame);
  assert.equal(env.frames[env.frames.length - 1], frame);
  await env.monitor.stopViewer();
  assert.equal(env.frames[env.frames.length - 1], null);
  assert.equal(socket.closeCode, 1000);
  await env.advance(6000);
  assert.equal(env.sockets.length, 1, 'intentional stop must not reconnect');
  assert.equal(env.timerCount(), 0);
});

await test('a new host with muted input waits for monitoring=true before authenticating its session', { muted: true }, async env => {
  await env.monitor.startHost();
  await env.settle();
  assert.equal(env.posts.find(post => post.path === '/heartbeat').body.monitoring, false);
  assert.equal(env.sockets.length, 0, 'an ignored pause heartbeat cannot establish a replacement session');
  env.setMuted(false);
  await env.advance(5000);
  assert.equal(env.posts.filter(post => post.path === '/heartbeat').slice(-1)[0].body.monitoring, true);
  assert.equal(env.sockets.length, 1, 'healthy heartbeat must establish the source before authentication');
  const socket = env.openSocket('host');
  env.setMuted(true);
  await env.advance(5000);
  assert.equal(socket.readyState, 1, 'an established socket may stay connected during a temporary microphone pause');
  socket.close(1006);
  await env.advance(500);
  assert.equal(env.sockets.length, 1, 'reconnection must wait for a healthy source heartbeat too');
  env.setMuted(false);
  await env.advance(5000);
  assert.equal(env.sockets.length, 2, 'microphone recovery must allow automatic reconnection');
});

await test('host re-establishes its session with a fresh heartbeat before each socket reconnect', {}, async env => {
  await env.monitor.startHost();
  await env.settle();
  const first = env.openSocket('host');
  const sessionId = JSON.parse(first.sent[0].data).sessionId;
  let completeHeartbeat;
  env.onHeartbeat(() => new Promise(resolve => { completeHeartbeat = resolve; }));
  first.close(1012);
  await env.advance(500);
  assert.equal(env.posts.filter(post => post.path === '/heartbeat').length, 2, 'retry must refresh the forgotten server session');
  assert.equal(env.sockets.length, 1, 'pending heartbeat must prevent premature socket authentication');
  completeHeartbeat();
  await env.settle();
  assert.equal(env.sockets.length, 2, 'successful fresh heartbeat must resume the source');
  const second = env.openSocket('host');
  assert.equal(JSON.parse(second.sent[0].data).sessionId, sessionId, 'reconnection preserves the local camera session');
  second.close(1006);
  await env.advance(500);
  assert.equal(env.sockets.length, 2, 'every retry must wait for its own heartbeat');
  await env.monitor.stopHost();
  completeHeartbeat();
  await env.settle();
  assert.equal(env.sockets.length, 2, 'late heartbeat completion cannot reconnect a stopped source');
});

await test('host keeps retrying a failed reconnect heartbeat without authenticating stale sessions', {}, async env => {
  await env.monitor.startHost();
  await env.settle();
  const first = env.openSocket('host');
  env.onHeartbeat(() => Promise.reject(new Error('Temporary heartbeat outage')));
  first.close(1006);
  await env.advance(500);
  assert.equal(env.sockets.length, 1, 'failed heartbeat cannot open an unauthenticatable socket');
  assert.equal(env.errors.length, 1);
  env.errors.length = 0;
  env.onHeartbeat(() => Promise.resolve());
  await env.advance(1000);
  assert.equal(env.sockets.length, 2, 'recovered heartbeat must permit the backed-off retry');
});

await test('host never retries a genuinely retired session even after successful heartbeats', {}, async env => {
  await env.monitor.startHost();
  await env.settle();
  const socket = env.openSocket('host');
  socket.receive({ type: 'error', status: 403, message: 'Session retired' });
  await env.advance(15000);
  assert.equal(env.sockets.length, 1, 'a terminal session rejection must remain terminal');
  assert.equal(env.errors.length, 1);
  env.errors.length = 0;
});

await test('terminal host rejection releases devices and stops photo uploads', { videoReady: true }, async env => {
  await env.monitor.startHost();
  await env.settle();
  const socket = env.openSocket('host');
  socket.receive({ type: 'error', status: 403, message: 'Session retired' });
  const before = env.posts.filter(p => p.path === '/events').length;
  await env.advance(2000);
  assert.ok(env.stream.getTracks().every(track => track.readyState === 'ended'));
  assert.equal(env.posts.filter(p => p.path === '/events').length, before);
  assert.equal(env.errors[0].status, 403);
  assert.equal(env.errors[0].sessionEnded, true);
  env.errors.length = 0;
});

await test('event uploads wait for source authentication and carry its session', { videoReady: true }, async env => {
  await env.monitor.startHost();
  await env.advance(1000);
  assert.equal(env.posts.filter(p => p.path === '/events').length, 0);
  const socket = env.openSocket('host');
  await env.advance(600);
  const event = env.posts.find(p => p.path === '/events');
  assert.equal(event.body.sessionId, JSON.parse(socket.sent[0].data).sessionId);
  socket.close(1006);
  const count = env.posts.filter(p => p.path === '/events').length;
  await env.advance(600);
  assert.equal(env.posts.filter(p => p.path === '/events').length, count);
});

await test('an HTTP event rejection also releases capture', { videoReady: true }, async env => {
  await env.monitor.startHost();
  await env.settle();
  env.openSocket('host');
  env.onEvent(() => Promise.reject(Object.assign(new Error('Сессия завершена'), { status: 403 })));
  await env.advance(1000);
  assert.ok(env.stream.getTracks().every(track => track.readyState === 'ended'));
  const count = env.posts.length;
  await env.advance(10000);
  assert.equal(env.posts.length, count);
  assert.equal(env.errors.length, 1);
  env.errors.length = 0;
});

await test('viewer reconnects with bounded backoff and cancels reconnection on stop', {}, async env => {
  await env.monitor.startViewer();
  const socket = env.openSocket('viewer');
  socket.close(1006);
  await env.advance(499);
  assert.equal(env.sockets.length, 1);
  await env.advance(1);
  assert.equal(env.sockets.length, 2, 'first transient retry starts at 500ms');
  env.sockets[1].close(1006);
  await env.advance(999);
  assert.equal(env.sockets.length, 2);
  await env.advance(1);
  assert.equal(env.sockets.length, 3, 'failed attempts must back off');
  env.sockets[2].close(1006);
  await env.monitor.stopViewer();
  await env.advance(10000);
  assert.equal(env.sockets.length, 3);
});

await test('revoked viewer access clears frames and permanently stops automatic retries', {}, async env => {
  await env.monitor.startViewer();
  const socket = env.openSocket('viewer');
  socket.receive({ type: 'source', online: true, monitoring: true });
  socket.receive(new Blob([new Uint8Array(120)], { type: 'image/jpeg' }));
  socket.receive({ type: 'error', status: 403, message: 'Ключ просмотра отозван' });
  socket.close(1008);
  await env.advance(15000);
  assert.equal(env.frames[env.frames.length - 1], null);
  assert.equal(env.sockets.length, 1);
  assert.equal(env.statuses[env.statuses.length - 1].kind, 'error');
  assert.match(env.statuses[env.statuses.length - 1].message, /доступ|ссылк|ключ/i);
  assert.equal(env.errors.length, 1);
  env.errors.length = 0;
});

await test('socket error does not hide a terminal close code or restart a revoked viewer', {}, async env => {
  await env.monitor.startViewer();
  const socket = env.openSocket('viewer');
  socket.onerror?.({});
  socket.close(1008);
  await env.advance(6000);
  assert.equal(env.sockets.length, 1, 'terminal close must win over the preceding socket error');
  assert.equal(env.statuses[env.statuses.length - 1].kind, 'error');
  assert.equal(env.errors.length, 1);
  env.errors.length = 0;
});

await test('stop during device permission closes pending audio and releases late tracks', { deferredMedia: true }, async env => {
  let context, rejectResume;
  env.onResume(audio => {
    context = audio;
    return new Promise((_, reject) => { rejectResume = reject; });
  });
  const starting = env.monitor.startHost();
  await env.monitor.stopHost();
  env.resolveMedia();
  await starting;
  assert.ok(env.stream.getTracks().every(track => track.readyState === 'ended'));
  assert.equal(context?.state, 'closed');
  rejectResume(new Error('Audio context closed'));
  await env.settle();
  assert.equal(env.sockets.length, 0, 'cancelled start cannot establish a source');
});

await test('stop releases a wake lock which resolves after the source is stopped', { deferredWake: true }, async env => {
  await env.monitor.startHost();
  await env.settle();
  await env.monitor.stopHost();
  env.resolveWake();
  await env.settle();
  assert.equal(env.releasedLocks(), 1);
});

await test('each ready selects the server transport and preserves WebSocket without RTC support', {}, async env => {
  await env.monitor.startViewer();
  const socket = env.openSocket('viewer');
  assert.deepEqual(env.transports, ['websocket']);
  socket.receive({ type: 'source', online: true, monitoring: true });
  socket.receive(new Blob([new Uint8Array(120)], { type: 'image/jpeg' }));
  assert.equal(env.statuses[env.statuses.length - 1].kind, 'live');
  socket.close(1006);
  await env.advance(500);
  const replacement = env.sockets[1];
  replacement.open();
  replacement.receive({ type: 'ready', role: 'viewer', mediaTransport: 'webrtc', clientId: 'viewer-2', iceServers: [] });
  assert.deepEqual(env.transports, ['websocket', 'webrtc']);
  assert.equal(env.frames[env.frames.length - 1], null);
  assert.match(env.errors.pop().message, /WebRTC/);
  replacement.receive({ type: 'source', online: true, monitoring: true, sourceId: 'host-id' });
  assert.equal(env.statuses[env.statuses.length - 1].kind, 'error', 'source state must preserve the unsupported WebRTC explanation');
});

await test('RTC ready consumes a pre-ready roster, publishes video only, and keeps snapshots without JPEG streaming', { rtc: true, videoReady: true }, async env => {
  await env.monitor.startHost(); await env.settle();
  const socket = env.sockets[0]; socket.open();
  socket.receive({ type: 'viewers', count: 1, ids: ['viewer-id'], monitoring: true });
  socket.receive({ type: 'ready', role: 'host', mediaTransport: 'webrtc', clientId: 'host-id', iceServers: [] });
  await env.advance(1000);
  assert.equal(env.peers.length, 1, 'buffered authorization must create the first offer');
  assert.deepEqual(env.peers[0].tracks.map(track => track.kind), ['video']);
  assert.ok(socket.sent.some(item => typeof item.data === 'string' && JSON.parse(item.data).signal?.type === 'offer'));
  assert.equal(socket.binary().length, 0);
  assert.equal(env.encodes.length, 0, 'RTC must not spend CPU encoding JPEG live frames');
  assert.ok(env.posts.some(post => post.path === '/events' && post.body.photo), 'shared detector snapshots must continue');
  env.setMuted(true); await env.advance(50); assert.equal(env.peers[0].closed, true);
  env.setMuted(false); await env.advance(50); assert.equal(env.peers.length, 2);
  socket.receive({ type: 'viewers', count: 0, ids: [], monitoring: true });
  assert.equal(env.peers[1].closed, true, 'host must enforce viewer revocation');
});
await test('RTC viewer uses pre-ready source authorization, ignores binary frames, and clears negotiation on control loss', { rtc: true }, async env => {
  await env.monitor.startViewer();
  const socket = env.sockets[0]; socket.open();
  socket.receive({ type: 'source', online: true, monitoring: true, sourceId: 'host-id' });
  socket.receive({ type: 'ready', role: 'viewer', mediaTransport: 'webrtc', clientId: 'viewer-id', iceServers: [] });
  socket.receive({ type: 'signal', from: 'host-id', connectionId: 'one', signal: { type: 'offer', sdp: 'host-offer' } });
  await env.settle();
  assert.equal(env.peers.length, 1);
  assert.ok(socket.sent.some(item => typeof item.data === 'string' && JSON.parse(item.data).signal?.type === 'answer'));
  socket.receive(new Blob([new Uint8Array(100)], { type: 'image/jpeg' }));
  assert.ok(!env.frames.some(Boolean), 'binary JPEG is disabled in RTC');
  socket.close(1006); assert.equal(env.peers[0].closed, true);
  await env.advance(500);
  const replacement = env.openSocket('viewer');
  replacement.receive({ type: 'source', online: true, monitoring: true });
  replacement.receive(new Blob([new Uint8Array(100)], { type: 'image/jpeg' }));
  assert.deepEqual(env.transports, ['webrtc', 'websocket']);
  assert.ok(env.frames[env.frames.length - 1], 'a reconnect must select the current server transport');
});

await test('an unsupported RTC host keeps its capability error across successful heartbeats', {}, async env => {
  await env.monitor.startHost(); await env.settle();
  const socket = env.sockets[0]; socket.open();
  socket.receive({ type: 'ready', role: 'host', mediaTransport: 'webrtc', clientId: 'host-id', iceServers: [] });
  assert.match(env.errors.pop().message, /WebRTC/);
  await env.advance(5000);
  assert.equal(env.statuses[env.statuses.length - 1].kind, 'error');
  assert.match(env.statuses[env.statuses.length - 1].message, /WebRTC/);
});

await test('TURN credentials renew before expiry and host waits for a fresh heartbeat before reconnecting', { rtc: true }, async env => {
  await env.monitor.startHost(); await env.settle();
  const socket = env.sockets[0]; socket.open();
  socket.receive({ type: 'ready', role: 'host', mediaTransport: 'webrtc', clientId: 'host-id', iceServers: [{ urls: ['stun:example.test', 'turns:relay.test:5349'], username: 'temporary', credential: 'secret' }] });
  await env.advance(45 * 60 * 1000 - 1);
  assert.equal(socket.readyState, 1, 'renewal must keep a healthy control socket until its refresh deadline');
  let completeHeartbeat;
  env.onHeartbeat(() => new Promise(resolve => { completeHeartbeat = resolve; }));
  await env.advance(1);
  assert.equal(socket.readyState, 3, 'TURN users must renew before the one-hour credential TTL');
  await env.advance(500);
  assert.equal(env.sockets.length, 1, 'renewal must not re-authenticate with stale server session state');
  assert.equal(typeof completeHeartbeat, 'function');
  completeHeartbeat(); await env.settle();
  assert.equal(env.sockets.length, 2);
});
await test('STUN-only RTC connections do not reconnect on the TURN credential deadline', { rtc: true }, async env => {
  await env.monitor.startViewer();
  const socket = env.sockets[0]; socket.open();
  socket.receive({ type: 'ready', role: 'viewer', mediaTransport: 'webrtc', clientId: 'viewer-id', iceServers: [{ urls: 'stun:example.test' }] });
  await env.advance(45 * 60 * 1000 + 1000);
  assert.equal(env.sockets.length, 1); assert.equal(socket.readyState, 1);
});
await test('stopping a TURN viewer cancels the scheduled credential renewal', { rtc: true }, async env => {
  await env.monitor.startViewer();
  const socket = env.sockets[0]; socket.open();
  socket.receive({ type: 'ready', role: 'viewer', mediaTransport: 'webrtc', clientId: 'viewer-id', iceServers: [{ urls: 'turn:relay.test', username: 'temporary', credential: 'secret' }] });
  await env.monitor.stopViewer();
  assert.equal(env.timerCount(), 0);
  await env.advance(45 * 60 * 1000 + 1000); assert.equal(env.sockets.length, 1);
});

await test('audio-only viewer authenticates its selection and preserves it after reconnect without opening local devices', {}, async env => {
  await env.monitor.startViewer({ mode: 'audio' });
  const socket = env.openSocket('viewer');
  assert.equal(JSON.parse(socket.sent[0].data).mode, 'audio');
  socket.receive({ type: 'source', online: true, monitoring: true });
  socket.receive(new Blob([new Uint8Array(10)], { type: 'image/jpeg' }));
  assert.equal(env.frames.filter(Boolean).length, 0, 'audio-only must not display unsolicited JPEG');
  socket.close(1006);
  await env.advance(500);
  const replacement = env.openSocket('viewer');
  assert.equal(JSON.parse(replacement.sent[0].data).mode, 'audio');
  assert.equal(env.mediaRequests(), 0, 'listening never asks for viewer microphone');
});

await test('changing selected channels replaces the old socket instead of leaving stale video subscription', {}, async env => {
  await env.monitor.startViewer();
  const first = env.openSocket('viewer');
  await env.monitor.startViewer({ mode: 'audio-video' });
  assert.equal(first.readyState, 3);
  const next = env.openSocket('viewer');
  assert.equal(JSON.parse(next.sent[0].data).mode, 'audio-video');
  await env.monitor.stopViewer();
  assert.equal(next.readyState, 3);
  await env.advance(10000);
  assert.equal(env.sockets.length, 2);
});

await test('unknown viewer mode is rejected before opening transport', {}, async env => {
  await assert.rejects(env.monitor.startViewer({ mode: 'record' }), /режим/i);
  assert.equal(env.sockets.length, 0);
});

await test('an audio-only audience does not make the host encode video but still keeps noise events', { videoReady: true }, async env => {
  await env.monitor.startHost();
  await env.settle();
  const socket = env.openSocket('host');
  socket.receive({ type: 'viewers', count: 1, ids: ['listener'], modes: { listener: 'audio' }, videoCount: 0, audioCount: 1 });
  await env.advance(1200);
  assert.equal(env.encodes.length, 0);
  assert.ok(env.posts.some(post => post.path === '/events'));
});

function audioPacket(sequence = 0) {
  const packet = new ArrayBuffer(3208);
  new Uint8Array(packet).set([66, 75, 65, 49]);
  new DataView(packet).setUint32(4, sequence, true);
  return packet;
}

await test('WebSocket PCM is heard independently from JPEG and is silenced immediately on control loss', {}, async env => {
  await env.monitor.startViewer({ mode: 'audio-video' });
  const socket = env.openSocket('viewer');
  socket.receive({ type: 'source', sourceId: 'host-one', online: true, monitoring: true });
  socket.receive(audioPacket());
  assert.equal(env.playbacks.length, 1);
  assert.equal(env.audioStatuses[env.audioStatuses.length - 1].kind, 'live');
  const late = socket.onmessage;
  socket.close(1006);
  assert.ok(env.playbacks.every(source => source.stopped));
  late({ data: audioPacket(1) });
  assert.equal(env.playbacks.length, 1, 'stale socket callback cannot replay audio');
  await env.monitor.stopViewer();
  assert.equal(env.audioStatuses[env.audioStatuses.length - 1].kind, 'idle');
});

await test('a resume invalidated by socket readiness cannot overwrite later running audio status', {}, async env => {
  let resolve, context;
  env.onResume(audio => { context = audio; audio.state = 'suspended'; return new Promise(done => { resolve = done; }); });
  await env.monitor.startViewer({ mode: 'audio' });
  const socket = env.openSocket('viewer');
  socket.receive({ type: 'source', sourceId: 'host-one', online: true, monitoring: true });
  context.state = 'running'; context.onstatechange(); resolve();
  await env.settle();
  socket.receive(audioPacket());
  assert.equal(env.playbacks.length, 1);
  assert.equal(env.audioStatuses[env.audioStatuses.length - 1].kind, 'live');
});

await test('RTC listening remains live after automatic browser audio resume', { rtc: true }, async env => {
  await env.monitor.startViewer({ mode: 'audio' });
  const socket = env.openSocket('viewer');
  socket.receive({ type: 'ready', role: 'viewer', mediaTransport: 'webrtc', clientId: 'listener', iceServers: [] });
  socket.receive({ type: 'source', sourceId: 'host-id', online: true, monitoring: true });
  socket.receive({ type: 'signal', from: 'host-id', connectionId: 'audio-one', signal: { type: 'offer', sdp: 'host-offer' } });
  await env.settle();
  let packets = 0;
  env.peers[0].ontrack({ track: env.stream.getAudioTracks()[0], receiver: { getStats: async () => new Map([['audio', { type: 'inbound-rtp', kind: 'audio', packetsReceived: ++packets }]]) } });
  await env.advance(500);
  assert.equal(env.audioStatuses[env.audioStatuses.length - 1].kind, 'live');
  env.transitionAudio('suspended');
  assert.equal(env.audioStatuses[env.audioStatuses.length - 1].kind, 'blocked');
  env.transitionAudio('running');
  await env.advance(500);
  assert.equal(env.audioStatuses[env.audioStatuses.length - 1].kind, 'live');
});

await test('a late retry for a replaced RTC track cannot block its replacement', { rtc: true }, async env => {
  await env.monitor.startViewer({ mode: 'audio' });
  const socket = env.openSocket('viewer');
  socket.receive({ type: 'ready', role: 'viewer', mediaTransport: 'webrtc', clientId: 'listener', iceServers: [] });
  socket.receive({ type: 'source', sourceId: 'host-id', online: true, monitoring: true });
  const receiveAudio = async connectionId => {
    socket.receive({ type: 'signal', from: 'host-id', connectionId, signal: { type: 'offer', sdp: 'host-offer' } });
    await env.settle();
    let packets = 0;
    env.peers[env.peers.length - 1].ontrack({
      track: env.stream.getAudioTracks()[0],
      receiver: { getStats: async () => new Map([['audio', { type: 'inbound-rtp', kind: 'audio', packetsReceived: ++packets }]]) },
    });
    await env.settle();
  };

  await receiveAudio('audio-one');
  await env.advance(500);
  assert.equal(env.audioStatuses[env.audioStatuses.length - 1].kind, 'live');
  let resolvePlay;
  env.onAudioPlay(() => new Promise(resolve => { resolvePlay = resolve; }));
  const retry = env.monitor.resumeAudio();
  env.onAudioPlay(() => Promise.resolve());
  await receiveAudio('audio-two');
  assert.equal(env.audioStatuses[env.audioStatuses.length - 1].kind, 'waiting');
  resolvePlay();
  await retry;
  await env.advance(500);
  assert.equal(env.audioStatuses[env.audioStatuses.length - 1].kind, 'live');
});

for (const disposition of ['legacy', 'accepted', 'duplicate']) {
  await test(`${disposition} acknowledgement removes only its JPEG and never shifts the local capture cadence`, { videoReady: true }, async env => {
    const captures = [];
    env.onSnapshot(() => { captures.push(performance.now()); return 'data:image/jpeg;base64,/9j/2Q=='; });
    env.onHeartbeat(() => Promise.resolve({ historyVersion: 3 }));
    let finish;
    env.onEvent(body => new Promise(resolve => { finish = () => resolve({
      ...eventResult(body, disposition === 'legacy' ? body.photoAt : null), historyVersion: 3,
      ...(disposition === 'legacy' ? {} : { photoStatus: disposition }),
    }); }));
    await env.monitor.startHost({ settings: { snapshotIntervalMs: 10000 } });
    await env.settle(); env.openSocket('host');
    await env.advance(9500);
    assert.deepEqual(captures, [150]);
    finish(); await env.settle();
    env.onEvent(body => Promise.resolve({ ...eventResult(body, null), historyVersion: 3, photoStatus: body.photo ? 'accepted' : 'none' }));
    await env.advance(11000);
    assert.deepEqual(captures, [150, 10150, 20150], 'the ten-second interval begins at each local JPEG capture');
    const photos = env.posts.filter(post => post.path === '/events' && post.body.photo);
    assert.equal(photos.length, 3, 'explicit dispositions settle photos without relying on the legacy timestamp');
    assert.equal(new Set(photos.map(post => post.body.episodeId)).size, 3, 'continuous noise must start a separate card each interval');
  });
}

await test('a timed-out event upload cannot stop local captures or lose their later upload', { videoReady: true }, async env => {
  const captures = [];
  env.onSnapshot(() => { captures.push(performance.now()); return 'data:image/jpeg;base64,/9j/2Q=='; });
  let finish;
  env.onEvent(body => new Promise(resolve => { finish = () => resolve({ ...eventResult(body), photoStatus: 'accepted' }); }));
  await env.monitor.startHost({ settings: { snapshotIntervalMs: 10000 } });
  await env.settle(); env.openSocket('host');
  await env.advance(12500);
  assert.deepEqual(captures, [150, 10150]);
  assert.equal(env.errors.length, 1);
  assert.match(env.errors.pop().message, /Сервер не отвечает/);
  finish(); await env.settle();
  env.onEvent(body => Promise.resolve({ ...eventResult(body), photoStatus: body.photo ? 'accepted' : 'none' }));
  await env.advance(8000);
  assert.deepEqual(captures, [150, 10150, 20150], 'a late response after timeout must not alter the next capture');
  const uploaded = new Set(env.posts.filter(post => post.path === '/events' && post.body.photo).map(post => post.body.photoAt));
  assert.equal(uploaded.size, 3, 'all distinct local captures must eventually upload');
});

await test('offline photo backlog stays bounded and drains without applying a second interval on upload', { videoReady: true }, async env => {
  let captures = 0;
  env.onHeartbeat(() => Promise.resolve({ historyVersion: 3 }));
  env.onEvent(body => Promise.resolve({ ...eventResult(body), historyVersion: 3, photoStatus: body.photo ? 'accepted' : 'none' }));
  env.onSnapshot(() => { captures++; return 'data:image/jpeg;base64,/9j/2Q=='; });
  await env.monitor.startHost({ settings: { snapshotIntervalMs: 10000 } });
  await env.advance(140500);
  assert.equal(captures, 15, 'offline capture still follows the local interval');
  assert.equal(env.posts.filter(post => post.path === '/events').length, 0);
  env.setAudioLevel(0);
  while (env.sockets[env.sockets.length - 1].readyState === 3) await env.advance(500);
  env.openSocket('host');
  await env.advance(6000);
  const uploads = env.posts.filter(post => post.path === '/events');
  assert.equal(uploads.length, 12, 'all retained photos must drain through the existing 500ms request loop');
  assert.equal(new Set(uploads.map(post => post.body.episodeId)).size, 12);
  assert.ok(uploads.every(post => post.body.photo));
  assert.equal(Date.parse(uploads[0].body.photoAt), Date.UTC(2026, 0, 1) + 30150, 'the oldest three of fifteen offline captures must be evicted');
  assert.ok(uploads.every((post, index) => !index || post.at - uploads[index - 1].at === 500));
  await env.advance(1000);
  assert.equal(env.posts.filter(post => post.path === '/events').length, 12, 'successful uploads must remove every retained capture');
});

await test('expired pending JPEGs are removed without dropping fresh noise from the same episode', { videoReady: true }, async env => {
  env.onHeartbeat(() => Promise.resolve({ historyVersion: 3 }));
  await env.monitor.startHost({ settings: { snapshotIntervalMs: 10000 } });
  await env.advance(500);
  env.setVideoReady(false);
  env.shiftWallClock(24 * 60 * 60 * 1000);
  await env.advance(1000);
  env.setAudioLevel(0);
  env.openSocket('host');
  await env.advance(500);
  const uploads = env.posts.filter(post => post.path === '/events');
  assert.equal(uploads.length, 1, 'new noise must survive expiry of its older JPEG');
  assert.equal(uploads[0].body.photo, undefined);
  assert.equal(uploads[0].body.photoAt, undefined);
  assert.ok(Date.parse(uploads[0].body.detectedAt) >= Date.UTC(2026, 0, 2));
});

await test('queued noise and JPEGs expire after twenty-four hours without new input', { videoReady: true }, async env => {
  env.onHeartbeat(() => Promise.resolve({ historyVersion: 3 }));
  await env.monitor.startHost();
  await env.advance(500);
  env.setAudioLevel(0);
  env.shiftWallClock(24 * 60 * 60 * 1000);
  env.openSocket('host');
  await env.advance(1000);
  assert.equal(env.posts.filter(post => post.path === '/events').length, 0);
});

await test('an unconfirmed JPEG from a legacy server cannot hide noise in a newer episode', { videoReady: true }, async env => {
  let finish;
  env.onEvent(body => new Promise(resolve => { finish = () => resolve(eventResult(body, null)); }));
  await env.monitor.startHost({ settings: { snapshotIntervalMs: 10000 } });
  await env.settle(); env.openSocket('host');
  await env.advance(10500);
  env.setAudioLevel(0);
  finish(); await env.settle();
  env.onEvent(body => Promise.resolve(eventResult(body, null)));
  await env.advance(1000);
  const uploads = env.posts.filter(post => post.path === '/events');
  assert.ok(uploads.some(post => post.body.episodeId !== uploads[0].body.episodeId), 'fresh noise must progress even when an old server never confirms the oldest JPEG');
});

await test('live interval settings recalculate from the last capture without restarting devices', { videoReady: true }, async env => {
  const captures = [];
  env.onSnapshot(() => { captures.push(performance.now()); return 'data:image/jpeg;base64,/9j/2Q=='; });
  await env.monitor.startHost();
  await env.settle(); env.openSocket('host');
  await env.advance(5000);
  assert.deepEqual(captures, [150]);
  env.monitor.updateSettings({ snapshotIntervalMs: 10000 });
  await env.advance(5500);
  assert.deepEqual(captures, [150, 10150], 'shortening the interval must retain the previous capture time');
  env.monitor.updateSettings({ snapshotIntervalMs: 30000 });
  await env.advance(29500);
  assert.deepEqual(captures, [150, 10150]);
  await env.advance(500);
  assert.deepEqual(captures, [150, 10150, 40150], 'lengthening the interval must start from the last capture, not the settings change');
  assert.equal(env.mediaRequests(), 1);
});

console.log(`${passed} media tests passed; ${failed} failed`);
if (failed) process.exitCode = 1;
