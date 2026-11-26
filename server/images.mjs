// Pictures made on this computer: stable-diffusion.cpp (sd-cli) with Z-Image Turbo, an open (Apache 2.0) model that
// draws in 8 steps and handles text in pictures well. Each job runs sd-cli once; pictures and their settings are
// kept in the data folder. The chat model and the picture model share memory, so a big chat model may need to
// step aside while pictures are made.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { DIRS, getSettings, updateSettings } from './settings.mjs';
import { run, uid, readJson, writeJson, IS_WIN, IS_MAC } from './util.mjs';
import { startDownload, listDownloads, shaOf } from './downloads.mjs';
import { extract, findProgram } from './engine-install.mjs';
import { hfTree } from './catalog.mjs';
import { detectHardware, liveStats } from './hardware.mjs';
import { engineState, stopEngine } from './engine.mjs';
import { t } from './i18n.mjs';

const EXE = IS_WIN ? 'sd-cli.exe' : 'sd-cli';
const ENGINE_DIR = path.join(DIRS.images, 'engine');
const MODEL_DIR = path.join(DIRS.images, 'models');
const OUT_DIR = path.join(DIRS.images, 'gallery');
fs.mkdirSync(OUT_DIR, { recursive: true });

const VAE = { repo: 'Comfy-Org/z_image_turbo', path: 'split_files/vae/ae.safetensors' };
export const IMAGE_SETS = [
  {
    id: 'zimage-q8',
    name: 'Z-Image Turbo',
    quality: 'Best quality',
    minRam: 24,
    files: [{ repo: 'leejet/Z-Image-Turbo-GGUF', path: 'z_image_turbo-Q8_0.gguf', role: 'diffusion' }, { repo: 'unsloth/Qwen3-4B-Instruct-2507-GGUF', path: 'Qwen3-4B-Instruct-2507-Q8_0.gguf', role: 'llm' }, { ...VAE, role: 'vae' }],
    steps: 8,
    cfg: 1,
  },
  {
    id: 'zimage-q4',
    name: 'Z-Image Turbo',
    quality: 'Smaller and lighter',
    minRam: 12,
    files: [{ repo: 'leejet/Z-Image-Turbo-GGUF', path: 'z_image_turbo-Q4_K.gguf', role: 'diffusion' }, { repo: 'unsloth/Qwen3-4B-Instruct-2507-GGUF', path: 'Qwen3-4B-Instruct-2507-Q4_K_M.gguf', role: 'llm' }, { ...VAE, role: 'vae' }],
    steps: 8,
    cfg: 1,
  },
];

export const SIZES = {
  square: [1024, 1024],
  portrait: [832, 1216],
  landscape: [1216, 832],
  story: [720, 1280],
  wide: [1280, 720],
};

const fileOf = (f) => path.join(MODEL_DIR, f.repo.split('/')[1], path.basename(f.path));

// The stable-diffusion.cpp program (sd-cli); videos use the same one.
export async function findEngine() {
  const local = findProgram(ENGINE_DIR, EXE, 4);
  if (local) return local;
  const which = (await run(IS_WIN ? 'where' : 'which', [EXE])).trim().split(/\r?\n/)[0];
  return which && fs.existsSync(which) ? which : '';
}

function installedSet() {
  const id = getSettings().imageModel;
  const set = IMAGE_SETS.find((s) => s.id === id);
  if (!set) return null;
  return set.files.every((f) => fs.existsSync(fileOf(f))) ? set : null;
}

async function setSizes(set) {
  const out = [];
  for (const f of set.files) {
    const tree = await hfTree(f.repo);
    out.push({ ...f, size: tree.find((x) => x.path === f.path)?.size || 0 });
  }
  return out;
}

let job = null; // the running or last job

// Pictures and videos share the graphics card and memory, so only one of them runs at a time.
export const drawing = () => Boolean(job && ['loading', 'drawing', 'saving'].includes(job.state));
let videoBusy = () => false;
export function setVideoBusy(fn) {
  videoBusy = fn;
}

