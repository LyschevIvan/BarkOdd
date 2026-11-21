import { test, expect, russianContext } from './russian-fixture.js';

const transport = process.env.BARKODD_TRANSPORT || 'websocket';
const liveSelector = transport === 'webrtc' ? '#remote-video' : '#live-frame';
const endpoint = (baseURL, path) => new URL(path, baseURL).href;
const groupCard = (page, name) => page.locator('.owned-group').filter({
  has: page.getByRole('heading', { name, exact: true }),
});

async function register(page, username) {
  const password = 'Shared-home-camera-2026!';
  await page.goto('./');
  await page.locator('#register-toggle').click();
  await page.locator('#register-username').fill(username);
  await page.locator('#register-password').fill(password);
  await page.locator('#register-confirm').fill(password);
  await page.locator('#register-form button').click();
  await expect(page.locator('#account-panel')).toBeVisible();
}

async function createFirstCamera(page, name) {
  await page.locator('#choose-host').click();
  await page.locator('#room-name').fill(name);
  await page.locator('#host-form button[type=submit]').click();
  await expect(page.locator('#room-title')).toHaveText(name);
  await page.locator('#switch-role').click();
}

function waitForCameraStream(page, baseURL, cameraID) {
  const path = new URL(`api/rooms/${cameraID}/stream`, baseURL).pathname;
  return page.waitForEvent('websocket', socket => new URL(socket.url()).pathname === path);
}

async function startCameraStream(page, baseURL, cameraID) {
  const [socket] = await Promise.all([
    waitForCameraStream(page, baseURL, cameraID),
    page.locator('#capture-button').click(),
  ]);
  return socket;
}

async function expectLiveFrames(page) {
  const frame = page.locator(liveSelector);
  await expect(frame).toBeVisible();
  const progress = () => frame.evaluate(element => {
    if (element instanceof HTMLVideoElement) return element.getVideoPlaybackQuality().totalVideoFrames;
    return element.complete && element.naturalWidth > 0 ? element.src : null;
  });
  await expect.poll(progress).toBeTruthy();
  const first = await progress();
  await expect.poll(async () => {
    const next = await progress();
    return Boolean(next) && next !== first;
  }).toBe(true);
  await expect(frame).toBeVisible();
}

