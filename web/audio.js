import { t } from './i18n.js';

export const AUDIO_SAMPLE_RATE = 16000;
export const AUDIO_SAMPLES = 1600;
export const AUDIO_PACKET_BYTES = 8 + AUDIO_SAMPLES * 2;

export function encodeAudioPacket(samples, sequence) {
  if (samples?.length !== AUDIO_SAMPLES) throw new RangeError('Expected 1600 audio samples');
  const packet = new ArrayBuffer(AUDIO_PACKET_BYTES);
  const bytes = new Uint8Array(packet);
  bytes.set([66, 75, 65, 49]); // BKA1
  const view = new DataView(packet);
  view.setUint32(4, sequence >>> 0, true);
  for (let i = 0; i < AUDIO_SAMPLES; i++) {
    const sample = Number.isFinite(samples[i]) ? Math.max(-1, Math.min(1, samples[i])) : 0;
    view.setInt16(8 + i * 2, Math.round(sample * (sample < 0 ? 32768 : 32767)), true);
  }
  return packet;
}

export function decodeAudioPacket(packet) {
  if (!(packet instanceof ArrayBuffer) || packet.byteLength !== AUDIO_PACKET_BYTES) return null;
  const bytes = new Uint8Array(packet);
  if (bytes[0] !== 66 || bytes[1] !== 75 || bytes[2] !== 65 || bytes[3] !== 49) return null;
  const view = new DataView(packet), samples = new Float32Array(AUDIO_SAMPLES);
  for (let i = 0; i < AUDIO_SAMPLES; i++) {
    const value = view.getInt16(8 + i * 2, true);
    samples[i] = value / (value < 0 ? 32768 : 32767);
  }
  return { sequence: view.getUint32(4, true), samples };
}

// This branch shares the detector's microphone source. The worklet explicitly
// writes silence to its output, so connecting it keeps capture running without
// feeding the local microphone back into the host's speakers.
export async function createAudioCapture({ context, source, onPacket, onError } = {}) {
  if (!context?.audioWorklet?.addModule || !globalThis.AudioWorkletNode) {
    throw new Error(t('Этот браузер не поддерживает передачу звука через AudioWorklet.'));
  }
  await context.audioWorklet.addModule(new URL('./audio-worklet.js', import.meta.url));
  const node = new globalThis.AudioWorkletNode(context, 'barkodd-pcm-capture', {
    numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
  });
  let enabled = false, closed = false, generation = 0, sequence = 0;
  const close = () => {
    if (closed) return;
    closed = true; enabled = false; generation++;
    node.port.onmessage = null; node.onprocessorerror = null;
    try { source.disconnect(node); } catch { /* Source may already be disconnected. */ }
    try { node.disconnect(); } catch { /* Context may already be closed. */ }
    node.port.close();
  };
  node.port.onmessage = event => {
    const data = event.data;
    if (closed) return;
    try {
      if (!enabled || data?.generation !== generation || !(data.samples instanceof Float32Array) || data.samples.length !== AUDIO_SAMPLES) return;
      if (!Number.isFinite(data.capturedAt) || context.currentTime - data.capturedAt > 0.5) return;
      onPacket?.(encodeAudioPacket(data.samples, sequence));
      sequence = (sequence + 1) >>> 0;
    } finally {
      // Acknowledge discarded generations and expired audio too, so a stalled
      // host resumes with the worklet's newest packet instead of deadlocking.
      if (Number.isSafeInteger(data?.id)) node.port.postMessage({ ack: data.id });
    }
  };
  node.onprocessorerror = () => {
    if (closed) return;
    close();
    onError?.(new Error(t('Не удалось обработать звук для трансляции. Перезапустите наблюдение.')));
  };
  try { source.connect(node); node.connect(context.destination); }
  catch (error) { close(); throw error; }
  return {
    setEnabled(value) {
      value = Boolean(value);
      if (closed || value === enabled) return;
      enabled = value;
      node.port.postMessage({ enabled, generation: ++generation });
    },
    close,
  };
}