export async function imagesStatus() {
  const hw = await detectHardware();
  const ramGB = Math.round(hw.ram / 1024 ** 3);
  const sets = [];
  for (const s of IMAGE_SETS) {
    let size = 0;
    try {
      size = (await setSizes(s)).reduce((a, f) => a + f.size, 0);
    } catch {}
    sets.push({ id: s.id, name: s.name, quality: t(s.quality), size, fits: ramGB >= s.minRam, installed: s.files.every((f) => fs.existsSync(fileOf(f))) });
  }
  const recommended = (sets.find((s) => s.fits && s.id === 'zimage-q8') || sets.find((s) => s.fits) || sets[sets.length - 1]).id;
  const engine = await findEngine();
  const set = installedSet();
  return {
    ready: Boolean(engine && set),
    engine: engine ? { path: engine } : null,
    set: set ? { id: set.id, name: set.name } : null,
    sets,
    recommended,
    installing: listDownloads().some((d) => d.kind === 'images' && (d.state === 'downloading' || d.state === 'queued' || d.state === 'finishing')),
    job: publicJob(),
    sizes: SIZES,
  };
}

// The ready-made engine for this system in each release, newest first: { tag, name, url, size, sha256 }.
async function engineReleases(hw, count = 5) {
  const res = await fetch(`https://api.github.com/repos/leejet/stable-diffusion.cpp/releases?per_page=${count}`, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'Hearth' }, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(t('GitHub said {status}', { status: res.status }));
  return pickEngineAssets(await res.json(), hw);
}

// Exported for tests: which file of each release fits this computer.
export function pickEngineAssets(releases, hw, { mac = IS_MAC, win = IS_WIN, arm = os.arch() === 'arm64' } = {}) {
  let want;
  if (mac) want = [arm ? /-bin-Darwin-macOS-[\d.]+-arm64\.zip$/ : /-bin-Darwin-macOS-[\d.]+-x86_64\.zip$/];
  else if (win) want = hw.gpus?.length ? [/-bin-win-vulkan-x64\.zip$/, /-bin-win-cpu-x64\.zip$/] : [/-bin-win-cpu-x64\.zip$/];
  else want = hw.gpus?.length ? [/-bin-Linux-Ubuntu-[\d.]+-x86_64-vulkan\.zip$/, /-bin-Linux-Ubuntu-[\d.]+-x86_64\.zip$/] : [/-bin-Linux-Ubuntu-[\d.]+-x86_64\.zip$/];
  const out = [];
  for (const rel of Array.isArray(releases) ? releases : []) {
    for (const re of want) {
      const a = rel.assets?.find((x) => re.test(x.name) && !x.name.startsWith('cudart'));
      if (a) {
        out.push({ tag: rel.tag_name, name: a.name, url: a.browser_download_url, size: a.size, sha256: shaOf(a) });
        break;
      }
    }
  }
  return out;
}

async function latestEngineAsset(hw) {
  return (await engineReleases(hw))[0] || null;
}

// Which build is installed. Hearth writes the release's name next to the engine when it downloads it; an engine from
// before that says its commit itself ("…, commit 984eb06"). Release names end in that commit: master-1047-984eb06.
const ENGINE_NOTE = path.join(ENGINE_DIR, 'hearth-engine.json');
const commitOf = (tag) => String(tag || '').split('-').pop();
export async function sdEngineBuild() {
  const bin = findProgram(ENGINE_DIR, EXE, 4);
  if (!bin) return null; // none, or one of the system's own that Hearth doesn't manage
  const note = readJson(ENGINE_NOTE, null);
  if (note?.tag) return { tag: note.tag, commit: commitOf(note.tag) };
  const said = await run(bin, ['--version'], { timeout: 15000, withStderr: true });
  return { tag: '', commit: (/commit\s+([0-9a-f]{7,40})/i.exec(said)?.[1] || '').slice(0, 7) };
}

