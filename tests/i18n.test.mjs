import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getLanguage, getLocale, setLanguage, t, translateMessage } from '../web/i18n.js';
import appMessages from '../web/messages-app.js';
import htmlMessages from '../web/messages-html.js';
import mediaMessages from '../web/messages-media.js';
import serverMessages from '../web/messages-server.js';

test('English is the default and unsupported languages fall back to English', () => {
  assert.equal(getLanguage(), 'en');
  assert.equal(getLocale(), 'en-US');
  setLanguage('ru');
  assert.equal(getLocale(), 'ru-RU');
  assert.equal(t('Неверные данные для входа'), 'Неверные данные для входа');
  setLanguage('fr');
  assert.equal(getLanguage(), 'en');
  assert.equal(t('Неверные данные для входа'), 'Invalid login credentials');
});

test('server errors translate both ways while unknown messages stay intact', () => {
  setLanguage('en');
  assert.equal(translateMessage('Неверные данные для входа'), 'Invalid login credentials');
  assert.equal(translateMessage('Custom proxy message'), 'Custom proxy message');
  setLanguage('ru');
  assert.equal(translateMessage('Invalid login credentials'), 'Неверные данные для входа');
  setLanguage('en');
});

test('nested calibration errors switch language with their surrounding message', () => {
  setLanguage('en');
  const issue = 'Микрофон недоступен. Проверьте подключение и запустите наблюдение снова.';
  const message = t('Калибровка прервана. {inputIssue}', { inputIssue: t(issue) });
  setLanguage('ru');
  assert.equal(translateMessage(message), `Калибровка прервана. ${issue}`);
  setLanguage('en');
  assert.equal(translateMessage(`Калибровка прервана. ${issue}`), message);
});

test('translations preserve all interpolation parameters and contain English output', () => {
  const placeholders = text => [...text.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort();
  for (const catalog of [appMessages, htmlMessages, mediaMessages, serverMessages]) {
    for (const [ru, en] of Object.entries(catalog)) {
      assert.deepEqual(placeholders(en), placeholders(ru), ru);
      assert.doesNotMatch(en, /[А-Яа-яЁё]/, ru);
    }
  }
});
