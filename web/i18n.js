import appMessages from './messages-app.js';
import htmlMessages from './messages-html.js';
import mediaMessages from './messages-media.js';
import serverMessages from './messages-server.js';

export const LANGUAGE_STORAGE_KEY = 'barkodd.language';
const messages = { ...htmlMessages, ...mediaMessages, ...serverMessages, ...appMessages };
const reverseMessages = new Map(Object.entries(messages).map(([ru, en]) => [en, ru]));
let language = 'en';
try { if (globalThis.window?.localStorage?.getItem(LANGUAGE_STORAGE_KEY) === 'ru') language = 'ru'; } catch (_) { /* Storage is optional. */ }

export const getLanguage = () => language;
export const getLocale = () => language === 'ru' ? 'ru-RU' : 'en-US';

export function setLanguage(value) {
  language = value === 'ru' ? 'ru' : 'en';
  try { globalThis.window?.localStorage?.setItem(LANGUAGE_STORAGE_KEY, language); } catch (_) { /* Still switch for this visit. */ }
  if (globalThis.document) document.documentElement.lang = language;
  globalThis.window?.dispatchEvent(new Event('languagechange'));
}

export function t(key, params = {}) {
  const template = language === 'ru' ? key : messages[key] ?? key;
  return template.replace(/\{(\w+)\}/g, (match, name) => Object.hasOwn(params, name) ? String(params[name]) : match);
}

const templatePatterns = [];
for (const [ru, en] of Object.entries(messages)) {
  if (!/\{\w+\}/.test(ru)) continue;
  for (const template of [ru, en]) {
    const names = [];
    const pattern = template.split(/(\{\w+\})/g).map(part => {
      if (/^\{\w+\}$/.test(part)) { names.push(part.slice(1, -1)); return '([\\s\\S]*?)'; }
      return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }).join('');
    templatePatterns.push({ key: ru, names, pattern: new RegExp(`^${pattern}$`) });
  }
}

// Only call this on application messages, never on user-provided names or text.
export function translateMessage(message) {
  if (typeof message !== 'string' || !message) return message;
  if (Object.hasOwn(messages, message)) return t(message);
  if (reverseMessages.has(message)) return t(reverseMessages.get(message));
  for (const { key, names, pattern } of templatePatterns) {
    const match = message.match(pattern);
    if (match) return t(key, Object.fromEntries(names.map((name, index) => {
      const value = match[index + 1];
      // inputIssue is an application-generated microphone diagnostic. Other
      // parameters may contain user names and must remain exactly as entered.
      return [name, name === 'inputIssue' ? translateMessage(value) : value];
    })));
  }
  return message;
}

export function applyTranslations(root = document) {
  if (root === globalThis.document) document.documentElement.lang = language;
  const attributes = ['aria-label', 'aria-valuetext', 'title', 'placeholder', 'alt', 'content'];
  const selector = ['[data-i18n]', ...attributes.map(name => `[data-i18n-${name}]`)].join(',');
  const elements = [...root.querySelectorAll(selector)];
  if (root.matches?.(selector)) elements.unshift(root);
  for (const element of elements) {
    let params = {};
    try { params = JSON.parse(element.dataset.i18nParams || '{}'); } catch (_) { /* No substitutions. */ }
    if (element.hasAttribute('data-i18n')) {
      const value = t(element.dataset.i18n, params);
      if (element.textContent !== value) element.textContent = value;
    }
    for (const name of attributes) {
      const key = element.getAttribute(`data-i18n-${name}`);
      if (key !== null) element.setAttribute(name, t(key, params));
    }
  }
  for (const template of root.querySelectorAll('template')) applyTranslations(template.content);
}