// A newer engine than the installed one, or null. New builds come several times a day, so a build only a few
// releases old is left in peace.
const WORTH_UPDATING = 10;
export async function sdEngineUpdate(hw, { releases } = {}) {
  const cur = await sdEngineBuild();
  if (!cur) return null;
  const list = releases || (await engineReleases(hw, 100));
  if (!list.length) return null;
  const at = cur.commit ? list.findIndex((r) => commitOf(r.tag) === cur.commit) : -1;
  // Not among the last hundred: older than all of them.
  const behind = at < 0 ? list.length : at;
  if (behind < WORTH_UPDATING) return null;
  return { current: cur.tag || cur.commit || '', latest: list[0].tag, size: list[0].size, behind, asset: list[0] };
}

const engineListeners = [];
// Called after the engine was replaced (the video module reads the engine's help once and must read it again).
export function onSdEngineChange(fn) {
  engineListeners.push(fn);
}

// Downloads one engine build and puts it in place. The engine that is there is kept aside until the new one has
// shown that it starts; if it doesn't, the old one comes back.
function downloadSdEngine(rel) {
  const tmp = path.join(DIRS.images, '.download');
  const old = `${ENGINE_DIR}.old`;
  return startDownload({
    kind: 'images',
    label: t('Picture engine (stable-diffusion.cpp {tag})', { tag: rel.tag }),
    meta: { engine: rel.tag },
    files: [{ url: rel.url, size: rel.size, sha256: rel.sha256, dest: path.join(tmp, rel.name) }],
    onDone: async () => {
      if (drawing() || videoBusy()) throw new Error(t('Pictures or a video are being made. Update the engine when they are done.'));
      fs.rmSync(old, { recursive: true, force: true });
      const had = fs.existsSync(ENGINE_DIR);
      if (had) fs.renameSync(ENGINE_DIR, old);
      try {
        fs.mkdirSync(ENGINE_DIR, { recursive: true });
        await extract(path.join(tmp, rel.name), ENGINE_DIR);
        const bin = findProgram(ENGINE_DIR, EXE, 4);
        if (!bin) throw new Error(t('The download did not contain {name}.', { name: EXE }));
        if (!IS_WIN) fs.chmodSync(bin, 0o755);
        const help = await run(bin, ['--help'], { timeout: 30000, withStderr: true });
        if (!help.includes('--diffusion-model')) throw new Error(t('The new picture engine does not start on this computer. The one you had is back in place.'));
        writeJson(ENGINE_NOTE, { tag: rel.tag, file: rel.name, at: Date.now() });
      } catch (err) {
        fs.rmSync(ENGINE_DIR, { recursive: true, force: true });
        if (had) fs.renameSync(old, ENGINE_DIR);
        throw err;
      } finally {
        fs.rmSync(path.join(tmp, rel.name), { force: true });
      }
      fs.rmSync(old, { recursive: true, force: true });
      for (const fn of engineListeners) fn();
    },
  });
}

// Downloads sd-cli when it isn't here yet: the download job, or null when there is nothing to do.
// force: download the newest one even though one is here (an old build that can't make videos).
export async function ensureSdEngine({ force = false } = {}) {
  if (!force && (await findEngine())) return null;
  const hw = await detectHardware();
  const rel = await latestEngineAsset(hw);
  if (!rel) throw new Error(t('No ready-made picture engine for this system.'));
  return downloadSdEngine(rel);
}

// The Update button: the newest engine in place of the installed one.
export async function updateSdEngine({ release } = {}) {
  if (drawing() || videoBusy()) throw Object.assign(new Error(t('Pictures or a video are being made. Update the engine when they are done.')), { status: 409 });
  const hw = await detectHardware();
  const rel = release || (await latestEngineAsset(hw)); // `release` is for tests
  if (!rel) throw new Error(t('No ready-made picture engine for this system.'));
  return downloadSdEngine(rel);
}

