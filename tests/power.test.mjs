// Tests for "this computer": starting with Windows (the user's Run entry, checked after writing, moved when Hearth
// was moved) and keeping the computer awake while bots or the model work. Windows' registry and PowerShell are
// stand-ins here; on a Mac the real caffeinate is started and stopped. Run with: npm test.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.HEARTH_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-test-'));
process.env.HEARTH_BOTS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-bots-'));
const { updateSettings } = await import('../server/settings.mjs');
const power = await import('../server/power.mjs');
const real = { ...power.sys };
updateSettings({ language: 'en', keepAwake: 'auto' });
after(() => {
  power.stopPower();
  Object.assign(power.sys, real);
});
const until = async (fn, ms = 3000) => {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
};

test('when to keep the computer awake', () => {
  const telegram = { telegram: { token: '1:x' }, schedules: [] };
  const daily = { telegram: {}, schedules: [{ on: true, task: 'Morning summary' }] };
  const offSchedule = { telegram: {}, schedules: [{ on: false, task: 'Old' }] };
  assert.equal(power.awakeReason('auto', {}), '');
  assert.equal(power.awakeReason('auto', { bots: [offSchedule] }), '');
  assert.equal(power.awakeReason('auto', { bots: [telegram] }), 'telegram');
  assert.equal(power.awakeReason('auto', { bots: [daily] }), 'schedule');
  assert.equal(power.awakeReason('auto', { busy: true }), 'work', 'the model answering a chat or an app');
  assert.equal(power.awakeReason('auto', { work: { queued: ['b/t'] } }), 'work');
  assert.equal(power.awakeReason('always', {}), 'always');
  assert.equal(power.awakeReason('off', { bots: [telegram], busy: true }), '');
});

test('Windows: Hearth starts at sign-in without a window, the entry is checked, and follows Hearth when it moves', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-win-'));
  fs.mkdirSync(path.join(home, 'node'));
  fs.writeFileSync(path.join(home, 'Hearth.vbs'), "' launcher");
  const reg = new Map(); // the Run key, as reg.exe would keep it
  const calls = [];
  Object.assign(power.sys, {
    platform: 'win32',
    execPath: path.join(home, 'node', 'node.exe'),
    run: async (cmd, args) => {
      calls.push([cmd, ...args]);
      assert.equal(cmd, 'reg');
      assert.equal(args[1], 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run');
      if (args[0] === 'add') reg.set(args[3], args[7]);
      else if (args[0] === 'delete') reg.delete(args[3]);
      else if (args[0] === 'query') {
        if (!reg.has(args[3])) throw new Error('ERROR: The system was unable to find the specified registry key or value.');
        return { stdout: `\r\nHKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Run\r\n    Hearth    REG_SZ    ${reg.get(args[3])}\r\n\r\n`, stderr: '' };
      }
      return { stdout: 'The operation completed successfully.', stderr: '' };
    },
  });
  try {
    const vbs = path.join(home, 'Hearth.vbs');
    assert.equal(power.launcher(), vbs);
    assert.deepEqual(await power.loginState(), { available: true, on: false });
    assert.deepEqual(await power.setStartAtLogin(true), { available: true, on: true });
    assert.equal(reg.get('Hearth'), `"C:\\Windows\\System32\\wscript.exe" "${vbs}" /background`);
    assert.equal(power.runCommand(vbs, 'D:\\Win'), `"D:\\Win\\System32\\wscript.exe" "${vbs}" /background`);
    assert.deepEqual(await power.setStartAtLogin(false), { available: true, on: false });
    assert.ok(!reg.has('Hearth'));
    // Windows refusing to save it is said, not hidden.
    const run = power.sys.run;
    power.sys.run = async (cmd, args) => (args[0] === 'add' ? { stdout: '' } : run(cmd, args));
    await assert.rejects(power.setStartAtLogin(true), /Windows didn’t save the setting/);
    power.sys.run = run;
    // Started at sign-in by a Hearth that was moved or removed: the entry now starts this one.
    reg.set('Hearth', '"C:\\Windows\\System32\\wscript.exe" "C:\\Old place\\Hearth\\Hearth.vbs" /background');
    updateSettings({ keepAwake: 'off' });
    power.startPower();
    await until(() => reg.get('Hearth').includes(vbs));
    power.stopPower();
    // An entry of another Hearth that still exists is left alone.
    const other = path.join(home, 'Other.vbs');
    fs.writeFileSync(other, "' another copy");
    reg.set('Hearth', `"C:\\Windows\\System32\\wscript.exe" "${other}" /background`);
    power.startPower();
    await new Promise((r) => setTimeout(r, 50));
    power.stopPower();
    assert.ok(reg.get('Hearth').includes('Other.vbs'));
    // Hearth run without its launcher (from the source) can't offer it.
    power.sys.execPath = path.join(os.tmpdir(), 'nowhere', 'node', 'node.exe');
    assert.deepEqual(await power.loginState(), { available: false, on: false });
    await assert.rejects(power.setStartAtLogin(true), /set here in Hearth for Windows/);
  } finally {
    Object.assign(power.sys, real);
  }
});

