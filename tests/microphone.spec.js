import { test, expect } from './russian-fixture.js';

async function syntheticMicrophone(page, amplitude = 0.2) {
  await page.addInitScript(level => {
    const NativeAudio = window.AudioContext;
    window.__syntheticMicrophoneRequests = 0;
    // Synthetic devices only: this test never opens the user's camera/microphone.
    navigator.mediaDevices.getUserMedia = async () => {
      window.__syntheticMicrophoneRequests++;
      const audio = new NativeAudio();
      const oscillator = audio.createOscillator();
      const gain = audio.createGain();
      gain.gain.value = level;
      const destination = audio.createMediaStreamDestination();
      oscillator.connect(gain);
      gain.connect(destination);
      oscillator.start();
      await audio.resume();
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
      const stream = canvas.captureStream(10);
      stream.addTrack(destination.stream.getAudioTracks()[0]);
      window.__syntheticMicrophone = { audio, stream, gain };
      return stream;
    };
  }, amplitude);
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
  const state = async () => {
    const response = await page.request.get(url);
    expect(response.ok()).toBe(true);
    return response.json();
  };
  return { url, state };
}

async function saveSettings(page, url) {
  const saved = page.waitForResponse(response => response.request().method() === 'PUT' && response.url() === `${url}/settings`);
  await page.locator('#save-settings').click();
  expect((await saved).ok()).toBe(true);
  await expect(page.locator('#save-settings')).toBeEnabled();
}

test('continued sound saves separate photos at the minimum interval and silence saves none', async ({ page, baseURL }) => {
  await syntheticMicrophone(page);
  const { url, state } = await createHost(page, baseURL, 'Continuous photo interval');
  await page.locator('#snapshot-interval').selectOption('10000');
  await saveSettings(page, url);
  try {
    await page.locator('#capture-button').click();
    await expect.poll(async () => (await state()).events.filter(event => event.hasPhoto).length).toBe(1);
    const first = (await state()).events[0];
    await expect.poll(async () => (await state()).events.filter(event => event.hasPhoto).length).toBe(2);
    const second = (await state()).events[0];
    expect(second.id).not.toBe(first.id);
    expect(Date.parse(second.photoAt) - Date.parse(first.photoAt)).toBeGreaterThanOrEqual(10000);
    expect((await state()).events.find(event => event.id === first.id).photoAt).toBe(first.photoAt);
    await expect(page.locator('.event-card')).toHaveCount(2);

    const quietAt = await page.evaluate(() => {
      window.__syntheticMicrophone.gain.gain.value = 0;
      return window.__syntheticMicrophone.audio.currentTime;
    });
    await expect.poll(() => page.evaluate(() => window.__syntheticMicrophone.audio.currentTime)).toBeGreaterThan(quietAt + 1.5);
    const quiet = await state();
    await expect.poll(() => page.evaluate(() => window.__syntheticMicrophone.audio.currentTime)).toBeGreaterThan(quietAt + 12);
    expect((await state()).events).toEqual(quiet.events);
    expect((await state()).lastNoiseAt).toBe(quiet.lastNoiseAt);
    await page.evaluate(() => { window.__syntheticMicrophone.gain.gain.value = 0.2; });
    await expect.poll(async () => (await state()).events.filter(event => event.hasPhoto).length).toBe(3);
    const third = (await state()).events[0];
    expect(Date.parse(third.photoAt) - Date.parse(second.photoAt)).toBeGreaterThanOrEqual(10000);
  } finally {
    await page.locator('#capture-button').click();
    await page.evaluate(() => window.__syntheticMicrophone.audio.close());
    await page.request.delete(url);
  }
});

