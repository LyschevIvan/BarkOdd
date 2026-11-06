import { test, expect } from '@playwright/test';

const mode = process.env.BARKODD_AUTH_MODE || 'admin_code';
const code = process.env.BARKODD_OWNER_KEY || 'test-owner-key-0123456789abcdef0123456789';
const password = 'Home-is-quiet-2026!';
const unique = prefix => `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
const endpoint = (base, path) => new URL(path, base).href;
async function admin(page) {
  await page.goto('./');
  if (mode === 'multi_user') await page.locator('#admin-login-toggle').click();
  if (mode !== 'none') {
    await page.locator('#login-code').fill(code);
    await page.locator('#code-form button').click();
  }
  await expect(page.locator('#account-panel')).toBeVisible();
}
async function register(page, username) {
  await page.goto('./');
  await page.locator('#register-toggle').click();
  await page.locator('#register-username').fill(username);
  await page.locator('#register-password').fill(password);
  await page.locator('#register-confirm').fill(password);
  await page.locator('#register-form button').click();
  await expect(page.locator('#account-panel')).toBeVisible();
}
async function create(page, name) {
  await page.locator('#choose-host').click();
  await page.locator('#room-name').fill(name);
  await page.locator('#host-form button[type=submit]').click();
  await expect(page.locator('#room-title')).toHaveText(name);
  return page.evaluate(() => {
    const state = JSON.parse(localStorage.getItem('barkodd.account.v2.' + document.querySelector('#account-tools').dataset.userId));
    return state.host;
  });
}

test(`${mode}: account access, session room binding and guest link`, async ({ page, browser, baseURL }) => {
  await admin(page);
  await expect(page.locator('#auth-panel')).toBeHidden();
  const name = unique('Shared home');
  const binding = await create(page, name);
  expect(binding.account).toBe(true);
  expect(binding.hostToken).toBeUndefined();
  await expect(page.locator('#pairing-qr')).toBeVisible();
  expect(await page.evaluate(() => JSON.stringify({ ...localStorage }))).not.toContain(code);
  await page.locator('#switch-role').click();
  const card = page.locator('.owned-room').filter({ hasText: name });
  await expect(card).toHaveCount(1);
  await card.getByRole('button', { name: 'Просмотр', exact: true }).click();
  await expect(page.locator('#host-settings')).toBeHidden();
  const context = await browser.newContext();
  const guest = await context.newPage();
  await guest.goto(endpoint(baseURL, `?role=viewer#room=${binding.id}&key=${binding.viewerToken}`));
  await expect(guest.locator('#room-title')).toHaveText(name);
  await expect(guest.locator('#host-settings')).toBeHidden();
  await context.close();
});

test('new browser recovers rooms through its session without rotating guest links', async ({ page, browser, baseURL }) => {
  await admin(page);
  const name = unique('Recover home');
  const binding = await create(page, name);
  const context = await browser.newContext();
  const fresh = await context.newPage();
  await admin(fresh);
  const card = fresh.locator('.owned-room').filter({ hasText: name });
  await card.getByRole('button', { name: 'Устройство питомца', exact: true }).click();
  await expect(fresh.locator('#qr-placeholder')).toContainText('Создайте новую ссылку');
  await expect(fresh.locator('#copy-link')).toBeDisabled();
  const oldLink = await fresh.request.get(endpoint(baseURL, `api/rooms/${binding.id}`), { headers: { Authorization: `Bearer ${binding.viewerToken}` } });
  expect(oldLink.status()).toBe(200);
  await fresh.reload();
  await expect(fresh.locator('#qr-placeholder')).toContainText('Создайте новую ссылку');
  fresh.once('dialog', dialog => dialog.accept());
  await fresh.locator('#regenerate-key').click();
  await expect(fresh.locator('#pairing-qr')).toBeVisible();
  expect((await fresh.request.get(endpoint(baseURL, `api/rooms/${binding.id}`), { headers: { Authorization: `Bearer ${binding.viewerToken}` } })).status()).toBe(401);
  await context.close();
});

