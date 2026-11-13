import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { AUDIO_PACKET_BYTES, AUDIO_SAMPLE_RATE, AUDIO_SAMPLES, encodeAudioPacket, decodeAudioPacket, createAudioCapture, createAudioPlayer } from '../web/audio.js';

const tests = [];
const test = (name, run) => tests.push({ name, run });

const tick = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
const packet = (sequence, amplitude = 0.25) => encodeAudioPacket(new Float32Array(1600).fill(amplitude), sequence);

// Web Audio nodes are browser boundaries. Codec, resampling, packet order,
// queue decisions and cancellation execute the production implementation.
function browser({ state = 'running' } = {}) {
  const originals = new Map(), contexts = [], worklets = [], elements = [];
  const replace = (name, value) => {
    if (!originals.has(name)) originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  };
  class Node {
    constructor() { this.connections = new Set(); this.stopped = false; }
    connect(node) { this.connections.add(node); return node; }
    disconnect(node) { if (node) this.connections.delete(node); else this.connections.clear(); }
    start(at) { this.started = at; }
    stop() { this.stopped = true; this.onended?.(); }
  }
  class Context {
    constructor() {
      this.state = state; this.currentTime = 0; this.destination = {}; this.sources = []; this.streams = [];
      this.resumeCalls = 0; this.resumeBehavior = null; this.loadedModules = [];
      this.audioWorklet = { addModule: async url => { this.loadedModules.push(String(url)); } };
      contexts.push(this);
    }
    resume() { this.resumeCalls++; if (this.resumeBehavior) return this.resumeBehavior(); this.state = 'running'; return Promise.resolve(); }
    close() { this.state = 'closed'; this.closed = true; return Promise.resolve(); }
    createBuffer(channels, size, rate) {
      assert.equal(channels, 1);
      const samples = new Float32Array(size);
      return { duration: size / rate, sampleRate: rate, getChannelData: () => samples, copyToChannel: data => samples.set(data) };
    }
    createBufferSource() { const node = new Node(); this.sources.push(node); return node; }
    createMediaStreamSource(stream) { const node = new Node(); node.stream = stream; this.streams.push(node); return node; }
    transition(next) { this.state = next; this.onstatechange?.(); }
  }
  class Worklet extends Node {
    constructor(context, name, options) {
      super(); this.context = context; this.name = name; this.options = options; this.messages = [];
      this.port = { postMessage: message => this.messages.push(message), close: () => { this.port.closed = true; } };
      worklets.push(this);
    }
  }
  replace('AudioContext', Context); replace('AudioWorkletNode', Worklet);
  replace('document', { createElement(name) {
    assert.equal(name, 'audio');
    const element = { muted: false, autoplay: false, srcObject: null, paused: true,
      play() { assert.equal(this.muted, true, 'decoder activation must never create a second audible output'); this.paused = false; return this.playBehavior?.() || Promise.resolve(); },
      pause() { this.paused = true; },
    };
    elements.push(element); return element;
  } });
  return { Context, Node, contexts, worklets, elements, replace,
    restore() { for (const [name, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name]; } },
  };
}

test('codec writes the fixed little-endian wire format and clamps PCM samples', () => {
  const samples = new Float32Array(1600); samples.set([-2, -1, -0.5, 0, 0.5, 1, 2, NaN]);
  const encoded = encodeAudioPacket(samples, 0x12345678), bytes = new Uint8Array(encoded), view = new DataView(encoded);
  assert.equal(encoded.byteLength, 3208); assert.equal(AUDIO_PACKET_BYTES, 3208);
  assert.equal(AUDIO_SAMPLE_RATE, 16000); assert.equal(AUDIO_SAMPLES, 1600);
  assert.deepEqual([...bytes.slice(0, 8)], [66, 75, 65, 49, 120, 86, 52, 18]);
  assert.deepEqual(Array.from({ length: 8 }, (_, i) => view.getInt16(8 + 2 * i, true)), [-32768, -32768, -16384, 0, 16384, 32767, 32767, 0]);
  const decoded = decodeAudioPacket(encoded);
  assert.equal(decoded.sequence, 0x12345678); assert.equal(decoded.samples.length, 1600);
  assert.ok(Math.abs(decoded.samples[2] + 0.5) < 0.00004);
  assert.ok(Math.abs(decoded.samples[4] - 0.5) < 0.00004);
  assert.equal(decoded.samples[1], -1); assert.equal(decoded.samples[5], 1);
});

