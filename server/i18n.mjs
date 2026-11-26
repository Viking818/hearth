// The language of each request, so messages from the server match the page that asked.
// Background work (auto-loading a model, batch jobs) uses the language the page used last.
import { AsyncLocalStorage } from 'node:async_hooks';
import { setLangResolver, pickLang, hasLang } from '../public/js/i18n.js';
import { getSettings } from './settings.mjs';

export { t, tn, getLang, locale } from '../public/js/i18n.js';

const als = new AsyncLocalStorage();
let lastPageLang = '';

export function defaultLang() {
  const pref = getSettings().language;
  if (pref && pref !== 'auto' && hasLang(pref)) return pref;
  return lastPageLang || pickLang('auto', [Intl.DateTimeFormat().resolvedOptions().locale, process.env.LANG]);
}

setLangResolver(() => als.getStore()?.lang || defaultLang());

// For pages the browser opens by itself (the end of a sign-in): the language Hearth's page uses.
export function inLang(lang, fn) {
  return als.run({ lang }, fn);
}

// Requests from Hearth's page say their language; apps get English error messages.
export function runWithLang(req, fn) {
  const header = String(req.headers['x-hearth-lang'] || '');
  let lang = 'en';
  if (header && hasLang(header)) {
    lang = header;
    lastPageLang = header;
  }
  return als.run({ lang }, fn);
}