test('self registration isolates rooms, password change signs out, administrator can block and reset', async ({ page, browser, baseURL }) => {
  test.skip(mode !== 'multi_user');
  const first = unique('alice');
  await register(page, first);
  const binding = await create(page, unique('Private home'));
  await page.locator('#switch-role').click();
  const secondContext = await browser.newContext();
  const second = await secondContext.newPage();
  await register(second, unique('bob'));
  await expect(second.locator('.owned-room')).toHaveCount(0);
  expect((await second.request.get(endpoint(baseURL, `api/rooms/${binding.id}`))).status()).toBe(401);
  await page.locator('#password-toggle').click();
  await page.locator('#current-password').fill(password);
  await page.locator('#new-password').fill('Changed-home-password-2026');
  await page.locator('#password-form button').click();
  await expect(page.locator('#auth-panel')).toBeVisible();
  await page.locator('#login-username').fill(first);
  await page.locator('#login-password').fill('Changed-home-password-2026');
  await page.locator('#login-form button').click();
  await expect(page.locator('.owned-room')).toHaveCount(1);
  await page.locator('.owned-room').first().getByRole('button', { name: 'Устройство питомца', exact: true }).click();
  await page.locator('#capture-button').click();
  await expect.poll(() => page.locator('#camera-video').evaluate(v => !!v.srcObject)).toBe(true);
  await page.evaluate(() => { window.__blockedTracks = document.querySelector('#camera-video').srcObject.getTracks(); });
  const adminContext = await browser.newContext();
  const manager = await adminContext.newPage();
  await admin(manager);
  await manager.locator('#users-toggle').click();
  const user = manager.locator('.user-card').filter({ hasText: first });
  await user.getByRole('button', { name: 'Заблокировать', exact: true }).click();
  await expect(user.getByRole('button', { name: 'Разблокировать', exact: true })).toBeVisible();
  await expect(page.locator('#auth-panel')).toBeVisible();
  expect(await page.evaluate(() => window.__blockedTracks.every(track => track.readyState === 'ended'))).toBe(true);
  expect((await second.request.get(endpoint(baseURL, `api/rooms/${binding.id}`), { headers: { Authorization: `Bearer ${binding.viewerToken}` } })).status()).toBe(401);
  await user.getByRole('button', { name: 'Разблокировать', exact: true }).click();
  await expect(user.getByRole('button', { name: 'Заблокировать', exact: true })).toBeVisible();
  await user.locator('input').fill('Reset-home-password-2026');
  await user.getByRole('button', { name: 'Сбросить пароль', exact: true }).click();
  await expect(manager.locator('#toast')).toContainText('Пароль сброшен');
  await page.locator('#login-username').fill(first);
  await page.locator('#login-password').fill('Reset-home-password-2026');
  await page.locator('#login-form button').click();
  await expect(page.locator('.owned-room')).toHaveCount(1);
  await secondContext.close();
  await adminContext.close();
});

test('logout releases capture and returns to login without persisting credentials', async ({ page }) => {
  test.skip(mode === 'none');
  await admin(page);
  await create(page, unique('Logout home'));
  await page.locator('#capture-button').click();
  await expect.poll(() => page.locator('#camera-video').evaluate(v => !!v.srcObject)).toBe(true);
  await page.evaluate(() => { window.__logoutTracks = document.querySelector('#camera-video').srcObject.getTracks(); });
  await page.locator('#logout').click();
  await expect(page.locator('#auth-panel')).toBeVisible();
  expect(await page.evaluate(() => window.__logoutTracks.every(track => track.readyState === 'ended'))).toBe(true);
  expect(await page.evaluate(() => JSON.stringify({ ...localStorage }))).not.toContain(code);
});

test('mobile account forms fit the screen', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('./');
  if (mode !== 'none') {
    await expect(page.locator('#auth-panel')).toBeVisible();
    if (mode === 'multi_user') {
      await page.locator('#register-toggle').click();
      await expect(page.locator('#register-form')).toBeVisible();
    }
    await page.locator('#auth-panel').scrollIntoViewIfNeeded();
  } else await expect(page.locator('#account-panel')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: `test-results/auth-mobile-${mode}.png`, fullPage: true });
});

test('switching accounts in one browser restores only that account bindings', async ({ page }) => {
  test.skip(mode !== 'multi_user');
  const first = unique('scoped');
  await register(page, first);
  const name = unique('Scoped home');
  await create(page, name);
  await page.locator('#logout').click();
  await page.locator('#admin-login-toggle').click();
  await page.locator('#login-code').fill(code);
  await page.locator('#code-form button').click();
  await expect(page.locator('#account-name')).toHaveText('admin');
  await expect(page.locator('.owned-room').filter({ hasText: name })).toHaveCount(0);
  await page.locator('#logout').click();
  await page.locator('#login-username').fill(first);
  await page.locator('#login-password').fill(password);
  await page.locator('#login-form button').click();
  await expect(page.locator('.owned-room')).toHaveCount(1);
  await expect(page.locator('.owned-room')).toContainText(name);
  expect(await page.evaluate(() => JSON.stringify({ ...localStorage }))).not.toContain(password);
});

