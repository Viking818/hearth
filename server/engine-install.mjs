// Finds a llama.cpp engine (llama-server) on this computer, or downloads the right official build
// from github.com/ggml-org/llama.cpp for this system and graphics card.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { DIRS, getSettings } from './settings.mjs';
import { run, exists, IS_WIN, IS_MAC } from './util.mjs';
import { startDownload, shaOf } from './downloads.mjs';
import { t } from './i18n.mjs';

const EXE = IS_WIN ? 'llama-server.exe' : 'llama-server';

// { build, info } for an engine that starts, else { build: 0, reason } saying why it doesn't, in the user's words.
function versionOf(bin) {
  return new Promise((resolve) => {
    try {
      execFile(bin, ['--version'], { timeout: 15000, maxBuffer: 4 << 20, windowsHide: true }, (err, stdout, stderr) => {
        const out = `${stdout || ''}${stderr || ''}`;
        // Old builds print "version: 9740 (hash)", newer ones "version: 0.8.0-dev (build 12064, commit …)".
        const build = Number(/\bbuild (\d+)/.exec(out)?.[1] || /version:\s*(\d+)\s*\(/.exec(out)?.[1]) || 0;
        const info = out.trim().split('\n').filter((l) => /version|built/.test(l)).join(' · ');
        if (build) return resolve({ build, info });
        // It ran but didn't say its build (e.g. built from a copy without history): fine when engine.json knows it.
        if (!err && info) return resolve({ build: 0, ran: true, info });
        resolve({ build: 0, reason: whyNotStarting(err, out) });
      });
    } catch (err) {
      resolve({ build: 0, reason: String(err.message || err) });
    }
  });
}

function whyNotStarting(err, out) {
  const code = err?.code;
  // Windows' own codes: a library the program needs is missing (0xC0000135), or is the wrong kind (0xC000007B).
  if (code === 3221225781 || code === -1073741515) return t('a file it needs is missing (often the graphics driver is too old)');
  if (code === 3221225595 || code === -1073741701) return t('a file it needs does not fit this computer');
  if (err?.killed) return t('it did not answer');
  const last = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).pop();
  if (last) return last.slice(0, 200);
  return typeof code === 'number' ? t('it stopped at once (code {code})', { code }) : t('it could not start');
}

// Finds a program by name in a folder tree (unpacked archives nest them differently).
export function findProgram(dir, exe, depth = 3) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return '';
  }
  for (const e of entries) if (e.isFile() && e.name === exe) return path.join(dir, e.name);
  if (depth > 0) for (const e of entries) if (e.isDirectory()) {
    const hit = findProgram(path.join(dir, e.name), exe, depth - 1);
    if (hit) return hit;
  }
  return '';
}

// Every engine we can use, newest first. Downloaded ones remember their backend in engine.json.
let listCache = { at: 0, list: null, broken: [] };

export async function listEngines(force = false) {
  // Every call asks each engine for its version, so keep the answer for a little while.
  if (!force && listCache.list && Date.now() - listCache.at < 15000) return listCache.list;
  const broken = [];
  const list = await findEngines(broken);
  listCache = { at: Date.now(), list, broken };
  return list;
}

// Downloaded engines that don't start on this computer, with the reason: [{ path, backend, reason }].
export function brokenEngines() {
  return listCache.broken || [];
}

async function findEngines(broken = []) {
  const found = [];
  // known: the llama.cpp build a download is made from (AMD's builds say it in their notes, not always in the program).
  const add = async (bin, source, backend = '', known = null) => {
    if (!bin || !exists(bin) || found.some((e) => e.path === bin)) return;
    const v = await versionOf(bin);
    const build = known?.build || v.build;
    if (build && (v.build || v.ran)) found.push({ path: bin, source, backend, build, info: v.info, from: known?.from || '' });
    else if (source === 'downloaded') broken.push({ path: bin, backend, reason: v.reason || t('it could not start') });
  };
  const custom = getSettings().enginePath;
  if (custom) await add(custom, 'custom');
  let dirs = [];
  try {
    dirs = fs.readdirSync(DIRS.engines, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith('.'));
  } catch {}
  for (const d of dirs) {
    const dir = path.join(DIRS.engines, d.name);
    let info = {};
    try {
      info = JSON.parse(fs.readFileSync(path.join(dir, 'engine.json'), 'utf8'));
    } catch {}
    await add(findProgram(dir, EXE), 'downloaded', info.backend || '', info.from === 'amd' ? { build: Number(info.build) || 0, from: 'amd' } : null);
  }
  const which = (await run(IS_WIN ? 'where' : 'which', [EXE])).trim().split(/\r?\n/)[0];
  await add(which, 'system', IS_MAC ? 'metal' : '');
  for (const p of IS_MAC ? ['/opt/homebrew/bin/llama-server', '/usr/local/bin/llama-server'] : IS_WIN ? [] : ['/usr/local/bin/llama-server', '/usr/bin/llama-server']) await add(p, 'system', IS_MAC ? 'metal' : '');
  return found.sort((a, b) => (a.source === 'custom' ? -1 : 0) - (b.source === 'custom' ? -1 : 0) || b.build - a.build);
}