test('codec rejects malformed packets and incomplete sample blocks', () => {
  for (const input of [null, 'BKA1', new Uint8Array(3208), new ArrayBuffer(8), new ArrayBuffer(3207), new ArrayBuffer(3209), new ArrayBuffer(3208)]) assert.equal(decodeAudioPacket(input), null);
  const invalidMagic = packet(1); new Uint8Array(invalidMagic)[3] = 2;
  assert.equal(decodeAudioPacket(invalidMagic), null);
  assert.throws(() => encodeAudioPacket(new Float32Array(1599), 0), RangeError);
});

async function processor(rate, { autoAck = true } = {}) {
  const code = await readFile(new URL('../web/audio-worklet.js', import.meta.url), 'utf8');
  let Registered;
  const messages = [];
  class Processor { constructor() { this.port = { postMessage: message => {
    messages.push(message);
    if (autoAck && Number.isSafeInteger(message.id)) this.port.onmessage({ data: { ack: message.id } });
  } }; } }
  const scope = { AudioWorkletProcessor: Processor, sampleRate: rate, currentTime: 0, Float32Array,
    registerProcessor(name, implementation) { assert.equal(name, 'barkodd-pcm-capture'); Registered = implementation; } };
  vm.runInNewContext(code, scope);
  const instance = new Registered();
  return { instance, messages,
    enable(enabled, generation = 1) { instance.port.onmessage({ data: { enabled, generation } }); },
    ack(id) { instance.port.onmessage({ data: { ack: id } }); },
    feed(channels) { const output = new Float32Array(channels[0]?.length || 128).fill(1); assert.equal(instance.process([channels], [[output]]), true); assert.ok(output.every(value => value === 0), 'host graph must never loop microphone into speakers'); scope.currentTime += output.length / rate; },
  };
}

test('worklet emits exactly 16 kHz at 48 kHz, 44.1 kHz and 8 kHz without amplitude drift', async () => {
  for (const rate of [48000, 44100, 8000]) {
    const p = await processor(rate); p.enable(true, 3);
    for (let position = 0; position < rate; position += 128) p.feed([new Float32Array(Math.min(128, rate - position)).fill(0.25)]);
    assert.equal(p.messages.length, 10, `one second at ${rate} must produce ten packets`);
    for (const message of p.messages) {
      assert.equal(message.generation, 3); assert.equal(message.samples.length, 1600);
      assert.ok(message.samples.every(value => Math.abs(value - 0.25) < 1e-6));
    }
  }
});

test('worklet mixes stereo to mono, preserves audible tone and stays silent while disabled', async () => {
  const p = await processor(48000);
  p.feed([new Float32Array(4800).fill(1)]); assert.equal(p.messages.length, 0);
  p.enable(true); p.feed([new Float32Array(4800).fill(0.5), new Float32Array(4800).fill(-0.5)]);
  assert.equal(p.messages.length, 1); assert.ok(p.messages[0].samples.every(value => value === 0));
  const tone = Float32Array.from({ length: 4800 }, (_, i) => 0.6 * Math.sin(2 * Math.PI * 1000 * i / 48000));
  p.feed([tone]);
  const samples = p.messages[1].samples;
  const rms = Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length);
  assert.ok(rms > 0.4 && rms < 0.43, `tone RMS ${rms}`);
  let crossings = 0; for (let i = 1; i < samples.length; i++) if (samples[i - 1] < 0 && samples[i] >= 0) crossings++;
  assert.ok(crossings >= 99 && crossings <= 100, 'one kHz tone must retain its frequency');
  p.feed([new Float32Array(2400).fill(1)]); p.enable(false, 2); p.feed([]); p.enable(true, 3);
  p.feed([new Float32Array(4800).fill(-0.25)]);
  assert.ok(p.messages.slice(-1)[0].samples.every(value => value === -0.25), 'partial pre-disable audio must be discarded');
});