for (const heldPart of ['response', 'upload']) {
test(`photo capture keeps its local interval with a delayed ${heldPart}`, async ({ page, baseURL }) => {
  await syntheticMicrophone(page);
  await page.addInitScript(() => {
    window.__photoCaptures = [];
    const encode = HTMLCanvasElement.prototype.toDataURL;
    HTMLCanvasElement.prototype.toDataURL = function (...args) {
      const result = encode.apply(this, args);
      if (args[0] === 'image/jpeg' && result.startsWith('data:image/jpeg;base64,')) window.__photoCaptures.push(performance.now());
      return result;
    };
  });
  const { url, state } = await createHost(page, baseURL, `Camera interval with delayed ${heldPart}`);
  const headers = { Origin: new URL(baseURL).origin };
  expect((await page.request.put(`${url}/settings`, { headers, data: { threshold: 0.01, snapshotIntervalMs: 10000 } })).status()).toBe(200);
  await page.reload();
  let release;
  const hold = new Promise(resolve => { release = resolve; });
  let firstUpload = false;
  const savedPhotos = [];
  await page.route(`${url}/events`, async route => {
    if (route.request().method() !== 'POST') return route.continue();
    const body = route.request().postDataJSON();
    const first = body.photo && !firstUpload;
    if (first) firstUpload = true;
    if (first && heldPart === 'upload') await hold;
    const response = await route.fetch();
    const saved = await response.json();
    if (body.photo) savedPhotos.push({ body, saved, receivedAt: Date.now() });
    if (first && heldPart === 'response') await hold;
    await route.fulfill({ response });
  });
  try {
    await page.locator('#capture-button').click();
    await expect.poll(() => firstUpload).toBe(true);
    if (heldPart === 'response') {
      // A five-second network response delay must not restart a ten-second
      // capture interval. Wait for that measured clock boundary, not a sleep.
      await page.waitForFunction(() => performance.now() - window.__photoCaptures[0] >= 5000);
    } else {
      await expect.poll(() => page.evaluate(() => window.__photoCaptures.length), { timeout: 12000 }).toBeGreaterThanOrEqual(2);
    }
    release();
    await expect.poll(() => page.evaluate(() => window.__photoCaptures.length), { timeout: 13000 }).toBeGreaterThanOrEqual(2);
    const captures = await page.evaluate(() => window.__photoCaptures);
    expect(captures[1] - captures[0]).toBeGreaterThanOrEqual(10000);
    expect(captures[1] - captures[0]).toBeLessThan(12500);
    await expect.poll(() => savedPhotos.length).toBeGreaterThanOrEqual(2);
    expect(savedPhotos.slice(0, 2).every(({ saved }) => saved.hasPhoto && saved.photoStatus === 'accepted')).toBe(true);
    expect(savedPhotos[1].body.episodeId).not.toBe(savedPhotos[0].body.episodeId);
    if (heldPart === 'upload') expect(savedPhotos[1].receivedAt - savedPhotos[0].receivedAt).toBeLessThan(3000);
    await expect.poll(async () => (await state()).events.filter(event => event.hasPhoto).length).toBe(2);
    expect(await page.evaluate(() => window.__syntheticMicrophoneRequests)).toBe(1);
    await page.locator('#capture-button').click();
  } finally {
    release();
    await page.evaluate(() => window.__syntheticMicrophone?.audio.close());
  }
});
}

test('microphone levels and disabled-input recovery work with a real Web Audio graph', async ({ page, baseURL }) => {
  await syntheticMicrophone(page);
  const { state } = await createHost(page, baseURL, 'Synthetic microphone regression');
  await page.locator('#capture-button').click();
  await expect.poll(async () => parseFloat(await page.locator('#sound-level-value').textContent())).toBeGreaterThan(1);
  await expect.poll(async () => (await state()).monitoring).toBe(true);
  await page.evaluate(() => { window.__syntheticMicrophone.stream.getAudioTracks()[0].enabled = false; });
  await expect.poll(async () => (await state()).monitoring).toBe(false);
  await expect(page.locator('#sound-level-value')).toHaveText('0%');
  await expect(page.locator('#media-status')).toContainText(/микрофон/i);
  await page.evaluate(() => { window.__syntheticMicrophone.stream.getAudioTracks()[0].enabled = true; });
  await expect.poll(async () => parseFloat(await page.locator('#sound-level-value').textContent())).toBeGreaterThan(1);
  await expect.poll(async () => (await state()).monitoring).toBe(true);
  await expect.poll(async () => (await state()).events.length).toBeGreaterThan(0);
  await page.locator('#capture-button').click();
  await page.evaluate(() => window.__syntheticMicrophone.audio.close());
});

test('maximum sensitivity detects quiet real audio without restarting capture and survives reload', async ({ page, baseURL }) => {
  // Sine amplitude 0.002 has RMS around 0.0014: below the default, above the most sensitive preset.
  await syntheticMicrophone(page, 0.002);
  const { url, state } = await createHost(page, baseURL, 'Quiet microphone regression');
  await expect(page.locator('#sensitivity')).toHaveValue('0.01');
  expect((await state()).settings.threshold).toBe(0.01);
  await page.locator('#capture-button').click();
  await expect.poll(async () => (await state()).monitoring).toBe(true);
  await expect.poll(() => page.evaluate(() => window.__syntheticMicrophone.audio.currentTime)).toBeGreaterThan(1.5);
  expect((await state()).events).toHaveLength(0);
  await page.evaluate(() => { window.__originalCaptureStream = window.__syntheticMicrophone.stream; });

  await page.locator('#sensitivity').selectOption('0.0005');
  await saveSettings(page, url);
  await expect.poll(async () => (await state()).settings.threshold).toBe(0.0005);
  await expect.poll(async () => (await state()).events.length).toBeGreaterThan(0);
  expect(await page.evaluate(() => ({
    requests: window.__syntheticMicrophoneRequests,
    sameStream: window.__syntheticMicrophone.stream === window.__originalCaptureStream,
    live: window.__syntheticMicrophone.stream.getTracks().every(track => track.readyState === 'live'),
  }))).toEqual({ requests: 1, sameStream: true, live: true });

  await page.locator('#capture-button').click();
  await page.evaluate(() => window.__syntheticMicrophone.audio.close());
  await page.reload();
  await expect(page.locator('#dashboard')).toBeVisible();
  await expect(page.locator('#sensitivity')).toHaveValue('0.0005');
  expect((await state()).settings.threshold).toBe(0.0005);
});

