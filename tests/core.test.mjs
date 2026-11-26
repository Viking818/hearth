// Run with: npm test  (node --test). No GPU, model or network needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.HEARTH_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-test-'));
const { pickAsset } = await import('../server/engine-install.mjs');
const { pickBackend, backendChoices } = await import('../server/hardware.mjs');
const { quantOf } = await import('../server/models.mjs');
const { quantsOf, fitFor } = await import('../server/catalog.mjs');
const { readGgufMeta } = await import('../server/gguf.mjs');
const { renderMarkdown, previewFrom } = await import('../public/js/md.js');

const GB = 1024 ** 3;
// Asset names as published on github.com/ggml-org/llama.cpp/releases (build b12064).
const ASSETS = [
  'cudart-llama-bin-win-cuda-12.4-x64.zip', 'cudart-llama-bin-win-cuda-13.4-x64.zip',
  'llama-b12064-bin-macos-arm64.tar.gz', 'llama-b12064-bin-macos-x64.tar.gz',
  'llama-b12064-bin-ubuntu-x64.tar.gz', 'llama-b12064-bin-ubuntu-vulkan-x64.tar.gz', 'llama-b12064-bin-ubuntu-rocm-10.0-x64.tar.gz',
  'llama-b12064-bin-ubuntu-cuda-12.8-x64.tar.gz', 'llama-b12064-bin-ubuntu-cuda-13.4-x64.tar.gz',
  'llama-b12064-bin-win-cpu-x64.zip', 'llama-b12064-bin-win-cuda-12.4-x64.zip', 'llama-b12064-bin-win-cuda-13.4-x64.zip',
  'llama-b12064-bin-win-rocm-10.0-x64.zip', 'llama-b12064-bin-win-vulkan-x64.zip', 'llama-b12064-bin-win-vulkan-arm64.zip',
].map((name) => ({ name, size: 1, browser_download_url: `https://example/${name}` }));

const win = (gpus) => ({ os: 'win32', arch: 'x64', gpus });
const amd7900 = { name: 'AMD Radeon RX 7900 XTX', vendor: 'amd', vram: 24 * GB, generation: 'rdna3' };

test('Mac gets the Metal build', () => {
  assert.equal(pickAsset(ASSETS, { os: 'darwin', arch: 'arm64', gpus: [] }, 'metal').asset.name, 'llama-b12064-bin-macos-arm64.tar.gz');
});

test('Windows + AMD Radeon RX 7000: Vulkan by default, ROCm on request', () => {
  const hw = win([amd7900]);
  assert.equal(pickBackend(hw), 'vulkan');
  assert.deepEqual(backendChoices(hw), ['vulkan', 'rocm', 'cpu']);
  assert.equal(pickAsset(ASSETS, hw, 'vulkan').asset.name, 'llama-b12064-bin-win-vulkan-x64.zip');
  assert.equal(pickAsset(ASSETS, hw, 'rocm').asset.name, 'llama-b12064-bin-win-rocm-10.0-x64.zip');
});

test('Windows + NVIDIA gets CUDA plus its runtime DLLs', () => {
  const rtx50 = win([{ name: 'NVIDIA GeForce RTX 5070', vendor: 'nvidia', vram: 12 * GB, driver: '581.57' }]);
  const p = pickAsset(ASSETS, rtx50, 'cuda');
  assert.equal(p.asset.name, 'llama-b12064-bin-win-cuda-13.4-x64.zip');
  assert.equal(p.extra.name, 'cudart-llama-bin-win-cuda-13.4-x64.zip');
  const old = win([{ name: 'NVIDIA GeForce RTX 3060', vendor: 'nvidia', vram: 12 * GB, driver: '546.33' }]);
  assert.equal(pickAsset(ASSETS, old, 'cuda').asset.name, 'llama-b12064-bin-win-cuda-12.4-x64.zip');
});

test('Linux AMD and no-GPU builds', () => {
  const linux = { os: 'linux', arch: 'x64', gpus: [amd7900] };
  assert.equal(pickAsset(ASSETS, linux, 'rocm').asset.name, 'llama-b12064-bin-ubuntu-rocm-10.0-x64.tar.gz');
  assert.equal(pickAsset(ASSETS, { os: 'linux', arch: 'x64', gpus: [] }, 'cpu').asset.name, 'llama-b12064-bin-ubuntu-x64.tar.gz');
});

