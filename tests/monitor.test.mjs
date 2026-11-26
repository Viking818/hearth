// Tests for the graphics-load sampler used by the Monitor page on Windows. A stand-in "powershell" on PATH plays
// the part of the real one, so this runs on any system. Run with: npm test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.HEARTH_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-test-'));
const { windowsGpuLive, stopWindowsGpu } = await import('../server/hardware.mjs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-fake-ps-'));
const log = path.join(bin, 'starts.log');
const script = path.join(bin, 'script.ps1');
// Records each start and the script it was given, then prints a sample now and then.
fs.writeFileSync(
  path.join(bin, 'powershell'),
  `#!/bin/bash
echo start >> "${log}"
prev=""
for a in "$@"; do
  if [ "$prev" = "-Command" ]; then printf '%s' "$a" > "${script}"; fi
  prev="$a"
done
if [ -n "$FAKE_PS_FAIL" ]; then exit 1; fi
while true; do echo "37 1234567"; sleep 0.2; done
`,
  { mode: 0o755 },
);
process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;
const starts = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).length : 0);

test('one PowerShell keeps sampling; its lines become the GPU numbers', { skip: process.platform === 'win32' }, async () => {
  assert.equal(windowsGpuLive(), null); // nothing read yet
  let got = null;
  for (let i = 0; i < 40 && !got; i++) {
    await sleep(100);
    got = windowsGpuLive();
  }
  assert.deepEqual(got, { util: 37, memUsed: 1234567 });
  for (let i = 0; i < 5; i++) windowsGpuLive();
  assert.equal(starts(), 1, 'asking again must not start another PowerShell');
  // The script reaches PowerShell intact: it watches Hearth's own process and reads the language-neutral WMI classes.
  const text = fs.readFileSync(script, 'utf8');
  assert.match(text, new RegExp(`Get-Process -Id ${process.pid}\\b`));
  assert.match(text, /Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine/);
  assert.match(text, /-replace '\^pid_\\d\+_'/);
  // Windows quotes a command-line argument with double quotes, so the script must not contain any.
  assert.ok(!text.includes('"'), 'no double quotes in the script');
  stopWindowsGpu();
});

test('a PowerShell that ends at once is not restarted every second', { skip: process.platform === 'win32' }, async () => {
  fs.rmSync(log, { force: true });
  process.env.FAKE_PS_FAIL = '1';
  try {
    windowsGpuLive();
    await sleep(500);
    for (let i = 0; i < 5; i++) {
      assert.equal(windowsGpuLive(), null);
      await sleep(50);
    }
    assert.equal(starts(), 1);
  } finally {
    delete process.env.FAKE_PS_FAIL;
    stopWindowsGpu();
  }
});