test('a stalled host can queue only one worklet message and acknowledgement releases only the newest audio', async () => {
  const p = await processor(48000, { autoAck: false }); p.enable(true, 1);
  for (let i = 0; i < 100; i++) p.feed([new Float32Array(4800).fill(i / 100)]);
  assert.equal(p.messages.length, 1, 'the main thread stall must not retain ten seconds of MessagePort packets');
  p.ack(p.messages[0].id);
  assert.equal(p.messages.length, 2);
  assert.ok(p.messages[1].samples.every(sample => Math.abs(sample - 0.99) < 1e-6));
  assert.ok(Math.abs(p.messages[1].capturedAt - 9.9) < 1e-6, 'the retained packet must carry its capture time');
  p.ack(p.messages[0].id); assert.equal(p.messages.length, 2, 'duplicate acknowledgements cannot release another packet');
});

test('worklet discards old-generation pending audio without unbounding outstanding messages', async () => {
  const p = await processor(48000, { autoAck: false }); p.enable(true, 1);
  p.feed([new Float32Array(4800).fill(0.25)]); p.feed([new Float32Array(4800).fill(0.5)]);
  p.enable(false, 2); p.enable(true, 3); p.feed([new Float32Array(4800).fill(-0.5)]);
  assert.equal(p.messages.length, 1);
  p.ack(p.messages[0].id);
  assert.equal(p.messages.length, 2); assert.equal(p.messages[1].generation, 3);
  assert.ok(p.messages[1].samples.every(sample => sample === -0.5));
  p.feed([new Float32Array(4800).fill(0.75)]);
  p.ack(p.messages[0].id); assert.equal(p.messages.length, 2);
  p.ack(p.messages[1].id); assert.equal(p.messages.length, 3);
  assert.ok(p.messages[2].samples.every(sample => sample === 0.75));
});

test('capture shares the source, starts disabled and rejects messages from previous subscriptions', async () => {
  const env = browser();
  try {
    const context = new env.Context(), source = new env.Node(), analyser = {}, packets = [], errors = [];
    source.connect(analyser);
    const capture = await createAudioCapture({ context, source, onPacket: value => packets.push(value), onError: error => errors.push(error) });
    const worklet = env.worklets[0];
    let messageId = 0;
    const deliver = data => worklet.port.onmessage({ data: { id: ++messageId, capturedAt: context.currentTime, ...data } });
    const currentGeneration = () => worklet.messages.filter(message => 'enabled' in message).slice(-1)[0].generation;
    assert.ok(context.loadedModules[0].endsWith('/web/audio-worklet.js'));
    assert.ok(source.connections.has(analyser)); assert.ok(source.connections.has(worklet));
    deliver({ samples: new Float32Array(1600), generation: 0 }); assert.equal(packets.length, 0);
    capture.setEnabled(true); const enabled = worklet.messages.slice(-1)[0];
    deliver({ samples: new Float32Array(1600).fill(0.5), generation: enabled.generation });
    assert.equal(decodeAudioPacket(packets[0]).sequence, 0);
    capture.setEnabled(false); capture.setEnabled(true);
    deliver({ samples: new Float32Array(1600), generation: enabled.generation });
    assert.equal(packets.length, 1);
    deliver({ samples: new Float32Array(1600), generation: currentGeneration() });
    assert.equal(decodeAudioPacket(packets[1]).sequence, 1);
    const late = worklet.port.onmessage; capture.close(); capture.setEnabled(true);
    late({ data: { samples: new Float32Array(1600), generation: worklet.messages.slice(-1)[0].generation } });
    assert.equal(packets.length, 2); assert.equal(source.connections.size, 1); assert.ok(source.connections.has(analyser));
    assert.equal(worklet.connections.size, 0); assert.equal(worklet.port.closed, true); assert.equal(context.closed, undefined);
    assert.deepEqual(errors, []);
  } finally { env.restore(); }
});

