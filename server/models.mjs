// Finds GGUF models already on this computer: Hearth's own folder, LM Studio, Ollama and the Hugging Face cache.
// Nothing is copied: a model is loaded from wherever it already is.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getSettings, modelsDir } from './settings.mjs';
import { readGgufMeta, readGgufLayout, isGguf } from './gguf.mjs';
import { hash, exists } from './util.mjs';

const QUANT_RE = /(?:^|[-_.])((?:UD-)?(?:I?Q\d(?:_[A-Z0-9]+)*|MXFP4(?:_MOE)?|NVFP4|BF16|F16|F32))(?=$|[-_.])/i;

export function quantOf(file) {
  const base = path.basename(file).replace(/\.gguf$/i, '').replace(/-\d{5}-of-\d{5}$/, '');
  const m = base.match(new RegExp(QUANT_RE.source, 'gi'));
  if (!m) return '';
  return m[m.length - 1].replace(/^[-_.]/, '').toUpperCase().replace(/^UD-/, 'UD-');
}

const isSplitRest = (f) => /-(\d{5})-of-\d{5}\.gguf$/i.test(f) && !/-00001-of-\d{5}\.gguf$/i.test(f);
const isProjectorName = (f) => /mmproj|projector|clip/i.test(path.basename(f));

// Walk a folder for .gguf files (a few levels deep, skipping hidden folders and partial downloads).
function walk(dir, depth = 4, out = []) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory() && depth > 0) walk(p, depth - 1, out);
    else if ((e.isFile() || e.isSymbolicLink()) && /\.gguf$/i.test(e.name)) out.push(p);
  }
  return out;
}

const metaCache = new Map(); // path -> { mtime, meta, layout }

function meta(file) {
  let st;
  try {
    st = fs.statSync(file);
  } catch {
    return null;
  }
  const c = metaCache.get(file);
  if (c && c.mtime === st.mtimeMs) return c.meta;
  let m = null;
  try {
    m = readGgufMeta(file);
  } catch {}
  metaCache.set(file, { mtime: st.mtimeMs, meta: m });
  return m;
}

// Experts / lookup table / the rest, for the memory plan. Read once per file version.
function layoutOf(file) {
  const c = metaCache.get(file);
  if (!c) return null;
  if (c.layout === undefined) {
    try {
      c.layout = readGgufLayout(file);
    } catch {
      c.layout = null;
    }
  }
  return c.layout;
}

function totalSize(file) {
  // Split models: add up every part.
  const m = /-(\d{5})-of-(\d{5})\.gguf$/i.exec(file);
  if (!m) return fs.statSync(file).size;
  const n = Number(m[2]);
  let sum = 0;
  for (let i = 1; i <= n; i++) {
    const part = file.replace(/-\d{5}-of-(\d{5})\.gguf$/i, `-${String(i).padStart(5, '0')}-of-$1.gguf`);
    try {
      sum += fs.statSync(part).size;
    } catch {
      return 0; // a part is missing, so the model is incomplete
    }
  }
  return sum;
}

// Prefer F16 for the image helper (works on every engine build), then BF16, then whatever is there.
function bestProjector(list) {
  const rank = (f) => (/f16/i.test(f) && !/bf16/i.test(f) ? 0 : /bf16/i.test(f) ? 1 : /q8/i.test(f) ? 2 : 3);
  return [...list].sort((a, b) => rank(a) - rank(b))[0] || '';
}

function prettyName(file, source, m) {
  const parent = path.basename(path.dirname(file));
  let name = path.basename(file).replace(/\.gguf$/i, '').replace(/-\d{5}-of-\d{5}$/, '');
  // Folders like "gemma-4-12B-it-QAT-GGUF" are usually the cleanest name.
  if (/gguf$/i.test(parent)) name = parent.replace(/[-_]?gguf$/i, '');
  else if (/^(UD-)?(I?Q\d|BF16|F16)/i.test(parent)) name = path.basename(path.dirname(path.dirname(file))).replace(/[-_]?gguf$/i, '');
  const q = quantOf(file);
  if (q) name = name.replace(new RegExp(`[-_.]${q.replace(/[-]/g, '\\-')}$`, 'i'), '');
  return name.replace(/^models--[^-]+--/, '') || m?.name || 'Model';
}

function entry(file, source, extra = {}) {
  const m = meta(file);
  if (!m || m.isProjector || m.splitNo > 0) return null;
  const size = totalSize(file);
  if (!size) return null;
  const embedding = /bert|embed/i.test(m.arch) || (!m.hasChatTemplate && /embed/i.test(file));
  // An MTP draft has only its extra layer (a few dozen tensors); it helps a main model, it doesn't chat.
  const draft = m.nextn > 0 && m.tensors < 300;
  const layout = embedding || draft ? null : layoutOf(file);
  return {
    id: hash(file),
    path: file,
    name: extra.name || prettyName(file, source, m),
    quant: extra.quant || quantOf(file),
    size,
    source,
    arch: m.arch,
    ctxTrain: m.ctxTrain,
    layers: m.layers,
    experts: m.experts,
    moe: m.experts > 1,
    sizeLabel: m.sizeLabel,
    kind: embedding ? 'embedding' : draft ? 'draft' : 'chat',
    nextn: m.nextn,
    nextnShared: m.nextnShared,
    hasTemplate: m.hasChatTemplate,
    mmproj: '',
    layout,
    // What the memory plan needs to size the context.
    meta: { layers: m.layers, headKv: m.headKv, heads: m.heads, keyLength: m.keyLength, valueLength: m.valueLength, fullAttentionInterval: m.fullAttentionInterval, slidingWindow: m.slidingWindow, embedding: m.embedding },
    ...extra,
  };
}

