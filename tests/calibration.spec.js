import { test, expect } from '@playwright/test';

const roomURLs = new WeakMap();

async function syntheticMicrophone(page, amplitude = 0.0014, options = {}) {
  await page.addInitScript(({ level, options }) => {
    const NativeAudio = window.AudioContext;
    window.__syntheticMicrophoneRequests = 0;
    window.__syntheticMicrophoneConstraints = [];
    window.__syntheticMicrophoneSources = [];
    window.__syntheticMicrophonePermission = options.permission || 'granted';
    // Supply a real Web Audio graph and canvas track; never open real devices.
    navigator.mediaDevices.getUserMedia = async constraints => {
      window.__syntheticMicrophoneRequests++;
      window.__syntheticMicrophoneConstraints.push(constraints);
      if (options.rejectVideo && constraints.video) throw new DOMException('Camera access denied', 'NotAllowedError');
      if (window.__syntheticMicrophonePermission === 'denied') throw new DOMException('Microphone access denied', 'NotAllowedError');
      if (window.__syntheticMicrophonePermission === 'pending') {
        await new Promise(resolve => { window.__releaseMicrophonePermission = resolve; });
      }
      const audio = new NativeAudio();
      const oscillator = audio.createOscillator();
      const gain = audio.createGain();
      const destination = audio.createMediaStreamDestination();
      gain.gain.value = level;
      oscillator.connect(gain);
      gain.connect(destination);
      oscillator.start();
      await audio.resume();
      const stream = new MediaStream(destination.stream.getAudioTracks());
      if (constraints.video) {
        const canvas = document.createElement('canvas');
        canvas.width = 320;
        canvas.height = 240;
        const draw = () => {
          const context = canvas.getContext('2d');
          context.fillStyle = '#468';
          context.fillRect(0, 0, 320, 240);
          requestAnimationFrame(draw);
        };
        draw();
        stream.addTrack(canvas.captureStream(10).getVideoTracks()[0]);
      }
      window.__syntheticMicrophone = { audio, stream, gain };
      window.__syntheticMicrophoneSources.push(window.__syntheticMicrophone);
      return stream;
    };
  }, { level: amplitude, options });
}

async function createHost(page, baseURL, name) {
  await page.goto('./');
  const mode = process.env.BARKODD_AUTH_MODE || 'admin_code';
  if (mode !== 'none') {
    if (mode === 'multi_user') await page.locator('#admin-login-toggle').click();
    await page.locator('#login-code').fill(process.env.BARKODD_OWNER_KEY || 'test-owner-key-0123456789abcdef0123456789');
    await page.locator('#code-form button[type=submit]').click();
  }
  await expect(page.locator('#account-panel')).toBeVisible();
  await page.locator('#choose-host').click();
  await page.locator('#room-name').fill(name);
  await page.locator('#host-form button[type=submit]').click();
  await expect(page.locator('#dashboard')).toBeVisible();
  const binding = await page.evaluate(() => JSON.parse(localStorage.getItem('barkodd.account.v2.' + document.querySelector('#account-tools').dataset.userId)).host);
  const url = new URL(`api/rooms/${binding.id}`, baseURL).href;
  roomURLs.set(page, url);
  return {
    url,
    state: async () => {
      const response = await page.request.get(url);
      expect(response.ok()).toBe(true);
      return response.json();
    },
  };
}

async function saveSettings(page, url) {
  const response = page.waitForResponse(response => response.request().method() === 'PUT' && response.url() === `${url}/settings`);
  await page.locator('#save-settings').click();
  expect((await response).ok()).toBe(true);
  await expect(page.locator('#save-settings')).toBeEnabled();
  await expect(page.locator('#settings-feedback')).toContainText(/сохранены/i);
}

async function adjustThreshold(page, value) {
  await page.locator('#threshold-adjustment').fill(String(value));
  await page.locator('#threshold-adjustment').dispatchEvent('input');
}

async function markerPosition(page, selector) {
  return page.locator(selector).evaluate(element => parseFloat(element.style.left));
}

async function audioTime(page) {
  return page.evaluate(() => window.__syntheticMicrophone.audio.currentTime);
}

