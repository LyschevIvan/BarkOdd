import { test, expect } from '@playwright/test';

const transport = process.env.BARKODD_TRANSPORT || 'websocket';
const rtc = transport === 'webrtc';
const liveSelector = rtc ? '#remote-video' : '#live-frame';

async function instrument(page) {
  await page.addInitScript(mode => {
    window.__peers = [];
    if (mode === 'websocket') {
      // JPEG must work even when WebRTC is absent.
      window.RTCPeerConnection = undefined;
      window.webkitRTCPeerConnection = undefined;
    } else {
      const NativePeer = window.RTCPeerConnection;
      window.RTCPeerConnection = class extends NativePeer {
        constructor(...args) { super(...args); window.__peers.push(this); }
      };
    }
    window.__sentFrames = 0;
    window.__viewerCount = null;
    window.__sockets = [];
    const NativeSocket = window.WebSocket;
    window.WebSocket = class extends NativeSocket {
      constructor(...args) {
        super(...args);
        window.__sockets.push(this);
        this.addEventListener('message', event => {
          if (typeof event.data === 'string') {
            try { const message = JSON.parse(event.data); if (message.type === 'viewers') window.__viewerCount = message.count; } catch (_) {}
          }
        });
      }
      send(data) { if (typeof data !== 'string') window.__sentFrames++; return super.send(data); }
    };
    window.__audioContexts = [];
    const NativeAudio = window.AudioContext;
    window.AudioContext = class extends NativeAudio {
      constructor(...args) { super(...args); window.__audioContexts.push(this); }
    };
  }, transport);
}

async function expectFrame(page) {
  await expect(page.locator(liveSelector)).toBeVisible();
  await expect.poll(() => page.locator(liveSelector).evaluate(el => el.tagName === 'VIDEO' ? el.readyState >= 2 && el.videoWidth > 0 : el.complete && el.naturalWidth > 0)).toBe(true);
}

const roomURL = (base, id, route = '') => new URL(`api/rooms/${id}${route}`, base).href;

const frameProgress = page => rtc ? page.locator(liveSelector).evaluate(video => video.getVideoPlaybackQuality().totalVideoFrames) : page.locator(liveSelector).getAttribute('src');

