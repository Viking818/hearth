// Hearth's own messages (start-up, errors) also go to logs/hearth.log, so they can be read when Hearth runs without
// a console window (the Mac app, Hearth.vbs on Windows) and on the Monitor page.
import fs from 'node:fs';
import path from 'node:path';
import { DIRS } from './settings.mjs';

const FILE = path.join(DIRS.logs, 'hearth.log');
const MAX = 2 << 20;
let stream = null;
let written = 0; // since the log was last opened

function open() {
  try {
    const size = fs.statSync(FILE).size;
    if (size > MAX) fs.renameSync(FILE, path.join(DIRS.logs, 'hearth.old.log'));
    else written = size;
  } catch {}
  stream = fs.createWriteStream(FILE, { flags: 'a' });
  stream.on('error', () => {
    stream = null;
  });
}

const text = (x) => (typeof x === 'string' ? x : x instanceof Error ? x.stack || x.message : JSON.stringify(x));

export function teeConsole() {
  if (stream) return;
  open();
  for (const k of ['log', 'warn', 'error']) {
    const orig = console[k].bind(console);
    console[k] = (...args) => {
      orig(...args);
      try {
        const line = `${new Date().toISOString()} ${args.map(text).join(' ').slice(0, 20000)}\n`;
        // The size is watched while Hearth runs too, not only at the start: when the log is full it is set aside
        // (one older copy is kept) and a new one begins.
        written += line.length;
        if (written > MAX) {
          written = 0;
          stream?.end();
          open();
        }
        stream?.write(line);
      } catch {}
    };
  }
}

export function readServerLog(n = 300) {
  try {
    return fs.readFileSync(FILE, 'utf8').split('\n').filter(Boolean).slice(-n);
  } catch {
    return [];
  }
}