async function startCalibration(page) {
  await expect(page.locator('#calibrate-noise')).toBeEnabled();
  const startedAt = await audioTime(page);
  await page.locator('#calibrate-noise').click();
  await expect(page.locator('#cancel-calibration')).toBeVisible();
  await expect(page.locator('#calibration-progress')).toBeVisible();
  await expect.poll(() => page.locator('#calibration-progress').evaluate(element => element.value)).toBeGreaterThan(0);
  return startedAt;
}

test.afterEach(async ({ page }) => {
  await page.evaluate(async () => {
    for (const source of window.__syntheticMicrophoneSources || []) {
      source.stream.getTracks().forEach(track => track.stop());
      if (source.audio.state !== 'closed') await source.audio.close();
    }
  }).catch(() => {});
  const url = roomURLs.get(page);
  if (url) await page.request.delete(url, { headers: { Origin: new URL(url).origin } });
});

test('standalone calibration uses only the microphone and preserves existing history before saving', async ({ page, baseURL }) => {
  await syntheticMicrophone(page, 0.0014, { rejectVideo: true });
  const { url, state } = await createHost(page, baseURL, 'Microphone-only calibration');
  const headers = { Origin: new URL(baseURL).origin };
  const sessionId = 'prior-observation';
  // Seed real server history, then stop that source. Calibration must leave it intact.
  expect((await page.request.post(`${url}/heartbeat`, { headers, data: { sessionId, monitoring: true } })).ok()).toBe(true);
  expect((await page.request.post(`${url}/events`, { headers, data: { sessionId, episodeId: 'existing-noise', level: 0.2 } })).ok()).toBe(true);
  expect((await page.request.post(`${url}/heartbeat`, { headers, data: { sessionId, monitoring: false, stopped: true } })).ok()).toBe(true);
  const before = await state();
  expect(before.events).toHaveLength(1);
  const mutations = [];
  page.on('request', request => {
    if (request.url().startsWith(url) && request.method() !== 'GET') mutations.push(`${request.method()} ${request.url()}`);
  });

  await expect(page.locator('#calibrate-noise')).toBeEnabled({ timeout: 3000 });
  const calibrationStartedAt = await page.evaluate(() => performance.now());
  await page.locator('#calibrate-noise').click();
  await expect(page.locator('#cancel-calibration')).toBeVisible();
  await expect.poll(() => page.locator('#calibration-progress').evaluate(element => element.value)).toBeGreaterThan(0);
  await expect.poll(async () => parseFloat((await page.locator('#sound-level-value').textContent()).replace(',', '.'))).toBeGreaterThan(0);
  for (const control of ['capture-button', 'video-device', 'audio-device', 'save-settings']) {
    await expect(page.locator(`#${control}`)).toBeDisabled();
  }
  await expect(page.locator('#capture-button')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('#camera-video')).toBeHidden();
  expect(await page.locator('#camera-video').evaluate(element => element.srcObject === null)).toBe(true);
  const constraints = await page.evaluate(() => window.__syntheticMicrophoneConstraints);
  expect(constraints).toHaveLength(1);
  expect(constraints[0].video).toBe(false);
  expect(constraints[0].audio).toBeTruthy();
  expect(await page.evaluate(() => window.__syntheticMicrophone.stream.getVideoTracks().length)).toBe(0);

  await expect(page.locator('#sensitivity')).toHaveValue('custom', { timeout: 9000 });
  // The separately created synthetic source has its own audio clock, which can
  // lag wall time during initialization. Calibration uses the monotonic clock.
  expect(await page.evaluate(() => performance.now()) - calibrationStartedAt).toBeGreaterThanOrEqual(5000);
  await expect(page.locator('#cancel-calibration')).toBeHidden();
  await expect(page.locator('#calibrate-noise')).toBeEnabled();
  await expect.poll(() => page.evaluate(() => window.__syntheticMicrophone.stream.getTracks().every(track => track.readyState === 'ended'))).toBe(true);
  await expect(page.locator('#sound-draft-marker')).toBeVisible();
  const after = await state();
  for (const key of ['events', 'eventCount', 'historyVersion', 'lastNoiseAt', 'lastSeenAt', 'sessionId', 'monitoring', 'settings']) {
    expect(after[key], key).toEqual(before[key]);
  }
  expect(after.monitoring).toBe(false);
  expect(mutations).toEqual([]);
  await saveSettings(page, url);
  const exactThreshold = (await state()).settings.threshold;
  expect(exactThreshold).toBeGreaterThan(0.0018);
  expect(exactThreshold).toBeLessThan(0.0022);
  await page.reload();
  await expect(page.locator('#dashboard')).toBeVisible();
  await expect(page.locator('#sensitivity')).toHaveValue('custom');
  expect((await state()).settings.threshold).toBe(exactThreshold);
  expect((await state()).events).toEqual(before.events);
});

