// Tests for starting Hearth when its port is taken by another program (on Windows, Hyper-V, WSL and Docker reserve
// ranges of ports): it uses the next free port and writes it to run.json, so a second start opens the running Hearth
// instead of starting another one that loads the model again, and Stop-Hearth.vbs can find it. Run with: npm test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Server code loaded here (the lock test) must never touch the real Hearth's data folder.
process.env.HEARTH_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-startup-'));

function startHearth(data) {
  const p = spawn(process.execPath, [path.join(ROOT, 'server', 'index.mjs')], { cwd: ROOT, env: { ...process.env, HEARTH_DATA_DIR: data }, stdio: ['ignore', 'pipe', 'pipe'] });
  p.out = '';
  p.stdout.on('data', (d) => (p.out += d));
  p.stderr.on('data', (d) => (p.out += d));
  p.done = new Promise((r) => p.once('exit', r));
  return p;
}

async function until(fn, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(200);
  }
  return null;
}

const free = (port) => new Promise((resolve) => {
  const s = net.createServer().once('error', () => resolve(false)).listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
});

test('a taken port: Hearth moves to the next one, writes run.json, and a second start finds it', { timeout: 60000 }, async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-start-'));
  const PORT = 7493;
  fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ port: PORT, language: 'en', autoLoad: false }));
  // Another program on Hearth's port (not Hearth: it answers nothing useful).
  const other = net.createServer((s) => s.destroy()).listen(PORT, '127.0.0.1');
  await new Promise((r) => other.once('listening', r));
  const first = startHearth(data);
  let second;
  try {
    const run = await until(() => {
      try {
        return JSON.parse(fs.readFileSync(path.join(data, 'run.json'), 'utf8'));
      } catch {
        return null;
      }
    });
    assert.ok(run, `run.json written\n${first.out}`);
    assert.equal(run.pid, first.pid);
    assert.equal(run.port, PORT + 1);
    const ping = await (await fetch(`http://127.0.0.1:${run.port}/api/ping`)).json();
    assert.equal(ping.app, 'hearth');

    second = startHearth(data);
    assert.ok(await until(() => /already running at http:\/\/127\.0\.0\.1:7494/.test(second.out)), `second start output:\n${second.out}`);
    assert.ok(await free(PORT + 2), 'no second Hearth on the next port');
  } finally {
    second?.kill('SIGKILL');
    first.kill('SIGTERM');
    await Promise.race([first.done, sleep(5000)]);
    other.close();
  }
  // Quitting removes run.json, so the next start doesn't look for a Hearth that is gone.
  assert.ok(!fs.existsSync(path.join(data, 'run.json')), 'run.json removed on quit');
});

// On the user's PC, a second and a third start came while the first Hearth was busy loading an 80 GB model. The quick
// ping went unanswered, so each started another Hearth that loaded the model again and took part of the graphics card.
// Now a second start finds the first one's lock and waits for it, however busy it is.
test('a busy Hearth: a second start waits for it instead of starting another one', { timeout: 90000, skip: process.platform === 'win32' }, async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-busy-'));
  const PORT = 7496;
  fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ port: PORT, language: 'en', autoLoad: false }));
  const first = startHearth(data);
  let second;
  try {
    assert.ok(await until(() => /is running/.test(first.out)), `first start output:\n${first.out}`);
    first.kill('SIGSTOP'); // frozen, like a computer swapping while the model loads: it answers nothing
    second = startHearth(data);
    await sleep(4000);
    assert.ok(await free(PORT + 1), 'no second Hearth on the next port');
    assert.doesNotMatch(second.out, /is running/);
    first.kill('SIGCONT');
    assert.ok(await until(() => /already running at http:\/\/127\.0\.0\.1:7496/.test(second.out)), `second start output:\n${second.out}`);
    assert.match(second.out, /App:\s+http:\/\/127\.0\.0\.1:7496/, 'the Mac app finds the address in this line');
    assert.equal(await Promise.race([second.done, sleep(15000).then(() => 'still running')]), 0, 'the second start ends by itself');
  } finally {
    second?.kill('SIGKILL');
    first.kill('SIGCONT');
    first.kill('SIGTERM');
    await Promise.race([first.done, sleep(5000)]);
  }
});

