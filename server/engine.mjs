// Starts and stops the engine (llama-server, or Colibri for a model set to it: colibri.mjs) for each loaded model,
// and keeps the engines' log.
// Each engine listens only on 127.0.0.1 on a private port; apps talk to Hearth's own API, which forwards.
// Normally one model runs at a time; with "Run several models" on, loading another keeps the others, and requests
// go to the model they name (the last one loaded is the default for the chat and for apps that don't say).
// The list of runs changes at once, before any waiting, so calls that overlap (two clicks, a speed test right after
// "Reload", two apps asking at the same moment) can never leave a second copy of a model running.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { DIRS, getSettings, updateSettings } from './settings.mjs';
import { listEngines, engineKnowsArch } from './engine-install.mjs';
import { planModel } from './plan.mjs';
import { detectHardware, readEngineDevices, listEngineDevices, queryEngineDevices, realCards, BACKEND_LABELS } from './hardware.mjs';
import { findFreePort, sleep, run as runCmd, uid, IS_WIN, GB } from './util.mjs';
import { t } from './i18n.mjs';
import { speculativeArgs, engineHelp } from './speed.mjs';
import { getModelSettings, effectiveOptions } from './model-settings.mjs';
import { importModel, serveCommand, adaptBody } from './colibri.mjs';

const LOG_MAX = 1500;
const PID_FILE = path.join(DIRS.data, 'engine.pid'); // one line per running engine

const runs = new Map(); // model id → the run on the list: { model, sig, state, child, exited, key, planInput, starting, cancelled }
const alive = new Set(); // every run whose engine process is still running, on the list or on its way out
let primary = '';
const logs = [];

// fallbacks: the model's combined steps this engine type can't run, so llama.cpp runs them a slower way.
// engineNote: { skipped, used, why } when the chosen engine type couldn't see the graphics card and another was used.
const emptyState = () => ({ status: 'stopped', model: null, engine: null, port: 0, pid: 0, ctx: 0, parallel: 1, vision: false, startedAt: 0, readyAt: 0, error: '', speculative: '', options: null, fallbacks: [], engineNote: null, gpuBusy: null });

// The plan's numbers are kept; its words are made per request, in the language of the page that asks.
function publicState(r) {
  if (!r) return emptyState();
  let plan = null;
  if (r.planInput && r.state.status !== 'stopped') {
    const p = planModel(r.planInput.hw, r.planInput.model, r.planInput.opts);
    plan = { mode: p.mode, level: p.level, label: p.label, detail: p.detail, need: p.need, ssd: p.ssd, cpuMoeLayers: p.cpuMoeLayers };
  }
  return { ...r.state, plan };
}

export function engineState() {
  return {
    ...publicState(runs.get(primary)),
    primary,
    loaded: [...runs.values()].map((r) => ({ ...publicState(r), primary: r.model.id === primary })),
    logTail: logs.slice(-6).map((l) => l.text),
  };
}

export function engineLogs(n = 300) {
  return logs.slice(-n);
}

// llama-server lets any website call it from the user's browser (it allows all origins), so each engine gets a
// private key that only Hearth knows. Apps and the browser talk to Hearth, which checks them and forwards.
export function engineHeaders(extra = {}) {
  const r = runs.get(primary);
  return r?.key ? { authorization: `Bearer ${r.key}`, ...extra } : extra;
}

export function engineUrl() {
  const r = runs.get(primary);
  return r?.state.status === 'ready' ? `http://127.0.0.1:${r.state.port}` : '';
}

// The engine for a request: the model it names (by its alias or id) if that one is loaded, else the default.
export async function resolveEngine(name) {
  for (let tries = 0; tries < 3; tries++) {
    let r = name ? [...runs.values()].find((x) => modelAlias(x.model) === name || x.model.id === name) : null;
    if (!r) r = runs.get(primary);
    if (r?.state.status === 'starting') {
      await r.starting;
      if (r.cancelled) continue; // replaced while loading (new settings): look again
    }
    if (r?.state.status !== 'ready') return null;
    const colibri = r.kind === 'colibri';
    // adapt(body): a request in llama.cpp's dialect, in this engine's.
    return { id: r.model.id, url: `http://127.0.0.1:${r.state.port}`, headers: (extra = {}) => ({ authorization: `Bearer ${r.key}`, ...extra }), state: r.state, kind: colibri ? 'colibri' : 'llama', adapt: colibri ? (b) => adaptBody(b, modelAlias(r.model)) : (b) => b };
  }
  return null;
}

