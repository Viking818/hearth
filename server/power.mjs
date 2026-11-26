// This computer, for bots and apps that rely on Hearth:
// - Starting with Windows: the user's own Run entry (HKCU\…\Run, no administrator needed) starts Hearth.vbs
//   /background when they sign in, so Hearth and its bots run again after a restart, without opening a window. On a
//   Mac, Hearth's own menu has "Open at login" (the app registers itself), so the page points there.
// - Keeping the computer awake (Settings → keepAwake). Asleep, a computer answers nobody: bots miss Telegram messages
//   and their schedule, and an app's long answer stops halfway.
//     'auto'   — while a bot has Telegram or a schedule, a bot is working, or the model, pictures or videos are busy
//     'always' — while Hearth runs
//     'off'    — the system decides, as before
//   The screen may still turn off, and sleep chosen by hand (or a laptop's lid) still works. Windows: keep-awake.ps1
//   holds SetThreadExecutionState until Hearth closes its input or ends; Mac: caffeinate -i -w <Hearth's pid>.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { getSettings } from './settings.mjs';
import { listBots } from './bots.mjs';
import { activity } from './agent.mjs';
import { busyRequests } from './monitor.mjs';
import { batchRunning } from './batch.mjs';
import { drawing } from './images.mjs';
import { videoRunning } from './videos.mjs';
import { t } from './i18n.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const RUN_NAME = 'Hearth';
const CHECK_EVERY = 20000;
const LET_GO_AFTER = 2 * 60000; // 'auto' lets the computer sleep again two minutes after the work is done
const RETRY_AFTER = 10 * 60000; // a keeper that failed to start is tried again this much later

// How commands run and which system this is (tests replace them).
export const sys = {
  platform: process.platform,
  execPath: process.execPath,
  pid: process.pid,
  run: (cmd, args) =>
    new Promise((resolve, reject) => execFile(cmd, args, { windowsHide: true, timeout: 15000 }, (err, stdout, stderr) => (err ? reject(Object.assign(err, { stderr })) : resolve({ stdout: String(stdout), stderr: String(stderr) })))),
  spawn: (cmd, args, opts) => spawn(cmd, args, opts),
};

const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });

// ---- Starting with Windows ----

// Hearth.vbs next to Hearth's own Node.js (the setup's folder and the zip's); '' when Hearth runs another way.
export function launcher() {
  const p = sys.execPath.includes('\\') ? path.win32 : path; // by the path itself (tests run elsewhere)
  const vbs = p.join(p.dirname(p.dirname(sys.execPath)), 'Hearth.vbs');
  return fs.existsSync(vbs) ? vbs : '';
}

// What Windows runs at sign-in. Explorer is 64-bit, so the real System32.
export function runCommand(vbs, systemRoot = process.env.SystemRoot || 'C:\\Windows') {
  return `"${path.win32.join(systemRoot, 'System32', 'wscript.exe')}" "${vbs}" /background`;
}

async function readRunEntry() {
  try {
    const { stdout } = await sys.run('reg', ['query', RUN_KEY, '/v', RUN_NAME]);
    return /^\s*Hearth\s+REG_\w+\s+(.*?)\s*$/m.exec(stdout)?.[1] || '';
  } catch {
    return ''; // not there
  }
}

const vbsOf = (entry) => /"([^"]+\.vbs)"/i.exec(entry)?.[1] || '';
const writeRunEntry = (vbs) => sys.run('reg', ['add', RUN_KEY, '/v', RUN_NAME, '/t', 'REG_SZ', '/d', runCommand(vbs), '/f']);

export async function loginState() {
  if (sys.platform === 'darwin') return { available: false, mac: true, on: false };
  if (sys.platform !== 'win32' || !launcher()) return { available: false, on: false };
  return { available: true, on: Boolean(await readRunEntry()) };
}