test('standalone cancellation releases a late permission stream without replacing the draft', async ({ page, baseURL }) => {
  await syntheticMicrophone(page, 0.0014, { rejectVideo: true, permission: 'pending' });
  const { state } = await createHost(page, baseURL, 'Cancelled microphone permission');
  await adjustThreshold(page, 40);
  const draft = await page.locator('#threshold-value').textContent();
  await expect(page.locator('#calibrate-noise')).toBeEnabled({ timeout: 3000 });
  await page.locator('#calibrate-noise').click();
  await expect.poll(() => page.evaluate(() => window.__syntheticMicrophoneRequests)).toBe(1);
  await expect(page.locator('#cancel-calibration')).toBeVisible();
  for (const control of ['capture-button', 'video-device', 'audio-device', 'save-settings']) {
    await expect(page.locator(`#${control}`)).toBeDisabled();
  }
  await page.locator('#cancel-calibration').click();
  await expect(page.locator('#cancel-calibration')).toBeHidden();
  await expect(page.locator('#calibrate-noise')).toBeEnabled();
  await expect(page.locator('#capture-button')).toBeEnabled();
  await page.evaluate(() => { window.__releaseMicrophonePermission(); });
  await expect.poll(() => page.evaluate(() => window.__syntheticMicrophoneSources.length)).toBe(1);
  await expect.poll(() => page.evaluate(() => window.__syntheticMicrophone.stream.getTracks().every(track => track.readyState === 'ended'))).toBe(true);
  await expect(page.locator('#threshold-adjustment')).toHaveValue('40');
  await expect(page.locator('#threshold-value')).toHaveText(draft);
  await expect(page.locator('#calibration-feedback')).toContainText(/отмен/i);
  expect(await page.locator('#camera-video').evaluate(element => element.srcObject === null)).toBe(true);
  expect((await state()).settings.threshold).toBe(0.01);
  expect((await state()).monitoring).toBe(false);
});

test('standalone microphone denial preserves the draft and permits retry', async ({ page, baseURL }) => {
  await syntheticMicrophone(page, 0.0014, { rejectVideo: true, permission: 'denied' });
  const { state } = await createHost(page, baseURL, 'Retry microphone permission');
  await adjustThreshold(page, 40);
  const draft = await page.locator('#threshold-value').textContent();
  await expect(page.locator('#calibrate-noise')).toBeEnabled({ timeout: 3000 });
  await page.locator('#calibrate-noise').click();
  await expect(page.locator('#calibration-feedback')).toContainText(/микрофон/i);
  await expect(page.locator('#calibration-feedback')).toContainText(/доступ|разреш/i);
  await expect(page.locator('#calibrate-noise')).toBeEnabled();
  await expect(page.locator('#cancel-calibration')).toBeHidden();
  await expect(page.locator('#threshold-adjustment')).toHaveValue('40');
  await expect(page.locator('#threshold-value')).toHaveText(draft);
  expect((await state()).settings.threshold).toBe(0.01);
  await page.evaluate(() => { window.__syntheticMicrophonePermission = 'granted'; });
  await page.locator('#calibrate-noise').click();
  await expect.poll(() => page.locator('#calibration-progress').evaluate(element => element.value)).toBeGreaterThan(0);
  await expect.poll(async () => parseFloat((await page.locator('#sound-level-value').textContent()).replace(',', '.'))).toBeGreaterThan(0);
  await page.locator('#cancel-calibration').click();
  await expect(page.locator('#calibrate-noise')).toBeEnabled();
  await expect.poll(() => page.evaluate(() => window.__syntheticMicrophone.stream.getTracks().every(track => track.readyState === 'ended'))).toBe(true);
  await expect(page.locator('#threshold-value')).toHaveText(draft);
  expect(await page.evaluate(() => window.__syntheticMicrophoneRequests)).toBe(2);
  expect((await state()).monitoring).toBe(false);
});