export function setPrimary(id) {
  if (runs.has(id)) primary = id;
  return engineState();
}

// While loading, llama.cpp checks which of a model's combined steps the GPU's engine type can run, and says so:
// "resolve_fused_ops: fused top-k mask not supported, set to disabled". Those steps then run as several smaller
// ones, which is slower (the Vulkan build lacks some that the ROCm and CUDA builds have).
const FALLBACK_RE = /resolve_fused_ops: (.+?) not supported, set to disabled/;

function log(text, stream = 'out', r = null) {
  const prefix = r && runs.size > 1 ? `[${r.model.name}] ` : '';
  for (const line of String(text).split(/\r?\n/)) {
    if (!line.trim()) continue;
    const fb = r && FALLBACK_RE.exec(line);
    if (fb && !r.state.fallbacks.includes(fb[1])) r.state.fallbacks.push(fb[1]);
    logs.push({ t: Date.now(), stream, src: r?.model.id || '', text: `${prefix}${line}`.slice(0, 2000) });
  }
  if (logs.length > LOG_MAX) logs.splice(0, logs.length - LOG_MAX);
}

export function modelAlias(model) {
  const base = `${model.name}${model.quant ? `-${model.quant}` : ''}`;
  return base.toLowerCase().replace(/[^a-z0-9.:_-]+/g, '-').replace(/^-+|-+$/g, '') || 'local-model';
}

// Split extra arguments like a shell would, keeping "quoted parts" together.
function splitArgs(s = '') {
  return (s.match(/"[^"]*"|'[^']*'|\S+/g) || []).map((a) => a.replace(/^["']|["']$/g, ''));
}

// Options an older engine doesn't know are left out (with their value), so it still starts.
function supportedOnly(args, help) {
  if (!help) return args;
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('-')) {
      const known = new RegExp(`(^|[\\s,])${a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([\\s,=]|$)`, 'm').test(help);
      if (!known) {
        if (args[i + 1] !== undefined && !args[i + 1].startsWith('-')) i++;
        continue;
      }
    }
    out.push(a);
  }
  return out;
}

async function chooseEngine(model) {
  const list = await listEngines();
  if (!list.length) return null;
  const s = getSettings();
  if (s.enginePath) return list.find((e) => e.path === s.enginePath) || list[0];
  const hw = await detectHardware();
  const want = s.engineBackend || hw.backend;
  // A downloaded build of the chosen type first, then the newest one, but only builds that know the model.
  const order = [...new Set([...list.filter((e) => e.source === 'downloaded' && e.backend === want), ...list])];
  const knows = order.filter((e) => engineKnowsArch(e.path, model?.arch));
  if (!knows.length) return { ...order[0], tooOld: true };
  const picked = await pickSeeingEngine(knows, hw, want, listEngineDevices);
  // AMD's ROCm builds are made without the processor's fast instructions (AVX2 and the like: llama.cpp turns them off
  // in builds made the way AMD makes them), so a model that doesn't fit on the graphics card, whose experts partly
  // run on the processor, gets very slow with them. Such a model runs with Vulkan; models that fit use AMD ROCm.
  if (picked.from === 'amd' && !hw.unified) {
    const o = effectiveOptions(model, hw, getModelSettings(model.id));
    const plan = planModel(hw, model, { ctx: o.ctx, vision: o.vision, kv: o.kv, visionCpu: o.visionCpu, margin: o.margin, lowRam: o.lowRam, othersNeed: othersNeed(model.id) });
    if (plan.mode !== 'gpu') {
      const vulkan = await pickVulkan(knows, listEngineDevices);
      if (vulkan) return { ...vulkan, note: { skipped: 'rocm', used: 'vulkan', why: '', reason: 'cpu-part' } };
    }
  }
  return picked;
}