test('capture discards packets older than half a second but acknowledges them so current audio can resume', async () => {
  const env = browser();
  try {
    const context = new env.Context(), packets = [];
    const capture = await createAudioCapture({ context, source: new env.Node(), onPacket: value => packets.push(value) });
    const worklet = env.worklets[0]; capture.setEnabled(true);
    const generation = worklet.messages[0].generation; context.currentTime = 3;
    worklet.port.onmessage({ data: { samples: new Float32Array(1600).fill(0.25), id: 1, capturedAt: 1, generation } });
    assert.equal(packets.length, 0, 'seconds-old audio must never escape after the main thread resumes');
    assert.equal(worklet.messages.slice(-1)[0].ack, 1);
    worklet.port.onmessage({ data: { samples: new Float32Array(1600).fill(0.5), id: 2, capturedAt: 2.8, generation } });
    assert.equal(packets.length, 1); assert.equal(decodeAudioPacket(packets[0]).sequence, 0);
    assert.equal(worklet.messages.slice(-1)[0].ack, 2);
    capture.setEnabled(false);
    worklet.port.onmessage({ data: { samples: new Float32Array(1600), id: 3, capturedAt: 3, generation } });
    assert.equal(packets.length, 1); assert.equal(worklet.messages.slice(-1)[0].ack, 3);
    capture.close();
  } finally { env.restore(); }
});

test('unsupported worklet rejects capture setup without closing the shared context', async () => {
  const env = browser();
  try {
    const context = new env.Context(); delete context.audioWorklet;
    await assert.rejects(createAudioCapture({ context, source: new env.Node() }), /AudioWorklet/);
    assert.equal(context.closed, undefined);
  } finally { env.restore(); }
});

test('player bounds queued audio to half a second and keeps the newest samples', () => {
  const env = browser();
  try {
    const statuses = [], player = createAudioPlayer({ onStatus: status => statuses.push(status) }), context = env.contexts[0];
    for (let i = 0; i < 30; i++) assert.equal(player.enqueue(packet(i, i / 100)), true);
    const active = context.sources.filter(node => !node.stopped && node.connections.size);
    assert.ok(active.length > 0 && active.length <= 5);
    assert.ok(Math.max(...active.map(node => node.started + node.buffer.duration)) - context.currentTime <= 0.500001);
    assert.ok(active.every(node => node.buffer.getChannelData(0)[0] > 0.24), 'old queued sound is dropped');
    assert.ok(Math.abs(active.slice(-1)[0].buffer.getChannelData(0)[0] - 0.29) < 0.00004);
    assert.ok(!statuses.some(status => status.kind === 'live'));
    player.close();
  } finally { env.restore(); }
});

test('player rejects malformed, duplicate and out-of-order packets, including at uint32 wrap', () => {
  const env = browser();
  try {
    const player = createAudioPlayer({}), context = env.contexts[0];
    assert.equal(player.enqueue(new ArrayBuffer(8)), false);
    assert.equal(player.enqueue(packet(0xfffffffe)), true); assert.equal(player.enqueue(packet(0xffffffff)), true);
    assert.equal(player.enqueue(packet(0)), true); assert.equal(player.enqueue(packet(0)), false);
    assert.equal(player.enqueue(packet(0xffffffff)), false); assert.equal(player.enqueue(packet(0x80000000)), false);
    assert.equal(context.sources.length, 3); player.reset(); assert.equal(player.enqueue(packet(0)), true); player.close();
  } finally { env.restore(); }
});

