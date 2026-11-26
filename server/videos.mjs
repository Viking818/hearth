// Videos made on this computer: stable-diffusion.cpp (the same sd-cli as Pictures) with LTX-2.5 from Lightricks, the
// newest open video model it runs (August 2026). It makes video with sound in one go, from a description or from a
// picture. The "distilled" version works in two stages, as Lightricks made it: 8 steps at half size, a 2× upscale of
// the result, then 3 steps at full size, with the step schedule from Lightricks' own code (ltx_pipelines constants).
// Files come from Unsloth's copy of LTX-2.5 (no Hugging Face login needed). The text encoder (Gemma 4 12B) is shared
// there only at full size (26 GB), so Hearth shrinks it once after downloading, with sd-cli's own convert mode.
// Videos and their settings are kept in the data folder (DATA/videos/gallery).
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DIRS, getSettings } from './settings.mjs';
import { uid, readJson, writeJson, GB, run } from './util.mjs';
import { startDownload, listDownloads } from './downloads.mjs';
import { hfTree } from './catalog.mjs';
import { detectHardware, liveStats } from './hardware.mjs';
import { engineState, stopEngine } from './engine.mjs';
import { findEngine, ensureSdEngine, drawing, setVideoBusy, imagePath, onSdEngineChange } from './images.mjs';
import { t } from './i18n.mjs';
import { splitWebm, soundIsBroken } from './webm.mjs';

const MODEL_DIR = path.join(DIRS.videos, 'models');
const UPSCALER_DIR = path.join(MODEL_DIR, 'upscalers');
const OUT_DIR = path.join(DIRS.videos, 'gallery');
const PLAY_DIR = path.join(DIRS.videos, 'play');
fs.mkdirSync(UPSCALER_DIR, { recursive: true });
fs.mkdirSync(OUT_DIR, { recursive: true });

const REPO = 'unsloth/LTX-2.5-GGUF';
export const VIDEO_FILES = [
  { path: 'distilled/ltx-2.5-22b-distilled-UD-Q4_K_XL.gguf', role: 'diffusion' },
  { path: 'text_encoders/gemma4-12b-with-proj-ltx-2.5-bf16.safetensors', role: 'llm', shrink: true },
  { path: 'vae/ltx-2.5-video-vae-conv-bf16.safetensors', role: 'vae' }, // the "conv" decoder: sd-cli has no diffusion decoder
  { path: 'vae/ltx-2.5-audio-vae-bf16.safetensors', role: 'audio' },
  { path: 'latent_upscale_models/ltx-2.5-latent-spatial-upscaler-x2-bf16-1.0.safetensors', role: 'upscaler' },
];
// Lightricks' DISTILLED_SIGMA_VALUES and STAGE_2_DISTILLED_SIGMA_VALUES.
export const SIGMAS = '1.0,0.99375,0.9875,0.98125,0.975,0.909375,0.725,0.421875,0.0';
export const HIRES_SIGMAS = '0.909375,0.725,0.421875,0.0';
const STEPS = 8;
const HIRES_STEPS = 3;
// First-stage sizes: half of the finished video (1280×704 and so on). LTX wants sides that are multiples of 32.
export const VIDEO_SIZES = { wide: [640, 352], portrait: [352, 640], square: [480, 480] };
// Frames at 24 per second; LTX wants 8n+1 frames.
export const VIDEO_LENGTHS = { 3: 73, 5: 121, 10: 241 };

