import { test, expect } from '@playwright/test';

const transport = process.env.BARKODD_TRANSPORT || 'websocket';
const authMode = process.env.BARKODD_AUTH_MODE || 'admin_code';
const liveSelector = transport === 'webrtc' ? '#remote-video' : '#live-frame';

async function syntheticDevices(page) {
  // Chromium uses its fake-device flags. WebKit has no equivalent: inject a
  // real synthetic media graph so Safari-engine tests never open real devices.
  if (!process.env.BARKODD_BROWSER || process.env.BARKODD_BROWSER === 'chromium') return;
  await page.addInitScript(() => {
    const NativeAudio = window.AudioContext;
    navigator.mediaDevices.getUserMedia = async () => {
      const audio = new NativeAudio();
      const oscillator = audio.createOscillator();
      const gain = audio.createGain();
      const destination = audio.createMediaStreamDestination();
      gain.gain.value = 0.2;
      oscillator.connect(gain);
      gain.connect(destination);
      oscillator.start();
      await audio.resume();
      const canvas = document.createElement('canvas');
      canvas.width = 320; canvas.height = 240;
      const draw = () => {
        canvas.getContext('2d').fillRect(0, 0, canvas.width, canvas.height);
        requestAnimationFrame(draw);
      };
      draw();
      const stream = canvas.captureStream(10);
      stream.addTrack(destination.stream.getAudioTracks()[0]);
      window.__syntheticAudio = audio;
      return stream;
    };
  });
}

async function instrument(page) {
  await page.addInitScript(localICE => {
    window.__peers = [];
    window.__audioPeak = 0;
    window.__mediaRequests = 0;
    window.__videoSent = 0;
    window.__audioSent = 0;
    window.__roster = null;
    window.__sockets = [];
    window.__playbackContexts = [];
    window.__streamSources = [];
    window.__audioOperations = [];
    window.__localICERewrites = 0;
    const gum = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = (...args) => { window.__mediaRequests++; return gum(...args); };
    const Peer = RTCPeerConnection;
    window.RTCPeerConnection = class extends Peer {
      constructor(...args) { super(...args); window.__peers.push(this); }
      addIceCandidate(candidate) {
        // Optional same-machine WebKit test workaround: its isolated contexts
        // cannot resolve each other's mDNS host names without STUN. Signaling
        // still carries the native candidate; only the test receiver resolves
        // that host to loopback. This does not test real-network ICE discovery.
        if (localICE && ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname) && candidate?.candidate) {
          const parts = candidate.candidate.split(' ');
          if (parts[2]?.toLowerCase() === 'udp' && parts[6] === 'typ' && parts[7] === 'host' && /\.local\.?$/i.test(parts[4] || '')) {
            parts[4] = '127.0.0.1';
            candidate = { ...candidate, candidate: parts.join(' ') };
            window.__localICERewrites++;
          }
        }
        return super.addIceCandidate(candidate);
      }
    };
    const Socket = WebSocket;
    window.WebSocket = class extends Socket {
      constructor(...args) {
        super(...args);
        window.__sockets.push(this);
        this.addEventListener('message', e => {
          if (typeof e.data === 'string') {
            const message = JSON.parse(e.data);
            if (message.type === 'viewers') window.__roster = message;
          }
        });
      }
      send(data) {
        if (data instanceof ArrayBuffer && new Uint8Array(data)[0] === 66) window.__audioSent++;
        else if (typeof data !== 'string') window.__videoSent++;
        return super.send(data);
      }
    };
    const Audio = AudioContext;
    window.AudioContext = class extends Audio {
      constructor(...args) {
        super(...args);
        window.__playbackContexts.push(this);
        // Observe the actual signal sent to the output, including decoded RTC
        // and scheduled PCM. A parallel silent analyser cannot produce sound.
        const analyser = this.createAnalyser();
        const mute = this.createGain(); mute.gain.value = 0;
        analyser.connect(mute); mute.connect(this.destination);
        const samples = new Float32Array(analyser.fftSize);
        const timer = setInterval(() => {
          if (this.state === 'closed') { clearInterval(timer); return; }
          analyser.getFloatTimeDomainData(samples);
          window.__audioPeak = Math.max(window.__audioPeak, ...samples.map(Math.abs));
        }, 100);
        for (const method of ['createBufferSource', 'createMediaStreamSource']) {
          const original = this[method].bind(this);
          this[method] = (...params) => {
            const source = original(...params);
            if (method === 'createMediaStreamSource') window.__streamSources.push(source);
            const connect = source.connect.bind(source);
            source.connect = (destination, ...rest) => {
              window.__audioOperations.push({ method, op: 'connect', output: destination === this.destination, at: this.currentTime });
              if (destination === this.destination) connect(analyser);
              return connect(destination, ...rest);
            };
            const disconnect = source.disconnect.bind(source);
            source.disconnect = (...args) => { window.__audioOperations.push({ method, op: 'disconnect', at: this.currentTime }); return disconnect(...args); };
            return source;
          };
        }
      }
    };
  }, process.env.BARKODD_BROWSER === 'webkit' && process.env.BARKODD_LOCAL_ICE === '1');
}

