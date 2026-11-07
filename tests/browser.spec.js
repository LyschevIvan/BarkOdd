import { test, expect } from '@playwright/test';

const authMode = process.env.BARKODD_AUTH_MODE || 'admin_code';
async function loginOwner(page) {
  await page.goto('./');
  if (authMode !== 'none') {
    if (authMode === 'multi_user') await page.locator('#admin-login-toggle').click();
    await page.locator('#login-code').fill(process.env.BARKODD_OWNER_KEY || 'test-owner-key-0123456789abcdef0123456789');
    await page.locator('#code-form button[type=submit]').click();
  }
  await expect(page.locator('#account-panel')).toBeVisible();
}
const savedHost = page => page.evaluate(() => JSON.parse(localStorage.getItem('barkodd.account.v2.' + document.querySelector('#account-tools').dataset.userId)).host);

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
  await loginOwner(page);
  await page.locator('#choose-host').click();
  await page.locator('#room-name').fill(`Дом Бруно · ${transport}`);
  await page.locator('#host-form button[type=submit]').click();
  await expect(page.locator('#pairing-qr')).toBeVisible();
  const binding = await savedHost(page);
  const initialState = await page.request.get(roomURL(baseURL, binding.id), {});
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
  const state = async () => (await page.request.get(roomURL(baseURL, binding.id), {})).json();
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
  page.once('dialog', dialog => dialog.accept());
  await page.locator('#regenerate-key').click();
  if (rtc) await expect.poll(() => page.evaluate(() => window.__oldPeers.every(peer => peer.connectionState === 'closed')), { timeout: 4000 }).toBe(true);
  await expect.poll(() => viewer.evaluate(() => window.__oldSockets.every(socket => socket.readyState === WebSocket.CLOSED)), { timeout: 6000 }).toBe(true);
  await viewer.unroute('**/api/**');
  const renewed = (await savedHost(page)).viewerToken;
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
  await expect(page.locator('#choose-viewer')).toBeVisible();
});

test('protected creation requires a session and never persists the code', async ({ page, baseURL }) => {
  test.skip(authMode === 'none');
  const anonymous = await page.request.post(new URL('api/rooms', baseURL).href, { data: { name: 'Anonymous' }, headers: { Origin: new URL(baseURL).origin } });
  expect([401, 403]).toContain(anonymous.status());
  await page.goto('./');
  if (authMode === 'multi_user') await page.locator('#admin-login-toggle').click();
  await page.locator('#login-code').fill('wrong-owner-key-0123456789abcdef0123456789');
  await page.locator('#code-form button[type=submit]').click();
  await expect(page.locator('#welcome-alert')).toBeVisible();
  await expect(page.locator('#login-code')).toHaveValue('');
  const key = process.env.BARKODD_OWNER_KEY || 'test-owner-key-0123456789abcdef0123456789';
  await page.locator('#login-code').fill(key);
  await page.locator('#code-form button[type=submit]').click();
  await expect(page.locator('#account-panel')).toBeVisible();
  await page.locator('#choose-host').click();
  await page.locator('#room-name').fill('Owner authorization');
  await page.locator('#host-form button[type=submit]').click();
  await expect(page.locator('#dashboard')).toBeVisible();
  expect(await page.evaluate(() => JSON.stringify({ ...localStorage }))).not.toContain(key);
  expect(page.url()).not.toContain(key);
});

test('camera direction can be selected when only the front device is listed', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'This test uses Chromium’s fake camera and microphone.');
  await page.addInitScript(() => {
    const devices = navigator.mediaDevices;
    const getUserMedia = devices.getUserMedia.bind(devices);
    window.__videoRequests = [];
    devices.enumerateDevices = async () => [
      { kind: 'videoinput', deviceId: 'tablet-front', label: window.__videoRequests.length ? 'Tablet front camera' : '' },
      { kind: 'audioinput', deviceId: 'tablet-mic', label: 'Tablet microphone' },
    ];
    devices.getUserMedia = constraints => {
      window.__videoRequests.push(constraints.video);
      // The fake camera has neither the tablet's ID nor a physical orientation.
      const video = { ...constraints.video };
      delete video.deviceId;
      delete video.facingMode;
      return getUserMedia({ ...constraints, video });
    };
  });

  await loginOwner(page);
  await page.locator('#choose-host').click();
  await page.locator('#room-name').fill('Tablet camera selection');
  await page.locator('#host-form button[type=submit]').click();

  const camera = page.locator('#video-device');
  const capture = page.locator('#capture-button');
  const preview = page.locator('#camera-video');
  const frontDevice = camera.locator('option[value="tablet-front"]');
  await expect(frontDevice).toHaveText('Камера 1');
  await expect(camera).toHaveValue('');
  await expect(camera.locator('option[value="facing:user"]')).toHaveText('Фронтальная камера');
  await expect(camera.locator('option[value="facing:environment"]')).toHaveText('Задняя камера');
  await camera.selectOption('facing:user');
  await camera.selectOption('facing:environment');
  expect(await page.evaluate(() => window.__videoRequests)).toEqual([]);

  await capture.click();
  await expect(preview).toBeVisible();
  await expect(frontDevice).toHaveText('Tablet front camera');
  const [rearRequest] = await page.evaluate(() => window.__videoRequests);
  expect(rearRequest.facingMode).toEqual({ exact: 'environment' });
  expect(rearRequest).not.toHaveProperty('deviceId');
  await expect(camera).toHaveValue('facing:environment');
  await preview.evaluate(video => { window.__rearCaptureTracks = video.srcObject.getTracks(); });

  await capture.click();
  await expect(camera).toBeEnabled();
  await expect(camera).toHaveValue('facing:environment');
  expect(await page.evaluate(() => window.__rearCaptureTracks.every(track => track.readyState === 'ended'))).toBe(true);

  await camera.selectOption('tablet-front');
  await capture.click();
  await expect(preview).toBeVisible();
  const [, frontRequest] = await page.evaluate(() => window.__videoRequests);
  expect(frontRequest.deviceId).toEqual({ exact: 'tablet-front' });
  expect(frontRequest).not.toHaveProperty('facingMode');
  await capture.click();
});

test('replacing the source stops the previous camera and keeps its room binding', async ({ page, context }) => {
  await instrument(page);
  await loginOwner(page);
  await page.locator('#choose-host').click();
  await page.locator('#room-name').fill('Replacement privacy');
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
  expect((await savedHost(page)).account).toBe(true);
  await replacement.locator('#capture-button').click();
  await replacement.close();
});

test('room deletion needs confirmation and removes its binding', async ({ page, baseURL }) => {
  await loginOwner(page);
  await page.locator('#choose-host').click();
  await page.locator('#room-name').fill('Deletion test');
  await page.locator('#host-form button[type=submit]').click();
  await expect(page.locator('#delete-room')).toBeVisible();
  const binding = await savedHost(page);
  page.once('dialog', dialog => dialog.dismiss());
  await page.locator('#delete-room').click();
  expect((await page.request.get(roomURL(baseURL, binding.id), {})).status()).toBe(200);
  page.once('dialog', dialog => dialog.accept());
  await page.locator('#delete-room').click();
  await expect(page.locator('#welcome')).toBeVisible();
  expect((await page.request.get(roomURL(baseURL, binding.id), {})).status()).toBe(404);
  expect(await savedHost(page)).toBeNull();
});