// ---- The second video model: MiniMax-H3 "Ref2VA", for reference photos ----
// LTX-2.5 takes a first and a last frame, nothing else. MiniMax-H3 takes photos of people, products and places and
// keeps them the same in the video (with sound), which is what "add several photos" means on the big video sites.
// The files come from Unsloth's copy at one fixed revision, each checked against its SHA-256 (they are the same
// four files stable-diffusion.cpp's own guide names). MiniMax's licence does not cover every country: the page says so.
const REF_REPO = 'unsloth/MiniMax-H3-GGUF';
const REF_REV = 'babc040eff0084465460ead58fdb8ec44296f8dd';
const REF_DIR = path.join(MODEL_DIR, 'minimax-h3');
export const REF_FILES = [
  { path: 'minimax_h3_ref2va_pruned-Q4_K.gguf', role: 'diffusion', size: 11381096544, sha256: '2fa5840021cf6967843eaeefde9aaa277e540de02986d5ee3d5b0e6a7a8c9dec' },
  { path: 'qwen3vl_32b_minimax_h3-Q4_K_M.gguf', role: 'llm', size: 18218065024, sha256: '11e6efe70a57ce7f4838c47bdbd1a1c4b8ce10e2b7747f1b065990b70f4b05fc' },
  { path: 'vae/minimax_h3_video_vae_fp16.safetensors', role: 'vae', size: 5207808496, sha256: '7c1f131492e7eddacaac9069a61b81bdd39de5cc96561e677c5eab1cdce5e522' },
  { path: 'vae/minimax_h3_audio_vae_fp32.safetensors', role: 'audio', size: 605254808, sha256: '8e505d95dd1561d47abd43d4238fd40d9bb1ae9e147ed0a4cba778d76ae4db48' },
];
// This model wants sides that are multiples of 32 and 17n+5 frames, and works best at about 0.4 megapixels.
export const REF_SIZES = { wide: [864, 480], portrait: [480, 864], square: [640, 640] };
export const REF_LENGTHS = { 3: 73, 5: 124, 10: 243 };
export const REF_STEPS = 8;
export const MAX_REFS = 4;
const refFile = (f) => path.join(REF_DIR, path.basename(f.path));

// Every file of the reference-photo model in place and whole: { diffusion, llm, vae, audio }, or null.
function installedRefFiles() {
  const out = {};
  for (const f of REF_FILES) {
    const p = refFile(f);
    if (!fs.existsSync(p) || fs.statSync(p).size !== f.size) return null;
    out[f.role] = p;
  }
  return out;
}

// People write "photo 1" or "@2" (or «фото 1»); the model knows its reference pictures as <Picture 1>, <Picture 2>…
// A description that names none gets a first line that hands all of them to the model.
export function refPrompt(prompt, count) {
  let named = false;
  const text = String(prompt || '').replace(/<?(?:\b(?:picture|photo|image|pic)|(?<![\p{L}])(?:фото(?:графи[яиюей]+)?|картинк[аиуое]й?|изображени[еяию]))\s*(?:#|№|номер\s*)?([1-9])>?|@([1-9])\b/giu, (m, a, b) => {
    const n = Number(a || b);
    if (n > count) return m;
    named = true;
    return `<Picture ${n}>`;
  });
  if (named || !count) return text;
  const all = Array.from({ length: count }, (_, i) => `<Picture ${i + 1}>`);
  return `Keep the people, objects and places of ${all.length > 1 ? `${all.slice(0, -1).join(', ')} and ${all[all.length - 1]}` : all[0]} exactly as they look. ${text}`;
}

const fileOf = (f) => (f.role === 'upscaler' ? path.join(UPSCALER_DIR, path.basename(f.path)) : path.join(MODEL_DIR, path.basename(f.path)));
const shrunk = (type) => path.join(MODEL_DIR, `gemma4-12b-with-proj-ltx-2.5-${type}.gguf`);
const TYPES = ['q8_0', 'q4_K'];

// The text encoder shrunk to 8 bits where there is room (a graphics card with 16 GB or more, or a Mac with 64 GB),
// else to 4 bits (smaller, a little less precise).
async function shrinkType() {
  const hw = await detectHardware();
  const roomy = hw.unified ? hw.ram >= 64 * GB : hw.gpuBudget >= 16 * GB && hw.ram >= 32 * GB;
  return roomy ? 'q8_0' : 'q4_K';
}

// Every file in place: { diffusion, llm, vae, audio, upscaler } (paths), or null.
function installedFiles() {
  const out = {};
  for (const f of VIDEO_FILES) {
    const p = f.shrink ? TYPES.map(shrunk).find((x) => fs.existsSync(x)) : fileOf(f);
    if (!p || !fs.existsSync(p)) return null;
    out[f.role] = p;
  }
  return out;
}

async function sizes() {
  const tree = await hfTree(REPO);
  return VIDEO_FILES.map((f) => ({ ...f, size: tree.find((x) => x.path === f.path)?.size || 0 }));
}

let job = null; // the running or last video
const active = () => Boolean(job && ['loading', 'drawing', 'saving'].includes(job.state));
setVideoBusy(active);
export const videoRunning = active; // for keeping the computer awake (power.mjs)

