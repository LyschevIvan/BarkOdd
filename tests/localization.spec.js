import { test, expect } from '@playwright/test';

test.use({ locale: 'ru-RU' });

test('English first visit, in-place language switching and saved preference', async ({ page }) => {
  await page.goto('./');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.locator('#language-en')).toHaveAttribute('aria-pressed', 'true');
  expect(await page.locator('body').innerText()).not.toMatch(/[А-Яа-яЁё]/);
  expect(await page.title()).not.toMatch(/[А-Яа-яЁё]/);
  expect(await page.locator('meta[name=description]').getAttribute('content')).not.toMatch(/[А-Яа-яЁё]/);
  await page.locator('#login-code').fill('unfinished-draft');
  await page.locator('#language-ru').click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'ru');
  await expect(page.locator('#login-code')).toHaveValue('unfinished-draft');
  expect(await page.title()).toMatch(/[А-Яа-яЁё]/);
  expect(await page.locator('meta[name=description]').getAttribute('content')).toMatch(/[А-Яа-яЁё]/);
  await page.reload();
  await expect(page.locator('#language-ru')).toHaveAttribute('aria-pressed', 'true');
  await page.locator('#language-en').click();
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await page.setViewportSize({ width: 375, height: 812 });
  await expect(page.locator('#language-ru')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/localization-en-mobile.png', fullPage: true });
});

test('switching works without storage and translates an existing server error', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'localStorage', { get() { throw new DOMException('Blocked', 'SecurityError'); } });
  });
  await page.goto('./');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await page.locator('#login-code').fill('invalid-code-0123456789abcdef0123456789');
  await page.locator('#code-form button[type=submit]').click();
  await expect(page.locator('#welcome-alert')).toContainText('Invalid login credentials');
  await page.locator('#language-ru').click();
  await expect(page.locator('#welcome-alert')).toContainText('Неверные данные для входа');
  await page.locator('#language-en').click();
  await expect(page.locator('#welcome-alert')).toContainText('Invalid login credentials');
});

test('language switching preserves monitoring, custom names, settings and guest access', async ({ page, browser }) => {
  await page.goto('./');
  await page.locator('#login-code').fill(process.env.BARKODD_OWNER_KEY || 'test-owner-key-0123456789abcdef0123456789');
  await page.locator('#code-form button[type=submit]').click();
  await expect(page.locator('#account-panel')).toBeVisible();
  await page.locator('#choose-host').click();
  const name = `Комната питомца ${Date.now()}`;
  await page.locator('#room-name').fill(name);
  await page.locator('#host-form button[type=submit]').click();
  await expect(page.locator('#dashboard')).toBeVisible();
  await page.locator('#capture-button').click();
  await expect(page.locator('#capture-button')).toHaveText('Stop monitoring');
  const tracks = await page.locator('#camera-video').evaluate(video => video.srcObject.getTracks().map(track => track.id));
  await page.locator('#snapshot-interval').selectOption('60000');
  await page.locator('#language-ru').click();
  await expect(page.locator('#capture-button')).toHaveText('Остановить наблюдение');
  await expect(page.locator('#room-title')).toHaveText(name);
  await expect(page.locator('#snapshot-interval')).toHaveValue('60000');
  await page.locator('#language-en').click();
  await expect(page.locator('#capture-button')).toHaveText('Stop monitoring');
  await expect(page.locator('#room-title')).toHaveText(name);
  expect(await page.locator('#camera-video').evaluate(video => video.srcObject.getTracks().map(track => track.id))).toEqual(tracks);
  expect(await page.locator('#camera-video').evaluate(video => video.srcObject.getTracks().every(track => track.readyState === 'live'))).toBe(true);
  const binding = await page.evaluate(() => JSON.parse(localStorage.getItem('barkodd.account.v2.' + document.querySelector('#account-tools').dataset.userId)).host);
  const guestContext = await browser.newContext({ locale: 'ru-RU' });
  try {
    const guest = await guestContext.newPage();
    const guestURL = new URL(page.url());
    guestURL.hash = new URLSearchParams({ room: binding.id, key: binding.viewerToken }).toString();
    await guest.goto(guestURL.href);
    await expect(guest.locator('html')).toHaveAttribute('lang', 'en');
    await expect(guest.locator('#room-title')).toHaveText(name);
    await guest.locator('#language-ru').click();
    await expect(guest.locator('#capture-button')).toHaveText('Включить видео');
    await expect(guest.locator('#room-title')).toHaveText(name);
  } finally { await guestContext.close(); }
  await page.locator('#capture-button').click();
});