// A Vulkan engine that sees the graphics card, if one is downloaded.
export async function pickVulkan(list, devicesOf) {
  for (const e of list) {
    if (e.backend !== 'vulkan') continue;
    const seen = await devicesOf(e.path);
    if (!seen || seen.devices.length) return e;
  }
  return null;
}

/**
 * On a PC with a graphics card, an engine that can't see the card would run the whole model on the processor,
 * which looks like a model that doesn't answer (e.g. the AMD ROCm build when the AMD driver is too old for it).
 * So the first engine in `order` that sees a card is used, and `note` says which type was passed over and why.
 * devicesOf(path) resolves { devices, note }, or null when not known (then the engine is trusted).
 */
export async function pickSeeingEngine(order, hw, want, devicesOf) {
  const hasCard = !hw.unified && (hw.gpus || []).some((g) => g.vram >= 2 * GB);
  if (!hasCard || want === 'cpu') return order[0];
  let passed = null;
  for (const e of order) {
    if (e.backend === 'cpu') continue;
    const seen = await devicesOf(e.path);
    if (seen && !seen.devices.length) {
      passed ||= { backend: e.backend, why: seen.note };
      continue;
    }
    // Another build of the same type (an old download) passed over: nothing to tell.
    return passed && passed.backend !== e.backend ? { ...e, note: { skipped: passed.backend, used: e.backend, why: passed.why } } : e;
  }
  return order[0]; // nothing sees the card: the engine's log says why
}

// GPU memory the other loaded models take, so a new one leaves room for them.
function othersNeed(exceptId) {
  let sum = 0;
  for (const r of runs.values()) {
    if (r.model.id === exceptId || !r.planInput || (r.state.status !== 'ready' && r.state.status !== 'starting')) continue;
    sum += planModel(r.planInput.hw, r.planInput.model, r.planInput.opts).need;
  }
  return sum;
}

function savePids() {
  try {
    const pids = [...alive].filter((r) => r.child?.pid).map((r) => `${r.child.pid}${r.kind === 'colibri' ? ' colibri' : ''}`);
    if (pids.length) fs.writeFileSync(PID_FILE, pids.join('\n'));
    else fs.rmSync(PID_FILE, { force: true });
  } catch {}
}

// Everything a load depends on. A model that is already loading with the same settings isn't loaded twice.
function loadSignature(model) {
  const s = getSettings();
  const { lastTest, tests, ...ms } = getModelSettings(model.id);
  return JSON.stringify([model.path, model.mmproj || '', ms, s.contextSize, s.vision, s.speculative, s.engineArgs, s.parallel, s.enginePath, s.engineBackend]);
}

// True when the model runs (or is loading) with the settings saved for it now.
export function loadedWithSettings(model) {
  const r = runs.get(model.id);
  return Boolean(r && !r.cancelled && r.sig === loadSignature(model) && (r.state.status === 'ready' || r.state.status === 'starting'));
}

/**
 * Loads a model with its own settings. Unless several models may run at once, the others stop first.
 * Resolves with the engine state once the model is ready (or failed).
 */
export async function startEngine(model) {
  const sig = loadSignature(model);
  const cur = runs.get(model.id);
  if (cur && !cur.cancelled && cur.sig === sig && cur.state.status === 'starting') {
    primary = model.id; // already on its way with these settings: wait for it
    await cur.starting;
    return engineState();
  }
  // Take the ones that make room off the list right away (no waiting in between), then stop them.
  const leaving = getSettings().multiModel ? [cur].filter(Boolean) : [...runs.values()];
  for (const x of leaving) {
    x.cancelled = true;
    runs.delete(x.model.id);
  }
  const r = { model, sig, state: { ...emptyState(), status: 'starting', model, startedAt: Date.now() }, child: null, exited: null, key: uid(32), planInput: null, cancelled: false };
  runs.set(model.id, r);
  primary = model.id;
  r.starting = (async () => {
    // Engines on their way out leave the memory before the new one loads.
    const going = [...alive].filter((x) => x.cancelled && !leaving.includes(x)).map((x) => Promise.race([x.exited, sleep(15000)]));
    await Promise.all([...leaving.map(stopRun), ...going]);
    await launch(r);
  })().catch((err) => {
    if (!r.cancelled) Object.assign(r.state, { status: 'error', error: String(err.message || err) });
  });
  await r.starting;
  return engineState();
}