test('quant names come out of real Hugging Face file names', () => {
  assert.equal(quantOf('Qwen3.6-35B-A3B-UD-Q4_K_XL-00001-of-00002.gguf'), 'UD-Q4_K_XL');
  assert.equal(quantOf('gemma-4-12b-it-Q4_K_M.gguf'), 'Q4_K_M');
  assert.equal(quantOf('gemma-4-26B-A4B-it-MXFP4_MOE.gguf'), 'MXFP4_MOE');
  assert.equal(quantOf('model-q8_0.gguf'), 'Q8_0');
});

test('split models count as one choice with the summed size', () => {
  const { quants, mmproj } = quantsOf([
    { path: 'UD-Q4_K_XL/m-UD-Q4_K_XL-00001-of-00002.gguf', size: 10e9 },
    { path: 'UD-Q4_K_XL/m-UD-Q4_K_XL-00002-of-00002.gguf', size: 5e9 },
    { path: 'm-Q2_K.gguf', size: 4e9 },
    { path: 'mmproj-BF16.gguf', size: 0.9e9 },
    { path: 'mmproj-F16.gguf', size: 0.9e9 },
  ]);
  assert.deepEqual(quants.map((q) => [q.quant, q.size, q.files.length]), [['Q2_K', 4e9, 1], ['UD-Q4_K_XL', 15e9, 2]]);
  assert.equal(mmproj.path, 'mmproj-F16.gguf');
});

test('fit check speaks plainly for a 48 GB Mac and a 24 GB graphics card', () => {
  const mac = { unified: true, gpuBudget: 36 * GB, ram: 48 * GB };
  assert.equal(fitFor(mac, 7e9).level, 'great');
  assert.equal(fitFor(mac, 80e9).level, 'no');
  const pc = { unified: false, gpuBudget: 24 * GB, ram: 64 * GB };
  assert.equal(fitFor(pc, 17e9).level, 'great');
  assert.equal(fitFor(pc, 40e9, { moe: true }).level, 'ok');
  assert.equal(fitFor(pc, 40e9).level, 'slow');
});

test('GGUF header reader', () => {
  // A minimal GGUF v3 file: magic, version, 0 tensors, 3 key/values.
  const parts = [];
  const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); parts.push(b); };
  const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); parts.push(b); };
  const str = (s) => { u64(Buffer.byteLength(s)); parts.push(Buffer.from(s)); };
  parts.push(Buffer.from('GGUF'));
  u32(3); u64(0); u64(3);
  str('general.architecture'); u32(8); str('llama');
  str('general.name'); u32(8); str('Test Model');
  str('llama.context_length'); u32(4); u32(131072);
  const file = path.join(process.env.HEARTH_DATA_DIR, 't.gguf');
  fs.writeFileSync(file, Buffer.concat(parts));
  const m = readGgufMeta(file);
  assert.equal(m.arch, 'llama');
  assert.equal(m.name, 'Test Model');
  assert.equal(m.ctxTrain, 131072);
});

test('markdown never lets model output inject HTML or script links', () => {
  const { html } = renderMarkdown('<img src=x onerror=alert(1)> [x](javascript:alert(1)) **ok**');
  assert.ok(!html.includes('<img'));
  assert.ok(!html.includes('href="javascript'));
  assert.ok(html.includes('<strong>ok</strong>'));
});

test('HTML answers become a live preview, with CSS and JS blocks folded in', () => {
  const { blocks } = renderMarkdown('```html\n<html><head></head><body><div id=a></div></body></html>\n```\n```css\n#a{color:red}\n```\n```js\nconsole.log(1)\n```');
  const p = previewFrom(blocks);
  assert.equal(p.name, 'index.html');
  assert.ok(p.doc.includes('#a{color:red}') && p.doc.includes('console.log(1)'));
});

test('simple LaTeX turns into readable math, prices stay', () => {
  assert.ok(renderMarkdown('$12 \\div 3 = 4$').html.includes('12 ÷ 3 = 4'));
  assert.ok(renderMarkdown('Shirts cost $25 and $30').html.includes('$25 and $30'));
});