const publicJob = () => {
  if (!job) return null;
  const { proc, ...rest } = job;
  return rest;
};

export async function videosStatus() {
  const hw = await detectHardware();
  let download = 0;
  let finished = 0;
  try {
    const list = await sizes();
    const share = (await shrinkType()) === 'q8_0' ? 0.53 : 0.3;
    download = list.reduce((a, f) => a + f.size, 0);
    // On disk once ready: the text encoder shrinks to about half (8 bits) or a third (4 bits) of its download.
    finished = list.reduce((a, f) => a + (f.shrink ? f.size * share : f.size), 0);
  } catch {}
  const engine = await findEngine();
  const files = installedFiles();
  // About 30 GB in memory while a video is made; 16 GB of graphics memory or a 48 GB Mac work best.
  const ramGB = Math.round(hw.ram / 1024 ** 3);
  // An engine from before LTX-2.5 counts as missing: the Install button then brings the newest one.
  const help = engine ? await cliHelp(engine) : '';
  const canVideo = Boolean(engine) && help.includes('--audio-vae');
  const busy = (d) => d.kind === 'videos' && (d.state === 'downloading' || d.state === 'queued' || d.state === 'finishing');
  const refDownload = REF_FILES.reduce((a, f) => a + (fs.existsSync(refFile(f)) && fs.statSync(refFile(f)).size === f.size ? 0 : f.size), 0);
  return {
    ready: Boolean(canVideo && files),
    engine: canVideo,
    download,
    onDisk: finished,
    fits: hw.unified ? ramGB >= 36 : ramGB >= 32,
    installing: listDownloads().some((d) => busy(d) && d.meta?.model !== 'refs'),
    // The reference-photo model (MiniMax-H3): its own download, and it needs an engine that knows it.
    refs: {
      ready: Boolean(canVideo && canRefs(help) && installedRefFiles()),
      download: refDownload,
      size: REF_FILES.reduce((a, f) => a + f.size, 0),
      max: MAX_REFS,
      fits: hw.unified ? ramGB >= 48 : ramGB >= 32,
      installing: listDownloads().some((d) => busy(d) && d.meta?.model === 'refs'),
    },
    job: publicJob(),
  };
}

// An engine that knows MiniMax-H3's reference photos says so in its help.
const canRefs = (help) => /MiniMax-H3/.test(help) && help.includes('--ref-image');

export async function installVideos({ model = '' } = {}) {
  const jobs = [];
  // A picture engine from before LTX-2.5 (August 2026) can't make these videos, and one from before MiniMax-H3
  // can't take reference photos: get the newest one.
  const bin = await findEngine();
  const help = bin ? await cliHelp(bin) : '';
  const old = Boolean(bin) && (!help.includes('--audio-vae') || (model === 'refs' && !canRefs(help)));
  if (old) helpText = null;
  const engineJob = await ensureSdEngine({ force: old });
  if (engineJob) jobs.push(engineJob);
  if (model === 'refs') {
    const missing = REF_FILES.filter((f) => !(fs.existsSync(refFile(f)) && fs.statSync(refFile(f)).size === f.size));
    const token = getSettings().hfToken;
    if (missing.length) {
      fs.mkdirSync(REF_DIR, { recursive: true });
      jobs.push(
        startDownload({
          kind: 'videos',
          label: t('Video model for reference photos (MiniMax-H3)'),
          meta: { model: 'refs' },
          files: missing.map((f) => ({ url: `https://huggingface.co/${REF_REPO}/resolve/${REF_REV}/${f.path}`, dest: refFile(f), size: f.size, sha256: f.sha256, headers: token ? { authorization: `Bearer ${token}` } : {} })),
        }),
      );
    }
    return { jobs };
  }
  const haveShrunk = TYPES.some((x) => fs.existsSync(shrunk(x)));
  const files = (await sizes()).filter((f) => !(f.shrink && haveShrunk) && !(fs.existsSync(fileOf(f)) && fs.statSync(fileOf(f)).size === f.size));
  const token = getSettings().hfToken;
  const llm = VIDEO_FILES.find((f) => f.shrink);
  if (files.length || (!haveShrunk && fs.existsSync(fileOf(llm)))) {
    jobs.push(
      startDownload({
        kind: 'videos',
        label: t('Video model (LTX-2.5)'),
        files: files.map((f) => ({ url: `https://huggingface.co/${REPO}/resolve/main/${f.path.split('/').map(encodeURIComponent).join('/')}`, dest: fileOf(f), size: f.size, headers: token ? { authorization: `Bearer ${token}` } : {} })),
        onDone: async () => shrinkTextEncoder(fileOf(llm)),
      }),
    );
  }
  return { jobs };
}

