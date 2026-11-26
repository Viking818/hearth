// App-wide state and server calls. Components read with useStore() and change with set().
import { useState, useEffect } from '../vendor/preact-htm.js';
import { t, getLang, locale } from './i18n.js';

const state = {
  route: { page: 'chat', id: '' },
  status: null, // /api/status
  models: [], // local models
  chats: [],
  downloads: [],
  assistants: [],
  toasts: [],
  updates: null,
  bots: null, // { working, unread } for the sidebar
  sidebarOpen: true,
};
const subs = new Set();

export function getState() {
  return state;
}

export function set(patch) {
  Object.assign(state, typeof patch === 'function' ? patch(state) : patch);
  for (const fn of subs) fn();
}

export function useStore() {
  const [, force] = useState(0);
  useEffect(() => {
    const fn = () => force((n) => n + 1);
    subs.add(fn);
    return () => subs.delete(fn);
  }, []);
  return state;
}

export class ApiError extends Error {
  constructor(message, status, data) {
    super(message);
    this.status = status;
    this.code = data?.error?.code || '';
    this.data = data;
  }
}

export async function api(path, { method = 'GET', body, raw, headers } = {}) {
  const opts = { method, headers: { 'x-hearth-lang': getLang(), ...(headers || {}) } };
  if (raw) opts.body = raw;
  else if (body !== undefined) {
    opts.body = JSON.stringify(body);
    opts.headers['content-type'] = 'application/json';
  }
  let res;
  try {
    res = await fetch(path, opts);
  } catch {
    throw new Error(t('Hearth is not running. Start it again from the Hearth launcher.'));
  }
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    if (data?.error?.code === 'PAIR') set({ needsPairing: true });
    throw new ApiError(data?.error?.message || t('Request failed ({status})', { status: res.status }), res.status, data);
  }
  return data;
}

let toastId = 0;
export function toast(text, kind = '') {
  const id = ++toastId;
  set({ toasts: [...state.toasts, { id, text, kind }] });
  setTimeout(() => set({ toasts: state.toasts.filter((x) => x.id !== id) }), kind === 'bad' ? 6000 : 3200);
}

export function toastError(err) {
  toast(String(err?.message || err), 'bad');
}

// ---- Loaders ----
export async function refreshStatus() {
  try {
    set({ status: await api('/api/status') });
  } catch {}
}

export async function refreshModels() {
  try {
    const r = await api('/api/models');
    set({ models: r.models });
  } catch (err) {
    toastError(err);
  }
}

export async function refreshChats() {
  try {
    set({ chats: (await api('/api/chats')).chats });
  } catch {}
}

export async function refreshDownloads() {
  try {
    set({ downloads: (await api('/api/downloads')).downloads });
  } catch {}
}

export async function refreshAssistants() {
  try {
    set({ assistants: (await api('/api/assistants')).assistants });
  } catch {}
}

export async function refreshBots() {
  try {
    set({ bots: await api('/api/bots/summary') });
  } catch {}
}

export async function refreshUpdates() {
  try {
    set({ updates: await api('/api/updates') });
  } catch {}
}

export async function loadModel(model) {
  try {
    const st = await api('/api/engine/start', { method: 'POST', body: { id: model.id } });
    set({ status: { ...state.status, engine: st } });
    pollEngine();
  } catch (err) {
    toastError(err);
  }
}

// Stops one loaded model (by id), or all of them.
export async function stopModel(id) {
  try {
    const st = await api('/api/engine/stop', { method: 'POST', body: { id: id || '' } });
    set({ status: { ...state.status, engine: st } });
  } catch (err) {
    toastError(err);
  }
}

// With several models loaded: the one the chat (and apps that don't name a model) should use.
export async function makePrimary(id) {
  try {
    const st = await api('/api/engine/primary', { method: 'POST', body: { id } });
    set({ status: { ...state.status, engine: st } });
  } catch (err) {
    toastError(err);
  }
}

// While a model loads, check every half second; otherwise every few seconds.
let pollTimer = null;
export function pollEngine() {
  clearTimeout(pollTimer);
  const tick = async () => {
    await refreshStatus();
    const s = state.status?.engine?.status;
    pollTimer = setTimeout(tick, s === 'starting' || s === 'stopping' ? 500 : 4000);
  };
  tick();
}

export function go(hash) {
  if (location.hash !== hash) location.hash = hash;
}

export const PAGES = ['models', 'monitor', 'connect', 'settings', 'assistants', 'extensions', 'batch', 'images', 'video', 'bots', 'artifacts', 'design'];

export function parseRoute() {
  const h = location.hash.replace(/^#\/?/, '');
  if (h.startsWith('pair=')) return { page: 'chat', id: '' };
  const [page, id] = h.split('/');
  if (PAGES.includes(page)) return { page, id: id || '' };
  return { page: 'chat', id: page === 'chat' ? id || '' : '' };
}

// ---- Formatting ----
const num = (n, digits) => n.toLocaleString(locale(), { minimumFractionDigits: digits, maximumFractionDigits: digits });

export function fmtBytes(n) {
  if (n == null || Number.isNaN(n)) return '–';
  if (n >= 1e12) return t('{n} TB', { n: num(n / 1e12, 1) });
  if (n >= 1e9) return t('{n} GB', { n: num(n / 1e9, n >= 1e11 ? 0 : 1) });
  if (n >= 1e6) return t('{n} MB', { n: num(n / 1e6, 0) });
  if (n >= 1e3) return t('{n} KB', { n: num(n / 1e3, 0) });
  return t('{n} B', { n });
}

// Memory (RAM, graphics memory) in binary units, the way computers are sold: a 48 GB Mac shows 48 GB.
export function fmtMem(n) {
  if (n == null || Number.isNaN(n)) return '–';
  const g = n / 1024 ** 3;
  return g >= 1 ? t('{n} GB', { n: num(g, g >= 100 ? 0 : 1) }) : t('{n} MB', { n: Math.round(n / 1024 ** 2) });
}

export function fmtNum(n) {
  return n == null ? '–' : Math.round(n).toLocaleString(locale());
}

export function fmtDec(n, digits = 1) {
  return n == null ? '–' : num(n, digits);
}

export function fmtCtx(n) {
  if (!n) return '';
  return n >= 1024 ? `${Math.round(n / 1024)}K` : String(n);
}

export function fmtDuration(ms) {
  if (ms == null) return '–';
  if (ms < 1000) return t('{n} ms', { n: Math.round(ms) });
  if (ms < 60000) return t('{n} s', { n: num(ms / 1000, 1) });
  const m = Math.floor(ms / 60000);
  return t('{m} min {s} s', { m, s: Math.round((ms % 60000) / 1000) });
}

export function copyText(text) {
  const done = () => toast(t('Copied'));
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text).then(done, () => fallbackCopy(text, done));
  fallbackCopy(text, done);
}

function fallbackCopy(text, done) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  try {
    document.execCommand('copy');
    done();
  } catch {}
  ta.remove();
}

export function modelLabel(m) {
  if (!m) return '';
  return `${m.name}${m.quant ? ` ${m.quant}` : ''}`;
}

// Saves a file the page made (a chat, a table, a picture) to the Downloads folder.
export function saveFile(name, data, type) {
  const a = document.createElement('a');
  a.href = typeof data === 'string' && data.startsWith('/') ? data : URL.createObjectURL(data instanceof Blob ? data : new Blob([data], { type }));
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  if (a.href.startsWith('blob:')) setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

export function readPref(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v == null ? fallback : JSON.parse(v);
  } catch {
    return fallback;
  }
}

export function writePref(key, v) {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {}
}