test('Windows: the keep-awake helper runs while needed, says when it holds, and lets go when told', async () => {
  const children = [];
  Object.assign(power.sys, {
    platform: 'win32',
    execPath: path.join(os.tmpdir(), 'nowhere', 'node', 'node.exe'),
    spawn: (cmd, args, opts) => {
      const c = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), cmd, args, opts, killed: false });
      c.kill = () => (c.killed = true);
      c.stdin.on('finish', () => setTimeout(() => c.emit('exit', 0), 5)); // the script lets go when its input closes
      children.push(c);
      setTimeout(() => c.stdout.write('awake\r\n'), 5);
      return c;
    },
  });
  try {
    updateSettings({ keepAwake: 'always' });
    power.awakeChanged();
    assert.equal(children.length, 1);
    const c = children[0];
    assert.equal(c.cmd, 'powershell.exe');
    assert.ok(c.opts.windowsHide);
    const script = c.args[c.args.indexOf('-File') + 1];
    assert.ok(fs.existsSync(script), 'keep-awake.ps1 ships with the server');
    assert.match(fs.readFileSync(script, 'utf8'), /SetThreadExecutionState\(0x80000001u\)[\s\S]*Console\.In\.ReadLine\(\)/);
    assert.ok(!c.args.includes('-EncodedCommand'), 'a plain script file, nothing hidden');
    let st = await power.powerState();
    assert.equal(st.awake.starting, true, 'starting until the script says it holds');
    await new Promise((r) => setTimeout(r, 30));
    st = await power.powerState();
    assert.equal(st.awake.on, true);
    assert.equal(st.awake.reason, 'always');
    power.checkAwake();
    assert.equal(children.length, 1, 'one helper, not one per check');
    updateSettings({ keepAwake: 'off' });
    power.awakeChanged();
    await until(() => c.stdin.writableFinished);
    st = await power.powerState();
    assert.equal(st.awake.on, false);
    assert.equal(st.awake.reason, '');

    // A helper that can't start says why, and isn't started again every few seconds.
    power.sys.spawn = (cmd, args) => {
      const c2 = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill() {} });
      children.push(c2);
      setTimeout(() => {
        c2.stderr.write('Add-Type : Cannot add type. Compilation errors occurred.\r\n');
        c2.emit('exit', 1);
      }, 5);
      return c2;
    };
    updateSettings({ keepAwake: 'always' });
    power.awakeChanged();
    await until(() => children.length === 2);
    await new Promise((r) => setTimeout(r, 30));
    st = await power.powerState();
    assert.match(st.awake.error, /Keeping the computer awake stopped: Add-Type : Cannot add type/);
    power.checkAwake();
    assert.equal(children.length, 2, 'waits before trying again');
    power.awakeChanged(); // choosing again in Settings tries at once
    assert.equal(children.length, 3);
  } finally {
    updateSettings({ keepAwake: 'off' });
    power.stopPower();
    Object.assign(power.sys, real);
  }
});

test('while bots need it: a bot with a schedule keeps the computer awake; two minutes after the need ends it may sleep', async () => {
  const bots = await import('../server/bots.mjs');
  const children = [];
  Object.assign(power.sys, {
    platform: 'darwin',
    spawn: (cmd, args) => {
      const c = Object.assign(new EventEmitter(), { stdout: null, stderr: new PassThrough(), stdin: null, cmd, args });
      c.kill = () => setTimeout(() => c.emit('exit', 0), 1);
      children.push(c);
      return c;
    },
  });
  try {
    updateSettings({ keepAwake: 'auto' });
    power.awakeChanged();
    assert.equal(children.length, 0, 'nothing needs it yet');
    const bot = await bots.createBot({ template: 'digest' }); // every day at 09:00
    const t0 = Date.now();
    power.checkAwake(t0);
    assert.equal(children.length, 1);
    assert.deepEqual(children[0].args, ['-i', '-w', String(process.pid)]);
    let st = await power.powerState();
    assert.equal(st.awake.reason, 'schedule');
    assert.equal(st.awake.on, true);
    bots.deleteBot(bot.id);
    power.checkAwake(t0 + 60000);
    assert.equal((await power.powerState()).awake.on, true, 'still within the two minutes');
    power.checkAwake(t0 + 3 * 60000);
    st = await power.powerState();
    assert.equal(st.awake.on, false);
    assert.equal(st.awake.reason, '');
  } finally {
    updateSettings({ keepAwake: 'off' });
    power.awakeChanged();
    Object.assign(power.sys, real);
  }
});

test('Mac: the real caffeinate keeps it awake while Hearth runs and stops when told', { skip: process.platform !== 'darwin' }, async () => {
  const mine = () => {
    try {
      return execFileSync('pgrep', ['-f', `caffeinate -i -w ${process.pid}`], { encoding: 'utf8' }).trim();
    } catch {
      return '';
    }
  };
  updateSettings({ keepAwake: 'always' });
  power.awakeChanged();
  await until(() => mine());
  const st = await power.powerState();
  assert.equal(st.awake.on, true);
  assert.deepEqual(st.login, { available: false, mac: true, on: false }); // the Mac app's own menu does it
  updateSettings({ keepAwake: 'off' });
  power.awakeChanged();
  await until(() => !mine());
  assert.equal((await power.powerState()).awake.on, false);
});

test('the Windows launcher starts without a window when asked, and uninstalling removes the entry', () => {
  const vbs = fs.readFileSync(path.join(ROOT, 'windows', 'Hearth.vbs'), 'utf8');
  assert.match(vbs, /LCase\(WScript\.Arguments\(0\)\) = "\/background" Then openArg = ""/);
  assert.match(vbs, /server\\index\.mjs" & openArg, 0, False/);
  assert.match(fs.readFileSync(path.join(ROOT, 'windows', 'installer.nsi'), 'utf8'), /DeleteRegValue HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Run" "Hearth"/);
});