async function setup(browser, page, baseURL) {
  await syntheticDevices(page);
  await instrument(page);
  await page.goto('./');
  if (authMode !== 'none') {
    if (authMode === 'multi_user') await page.locator('#admin-login-toggle').click();
    await page.locator('#login-code').fill(process.env.BARKODD_OWNER_KEY || 'test-owner-key-0123456789abcdef0123456789');
    await page.locator('#code-form button').click();
  }
  await page.locator('#choose-host').click();
  await page.locator('#room-name').fill(`Audio ${transport}`);
  await page.locator('#host-form button').click();
  await expect(page.locator('#pairing-qr')).toBeVisible();
  const binding = await page.evaluate(() => JSON.parse(localStorage.getItem('barkodd.account.v2.' + document.querySelector('#account-tools').dataset.userId)).host);
  await page.locator('#capture-button').click();
  await expect(page.locator('#camera-video')).toBeVisible();
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const viewer = await context.newPage();
  await instrument(viewer);
  await viewer.goto(new URL(`?role=viewer#room=${binding.id}&key=${binding.viewerToken}`, baseURL).href);
  await expect(viewer.locator('#audio-button')).toBeVisible();
  return { context, viewer, binding };
}

const expectSound = async viewer => {
  await viewer.evaluate(() => { window.__audioPeak = 0; });
  try {
    await expect(viewer.locator('#audio-status')).toHaveAttribute('data-state', 'live');
    await expect.poll(() => viewer.evaluate(() => window.__audioPeak), { timeout: 20000 }).toBeGreaterThan(0.01);
  } catch (error) {
    await test.info().attach('audio-diagnostics', { contentType: 'application/json', body: JSON.stringify(await viewer.evaluate(async () => ({
      contexts: window.__playbackContexts.map(ctx => ({ state: ctx.state, time: ctx.currentTime })),
      sources: window.__streamSources.map(source => source.mediaStream.getTracks().map(track => ({ kind: track.kind, state: track.readyState, muted: track.muted, enabled: track.enabled }))),
      operations: window.__audioOperations,
      peers: await Promise.all(window.__peers.map(async pc => ({
        connection: pc.connectionState, ice: pc.iceConnectionState,
        stats: [...(await pc.getStats()).values()].filter(item => ['inbound-rtp', 'candidate-pair', 'transport', 'local-candidate', 'remote-candidate'].includes(item.type)),
      }))),
    }))) });
    throw error;
  }
};

