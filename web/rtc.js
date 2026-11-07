const noop = () => {};
const clock = () => performance.now();
const connectionID = () => globalThis.crypto?.randomUUID?.() || `rtc-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
const wantsAudio = mode => mode === 'audio' || mode === 'audio-video';
const wantsVideo = mode => mode !== 'audio';
const subscription = mode => wantsAudio(mode) ? mode : 'video';

// Signaling remains on the authenticated control socket. Closing this helper
// invalidates every in-flight browser promise as well as the live connections.
export function createRTC({ role, clientId, iceServers = [], stream, mode = 'video', send, onStream = noop, onStatus = noop, onAudioStream = noop, onAudioStatus = noop, onError = noop }) {
  if (!globalThis.RTCPeerConnection) throw new Error('Этот браузер не поддерживает WebRTC.');
  let active = true, publishing = true, monitoring = false, sourceId = '', lease = null, visible = null, audible = null;
  let authorized = new Set(), modes = new Map();
  const peers = new Map(), retries = new Map(), delays = new Map(), timers = new Set(), retired = new Set();
  const later = (delay, callback) => {
    const timer = setTimeout(() => { timers.delete(timer); if (active) callback(); }, delay);
    timers.add(timer); return timer;
  };
  const cancel = timer => { clearTimeout(timer); timers.delete(timer); };
  const display = value => { if (visible !== value) { visible = value; onStream(value); } };
  const sound = value => { if (audible !== value) { audible = value; onAudioStream(value); } };
  const allowed = id => active && monitoring && (role === 'host' ? publishing && authorized.has(id) : id === sourceId);
  const current = peer => allowed(peer.id) && peers.get(peer.id) === peer;
  function remove(peer) {
    if (peers.get(peer.id) !== peer) return;
    peers.delete(peer.id);
    cancel(peer.timeout); cancel(peer.frameTimer); cancel(peer.pollTimer); cancel(peer.recoveryTimer); cancel(peer.disconnectTimer); cancel(peer.audioTimer);
    const pc = peer.pc;
    pc.onicecandidate = pc.onconnectionstatechange = pc.oniceconnectionstatechange = pc.ontrack = null;
    pc.close();
    if (peer.video) {
      peer.video.cancelVideoFrameCallback?.(peer.frameCallback);
      peer.video.pause(); peer.video.srcObject = null;
    }
    for (const [track, state] of peer.audioTracks) track.removeEventListener?.('ended', state.ended);
    peer.audioTracks.clear();
    if (role === 'viewer') {
      display(null); sound(null);
      if (active && wantsAudio(peer.mode)) onAudioStatus('connecting', 'Ожидаем звук с устройства питомца…');
      retired.add(`${peer.id}\0${peer.connectionId}`);
      if (retired.size > 128) retired.delete(retired.values().next().value);
    }
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
  const audioHealthy = peer => peer.lastAudioPacket != null && clock() - peer.lastAudioPacket < 3000 && peer.audioTracks.size > 0;
  const videoHealthy = peer => peer.lastFrame != null && clock() - peer.lastFrame < 3000;
  function recoverVideo(peer) {
    if (!current(peer)) return;
    // A stalled picture may recover on this connection. Replacing the whole
    // connection would unnecessarily interrupt independently arriving sound.
    if (audioHealthy(peer)) peer.recoveryTimer = later(1000, () => recoverVideo(peer));
    else fail(peer);
  }
  function audioStatus(peer, kind, message) {
    const value = `${kind}:${message}`;
    if (current(peer) && peer.audioStatus !== value) { peer.audioStatus = value; onAudioStatus(kind, message); }
  }
  async function pollAudio(peer) {
    if (!current(peer)) return;
    let progress = false;
    for (const [track, state] of peer.audioTracks) {
      if (track.readyState === 'ended') continue;
      try {
        // Receiver reports isolate the selected track; the PC fallback supports
        // implementations without receiver.getStats. Energy is deliberately not
        // involved: real silence still delivers RTP packets.
        const report = await (state.receiver?.getStats ? state.receiver.getStats() : peer.pc.getStats(track));
        if (!current(peer)) return;
        if (!peer.audioTracks.has(track) || track.readyState === 'ended') continue;
        report.forEach(stat => {
          if (stat.type !== 'inbound-rtp' || (stat.kind || stat.mediaType) !== 'audio') return;
          const packets = stat.packetsReceived;
          if (!Number.isFinite(packets)) return;
          const key = stat.id || stat.ssrc || 'audio';
          const previous = state.packets.get(key) || 0;
          if (packets > previous) progress = true;
          state.packets.set(key, packets);
        });
      } catch { /* A transient stats failure does not stop a healthy video. */ }
    }
    if (!current(peer)) return;
    if (progress) {
      peer.lastAudioPacket = clock();
      sound(peer.audioStream);
      audioStatus(peer, 'live', 'Прямой звук');
    }
  }
  function watchAudio(peer) {
    if (!current(peer)) return;
    const elapsed = clock() - (peer.lastAudioPacket ?? peer.started);
    if (elapsed >= 3000 && !audioHealthy(peer)) {
      sound(null);
      audioStatus(peer, 'connecting', 'Нет новых аудиопакетов. Ожидаем устройство питомца…');
    }
    if (elapsed >= (peer.lastAudioPacket == null ? 10000 : 6000) && !videoHealthy(peer)) { fail(peer); return; }
    // Keep the deadline independent of browser promises, with at most one
    // stats request in flight even if getStats stops resolving.
    if (!peer.audioPolling) {
      peer.audioPolling = true;
      void pollAudio(peer).finally(() => { peer.audioPolling = false; });
    }
    peer.audioTimer = later(500, () => watchAudio(peer));
  }
  function observeAudio(peer, event) {
    const track = event.track;
    if (peer.audioTracks.has(track) || track.readyState === 'ended') return;
    if (!peer.audioStream) peer.audioStream = new MediaStream();
    peer.audioStream.addTrack(track);
    const ended = () => {
      if (!current(peer)) return;
      peer.audioStream.removeTrack(track);
      peer.audioTracks.delete(track);
      track.removeEventListener?.('ended', ended);
      if (!peer.audioTracks.size) {
        peer.lastAudioPacket = null;
        sound(null);
        audioStatus(peer, 'connecting', 'Звуковая дорожка завершена. Ожидаем устройство питомца…');
      }
    };
    peer.audioTracks.set(track, { receiver: event.receiver, packets: new Map(), ended });
    track.addEventListener?.('ended', ended);
    sound(peer.audioStream);
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
      peer.recoveryTimer = later(3000, () => recoverVideo(peer));
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
    peer.recoveryTimer = later(10000, () => recoverVideo(peer));
  }
  function makePeer(id, connectionId) {
    const pc = new RTCPeerConnection({ iceServers });
    const peer = { id, connectionId, pc, mode: role === 'host' ? modes.get(id) || 'video' : subscription(mode), started: clock(),
      audioTracks: new Map(), candidates: [], localCandidates: [], remoteReady: false, signaled: false, chain: Promise.resolve() };
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
      if (role !== 'viewer' || !current(peer)) return;
      if (event.track.kind === 'video' && wantsVideo(peer.mode)) {
        observe(peer, event.streams?.[0] || new MediaStream([event.track]));
      } else if (event.track.kind === 'audio' && wantsAudio(peer.mode)) observeAudio(peer, event);
    };
    if (role === 'viewer' && wantsAudio(peer.mode)) {
      audioStatus(peer, 'connecting', 'Ожидаем звук с устройства питомца…');
      peer.audioTimer = later(500, () => watchAudio(peer));
    }
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
      if (wantsVideo(peer.mode)) for (const track of stream.getVideoTracks()) peer.pc.addTrack(track, stream);
      if (wantsAudio(peer.mode)) for (const track of stream.getAudioTracks()) peer.pc.addTrack(track, stream);
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
      if (peer?.connectionId === connectionId || retired.has(`${from}\0${connectionId}`)) return;
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
      modes = new Map([...authorized].map(id => [id, subscription(message.modes?.[id])]));
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
      if (role === 'viewer' && wantsAudio(mode)) onAudioStatus('offline', 'Нет связи с сервером. Ожидаем подтверждение звука…');
    });
    for (const peer of [...peers.values()]) if (!allowed(peer.id) || (role === 'host' && peer.mode !== modes.get(peer.id))) remove(peer);
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
    timers.clear(); display(null); sound(null);
  }
  return { updateState, signal, setPublishing, close };
}
