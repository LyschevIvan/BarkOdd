const noop = () => {};
const clock = () => performance.now();
const connectionID = () => globalThis.crypto?.randomUUID?.() || `rtc-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;

// Signaling remains on the authenticated control socket. Closing this helper
// invalidates every in-flight browser promise as well as the live connections.
export function createRTC({ role, clientId, iceServers = [], stream, send, onStream = noop, onStatus = noop, onError = noop }) {
  if (!globalThis.RTCPeerConnection) throw new Error('Этот браузер не поддерживает WebRTC.');
  let active = true, publishing = true, monitoring = false, sourceId = '', lease = null, visible = null;
  let authorized = new Set();
  const peers = new Map(), retries = new Map(), delays = new Map(), timers = new Set();
  const later = (delay, callback) => {
    const timer = setTimeout(() => { timers.delete(timer); if (active) callback(); }, delay);
    timers.add(timer); return timer;
  };
  const cancel = timer => { clearTimeout(timer); timers.delete(timer); };
  const display = value => { if (visible !== value) { visible = value; onStream(value); } };
  const allowed = id => active && monitoring && (role === 'host' ? publishing && authorized.has(id) : id === sourceId);
  const current = peer => allowed(peer.id) && peers.get(peer.id) === peer;
  function remove(peer) {
    if (peers.get(peer.id) !== peer) return;
    peers.delete(peer.id);
    cancel(peer.timeout); cancel(peer.frameTimer); cancel(peer.pollTimer); cancel(peer.recoveryTimer); cancel(peer.disconnectTimer);
    const pc = peer.pc;
    pc.onicecandidate = pc.onconnectionstatechange = pc.oniceconnectionstatechange = pc.ontrack = null;
    pc.close();
    if (peer.video) {
      peer.video.cancelVideoFrameCallback?.(peer.frameCallback);
      peer.video.pause(); peer.video.srcObject = null;
    }
    if (role === 'viewer') display(null);
    peer.candidates.length = peer.localCandidates.length = 0;
  }
  function clear() {
    for (const peer of [...peers.values()]) remove(peer);
    for (const timer of retries.values()) cancel(timer);
    retries.clear();
  }
  function fail(peer) {
    if (!current(peer)) return;
    const id = peer.id;
    remove(peer);
    if (role !== 'host' || retries.has(id)) return;
    const delay = delays.get(id) || 500;
    delays.set(id, Math.min(5000, delay * 2));
    retries.set(id, later(delay, () => { retries.delete(id); if (allowed(id)) offer(id); }));
  }
  function transmit(peer, signal) {
    if (current(peer)) send({ type: 'signal', target: peer.id, connectionId: peer.connectionId, signal });
  }
  async function localDescription(peer, description) {
    if (!current(peer)) return;
    await peer.pc.setLocalDescription(description);
    if (!current(peer)) return;
    transmit(peer, { type: description.type, sdp: peer.pc.localDescription.sdp });
    peer.signaled = true;
    for (const candidate of peer.localCandidates.splice(0)) transmit(peer, { type: 'candidate', candidate });
  }
  function decoded(peer) {
    if (!current(peer)) return;
    peer.lastFrame = clock();
    cancel(peer.frameTimer); cancel(peer.recoveryTimer);
    display(peer.remoteStream);
    onStatus('live', 'Прямая трансляция');
    peer.frameTimer = later(3000, () => {
      if (!current(peer)) return;
      display(null);
      onStatus('connecting', 'Нет новых кадров. Ожидаем устройство питомца…');
      // A receiver which remains frozen is closed so the sender's connection
      // state initiates a new offer; a resumed decoder cancels this recovery.
      peer.recoveryTimer = later(3000, () => fail(peer));
    });
  }
  function observe(peer, remoteStream) {
    if (!current(peer) || peer.video || !remoteStream) return;
    peer.remoteStream = remoteStream;
    const video = peer.video = document.createElement('video');
    video.muted = true; video.autoplay = true; video.playsInline = true; video.srcObject = remoteStream;
    void Promise.resolve(video.play()).catch(() => { /* Retry via the next source offer if autoplay is unavailable. */ });
    if (video.requestVideoFrameCallback) {
      let lastPresented = 0;
      const tick = (_, metadata) => {
        if (!current(peer)) return;
        if (metadata.presentedFrames > lastPresented) { lastPresented = metadata.presentedFrames; decoded(peer); }
        peer.frameCallback = video.requestVideoFrameCallback(tick);
      };
      peer.frameCallback = video.requestVideoFrameCallback(tick);
    } else {
      let count = 0;
      const poll = () => {
        if (!current(peer)) return;
        const total = video.getVideoPlaybackQuality?.().totalVideoFrames ?? video.webkitDecodedFrameCount ?? 0;
        if (total > count) { count = total; decoded(peer); }
        peer.pollTimer = later(250, poll);
      };
      poll();
    }
    // Connected ICE with no decoded video must also recover instead of showing
    // an indefinitely blank stream.
    peer.recoveryTimer = later(10000, () => fail(peer));
  }
  function makePeer(id, connectionId) {
    const pc = new RTCPeerConnection({ iceServers });
    const peer = { id, connectionId, pc, candidates: [], localCandidates: [], remoteReady: false, signaled: false, chain: Promise.resolve() };
    peers.set(id, peer);
    peer.timeout = later(10000, () => fail(peer));
    pc.onicecandidate = event => {
      if (!current(peer)) return;
      const candidate = event.candidate?.toJSON?.() ?? event.candidate ?? null;
      if (peer.signaled) transmit(peer, { type: 'candidate', candidate });
      else if (peer.localCandidates.length < 128) peer.localCandidates.push(candidate);
      else fail(peer);
    };
    const connection = () => {
      if (!current(peer)) return;
      const state = pc.connectionState || pc.iceConnectionState;
      if (state === 'connected' || state === 'completed') { cancel(peer.timeout); cancel(peer.disconnectTimer); peer.disconnectTimer = null; delays.delete(id); }
      else if (state === 'failed' || state === 'closed') fail(peer);
      else if (state === 'disconnected' && !peer.disconnectTimer) peer.disconnectTimer = later(1000, () => fail(peer));
    };
    pc.onconnectionstatechange = pc.oniceconnectionstatechange = connection;
    pc.ontrack = event => {
      if (role === 'viewer' && current(peer) && event.track.kind === 'video') {
        observe(peer, event.streams?.[0] || new MediaStream([event.track]));
      }
    };
    return peer;
  }
  function run(peer, task) {
    peer.chain = peer.chain.then(async () => { if (current(peer)) await task(); }).catch(() => { if (current(peer)) fail(peer); });
  }
  function offer(id) {
    if (!allowed(id) || peers.has(id) || retries.has(id)) return;
    let peer;
    try {
      peer = makePeer(id, connectionID());
      // Never attach the microphone: its only consumer is the local detector.
      for (const track of stream.getVideoTracks()) peer.pc.addTrack(track, stream);
      run(peer, async () => { const description = await peer.pc.createOffer(); if (current(peer)) await localDescription(peer, description); });
    } catch (error) { if (peer) fail(peer); onError(error); }
  }
  async function remoteDescription(peer, description) {
    if (!current(peer)) return;
    await peer.pc.setRemoteDescription(description);
    if (!current(peer)) return;
    peer.remoteReady = true;
    for (const candidate of peer.candidates.splice(0)) {
      if (!current(peer)) return;
      await peer.pc.addIceCandidate(candidate);
    }
  }
  function signal(message) {
    if (!active || !allowed(message.from) || !message.connectionId || !message.signal) return;
    const { from, connectionId, signal } = message;
    let peer = peers.get(from);
    if (signal.type === 'offer' && role === 'viewer') {
      if (peer?.connectionId === connectionId) return;
      if (peer) remove(peer);
      try { peer = makePeer(from, connectionId); } catch (error) { onError(error); return; }
      run(peer, async () => {
        await remoteDescription(peer, { type: 'offer', sdp: signal.sdp });
        if (!current(peer)) return;
        const answer = await peer.pc.createAnswer();
        if (current(peer)) await localDescription(peer, answer);
      });
    } else if (peer?.connectionId === connectionId) {
      if (signal.type === 'answer' && role === 'host' && !peer.answerReceived) {
        peer.answerReceived = true;
        run(peer, () => remoteDescription(peer, { type: 'answer', sdp: signal.sdp }));
      } else if (signal.type === 'candidate') {
        if (!peer.remoteReady) {
          if (peer.candidates.length >= 128) fail(peer);
          else peer.candidates.push(signal.candidate ?? null);
        } else run(peer, () => peer.pc.addIceCandidate(signal.candidate ?? null));
      }
    }
  }
  function updateState(message) {
    if (!active) return;
    if (role === 'host' && message.type === 'viewers') {
      authorized = new Set((Array.isArray(message.ids) ? message.ids : []).filter(id => typeof id === 'string' && id && id !== clientId).slice(0, 6));
      monitoring = message.monitoring === true;
    } else if (role === 'viewer' && message.type === 'source') {
      const next = message.online === true && typeof message.sourceId === 'string' ? message.sourceId : '';
      if (next !== sourceId) clear();
      sourceId = next;
      monitoring = !!sourceId && message.monitoring === true;
    } else return;
    for (const id of delays.keys()) if (role === 'host' && !authorized.has(id)) delays.delete(id);
    cancel(lease);
    lease = later(6000, () => {
      monitoring = false; clear();
      onStatus('offline', 'Нет связи с сервером. Ожидаем подтверждение трансляции…');
    });
    for (const peer of [...peers.values()]) if (!allowed(peer.id)) remove(peer);
    for (const [id, timer] of retries) if (!allowed(id)) { cancel(timer); retries.delete(id); }
    if (role === 'host') for (const id of authorized) offer(id);
  }
  function setPublishing(value) {
    publishing = !!value;
    if (!publishing) clear();
    else if (role === 'host') for (const id of authorized) offer(id);
  }
  function close() {
    active = false; clear();
    for (const timer of timers) clearTimeout(timer);
    timers.clear(); display(null);
  }
  return { updateState, signal, setPublishing, close };
}