test('calibration suppresses new events and saves a threshold that rejects background but detects louder sound', async ({ page, baseURL }) => {
  await syntheticMicrophone(page);
  const { url, state } = await createHost(page, baseURL, 'Calibrated background');
  await expect(page.locator('#calibrate-noise')).toBeEnabled();
  await expect(page.locator('#calibration-feedback')).toHaveAttribute('role', 'status');
  await page.locator('#sensitivity').selectOption('0.0005');
  await page.locator('#snapshot-interval').selectOption('10000');
  await saveSettings(page, url);
  await page.locator('#capture-button').click();
  await expect.poll(async () => (await state()).events.filter(event => event.hasPhoto).length).toBe(1);
  await page.evaluate(() => { window.__originalCaptureStream = window.__syntheticMicrophone.stream; });
  const startedAt = await startCalibration(page);
  const samplingStartedAt = await page.evaluate(() => Date.now());
  const during = await state();
  await expect.poll(() => audioTime(page)).toBeGreaterThan(startedAt + 3.5);
  await expect(page.locator('#cancel-calibration')).toBeVisible();
  const stillSampling = await state();
  expect(stillSampling.events.map(event => event.id)).toEqual(during.events.map(event => event.id));
  // A previously captured event can finish uploading during calibration.
  // Its detection time must precede the measurement, even if API state changes.
  expect(Date.parse(stillSampling.lastNoiseAt)).toBeLessThanOrEqual(samplingStartedAt);
  await expect(page.locator('#sensitivity')).toHaveValue('custom', { timeout: 9000 });
  expect(await audioTime(page)).toBeGreaterThan(startedAt + 4.8);
  await expect(page.locator('#cancel-calibration')).toBeHidden();
  await expect(page.locator('#calibration-progress')).toBeHidden();
  const calibrated = await state();
  expect(calibrated.settings.threshold).toBe(0.0005);
  await expect(page.locator('#threshold-hint')).toContainText(/сохраните|несохран/i);
  await expect(page.locator('#sound-draft-marker')).toBeVisible();
  expect(await markerPosition(page, '#sound-threshold-marker')).toBeCloseTo(17.47425, 2);
  expect(await markerPosition(page, '#sound-draft-marker')).toBeGreaterThan(30);
  expect(await markerPosition(page, '#sound-draft-marker')).toBeLessThan(35);
  expect(await page.evaluate(() => ({
    requests: window.__syntheticMicrophoneRequests,
    sameStream: window.__syntheticMicrophone.stream === window.__originalCaptureStream,
    live: window.__syntheticMicrophone.stream.getTracks().every(track => track.readyState === 'live'),
  }))).toEqual({ requests: 1, sameStream: true, live: true });

  await saveSettings(page, url);
  const threshold = (await state()).settings.threshold;
  expect(threshold).toBeGreaterThan(0.0018);
  expect(threshold).toBeLessThan(0.0022);
  await expect(page.locator('#sound-draft-marker')).toBeHidden();
  const settledAt = await audioTime(page);
  await expect.poll(() => audioTime(page)).toBeGreaterThan(settledAt + 1);
  const quietAt = await audioTime(page);
  const before = await state();
  await expect.poll(() => audioTime(page)).toBeGreaterThan(quietAt + 2);
  expect((await state()).events.map(event => event.id)).toEqual(before.events.map(event => event.id));
  expect((await state()).lastNoiseAt).toBe(before.lastNoiseAt);
  await page.evaluate(() => { window.__syntheticMicrophone.gain.gain.value = 0.014; });
  await expect.poll(async () => (await state()).lastNoiseAt, { timeout: 5000 }).not.toBe(before.lastNoiseAt);
});