// Another program holding the graphics card's memory (Strata, a game, a second Hearth that loaded the model too)
// leaves this model less of the card, so it runs slower. The engine says what is free right before loading.
const gbText = (n) => `${(n / 1024 ** 3).toFixed(1)} GB`;
export async function gpuTakenByOthers(bin, hw, r, devicesNow = queryEngineDevices) {
  if (hw.unified || !(hw.gpus || []).some((g) => g.vram >= 2 * 1024 ** 3)) return null;
  if ([...alive].some((x) => x !== r && !x.cancelled)) return null; // Hearth's own other models use it
  const cards = realCards((await devicesNow(bin, 20000))?.devices || []);
  if (!cards.length) return null;
  const total = cards.reduce((s, d) => s + d.total, 0);
  const free = cards.reduce((s, d) => s + d.free, 0);
  const used = total - free;
  return used > Math.max(4 * 1024 ** 3, total * 0.2) ? { used, free, total } : null;
}

async function launch(r) {
  if (r.cancelled) return; // replaced before it began
  const { model } = r;
  const s = getSettings();
  log(`— Loading ${model.name} ${model.quant || ''} —`, 'hearth', r);
  if (getModelSettings(model.id).engine === 'colibri') return launchColibri(r);
  const engine = await chooseEngine(model);
  if (!engine) {
    Object.assign(r.state, { status: 'error', error: 'NO_ENGINE' });
    log('No engine found. Open Models → Engine to download one.', 'hearth', r);
    return;
  }
  const { note, ...used } = engine;
  r.state.engine = used;
  r.state.engineNote = note || null;
  if (note?.reason === 'cpu-part') log('Part of this model runs on the processor, where AMD’s ROCm build is slow (it is made without AVX2), so it runs with Vulkan.', 'hearth', r);
  else if (note) log(`${BACKEND_LABELS[note.skipped] || note.skipped} can't see the graphics card here${note.why ? ` (${note.why})` : ''}; using ${BACKEND_LABELS[note.used] || note.used} instead.`, 'hearth', r);
  await readEngineDevices(engine.path).catch(() => {}); // the real GPU memory, for the plan below
  const port = await findFreePort(7440 + Math.floor(Math.random() * 20));
  if (r.cancelled) return;
  const hw = await detectHardware();
  r.state.gpuBusy = await gpuTakenByOthers(engine.path, hw, r);
  if (r.state.gpuBusy) log(`Only ${gbText(r.state.gpuBusy.free)} of the graphics card's ${gbText(r.state.gpuBusy.total)} is free: another program uses ${gbText(r.state.gpuBusy.used)} (Strata, a game, or a second Hearth). This model gets less of the card and runs slower; close that program and load the model again.`, 'hearth', r);
  if (r.cancelled) return;
  const o = effectiveOptions(model, hw, getModelSettings(model.id));
  // Big models: which parts stay in memory and which are read from the SSD.
  // Guess-and-check decoding (see speed.mjs); the user's own engine options win.
  const extra = [...splitArgs(s.engineArgs), ...splitArgs(o.args)];
  const base = { ctx: o.ctx, vision: Boolean(o.vision && model.mmproj && fs.existsSync(model.mmproj)), kv: o.kv, visionCpu: o.visionCpu, margin: o.margin, lowRam: o.lowRam, othersNeed: othersNeed(model.id) };
  const draftFits = Boolean(o.draft) && planModel(hw, model, { ...base, draftBytes: o.draft.size }).mode === 'gpu';
  const spec = extra.includes('--spec-type') ? { args: [], mode: '', draftBytes: 0 } : await speculativeArgs(model, engine, o.drafting, o.draft, draftFits);
  const opts = { ...base, draftBytes: spec.draftBytes };
  const plan = planModel(hw, model, opts);
  r.planInput = { hw, model, opts };
  if (engine.tooOld) log(`Note: no engine here lists the "${model.arch}" architecture. If loading fails, update the engine in Models.`, 'hearth', r);
  if (plan.mode === 'split' || plan.mode === 'ssd-experts') log(`Big model mode: ${plan.detail}`, 'hearth', r);
  const help = await engineHelp(engine.path);
  const args = ['-m', model.path, '--host', '127.0.0.1', '--port', String(port), '-c', String(o.ctx), '-np', String(s.parallel), '--jinja', '--metrics', '--no-webui', '--alias', modelAlias(model)];
  // With several slots, share one memory pool so every slot can still use the full context.
  if (s.parallel > 1) args.push('--kv-unified');
  if (opts.vision) args.push('--mmproj', model.mmproj);
  args.push(...supportedOnly(plan.args, help));
  if (o.threads) args.push('-t', String(o.threads), '-tb', String(o.threads)); // leave the rest for the user's work
  if (r.cancelled) return; // stopped or replaced while we were checking
  args.push(...spec.args, ...extra);
  Object.assign(r.state, { port, ctx: o.ctx, parallel: s.parallel, vision: opts.vision, speculative: spec.mode, options: { kv: o.kv, visionCpu: o.visionCpu, threads: o.threads, lowRam: o.lowRam, computer: o.threads ? 'leave20' : 'full' } });
  log(`${path.basename(engine.path)} ${args.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ')}`, 'hearth', r);

  const binDir = path.dirname(engine.path);
  const env = { ...process.env };
  // Downloaded builds keep their libraries next to the program.
  if (process.platform === 'linux') env.LD_LIBRARY_PATH = [binDir, env.LD_LIBRARY_PATH].filter(Boolean).join(':');
  if (IS_WIN) env.PATH = [binDir, env.PATH].filter(Boolean).join(';');
  // Passed through the environment rather than the command line, so it doesn't show in process lists.
  env.LLAMA_API_KEY = r.key;
  spawnRun(r, engine.path, args, { cwd: binDir, env });
  // Big models can take minutes to load from disk.
  if (!(await waitHealthy(r, `http://127.0.0.1:${port}/health`, {}, 20))) return;
  try {
    const slots = await (await fetch(`http://127.0.0.1:${port}/slots`, { headers: { authorization: `Bearer ${r.key}` } })).json();
    if (slots?.[0]?.n_ctx) r.state.ctx = slots[0].n_ctx;
  } catch {}
  Object.assign(r.state, { status: 'ready', readyAt: Date.now() });
  log(`Ready in ${((r.state.readyAt - r.state.startedAt) / 1000).toFixed(1)} s · context ${r.state.ctx} tokens${opts.vision ? ' · images on' : ''}`, 'hearth', r);
  updateSettings({ lastModel: { id: model.id, path: model.path, mmproj: model.mmproj, name: model.name, quant: model.quant } });
}

