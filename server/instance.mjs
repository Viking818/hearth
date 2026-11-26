// One Hearth per data folder. The first Hearth holds a named pipe (Windows) or a socket file (Mac, Linux) for as long
// as it runs, and the system frees it even after a crash. A second start finds it taken and asks the first one for its
// port through it, so it can open that window instead of starting another Hearth that loads the model a second time.
// Checking the port alone was not enough: a Hearth that is busy (a big model loading on a computer short of memory)
// can take longer than any short ping, and each extra Hearth took part of the graphics card from the first.
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { DIRS } from './settings.mjs';

export function lockPath(dir = DIRS.data, platform = process.platform) {
  const id = crypto.createHash('sha256').update(path.resolve(dir).toLowerCase()).digest('hex').slice(0, 16);
  if (platform === 'win32') return `\\\\.\\pipe\\hearth-${id}`;
  const inData = path.join(dir, 'hearth.sock');
  return inData.length < 100 ? inData : path.join(os.tmpdir(), `hearth-${id}.sock`); // socket paths are short on Unix
}

// Ask the running Hearth who it is. Resolves { info } when it answers, { busy: true } when something holds the lock
// but doesn't answer in time, and null when nothing is there.
export function askInstance(timeout = 3000, where = lockPath()) {
  return new Promise((resolve) => {
    let text = '';
    let connected = false;
    const sock = net.connect(where);
    const done = (v) => {
      clearTimeout(timer);
      sock.destroy();
      resolve(v);
    };
    const timer = setTimeout(() => done(connected ? { busy: true } : null), timeout);
    sock.on('connect', () => (connected = true));
    sock.on('data', (d) => {
      text += d;
      if (text.includes('\n')) {
        try {
          done({ info: JSON.parse(text.split('\n')[0]) });
        } catch {
          done({ busy: true });
        }
      }
    });
    sock.on('error', (err) => done(connected || err.code === 'EPIPE' ? { busy: true } : null));
    sock.on('end', () => done(text ? { busy: true } : connected ? { busy: true } : null));
  });
}

let held = null;

// Take the lock. { ok: true } means this is the only Hearth for the data folder; { ok: false, info } means another one
// runs (info is what it said about itself, or null while it is too busy to answer).
export async function holdInstance(describe, where = lockPath()) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await new Promise((resolve) => {
      const server = net.createServer((sock) => {
        sock.on('error', () => {});
        sock.end(`${JSON.stringify(describe())}\n`);
      });
      server.once('error', (err) => resolve({ err }));
      server.listen(where, () => resolve({ server }));
    });
    if (r.server) {
      r.server.unref(); // the lock alone must not keep Hearth from quitting
      held = { server: r.server, where };
      return { ok: true };
    }
    if (r.err.code !== 'EADDRINUSE') return { ok: true, unlocked: r.err.message }; // can't lock here: carry on as before
    const other = await askInstance(1500, where);
    if (other) return { ok: false, info: other.info || null };
    // Nothing answers: a socket file left behind by a Hearth that crashed (Mac, Linux), or a Hearth that just quit.
    if (!isPipe(where)) fs.rmSync(where, { force: true });
    await new Promise((r) => setTimeout(r, 200));
  }
  // Still taken: a Windows pipe exists only while the Hearth holding it runs, even one too busy to let us in.
  return isPipe(where) ? { ok: false, info: null } : { ok: true, unlocked: 'the lock could not be taken' };
}

const isPipe = (where) => where.startsWith('\\\\.\\pipe\\');

export function releaseInstance() {
  if (!held) return;
  try {
    held.server.close();
    if (!isPipe(held.where)) fs.rmSync(held.where, { force: true });
  } catch {}
  held = null;
}
