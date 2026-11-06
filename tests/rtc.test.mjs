import { strict as assert } from 'assert';
import { createRTC } from '../web/rtc.js';

// PeerConnection and video decoding are browser boundaries. Authorization,
// negotiation, generations, lease, and recovery run in the real RTC helper.
function environment(role = 'host') {
  const originals = new Map();
  const replace = (name, value) => {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  };
  let time = 0, sequence = 0;
  const timers = new Map(), peers = [], sent = [], streams = [], statuses = [], errors = [], videos = [];
  const videoTrack = { kind: 'video', readyState: 'live' }, audioTrack = { kind: 'audio', readyState: 'live' };
  const stream = { getTracks: () => [videoTrack, audioTrack], getVideoTracks: () => [videoTrack] };
  let resolveOffer, deferOffer = false, resolveRemote, deferRemote = false, earlyICE = false, frameCallbacks = true;
  class Peer {
    constructor(config) { this.config = config; this.tracks = []; this.candidates = []; this.connectionState = 'new'; peers.push(this); }
    addTrack(track, source) { this.tracks.push({ track, source }); }
    async createOffer() { if (deferOffer) return new Promise(resolve => { resolveOffer = resolve; }); return { type: 'offer', sdp: 'host-offer' }; }
    async createAnswer() { return { type: 'answer', sdp: 'viewer-answer' }; }
    async setLocalDescription(description) { this.localDescription = description; if (earlyICE) this.onicecandidate?.({ candidate: { candidate: 'local', sdpMid: '0' } }); }
    async setRemoteDescription(description) { if (deferRemote) await new Promise(resolve => { resolveRemote = resolve; }); this.remoteDescription = description; }
    async addIceCandidate(candidate) { assert.ok(this.remoteDescription, 'ICE must wait for the remote SDP'); this.candidates.push(candidate); }
    close() { this.connectionState = 'closed'; this.closed = true; }
    connection(state) { this.connectionState = state; this.onconnectionstatechange?.(); }
    track(remote) { this.ontrack?.({ track: { kind: 'video' }, streams: [remote] }); }
  }
  replace('RTCPeerConnection', Peer);
  replace('performance', { now: () => time });
  replace('setTimeout', (callback, delay = 0) => { const id = ++sequence; timers.set(id, { callback, at: time + delay }); return id; });
  replace('clearTimeout', id => timers.delete(id));
  replace('document', { createElement(name) {
    assert.equal(name, 'video');
    const video = { muted: false, readyState: 4, count: 0,
      play: async () => {}, pause() {},
      getVideoPlaybackQuality() { return { totalVideoFrames: this.count }; },
      requestVideoFrameCallback(callback) { this.callback = callback; return 1; },
      cancelVideoFrameCallback() { this.callback = null; },
      decoded() { this.count++; const callback = this.callback; this.callback = null; callback?.(time, { presentedFrames: this.count }); },
    };
    if (!frameCallbacks) delete video.requestVideoFrameCallback;
    videos.push(video); return video;
  } });
  const rtc = createRTC({ role, clientId: `${role}-id`, iceServers: [{ urls: 'stun:example.test' }], stream,
    send: message => sent.push(message), onStream: stream => streams.push(stream), onStatus: (kind, message) => statuses.push({ kind, message }), onError: error => errors.push(error),
  });
  const settle = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
  const advance = async duration => {
    const end = time + duration; await settle();
    while (true) {
      const next = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      timers.delete(next[0]); time = next[1].at; next[1].callback(); await settle();
    }
    time = end; await settle();
  };
  return { rtc, peers, sent, streams, statuses, errors, videos, stream, videoTrack, audioTrack, settle, advance,
    roster(ids = ['viewer-id'], monitoring = true) { rtc.updateState({ type: 'viewers', ids, count: ids.length, monitoring }); },
    source(id = 'host-id', monitoring = true) { rtc.updateState({ type: 'source', sourceId: id, online: !!id, monitoring }); },
    offer(id = 'one', from = 'host-id') { rtc.signal({ from, connectionId: id, signal: { type: 'offer', sdp: 'host-offer' } }); },
    earlyICE() { earlyICE = true; },
    decodedCountFallback() { frameCallbacks = false; },
    deferOffer() { deferOffer = true; }, resolveOffer() { resolveOffer({ type: 'offer', sdp: 'late-offer' }); },
    deferRemote() { deferRemote = true; }, resolveRemote() { deferRemote = false; resolveRemote(); },
    cleanup() { rtc.close(); for (const [name, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name]; } },
  };
}
let passed = 0, failed = 0;
async function test(name, role, run) {
  const env = environment(role);
  try { await run(env); assert.deepEqual(env.errors, []); passed++; console.log(`ok - ${name}`); }
  catch (error) { failed++; console.error(`not ok - ${name}\n${error.stack}`); }
  finally { env.cleanup(); }
}
await test('host offers video only to authorized roster IDs and closes revoked peers', 'host', async env => {
  env.roster(['one', 'two']); await env.settle();
  assert.equal(env.peers.length, 2);
  assert.ok(env.peers.every(peer => peer.tracks.length === 1 && peer.tracks[0].track === env.videoTrack));
  assert.deepEqual(env.sent.filter(message => message.signal.type === 'offer').map(message => message.target), ['one', 'two']);
  env.roster(['two']); assert.equal(env.peers[0].closed, true); assert.equal(env.peers[1].closed, undefined);
  env.roster(['two'], false); assert.equal(env.peers[1].closed, true);
});
await test('lost control lease closes output and fresh roster permits new offers', 'host', async env => {
  env.roster(); await env.settle();
  await env.advance(5999); assert.equal(env.peers[0].closed, undefined);
  await env.advance(1); assert.equal(env.peers[0].closed, true);
  env.roster(); await env.settle(); assert.equal(env.peers.length, 2);
  assert.notEqual(env.sent[0].connectionId, env.sent[1].connectionId);
});
await test('stop or roster revocation cancels a pending offer before it can escape', 'host', async env => {
  env.deferOffer(); env.roster(); await env.settle(); env.roster([]);
  env.resolveOffer(); await env.settle(); assert.equal(env.sent.length, 0);
  assert.equal(env.peers[0].closed, true);
});
await test('viewer queues candidates during SDP and ignores stale connection generations', 'viewer', async env => {
  env.source(); env.deferRemote(); env.offer(); await env.settle();
  env.rtc.signal({ from: 'host-id', connectionId: 'one', signal: { type: 'candidate', candidate: { candidate: 'early' } } });
  assert.equal(env.peers[0].candidates.length, 0);
  env.resolveRemote(); await env.settle();
  assert.deepEqual(env.peers[0].candidates, [{ candidate: 'early' }]);
  assert.equal(env.sent[0].signal.type, 'answer');
  env.offer('two'); await env.settle();
  env.rtc.signal({ from: 'host-id', connectionId: 'one', signal: { type: 'candidate', candidate: { candidate: 'stale' } } });
  assert.equal(env.peers[0].closed, true); assert.equal(env.peers[1].candidates.length, 0);
  env.source('new-host'); assert.equal(env.peers[1].closed, true);
  env.offer('obsolete', 'host-id'); await env.settle(); assert.equal(env.peers.length, 2);
});
await test('candidate queue has a strict bound and cannot revive a cancelled peer', 'viewer', async env => {
  env.source(); env.deferRemote(); env.offer(); await env.settle();
  for (let i = 0; i < 129; i++) env.rtc.signal({ from: 'host-id', connectionId: 'one', signal: { type: 'candidate', candidate: { candidate: String(i) } } });
  assert.equal(env.peers[0].closed, true);
  env.resolveRemote(); await env.settle(); assert.equal(env.sent.length, 0);
});
await test('ICE connected is not live; decoded progress is required and frozen video clears', 'viewer', async env => {
  env.source(); env.offer(); await env.settle();
  const peer = env.peers[0]; peer.connection('connected');
  const stream = { getVideoTracks: () => [env.videoTrack] }; peer.track(stream); await env.settle();
  assert.ok(!env.statuses.some(status => status.kind === 'live'));
  assert.ok(!env.streams.includes(stream), 'do not display an undecoded stream');
  env.videos[0].decoded(); assert.equal(env.streams[env.streams.length - 1], stream);
  assert.equal(env.statuses[env.statuses.length - 1].kind, 'live');
  await env.advance(2999); assert.equal(env.streams[env.streams.length - 1], stream);
  await env.advance(1); assert.equal(env.streams[env.streams.length - 1], null);
  env.videos[0].decoded(); assert.equal(env.streams[env.streams.length - 1], stream);
  env.source('host-id', false); assert.equal(peer.closed, true); assert.equal(env.streams[env.streams.length - 1], null);
});
await test('failed host peers recover with a bounded delay and a new connection ID', 'host', async env => {
  env.roster(); await env.settle(); const first = env.sent[0].connectionId;
  env.peers[0].connection('failed'); await env.advance(499); assert.equal(env.peers.length, 1);
  await env.advance(1); assert.equal(env.peers.length, 2); assert.notEqual(env.sent[1].connectionId, first);
});
await test('local unhealthy capture closes sending peers immediately and resumes from authorized state', 'host', async env => {
  env.roster(); await env.settle(); env.rtc.setPublishing(false); assert.equal(env.peers[0].closed, true);
  env.rtc.setPublishing(true); await env.settle(); assert.equal(env.peers.length, 2);
  env.rtc.close(); const count = env.sent.length; await env.advance(20000); assert.equal(env.sent.length, count);
});
await test('a connected peer without decoded frames is closed for recovery', 'viewer', async env => {
  env.source(); env.offer(); await env.settle();
  env.peers[0].track({ getVideoTracks: () => [env.videoTrack] });
  env.peers[0].connection('connected');
  for (let i = 0; i < 10; i++) { await env.advance(1000); env.source(); }
  assert.equal(env.peers[0].closed, true, 'ICE success cannot suppress the no-video recovery deadline');
});
await test('lease refresh cannot restore output after intentional close', 'host', async env => {
  env.roster(); await env.settle(); env.rtc.close();
  env.roster(); env.rtc.setPublishing(true); await env.advance(20000);
  assert.equal(env.peers.length, 1); assert.equal(env.peers[0].closed, true);
});
await test('pause during remote SDP cannot send a late answer or publish a late track', 'viewer', async env => {
  env.source(); env.deferRemote(); env.offer(); await env.settle();
  const peer = env.peers[0]; const lateTrack = peer.ontrack;
  env.source('host-id', false); env.resolveRemote(); await env.settle();
  lateTrack({ track: { kind: 'video' }, streams: [{}] });
  assert.equal(env.sent.length, 0); assert.equal(env.videos.length, 0); assert.equal(peer.closed, true);
});

await test('local ICE discovered during setLocalDescription is sent after its offer', 'host', async env => {
  env.earlyICE(); env.roster(); await env.settle();
  assert.deepEqual(env.sent.map(message => message.signal.type), ['offer', 'candidate']);
  assert.equal(env.sent[0].connectionId, env.sent[1].connectionId);
});
await test('decoded-frame-count fallback requires progress and also clears frozen video', 'viewer', async env => {
  env.decodedCountFallback(); env.source(); env.offer(); await env.settle();
  const stream = { getVideoTracks: () => [env.videoTrack] };
  env.peers[0].track(stream); await env.advance(500);
  assert.ok(!env.statuses.some(status => status.kind === 'live'));
  env.videos[0].count = 1; await env.advance(250);
  assert.equal(env.streams[env.streams.length - 1], stream);
  for (let i = 0; i < 3; i++) { env.source(); await env.advance(1000); }
  assert.equal(env.streams[env.streams.length - 1], null);
});

console.log(`${passed} RTC tests passed; ${failed} failed`);
if (failed) process.exitCode = 1;