// sd-cli -M convert: the 26 GB text encoder becomes a GGUF file of 8 or 4 bits, then the big file goes.
export async function shrinkTextEncoder(full) {
  if (!fs.existsSync(full)) return;
  let bin = await findEngine();
  for (let i = 0; !bin && i < 600; i++) {
    await new Promise((r) => setTimeout(r, 1000)); // the engine is still downloading next to it
    bin = await findEngine();
  }
  if (!bin) throw new Error(t('The picture engine is missing. Install it again.'));
  const type = await shrinkType();
  const out = shrunk(type);
  const tmp = out.replace(/\.gguf$/, '.tmp.gguf');
  const log = await new Promise((resolve) => {
    let text = '';
    const p = spawn(bin, ['-M', 'convert', '-m', full, '--type', type, '-o', tmp], { cwd: path.dirname(bin), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    p.stdout.on('data', (d) => (text = (text + d).slice(-4000)));
    p.stderr.on('data', (d) => (text = (text + d).slice(-4000)));
    p.on('error', (err) => resolve({ code: -1, text: err.message }));
    p.on('close', (code) => resolve({ code, text }));
  });
  if (log.code !== 0 || !fs.existsSync(tmp) || fs.statSync(tmp).size < 1e9) {
    fs.rmSync(tmp, { force: true });
    throw new Error(`${t('Could not prepare the text encoder.')} ${log.text.trim().split('\n').pop() || ''}`.trim());
  }
  fs.renameSync(tmp, out);
  fs.rmSync(full, { force: true });
}

// The memory a video needs, and whether the loaded chat model leaves enough (same rule as pictures).
async function memoryCheck(files) {
  const need = Object.values(files).reduce((a, p) => a + fs.statSync(p).size, 0) + 4 * GB;
  const loaded = engineState().loaded.filter((r) => r.status === 'ready' || r.status === 'starting');
  if (!loaded.length) return { ok: true, need };
  const hw = await detectHardware();
  const stats = await liveStats(hw, loaded[0].pid, { gpu: false });
  const free = stats.ramTotal - stats.ramUsed;
  const used = loaded.reduce((a, r) => a + (r.plan?.need || 0), 0);
  const gpuFree = hw.unified && hw.gpuBudget ? hw.gpuBudget - used : Infinity;
  return { ok: free > need + 2 * GB && gpuFree > need, need, names: loaded.map((r) => r.model?.name).filter(Boolean).join(', ') };
}

let helpText = null;
onSdEngineChange(() => (helpText = null)); // a new engine: what it can do is read again
async function cliHelp(bin) {
  if (helpText == null) helpText = await run(bin, ['--help'], { timeout: 20000, withStderr: true });
  return helpText;
}

// The photos that come with a request, in order: each one from the page (a data URL) or from the Pictures gallery.
// The old form with a single start picture (picture / image) still works.
function photoList(opts) {
  const list = Array.isArray(opts.photos) ? opts.photos : opts.picture || opts.image ? [{ picture: opts.picture, image: opts.image }] : [];
  return list.filter((x) => x && typeof x === 'object' && (x.picture || x.image));
}

// One photo saved in the job's folder (a gallery picture is used where it is). Returns its path.
function savePhoto(item, dir, name) {
  if (item.picture) {
    const p = imagePath(item.picture);
    if (!p) throw Object.assign(new Error(t('That picture is no longer in the gallery.')), { status: 400 });
    return p;
  }
  const m = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(item.image || ''));
  if (!m) throw Object.assign(new Error(t('Choose a PNG, JPEG or WebP picture.')), { status: 400 });
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > 30e6) throw Object.assign(new Error(t('The picture is too big (30 MB at most).')), { status: 413 });
  const p = path.join(dir, `${name}.${m[1] === 'jpeg' ? 'jpg' : m[1]}`);
  fs.writeFileSync(p, buf);
  return p;
}