test('big MoE on a 48 GB Mac: lookup table from the SSD, a few expert layers on the processor', async () => {
  const { planModel } = await import('../server/plan.mjs');
  // A 48 GB M3 Max: macOS lets the GPU use 40.2 GB (from llama-server --list-devices).
  const mac48 = { unified: true, gpuBudget: 38338 * 1024 * 1024, ram: 48 * GB };
  // Qwen3.8-Flash-Next GSQ-RCO Q2_0, as read from its real file headers.
  const model = {
    size: 66.41e9, moe: true, mmprojSize: 0.91e9,
    layout: { total: 66.41e9, experts: 33.97e9, table: 28.8e9, dense: 3.64e9, expertLayers: 48 },
    meta: { layers: 48, headKv: 2, keyLength: 256, valueLength: 256, fullAttentionInterval: 4 },
  };
  const withImages = planModel(mac48, model, { ctx: 32768, vision: true });
  assert.equal(withImages.mode, 'split');
  assert.ok(withImages.cpuMoeLayers >= 1 && withImages.cpuMoeLayers <= 4, `moved ${withImages.cpuMoeLayers} layers`);
  assert.equal(withImages.level, 'ok', 'the moved experts fit in the RAM cache');
  assert.ok(withImages.args.includes('--lazy-mode') && withImages.args.includes('--fit-target'));
  // Text only, 32K: measured to fit entirely on the GPU (38.4 tok/s). Hearth's estimate is a little more careful
  // than llama.cpp's (which makes the real split), so it may say one layer.
  assert.ok(planModel(mac48, model, { ctx: 32768, vision: false }).cpuMoeLayers <= 1);
  assert.match(withImages.detail, /29 GB lookup table/);
  assert.equal(planModel({ unified: true, gpuBudget: 96 * GB, ram: 128 * GB }, model, { ctx: 65536 }).level, 'great');
});

test('big MoE on a PC with a 24 GB card: experts on the processor, prompts read in batches of 2048', async () => {
  const { planModel } = await import('../server/plan.mjs');
  // The user's PC: RX 7900 XTX (24 GB), 64 GB RAM. Qwen3.8-Flash-Next UD-Q2_K_XL as its headers describe it.
  const pc = { unified: false, gpuBudget: 25753026560, ram: 67767975936, gpus: [{ vendor: 'amd', vram: 25753026560 }] };
  const model = {
    size: 79.58e9, moe: true, mmprojSize: 0.9e9,
    layout: { total: 79.57e9, experts: 46.03e9, table: 28.8e9, dense: 4.74e9, expertLayers: 48 },
    meta: { layers: 48, headKv: 2, keyLength: 256, valueLength: 256, fullAttentionInterval: 4 },
  };
  const plan = planModel(pc, model, { ctx: 262144, vision: true, kv: 'q8_0' });
  assert.equal(plan.mode, 'moe-cpu');
  const ub = plan.args.indexOf('-ub');
  assert.ok(ub >= 0 && plan.args[ub + 1] === '2048', plan.args.join(' '));
  // Its lookup table is read from the SSD, so the experts are locked in RAM: Windows then drops table pages, not experts.
  const lm = plan.args.indexOf('--load-mode');
  assert.ok(lm >= 0 && plan.args[lm + 1] === 'mmap+mlock', plan.args.join(' '));
  assert.ok(!planModel({ ...pc, ram: 32 * GB }, model, { ctx: 32768 }).args.includes('--load-mode'), 'no lock when RAM is short');
  const noTable = { ...model, layout: { ...model.layout, table: 0, experts: 74.8e9 } };
  assert.ok(!planModel(pc, noTable, { ctx: 32768 }).args.includes('--load-mode'), 'no lock without a lookup table');
  // Small cards keep llama.cpp's own batch (a bigger work area would crowd them), and Macs share one memory.
  assert.ok(!planModel({ ...pc, gpuBudget: 8 * GB, gpus: [{ vendor: 'nvidia', vram: 8 * GB }] }, model, { ctx: 32768 }).args.includes('-ub'));
  assert.ok(!planModel({ unified: true, gpuBudget: 38338 * 1024 * 1024, ram: 48 * GB }, model, { ctx: 32768 }).args.includes('-ub'));
});

test('real GPU memory comes from the engine’s device list', async () => {
  const { parseDeviceList } = await import('../server/hardware.mjs');
  const mac = parseDeviceList('Available devices:\n  MTL0: Apple M3 Max (38338 MiB, 38338 MiB free)\n  BLAS: Accelerate (0 MiB, 0 MiB free)\n');
  assert.deepEqual(mac.map((d) => [d.id, Math.round(d.total / 1e9 * 10) / 10]), [['MTL0', 40.2]]);
  const pc = parseDeviceList('Available devices:\n  Vulkan0: AMD Radeon RX 7900 XTX (24560 MiB, 23800 MiB free)\n  CUDA0: NVIDIA GeForce RTX 4090 (24563 MiB, 23000 MiB free)\n');
  assert.equal(pc.length, 2);
  assert.equal(pc[0].name, 'AMD Radeon RX 7900 XTX');
});
