// Artifacts: the pages, apps and pictures the model makes in a chat (an HTML or SVG answer), and the designs made on
// the Design page. Each keeps its versions, can be found by its words, opened on its own, downloaded and deleted.
// They are only ever shown sandboxed: the page that shows one gets no origin of its own, so what the model wrote can't
// reach Hearth (its settings, chats or connectors), even when opened in a window of its own.
// The brand kit (name, colours, fonts, logo) lives here too: designs (and bots) use it.
import fs from 'node:fs';
import path from 'node:path';
import { DIRS } from './settings.mjs';
import { readJson, writeJson, uid } from './util.mjs';
import { t } from './i18n.mjs';
import { imagePath } from './images.mjs';

const MAX_VERSIONS = 30;
const MAX_CODE = 4 << 20;
const KINDS = ['html', 'svg', 'design'];
const BRAND_FILE = path.join(DIRS.data, 'brand.json');
const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml' };

const safeId = (id) => /^[\w-]{4,40}$/.test(String(id || ''));
const dirOf = (id) => path.join(DIRS.artifacts, id);
const metaFile = (id) => path.join(dirOf(id), 'meta.json');
const codeFile = (id, kind, n) => path.join(dirOf(id), `v${n}.${kind === 'svg' ? 'svg' : 'html'}`);
const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });

// The words of a page, for search: no tags, scripts or styles.
export function textOf(code = '') {
  return String(code)
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 20000);
}

// The title a page gives itself (<title> or its first heading).
export function titleOf(code = '') {
  const m = /<title[^>]*>([^<]{1,120})<\/title>/i.exec(code) || /<h1[^>]*>([\s\S]{1,200}?)<\/h1>/i.exec(code);
  return m ? textOf(m[1]).slice(0, 100) : '';
}

let index = null; // id → { meta, text }

function loadIndex() {
  if (index) return index;
  index = new Map();
  let names = [];
  try {
    names = fs.readdirSync(DIRS.artifacts);
  } catch {}
  for (const id of names) {
    const meta = readJson(metaFile(id), null);
    if (!meta?.id) continue;
    let code = '';
    try {
      code = fs.readFileSync(codeFile(id, meta.kind, meta.version), 'utf8');
    } catch {}
    index.set(id, { meta, text: textOf(code) });
  }
  return index;
}

const summary = (m) => ({ id: m.id, title: m.title, kind: m.kind, source: m.source, chatId: m.chatId || '', format: m.format || null, version: m.version, versions: m.versions, size: m.size, createdAt: m.createdAt, updatedAt: m.updatedAt });

export function listArtifacts({ q = '', kind = '' } = {}) {
  const idx = loadIndex();
  let list = [...idx.values()];
  if (KINDS.includes(kind)) list = list.filter((x) => x.meta.kind === kind);
  const words = String(q).toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length) list = list.filter((x) => words.every((w) => `${x.meta.title} ${x.text}`.toLowerCase().includes(w)));
  return list.map((x) => summary(x.meta)).sort((a, b) => b.updatedAt - a.updatedAt);
}

export function getArtifact(id, version = 0) {
  if (!safeId(id)) return null;
  const meta = readJson(metaFile(id), null);
  if (!meta) return null;
  const n = version && meta.versions.includes(Number(version)) ? Number(version) : meta.version;
  let code = '';
  try {
    code = fs.readFileSync(codeFile(id, meta.kind, n), 'utf8');
  } catch {}
  return { ...meta, shown: n, code };
}

function writeMeta(meta) {
  meta.updatedAt = Date.now();
  writeJson(metaFile(meta.id), meta);
  loadIndex().set(meta.id, { meta, text: index.get(meta.id)?.text || '' });
}

function addVersion(meta, code) {
  const n = (meta.versions.at(-1) || 0) + 1;
  fs.writeFileSync(codeFile(meta.id, meta.kind, n), code);
  meta.versions.push(n);
  meta.version = n;
  meta.size = Buffer.byteLength(code);
  while (meta.versions.length > MAX_VERSIONS) fs.rmSync(codeFile(meta.id, meta.kind, meta.versions.shift()), { force: true });
  loadIndex().set(meta.id, { meta, text: textOf(code) });
}

const cleanFormat = (f) => (f && Number(f.w) > 0 && Number(f.h) > 0 ? { id: String(f.id || 'custom').slice(0, 40), name: String(f.name || '').slice(0, 80), w: Math.min(8000, Math.round(Number(f.w))), h: Math.min(8000, Math.round(Number(f.h))), scale: Math.min(6, Math.max(1, Number(f.scale) || 1)), transparent: Boolean(f.transparent) } : null);
const cleanImages = (list) => (Array.isArray(list) ? list.filter((u) => /^\/(uploads|images)\/[\w.-]+$/.test(u)).slice(0, 8) : []);