test('reset stops every PCM node and immediately disconnects RTC audio without stopping remote tracks', () => {
  const env = browser();
  try {
    const player = createAudioPlayer({}), context = env.contexts[0];
    player.enqueue(packet(1)); player.enqueue(packet(2)); const pcm = [...context.sources];
    const stream = { getAudioTracks: () => [{ stop() { assert.fail('player does not own remote tracks'); } }] };
    player.setStream(stream); assert.ok(pcm.every(node => node.stopped && node.connections.size === 0));
    assert.equal(context.streams[0].connections.size, 1);
    player.reset(); assert.equal(context.streams[0].connections.size, 0);
    player.enqueue(packet(1)); const next = context.sources.slice(-1)[0]; player.reset();
    assert.equal(next.stopped, true); assert.equal(next.connections.size, 0); player.close();
  } finally { env.restore(); }
});

test('RTC decoding retains a muted media element and releases it on stream replacement, reset and close', () => {
  const env = browser();
  try {
    const player = createAudioPlayer({}), first = {}, second = {}, third = {};
    player.setStream(first);
    assert.equal(env.elements.length, 1, 'RTC decoding must activate independently of Web Audio output');
    const element = env.elements[0];
    assert.equal(element.srcObject, first); assert.equal(element.muted, true); assert.equal(element.paused, false);
    player.setStream(first); assert.equal(env.elements.length, 1);
    player.setStream(second);
    assert.equal(element.paused, true); assert.equal(element.srcObject, null);
    assert.equal(env.elements[1].srcObject, second); assert.equal(env.elements[1].muted, true);
    player.reset(); assert.equal(env.elements[1].paused, true); assert.equal(env.elements[1].srcObject, null);
    player.setStream(third); player.close();
    assert.equal(env.elements[2].paused, true); assert.equal(env.elements[2].srcObject, null);
  } finally { env.restore(); }
});

test('late decoder play rejection cannot change status after reset or stream replacement', async () => {
  const env = browser();
  try {
    const statuses = [], player = createAudioPlayer({ onStatus: status => statuses.push(status) });
    player.setStream({});
    assert.equal(env.elements.length, 1);
    let reject;
    env.elements[0].playBehavior = () => new Promise((resolve, fail) => { reject = fail; });
    const pending = player.resume(); player.reset(); const statusCount = statuses.length;
    reject(new Error('cancelled old decoder'));
    assert.equal(await pending, false); assert.equal(statuses.length, statusCount);
    player.setStream({}); player.close(); await tick(); assert.equal(statuses.length, statusCount);
  } finally { env.restore(); }
});

test('a running AudioContext keeps the retry available until the RTC decoder plays', async () => {
  const env = browser({ state: 'suspended' });
  try {
    const statuses = [], player = createAudioPlayer({ onStatus: status => statuses.push(status) }), context = env.contexts[0];
    player.setStream({});
    const decoder = env.elements[0];
    decoder.playBehavior = () => Promise.reject(new Error('NotAllowedError'));
    context.resumeBehavior = () => Promise.resolve();
    assert.equal(await player.resume(), false);
    assert.equal(statuses[statuses.length - 1].kind, 'blocked');
    context.transition('running');
    assert.equal(statuses[statuses.length - 1].kind, 'blocked');
    let completePlay;
    decoder.playBehavior = () => new Promise(resolve => { completePlay = resolve; });
    const retry = player.resume();
    assert.equal(statuses[statuses.length - 1].kind, 'blocked');
    completePlay();
    assert.equal(await retry, true);
    assert.equal(statuses[statuses.length - 1].kind, 'waiting');
    player.close();
  } finally { env.restore(); }
});

test('a pending AudioContext resume cannot clear a later RTC decoder rejection', async () => {
  const env = browser({ state: 'suspended' });
  try {
    const statuses = [], player = createAudioPlayer({ onStatus: status => statuses.push(status) }), context = env.contexts[0];
    let completeResume;
    context.resumeBehavior = () => new Promise(resolve => { completeResume = resolve; });
    const first = player.resume();
    const createElement = document.createElement;
    document.createElement = name => {
      const decoder = createElement(name);
      decoder.playBehavior = () => Promise.reject(new Error('NotAllowedError'));
      return decoder;
    };
    player.setStream({});
    await tick();
    context.transition('running'); completeResume();
    assert.equal(await first, false);
    assert.equal(statuses[statuses.length - 1].kind, 'blocked');
    player.close();
  } finally { env.restore(); }
});