test(`${transport}: on-demand video, photos, pause, reconnect and revocation`, async ({ browser, page, baseURL }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await instrument(page);
  await page.goto('./');
  await page.locator('#choose-host').click();
  await page.locator('#room-name').fill(`Дом Бруно · ${transport}`);
  await page.locator('#creation-key').fill(process.env.BARKODD_OWNER_KEY || 'test-owner-key-0123456789abcdef0123456789');
  await page.locator('#host-form button[type=submit]').click();
  await expect(page.locator('#pairing-qr')).toBeVisible();
  const binding = await page.evaluate(() => JSON.parse(localStorage.getItem('barkodd.binding.v1')).host);
  const initialState = await page.request.get(roomURL(baseURL, binding.id), { headers: { Authorization: `Bearer ${binding.hostToken}` } });
  expect((await initialState.json()).mediaTransport).toBe(transport);
  const viewerURL = new URL(`?role=viewer#room=${encodeURIComponent(binding.id)}&key=${encodeURIComponent(binding.viewerToken)}`, baseURL).href;
  await page.locator('#capture-button').click();
  await expect.poll(() => page.locator('#camera-video').evaluate(video => video.readyState)).toBeGreaterThanOrEqual(2);
  await expect(page.locator('.event-card').first()).toBeVisible({ timeout: 30000 });
  await expect.poll(() => page.evaluate(() => window.__viewerCount)).toBe(0);
  expect(await page.evaluate(() => window.__sentFrames)).toBe(0);

  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const viewer = await context.newPage();
  viewer.on('pageerror', error => errors.push(error.message));
  await instrument(viewer);
  await viewer.goto(viewerURL);
  await expect(viewer.locator('#dashboard')).toBeVisible();
  await expect(viewer.locator('#host-settings')).toBeHidden();
  await expect(viewer.locator('#mute-button')).toHaveCount(0);
  await viewer.locator('#capture-button').click();
  await expectFrame(viewer);
  const first = await frameProgress(viewer);
  await expect.poll(() => frameProgress(viewer)).not.toBe(first);
  if (rtc) {
    expect(await page.evaluate(() => window.__sentFrames)).toBe(0);
    expect(await page.evaluate(() => window.__peers.flatMap(peer => peer.getSenders()).some(sender => sender.track?.kind === 'audio'))).toBe(false);
    await expect(viewer.locator('#stream-note')).toContainText('WebRTC');
  } else {
    expect(await viewer.evaluate(() => typeof RTCPeerConnection)).toBe('undefined');
    expect(await page.evaluate(() => window.__sentFrames)).toBeGreaterThan(0);
  }
  await expect.poll(() => viewer.locator('.event-card img').first().evaluate(img => img.complete && img.naturalWidth > 0)).toBe(true);
  await page.screenshot({ path: `test-results/host-${transport}.png`, fullPage: true });
  await viewer.screenshot({ path: `test-results/viewer-${transport}.png`, fullPage: true });
  expect(await viewer.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

  // Viewer off stops live upload while microphone, photo capture and source remain active.
  await viewer.locator('#capture-button').click();
  await expect(viewer.locator(liveSelector)).toBeHidden();
  await expect.poll(() => page.evaluate(() => window.__viewerCount)).toBe(0);
  if (rtc) await expect.poll(() => page.evaluate(() => window.__peers.every(peer => peer.connectionState === 'closed'))).toBe(true);
  const sent = await page.evaluate(() => window.__sentFrames);
  await page.waitForResponse(response => response.request().method() === 'GET' && response.url() === roomURL(baseURL, binding.id));
  expect(await page.evaluate(() => window.__sentFrames)).toBe(sent);
  expect(await page.locator('#camera-video').evaluate(video => video.srcObject.getTracks().every(track => track.readyState === 'live'))).toBe(true);
  await viewer.locator('#capture-button').click();
  await expectFrame(viewer);

  // Browser microphone suspension can recover in the same room and session.
  const state = async () => (await page.request.get(roomURL(baseURL, binding.id), { headers: { Authorization: `Bearer ${binding.hostToken}` } })).json();
  await page.evaluate(() => window.__audioContexts.at(-1).suspend());
  await expect.poll(async () => (await state()).monitoring).toBe(false);
  await expect(viewer.locator(liveSelector)).toBeHidden();
  await page.evaluate(() => window.__audioContexts.at(-1).resume());
  await expect.poll(async () => (await state()).monitoring).toBe(true);
  await expectFrame(viewer);

  // Network loss must not leave a frozen frame labelled live.
  await context.setOffline(true);
  await expect(viewer.locator(liveSelector)).toBeHidden();
  await context.setOffline(false);
  await expectFrame(viewer);

  // Source restart reconnects the viewer without changing the pairing URL.
  await page.locator('#capture-button').click();
  await expect(viewer.locator(liveSelector)).toBeHidden();
  await page.locator('#capture-button').click();
  await expectFrame(viewer);

  // Even a client that refuses further HTTP requests loses the old socket.
  await viewer.evaluate(() => { window.__oldSockets = window.__sockets.filter(socket => socket.readyState === WebSocket.OPEN); });
  await viewer.route('**/api/**', route => route.abort());
  if (rtc) {
    // A revoked viewer may ignore all control callbacks. The source must stop P2P.
    await viewer.evaluate(() => { for (const socket of window.__oldSockets) { socket.onmessage = null; socket.onclose = null; } });
    const peers = await page.evaluate(() => { window.__oldPeers = window.__peers.filter(peer => peer.connectionState === 'connected'); return window.__oldPeers.length; });
    expect(peers).toBeGreaterThan(0);
  }
  await page.locator('#regenerate-key').click();
  if (rtc) await expect.poll(() => page.evaluate(() => window.__oldPeers.every(peer => peer.connectionState === 'closed')), { timeout: 4000 }).toBe(true);
  await expect.poll(() => viewer.evaluate(() => window.__oldSockets.every(socket => socket.readyState === WebSocket.CLOSED)), { timeout: 6000 }).toBe(true);
  await viewer.unroute('**/api/**');
  const renewed = await page.evaluate(() => JSON.parse(localStorage.getItem('barkodd.binding.v1')).host.viewerToken);
  expect(renewed).not.toBe(binding.viewerToken);
  await viewer.goto(new URL(`?role=viewer#room=${binding.id}&key=${renewed}`, baseURL).href);
  await viewer.locator('#capture-button').click();
  await expectFrame(viewer);

  // One failed photo response retries even with stopped source and unchanged history.
  await page.locator('#capture-button').click();
  let aborted = false;
  await viewer.route('**/events/*/photo', route => { if (!aborted) { aborted = true; return route.abort(); } return route.continue(); });
  await viewer.reload();
  await expect.poll(() => viewer.locator('#latest-photo').evaluate(img => img.complete && img.naturalWidth > 0)).toBe(true);
  expect(aborted).toBe(true);
  await context.close();
  expect(errors).toEqual([]);
});

test('invalid pairing has a recovery screen', async ({ page }) => {
  await instrument(page);
  await page.goto('./?role=viewer#room=missing&key=invalid');
  await expect(page.locator('#welcome-alert')).toBeVisible();
  await expect(page.locator('#choose-host')).toBeVisible();
});

test('creation requires the owner key and never persists it in browser bindings', async ({ page, baseURL }) => {
  const anonymous = await page.request.post(new URL('api/rooms', baseURL).href, { data: { name: 'Anonymous' } });
  expect(anonymous.status()).toBe(403);
  await page.goto('./');
  await page.locator('#choose-host').click();
  await page.locator('#room-name').fill('Owner authorization');
  await page.locator('#creation-key').fill('wrong-owner-key-0123456789abcdef0123456789');
  await page.locator('#host-form button[type=submit]').click();
  await expect(page.locator('#welcome-alert')).toContainText('ключ');
  await expect(page.locator('#creation-key')).toHaveValue('');
  const key = process.env.BARKODD_OWNER_KEY || 'test-owner-key-0123456789abcdef0123456789';
  await page.locator('#creation-key').fill(key);
  await page.locator('#host-form button[type=submit]').click();
  await expect(page.locator('#dashboard')).toBeVisible();
  await expect(page.locator('#creation-key')).toHaveValue('');
  expect(await page.evaluate(() => JSON.stringify({ ...localStorage }))).not.toContain(key);
  expect(page.url()).not.toContain(key);
});

test('replacing the source stops the previous camera and keeps its room binding', async ({ page, context }) => {
  await instrument(page);
  await page.goto('./');
  await page.locator('#choose-host').click();
  await page.locator('#room-name').fill('Replacement privacy');
  await page.locator('#creation-key').fill(process.env.BARKODD_OWNER_KEY || 'test-owner-key-0123456789abcdef0123456789');
  await page.locator('#host-form button[type=submit]').click();
  await expect(page.locator('#dashboard')).toBeVisible();
  await page.locator('#capture-button').click();
  await expect.poll(() => page.locator('#camera-video').evaluate(v => !!v.srcObject)).toBe(true);
  await page.evaluate(() => { window.__oldCaptureTracks = document.querySelector('#camera-video').srcObject.getTracks(); });
  const replacement = await context.newPage();
  await instrument(replacement);
  await replacement.goto('./');
  await expect(replacement.locator('#dashboard')).toBeVisible();
  await replacement.locator('#capture-button').click();
  await expect.poll(() => replacement.locator('#camera-video').evaluate(v => !!v.srcObject)).toBe(true);
  await expect.poll(() => page.evaluate(() => window.__oldCaptureTracks.every(t => t.readyState === 'ended'))).toBe(true);
  expect(await page.evaluate(() => !!JSON.parse(localStorage.getItem('barkodd.binding.v1')).host?.hostToken)).toBe(true);
  await replacement.locator('#capture-button').click();
  await replacement.close();
});

test('room deletion needs confirmation and removes its binding', async ({ page, baseURL }) => {
  await page.goto('./');
  await page.locator('#choose-host').click();
  await page.locator('#room-name').fill('Deletion test');
  await page.locator('#creation-key').fill(process.env.BARKODD_OWNER_KEY || 'test-owner-key-0123456789abcdef0123456789');
  await page.locator('#host-form button[type=submit]').click();
  await expect(page.locator('#delete-room')).toBeVisible();
  const binding = await page.evaluate(() => JSON.parse(localStorage.getItem('barkodd.binding.v1')).host);
  page.once('dialog', dialog => dialog.dismiss());
  await page.locator('#delete-room').click();
  expect((await page.request.get(roomURL(baseURL, binding.id), { headers: { Authorization: `Bearer ${binding.hostToken}` } })).status()).toBe(200);
  page.once('dialog', dialog => dialog.accept());
  await page.locator('#delete-room').click();
  await expect(page.locator('#welcome')).toBeVisible();
  expect((await page.request.get(roomURL(baseURL, binding.id), { headers: { Authorization: `Bearer ${binding.hostToken}` } })).status()).toBe(404);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('barkodd.binding.v1')).host)).toBeNull();
});