test('manual custom threshold survives reload and interval-only saves on desktop and mobile', async ({ page, baseURL }) => {
  const { url, state } = await createHost(page, baseURL, 'Exact custom threshold');
  const adjustment = page.locator('#threshold-adjustment');
  await expect(adjustment).toHaveAttribute('type', 'range');
  await expect(adjustment).toHaveAttribute('min', '0');
  await expect(adjustment).toHaveAttribute('max', '100');
  await expect(adjustment).toHaveAttribute('step', '0.1');
  await adjustThreshold(page, 40);
  await expect(page.locator('#sensitivity')).toHaveValue('custom');
  await expect(page.locator('#sensitivity option')).toHaveCount(6);
  await expect(page.locator('#sensitivity option[value=custom]')).toHaveText('Свой порог');
  await expect(page.locator('#threshold-hint')).toContainText(/сохраните|несохран/i);
  expect(await markerPosition(page, '#sound-threshold-marker')).toBeCloseTo(50, 2);
  expect(await markerPosition(page, '#sound-draft-marker')).toBeCloseTo(47.47425, 2);
  const displayed = parseFloat((await page.locator('#threshold-value').textContent()).replace(',', '.'));
  expect(displayed).toBeGreaterThan(0.79);
  expect(displayed).toBeLessThan(0.80);
  expect((await state()).settings.threshold).toBe(0.01);
  await page.locator('#host-settings').screenshot({ path: 'test-results/calibration-desktop.png' });
  await page.setViewportSize({ width: 375, height: 812 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.locator('#host-settings').screenshot({ path: 'test-results/calibration-mobile.png' });

  await saveSettings(page, url);
  const exactThreshold = (await state()).settings.threshold;
  // At 40% of the three-decade range: 0.0005 × 10^1.2.
  expect(exactThreshold).toBeCloseTo(0.007924465962305567, 14);
  await expect(page.locator('#sound-draft-marker')).toBeHidden();
  expect(await markerPosition(page, '#sound-threshold-marker')).toBeCloseTo(47.47425, 2);
  await page.reload();
  await expect(page.locator('#dashboard')).toBeVisible();
  await expect(page.locator('#sensitivity')).toHaveValue('custom');
  await expect(adjustment).toHaveValue('40');
  expect((await state()).settings.threshold).toBe(exactThreshold);
  await page.locator('#snapshot-interval').selectOption('60000');
  await saveSettings(page, url);
  expect((await state()).settings).toMatchObject({ threshold: exactThreshold, snapshotIntervalMs: 60000 });
  await page.reload();
  await expect(page.locator('#sensitivity')).toHaveValue('custom');
  await expect(page.locator('#snapshot-interval')).toHaveValue('60000');
  expect((await state()).settings.threshold).toBe(exactThreshold);
});

test('cancelling calibration or stopping capture preserves an existing unsaved threshold', async ({ page, baseURL }) => {
  await syntheticMicrophone(page);
  const { state } = await createHost(page, baseURL, 'Cancel calibration draft');
  await adjustThreshold(page, 40);
  const draft = await page.locator('#threshold-value').textContent();
  await page.locator('#capture-button').click();
  await startCalibration(page);
  await page.locator('#cancel-calibration').click();
  await expect(page.locator('#cancel-calibration')).toBeHidden();
  await expect(page.locator('#calibration-feedback')).toContainText(/отмен/i);
  await expect(page.locator('#threshold-adjustment')).toHaveValue('40');
  await expect(page.locator('#threshold-value')).toHaveText(draft);
  await expect(page.locator('#sound-draft-marker')).toBeVisible();
  expect((await state()).settings.threshold).toBe(0.01);
  await startCalibration(page);
  await page.locator('#capture-button').click();
  await expect(page.locator('#calibrate-noise')).toBeEnabled();
  await expect(page.locator('#cancel-calibration')).toBeHidden();
  await expect(page.locator('#calibration-progress')).toBeHidden();
  await expect(page.locator('#threshold-adjustment')).toHaveValue('40');
  await expect(page.locator('#threshold-value')).toHaveText(draft);
  expect(await markerPosition(page, '#sound-threshold-marker')).toBeCloseTo(50, 2);
  expect((await state()).settings.threshold).toBe(0.01);
});

test('disabled microphone and digital silence cannot replace an existing calibration draft', async ({ page, baseURL }) => {
  await syntheticMicrophone(page);
  const { state } = await createHost(page, baseURL, 'Invalid calibration input');
  await adjustThreshold(page, 40);
  const draft = await page.locator('#threshold-value').textContent();
  await page.locator('#capture-button').click();
  await startCalibration(page);
  await page.evaluate(() => { window.__syntheticMicrophone.stream.getAudioTracks()[0].enabled = false; });
  await expect.poll(async () => (await state()).monitoring).toBe(false);
  await expect(page.locator('#cancel-calibration')).toBeHidden();
  await expect(page.locator('#calibrate-noise')).toBeDisabled();
  await expect(page.locator('#calibration-feedback')).toContainText(/микрофон|прерван|отмен/i);
  await expect(page.locator('#threshold-adjustment')).toHaveValue('40');
  await expect(page.locator('#threshold-value')).toHaveText(draft);
  expect((await state()).settings.threshold).toBe(0.01);

  await page.evaluate(() => {
    window.__syntheticMicrophone.gain.gain.value = 0;
    window.__syntheticMicrophone.stream.getAudioTracks()[0].enabled = true;
  });
  await expect.poll(async () => (await state()).monitoring).toBe(true);
  await expect(page.locator('#sound-level-value')).toHaveText('0%');
  await startCalibration(page);
  await expect(page.locator('#cancel-calibration')).toBeHidden({ timeout: 9000 });
  await expect(page.locator('#calibration-feedback')).toContainText(/тиш|сигнал|не удалось|нул/i);
  await expect(page.locator('#threshold-adjustment')).toHaveValue('40');
  await expect(page.locator('#threshold-value')).toHaveText(draft);
  await expect(page.locator('#sound-draft-marker')).toBeVisible();
  expect((await state()).settings.threshold).toBe(0.01);
});

test('local microphone recovery allows calibration while heartbeat fails', async ({ page, baseURL }) => {
  await syntheticMicrophone(page);
  const { url, state } = await createHost(page, baseURL, 'Local microphone recovery');
  await page.locator('#capture-button').click();
  await expect.poll(async () => (await state()).monitoring).toBe(true);
  await expect(page.locator('#calibrate-noise')).toBeEnabled();
  await page.route(`${url}/heartbeat`, route => route.fulfill({
    status: 503,
    contentType: 'application/json',
    body: JSON.stringify({ error: 'Сервер временно недоступен' }),
  }));
  const heartbeatFailed = page.waitForResponse(response => response.url() === `${url}/heartbeat` && response.status() === 503);
  await page.evaluate(() => { window.__syntheticMicrophone.stream.getAudioTracks()[0].enabled = false; });
  await expect(page.locator('#calibrate-noise')).toBeDisabled({ timeout: 3000 });
  await heartbeatFailed;
  await page.evaluate(() => { window.__syntheticMicrophone.stream.getAudioTracks()[0].enabled = true; });
  await expect(page.locator('#calibrate-noise')).toBeEnabled({ timeout: 3000 });
  await startCalibration(page);
  await page.locator('#cancel-calibration').click();
  await expect(page.locator('#cancel-calibration')).toBeHidden();
  await expect(page.locator('#calibrate-noise')).toBeEnabled();
  expect((await state()).settings.threshold).toBe(0.01);
  expect(await page.evaluate(() => window.__syntheticMicrophoneRequests)).toBe(1);
});

test('failed settings save preserves the custom draft and active threshold marker', async ({ page, baseURL }) => {
  const { url, state } = await createHost(page, baseURL, 'Failed calibration settings save');
  await adjustThreshold(page, 40);
  const draft = await page.locator('#threshold-value').textContent();
  await page.route(`${url}/settings`, route => route.request().method() === 'PUT'
    ? route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Настройки временно недоступны' }) })
    : route.continue());
  const response = page.waitForResponse(response => response.request().method() === 'PUT' && response.url() === `${url}/settings`);
  await page.locator('#save-settings').click();
  expect((await response).status()).toBe(503);
  await expect(page.locator('#save-settings')).toBeEnabled();
  await expect(page.locator('#threshold-adjustment')).toBeEnabled();
  await expect(page.locator('#threshold-adjustment')).toHaveValue('40');
  await expect(page.locator('#threshold-value')).toHaveText(draft);
  await expect(page.locator('#sensitivity')).toHaveValue('custom');
  await expect(page.locator('#threshold-hint')).toContainText(/сохраните|несохран/i);
  await expect(page.locator('#sound-draft-marker')).toBeVisible();
  expect(await markerPosition(page, '#sound-threshold-marker')).toBeCloseTo(50, 2);
  expect((await state()).settings.threshold).toBe(0.01);
  await page.unroute(`${url}/settings`);
  await saveSettings(page, url);
  expect((await state()).settings.threshold).toBeCloseTo(0.007924465962305567, 14);
});