test('a pending RTC decoder keeps playback retry available even with a running AudioContext', async () => {
  const env = browser();
  try {
    const statuses = [], player = createAudioPlayer({ onStatus: status => statuses.push(status) });
    let rejectPlay;
    const createElement = document.createElement;
    document.createElement = name => {
      const decoder = createElement(name);
      decoder.playBehavior = () => new Promise((resolve, reject) => { rejectPlay = reject; });
      return decoder;
    };
    await player.resume();
    player.setStream({});
    assert.equal(statuses[statuses.length - 1].kind, 'blocked');
    await tick();
    assert.equal(statuses[statuses.length - 1].kind, 'blocked');
    rejectPlay(new Error('NotAllowedError'));
    await tick();
    assert.equal(statuses[statuses.length - 1].kind, 'blocked');
    env.elements[0].playBehavior = null;
    assert.equal(await player.resume(), true);
    assert.equal(statuses[statuses.length - 1].kind, 'waiting');
    player.close();
  } finally { env.restore(); }
});

test('RTC graph setup error persists through AudioContext resume', async () => {
  const env = browser({ state: 'suspended' });
  try {
    const statuses = [], player = createAudioPlayer({ onStatus: status => statuses.push(status) }), context = env.contexts[0];
    context.createMediaStreamSource = () => { throw new Error('RTC source unavailable'); };
    player.setStream({});
    assert.equal(statuses[statuses.length - 1].kind, 'error');
    context.transition('running');
    assert.equal(statuses[statuses.length - 1].kind, 'error');
    assert.equal(await player.resume(), false);
    assert.equal(statuses[statuses.length - 1].kind, 'error');
    player.close();
  } finally { env.restore(); }
});

test('audio playback selects the playback session before opening AudioContext and restores it after the last player', () => {
  const env = browser();
  try {
    const session = { type: 'auto' };
    env.replace('navigator', { audioSession: session });
    env.replace('AudioContext', class extends env.Context {
      constructor() { assert.equal(session.type, 'playback'); super(); }
    });
    const first = createAudioPlayer(), second = createAudioPlayer();
    assert.equal(session.type, 'playback');
    first.close(); assert.equal(session.type, 'playback');
    second.close(); assert.equal(session.type, 'auto');
  } finally { env.restore(); }
});

test('closing the player preserves an audio session type changed elsewhere', () => {
  const env = browser();
  try {
    const session = { type: 'ambient' };
    env.replace('navigator', { audioSession: session });
    const player = createAudioPlayer();
    assert.equal(session.type, 'playback');
    session.type = 'play-and-record';
    player.close(); assert.equal(session.type, 'play-and-record');
  } finally { env.restore(); }
});

test('failed AudioContext setup releases the playback session', () => {
  const env = browser();
  try {
    const session = { type: 'auto' };
    env.replace('navigator', { audioSession: session });
    let typeAtSetup;
    env.replace('AudioContext', class {
      constructor() { typeAtSetup = session.type; throw new Error('AudioContext unavailable'); }
    });
    const statuses = [], player = createAudioPlayer({ onStatus: status => statuses.push(status) });
    assert.equal(typeAtSetup, 'playback');
    assert.equal(session.type, 'auto');
    assert.equal(statuses[statuses.length - 1].kind, 'error');
    player.close();
  } finally { env.restore(); }
});

test('a rejected AudioSession setting leaves audio playback usable', async () => {
  const env = browser();
  try {
    env.replace('navigator', { audioSession: { get type() { return 'auto'; }, set type(_) { throw new Error('unsupported'); } } });
    const player = createAudioPlayer();
    assert.equal(await player.resume(), true);
    assert.equal(player.enqueue(packet(1)), true);
    player.close();
  } finally { env.restore(); }
});