// Starts a run's engine process and follows it: its output goes to the log, its end to the run's state.
// group: the engine is a launcher with programs of its own (Colibri: Python, then the engine), stopped as a whole.
function spawnRun(r, cmd, args, { cwd, env, group = false }) {
  const p = spawn(cmd, args, { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], detached: group && !IS_WIN });
  r.child = p;
  r.group = group;
  r.state.pid = p.pid || 0;
  r.exited = new Promise((resolve) => {
    p.once('exit', resolve);
    p.once('error', () => !p.pid && resolve()); // never started
  });
  if (p.pid) alive.add(r);
  savePids();
  p.stdout.on('data', (d) => log(d, 'out', r));
  p.stderr.on('data', (d) => log(d, 'err', r));
  p.on('error', (err) => {
    log(`Could not start the engine: ${err.message}`, 'hearth', r);
    if (!p.pid) {
      alive.delete(r);
      if (r.child === p) r.child = null;
      if (!r.cancelled) Object.assign(r.state, { status: 'error', error: `${t('The engine stopped while loading.')} ${err.message}` });
    }
  });
  p.on('exit', (code, signal) => {
    if (r.child === p) r.child = null;
    alive.delete(r);
    r.state.pid = 0;
    savePids();
    if (r.cancelled) return;
    log(`Engine stopped (${signal || `code ${code}`}).`, 'hearth', r);
    Object.assign(r.state, { status: 'error', error: explainCrash(r) });
  });
  return p;
}