test(`${transport}: sound alone, combined channels, switching, reconnect and revocation`, async ({ browser, page, baseURL }) => {
  const { context, viewer, binding } = await setup(browser, page, baseURL);
  const errors = [];
  viewer.on('pageerror', error => errors.push(error.message));
  try {
    await expect(viewer.locator('#audio-button')).toHaveAttribute('aria-pressed', 'false');
    const originalSessionType = await viewer.evaluate(() => navigator.audioSession?.type);
    await viewer.locator('#audio-button').click();
    await expectSound(viewer);
    if (originalSessionType) expect(await viewer.evaluate(() => navigator.audioSession.type)).toBe('playback');
    await expect(viewer.locator(liveSelector)).toBeHidden();
    await expect(viewer.locator('#capture-button')).toHaveAttribute('aria-pressed', 'false');
    await expect.poll(() => page.evaluate(() => window.__roster?.audioCount)).toBe(1);
    expect(await page.evaluate(() => window.__roster.videoCount)).toBe(0);
    expect(await page.evaluate(() => window.__videoSent)).toBe(0);
    if (transport === 'webrtc') {
      expect(await page.evaluate(() => window.__peers.filter(pc => pc.connectionState !== 'closed').flatMap(pc => pc.getSenders()).map(sender => sender.track?.kind))).toEqual(['audio']);
      if (process.env.BARKODD_BROWSER === 'webkit' && process.env.BARKODD_LOCAL_ICE === '1') {
        expect(await viewer.evaluate(() => window.__localICERewrites)).toBeGreaterThan(0);
        expect(await page.evaluate(() => window.__localICERewrites)).toBeGreaterThan(0);
      }
    } else {
      expect(await page.evaluate(() => window.__audioSent)).toBeGreaterThan(0);
    }
    expect(await viewer.evaluate(() => window.__mediaRequests)).toBe(0);
    await expect(page.locator('.event-card img').first()).toBeVisible({ timeout: 30000 });
    expect(await viewer.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await viewer.screenshot({ path: `test-results/audio-only-${transport}-${process.env.BARKODD_BROWSER || 'chromium'}.png`, fullPage: true });

    // A real suspended output must expose a user gesture to resume playback.
    await viewer.evaluate(() => window.__playbackContexts.find(ctx => ctx.state === 'running').suspend());
    await expect(viewer.locator('#audio-retry')).toBeVisible();
    await expect(viewer.locator('#audio-status')).toHaveAttribute('data-state', 'blocked');
    await viewer.locator('#audio-retry').click();
    await expectSound(viewer);

    // Selecting picture must retain sound, then disabling sound retains picture.
    await viewer.locator('#capture-button').click();
    await expect(viewer.locator(liveSelector)).toBeVisible();
    await expectSound(viewer);
    // Audio packets update the status during a normal press. The button must
    // keep its label node stable so WebKit delivers the resulting click.
    await viewer.locator('#audio-button').click({ delay: 200 });
    await expect(viewer.locator('#audio-status')).toHaveAttribute('data-state', 'idle');
    await expect(viewer.locator(liveSelector)).toBeVisible();
    await expect.poll(() => viewer.evaluate(() => window.__playbackContexts.every(ctx => ctx.state === 'closed'))).toBe(true);
    if (originalSessionType) expect(await viewer.evaluate(() => navigator.audioSession.type)).toBe(originalSessionType);

    // Back to audio-only; reconnect keeps the subscription.
    await viewer.locator('#audio-button').click();
    await expectSound(viewer);
    await viewer.locator('#capture-button').click();
    await expectSound(viewer);
    await context.setOffline(true);
    if (process.env.BARKODD_BROWSER === 'webkit') {
      // WebKit's offline emulation leaves established WebSockets and loopback
      // RTP alive. Close the real control connection to exercise disconnection.
      await viewer.evaluate(() => Promise.all(window.__sockets.filter(socket => socket.readyState === WebSocket.OPEN).map(socket => new Promise(resolve => {
        socket.addEventListener('close', resolve, { once: true });
        socket.close();
      }))));
    }
    await expect(viewer.locator('#audio-status')).not.toHaveAttribute('data-state', 'live');
    await context.setOffline(false);
    if (process.env.BARKODD_BROWSER === 'webkit') {
      // WebKit can suspend a quiet output while the network is offline. The
      // supported recovery is an explicit retry when it requires a new gesture.
      await expect(viewer.locator('#audio-status')).toHaveAttribute('data-state', /^(live|blocked)$/);
      if (await viewer.locator('#audio-status').getAttribute('data-state') === 'blocked') {
        expect(await viewer.evaluate(() => window.__playbackContexts.some(ctx => ['suspended', 'interrupted'].includes(ctx.state)))).toBe(true);
        await expect(viewer.locator('#audio-retry')).toBeVisible();
        await viewer.locator('#audio-retry').click();
      }
    }
    await expectSound(viewer);
    await expect(viewer.locator(liveSelector)).toBeHidden();
    await expect.poll(() => page.evaluate(() => window.__roster?.videoCount)).toBe(0);

    page.once('dialog', dialog => dialog.accept());
    await page.locator('#regenerate-key').click();
    await expect.poll(() => viewer.evaluate(() => window.__playbackContexts.every(ctx => ctx.state === 'closed'))).toBe(true);
    if (transport === 'webrtc') await expect.poll(() => page.evaluate(() => window.__peers.every(pc => pc.connectionState === 'closed'))).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await context.close();
    await page.evaluate(() => window.__syntheticAudio?.close());
    await page.request.delete(new URL(`api/rooms/${binding.id}`, baseURL).href);
  }
});