// Does this engine build know a model architecture (e.g. "qwen4exp")? llama.cpp keeps the names as plain strings
// in its library, so we look for them there. Unknown (no library found) counts as yes.
const archCache = new Map();
export function engineKnowsArch(bin, arch) {
  if (!arch) return true;
  let real = bin;
  try {
    real = fs.realpathSync(bin);
  } catch {}
  const key = `${real}|${arch}`;
  if (archCache.has(key)) return archCache.get(key);
  const dirs = [path.dirname(real), path.join(path.dirname(real), '..', 'lib')];
  const files = [];
  for (const d of dirs) {
    try {
      for (const f of fs.readdirSync(d)) if (/^(lib)?llama[\w.-]*\.(dylib|so[\d.]*|dll)$/i.test(f)) files.push(path.join(d, f));
    } catch {}
  }
  if (!files.length) files.push(real); // static build: the names are in the program itself
  const needle = Buffer.from(`\0${arch}\0`);
  let found = false;
  let readAny = false;
  for (const f of files) {
    try {
      if (fs.lstatSync(f).isSymbolicLink()) continue;
      readAny = true;
      if (fs.readFileSync(f).includes(needle)) {
        found = true;
        break;
      }
    } catch {}
  }
  const ok = found || !readAny;
  archCache.set(key, ok);
  return ok;
}

// Asset name patterns of the official builds, per system and backend.
export function assetPatterns(hw, backend) {
  const arm = hw.arch === 'arm64';
  if (hw.os === 'darwin') return [arm ? /-bin-macos-arm64\.(tar\.gz|zip)$/ : /-bin-macos-x64\.(tar\.gz|zip)$/];
  if (hw.os === 'win32') {
    const cpu = arm ? /-bin-win-cpu-arm64\.zip$/ : /-bin-win-cpu-x64\.zip$/;
    if (backend === 'cuda') {
      const nv = hw.gpus.find((g) => g.vendor === 'nvidia');
      const driver = Number(String(nv?.driver || '').split('.')[0]) || 0;
      // CUDA 13 builds need a recent driver; RTX 50 cards need at least CUDA 12.8.
      const new13 = driver >= 580 || /rtx\s*50/i.test(nv?.name || '');
      return [new13 ? /-bin-win-cuda-13[\d.]*-x64\.zip$/ : /-bin-win-cuda-12[\d.]*-x64\.zip$/, /-bin-win-cuda-[\d.]+-x64\.zip$/, /-bin-win-vulkan-x64\.zip$/, cpu];
    }
    if (backend === 'rocm') return [/-bin-win-(rocm|hip)[^/]*-x64\.zip$/, /-bin-win-vulkan-x64\.zip$/, cpu];
    if (backend === 'vulkan') return [arm ? /-bin-win-vulkan-arm64\.zip$/ : /-bin-win-vulkan-x64\.zip$/, cpu];
    return [cpu];
  }
  // Linux
  const cpu = arm ? /-bin-ubuntu-arm64\.(tar\.gz|zip)$/ : /-bin-ubuntu-x64\.(tar\.gz|zip)$/;
  if (backend === 'cuda') return [arm ? /-bin-ubuntu-cuda-[\d.]+-arm64\.tar\.gz$/ : /-bin-ubuntu-cuda-13[\d.]*-x64\.tar\.gz$/, /-bin-ubuntu-cuda-[\d.]+-x64\.tar\.gz$/, /-bin-ubuntu-vulkan-x64\.tar\.gz$/, cpu];
  if (backend === 'rocm') return [/-bin-ubuntu-rocm[^/]*-x64\.tar\.gz$/, /-bin-ubuntu-vulkan-x64\.tar\.gz$/, cpu];
  if (backend === 'vulkan') return [arm ? /-bin-ubuntu-vulkan-arm64\.tar\.gz$/ : /-bin-ubuntu-vulkan-x64\.tar\.gz$/, cpu];
  return [cpu];
}

