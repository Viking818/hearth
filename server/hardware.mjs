// What computer are we on? Chip, memory and graphics cards, plus live load numbers for the monitor.
// Works without admin rights on Mac, Windows and Linux. Anything we can't read is left out, never guessed.
import fs from 'node:fs';
import os from 'node:os';
import { spawn, execFile } from 'node:child_process';
import { run, GB, IS_MAC, IS_WIN } from './util.mjs';

function vendorOf(name = '') {
  const n = name.toLowerCase();
  if (/nvidia|geforce|rtx|gtx|quadro|tesla/.test(n)) return 'nvidia';
  if (/amd|radeon|ati /.test(n)) return 'amd';
  if (/intel|arc /.test(n)) return 'intel';
  if (/apple/.test(n)) return 'apple';
  return 'other';
}

// RDNA3/RDNA4 cards (RX 7000/9000, Radeon AI PRO, Strix Halo) are the ones the ROCm build supports well.
function amdGeneration(name = '') {
  const n = name.toLowerCase();
  if (/rx\s*9\d{3}|r9700|ai pro/.test(n)) return 'rdna4';
  if (/rx\s*7\d{3}|8060s|8050s|890m|880m|780m|760m|w7\d{3}/.test(n)) return 'rdna3';
  if (/rx\s*6\d{3}|w6\d{3}/.test(n)) return 'rdna2';
  return '';
}

// The chip family that AMD's ready-made ROCm builds of llama.cpp are made for (github.com/lemonade-sdk/llamacpp-rocm):
// RX 7000 and the 780M/760M are gfx110X, RX 9000 gfx120X, Strix Halo (8060S/8050S) gfx1151, the 890M/880M gfx1150,
// the 860M/840M gfx1152, and RX 6000 gfx103X. Empty when not known.
export function amdFamily(name = '') {
  const n = name.toLowerCase();
  if (/rx\s*9\d{3}|r9700|ai pro/.test(n)) return 'gfx120X';
  if (/rx\s*7\d{3}|w7\d{3}|780m|760m|740m/.test(n)) return 'gfx110X';
  if (/8060s|8050s|8040s/.test(n)) return 'gfx1151';
  if (/890m|880m/.test(n)) return 'gfx1150';
  if (/860m|840m|820m/.test(n)) return 'gfx1152';
  if (/rx\s*6\d{3}|w6\d{3}/.test(n)) return 'gfx103X';
  return '';
}

async function macInfo() {
  const [cpu, gpuRaw, wired, perf] = await Promise.all([
    run('sysctl', ['-n', 'machdep.cpu.brand_string']),
    run('ioreg', ['-r', '-d', '1', '-c', 'IOAccelerator']),
    run('sysctl', ['-n', 'iogpu.wired_limit_mb']),
    run('sysctl', ['-n', 'hw.perflevel0.physicalcpu']), // the fast cores (llama.cpp works on these)
  ]);
  const model = /"model" = "([^"]+)"/.exec(gpuRaw)?.[1] || cpu.trim();
  const cores = Number(/"gpu-core-count" = (\d+)/.exec(gpuRaw)?.[1]) || 0;
  const ram = os.totalmem();
  // macOS lets the GPU use about 3/4 of memory on big Macs and about 2/3 on small ones,
  // unless the user raised the limit with `sudo sysctl iogpu.wired_limit_mb=…`.
  const wiredMb = Number(wired.trim()) || 0;
  const budget = wiredMb > 0 ? wiredMb * 1024 * 1024 : ram * (ram >= 36 * GB ? 0.75 : 0.66);
  return {
    cpuName: cpu.trim(),
    perfCores: Number(perf.trim()) || 0,
    gpus: [{ name: model, vendor: 'apple', vram: budget, cores, unified: true }],
    unified: true,
    gpuBudget: budget,
  };
}

async function nvidiaGpus() {
  const out = await run('nvidia-smi', ['--query-gpu=name,memory.total,driver_version', '--format=csv,noheader,nounits']);
  return out
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [name, mem, driver] = line.split(',').map((s) => s.trim());
      return { name, vendor: 'nvidia', vram: Number(mem) * 1024 * 1024, driver };
    });
}

