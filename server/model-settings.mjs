// Settings that belong to one model (context, drafting, how much of the computer it may take, pictures, context
// memory, low-memory mode, extra engine options), the last speed test, and named sets of settings to reuse.
import os from 'node:os';
import path from 'node:path';
import { DIRS, getSettings } from './settings.mjs';
import { readJson, writeJson, uid } from './util.mjs';
import { FIT_MARGIN } from './plan.mjs';
import { t } from './i18n.mjs';

const FILE = path.join(DIRS.data, 'model-settings.json');
const PRESETS = path.join(DIRS.data, 'presets.json');

export const MODEL_DEFAULTS = {
  ctx: 0, // 0 = the general setting (Settings → Context size)
  drafting: 'auto', // auto = what measured fastest for the model; mtp = its MTP draft; ngram = guesses from the text; off
  computer: 'full', // full = all the speed; leave20 = leave a fifth of the processor and GPU memory for other work
  vision: true, // read pictures, when the model has an image helper (and images are on in Settings)
  visionOn: 'auto', // auto = the image helper runs on the GPU; cpu = on the processor, to save GPU memory
  kv: 'auto', // context memory: auto (INT8 from 64K up), f16, q8_0 (INT8), q4_0 (INT4)
  lowRam: 'auto', // auto = Hearth's memory plan; ssd = experts stay in the file, a small GPU cache (MoE models)
  args: '', // extra llama-server options for this model only
  engine: 'llama', // llama = llama.cpp; colibri = Colibri, for big mixture-of-experts models (colibri.mjs; experimental)
};

const CHOICES = {
  ctx: [0, 4096, 8192, 16384, 32768, 65536, 131072, 262144],
  drafting: ['auto', 'mtp', 'ngram', 'off'],
  computer: ['full', 'leave20'],
  visionOn: ['auto', 'cpu'],
  kv: ['auto', 'f16', 'q8_0', 'q4_0'],
  lowRam: ['auto', 'ssd'],
  engine: ['llama', 'colibri'],
};

function all() {
  return readJson(FILE, {});
}

export function cleanModelSettings(patch = {}) {
  const out = {};
  for (const [k, v] of Object.entries(patch || {})) {
    if (!(k in MODEL_DEFAULTS)) continue;
    if (CHOICES[k]) {
      const val = k === 'ctx' ? Number(v) : v;
      if (CHOICES[k].includes(val)) out[k] = val;
    } else if (k === 'vision') out.vision = Boolean(v);
    else if (k === 'args') out.args = String(v || '').trim().slice(0, 2000);
  }
  return out;
}

export function getModelSettings(id) {
  const rec = all()[id] || {};
  return { ...MODEL_DEFAULTS, ...cleanModelSettings(rec), lastTest: rec.lastTest || null, tests: rec.tests || {} };
}

export function setModelSettings(id, patch) {
  if (!/^[\w-]{4,64}$/.test(String(id || ''))) throw Object.assign(new Error(t('Model not found')), { status: 404 });
  const a = all();
  a[id] = { ...(a[id] || {}), ...cleanModelSettings(patch) };
  writeJson(FILE, a);
  return getModelSettings(id);
}

// The last test, and the last one with each engine (to compare llama.cpp and Colibri on this computer).
export function recordSpeedTest(id, result) {
  const a = all();
  const engine = result.engine || 'llama';
  a[id] = { ...(a[id] || {}), lastTest: result, tests: { ...(a[id]?.tests || {}), [engine]: result } };
  writeJson(FILE, a);
}

// How many processor threads "leave 20% for my work" lets the engine use: four fifths of the fast cores.
export function workThreads(hw) {
  const fast = hw.perfCores || Math.max(1, Math.round((hw.threads || os.cpus().length) / (process.platform === 'darwin' ? 1 : 2)));
  return Math.max(1, Math.floor(fast * 0.8));
}

/**
 * What the engine and the memory plan use for one model: its own settings on top of the general ones.
 * Returns { ctx, kv, vision, visionCpu, margin, lowRam, drafting, threads, args }.
 */
export function effectiveOptions(model, hw, ms = getModelSettings(model.id)) {
  const s = getSettings();
  const want = ms.ctx || s.contextSize;
  const ctx = model.ctxTrain ? Math.min(want, model.ctxTrain) : want;
  const kv = ms.kv === 'auto' ? (ctx >= 65536 ? 'q8_0' : 'f16') : ms.kv;
  const vision = Boolean(s.vision && ms.vision && model.mmproj);
  const leave = ms.computer === 'leave20';
  const budget = hw.gpuBudget || (hw.unified ? hw.ram * 0.66 : 0);
  return {
    ctx,
    kv,
    vision,
    visionCpu: vision && ms.visionOn === 'cpu',
    margin: leave ? Math.max(FIT_MARGIN, budget * 0.2) : FIT_MARGIN,
    lowRam: ms.lowRam === 'ssd' && Boolean(model.moe),
    drafting: s.speculative === 'off' ? 'off' : ms.drafting,
    draft: (model.drafts || [])[0] || null, // the MTP draft made for this model, smallest first
    threads: leave ? workThreads(hw) : 0,
    args: ms.args || '',
  };
}

// ---- Saved settings: named sets that can be applied to any model ----

export function listPresets() {
  return readJson(PRESETS, { presets: [] }).presets;
}

export function savePreset(name, settings) {
  const n = String(name || '').trim().slice(0, 60);
  if (!n) throw Object.assign(new Error(t('Give the settings a name.')), { status: 400 });
  const list = listPresets().filter((p) => p.name.toLowerCase() !== n.toLowerCase());
  const p = { id: uid(8), name: n, settings: cleanModelSettings(settings), at: Date.now() };
  list.push(p);
  writeJson(PRESETS, { presets: list.slice(-50) });
  return p;
}

export function deletePreset(id) {
  writeJson(PRESETS, { presets: listPresets().filter((p) => p.id !== id) });
}

