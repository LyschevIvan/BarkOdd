import { defineConfig } from '@playwright/test';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Deterministic synthetic microphone: 1 s quiet, 2 s tone, 5 s quiet.
// Chromium loops this file; no real microphone or camera is opened by tests.
mkdirSync('test-results', { recursive: true });
const rate = 48000;
const samples = rate * 8;
const wav = Buffer.alloc(44 + samples * 2);
wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 2, 28);
wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36);
wav.writeUInt32LE(samples * 2, 40);
for (let i = 0; i < samples; i++) {
  const t = i / rate;
  wav.writeInt16LE(t >= 1 && t < 3 ? Math.round(Math.sin(t * 2 * Math.PI * 440) * 12000) : 0, 44 + i * 2);
}
const audioPath = resolve('test-results/synthetic-microphone.wav');
writeFileSync(audioPath, wav);
const macChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const executablePath = process.env.BARKODD_CHROME_PATH || (existsSync(macChrome) ? macChrome : undefined);
const browserName = process.env.BARKODD_BROWSER || 'chromium';

export default defineConfig({
  testDir: './tests',
  testMatch: ['**/browser.spec.js', '**/microphone.spec.js', '**/auth.spec.js'],
  timeout: 90000,
  expect: { timeout: 20000 },
  workers: 1,
  reporter: 'list',
  outputDir: 'test-results/playwright',
  use: {
    browserName,
    baseURL: `${(process.env.BARKODD_BASE_URL || 'http://127.0.0.1:8088').replace(/\/+$/, '')}/`,
    viewport: { width: 1440, height: 1000 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    launchOptions: browserName === 'chromium' ? {
      executablePath,
      args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required', `--use-file-for-fake-audio-capture=${audioPath}`],
    } : {},
  },
});