test('the lock: one holder per data folder, and a socket left by a crash is taken over', { timeout: 30000, skip: process.platform === 'win32' }, async () => {
  const { lockPath } = await import('../server/instance.mjs');
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-lock-'));
  const where = lockPath(data);
  assert.equal(where, path.join(data, 'hearth.sock'));
  assert.match(lockPath('C:\\Users\\Alex\\AppData\\Local\\Hearth', 'win32'), /^\\\\\.\\pipe\\hearth-[0-9a-f]{16}$/);
  assert.equal(lockPath('C:\\Users\\Alex\\AppData\\Local\\Hearth', 'win32'), lockPath('c:\\users\\alex\\appdata\\local\\hearth', 'win32'));
  // A Hearth that crashed leaves its socket file behind; nothing answers on it.
  const crashed = spawn(process.execPath, ['-e', `require('net').createServer().listen(${JSON.stringify(where)}, () => console.log('up'))`], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((r) => crashed.stdout.once('data', r));
  crashed.kill('SIGKILL');
  await new Promise((r) => crashed.once('exit', r));
  assert.ok(fs.existsSync(where), 'the socket file stays after a crash');
  const PORT = 7499;
  fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ port: PORT, language: 'en', autoLoad: false }));
  const h = startHearth(data);
  try {
    assert.ok(await until(() => /is running/.test(h.out)), `start output:\n${h.out}`);
    assert.equal((await (await fetch(`http://127.0.0.1:${PORT}/api/ping`)).json()).app, 'hearth');
  } finally {
    h.kill('SIGTERM');
    await Promise.race([h.done, sleep(5000)]);
  }
  assert.ok(!fs.existsSync(where), 'the socket file is removed on quit');
});

// Found in the 0.2.19 review: a page of another program on this computer (the same name, another port) could change
// things in Hearth, because only the name of the page's address was compared.
test('only Hearth’s own page may change things: another site, or another program’s page here, is refused', { timeout: 60000 }, async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-origin-'));
  const PORT = 7497;
  fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ port: PORT, language: 'en', autoLoad: false, checkUpdates: false, keepAwake: 'off' }));
  const hearth = startHearth(data);
  try {
    const run = await until(() => {
      try {
        return JSON.parse(fs.readFileSync(path.join(data, 'run.json'), 'utf8'));
      } catch {
        return null;
      }
    });
    assert.ok(run, `started\n${hearth.out}`);
    const base = `http://127.0.0.1:${run.port}`;
    const post = (url, origin, host) => fetch(`${base}${url}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}), ...(host ? { host } : {}) }, body: JSON.stringify({ text: 'a fact', messages: [] }) }).then((r) => r.status);
    assert.equal(await post('/api/memory', base), 200, 'Hearth’s own page');
    assert.equal(await post('/api/memory', ''), 200, 'a program on this computer (no page)');
    assert.equal(await post('/api/memory', 'https://example.com'), 403, 'another website');
    assert.equal(await post('/api/memory', 'http://127.0.0.1:3000'), 403, 'another program’s page, by number');
    assert.equal(await post('/api/memory', 'http://localhost:3000'), 403, 'another program’s page, by name');
    assert.equal(await post('/api/memory', `http://localhost:${run.port}`), 403, 'not the address the page was opened at');
    assert.equal(await post('/api/memory', 'null'), 403, 'a sandboxed frame');
    // The API for apps: a program without a page gets through to "no model" (503); pages other than Hearth's don't.
    assert.equal(await post('/v1/chat/completions', ''), 503);
    assert.equal(await post('/v1/chat/completions', base), 503);
    assert.equal(await post('/v1/chat/completions', 'http://localhost:3000'), 401);
    assert.equal(await post('/v1/chat/completions', 'https://example.com'), 401);
    const facts = (await (await fetch(`${base}/api/memory`)).json()).facts;
    assert.deepEqual(facts.map((f) => f.text), ['a fact'], 'only the allowed requests saved the fact (the same one twice is kept once)');
  } finally {
    hearth.kill('SIGTERM');
    await Promise.race([hearth.done, sleep(5000)]);
  }
});
