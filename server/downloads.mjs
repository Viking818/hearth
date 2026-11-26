// Downloads big files (models, engines) with progress, resume after a break, and cancel.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { uid } from './util.mjs';
import { t } from './i18n.mjs';

// GitHub lists a checksum for every file of a release ("digest": "sha256:…"): '' when it gives none.
export const shaOf = (asset) => /^sha256:([0-9a-f]{64})$/i.exec(String(asset?.digest || ''))?.[1].toLowerCase() || '';

const sha256 = (file) =>
  new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file).on('data', (d) => h.update(d)).on('error', reject).on('end', () => resolve(h.digest('hex')));
  });

const jobs = new Map();

export function listDownloads() {
  return [...jobs.values()].map(publicJob).sort((a, b) => b.createdAt - a.createdAt);
}

function publicJob(j) {
  const { controller, onDone, ...rest } = j;
  return { ...rest, files: j.files.map(({ url, headers, ...f }) => f) };
}

export function getDownload(id) {
  return jobs.get(id);
}

/**
 * files: [{ url, dest, size?, headers?, sha256? }]. Files already complete on disk are skipped.
 * sha256: the file's checksum where its source gives one (programs Hearth will run): a file that doesn't match is
 * deleted and never used.
 * onDone(job) runs after every file is in place (e.g. unpack an engine).
 */
export function startDownload({ kind, label, files, meta = {}, onDone }) {
  // The same thing twice? Return the running job instead of downloading in parallel into the same files.
  const dests = files.map((f) => f.dest).join('|');
  for (const j of jobs.values()) {
    if (j.state === 'downloading' || j.state === 'queued') {
      if (j.files.map((f) => f.dest).join('|') === dests) return publicJob(j);
    }
  }
  const job = {
    id: uid(10),
    kind,
    label,
    meta,
    files: files.map((f) => ({ ...f, name: path.basename(f.dest), done: 0 })),
    total: files.reduce((s, f) => s + (f.size || 0), 0),
    done: 0,
    speed: 0,
    state: 'queued',
    error: '',
    createdAt: Date.now(),
    controller: new AbortController(),
    onDone,
  };
  jobs.set(job.id, job);
  run(job);
  return publicJob(job);
}

export function cancelDownload(id) {
  const j = jobs.get(id);
  if (!j) return false;
  if (j.state === 'downloading' || j.state === 'queued') {
    j.state = 'cancelled';
    j.controller.abort();
  } else {
    jobs.delete(id); // a finished/failed entry: remove it from the list
  }
  return true;
}

async function run(job) {
  job.state = 'downloading';
  let lastTick = Date.now();
  let lastBytes = 0;
  const tick = () => {
    job.done = job.files.reduce((s, f) => s + f.done, 0);
    const now = Date.now();
    if (now - lastTick >= 1000) {
      const inst = ((job.done - lastBytes) * 1000) / (now - lastTick);
      job.speed = job.speed ? job.speed * 0.6 + inst * 0.4 : inst;
      lastTick = now;
      lastBytes = job.done;
    }
  };
  try {
    for (const f of job.files) {
      await downloadFile(f, job.controller.signal, tick);
      tick();
    }
    job.speed = 0;
    if (job.onDone) {
      job.state = 'finishing';
      await job.onDone(publicJob(job));
    }
    job.state = 'done';
    job.finishedAt = Date.now();
  } catch (err) {
    job.speed = 0;
    if (job.state !== 'cancelled') {
      job.state = 'error';
      job.error = String(err?.message || err);
    }
  }
}

async function downloadFile(f, signal, tick) {
  fs.mkdirSync(path.dirname(f.dest), { recursive: true });
  if (f.size && fs.existsSync(f.dest) && fs.statSync(f.dest).size === f.size) {
    if (!f.sha256 || (await sha256(f.dest)) === f.sha256) {
      f.done = f.size;
      return;
    }
    fs.rmSync(f.dest, { force: true }); // here from an earlier try, but not the file its source lists: get it again
  }
  const part = `${f.dest}.part`;
  let have = 0;
  try {
    have = fs.statSync(part).size;
  } catch {}
  const startOver = () => {
    fs.rmSync(part, { force: true });
    have = 0;
  };
  if (f.size && have > f.size) startOver(); // a leftover longer than the file: it can't be part of it
  // Ask until the whole file is here. A server may end an answer before the end without any error (Hugging Face's
  // file servers send big files in parts): then the next request asks for the rest. Only answers that bring
  // nothing, or fail, count as failures; five of them in a row stop the download.
  let failures = 0;
  while (!f.size || have < f.size) {
    const before = have;
    try {
      const headers = { ...(f.headers || {}) };
      if (have > 0) headers.range = `bytes=${have}-`;
      const res = await fetch(f.url, { headers, signal, redirect: 'follow' });
      if (res.status === 416) {
        if (f.size && have === f.size) break; // already complete
        startOver(); // the leftover doesn't fit the file on the server (it changed, or the leftover is damaged)
        throw new Error('Server said 416');
      }
      if (!res.ok) {
        if (res.status === 401 || res.status === 403) throw Object.assign(new Error('This model needs a Hugging Face login (add a token in Settings) or accepting its license on huggingface.co.'), { fatal: true });
        if (res.status === 404) throw Object.assign(new Error('File not found on the server.'), { fatal: true });
        throw new Error(`Server said ${res.status}`);
      }
      if (have > 0 && res.status !== 206) have = 0; // server ignored the resume request: start over
      const len = Number(res.headers.get('content-length')) || 0;
      if (!f.size && len) f.size = have + len;
      const out = fs.createWriteStream(part, { flags: have > 0 ? 'a' : 'w' });
      f.done = have;
      try {
        for await (const chunk of res.body) {
          if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
          f.done += chunk.length;
          have += chunk.length;
          tick();
        }
      } finally {
        await new Promise((r) => out.end(r));
      }
      if (!f.size) break; // no size known: the server's answer is the whole file
      if (have > f.size) {
        startOver(); // more than the file holds: the pieces don't fit together
        throw new Error('The download came out too long.');
      }
      if (have > before || have === f.size) failures = 0;
      else throw new Error('The server sent nothing.');
    } catch (err) {
      if (signal.aborted || err.fatal || ++failures > 5) throw err;
      try {
        have = fs.statSync(part).size;
      } catch {
        have = 0;
      }
      await new Promise((r) => setTimeout(r, 2000 * failures)); // network hiccup: wait and resume
    }
  }
  if (f.size && fs.statSync(part).size !== f.size) throw new Error(`Download of ${path.basename(f.dest)} is incomplete. Try again to resume.`);
  if (f.sha256 && (await sha256(part)) !== f.sha256) {
    fs.rmSync(part, { force: true });
    throw new Error(t('The download of {file} is damaged (its checksum doesn’t match). Try again.', { file: path.basename(f.dest) }));
  }
  fs.renameSync(part, f.dest);
  f.done = fs.statSync(f.dest).size;
}