// Waits until the engine answers its health check. False when the run was cancelled, failed, or took too long.
async function waitHealthy(r, url, headers, minutes) {
  const deadline = Date.now() + minutes * 60e3;
  while (Date.now() < deadline) {
    if (r.cancelled || r.state.status !== 'starting') return false;
    try {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(2000) });
      if (res.ok) return !r.cancelled && r.state.status === 'starting';
    } catch {}
    await sleep(400);
  }
  if (r.cancelled || r.state.status !== 'starting') return false;
  await stopRun(r);
  Object.assign(r.state, { status: 'error', error: t('The model took too long to load.') });
  if (!runs.has(r.model.id)) runs.set(r.model.id, r); // keep it on the list so the error shows
  return false;
}

// Colibri runs the model: its GGUF is linked (once), then `coli serve` starts on a private port with this run's key.
async function launchColibri(r) {
  const { model } = r;
  r.kind = 'colibri';
  const hw = await detectHardware();
  const o = effectiveOptions(model, hw, getModelSettings(model.id));
  let dir;
  try {
    dir = await importModel(model, { log: (text) => log(text, 'out', r) });
  } catch (err) {
    log(err.message, 'hearth', r);
    if (!r.cancelled) Object.assign(r.state, { status: 'error', error: err.message });
    return;
  }
  if (r.cancelled) return;
  const port = await findFreePort(7440 + Math.floor(Math.random() * 20));
  if (r.cancelled) return;
  const c = serveCommand({ model, dir, port, key: r.key, alias: modelAlias(model), ctx: o.ctx, hw });
  r.state.engine = { kind: 'colibri', tag: c.tag, build: c.tag, backend: c.backend, path: c.cmd, source: 'colibri' };
  Object.assign(r.state, { port, ctx: o.ctx, parallel: 1, vision: false, speculative: '', options: { kv: '', visionCpu: false, threads: 0, lowRam: false, computer: 'full' } });
  log(`Colibri ${c.tag} (${c.backend}): ${path.basename(c.cmd)} ${c.args.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ')}`, 'hearth', r);
  spawnRun(r, c.cmd, c.args, { cwd: c.cwd, env: c.env, group: true });
  // The first start of a big model reads its dense part from the disk: give it time.
  if (!(await waitHealthy(r, `http://127.0.0.1:${port}/health`, { authorization: `Bearer ${r.key}` }, 30))) return;
  try {
    const j = await (await fetch(`http://127.0.0.1:${port}/v1/models`, { headers: { authorization: `Bearer ${r.key}` }, signal: AbortSignal.timeout(5000) })).json();
    const n = Number(j?.data?.[0]?.context_length);
    if (n > 0) r.state.ctx = n;
  } catch {}
  Object.assign(r.state, { status: 'ready', readyAt: Date.now() });
  log(`Ready in ${((r.state.readyAt - r.state.startedAt) / 1000).toFixed(1)} s with Colibri · context ${r.state.ctx} tokens`, 'hearth', r);
  updateSettings({ lastModel: { id: model.id, path: model.path, mmproj: model.mmproj, name: model.name, quant: model.quant } });
}

// Ends an engine with the programs it started (Colibri's launcher runs the engine as a program of its own).
function killTree(r, p, signal) {
  if (!r.group || !p.pid) return p.kill(signal);
  if (IS_WIN) {
    try {
      spawnSync('taskkill', ['/PID', String(p.pid), '/T', '/F'], { windowsHide: true, timeout: 10000 });
    } catch {}
    return;
  }
  try {
    process.kill(-p.pid, signal); // its process group
  } catch {
    p.kill(signal);
  }
}

// "Compute error" is how the engine says it ran out of memory in the middle of an answer.
export function explainEngineError(msg) {
  const m = String(msg || '');
  if (/compute error|out of memory|insufficient memory|failed to allocate/i.test(m))
    return t('The model ran out of memory while answering. Close other big apps or unload other models and try again. If it keeps happening, use a shorter context or Low-RAM mode in the model’s settings.');
  return m;
}