const PACKET_SECONDS = AUDIO_SAMPLES / AUDIO_SAMPLE_RATE;
const MAX_BUFFER_SECONDS = 0.5;
const START_DELAY = 0.01;
const playbackSessions = new WeakMap();

function acquirePlaybackSession() {
  try {
    const session = globalThis.navigator?.audioSession;
    if (!session) return;
    let playback = playbackSessions.get(session);
    if (!playback) {
      const previousType = session.type;
      if (previousType === 'playback') return;
      // Web Audio may otherwise follow the iPhone's Silent mode.
      session.type = 'playback';
      playback = { previousType, players: 0 };
      playbackSessions.set(session, playback);
    }
    playback.players++;
    return () => {
      if (--playback.players !== 0) return;
      playbackSessions.delete(session);
      try {
        if (session.type === 'playback') session.type = playback.previousType;
      } catch { /* The browser may no longer expose the session. */ }
    };
  } catch { /* AudioSession is optional. */ }
}

export function createAudioPlayer({ onStatus } = {}) {
  let context = null, closed = false, generation = 0, resumeAttempt = 0;
  let scheduled = [], streamSource = null, streamElement = null, streamPlayAttempt = 0;
  let streamPlaying = false, streamSetupFailed = false;
  let currentStream = null, lastSequence = null, lastStatus = '';
  let releaseAudioSession;
  const releasePlayback = () => { releaseAudioSession?.(); releaseAudioSession = null; };
  const status = (kind, message) => {
    const key = `${kind}:${message}`;
    if (closed || key === lastStatus) return;
    lastStatus = key;
    onStatus?.({ kind, message });
  };
  const blocked = () => status('blocked', t('Браузер приостановил звук. Нажмите «Воспроизвести звук» для повторного запуска.'));
  const waiting = () => status('waiting', t('Ждём звук от устройства питомца…'));
  const stopNode = node => {
    node.onended = null;
    try { node.stop(); } catch { /* Already ended or context was closed. */ }
    try { node.disconnect(); } catch { /* Already disconnected. */ }
  };
  const clearPCM = () => { for (const item of scheduled) stopNode(item.node); scheduled = []; };
  const disconnectStream = () => {
    if (streamSource) { try { streamSource.disconnect(); } catch { /* Already disconnected. */ } }
    streamPlayAttempt++;
    if (streamElement) {
      streamElement.pause();
      streamElement.srcObject = null;
    }
    streamElement = null;
    streamSource = null; currentStream = null;
    streamPlaying = false;
    streamSetupFailed = false;
  };
  const activateStream = () => {
    const element = streamElement;
    if (!element) return Promise.resolve(true);
    const token = generation, attempt = ++streamPlayAttempt;
    const current = () => !closed && generation === token && streamElement === element && streamPlayAttempt === attempt;
    const playFailed = () => {
      if (current()) { streamPlaying = false; blocked(); }
      return false;
    };
    let result;
    if (!streamPlaying) blocked();
    try { result = element.play(); }
    catch (error) { return Promise.resolve(playFailed()); }
    return Promise.resolve(result).then(() => {
      if (!current()) return false;
      streamPlaying = true;
      if (context.state === 'running') waiting();
      return true;
    }, playFailed);
  };
  const reset = () => {
    generation++; resumeAttempt++; lastSequence = null;
    clearPCM(); disconnectStream();
  };
  try {
    const Audio = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!Audio) throw new Error(t('Этот браузер не поддерживает воспроизведение звука.'));
    // Construct immediately, before any await, to retain the click's activation.
    releaseAudioSession = acquirePlaybackSession();
    context = new Audio();
    context.onstatechange = () => {
      if (closed) return;
      if (context.state === 'closed') {
        reset(); releasePlayback();
        status('error', t('Воспроизведение звука остановлено браузером.'));
      }
      else if (streamSetupFailed) return;
      else if (context.state === 'running') { if (!streamElement || streamPlaying) waiting(); }
      else { clearPCM(); blocked(); }
    };
  } catch (error) { releasePlayback(); status('error', error.message); }

  const schedule = (samples, start) => {
    const buffer = context.createBuffer(1, AUDIO_SAMPLES, AUDIO_SAMPLE_RATE);
    buffer.getChannelData(0).set(samples);
    const node = context.createBufferSource();
    const item = { node, samples, start, end: start + PACKET_SECONDS };
    node.buffer = buffer;
    node.onended = () => {
      node.disconnect();
      const index = scheduled.indexOf(item);
      if (index !== -1) scheduled.splice(index, 1);
    };
    node.connect(context.destination);
    scheduled.push(item);
    node.start(start);
  };

  return {
    resume() {
      if (closed || !context || context.state === 'closed' || streamSetupFailed) return Promise.resolve(false);
      const token = generation, attempt = ++resumeAttempt;
      const current = () => !closed && token === generation && attempt === resumeAttempt;
      let result;
      try { result = context.resume(); } // Deliberately invoke inside the click, not a Promise callback.
      catch (error) { if (current()) blocked(); return Promise.resolve(false); }
      const decoding = activateStream(); // Retry both browser gates within this same user gesture.
      // Some browsers leave resume pending under autoplay restrictions instead
      // of rejecting it. Keep the retry action available during that wait.
      if (context.state !== 'running') blocked();
      return Promise.all([result, decoding]).then(([, decoderReady]) => {
        if (!current() || streamSetupFailed) return false;
        if (!decoderReady || (streamElement && !streamPlaying)) return false;
        if (context.state !== 'running') { blocked(); return false; }
        waiting(); return true;
      }, () => { if (current() && !streamSetupFailed) blocked(); return false; });
    },
    enqueue(packet) {
      if (closed || !context || context.state === 'closed') return false;
      const decoded = decodeAudioPacket(packet);
      if (!decoded) return false;
      if (context.state !== 'running') { blocked(); return false; }
      if (lastSequence !== null) {
        const distance = (decoded.sequence - lastSequence) >>> 0;
        if (distance === 0 || distance >= 0x80000000) return false;
      }
      const now = context.currentTime;
      for (const item of scheduled.filter(item => item.end <= now)) stopNode(item.node);
      scheduled = scheduled.filter(item => item.end > now);
      try {
        const last = scheduled[scheduled.length - 1];
        const start = Math.max(now + START_DELAY, last?.end || 0);
        if (start + PACKET_SECONDS > now + MAX_BUFFER_SECONDS) {
          // Rebuild only the newest packets when a burst would create a backlog.
          const keep = Math.floor((MAX_BUFFER_SECONDS - START_DELAY) / PACKET_SECONDS);
          const recent = [...scheduled.map(item => item.samples), decoded.samples].slice(-keep);
          clearPCM();
          recent.forEach((samples, index) => schedule(samples, now + START_DELAY + index * PACKET_SECONDS));
        } else schedule(decoded.samples, start);
        lastSequence = decoded.sequence;
        return true;
      } catch (error) {
        clearPCM(); status('error', t('Не удалось воспроизвести полученный звук.')); return false;
      }
    },
    setStream(stream) {
      if (closed || !context || context.state === 'closed' || (!streamSetupFailed && currentStream === stream)) return;
      clearPCM(); disconnectStream(); lastSequence = null;
      if (!stream) return;
      try {
        // Chromium needs a media element attached to a remote stream to start
        // its RTC audio decoder (crbug.com/40094084). Keep it muted: this
        // context is the sole audible output and owns suspension/retry.
        streamElement = document.createElement('audio');
        streamElement.muted = true;
        streamElement.autoplay = true;
        streamElement.playsInline = true;
        streamElement.srcObject = stream;
        streamSource = context.createMediaStreamSource(stream);
        streamSource.connect(context.destination); currentStream = stream;
        void activateStream();
        if (context.state !== 'running') blocked();
      } catch (error) {
        disconnectStream();
        streamSetupFailed = true;
        status('error', t('Не удалось воспроизвести звук трансляции.'));
      }
    },
    reset,
    close() {
      if (closed) return;
      closed = true; reset();
      if (context) {
        context.onstatechange = null;
        try { Promise.resolve(context.close()).catch(() => {}); } catch { /* Already closed. */ }
      }
      releasePlayback();
    },
  };
}
