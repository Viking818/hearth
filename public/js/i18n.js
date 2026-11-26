// Words in the user's language. English is the source text; a language file maps it to its own words.
// The page and the server share this file (the server answers each request in that page's language).
import ru from './lang/ru.js';

const DICTS = { ru };
export const LANGS = [
  ['en', 'English'],
  ['ru', 'Русский'],
];

let lang = 'en';
let resolver = null;

export function setLang(l) {
  lang = l === 'en' || DICTS[l] ? l : 'en';
}

export function getLang() {
  const r = resolver ? resolver() : '';
  return r && (r === 'en' || DICTS[r]) ? r : lang;
}

// The server sets this: it returns the language of the request being handled.
export function setLangResolver(fn) {
  resolver = fn;
}

// 'auto' (or anything unknown) follows the browser's or the system's languages.
export function pickLang(pref, accepted = []) {
  if (pref === 'en' || DICTS[pref]) return pref;
  for (const a of accepted) {
    const base = String(a || '').toLowerCase().split(/[-_]/)[0];
    if (base === 'en' || DICTS[base]) return base;
  }
  return 'en';
}

export function locale() {
  return getLang() === 'ru' ? 'ru-RU' : 'en-US';
}

const fill = (s, vars) => (vars ? s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] ?? m)) : s);

export function t(text, vars) {
  const d = DICTS[getLang()];
  const s = d && typeof d[text] === 'string' ? d[text] : text;
  return fill(s, vars);
}

// Counted words: tn(3, '{n} chat', '{n} chats') → "3 chats", or "3 чата" in Russian.
export function tn(n, one, other, vars) {
  const l = getLang();
  const forms = DICTS[l]?.[one];
  let s;
  if (Array.isArray(forms)) s = forms[pluralIndex(l, n)] ?? forms[forms.length - 1];
  else s = n === 1 ? one : other;
  return fill(s, { n, ...vars });
}

function pluralIndex(l, n) {
  if (l === 'ru') {
    if (!Number.isInteger(n)) return 1;
    const a = Math.abs(n) % 100;
    const b = a % 10;
    if (a > 10 && a < 20) return 2;
    if (b === 1) return 0;
    if (b >= 2 && b <= 4) return 1;
    return 2;
  }
  return n === 1 ? 0 : 1;
}

export function hasLang(l) {
  return l === 'en' || Boolean(DICTS[l]);
}