export async function installImages(setId) {
  const set = IMAGE_SETS.find((s) => s.id === setId) || IMAGE_SETS[0];
  const jobs = [];
  const engineJob = await ensureSdEngine();
  if (engineJob) jobs.push(engineJob);
  const files = (await setSizes(set)).filter((f) => !(fs.existsSync(fileOf(f)) && fs.statSync(fileOf(f)).size === f.size));
  const token = getSettings().hfToken;
  if (files.length) {
    jobs.push(
      startDownload({
        kind: 'images',
        label: t('Picture model ({name}, {quality})', { name: set.name, quality: t(set.quality) }),
        files: files.map((f) => ({ url: `https://huggingface.co/${f.repo}/resolve/main/${f.path.split('/').map(encodeURIComponent).join('/')}`, dest: fileOf(f), size: f.size, headers: token ? { authorization: `Bearer ${token}` } : {} })),
        onDone: async () => updateSettings({ imageModel: set.id }),
      }),
    );
  } else updateSettings({ imageModel: set.id });
  return { jobs };
}

// sd-cli options changed names over time; read its help once and use what it knows.
let helpText = null;
async function cliHelp(bin) {
  if (helpText == null) helpText = await run(bin, ['--help'], { timeout: 20000, withStderr: true });
  return helpText;
}

function publicJob() {
  if (!job) return null;
  const { proc, ...rest } = job;
  return rest;
}

// How much memory pictures need, and whether the loaded chat model leaves enough.
async function memoryCheck(set) {
  const need = set.files.reduce((a, f) => a + (fs.existsSync(fileOf(f)) ? fs.statSync(fileOf(f)).size : 0), 0) + 2.5 * 1024 ** 3;
  const loaded = engineState().loaded.filter((r) => r.status === 'ready' || r.status === 'starting');
  if (!loaded.length) return { ok: true, need };
  const hw = await detectHardware();
  const stats = await liveStats(hw, loaded[0].pid, { gpu: false });
  const free = stats.ramTotal - stats.ramUsed;
  const used = loaded.reduce((a, r) => a + (r.plan?.need || 0), 0);
  const gpuFree = hw.unified && hw.gpuBudget ? hw.gpuBudget - used : Infinity;
  return { ok: free > need + 2 * 1024 ** 3 && gpuFree > need, need, free, names: loaded.map((r) => r.model?.name).filter(Boolean).join(', ') };
}

