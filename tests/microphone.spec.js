import { test, expect } from '@playwright/test';

test('microphone levels and disabled-input recovery work with a real Web Audio graph', async ({ page, baseURL }) => {
  await page.addInitScript(() => {
    const NativeAudio = window.AudioContext;
    // Synthetic devices only: this test never opens the user's camera/microphone.
    navigator.mediaDevices.getUserMedia = async () => {
      const audio = new NativeAudio();
      const oscillator = audio.createOscillator();
      const gain = audio.createGain();
      gain.gain.value = 0.2;
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
  });
  await page.goto('./');
  await page.locator('#choose-host').click();
  await page.locator('#room-name').fill('Synthetic microphone regression');
  await page.locator('#creation-key').fill(process.env.BARKODD_OWNER_KEY || 'test-owner-key-0123456789abcdef0123456789');
  await page.locator('#host-form button[type=submit]').click();
  await expect(page.locator('#dashboard')).toBeVisible();
  await page.locator('#capture-button').click();
  await expect.poll(async () => parseFloat(await page.locator('#sound-level-value').textContent())).toBeGreaterThan(1);
  const binding = await page.evaluate(() => JSON.parse(localStorage.getItem('barkodd.binding.v1')).host);
  const state = async () => {
    const response = await page.request.get(new URL(`api/rooms/${binding.id}`, baseURL).href, { headers: { Authorization: `Bearer ${binding.hostToken}` } });
    expect(response.ok()).toBe(true);
    return response.json();
  };
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
