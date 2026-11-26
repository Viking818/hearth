// Tests for choosing an engine on a PC with a graphics card: a download that doesn't start is reported with the
// reason, and an engine that can't see the card is passed over for one that can. Stand-in engines (small scripts)
// play the part of llama-server, so this runs on any system. Run with: npm test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.HEARTH_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-test-'));
const { DIRS } = await import('../server/settings.mjs');
const { listEngines, brokenEngines } = await import('../server/engine-install.mjs');
const { listEngineDevices } = await import('../server/hardware.mjs');
const { pickSeeingEngine } = await import('../server/engine.mjs');

const EXE = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server';

// A downloaded engine folder with a stand-in program: `version` is what --version prints (empty: it fails at once),
// `devices` what --list-devices prints.
function fakeEngine(name, backend, { version = '', devices = '' } = {}) {
  const dir = path.join(DIRS.engines, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'engine.json'), JSON.stringify({ backend }));
  const bin = path.join(dir, EXE);
  fs.writeFileSync(
    bin,
    `#!/bin/bash
if [ "$1" = "--version" ]; then
  ${version ? `printf '%s\\n' ${JSON.stringify(version)}; exit 0` : `echo "error while loading shared libraries: libamdhip64.so.7" >&2; exit 127`}
fi
if [ "$1" = "--list-devices" ]; then printf '%b' ${JSON.stringify(devices)}; exit 0; fi
exit 1
`,
    { mode: 0o755 },
  );
  return bin;
}

const skip = process.platform === 'win32';

test('a downloaded engine that does not start is listed apart, with its reason', { skip }, async () => {
  fakeEngine('b12144-win-vulkan-x64', 'vulkan', { version: 'version: 0.9.0 (build 12144, commit abc)' });
  fakeEngine('b12144-win-rocm-10.0-x64', 'rocm');
  const list = await listEngines(true);
  assert.deepEqual(list.filter((e) => e.source === 'downloaded').map((e) => e.backend), ['vulkan']);
  const broken = brokenEngines();
  assert.equal(broken.length, 1);
  assert.equal(broken[0].backend, 'rocm');
  assert.match(broken[0].reason, /libamdhip64/);
});

test('what an engine sees: its graphics cards, or the line that says why there are none', { skip }, async () => {
  const blind = fakeEngine('blind-rocm', 'rocm', {
    version: 'version: 0.9.0 (build 12144, commit abc)',
    devices: 'ggml_cuda_init: failed to initialize ROCm: no ROCm-capable device is detected\\nAvailable devices:\\n',
  });
  const seeing = fakeEngine('seeing-vulkan', 'vulkan', {
    version: 'version: 0.9.0 (build 12144, commit abc)',
    devices: 'Available devices:\\n  Vulkan0: AMD Radeon RX 7900 XTX (24560 MiB, 23800 MiB free)\\n',
  });
  const a = await listEngineDevices(blind);
  assert.equal(a.devices.length, 0);
  assert.match(a.note, /no ROCm-capable device/);
  const b = await listEngineDevices(seeing);
  assert.equal(b.devices.length, 1);
  assert.equal(b.devices[0].id, 'Vulkan0');
});

test('an engine that cannot see the graphics card is passed over, and the note says why', async () => {
  const pc = { unified: false, gpus: [{ vendor: 'amd', vram: 24 * 1024 ** 3 }] };
  const order = [
    { path: 'rocm', backend: 'rocm' },
    { path: 'vulkan', backend: 'vulkan' },
  ];
  const seen = { rocm: { devices: [], note: 'no ROCm-capable device is detected' }, vulkan: { devices: [{ id: 'Vulkan0' }], note: '' } };
  const pick = await pickSeeingEngine(order, pc, 'rocm', async (p) => seen[p]);
  assert.equal(pick.backend, 'vulkan');
  assert.deepEqual(pick.note, { skipped: 'rocm', used: 'vulkan', why: 'no ROCm-capable device is detected' });
  // Not known yet (it didn't answer in time): the chosen engine is trusted.
  assert.equal((await pickSeeingEngine(order, pc, 'rocm', async () => null)).backend, 'rocm');
  // The user chose the processor, or the computer has no graphics card of its own: no check.
  assert.equal((await pickSeeingEngine(order, pc, 'cpu', async (p) => seen[p])).backend, 'rocm');
  assert.equal((await pickSeeingEngine(order, { unified: true, gpus: [{ vram: 40e9 }] }, 'metal', async (p) => seen[p])).backend, 'rocm');
  // Nothing sees the card: keep the first choice.
  assert.equal((await pickSeeingEngine(order, pc, 'rocm', async () => ({ devices: [], note: '' }))).backend, 'rocm');
});

