import { test, expect } from '@playwright/test';

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
      window.__syntheticMicrophone = { audio, stream };
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
  await expect(page.locator('#sensitivity')).toHaveValue('0.1');
  expect((await state()).settings.threshold).toBe(0.06);

  await page.locator('#snapshot-interval').selectOption('60000');
  await saveSettings(page, url);
  await expect.poll(async () => (await state()).settings).toMatchObject({ threshold: 0.06, snapshotIntervalMs: 60000 });
  await page.reload();
  await expect(page.locator('#dashboard')).toBeVisible();
  await expect(page.locator('#sensitivity')).toHaveValue('0.1');
  await expect(page.locator('#snapshot-interval')).toHaveValue('60000');
  expect((await state()).settings.threshold).toBe(0.06);
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