// "--offload-to-cpu" keeps the weights in ordinary memory and copies them to the graphics card when needed. That
// suits a PC, where the two are separate. On a Mac they are the same memory, so the copy only doubles the use: videos
// ran into swap and took twice as long. A newer engine (it knows the HyperFlow presets) places the weights by itself;
// there the flag is left out on such computers. Measured on a 48 GB Mac: sampling twice as fast for LTX-2.5, and a
// reference-photo video in 19 minutes where it took 26.
export function wantsOffload(hw, help) {
  return !(hw?.unified && /hyperflow-h3-flash/.test(help || ''));
}

// The command for one video (exported for tests).
export function videoArgs({ files, prompt, negative = '', size = 'wide', seconds = 5, seed = 0, image = '', end = '', out, help = '', offload = true }) {
  const [w, h] = VIDEO_SIZES[size] || VIDEO_SIZES.wide;
  const frames = VIDEO_LENGTHS[seconds] || VIDEO_LENGTHS[5];
  const args = ['-M', 'vid_gen', '--diffusion-model', files.diffusion, '--vae', files.vae, '--audio-vae', files.audio, '--llm', files.llm,
    '-p', prompt, '--cfg-scale', '1', '--sampling-method', 'euler', '--steps', String(STEPS), '--sigmas', SIGMAS,
    '-W', String(w), '-H', String(h), '--video-frames', String(frames), '--fps', '24',
    '--hires', '--hires-upscalers-dir', path.dirname(files.upscaler), '--hires-upscaler', path.basename(files.upscaler).replace(/\.safetensors$/i, ''),
    '--hires-steps', String(HIRES_STEPS), '--hires-sigmas', HIRES_SIGMAS,
    '--vae-tiling', '-s', String(seed), '-o', out];
  if (offload) args.push('--offload-to-cpu');
  if (negative.trim()) args.push('-n', negative.slice(0, 2000));
  // A first frame, and with it a last one: the video then goes from the one to the other.
  if (image) args.push('-i', image);
  if (image && end) args.push('--end-img', end);
  if (help.includes('--flash-attn')) args.push('--flash-attn', 'auto');
  else if (help.includes('--diffusion-fa')) args.push('--diffusion-fa');
  return args;
}

// The command for one video with reference photos (MiniMax-H3 Ref2VA; exported for tests). This model is distilled:
// it runs without guidance (cfg 1), so there is nothing to leave out and no second stage.
export function refVideoArgs({ files, prompt, size = 'wide', seconds = 5, seed = 0, refs = [], out, offload = true }) {
  const [w, h] = REF_SIZES[size] || REF_SIZES.wide;
  const frames = REF_LENGTHS[seconds] || REF_LENGTHS[5];
  const args = ['-M', 'vid_gen', '--diffusion-model', files.diffusion, '--vae', files.vae, '--audio-vae', files.audio, '--llm', files.llm,
    '-p', refPrompt(prompt, refs.length), '--cfg-scale', '1', '--steps', String(REF_STEPS),
    '-W', String(w), '-H', String(h), '--video-frames', String(frames), '--fps', '24',
    '--vae-tiling', '--rng', 'cpu', '-s', String(seed), '-o', out];
  if (offload) args.push('--offload-to-cpu');
  for (const r of refs) args.push('-r', r);
  // No flash attention here, unlike LTX: with it this model turns a long full-size clip into a black picture and
  // noise (seen on a Mac at 864×480, 73 frames; shorter or smaller clips were fine), and it is no faster.
  return args;
}