test('AMD chip families for the ready-made AMD builds', async () => {
  const { amdFamily } = await import('../server/hardware.mjs');
  assert.equal(amdFamily('AMD Radeon RX 7900 XTX'), 'gfx110X');
  assert.equal(amdFamily('AMD Radeon RX 7600'), 'gfx110X');
  assert.equal(amdFamily('AMD Radeon RX 9070 XT'), 'gfx120X');
  assert.equal(amdFamily('AMD Radeon(TM) 8060S Graphics'), 'gfx1151');
  assert.equal(amdFamily('AMD Radeon RX 6800 XT'), 'gfx103X');
  assert.equal(amdFamily('NVIDIA GeForce RTX 4090'), '');
});

test('AMD ROCm on a Radeon PC takes AMD’s complete build for its chip family', async () => {
  const { pickAmdBuild } = await import('../server/engine-install.mjs');
  const sha = '10d4846a572aebf21c0482d140b00e74c0f1ad20';
  const list = [
    { tag_name: 'b1369', prerelease: true, assets: [{ name: 'llama-b1369-windows-rocm-gfx110X-x64.zip' }] },
    {
      tag_name: 'b1368',
      body: `**Build Number**: b1368\n**Llama.cpp Commit (full)**: ${sha}\n`,
      assets: [
        { name: 'llama-b1368-ubuntu-rocm-gfx110X-x64.zip', size: 1 },
        { name: 'llama-b1368-windows-rocm-gfx120X-x64.zip', size: 2 },
        { name: 'llama-b1368-windows-rocm-gfx110X-x64.zip', size: 532e6, browser_download_url: 'https://x/win110' },
      ],
    },
  ];
  const pc = { os: 'win32', arch: 'x64', gpus: [{ vendor: 'amd', family: 'gfx110X' }] };
  const pick = pickAmdBuild(list, pc);
  assert.equal(pick.rel.tag_name, 'b1368', 'test builds (prereleases) are skipped');
  assert.equal(pick.asset.browser_download_url, 'https://x/win110');
  assert.equal(pick.sha, sha);
  assert.equal(pickAmdBuild(list, { ...pc, os: 'linux' }).asset.name, 'llama-b1368-ubuntu-rocm-gfx110X-x64.zip');
  assert.equal(pickAmdBuild(list, { ...pc, gpus: [{ vendor: 'nvidia' }] }), null);
  assert.equal(pickAmdBuild(list, { ...pc, os: 'darwin' }), null);
});

test('an AMD build that does not print its build number is listed with the one its download noted', { skip }, async () => {
  const bin = fakeEngine('amd-b1368-windows-rocm-gfx110X-x64', 'rocm', { version: 'version: unknown (10d4846)' });
  const json = path.join(path.dirname(bin), 'engine.json');
  fs.writeFileSync(json, JSON.stringify({ backend: 'rocm', from: 'amd', build: 12151 }));
  const e = (await listEngines(true)).find((x) => x.path === bin);
  assert.ok(e, 'listed');
  assert.equal(e.build, 12151);
  assert.equal(e.from, 'amd');
});

test('a model that spills onto the processor gets a Vulkan engine that sees the card', async () => {
  const { pickVulkan } = await import('../server/engine.mjs');
  const list = [
    { path: 'amd', backend: 'rocm', from: 'amd' },
    { path: 'vk-blind', backend: 'vulkan' },
    { path: 'vk', backend: 'vulkan' },
  ];
  const seen = { 'vk-blind': { devices: [], note: '' }, vk: { devices: [{ id: 'Vulkan0' }], note: '' } };
  assert.equal((await pickVulkan(list, async (p) => seen[p])).path, 'vk');
  assert.equal(await pickVulkan([{ path: 'amd', backend: 'rocm' }], async () => null), null);
});

// On the user's PC a second Hearth loaded the same model while the first held 18 GB of the 24 GB card, so the second
// got almost none of it and wrote 6 tokens a second. Hearth now says so when another program holds the card.
test('another program holding the graphics card is noticed before loading', async () => {
  const { gpuTakenByOthers } = await import('../server/engine.mjs');
  const GiB = 1024 ** 3;
  const pc = { unified: false, gpus: [{ name: 'AMD Radeon RX 7900 XTX', vram: 24 * GiB }] };
  const list = (free) => async () => ({ devices: [{ id: 'Vulkan1', name: 'AMD Radeon(TM) Graphics', total: 0.5 * GiB, free: 0.4 * GiB }, { id: 'Vulkan0', name: 'AMD Radeon RX 7900 XTX', total: 24 * GiB, free: free * GiB }] });
  const busy = await gpuTakenByOthers('llama-server', pc, {}, list(5.5));
  assert.equal(busy.total, 24 * GiB);
  assert.equal(busy.used, 18.5 * GiB);
  assert.equal(await gpuTakenByOthers('llama-server', pc, {}, list(22.6)), null, 'the desktop’s own use is normal');
  assert.equal(await gpuTakenByOthers('llama-server', { unified: true, gpus: [{ vram: 48 * GiB }] }, {}, list(1)), null, 'not on a Mac');
  assert.equal(await gpuTakenByOthers('llama-server', pc, {}, async () => null), null, 'no answer, no warning');
});
