// Colibri (github.com/JustVugg/colibri, Apache 2.0): a second engine for big mixture-of-experts models, chosen per
// model in its settings (experimental). It places the experts by how often they are used: the hottest on the graphics
// card (Vulkan, or CUDA on NVIDIA), warm ones in RAM, the rest read from the disk; and it keeps a conversation's state
// between turns, so an agent's next turn reads only what is new. On a 24 GB card with 62 GB of RAM its author measured
// Qwen3.8-Flash-Next writing about 50 tokens a second through Vulkan.
//
// Hearth downloads its release from GitHub (checked against the release's SHA256SUMS) and, on Windows, a private
// Python for its launcher and API gateway (python.org's embeddable package: standard library only, nothing installed
// in the system). A model's GGUF is linked, not copied (`coli import`, into Hearth's data folder), and `coli serve`
// runs it on a private port with a key only Hearth knows, as llama-server does; Hearth forwards requests to it.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { DIRS } from './settings.mjs';
import { startDownload, getDownload } from './downloads.mjs';
import { extract } from './engine-install.mjs';
import { readJson, writeJson } from './util.mjs';
import { t } from './i18n.mjs';

const REPO = 'JustVugg/colibri';
const ROOT = () => path.join(DIRS.data, 'colibri');
const MARK = () => path.join(ROOT(), 'colibri.json');
const PY_DIR = () => path.join(ROOT(), 'python');

// Windows: python.org's embeddable package (standard library only). Pinned with its SHA-256.
export const PYTHON = {
  version: '3.13.12',
  url: 'https://www.python.org/ftp/python/3.13.12/python-3.13.12-embed-amd64.zip',
  sha256: '76f238f606250c87c6beac75dccd35ee99070a13490555936abb6cb64ecce3d0',
  size: 10941233,
  pth: 'python313._pth',
};

// GGUF architectures Colibri's engines run (its docs/gguf.md, v2.1.0).
export const ARCHES = new Set(['qwen35moe', 'qwen35', 'qwen3moe', 'qwen3', 'flint', 'muse-spark', 'lfm3', 'qwen4exp', 'deepseek4', 'deepseek41', 'inkling', 'glm5-next', 'glm-dsa', 'mistral-large4', 'mimo2', 'olmoe', 'kimi-k3']);
const METAL_ARCHES = new Set(['glm-dsa', 'mistral-large4', 'inkling', 'kimi-k3']); // the macOS release's Metal engines

// Which system this is and how it talks to GitHub (tests replace them).
export const sys = { platform: process.platform, arch: process.arch, api: 'https://api.github.com', fetch: (...a) => fetch(...a) };

const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });
const discreteGpu = (hw) => (hw?.gpus || []).find((g) => !g.unified && g.vram >= 2 * 1024 ** 3) || null;

// The release file for this computer: Windows (CUDA for an NVIDIA card, else CPU + Vulkan), Apple Silicon, Linux.
export function assetName(hw) {
  if (sys.platform === 'win32' && sys.arch === 'x64') return discreteGpu(hw)?.vendor === 'nvidia' ? /windows-x86_64-cuda\.zip$/ : /windows-x86_64\.zip$/;
  if (sys.platform === 'darwin' && sys.arch === 'arm64') return /macos-arm64\.tar\.gz$/;
  if (sys.platform === 'linux' && sys.arch === 'x64') return /linux-x86_64\.tar\.gz$/;
  return null;
}

export const colibriSupports = (model) => Boolean(model?.arch && ARCHES.has(model.arch) && model.path?.toLowerCase().endsWith('.gguf'));

export function installed() {
  const m = readJson(MARK(), null);
  return m?.dir && fs.existsSync(path.join(m.dir, 'coli')) ? m : null;
}

// The Python that runs Colibri's launcher: Hearth's own on Windows (a "python" on PATH there may be the Microsoft
// Store's placeholder), python3 elsewhere.
export function pythonCommand() {
  if (sys.platform === 'win32') {
    const exe = path.join(PY_DIR(), 'python.exe');
    return fs.existsSync(exe) ? exe : '';
  }
  return 'python3';
}

let lastError = '';

export async function colibriState(hw) {
  const ins = installed();
  const job = currentJob ? getDownload(currentJob) : null;
  return {
    available: Boolean(assetName(hw)),
    installed: ins ? { tag: ins.tag, asset: ins.asset } : null,
    python: sys.platform === 'win32' ? { private: true, ready: Boolean(pythonCommand()) } : { private: false, ready: true },
    job: job && ['queued', 'downloading', 'finishing'].includes(job.state) ? job : null,
    error: job?.state === 'error' ? job.error : lastError,
  };
}