export function pickAsset(assets, hw, backend) {
  for (const re of assetPatterns(hw, backend)) {
    const a = assets.find((x) => re.test(x.name) && !x.name.startsWith('cudart'));
    if (a) {
      // Windows CUDA builds need NVIDIA's runtime DLLs next to them.
      const cuda = /-win-cuda-([\d.]+)-(x64|arm64)\.zip$/.exec(a.name);
      const extra = cuda ? assets.find((x) => x.name === `cudart-llama-bin-win-cuda-${cuda[1]}-${cuda[2]}.zip`) : null;
      return { asset: a, extra };
    }
  }
  return null;
}

let releaseCache = { at: 0, list: [] };

async function releases() {
  if (Date.now() - releaseCache.at < 3600e3 && releaseCache.list.length) return releaseCache.list;
  const res = await fetch('https://api.github.com/repos/ggml-org/llama.cpp/releases?per_page=10', {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'Hearth' },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(t('GitHub said {status}', { status: res.status }));
  const list = (await res.json()).filter((r) => /^b\d+$/.test(r.tag_name) && r.assets?.length > 5);
  releaseCache = { at: Date.now(), list };
  return list;
}

// ---- AMD's ready-made ROCm builds (github.com/lemonade-sdk/llamacpp-rocm) ----
// llama.cpp's own Windows ROCm build no longer carries AMD's math libraries (hipBLAS, rocBLAS, rocSOLVER): without a
// separate ROCm install it finds no graphics card. AMD's Lemonade project builds the same llama.cpp per chip family
// with everything inside (its release check: "self-contained, no library from outside the archive"), like Strata's
// own engine packages. So for AMD ROCm on Windows and Linux, Hearth takes those, and llama.cpp's only as a fallback.
const AMD_REPO = 'lemonade-sdk/llamacpp-rocm';
let amdCache = { at: 0, list: [] };

async function amdReleases() {
  if (Date.now() - amdCache.at < 3600e3 && amdCache.list.length) return amdCache.list;
  const res = await fetch(`https://api.github.com/repos/${AMD_REPO}/releases?per_page=5`, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'Hearth' },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(t('GitHub said {status}', { status: res.status }));
  amdCache = { at: Date.now(), list: await res.json() };
  return amdCache.list;
}

// The newest AMD build for this computer's chip family: { rel, asset, sha } or null.
export function pickAmdBuild(list, hw) {
  const family = (hw.gpus || []).find((g) => g.vendor === 'amd' && g.family)?.family;
  if (!family || (hw.os !== 'win32' && hw.os !== 'linux') || hw.arch !== 'x64') return null;
  const os = hw.os === 'win32' ? 'windows' : 'ubuntu';
  for (const rel of list || []) {
    if (rel.draft || rel.prerelease) continue;
    const asset = (rel.assets || []).find((a) => a.name === `llama-${rel.tag_name}-${os}-rocm-${family}-x64.zip`);
    if (!asset) continue;
    const sha = /Llama\.cpp Commit \(full\)\*\*:\s*([0-9a-f]{40})/i.exec(rel.body || '')?.[1] || '';
    return { rel, asset, sha, family, os };
  }
  return null;
}

// Which llama.cpp build a commit is, counted from the nearest official release (their numbers count commits).
const buildCache = new Map();
async function buildOfCommit(sha) {
  if (!sha) return 0;
  if (buildCache.has(sha)) return buildCache.get(sha);
  let build = 0;
  try {
    const tag = (await releases())[0]?.tag_name;
    const res = await fetch(`https://api.github.com/repos/ggml-org/llama.cpp/compare/${tag}...${sha}`, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'Hearth' },
      signal: AbortSignal.timeout(20000),
    });
    const j = res.ok ? await res.json() : {};
    const base = Number(String(tag).slice(1)) || 0;
    if (j.status === 'identical') build = base;
    else if (j.status === 'ahead') build = base + j.ahead_by;
    else if (j.status === 'behind') build = base - j.behind_by;
  } catch {}
  if (build) buildCache.set(sha, build);
  return build;
}

async function latestAmdEngine(hw) {
  const pick = pickAmdBuild(await amdReleases(), hw);
  if (!pick) return null;
  // Not countable (GitHub busy): the newest official number, so updates still compare sensibly.
  const build = (await buildOfCommit(pick.sha)) || Number(String((await releases().catch(() => []))[0]?.tag_name || '').slice(1)) || 0;
  return {
    tag: `amd-${pick.rel.tag_name}`,
    build,
    variant: `${pick.os}-rocm-${pick.family}-x64`,
    backend: 'rocm',
    from: 'amd',
    files: [{ name: pick.asset.name, url: pick.asset.browser_download_url, size: pick.asset.size, sha256: shaOf(pick.asset) }],
    size: pick.asset.size,
  };
}