test('migrates saved guest links and owner QR keys without keeping legacy host credentials', async ({ page, browser }) => {
  await admin(page);
  const name = unique('Legacy home');
  const binding = await create(page, name);
  const guestContext = await browser.newContext();
  await guestContext.addInitScript(binding => {
    if (!localStorage.getItem('migration-seeded')) {
      localStorage.setItem('migration-seeded', 'true');
      localStorage.setItem('barkodd.binding.v1', JSON.stringify({ role: 'viewer', viewer: { id: binding.id, viewerToken: binding.viewerToken } }));
    }
  }, binding);
  const guest = await guestContext.newPage();
  await guest.goto('./');
  await expect(guest.locator('#room-title')).toHaveText(name);
  await expect(guest.locator('#host-settings')).toBeHidden();
  expect(await guest.evaluate(() => localStorage.getItem('barkodd.binding.v1'))).toBeNull();
  const ownerContext = await browser.newContext();
  await ownerContext.addInitScript(binding => {
    if (!localStorage.getItem('migration-seeded')) {
      localStorage.setItem('migration-seeded', 'true');
      localStorage.setItem('barkodd.binding.v1', JSON.stringify({ role: 'host', host: { id: binding.id, hostToken: 'legacy-host-secret', viewerToken: binding.viewerToken } }));
      localStorage.setItem('barkodd.account.v2.owner', JSON.stringify({ role: null, rooms: { preserved: { id: 'preserved', account: true, viewerToken: 'keep-existing-viewer' } } }));
    }
  }, binding);
  const owner = await ownerContext.newPage();
  await admin(owner);
  await owner.locator('.owned-room').filter({ hasText: name }).getByRole('button', { name: 'Устройство питомца', exact: true }).click();
  await expect(owner.locator('#pairing-qr')).toBeVisible();
  const stored = await owner.evaluate(() => ({ all: JSON.stringify({ ...localStorage }), account: JSON.parse(localStorage.getItem('barkodd.account.v2.owner')) }));
  expect(stored.all).not.toContain('legacy-host-secret');
  expect(stored.account.rooms[binding.id].viewerToken).toBe(binding.viewerToken);
  expect(stored.account.rooms.preserved.viewerToken).toBe('keep-existing-viewer');
  await ownerContext.close();
  await guestContext.close();
});

test('stale saved QR key requires explicit regeneration and never rotates on open', async ({ page, baseURL }) => {
  await admin(page);
  const binding = await create(page, unique('Stale QR home'));
  const rotated = await page.request.post(endpoint(baseURL, `api/rooms/${binding.id}/pairing`), { data: {}, headers: { Origin: new URL(baseURL).origin } });
  expect(rotated.status()).toBe(200);
  const { viewerToken } = await rotated.json();
  await page.reload();
  await expect(page.locator('#qr-placeholder')).toContainText('Ключ просмотра изменился');
  await expect(page.locator('#copy-link')).toBeDisabled();
  expect((await page.request.get(endpoint(baseURL, `api/rooms/${binding.id}`), { headers: { Authorization: `Bearer ${viewerToken}` } })).status()).toBe(200);
  await expect(page.locator('#account-tools')).toBeVisible();
});

test('delayed create response cannot copy one account room into the next account', async ({ page }) => {
  test.skip(mode !== 'multi_user');
  await register(page, unique('delayed'));
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let captured;
  const intercepted = new Promise(resolve => { captured = resolve; });
  let payload;
  await page.route('**/api/rooms', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    const response = await route.fetch();
    payload = await response.json();
    captured();
    await gate;
    await route.fulfill({ response });
  });
  await page.locator('#choose-host').click();
  await page.locator('#room-name').fill(unique('Delayed private home'));
  await page.locator('#host-form button').click();
  await intercepted;
  await page.locator('#logout').click();
  await expect(page.locator('#auth-panel')).toBeVisible();
  await page.locator('#admin-login-toggle').click();
  await page.locator('#login-code').fill(code);
  await page.locator('#code-form button').click();
  await expect(page.locator('#account-name')).toHaveText('admin');
  const delivered = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith('/api/rooms'));
  release();
  await delivered;
  await expect(page.locator('#account-panel')).toBeVisible();
  await expect(page.locator('#dashboard')).toBeHidden();
  const owner = await page.evaluate(() => localStorage.getItem('barkodd.account.v2.owner') || '');
  expect(owner).not.toContain(payload.id);
  expect(owner).not.toContain(payload.viewerToken);
  await expect(page.locator('#account-name')).toHaveText('admin');
});