export async function setStartAtLogin(on) {
  const vbs = sys.platform === 'win32' ? launcher() : '';
  if (!vbs) throw bad(t('Starting with the computer is set here in Hearth for Windows.'));
  if (on) await writeRunEntry(vbs);
  else await sys.run('reg', ['delete', RUN_KEY, '/v', RUN_NAME, '/f']).catch(() => {});
  const entry = await readRunEntry();
  if (on ? !/Hearth\.vbs"\s+\/background/i.test(entry) : entry) throw bad(t('Windows didn’t save the setting. Try again.'), 500);
  return loginState();
}

// At start: an entry left by a Hearth that was moved or removed now starts this one.
async function fixRunEntry() {
  const vbs = sys.platform === 'win32' ? launcher() : '';
  if (!vbs) return;
  const entry = await readRunEntry();
  const was = vbsOf(entry);
  if (entry && was && !fs.existsSync(was)) await writeRunEntry(vbs).catch(() => {});
}

// ---- Keeping the computer awake ----

// Why the computer should stay awake now ('' when it needn't).
export function awakeReason(mode, { bots = [], work = {}, busy = false } = {}) {
  if (mode === 'always') return 'always';
  if (mode !== 'auto') return '';
  if (busy || work.running || work.queued?.length) return 'work';
  if (bots.some((b) => b.telegram?.token)) return 'telegram';
  if (bots.some((b) => (b.schedules || []).some((s) => s.on && s.task))) return 'schedule';
  return '';
}

let keeper = null; // { child, active, stopping }
let reason = '';
let lastNeeded = 0;
let failedAt = 0;
let error = '';
let timer = null;

function startKeeper() {
  let child;
  try {
    if (sys.platform === 'win32') {
      child = sys.spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(HERE, 'keep-awake.ps1')], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    } else if (sys.platform === 'darwin') {
      child = sys.spawn('caffeinate', ['-i', '-w', String(sys.pid)], { stdio: ['ignore', 'ignore', 'pipe'] });
    } else return;
  } catch (err) {
    error = err.message;
    failedAt = Date.now();
    return;
  }
  const k = { child, active: sys.platform === 'darwin', stopping: false };
  keeper = k;
  error = '';
  let said = '';
  child.stdout?.on('data', (d) => {
    if (String(d).includes('awake')) k.active = true;
  });
  child.stderr?.on('data', (d) => (said = `${said}${d}`.slice(-2000)));
  child.on('error', (err) => (said = err.message));
  child.on('exit', (code) => {
    if (keeper === k) keeper = null;
    if (k.stopping) return;
    // It ended by itself: say why, and try again later rather than every few seconds.
    failedAt = Date.now();
    error = t('Keeping the computer awake stopped: {detail}', { detail: (said.trim().split('\n').filter(Boolean).pop() || `code ${code}`).slice(0, 200) });
  });
}

function stopKeeper() {
  const k = keeper;
  if (!k) return;
  keeper = null;
  k.stopping = true;
  try {
    k.child.stdin?.end(); // keep-awake.ps1 lets go and ends
  } catch {}
  const kill = setTimeout(() => {
    try {
      k.child.kill();
    } catch {}
  }, sys.platform === 'win32' ? 3000 : 0);
  kill.unref?.();
}

export function checkAwake(now = Date.now()) {
  const mode = getSettings().keepAwake;
  let bots = [];
  try {
    bots = listBots();
  } catch {}
  const busy = busyRequests(now) > 0 || Boolean(batchRunning()) || drawing() || videoRunning();
  const r = awakeReason(mode, { bots, work: activity(), busy });
  if (r) {
    reason = r;
    lastNeeded = now;
  }
  const keep = Boolean(r) || (mode === 'auto' && Boolean(reason) && now - lastNeeded < LET_GO_AFTER);
  if (!keep) reason = '';
  if (keep && !keeper && !(failedAt && now - failedAt < RETRY_AFTER)) startKeeper();
  if (!keep && keeper) stopKeeper();
  if (!keep) error = '';
}

export function startPower() {
  if (timer) return;
  fixRunEntry().catch(() => {});
  checkAwake();
  timer = setInterval(() => checkAwake(), CHECK_EVERY);
  timer.unref?.();
}

export function stopPower() {
  clearInterval(timer);
  timer = null;
  stopKeeper();
}

// The user changed the setting: it applies at once (and a helper that failed is tried again).
export function awakeChanged() {
  failedAt = 0;
  reason = ''; // the new choice applies now, without the pause after the old one
  lastNeeded = 0;
  checkAwake();
}

export async function powerState() {
  return {
    login: await loginState(),
    awake: { available: sys.platform === 'win32' || sys.platform === 'darwin', mode: getSettings().keepAwake, on: Boolean(keeper?.active), starting: Boolean(keeper && !keeper.active), reason, error },
  };
}