test(`${transport}: shared cameras stream independently and revoking one owner stops only their source`, async ({ page, context, browser, baseURL, browserName }) => {
  test.skip(process.env.BARKODD_AUTH_MODE !== 'multi_user', 'Shared owners require multi_user.');
  test.skip(browserName !== 'chromium', 'This test uses Chromium’s fake camera and microphone.');

  const suffix = Date.now().toString(36);
  const firstOwner = `shared_alice_${suffix}`;
  const secondOwner = `shared_bob_${suffix}`;
  const groupName = `Shared home ${suffix}`;
  const cameraName = 'Hallway camera';
  const privateName = `Private home ${suffix}`;
  const groupsURL = endpoint(baseURL, 'api/groups');
  const roomURL = id => endpoint(baseURL, `api/rooms/${id}`);
  const state = async id => {
    const response = await page.request.get(roomURL(id));
    expect(response.status()).toBe(200);
    return response.json();
  };

  const secondContext = await russianContext(browser);
  try {
    const second = await secondContext.newPage();
    const group = groupCard(page, groupName);
    const sharedGroup = groupCard(second, groupName);

    const { firstID, secondID } = await test.step('Share the room with a second account that can add its own camera', async () => {
      await register(page, firstOwner);
      await register(second, secondOwner);
      await createFirstCamera(page, groupName);
      await expect(group).toBeVisible({ timeout: 5000 });
      await createFirstCamera(second, privateName);
      await expect(groupCard(second, privateName)).toBeVisible();
      await expect(sharedGroup).toHaveCount(0);

      const memberForm = group.locator('.add-room-member');
      await memberForm.locator('[name=username]').fill(secondOwner);
      await memberForm.getByRole('button', { name: 'Добавить хозяина', exact: true }).click();
      await expect(group.locator('.room-member').filter({ hasText: secondOwner })).toBeVisible();
      await second.locator('#refresh-rooms').click();
      await expect(sharedGroup.locator('.owned-room')).toContainText(groupName);

      const cameraForm = sharedGroup.locator('.add-room-camera');
      await cameraForm.locator('[name=name]').fill(cameraName);
      await cameraForm.getByRole('button', { name: 'Добавить камеру', exact: true }).click();
      await expect(second.locator('#room-title')).toHaveText(cameraName);
      await page.locator('#refresh-rooms').click();
      await expect(group.locator('.owned-room')).toHaveCount(2);

      const response = await page.request.get(groupsURL);
      expect(response.status()).toBe(200);
      const { groups } = await response.json();
      const shared = groups.find(group => group.name === groupName);
      expect(shared?.cameras.map(camera => camera.name)).toEqual(expect.arrayContaining([groupName, cameraName]));
      const { cameras } = shared;
      const firstID = cameras.find(camera => camera.name === groupName).id;
      const secondID = cameras.find(camera => camera.name === cameraName).id;
      expect(firstID).not.toBe(secondID);
      return { firstID, secondID };
    });

    const source = await context.newPage();
    const viewer = await context.newPage();
    await Promise.all([source.goto('./'), viewer.goto('./')]);
    await expect(groupCard(viewer, groupName)).toBeVisible();
    const { firstSession, secondSession, secondSocket } = await test.step('Keep both source sessions active at the same time', async () => {
      const camera = groupCard(source, groupName).locator('.owned-room').filter({ hasText: groupName });
      await camera.getByRole('button', { name: 'Устройство питомца', exact: true }).click();
      await expect(source.locator('#room-title')).toHaveText(groupName);
      await startCameraStream(source, baseURL, firstID);
      await expect.poll(async () => (await state(firstID)).monitoring).toBe(true);
      const firstSession = (await state(firstID)).sessionId;
      expect(firstSession).toBeTruthy();

      const secondSocket = await startCameraStream(second, baseURL, secondID);
      await expect.poll(async () => (await state(secondID)).monitoring).toBe(true);
      const secondSession = (await state(secondID)).sessionId;
      expect(secondSession).toBeTruthy();
      expect(await state(firstID)).toMatchObject({ monitoring: true, sessionId: firstSession });
      expect(secondSession).not.toBe(firstSession);
      await expect(second.locator('#camera-video')).toBeVisible();
      await second.locator('#camera-video').evaluate(video => {
        window.__sharedCaptureTracks = video.srcObject.getTracks();
      });
      return { firstSession, secondSession, secondSocket };
    });

    await test.step('Play the second camera and switch to a live feed from the first', async () => {
      const camera = groupCard(viewer, groupName).locator('.owned-room').filter({ hasText: cameraName });
      await camera.getByRole('button', { name: 'Просмотр', exact: true }).click();
      await expect(viewer.locator('#room-title')).toHaveText(cameraName);
      await expect(viewer.locator('#viewer-camera')).toHaveValue(secondID);
      const originalStream = await startCameraStream(viewer, baseURL, secondID);
      await expectLiveFrames(viewer);

      await Promise.all([
        waitForCameraStream(viewer, baseURL, firstID),
        viewer.locator('#viewer-camera').selectOption(firstID),
      ]);
      await expect(viewer.locator('#room-title')).toHaveText(groupName);
      await expect.poll(() => originalStream.isClosed()).toBe(true);
      await expectLiveFrames(viewer);
    });

    await test.step('Revocation stops the removed owner’s capture and preserves the other stream', async () => {
      expect(secondSocket.isClosed()).toBe(false);
      expect(await state(secondID)).toMatchObject({ monitoring: true, sessionId: secondSession });
      const member = group.locator('.room-member').filter({ hasText: secondOwner });
      page.once('dialog', dialog => dialog.accept());
      await member.getByRole('button', { name: 'Удалить хозяина', exact: true }).click();
      await expect(member).toHaveCount(0);
      await expect.poll(() => secondSocket.isClosed(), { timeout: 5000 }).toBe(true);
      await expect.poll(() => second.evaluate(() => window.__sharedCaptureTracks.every(track => track.readyState === 'ended'))).toBe(true);
      await expect(second.locator('#account-panel')).toBeVisible();
      await expect(second.locator('#account-name')).toHaveText(secondOwner);
      await expect(groupCard(second, privateName)).toBeVisible();
      await expect(sharedGroup).toHaveCount(0);
      expect((await second.request.get(roomURL(secondID))).status()).toBe(401);
      expect((await state(secondID)).monitoring).toBe(false);
      expect(await state(firstID)).toMatchObject({ monitoring: true, sessionId: firstSession });
      await expectLiveFrames(viewer);
    });
  } finally {
    await secondContext.close();
  }
});
