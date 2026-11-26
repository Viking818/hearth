// Tests for the downloader against a server that misbehaves the way big-file servers do: answers that end before
// the end of the file without an error (Hugging Face's file servers send big files in parts), a connection that
// drops in the middle, and a leftover piece longer than the file. Each download must still finish byte for byte.
// Run with: npm test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

process.env.HEARTH_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-test-'));
const { startDownload, getDownload, shaOf } = await import('../server/downloads.mjs');

const FILE = crypto.randomBytes(300_000);
let mode = 'parts';
let requests = 0;

// Answers ranges honestly, but sends at most 64 KB per answer ('parts'), or drops the first answer halfway ('drop').
const server = http.createServer((req, res) => {
  requests++;
  const m = /bytes=(\d+)-/.exec(req.headers.range || '');
  const start = m ? Number(m[1]) : 0;
  if (start >= FILE.length) {
    res.writeHead(416, { 'content-range': `bytes */${FILE.length}` });
    return res.end();
  }
  if (mode === 'drop' && requests === 1) {
    res.writeHead(200, { 'content-length': FILE.length });
    res.write(FILE.subarray(0, 100_000));
    return setTimeout(() => res.destroy(), 50);
  }
  const end = mode === 'parts' ? Math.min(FILE.length, start + 64 * 1024) : FILE.length;
  const body = FILE.subarray(start, end);
  // A part ends cleanly: its own length is announced and sent in full, only the file goes on.
  res.writeHead(m ? 206 : 200, { 'content-length': body.length, ...(m || end < FILE.length ? { 'content-range': `bytes ${start}-${end - 1}/${FILE.length}` } : {}), 'accept-ranges': 'bytes' });
  res.end(body);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/file.gguf`;

async function download(name, sha256) {
  const dest = path.join(process.env.HEARTH_DATA_DIR, name);
  const job = startDownload({ kind: 'model', label: name, files: [{ url, dest, size: FILE.length, sha256 }] });
  for (let i = 0; i < 300; i++) {
    const j = getDownload(job.id);
    if (j.state === 'done' || j.state === 'error') return { state: j.state, error: j.error, dest };
    await new Promise((r) => setTimeout(r, 50));
  }
  return { state: 'timeout', dest };
}

test('an answer that ends early is followed by one asking for the rest', async () => {
  mode = 'parts';
  requests = 0;
  const r = await download('parts.gguf');
  assert.equal(r.state, 'done', r.error);
  assert.ok(fs.readFileSync(r.dest).equals(FILE), 'the file is exactly the one on the server');
  assert.ok(requests >= 5, `asked ${requests} times`);
});

test('a dropped connection resumes where it stopped', async () => {
  mode = 'drop';
  requests = 0;
  const r = await download('drop.gguf');
  assert.equal(r.state, 'done', r.error);
  assert.ok(fs.readFileSync(r.dest).equals(FILE));
});

// Programs Hearth will run (engines) come with the checksum GitHub lists for the file.
test('a download is checked against its checksum: a wrong file is deleted, a wrong leftover is fetched again', async () => {
  mode = 'whole';
  const good = crypto.createHash('sha256').update(FILE).digest('hex');
  assert.equal(shaOf({ digest: `sha256:${good.toUpperCase()}` }), good);
  assert.equal(shaOf({ digest: null }), '');
  assert.equal(shaOf({}), '');
  const ok = await download('engine-ok.zip', good);
  assert.equal(ok.state, 'done', ok.error);
  const bad = await download('engine-bad.zip', 'f'.repeat(64));
  assert.equal(bad.state, 'error');
  assert.match(bad.error, /checksum/);
  assert.ok(!fs.existsSync(bad.dest) && !fs.existsSync(`${bad.dest}.part`), 'nothing of the wrong file is left');
  // A file of the right size but other content, left from an earlier try, is not taken for the real one.
  const dest = path.join(process.env.HEARTH_DATA_DIR, 'engine-old.zip');
  fs.writeFileSync(dest, Buffer.alloc(FILE.length, 7));
  const again = await download('engine-old.zip', good);
  assert.equal(again.state, 'done', again.error);
  assert.ok(fs.readFileSync(dest).equals(FILE));
});

test('a leftover longer than the file is thrown away and the download starts over', async () => {
  mode = 'whole';
  const dest = path.join(process.env.HEARTH_DATA_DIR, 'stale.gguf');
  fs.writeFileSync(`${dest}.part`, Buffer.alloc(FILE.length + 10));
  const r = await download('stale.gguf');
  assert.equal(r.state, 'done', r.error);
  assert.ok(fs.readFileSync(r.dest).equals(FILE));
  server.close();
});