test('sensitivity offers exactly five presets and saves each through the real API', async ({ page, baseURL }) => {
  const { url, state } = await createHost(page, baseURL, 'Sensitivity presets regression');
  const values = ['0.1', '0.03', '0.01', '0.003', '0.0005'];
  const options = page.locator('#sensitivity option');
  await expect(options).toHaveCount(5);
  await expect(options).toHaveText(['Только очень громкие', 'Громкие', 'Обычные', 'Тихие', 'Даже очень тихие']);
  expect(await options.evaluateAll(items => items.map(item => item.value))).toEqual(values);

  for (const value of values) {
    await page.locator('#sensitivity').selectOption(value);
    await saveSettings(page, url);
    await expect.poll(async () => (await state()).settings.threshold).toBe(Number(value));
    await page.reload();
    await expect(page.locator('#dashboard')).toBeVisible();
    await expect(page.locator('#sensitivity')).toHaveValue(value);
    expect((await state()).settings.threshold).toBe(Number(value));
  }
  await page.locator('#host-settings').screenshot({ path: 'test-results/sensitivity-desktop.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.locator('#host-settings').screenshot({ path: 'test-results/sensitivity-mobile.png' });
});

test('saving the photo interval preserves a legacy threshold between presets', async ({ page, baseURL }) => {
  const { url, state } = await createHost(page, baseURL, 'Legacy sensitivity regression');
  const legacy = await page.request.put(`${url}/settings`, {
    data: { threshold: 0.06, snapshotIntervalMs: 30000 },
    headers: { Origin: new URL(baseURL).origin },
  });
  expect(legacy.ok()).toBe(true);
  await page.reload();
  await expect(page.locator('#dashboard')).toBeVisible();
  await expect(page.locator('#sensitivity')).toHaveValue('custom');
  expect((await state()).settings.threshold).toBe(0.06);

  await page.locator('#snapshot-interval').selectOption('60000');
  await saveSettings(page, url);
  await expect.poll(async () => (await state()).settings).toMatchObject({ threshold: 0.06, snapshotIntervalMs: 60000 });
  await page.reload();
  await expect(page.locator('#dashboard')).toBeVisible();
  await expect(page.locator('#sensitivity')).toHaveValue('custom');
  await expect(page.locator('#snapshot-interval')).toHaveValue('60000');
  expect((await state()).settings.threshold).toBe(0.06);
});

test('a delayed room poll cannot roll back saved camera settings during a short sound', async ({ page, baseURL }) => {
  await syntheticMicrophone(page, 0);
  const { url, state } = await createHost(page, baseURL, 'Saved camera settings');
  expect((await page.request.put(`${url}/settings`, {
    headers: { Origin: new URL(baseURL).origin }, data: { threshold: 0.5, snapshotIntervalMs: 30000 },
  })).status()).toBe(200);
  await page.reload();
  await page.locator('#capture-button').click();
  await expect(page.locator('#capture-button')).toHaveText('Остановить наблюдение');
  let release;
  let held = false;
  const hold = new Promise(resolve => { release = resolve; });
  await page.route(url, async route => {
    if (held || route.request().method() !== 'GET') return route.continue();
    const response = await route.fetch();
    held = true;
    await hold;
    await route.fulfill({ response });
  });
  try {
    await expect.poll(() => held).toBe(true);
    await page.locator('#sensitivity').selectOption('0.0005');
    await page.locator('#snapshot-interval').selectOption('10000');
    await saveSettings(page, url);
    const staleArrived = page.waitForResponse(response => response.request().method() === 'GET' && response.url() === url);
    release();
    await staleArrived;
    await page.evaluate(() => {
      window.__syntheticMicrophone.gain.gain.value = 0.02;
      setTimeout(() => { window.__syntheticMicrophone.gain.gain.value = 0; }, 500);
    });
    await expect.poll(async () => (await state()).events.filter(event => event.hasPhoto).length, { timeout: 5000 }).toBe(1);
    expect(await page.evaluate(() => window.__syntheticMicrophoneRequests)).toBe(1);
    await page.locator('#capture-button').click();
  } finally {
    release();
    await page.evaluate(() => window.__syntheticMicrophone?.audio.close());
  }
});

test('settings choices stay locked until an in-flight save completes', async ({ page, baseURL }) => {
  const { url, state } = await createHost(page, baseURL, 'Pending settings regression');
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  await page.route(`${url}/settings`, async route => { await gate; await route.continue(); });
  await page.locator('#sensitivity').selectOption('0.003');
  await page.locator('#snapshot-interval').selectOption('60000');
  const saved = page.waitForResponse(response => response.request().method() === 'PUT' && response.url() === `${url}/settings`);
  try {
    await page.locator('#save-settings').click();
    await expect(page.locator('#sensitivity')).toBeDisabled({ timeout: 1000 });
    await expect(page.locator('#snapshot-interval')).toBeDisabled();
  } finally { release(); }
  expect((await saved).ok()).toBe(true);
  await expect(page.locator('#sensitivity')).toBeEnabled();
  await expect(page.locator('#snapshot-interval')).toBeEnabled();
  expect((await state()).settings).toMatchObject({ threshold: 0.003, snapshotIntervalMs: 60000 });
});