export async function generateVideo(opts) {
  if (active()) throw Object.assign(new Error(t('A video is being made. Wait for it to finish.')), { status: 409 });
  if (drawing()) throw Object.assign(new Error(t('Pictures are being made. Wait for them to finish.')), { status: 409 });
  // How the photos are used: 'frames' (the first and the last frame, LTX-2.5) or 'refs' (reference photos, MiniMax-H3).
  const use = opts.use === 'refs' ? 'refs' : 'frames';
  const photos = photoList(opts).slice(0, use === 'refs' ? MAX_REFS : 2);
  const bin = await findEngine();
  const files = use === 'refs' ? installedRefFiles() : installedFiles();
  if (!bin || !files) throw Object.assign(new Error(use === 'refs' ? t('Install the video model for reference photos first.') : t('Install the video model first.')), { status: 409 });
  const help = await cliHelp(bin);
  if (!help.includes('--audio-vae') || (use === 'refs' && !canRefs(help))) throw Object.assign(new Error(t('The picture engine is too old for videos. Press Install on the Video page to update it.')), { status: 409 });
  if (use === 'refs' && !photos.length) throw Object.assign(new Error(t('Add at least one reference photo.')), { status: 400 });
  const prompt = String(opts.prompt || '').trim().slice(0, 4000);
  if (!prompt) throw Object.assign(new Error(t('Describe the video first.')), { status: 400 });
  const size = VIDEO_SIZES[opts.size] ? opts.size : 'wide';
  const seconds = VIDEO_LENGTHS[opts.seconds] ? Number(opts.seconds) : 5;
  const seed = Number.isInteger(opts.seed) && opts.seed >= 0 ? opts.seed : Math.floor(Math.random() * 2 ** 31);
  const mem = await memoryCheck(files);
  let unloaded = '';
  if (!mem.ok) {
    if (!opts.unload) throw Object.assign(new Error(t('Not enough free memory while the chat model is loaded.')), { status: 409, code: 'NEEDS_MEMORY', model: mem.names || '' });
    unloaded = mem.names || '';
    await stopEngine(); // every loaded model steps aside
  }
  const id = uid(10);
  const dir = path.join(DIRS.videos, '.work', id);
  fs.mkdirSync(dir, { recursive: true });
  let saved = [];
  try {
    saved = photos.map((ph, i) => savePhoto(ph, dir, `${use === 'refs' ? 'ref' : i ? 'end' : 'start'}-${i + 1}`));
  } catch (err) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw err;
  }
  const out = path.join(dir, 'video.webm');
  const refs = use === 'refs';
  const offload = wantsOffload(await detectHardware(), help);
  const args = refs
    ? refVideoArgs({ files, prompt, size, seconds, seed, refs: saved, out, offload })
    : videoArgs({ files, prompt, negative: String(opts.negative || ''), size, seconds, seed, image: saved[0] || '', end: saved[1] || '', out, help, offload });
  const [w, h] = refs ? REF_SIZES[size] : VIDEO_SIZES[size].map((x) => x * 2);
  // The steps the engine will count: one stage for the reference-photo model, two for LTX-2.5.
  const first = refs ? REF_STEPS : STEPS;
  const second = refs ? 0 : HIRES_STEPS;
  job = { id, state: 'loading', stage: 1, step: 0, steps: first + second, prompt, size, seconds, seed, width: w, height: h, fromPicture: !refs && saved.length > 0, toPicture: !refs && saved.length > 1, refs: refs ? saved.length : 0, startedAt: Date.now(), video: '', error: '', unloaded };
  const my = job;
  const proc = spawn(bin, args, { cwd: path.dirname(bin), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  my.proc = proc;
  let last = '';
  const onOut = (d) => {
    const s = String(d);
    last = (last + s).slice(-6000);
    for (const line of s.split(/[\r\n]+/)) {
      // Progress bars: "|=====>    | 3/8 - 12.4s/it". For LTX-2.5, 8 steps are the first stage and 3 the second; the
      // reference-photo model has one stage. Anything else after them is the decoder writing the frames.
      const m = /\|\s*(\d+)\/(\d+)\s*-/.exec(line);
      if (!m) continue;
      const step = Number(m[1]);
      const total = Number(m[2]);
      if (total === first && my.stage === 1 && step >= (my.state === 'drawing' ? my.step : 0)) Object.assign(my, { state: 'drawing', step });
      else if (second && total === second && my.step >= first - 1) Object.assign(my, { state: 'drawing', stage: 2, step: first + step });
      else if (my.state === 'drawing' && my.step >= first + second - 1) my.state = 'saving';
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
    const made = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /\.webm$/i.test(f)) : [];
    if (!made.length) {
      my.state = 'error';
      my.error = code === 0 ? t('No video was made.') : explain(last);
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    }
    // The engine can finish "successfully" with a black picture and full-volume noise (its numbers went wrong on
    // the way). Such a video is not kept: it would only hurt the ears.
    let broken = false;
    try {
      broken = soundIsBroken(splitWebm(fs.readFileSync(path.join(dir, made[0])))?.wav);
    } catch {}
    if (broken) {
      my.state = 'error';
      my.error = t('The video came out broken (a black picture and noise). Try again; if it happens again, make a shorter or smaller video.');
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    }
    const name = `${new Date().toISOString().slice(0, 10)}-${id}.webm`;
    fs.renameSync(path.join(dir, made[0]), path.join(OUT_DIR, name));
    writeJson(path.join(OUT_DIR, `${name}.json`), { prompt, negative: opts.negative || '', size, seconds, width: my.width, height: my.height, seed, fromPicture: my.fromPicture, toPicture: my.toPicture, refs: my.refs, model: my.refs ? 'MiniMax-H3 Ref2VA (Q4_K)' : 'LTX-2.5 distilled (UD-Q4_K_XL)', ms: Date.now() - my.startedAt, at: Date.now() });
    fs.rmSync(dir, { recursive: true, force: true });
    playFiles(name);
    Object.assign(my, { state: 'done', video: name, finishedAt: Date.now() });
  });
  return publicJob();
}