// A new artifact, or a new version of one: by its id, or the same block of the same chat answer.
export function saveArtifact(body = {}) {
  const code = String(body.code ?? '');
  if (!code.trim()) throw bad(t('There is nothing to save.'));
  if (Buffer.byteLength(code) > MAX_CODE) throw bad(t('That is too big to keep as an artifact (at most 4 MB).'));
  const idx = loadIndex();
  let meta = body.id ? (safeId(body.id) ? readJson(metaFile(body.id), null) : null) : null;
  if (body.id && !meta) throw bad(t('Not found'), 404);
  if (!meta && body.chatId && body.messageId) {
    const same = [...idx.values()].find((x) => x.meta.chatId === body.chatId && x.meta.messageId === body.messageId && (x.meta.block ?? 0) === (Number(body.block) || 0));
    if (same) meta = readJson(metaFile(same.meta.id), null);
  }
  const kind = meta?.kind || (KINDS.includes(body.kind) ? body.kind : /^\s*<svg/i.test(code) ? 'svg' : 'html');
  if (!meta) {
    const id = uid(10);
    fs.mkdirSync(dirOf(id), { recursive: true });
    meta = {
      id,
      title: String(body.title || '').trim().slice(0, 120) || titleOf(code) || String(body.fallbackTitle || '').trim().slice(0, 120) || t('Untitled'),
      kind,
      source: ['chat', 'create', 'design'].includes(body.source) ? body.source : 'chat',
      chatId: String(body.chatId || '').slice(0, 40),
      messageId: String(body.messageId || '').slice(0, 40),
      block: Number(body.block) || 0,
      format: cleanFormat(body.format),
      images: cleanImages(body.images),
      brand: Boolean(body.brand),
      prompts: [],
      versions: [],
      version: 0,
      size: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
  }
  const current = meta.version ? fs.existsSync(codeFile(meta.id, meta.kind, meta.version)) && fs.readFileSync(codeFile(meta.id, meta.kind, meta.version), 'utf8') : null;
  if (current !== code) addVersion(meta, code);
  if (body.prompt) meta.prompts = [...(meta.prompts || []), { text: String(body.prompt).slice(0, 2000), version: meta.version, at: Date.now() }].slice(-60);
  writeMeta(meta);
  return getArtifact(meta.id);
}

export function updateArtifact(id, body = {}) {
  const meta = safeId(id) ? readJson(metaFile(id), null) : null;
  if (!meta) throw bad(t('Not found'), 404);
  if ('title' in body) meta.title = String(body.title || '').trim().slice(0, 120) || meta.title;
  if ('format' in body) meta.format = cleanFormat(body.format) || meta.format;
  if ('images' in body) meta.images = cleanImages(body.images);
  if ('brand' in body) meta.brand = Boolean(body.brand);
  // Going back to an earlier version makes it the current one again (as a new version, so nothing is lost).
  if (body.restore && meta.versions.includes(Number(body.restore))) {
    const code = fs.readFileSync(codeFile(id, meta.kind, Number(body.restore)), 'utf8');
    addVersion(meta, code);
  }
  writeMeta(meta);
  return getArtifact(id);
}

export function deleteArtifact(id) {
  if (!safeId(id)) return false;
  fs.rmSync(dirOf(id), { recursive: true, force: true });
  loadIndex().delete(id);
  return true;
}

// ---- Showing one ----

// Pictures a design uses ({{image:1}}…): their address, or the picture itself (for saving as PNG, which needs it inside).
function withImages(code, images = [], inline = false) {
  return code.replace(/\{\{\s*image:(\d+)\s*\}\}/g, (m, n) => {
    const url = images[Number(n) - 1];
    if (!url) return '';
    if (!inline) return url;
    const file = url.startsWith('/images/') ? imagePath(url.slice(8)) : path.join(DIRS.uploads, path.basename(url));
    try {
      return `data:${MIME[path.extname(file).toLowerCase()] || 'image/png'};base64,${fs.readFileSync(file).toString('base64')}`;
    } catch {
      return '';
    }
  });
}

// The page to show: a whole HTML document (a picture or a bare fragment gets one around it). A design's pictures go
// inside it: browsers don't let a sandboxed page load anything from Hearth's own (local) address.
export function artifactDoc(a) {
  let code = a.kind === 'design' ? withImages(a.code, a.images, true) : a.code;
  if (a.kind === 'svg') return `<!doctype html><html><head><meta charset="utf-8"><title>${a.title.replace(/</g, '&lt;')}</title></head><body style="margin:0;display:grid;place-items:center;min-height:100vh;background:#fff">${code}</body></html>`;
  if (!/<html[\s>]/i.test(code)) code = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body>${code}</body></html>`;
  return code;
}

// Served with this, an artifact is sandboxed even when opened in a tab of its own.
export const SANDBOX_HEADERS = {
  'content-security-policy': 'sandbox allow-scripts allow-forms allow-modals allow-popups allow-pointer-lock allow-downloads',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
};

// ---- Brand kit ----

const COLOR = /^#[0-9a-f]{6}$/i;
export function getBrand() {
  return { name: '', slogan: '', colors: [], headingFont: '', bodyFont: '', logo: '', notes: '', ...readJson(BRAND_FILE, {}) };
}

export function saveBrand(b = {}) {
  const out = {
    name: String(b.name || '').trim().slice(0, 80),
    slogan: String(b.slogan || '').trim().slice(0, 160),
    colors: (Array.isArray(b.colors) ? b.colors : []).map(String).filter((c) => COLOR.test(c)).slice(0, 8),
    headingFont: String(b.headingFont || '').trim().slice(0, 60),
    bodyFont: String(b.bodyFont || '').trim().slice(0, 60),
    logo: /^\/(uploads|images)\/[\w.-]+$/.test(String(b.logo || '')) ? b.logo : '',
    notes: String(b.notes || '').trim().slice(0, 1500),
  };
  writeJson(BRAND_FILE, out);
  return out;
}