test('resume is invoked synchronously, reports blocked playback and can retry without claiming live', async () => {
  const env = browser({ state: 'suspended' });
  try {
    const statuses = [], player = createAudioPlayer({ onStatus: status => statuses.push(status) }), context = env.contexts[0];
    context.resumeBehavior = () => Promise.reject(new Error('NotAllowedError'));
    const attempt = player.resume(); assert.equal(context.resumeCalls, 1, 'resume must run within the original user gesture');
    assert.equal(await attempt, false); assert.equal(statuses.slice(-1)[0].kind, 'blocked');
    for (let i = 0; i < 20; i++) assert.equal(player.enqueue(packet(i)), false);
    assert.equal(context.sources.length, 0);
    context.resumeBehavior = null; assert.equal(await player.resume(), true);
    assert.equal(statuses.slice(-1)[0].kind, 'waiting'); assert.equal(player.enqueue(packet(20)), true);
    assert.ok(!statuses.some(status => status.kind === 'live')); player.close();
  } finally { env.restore(); }
});

test('a resolved resume while still suspended remains blocked', async () => {
  const env = browser({ state: 'suspended' });
  try {
    const statuses = [], player = createAudioPlayer({ onStatus: status => statuses.push(status) }), context = env.contexts[0];
    context.resumeBehavior = () => Promise.resolve(); assert.equal(await player.resume(), false);
    assert.equal(statuses.slice(-1)[0].kind, 'blocked'); player.close();
  } finally { env.restore(); }
});

test('a pending browser resume immediately exposes a retry until audio actually runs', async () => {
  const env = browser({ state: 'suspended' });
  try {
    const statuses = [], player = createAudioPlayer({ onStatus: status => statuses.push(status) }), context = env.contexts[0];
    let resolve; context.resumeBehavior = () => new Promise(done => { resolve = done; });
    const pending = player.resume(); await tick();
    assert.equal(statuses[statuses.length - 1]?.kind, 'blocked', 'an unresolved browser promise must not hide the retry action');
    context.transition('running'); resolve(); assert.equal(await pending, true);
    assert.equal(statuses[statuses.length - 1].kind, 'waiting'); player.close();
  } finally { env.restore(); }
});

test('suspension discards scheduled PCM so retry cannot replay stale audio', async () => {
  const env = browser();
  try {
    const player = createAudioPlayer({}), context = env.contexts[0];
    player.enqueue(packet(1)); const node = context.sources[0]; context.transition('suspended');
    assert.equal(node.stopped, true); assert.equal(node.connections.size, 0);
    assert.equal(await player.resume(), true); assert.equal(context.sources.length, 1); player.close();
  } finally { env.restore(); }
});

test('close and reset invalidate pending resumes and stale callbacks cannot restore sound or status', async () => {
  const env = browser({ state: 'suspended' });
  try {
    const statuses = [], player = createAudioPlayer({ onStatus: status => statuses.push(status) }), context = env.contexts[0];
    let resolve; context.resumeBehavior = () => new Promise(done => { resolve = done; });
    const pending = player.resume(); player.reset(); const count = statuses.length;
    context.state = 'running'; resolve(); assert.equal(await pending, false); assert.equal(statuses.length, count);
    player.enqueue(packet(1)); player.setStream({}); const stateCallback = context.onstatechange;
    player.close(); const closedCount = statuses.length; stateCallback?.();
    assert.equal(player.enqueue(packet(2)), false); player.setStream({}); assert.equal(await player.resume(), false); await tick();
    assert.equal(context.closed, true); assert.ok(context.sources.every(node => node.stopped));
    assert.ok(context.streams.every(node => node.connections.size === 0)); assert.equal(statuses.length, closedCount);
  } finally { env.restore(); }
});

let failed = 0;
for (const { name, run } of tests) {
  try { await run(); console.log(`ok - ${name}`); }
  catch (error) { failed++; console.error(`not ok - ${name}\n${error.stack}`); }
}
console.log(`${tests.length - failed} audio tests passed; ${failed} failed`);
if (failed) process.exitCode = 1;
