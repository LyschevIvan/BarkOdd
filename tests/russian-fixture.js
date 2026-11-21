import { test as base, expect } from '@playwright/test';

async function seedRussianLanguage(context) {
  await context.addInitScript(() => {
    try {
      if (localStorage.getItem('barkodd.language') === null) {
        localStorage.setItem('barkodd.language', 'ru');
      }
    } catch (_) { /* Storage may be unavailable on an initial blank document. */ }
  });
}

export const test = base.extend({
  context: async ({ context }, use) => {
    await seedRussianLanguage(context);
    await use(context);
  },
});

export { expect };

export async function russianContext(browser, options) {
  const context = await browser.newContext(options);
  await seedRussianLanguage(context);
  return context;
}