// The newest official build for this computer.
export async function latestEngine(hw, backend) {
  if (backend === 'rocm') {
    const amd = await latestAmdEngine(hw).catch(() => null);
    if (amd) return amd;
  }
  for (const rel of await releases()) {
    const pick = pickAsset(rel.assets, hw, backend);
    if (pick) {
      const variant = pick.asset.name.replace(/^llama-b\d+-bin-/, '').replace(/\.(tar\.gz|zip)$/, '');
      return {
        tag: rel.tag_name,
        build: Number(rel.tag_name.slice(1)),
        variant,
        backend: /cuda/.test(variant) ? 'cuda' : /rocm|hip/.test(variant) ? 'rocm' : /vulkan/.test(variant) ? 'vulkan' : /macos/.test(variant) ? 'metal' : 'cpu',
        files: [pick.asset, pick.extra].filter(Boolean).map((a) => ({ name: a.name, url: a.browser_download_url, size: a.size, sha256: shaOf(a) })),
        size: pick.asset.size + (pick.extra?.size || 0),
      };
    }
  }
  return null;
}

export function extract(archive, dest) {
  return new Promise((resolve, reject) => {
    // `tar` reads .tar.gz everywhere, and .zip too on macOS and Windows 10+; Linux zips go through unzip.
    const useUnzip = archive.endsWith('.zip') && process.platform === 'linux';
    const p = useUnzip ? spawn('unzip', ['-oq', archive, '-d', dest]) : spawn('tar', ['-xf', archive, '-C', dest], { windowsHide: true });
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(t('Could not unpack {file}: {err}', { file: path.basename(archive), err: err.trim() })))));
  });
}

// Deletes downloaded engines that `test(engineJson, folderName)` picks (never one that is running: Windows locks it).
function removeEngines(test) {
  let dirs = [];
  try {
    dirs = fs.readdirSync(DIRS.engines, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith('.'));
  } catch {}
  for (const d of dirs) {
    let info = {};
    try {
      info = JSON.parse(fs.readFileSync(path.join(DIRS.engines, d.name, 'engine.json'), 'utf8'));
    } catch {
      continue;
    }
    if (!test(info, d.name)) continue;
    try {
      fs.rmSync(path.join(DIRS.engines, d.name), { recursive: true, force: true });
    } catch {}
  }
}

export async function installEngine(hw, backend) {
  const rel = await latestEngine(hw, backend);
  if (!rel) throw new Error(t('No ready-made engine for this system. Install llama.cpp yourself and pick it in Settings.'));
  const dir = path.join(DIRS.engines, `${rel.tag}-${rel.variant}`);
  const tmp = path.join(DIRS.engines, '.download');
  return startDownload({
    kind: 'engine',
    label: t('Engine {tag} ({variant})', { tag: rel.tag, variant: rel.variant }),
    meta: { tag: rel.tag, variant: rel.variant, backend: rel.backend },
    files: rel.files.map((f) => ({ url: f.url, size: f.size, sha256: f.sha256, dest: path.join(tmp, f.name) })), // checked against GitHub's checksum
    onDone: async () => {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.mkdirSync(dir, { recursive: true });
      for (const f of rel.files) await extract(path.join(tmp, f.name), dir);
      const bin = findProgram(dir, EXE);
      if (!bin) throw new Error(t('The download did not contain {name}.', { name: 'llama-server' }));
      // CUDA runtime DLLs must sit next to the program.
      if (IS_WIN && path.dirname(bin) !== dir) {
        for (const f of fs.readdirSync(dir)) if (/\.dll$/i.test(f)) fs.copyFileSync(path.join(dir, f), path.join(path.dirname(bin), f));
      }
      if (!IS_WIN) fs.chmodSync(bin, 0o755);
      fs.writeFileSync(path.join(dir, 'engine.json'), JSON.stringify({ tag: rel.tag, variant: rel.variant, backend: rel.backend, from: rel.from || 'llama.cpp', build: rel.build, installedAt: Date.now() }, null, 2));
      for (const f of rel.files) fs.rmSync(path.join(tmp, f.name), { force: true });
      // AMD's complete build replaces llama.cpp's own ROCm builds, which can't find the card without a separate install.
      if (rel.from === 'amd') removeEngines((info, name) => info.backend === 'rocm' && info.from !== 'amd' && name !== path.basename(dir));
      listCache = { at: 0, list: null, broken: [] };
    },
  });
}