export async function generateImages(opts) {
  if (job && (job.state === 'loading' || job.state === 'drawing' || job.state === 'saving')) throw Object.assign(new Error(t('Pictures are already being made. Wait for them to finish.')), { status: 409 });
  if (videoBusy()) throw Object.assign(new Error(t('A video is being made. Wait for it to finish.')), { status: 409 });
  const bin = await findEngine();
  const set = installedSet();
  if (!bin || !set) throw Object.assign(new Error(t('Install the picture model first.')), { status: 409 });
  const prompt = String(opts.prompt || '').trim().slice(0, 4000);
  if (!prompt) throw Object.assign(new Error(t('Describe the picture first.')), { status: 400 });
  const [w, h] = SIZES[opts.size] || SIZES.square;
  const count = Math.min(4, Math.max(1, Number(opts.count) || 1));
  const steps = Math.min(30, Math.max(4, Number(opts.steps) || set.steps));
  const seed = Number.isInteger(opts.seed) && opts.seed >= 0 ? opts.seed : Math.floor(Math.random() * 2 ** 31);
  const mem = await memoryCheck(set);
  let unloaded = '';
  if (!mem.ok) {
    if (!opts.unload) throw Object.assign(new Error(t('Not enough free memory while the chat model is loaded.')), { status: 409, code: 'NEEDS_MEMORY', model: mem.names || '' });
    unloaded = mem.names || '';
    await stopEngine(); // every loaded model steps aside
  }
  const help = await cliHelp(bin);
  const files = Object.fromEntries(set.files.map((f) => [f.role, fileOf(f)]));
  const dir = path.join(DIRS.images, '.work', uid(8));
  fs.mkdirSync(dir, { recursive: true });
  const args = ['--diffusion-model', files.diffusion, '--vae', files.vae, help.includes('--llm') ? '--llm' : '--qwen2vl', files.llm, '-p', prompt, '-W', String(w), '-H', String(h), '--steps', String(steps), '--cfg-scale', String(set.cfg), '-s', String(seed), '-b', String(count), '-o', path.join(dir, 'image.png')];
  if (opts.negative && String(opts.negative).trim()) args.push('-n', String(opts.negative).slice(0, 2000));
  if (help.includes('--flash-attn')) args.push('--flash-attn', 'auto');
  else if (help.includes('--diffusion-fa')) args.push('--diffusion-fa');
  if (!IS_MAC && help.includes('--vae-tiling')) args.push('--vae-tiling');
  const id = uid(10);
  job = { id, state: 'loading', step: 0, steps, image: 0, count, prompt, size: opts.size || 'square', seed, startedAt: Date.now(), images: [], error: '', unloaded, log: [] };
  const my = job;
  const proc = spawn(bin, args, { cwd: path.dirname(bin), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  my.proc = proc;
  let last = '';
  const onOut = (d) => {
    const s = String(d);
    last = (last + s).slice(-6000);
    for (const line of s.split(/[\r\n]+/)) {
      const m = /\|\s*(\d+)\/(\d+)\s*-/.exec(line);
      if (m && Number(m[2]) === steps) {
        const step = Number(m[1]);
        if (my.state === 'drawing' && step < my.step) my.image = Math.min(count - 1, my.image + 1); // the next picture began
        my.state = 'drawing';
        my.step = step;
      } else if (/decod|vae/i.test(line) && my.state === 'drawing' && my.step >= steps) my.state = 'saving';
    }
  };
  proc.stdout.on('data', onOut);
  proc.stderr.on('data', onOut);
  proc.on('error', (err) => {
    my.state = 'error';
    my.error = err.message;
  });
  proc.on('close', (code) => {
    my.proc = null;
    if (my.state === 'cancelled') return fs.rmSync(dir, { recursive: true, force: true });
    const made = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.png')).sort((a, b) => a.length - b.length || a.localeCompare(b)) : [];
    if (!made.length) {
      my.state = 'error';
      my.error = code === 0 ? t('No picture was made.') : explain(last);
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    }
    made.forEach((f, i) => {
      const name = `${new Date().toISOString().slice(0, 10)}-${id}-${i + 1}.png`;
      fs.renameSync(path.join(dir, f), path.join(OUT_DIR, name));
      writeJson(path.join(OUT_DIR, `${name}.json`), { prompt, negative: opts.negative || '', width: w, height: h, steps, seed: seed + i, model: `${set.name} (${set.id})`, ms: Date.now() - my.startedAt, at: Date.now() });
      my.images.push(name);
    });
    fs.rmSync(dir, { recursive: true, force: true });
    my.state = 'done';
    my.finishedAt = Date.now();
  });
  return publicJob();
}

function explain(log) {
  if (/out of memory|failed to allocate|Insufficient Memory|kIOGPUCommandBufferCallbackErrorOutOfMemory/i.test(log)) return t('Not enough memory to make this picture. Try a smaller size, or close other apps.');
  const lines = log.trim().split('\n').filter((l) => /error|fail/i.test(l));
  return `${t('The picture engine stopped.')} ${(lines.pop() || log.trim().split('\n').pop() || '').slice(0, 300)}`.trim();
}

export function cancelImages() {
  if (job?.proc) {
    job.state = 'cancelled';
    job.proc.kill();
  }
  return publicJob();
}

export function jobStatus() {
  return publicJob();
}

export function gallery(limit = 200) {
  const out = [];
  for (const f of fs.readdirSync(OUT_DIR)) {
    if (!f.endsWith('.png')) continue;
    const meta = readJson(path.join(OUT_DIR, `${f}.json`), {});
    out.push({ name: f, url: `/images/${f}`, ...meta, at: meta.at || fs.statSync(path.join(OUT_DIR, f)).mtimeMs });
  }
  return out.sort((a, b) => b.at - a.at).slice(0, limit);
}

export function imagePath(name) {
  const base = path.basename(String(name || ''));
  if (!/^[\w.-]+\.png$/.test(base)) return '';
  const p = path.join(OUT_DIR, base);
  return fs.existsSync(p) ? p : '';
}

export function deleteImage(name) {
  const p = imagePath(name);
  if (!p) return false;
  fs.rmSync(p, { force: true });
  fs.rmSync(`${p}.json`, { force: true });
  return true;
}