// Turn the last log lines of one engine into a sentence a person can act on.
function explainCrash(r) {
  const mine = logs.filter((l) => l.src === r.model.id);
  const tail = mine.slice(-40).map((l) => l.text).join('\n');
  if (/failed to load draft model/i.test(tail)) return t('The MTP draft could not be loaded with this engine. In the model’s settings, set Drafting to “Guesses from the text” or update the engine.');
  if (/unknown model architecture|unsupported model|failed to load model/i.test(tail) && /architecture/i.test(tail))
    return t('This engine is too old for this model. Download the latest engine in Models → Engine.');
  if (/out of memory|failed to allocate|ErrorOutOfDeviceMemory|insufficient memory|cudaMalloc failed/i.test(tail))
    return t('Not enough memory for this model. Pick a smaller size or a shorter context in Settings.');
  if (/address already in use|bind/i.test(tail)) return t('The engine could not open its port. Try again.');
  if (/mmproj|clip/i.test(tail) && /fail/i.test(tail)) return t('The image helper (mmproj) failed to load. Turn off images in Settings and try again.');
  const last = mine.filter((l) => l.stream !== 'hearth').slice(-1)[0]?.text || '';
  return `${t('The engine stopped while loading.')} ${last}`.trim();
}

// Stops one run and waits until its engine has really quit, so its memory is free for the next one.
async function stopRun(r) {
  r.cancelled = true;
  if (runs.get(r.model.id) === r) runs.delete(r.model.id);
  const p = r.child;
  if (p && p.exitCode === null && p.signalCode === null) {
    r.state.status = 'stopping';
    killTree(r, p, 'SIGTERM');
    const quit = await Promise.race([r.exited.then(() => true), sleep(5000).then(() => false)]);
    if (!quit) {
      killTree(r, p, 'SIGKILL');
      await Promise.race([r.exited, sleep(5000)]);
    }
    log('Engine stopped.', 'hearth', r);
  }
  Object.assign(r.state, { status: 'stopped', pid: 0, port: 0 });
  savePids();
}

// Stops one model (by id), or every model and every engine still on its way out.
export async function stopEngine(id) {
  const targets = new Set(id ? [runs.get(id)].filter(Boolean) : [...runs.values(), ...alive]);
  await Promise.all([...targets].map(stopRun));
  if (!runs.has(primary)) primary = [...runs.keys()].pop() || '';
}

// Used by the API: make sure a model is loaded (load the last one if needed) before forwarding a request.
export async function ensureEngine(findModel) {
  for (let tries = 0; tries < 3 && runs.get(primary)?.state.status === 'starting'; tries++) await runs.get(primary).starting;
  const r = runs.get(primary);
  if (r?.state.status === 'ready') return true;
  if (r?.state.status === 'starting') return false;
  const s = getSettings();
  if (!s.autoLoad || !s.lastModel) return false;
  const model = findModel(s.lastModel) || null;
  if (!model) return false;
  await startEngine(model);
  return runs.get(model.id)?.state.status === 'ready';
}

// A crashed Hearth can leave engines running; stop them so they don't hold memory.
export async function cleanupOrphan() {
  let lines = [];
  try {
    lines = fs.readFileSync(PID_FILE, 'utf8').split(/\r?\n/).filter(Boolean);
  } catch {
    return;
  }
  for (const line of lines) {
    const [pidText, kind] = line.trim().split(/\s+/);
    const pid = Number(pidText);
    if (!pid) continue;
    const cmd = IS_WIN ? await runCmd('tasklist', ['/FI', `PID eq ${pid}`, '/NH']) : await runCmd('ps', ['-p', String(pid), '-o', 'command=']);
    // Colibri's launcher is Python (Windows only shows the program's name, not its arguments).
    const ours = kind === 'colibri' ? (IS_WIN ? /python/i.test(cmd) : /[\\/]coli\b.*\bserve\b/i.test(cmd)) : /llama-server/i.test(cmd);
    if (!ours) continue;
    try {
      if (kind === 'colibri' && IS_WIN) spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 10000 });
      else if (kind === 'colibri') process.kill(-pid, 'SIGTERM'); // its process group: the launcher and its engine
      else process.kill(pid);
      log(`Stopped an engine left running from last time (pid ${pid}).`, 'hearth');
    } catch {}
  }
  fs.rmSync(PID_FILE, { force: true });
}

export function killEngineSync() {
  for (const r of new Set([...runs.values(), ...alive])) {
    try {
      if (r.child) killTree(r, r.child, 'SIGKILL');
    } catch {}
  }
}