async function windowsGpus() {
  // AdapterRAM is capped at 4 GB, so the real size comes from the driver's registry entry.
  const ps = `
$r = @()
Get-ChildItem 'HKLM:\\SYSTEM\\ControlSet001\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}' -ErrorAction SilentlyContinue | ForEach-Object {
  $p = Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue
  if ($p.DriverDesc) { $r += [pscustomobject]@{ name = $p.DriverDesc; mem = $p.'HardwareInformation.qwMemorySize'; driver = $p.DriverVersion } }
}
$r | ConvertTo-Json -Compress`;
  const out = await run('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { timeout: 15000 });
  let list = [];
  try {
    const j = JSON.parse(out.trim() || '[]');
    list = (Array.isArray(j) ? j : [j]).map((g) => ({ name: g.name, vendor: vendorOf(g.name), vram: Number(g.mem) || 0, driver: g.driver }));
  } catch {}
  return list.filter((g) => !/basic display|remote|virtual|parsec|meta/i.test(g.name));
}

async function linuxGpus() {
  const list = [];
  let drm = [];
  try {
    drm = fs.readdirSync('/sys/class/drm').filter((d) => /^card\d+$/.test(d));
  } catch {}
  for (const card of drm) {
    const dev = `/sys/class/drm/${card}/device`;
    const read = (f) => {
      try {
        return fs.readFileSync(`${dev}/${f}`, 'utf8').trim();
      } catch {
        return '';
      }
    };
    const vendorId = read('vendor');
    if (vendorId === '0x10de') continue; // NVIDIA is read through nvidia-smi
    const vram = Number(read('mem_info_vram_total')) || 0;
    const vendor = vendorId === '0x1002' ? 'amd' : vendorId === '0x8086' ? 'intel' : 'other';
    if (vendor === 'other' || (!vram && vendor !== 'intel')) continue;
    const name = read('product_name') || (vendor === 'amd' ? 'AMD Radeon' : 'Intel graphics');
    list.push({ name, vendor, vram });
  }
  return list;
}

let cached = null;

export async function detectHardware(force = false) {
  if (cached && !force) return cached;
  const ram = os.totalmem();
  const cpus = os.cpus();
  const base = {
    os: process.platform,
    osName: IS_MAC ? 'macOS' : IS_WIN ? 'Windows' : 'Linux',
    arch: process.arch,
    cpuName: cpus[0]?.model?.trim() || '',
    threads: cpus.length,
    ram,
    gpus: [],
    unified: false,
    gpuBudget: 0,
  };
  let info = {};
  if (IS_MAC) info = await macInfo();
  else {
    const nv = await nvidiaGpus();
    const others = IS_WIN ? (await windowsGpus()).filter((g) => g.vendor !== 'nvidia' || !nv.length) : await linuxGpus();
    const gpus = [...nv, ...others].filter((g) => g.vendor !== 'other');
    for (const g of gpus) if (g.vendor === 'amd') Object.assign(g, { generation: amdGeneration(g.name), family: amdFamily(g.name) });
    // Integrated chips share RAM; only count real graphics memory for the GPU budget.
    const dedicated = gpus.filter((g) => g.vram >= 2 * GB);
    info = { gpus, gpuBudget: dedicated.reduce((s, g) => s + g.vram, 0) };
  }
  cached = { ...base, ...info, cpuName: info.cpuName || base.cpuName, budgetSource: 'estimate' };
  cached.backend = pickBackend(cached);
  applyEngineDevices();
  return cached;
}

// The engine knows the real GPU memory: `llama-server --list-devices` prints lines like
// "MTL0: Apple M3 Max (38338 MiB, 38338 MiB free)". On a Mac that is macOS's own limit for one program
// (40.2 GB on a 48 GB M3 Max, more than the 3/4 rule of thumb), on PCs the graphics card's memory.
let engineDevices = null; // { bin, devices: [{ id, name, total, free }] } of the engine in use
const deviceLists = new Map(); // engine path → { devices, note }, once that engine has answered

// The graphics cards an engine can use, and when it sees none, its own line saying why (for example the ROCm build
// with an AMD driver too old for it: "failed to initialize ROCm: no ROCm-capable device is detected").
// Null when it didn't answer in time (the first start of a big GPU build can be slow): not known yet.
export async function listEngineDevices(bin, timeout = 90000) {
  if (!bin) return { devices: [], note: '' };
  if (deviceLists.has(bin)) return deviceLists.get(bin);
  const res = await queryEngineDevices(bin, timeout);
  if (res) deviceLists.set(bin, res);
  return res;
}

// Ask the engine right now (not remembered): its graphics cards, with how much of their memory is free at this moment.
export function queryEngineDevices(bin, timeout = 90000) {
  if (!bin) return Promise.resolve({ devices: [], note: '' });
  return new Promise((resolve) => {
    try {
      execFile(bin, ['--list-devices'], { timeout, maxBuffer: 4 << 20, windowsHide: true }, (err, stdout, stderr) => {
        if (err?.killed) return resolve(null);
        const out = `${stdout || ''}\n${stderr || ''}`;
        const devices = parseDeviceList(out);
        const why = devices.length ? '' : out.split(/\r?\n/).map((l) => l.trim()).find((l) => /no [\w-]+(-capable)? devices?|failed to (load|initiali[sz]e)|not supported|unsupported|error/i.test(l));
        resolve({ devices, note: (why || '').slice(0, 200) });
      });
    } catch {
      resolve(null);
    }
  });
}

// Real graphics cards only: integrated chips also show up, with a slice of the computer's memory.
export const realCards = (devs) => devs.filter((d) => d.total >= 2 * GB && !/integrated|uhd|iris|radeon\(tm\) graphics|780m|760m|680m|890m|880m/i.test(d.name));

// What is known so far about an engine's graphics cards, without asking it.
export const knownEngineDevices = (bin) => deviceLists.get(bin) || null;

export async function readEngineDevices(bin, timeout) {
  if (!bin) return [];
  const devices = (await listEngineDevices(bin, timeout))?.devices || [];
  if (engineDevices?.bin !== bin) {
    engineDevices = { bin, devices };
    applyEngineDevices();
  }
  return devices;
}

export function parseDeviceList(out) {
  const devices = [];
  for (const line of String(out).split('\n')) {
    const m = /^\s*([\w.-]+):\s*(.+?)\s*\((\d+) MiB,\s*(\d+) MiB free\)/.exec(line);
    if (m && Number(m[3]) > 0 && !/^(BLAS|CPU)/i.test(m[1])) devices.push({ id: m[1], name: m[2], total: Number(m[3]) * 1024 * 1024, free: Number(m[4]) * 1024 * 1024 });
  }
  return devices;
}

function applyEngineDevices() {
  const devs = engineDevices?.devices || [];
  if (!cached || !devs.length) return;
  if (cached.unified) {
    cached.gpuBudget = devs[0].total;
    if (cached.gpus[0]) cached.gpus[0].vram = devs[0].total;
    cached.budgetSource = 'engine';
  } else {
    const cards = realCards(devs);
    if (cards.length) {
      cached.gpuBudget = cards.reduce((s, d) => s + d.total, 0);
      cached.budgetSource = 'engine';
    }
  }
}

// The llama.cpp build that suits this computer best.
export function pickBackend(hw) {
  if (hw.os === 'darwin') return 'metal';
  const gpus = hw.gpus || [];
  if (gpus.some((g) => g.vendor === 'nvidia')) return 'cuda';
  // AMD: Vulkan runs on every Radeon with just the normal driver. The ROCm (HIP) build reads long prompts
  // faster on RX 7000/9000 cards and can be picked on the Models page.
  if (gpus.some((g) => g.vendor === 'amd')) return 'vulkan';
  if (gpus.some((g) => g.vendor === 'intel' && g.vram >= 2 * GB)) return 'vulkan';
  return 'cpu';
}

// Builds that make sense on this computer, best first.
export function backendChoices(hw) {
  if (hw.os === 'darwin') return ['metal'];
  const gpus = hw.gpus || [];
  const out = [];
  if (gpus.some((g) => g.vendor === 'nvidia')) out.push('cuda');
  if (gpus.some((g) => g.vendor === 'amd')) out.push('vulkan', 'rocm');
  if (gpus.some((g) => g.vendor === 'intel') && !out.includes('vulkan')) out.push('vulkan');
  if (!out.includes('vulkan') && out.length) out.push('vulkan');
  out.push('cpu');
  return out;
}

export const BACKEND_LABELS = {
  metal: 'Apple Metal',
  cuda: 'NVIDIA CUDA',
  rocm: 'AMD ROCm (HIP)',
  vulkan: 'Vulkan',
  cpu: 'CPU only',
};

// ---- Live numbers for the monitor ----

let lastCpu = null;
function cpuPercent() {
  const now = os.cpus().map((c) => c.times);
  let pct = null;
  if (lastCpu && lastCpu.length === now.length) {
    let idle = 0;
    let total = 0;
    now.forEach((t, i) => {
      const p = lastCpu[i];
      const sum = (x) => x.user + x.nice + x.sys + x.idle + x.irq;
      total += sum(t) - sum(p);
      idle += t.idle - p.idle;
    });
    pct = total > 0 ? Math.round(100 * (1 - idle / total)) : 0;
  }
  lastCpu = now;
  return pct;
}

async function macMemoryUsed() {
  // os.freemem() on a Mac leaves out cached memory and looks almost full; vm_stat gives the real picture.
  const out = await run('vm_stat');
  const pageSize = Number(/page size of (\d+)/.exec(out)?.[1]) || 16384;
  const pages = (label) => Number(new RegExp(`${label}:\\s+(\\d+)`).exec(out)?.[1]) || 0;
  const used = pages('Pages active') + pages('Pages wired down') + pages('Pages occupied by compressor');
  return used ? used * pageSize : os.totalmem() - os.freemem();
}

async function macGpu() {
  const out = await run('ioreg', ['-r', '-d', '1', '-c', 'IOAccelerator']);
  const util = Number(/"Device Utilization %"=(\d+)/.exec(out)?.[1]);
  const mem = Number(/"In use system memory"=(\d+)/.exec(out)?.[1]);
  return { util: Number.isFinite(util) ? util : null, memUsed: Number.isFinite(mem) ? mem : null };
}

async function nvidiaLive() {
  const out = await run('nvidia-smi', [
    '--query-gpu=utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw,power.limit',
    '--format=csv,noheader,nounits',
  ]);
  const rows = out.trim().split('\n').filter(Boolean).map((l) => l.split(',').map((s) => Number(s.trim())));
  if (!rows.length) return null;
  const sum = (i) => rows.reduce((s, r) => s + (Number.isFinite(r[i]) ? r[i] : 0), 0);
  return {
    util: Math.round(sum(0) / rows.length),
    memUsed: sum(1) * 1024 * 1024,
    memTotal: sum(2) * 1024 * 1024,
    temp: Math.max(...rows.map((r) => r[3]).filter(Number.isFinite)),
    power: Math.round(sum(4)),
    powerLimit: Math.round(sum(5)),
  };
}

function linuxAmdLive() {
  try {
    const cards = fs.readdirSync('/sys/class/drm').filter((d) => /^card\d+$/.test(d));
    let util = null;
    let used = 0;
    let total = 0;
    for (const c of cards) {
      const dev = `/sys/class/drm/${c}/device`;
      const t = Number(fs.readFileSync(`${dev}/mem_info_vram_total`, 'utf8')) || 0;
      if (!t) continue;
      total += t;
      used += Number(fs.readFileSync(`${dev}/mem_info_vram_used`, 'utf8')) || 0;
      const busy = Number(fs.readFileSync(`${dev}/gpu_busy_percent`, 'utf8'));
      if (Number.isFinite(busy)) util = Math.max(util ?? 0, busy);
    }
    return total ? { util, memUsed: used, memTotal: total } : null;
  } catch {
    return null;
  }
}

// Graphics load on Windows comes from the system's performance counters, which work for every vendor (AMD, Intel,
// NVIDIA). They are read through PowerShell, which is slow to start and costs processor time the engine needs,
// so starting one for every sample would slow answers down. Instead one PowerShell keeps running while the Monitor
// page is open and prints a line every 2 seconds; it stops when nobody has asked for a while, or when Hearth stops.
// The WMI class names are the same in every Windows language (Get-Counter only knows the local counter names).
// Like Task Manager, the load is that of the busiest engine (models run on the "Compute" engines, games on "3D"),
// each engine's load being the sum over all programs (instance names are pid_<n>_luid_…_eng_<n>_engtype_<type>).
const WIN_GPU_SCRIPT = (parent) => `$ErrorActionPreference = 'SilentlyContinue'
while (Get-Process -Id ${parent}) {
  $busy = @{}
  foreach ($x in @(Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine)) {
    $k = $x.Name -replace '^pid_\\d+_', ''
    $busy[$k] = [double]$busy[$k] + [double]$x.UtilizationPercentage
  }
  $mem = (@(Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUAdapterMemory) | Measure-Object DedicatedUsage -Sum).Sum
  if ($busy.Count -eq 0) { [Console]::Out.WriteLine('none') }
  else { [Console]::Out.WriteLine(('{0} {1}' -f [math]::Round(($busy.Values | Measure-Object -Maximum).Maximum), [math]::Round([double]$mem))) }
  Start-Sleep -Seconds 2
}`;

const winGpu = { child: null, last: null, askedAt: 0, retryAt: 0, timer: null };

export function stopWindowsGpu() {
  try {
    winGpu.child?.kill();
  } catch {}
  winGpu.child = null;
  winGpu.last = null;
  clearInterval(winGpu.timer);
  winGpu.timer = null;
}

// The latest { util, memUsed } (null until the first line), starting the sampler when needed. Exported for tests.
export function windowsGpuLive() {
  winGpu.askedAt = Date.now();
  if (!winGpu.child && Date.now() >= winGpu.retryAt) {
    const startedAt = Date.now();
    let child;
    try {
      // Passed as plain text, like the graphics card check above (antivirus programs distrust -EncodedCommand).
      // The script has no double quotes, so it reaches PowerShell as written.
      child = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', WIN_GPU_SCRIPT(process.pid)], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      winGpu.retryAt = Date.now() + 60e3;
      return null;
    }
    winGpu.child = child;
    let buf = '';
    child.stdout.on('data', (d) => {
      buf += d;
      const lines = buf.split(/\r?\n/);
      buf = lines.pop();
      const line = lines.filter((l) => l.trim()).pop();
      if (!line) return;
      const [u, m] = line.trim().split(/\s+/).map(Number);
      winGpu.last = Number.isFinite(u) ? { util: Math.min(100, u), memUsed: Number.isFinite(m) ? m : null } : null;
    });
    const gone = () => {
      if (winGpu.child !== child) return;
      winGpu.child = null;
      // It ended by itself (no PowerShell, no counters): don't try again for a minute.
      if (Date.now() - startedAt < 15e3) winGpu.retryAt = Date.now() + 60e3;
    };
    child.on('exit', gone);
    child.on('error', gone);
    if (!winGpu.timer) {
      winGpu.timer = setInterval(() => {
        if (Date.now() - winGpu.askedAt > 10e3) stopWindowsGpu();
      }, 5e3);
      winGpu.timer.unref?.();
    }
  }
  return winGpu.last;
}

if (IS_WIN) process.on('exit', stopWindowsGpu);

// gpu: false when only memory is wanted (it skips the graphics counters on Windows).
export async function liveStats(hw, enginePid, { gpu: wantGpu = true } = {}) {
  const cpu = cpuPercent();
  const ramTotal = os.totalmem();
  const ramUsed = IS_MAC ? await macMemoryUsed() : ramTotal - os.freemem();
  let gpu = null;
  if (!wantGpu) gpu = null;
  else if (IS_MAC) gpu = { ...(await macGpu()), memTotal: hw.gpuBudget };
  else if (hw.gpus.some((g) => g.vendor === 'nvidia')) gpu = await nvidiaLive();
  else if (process.platform === 'linux') gpu = linuxAmdLive();
  else if (IS_WIN) {
    const g = windowsGpuLive();
    gpu = g && { ...g, memTotal: hw.gpuBudget };
  }
  let engineMem = null;
  if (enginePid && !IS_WIN) {
    const rss = Number((await run('ps', ['-o', 'rss=', '-p', String(enginePid)])).trim());
    if (rss) engineMem = rss * 1024;
  }
  return { cpu, ramUsed, ramTotal, gpu, engineMem };
}