const sha256 = (file) =>
  new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file).on('data', (d) => h.update(d)).on('error', reject).on('end', () => resolve(h.digest('hex')));
  });

async function latestRelease() {
  const res = await sys.fetch(`${sys.api}/repos/${REPO}/releases/latest`, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'Hearth' }, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw bad(t('GitHub didn’t answer ({status}). Try again later.', { status: res.status }), 502);
  return res.json();
}

let currentJob = '';

// Downloads the newest release (and Python on Windows) and sets them up. Returns the download job.
export async function installColibri(hw) {
  lastError = '';
  const want = assetName(hw);
  if (!want) throw bad(t('Colibri has no ready-made build for this computer.'));
  const rel = await latestRelease();
  const asset = (rel.assets || []).find((a) => want.test(a.name));
  const sums = (rel.assets || []).find((a) => a.name === 'SHA256SUMS.txt');
  if (!asset || !sums) throw bad(t('Colibri’s newest release has no build for this computer yet.'), 502);
  const sumsRes = await sys.fetch(sums.browser_download_url, { signal: AbortSignal.timeout(20000) });
  const expected = new RegExp(`^([0-9a-f]{64})\\s+\\*?${asset.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm').exec(await sumsRes.text())?.[1];
  if (!expected) throw bad(t('Colibri’s release doesn’t list a checksum for {file}, so Hearth didn’t use it.', { file: asset.name }), 502);
  const tmp = path.join(ROOT(), '.download');
  fs.mkdirSync(tmp, { recursive: true });
  const needPython = sys.platform === 'win32' && !pythonCommand();
  const files = [{ url: asset.browser_download_url, size: asset.size, dest: path.join(tmp, asset.name) }];
  if (needPython) files.push({ url: PYTHON.url, size: PYTHON.size, dest: path.join(tmp, path.basename(PYTHON.url)) });
  const job = startDownload({
    kind: 'colibri',
    label: t('Colibri {tag}', { tag: rel.tag_name }),
    meta: { tag: rel.tag_name },
    files,
    onDone: async () => {
      try {
        await setUp({ tag: rel.tag_name, asset: asset.name, expected, archive: files[0].dest, python: needPython ? files[1].dest : '' });
      } catch (err) {
        lastError = err.message;
        throw err;
      }
    },
  });
  currentJob = job.id;
  return job;
}

// Checks what was downloaded, unpacks it, and points the private Python at Colibri's folder.
export async function setUp({ tag, asset, expected, archive, python }) {
  if ((await sha256(archive)) !== expected) throw new Error(t('The download of {file} is damaged (its checksum doesn’t match). Try again.', { file: asset }));
  if (python && (await sha256(python)) !== PYTHON.sha256) throw new Error(t('The download of {file} is damaged (its checksum doesn’t match). Try again.', { file: path.basename(python) }));
  const dir = path.join(ROOT(), tag.replace(/[^\w.-]/g, '_'));
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  await extract(archive, dir);
  // An archive with one top folder: use that folder.
  let home = dir;
  const top = fs.readdirSync(dir);
  if (!fs.existsSync(path.join(dir, 'coli')) && top.length === 1 && fs.statSync(path.join(dir, top[0])).isDirectory()) home = path.join(dir, top[0]);
  if (!fs.existsSync(path.join(home, 'coli'))) throw new Error(t('The download did not contain {name}.', { name: 'coli' }));
  if (sys.platform !== 'win32') {
    for (const f of fs.readdirSync(home)) {
      const p = path.join(home, f);
      if (fs.statSync(p).isFile() && !/\.(py|md|txt|json|html|cmd)$/i.test(f) && f !== 'LICENSE') fs.chmodSync(p, 0o755);
    }
  }
  if (python) {
    fs.rmSync(PY_DIR(), { recursive: true, force: true });
    fs.mkdirSync(PY_DIR(), { recursive: true });
    await extract(python, PY_DIR());
  }
  if (sys.platform === 'win32') writePythonPaths(home);
  writeJson(MARK(), { tag, asset, dir: home, installedAt: Date.now() });
  // Older versions go (one that is running keeps its files until Hearth restarts: Windows locks them).
  for (const d of fs.readdirSync(ROOT(), { withFileTypes: true })) {
    if (!d.isDirectory() || ['models', 'python', '.download'].includes(d.name) || path.join(ROOT(), d.name) === dir) continue;
    try {
      fs.rmSync(path.join(ROOT(), d.name), { recursive: true, force: true });
    } catch {}
  }
  for (const f of [archive, python].filter(Boolean)) fs.rmSync(f, { force: true });
}

// The embeddable Python reads its search path from its ._pth file only (not the script's folder, not PYTHONPATH),
// so Colibri's folder and its tools go there.
export function writePythonPaths(home) {
  const pth = path.join(PY_DIR(), PYTHON.pth);
  if (!fs.existsSync(path.dirname(pth))) return;
  fs.writeFileSync(pth, [PYTHON.pth.replace('._pth', '.zip'), '.', home, path.join(home, 'tools'), ''].join('\r\n'));
}

// ---- Running a model ----

const modelDir = (model) => path.join(ROOT(), 'models', model.id);

// `coli import` writes a small folder that points at the GGUF (config, tokenizer, chat template). Made again only
// when the file or Colibri changed.
export async function importModel(model, { log = () => {} } = {}) {
  const ins = installed();
  if (!ins) throw bad(t('Colibri isn’t installed yet: open the model’s settings and download it.'));
  const py = pythonCommand();
  if (!py) throw bad(t('Colibri’s Python is missing: download Colibri again in the model’s settings.'));
  const st = fs.statSync(model.path);
  const dir = modelDir(model);
  const mark = { gguf: model.path, size: st.size, mtime: Math.round(st.mtimeMs), tag: ins.tag };
  const had = readJson(path.join(dir, 'hearth.json'), null);
  if (had && JSON.stringify(had) === JSON.stringify(mark) && fs.existsSync(path.join(dir, 'gguf.json'))) return dir;
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  log(`coli import --out ${dir} ${model.path}`);
  const out = await new Promise((resolve) => {
    const p = spawn(py, [path.join(ins.dir, 'coli'), 'import', '--out', dir, model.path], { cwd: ins.dir, env: pythonEnv(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let text = '';
    const take = (d) => {
      text = `${text}${d}`.slice(-20000);
      log(String(d));
    };
    p.stdout.on('data', take);
    p.stderr.on('data', take);
    p.on('error', (err) => resolve({ code: -1, text: err.message }));
    p.on('close', (code) => resolve({ code, text }));
  });
  if (out.code !== 0 || !fs.existsSync(path.join(dir, 'gguf.json'))) {
    const why = out.text.trim().split('\n').filter(Boolean).slice(-3).join(' ').slice(0, 400);
    throw bad(t('Colibri couldn’t read this model: {detail}', { detail: why || `code ${out.code}` }), 500);
  }
  writeJson(path.join(dir, 'hearth.json'), mark);
  return dir;
}

const pythonEnv = () => ({ ...process.env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' });

// How to start `coli serve` for a model: the command, its arguments and its environment.
export function serveCommand({ model, dir, port, key, alias, ctx, hw }) {
  const ins = installed();
  const args = [path.join(ins.dir, 'coli'), 'serve', '--model', dir, '--host', '127.0.0.1', '--port', String(port), '--model-id', alias];
  if (ctx) args.push('--ctx', String(ctx));
  // One answer at a time: a request waits its turn. An agent's long turn on a slow computer can take more than the
  // default five minutes, so a bot's request behind it would fail with 429; an hour is the patience here.
  const env = { ...pythonEnv(), COLI_API_KEY: key, COLI_QUEUE_TIMEOUT: '3600' };
  const gpu = discreteGpu(hw);
  let backend = 'cpu';
  if (sys.platform === 'darwin' && METAL_ARCHES.has(model.arch)) {
    env.COLI_METAL = '1';
    env.K3_METAL = '1';
    backend = 'metal';
  } else if (gpu && sys.platform !== 'darwin') {
    if (gpu.vendor === 'nvidia' && /cuda/.test(ins.asset)) {
      env.COLI_CUDA = '1';
      backend = 'cuda';
    } else {
      env.COLI_VULKAN = '1';
      backend = 'vulkan';
    }
  }
  return { cmd: pythonCommand(), args, env, cwd: ins.dir, backend, tag: ins.tag };
}

// Requests in llama.cpp's dialect, in Colibri's: it answers only to the model name it was started with (llama-server
// takes any; apps and Hearth itself send their own, like "local"), reads the thinking switch at the top of the request
// (and would otherwise think at full depth on Qwen3.8 every time), and refuses token penalties rather than ignoring them.
export function adaptBody(body, modelId = '') {
  if (!body || typeof body !== 'object') return body;
  if (modelId) body.model = modelId;
  const kw = body.chat_template_kwargs;
  if (kw && typeof kw.enable_thinking === 'boolean' && body.enable_thinking === undefined && body.reasoning_effort === undefined) body.enable_thinking = kw.enable_thinking;
  delete body.chat_template_kwargs;
  delete body.cache_prompt;
  delete body.frequency_penalty;
  delete body.presence_penalty;
  delete body.top_k; // its Anthropic endpoint refuses it; the OpenAI one ignores it
  return body;
}