test('stale anonymous auth refresh cannot replace a newer login or close its room', async ({ page }) => {
  test.skip(mode === 'none');
  let calls = 0;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let captured;
  const intercepted = new Promise(resolve => { captured = resolve; });
  await page.route('**/api/auth', async route => {
    if (++calls !== 2) return route.continue();
    const response = await route.fetch();
    captured();
    await gate;
    await route.fulfill({ response });
  });
  await page.goto('./');
  await expect(page.locator('#auth-panel')).toBeVisible();
  await intercepted;
  if (mode === 'multi_user') await page.locator('#admin-login-toggle').click();
  await page.locator('#login-code').fill(code);
  await page.locator('#code-form button').click();
  await expect(page.locator('#account-panel')).toBeVisible();
  const name = unique('Newer login home');
  await create(page, name);
  const delivered = page.waitForResponse(response => response.request().method() === 'GET' && response.url().endsWith('/api/auth'));
  release();
  await delivered;
  await expect(page.locator('#dashboard')).toBeVisible();
  await expect(page.locator('#room-title')).toHaveText(name);
  await expect(page.locator('#account-name')).toHaveText('admin');
});

test('failed v2 migration writes preserve a recoverable viewer key and discard old host credentials', async ({ page, browser, baseURL }) => {
  await admin(page);
  const name = unique('Storage recovery home');
  const binding = await create(page, name);
  const context = await browser.newContext();
  await context.addInitScript(binding => {
    const native = Storage.prototype.setItem;
    if (!localStorage.getItem('migration-seeded')) {
      native.call(localStorage, 'migration-seeded', 'true');
      native.call(localStorage, 'barkodd.binding.v1', JSON.stringify({ role: 'viewer', host: { id: binding.id, hostToken: 'obsolete-host-secret', viewerToken: binding.viewerToken }, viewer: { id: binding.id, viewerToken: binding.viewerToken } }));
    }
    if (!localStorage.getItem('allow-migration')) {
      Storage.prototype.setItem = function(key, value) { if (key.startsWith('barkodd.account.v2.') || key === 'barkodd.guest.v2') throw new DOMException('Test quota failure', 'QuotaExceededError'); return native.call(this, key, value); };
    }
  }, binding);
  const recovery = await context.newPage();
  await recovery.goto('./');
  await expect(recovery.locator(mode === 'none' ? '#account-panel' : '#auth-panel')).toBeVisible();
  const saved = await recovery.evaluate(() => localStorage.getItem('barkodd.binding.v1'));
  expect(saved).toContain(binding.viewerToken);
  expect(saved).not.toContain('obsolete-host-secret');
  expect((await recovery.request.get(endpoint(baseURL, `api/rooms/${binding.id}`), { headers: { Authorization: `Bearer ${binding.viewerToken}` } })).status()).toBe(200);
  await recovery.evaluate(() => localStorage.setItem('allow-migration', 'true'));
  await recovery.reload();
  await expect(recovery.locator('#room-title')).toHaveText(name);
  expect(await recovery.evaluate(() => localStorage.getItem('barkodd.binding.v1'))).toBeNull();
  await context.close();
});

test('stale tabs cannot create, list or log out using a different account cookie', async ({ page, context, baseURL }) => {
  test.skip(mode !== 'multi_user');
  await register(page, unique('tabs'));
  const staleList = await context.newPage();
  const staleLogout = await context.newPage();
  for (const stale of [staleList, staleLogout]) {
    await stale.goto('./');
    await expect(stale.locator('#account-panel')).toBeVisible();
  }
  for (const stale of [page, staleList, staleLogout]) await stale.route('**/api/auth', route => route.abort());
  const switcher = await context.newPage();
  await switcher.goto('./');
  await switcher.locator('#logout').click();
  await expect(switcher.locator('#auth-panel')).toBeVisible();
  await switcher.locator('#admin-login-toggle').click();
  await switcher.locator('#login-code').fill(code);
  await switcher.locator('#code-form button').click();
  await expect(switcher.locator('#account-name')).toHaveText('admin');
  const before = await (await switcher.request.get(endpoint(baseURL, 'api/rooms'))).json();
  const listResponse = staleList.waitForResponse(response => response.request().method() === 'GET' && response.url().endsWith('/api/rooms'));
  await staleList.locator('#refresh-rooms').click();
  expect((await listResponse).status()).toBe(401);
  const logoutResponse = staleLogout.waitForResponse(response => response.url().endsWith('/api/auth/logout'));
  await staleLogout.locator('#logout').click();
  expect((await logoutResponse).status()).toBe(401);
  await page.locator('#choose-host').click();
  await page.locator('#room-name').fill(unique('Cross tab forbidden'));
  const createResponse = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith('/api/rooms'));
  await page.locator('#host-form button').click();
  expect((await createResponse).status()).toBe(401);
  const current = await (await switcher.request.get(endpoint(baseURL, 'api/auth'))).json();
  expect(current.user.id).toBe('owner');
  const after = await (await switcher.request.get(endpoint(baseURL, 'api/rooms'))).json();
  expect(after.rooms.map(room => room.id)).toEqual(before.rooms.map(room => room.id));
  await staleList.close(); await staleLogout.close(); await switcher.close();
});