function scanFolder(root, source, depth = 4) {
  const files = walk(root, depth).filter((f) => !isSplitRest(f));
  const projectors = files.filter(isProjectorName);
  const out = [];
  for (const f of files) {
    if (isProjectorName(f)) continue;
    const e = entry(f, source);
    if (!e) continue;
    // The image helper sits next to the model, or one folder up (big quants live in their own subfolder).
    const near = projectors.filter((p) => path.dirname(p) === path.dirname(f));
    const up = projectors.filter((p) => path.dirname(p) === path.dirname(path.dirname(f)));
    e.mmproj = bestProjector(near.length ? near : up);
    e.mmprojSize = e.mmproj ? fs.statSync(e.mmproj).size : 0;
    out.push(e);
  }
  return out;
}

function scanOllama() {
  const base = process.env.OLLAMA_MODELS || path.join(os.homedir(), '.ollama', 'models');
  const manifests = path.join(base, 'manifests');
  const out = [];
  for (const file of walkAll(manifests)) {
    let j;
    try {
      j = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      continue;
    }
    const layer = (j.layers || []).find((l) => l.mediaType === 'application/vnd.ollama.image.model');
    if (!layer) continue;
    const blob = path.join(base, 'blobs', layer.digest.replace(':', '-'));
    if (!isGguf(blob)) continue; // newer Ollama formats (e.g. MLX) can't be loaded by llama.cpp
    const proj = (j.layers || []).find((l) => l.mediaType === 'application/vnd.ollama.image.projector');
    const rel = path.relative(manifests, file).split(path.sep);
    const tag = rel.pop();
    const name = `${rel[rel.length - 1]}:${tag}`;
    const e = entry(blob, 'ollama', { name, quant: '' });
    if (!e) continue;
    if (proj) {
      e.mmproj = path.join(base, 'blobs', proj.digest.replace(':', '-'));
      e.mmprojSize = proj.size || 0;
    }
    // Ollama keeps the chat template outside the file; without one the answers can be odd.
    e.note = e.hasTemplate ? '' : 'Ollama keeps this model’s chat format separately, so answers may look odd.';
    out.push(e);
  }
  return out;
}

function walkAll(dir, out = []) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkAll(p, out);
    else out.push(p);
  }
  return out;
}

export function scanSources() {
  const s = getSettings();
  const home = os.homedir();
  const src = [{ dir: modelsDir(), source: 'hearth' }];
  if (s.scanLmStudio) {
    src.push({ dir: path.join(home, '.lmstudio', 'models'), source: 'lmstudio' });
    src.push({ dir: path.join(home, '.cache', 'lm-studio', 'models'), source: 'lmstudio' });
  }
  if (s.scanHfCache) src.push({ dir: process.env.HF_HUB_CACHE || path.join(home, '.cache', 'huggingface', 'hub'), source: 'huggingface', depth: 6 });
  for (const d of s.extraModelDirs || []) src.push({ dir: d, source: 'folder' });
  return src;
}

let lastScan = { at: 0, list: [] };

export function listLocalModels(force = false) {
  if (!force && Date.now() - lastScan.at < 3000) return lastScan.list;
  const seen = new Set();
  const list = [];
  const add = (e) => {
    let real = e.path;
    try {
      real = fs.realpathSync(e.path);
    } catch {}
    if (seen.has(real)) return;
    seen.add(real);
    list.push(e);
  };
  for (const { dir, source, depth } of scanSources()) {
    for (const e of scanFolder(dir, source, depth)) {
      // Hearth's downloads live in <models>/<owner>/<repo>/..., which tells us where they came from.
      if (source === 'hearth') {
        const segs = path.relative(dir, e.path).split(path.sep);
        if (segs.length >= 3) e.repo = `${segs[0]}/${segs[1]}`;
      }
      add(e);
    }
  }
  if (getSettings().scanOllama) for (const e of scanOllama()) add(e);
  // Each MTP draft goes with the models it was made for: same architecture, width and number of layers.
  const drafts = list.filter((d) => d.kind === 'draft');
  for (const m of list) {
    if (m.kind !== 'chat') continue;
    m.drafts = drafts
      .filter((d) => d.arch === m.arch && d.meta.embedding === m.meta.embedding && d.layers - d.nextn === m.layers)
      // Self-contained drafts first: "shared" ones borrow tables from the main model, which not every engine can do.
      .sort((a, b) => Number(a.nextnShared) - Number(b.nextnShared) || a.size - b.size)
      .map((d) => ({ id: d.id, path: d.path, size: d.size, shared: d.nextnShared, name: path.basename(d.path) }));
  }
  list.sort((a, b) => (a.source === 'hearth' ? -1 : 0) - (b.source === 'hearth' ? -1 : 0) || a.name.localeCompare(b.name));
  lastScan = { at: Date.now(), list };
  return list;
}

export function findLocalModel(id) {
  return listLocalModels().find((m) => m.id === id) || listLocalModels(true).find((m) => m.id === id);
}

export const SOURCE_LABELS = {
  hearth: 'Hearth',
  lmstudio: 'LM Studio',
  ollama: 'Ollama',
  huggingface: 'Hugging Face cache',
  folder: 'Your folder',
};

// Puts a shared file in place as the last part of one size: llama.cpp opens every part from the model's folder.
// A hard link takes no extra space and needs no special rights (Windows allows symbolic links only to admins or in
// developer mode); a drive that can't link (e.g. exFAT) gets the file moved there instead.
export function linkShared(from, as) {
  if (exists(as)) return 'there';
  fs.mkdirSync(path.dirname(as), { recursive: true });
  try {
    fs.linkSync(from, as);
    return 'link';
  } catch {}
  try {
    fs.symlinkSync(from, as);
    return 'symlink';
  } catch {}
  fs.renameSync(from, as);
  return 'moved';
}