function explain(log) {
  if (/out of memory|failed to allocate|Insufficient Memory|kIOGPUCommandBufferCallbackErrorOutOfMemory|ErrorOutOfDeviceMemory/i.test(log)) return t('Not enough memory for this video. Try a shorter or smaller one, or close other apps.');
  const lines = log.trim().split('\n').filter((l) => /error|fail/i.test(l));
  return `${t('The video engine stopped.')} ${(lines.pop() || log.trim().split('\n').pop() || '').slice(0, 300)}`.trim();
}

export function cancelVideos() {
  if (job?.proc) {
    job.state = 'cancelled';
    job.proc.kill();
  }
  return publicJob();
}

export const videoJob = () => publicJob();

export function videoGallery(limit = 200) {
  const out = [];
  for (const f of fs.readdirSync(OUT_DIR)) {
    if (!f.endsWith('.webm')) continue;
    const meta = readJson(path.join(OUT_DIR, `${f}.json`), {});
    out.push({ name: f, url: `/videos/${f}`, ...meta, at: meta.at || fs.statSync(path.join(OUT_DIR, f)).mtimeMs });
  }
  return out.sort((a, b) => b.at - a.at).slice(0, limit);
}

export function videoPath(name) {
  const base = path.basename(String(name || ''));
  if (!/^[\w.-]+\.webm$/.test(base)) return '';
  const p = path.join(OUT_DIR, base);
  return fs.existsSync(p) ? p : '';
}

// The engine writes the sound as plain PCM, which Chrome plays but Safari and the Mac app refuse (and the whole video
// with it). For them Hearth keeps the picture alone (a WebM) and the sound (a WAV) next to the gallery, made once from
// the video without re-encoding anything; the page plays the two together. Returns what there is to play.
export function playFiles(name) {
  const src = videoPath(name);
  if (!src) return { picture: '', sound: '' };
  const picture = path.join(PLAY_DIR, path.basename(src));
  const sound = `${picture}.wav`;
  try {
    if (!fs.existsSync(picture)) {
      const parts = splitWebm(fs.readFileSync(src));
      if (!parts) return { picture: '', sound: '' };
      fs.mkdirSync(PLAY_DIR, { recursive: true });
      // Each file appears under its name only when it is whole: two players may ask at the same moment.
      const put = (file, data) => {
        const part = `${file}.${uid(6)}.part`;
        fs.writeFileSync(part, data);
        fs.renameSync(part, file);
      };
      if (parts.wav) put(sound, parts.wav);
      put(picture, parts.video);
    }
  } catch {
    return { picture: '', sound: '' };
  }
  return { picture, sound: fs.existsSync(sound) ? sound : '' };
}

// rel: "<video>.webm" for the picture, "<video>.webm.wav" for the sound.
export function videoPlayPath(rel) {
  const m = /^([\w.-]+\.webm)(\.wav)?$/.exec(String(rel || ''));
  if (!m) return '';
  const f = playFiles(m[1]);
  return m[2] ? f.sound : f.picture;
}

export function deleteVideo(name) {
  const p = videoPath(name);
  if (!p) return false;
  fs.rmSync(p, { force: true });
  fs.rmSync(`${p}.json`, { force: true });
  const play = path.join(PLAY_DIR, path.basename(p));
  fs.rmSync(play, { force: true });
  fs.rmSync(`${play}.wav`, { force: true });
  return true;
}
