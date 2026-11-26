// Tests for playing generated videos where the browser refuses their sound (Safari, the Mac app): the video is taken
// apart into the picture alone and the sound as a WAV, without changing a single frame or sample.
// Run with: npm test. No GPU, model or network needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

process.env.HEARTH_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-webm-'));
const { splitWebm, soundIsBroken } = await import('../server/webm.mjs');
const { DIRS } = await import('../server/settings.mjs');
const vids = await import('../server/videos.mjs');

// A small WebM writer of its own (short sizes, as real files have), so the reader is checked against something it
// did not write itself.
const vint = (n) => (n < 127 ? Buffer.from([0x80 | n]) : n < 16383 ? Buffer.from([0x40 | (n >> 8), n & 0xff]) : Buffer.from([0x10, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]));
const UNKNOWN = Buffer.from([0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
const el = (id, body, unknown = false) => Buffer.concat([Buffer.from(id, 'hex'), unknown ? UNKNOWN : vint(body.length), body]);
const num = (n, bytes = 1) => {
  const b = Buffer.alloc(bytes);
  b.writeUIntBE(n, 0, bytes);
  return b;
};
const float = (n) => {
  const b = Buffer.alloc(8);
  b.writeDoubleBE(n);
  return b;
};
const block = (track, time, flags, data) => el('a3', Buffer.concat([Buffer.from([0x80 | track]), num(time, 2), Buffer.from([flags]), data]));

function sample({ unknownSizes = false, codec = 'A_PCM/INT/LIT', sound = true } = {}) {
  const frames = [Buffer.from('KEYFRAME-0'), Buffer.from('frame-1'), Buffer.from('frame-2'), Buffer.from('KEYFRAME-3'), Buffer.from('frame-4')];
  const pcm = [0, 1, 2, 3, 4].map((i) => Buffer.from(Array.from({ length: 8 }, (_, k) => i * 16 + k)));
  const header = el('1a45dfa3', Buffer.concat([el('4282', Buffer.from('webm')), el('4287', num(2)), el('4285', num(2))]));
  const info = el('1549a966', Buffer.concat([el('2ad7b1', num(1000000, 3)), el('4489', float(200))]));
  const videoTrack = el('ae', Buffer.concat([el('d7', num(1)), el('83', num(1)), el('86', Buffer.from('V_VP8')), el('e0', Buffer.concat([el('b0', num(64)), el('ba', num(32))]))]));
  const audioTrack = el('ae', Buffer.concat([el('d7', num(2)), el('83', num(2)), el('86', Buffer.from(codec)), el('e1', Buffer.concat([el('b5', float(8000)), el('9f', num(2)), el('6264', num(16))]))]));
  const tracks = el('1654ae6b', Buffer.concat(sound ? [videoTrack, audioTrack] : [videoTrack]));
  const cluster = (time, items) => el('1f43b675', Buffer.concat([el('e7', num(time, 2)), ...items]), unknownSizes);
  const a = (i) => (sound ? [block(2, i * 40, 0x80, pcm[i])] : []);
  const clusters = [
    cluster(0, [block(1, 0, 0x80, frames[0]), ...a(0), block(1, 40, 0, frames[1]), ...a(1), block(1, 80, 0, frames[2]), ...a(2)]),
    // A block group (the other way of writing a block) for one frame.
    cluster(120, [block(1, 0, 0x80, frames[3]), ...a(3), el('a0', Buffer.concat([el('a1', Buffer.concat([Buffer.from([0x81]), num(40, 2), Buffer.from([0]), frames[4]])), el('9b', num(40))])), ...a(4)]),
  ];
  // An index that points into the old file: it must not be carried over.
  const cues = el('1c53bb6b', el('bb', Buffer.concat([el('b3', num(0)), el('b7', Buffer.concat([el('f7', num(1)), el('f1', num(9999, 2))]))])));
  const file = Buffer.concat([header, el('18538067', Buffer.concat([info, tracks, ...clusters, ...(unknownSizes ? [] : [cues])]), unknownSizes)]);
  return { file, frames, pcm: Buffer.concat(pcm), info, videoTrack };
}

// What splitWebm wrote itself (the segment and its index), flat: id, start of data, end. Its own elements have
// 8-byte sizes; the track and the frames inside are copied from the original and are not walked into.
function walk(buf, from, to, out = [], depth = 0) {
  const masters = new Set(['18538067', '1c53bb6b', 'bb', 'b7']);
  let at = from;
  while (at < to) {
    let len = 1;
    while (!(buf[at] & (0x80 >> (len - 1)))) len++;
    const id = buf.toString('hex', at, at + len);
    // The info element is the original's, with a short size; everything else here has an 8-byte one.
    const short = id === '1549a966';
    if (!short) assert.equal(buf[at + len], 0x01, `8-byte size after ${id}`);
    const size = short ? buf[at + len] & 0x7f : Number(buf.readBigUInt64BE(at + len) & 0x00ffffffffffffffn);
    const data = at + len + (short ? 1 : 8);
    out.push({ id, at, data, end: data + size, depth });
    if (masters.has(id)) walk(buf, data, data + size, out, depth + 1);
    at = data + size;
  }
  assert.equal(at, to, 'sizes add up');
  return out;
}

test('a video is taken apart: the picture alone with an index, the sound as a WAV, nothing changed', () => {
  const s = sample();
  const r = splitWebm(s.file);
  assert.ok(r);
  assert.equal(r.codec, 'V_VP8');
  assert.equal(r.sound, 'A_PCM/INT/LIT');

  // The sound: a normal WAV with exactly the samples that were in the video, in order.
  assert.equal(r.wav.toString('latin1', 0, 4), 'RIFF');
  assert.equal(r.wav.readUInt16LE(22), 2, 'channels');
  assert.equal(r.wav.readUInt32LE(24), 8000, 'rate');
  assert.equal(r.wav.readUInt16LE(34), 16, 'bits');
  assert.equal(r.wav.readUInt32LE(40), s.pcm.length);
  assert.deepEqual(r.wav.subarray(44), s.pcm);

  // The picture: the same header and info, one track, and every frame as it was.
  const headerEnd = s.file.indexOf(Buffer.from('18538067', 'hex'));
  assert.deepEqual(r.video.subarray(0, headerEnd), s.file.subarray(0, headerEnd));
  const all = walk(r.video, headerEnd, r.video.length);
  const seg = all[0];
  assert.equal(seg.id, '18538067');
  assert.equal(seg.end, r.video.length);
  assert.deepEqual(all.filter((e) => e.depth === 1).map((e) => e.id), ['1549a966', '1654ae6b', '1c53bb6b', '1f43b675', '1f43b675']);
  const tracks = all.find((e) => e.id === '1654ae6b');
  assert.deepEqual(r.video.subarray(tracks.data, tracks.end), s.videoTrack, 'only the video track');
  assert.deepEqual(r.video.subarray(all[1].at, all[1].end), s.info, 'the same info (length, time scale)');
  for (const f of s.frames) assert.ok(r.video.includes(f), `frame ${f}`);
  assert.ok(!r.video.includes(s.pcm.subarray(0, 8)), 'no sound left in it');
  assert.ok(!r.video.includes(Buffer.from('A_PCM')));

  // The index points at the two clusters (both start with a whole picture), counted from the segment's content.
  const points = all.filter((e) => e.id === 'bb');
  const clusters = all.filter((e) => e.id === '1f43b675');
  assert.equal(points.length, 2);
  const cue = (p, id) => {
    const e = all.find((x) => x.id === id && x.at > p.at && x.end <= p.end);
    return Number(r.video.readBigUInt64BE(e.data));
  };
  assert.deepEqual(points.map((p) => cue(p, 'b3')), [0, 120], 'times');
  assert.deepEqual(points.map((p) => seg.data + cue(p, 'f1')), clusters.map((c) => c.at), 'places');

  // Taken apart again, the result is itself a sound video with the same frames and no sound.
  const again = splitWebm(r.video);
  assert.equal(again.wav, null);
  for (const f of s.frames) assert.ok(again.video.includes(f));
});

test('files written without sizes (as while recording), without sound, or with other sound', () => {
  const live = sample({ unknownSizes: true });
  const r = splitWebm(live.file);
  assert.ok(r, 'unknown sizes are read');
  assert.deepEqual(r.wav.subarray(44), live.pcm);
  for (const f of live.frames) assert.ok(r.video.includes(f));

  const silent = splitWebm(sample({ sound: false }).file);
  assert.equal(silent.wav, null);
  assert.equal(silent.sound, '');

  // Sound the browser plays itself (Opus) is not turned into a WAV; the picture is still there.
  const opus = splitWebm(sample({ codec: 'A_OPUS' }).file);
  assert.equal(opus.wav, null);
  assert.ok(opus.video.includes(Buffer.from('KEYFRAME-3')));
});

test('what is not a video is refused quietly', () => {
  assert.equal(splitWebm(Buffer.alloc(0)), null);
  assert.equal(splitWebm(Buffer.from('this is not a video file at all')), null);
  assert.equal(splitWebm(Buffer.alloc(5000, 0xff)), null);
  const good = sample().file;
  assert.equal(splitWebm(good.subarray(0, 60)), null, 'cut off in the header');
  for (const cut of [100, 150, good.length - 20, good.length - 1]) assert.doesNotThrow(() => splitWebm(good.subarray(0, cut)), `cut at ${cut}`);
  // Sizes that point past the end of the file.
  const lying = Buffer.from(good);
  lying[good.indexOf(Buffer.from('1f43b675', 'hex')) + 4] = 0x7f;
  assert.doesNotThrow(() => splitWebm(lying));
});

test('a video that is only full-volume noise is recognised as broken; quiet, loud and silent ones are not', () => {
  const wav = (samples) => {
    const b = Buffer.alloc(44 + samples.length * 2);
    b.write('RIFF', 0, 'latin1');
    b.write('WAVEfmt ', 8, 'latin1');
    b.writeUInt16LE(16, 34);
    samples.forEach((v, i) => b.writeInt16LE(v, 44 + i * 2));
    return b;
  };
  const n = 20000;
  assert.equal(soundIsBroken(wav(Array.from({ length: n }, (_, i) => (i % 2 ? 32767 : -32768)))), true, 'pinned at the limits');
  assert.equal(soundIsBroken(wav(Array.from({ length: n }, (_, i) => Math.round(Math.sin(i / 20) * 30000)))), false, 'loud music');
  assert.equal(soundIsBroken(wav(Array.from({ length: n }, (_, i) => Math.round(Math.sin(i / 20) * 3000)))), false, 'ordinary sound');
  assert.equal(soundIsBroken(wav(new Array(n).fill(0))), false, 'silence');
  assert.equal(soundIsBroken(null), false, 'no sound at all');
  assert.equal(soundIsBroken(Buffer.alloc(10)), false);
});

test('the gallery keeps the two play files beside a video and removes them with it', () => {
  const gallery = path.join(DIRS.videos, 'gallery');
  const play = path.join(DIRS.videos, 'play');
  const name = '2026-11-10-test1.webm';
  fs.writeFileSync(path.join(gallery, name), sample().file);
  fs.writeFileSync(path.join(gallery, `${name}.json`), '{}');

  const picture = vids.videoPlayPath(name);
  const sound = vids.videoPlayPath(`${name}.wav`);
  assert.equal(picture, path.join(play, name));
  assert.equal(sound, path.join(play, `${name}.wav`));
  assert.ok(fs.readFileSync(picture).includes(Buffer.from('KEYFRAME-0')));
  assert.equal(fs.readFileSync(sound).toString('latin1', 0, 4), 'RIFF');
  assert.deepEqual(fs.readdirSync(play).sort(), [name, `${name}.wav`], 'no half-written files left');
  // The gallery lists the video once: the play files are not videos of their own.
  assert.deepEqual(vids.videoGallery().map((g) => g.name), [name]);

  // Only a video of the gallery can be asked for.
  for (const bad of ['../settings.json', 'nothing.webm', `${name}.json`, `../gallery/${name}`, `${name}.wav.wav`, '']) assert.equal(vids.videoPlayPath(bad), '', bad);

  // A video that can't be taken apart has no play files, and asking for them is not an error.
  fs.writeFileSync(path.join(gallery, 'broken.webm'), 'not a video');
  assert.equal(vids.videoPlayPath('broken.webm'), '');
  assert.equal(vids.videoPlayPath('broken.webm.wav'), '');
  vids.deleteVideo('broken.webm');

  assert.ok(vids.deleteVideo(name));
  assert.deepEqual(fs.readdirSync(play), []);
  assert.deepEqual(vids.videoGallery(), []);
});

test('over HTTP: the picture and the sound of a gallery video are served for playing, with seeking', { timeout: 60000 }, async () => {
  const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-webm-http-'));
  const PORT = 7488;
  const name = '2026-11-10-http1.webm';
  const s = sample();
  fs.mkdirSync(path.join(data, 'videos', 'gallery'), { recursive: true });
  fs.writeFileSync(path.join(data, 'videos', 'gallery', name), s.file);
  fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ port: PORT, language: 'en', autoLoad: false }));
  const p = spawn(process.execPath, [path.join(ROOT, 'server', 'index.mjs')], { cwd: ROOT, env: { ...process.env, HEARTH_DATA_DIR: data }, stdio: 'ignore' });
  const base = `http://127.0.0.1:${PORT}`;
  try {
    let up = false;
    for (let i = 0; i < 100 && !up; i++) {
      up = await fetch(`${base}/api/status`).then((r) => r.ok, () => false);
      if (!up) await new Promise((r) => setTimeout(r, 200));
    }
    assert.ok(up, 'Hearth started');
    const whole = await fetch(`${base}/videos/${name}`);
    assert.equal(whole.headers.get('content-type'), 'video/webm');
    assert.deepEqual(Buffer.from(await whole.arrayBuffer()), s.file, 'the video itself is untouched');
    const picture = await fetch(`${base}/videos/play/${name}`);
    assert.equal(picture.status, 200);
    assert.equal(picture.headers.get('content-type'), 'video/webm');
    assert.equal(picture.headers.get('accept-ranges'), 'bytes');
    assert.ok(!Buffer.from(await picture.arrayBuffer()).includes(Buffer.from('A_PCM')));
    const sound = await fetch(`${base}/videos/play/${name}.wav`);
    assert.equal(sound.headers.get('content-type'), 'audio/wav');
    assert.deepEqual(Buffer.from(await sound.arrayBuffer()).subarray(44), s.pcm);
    const part = await fetch(`${base}/videos/play/${name}.wav`, { headers: { range: 'bytes=0-3' } });
    assert.equal(part.status, 206);
    assert.equal(await part.text(), 'RIFF');
    for (const bad of ['nothing.webm', '..%2F..%2Fsettings.json', `${name}.json`, `..%2Fgallery%2F${name}`]) assert.equal((await fetch(`${base}/videos/play/${bad}`)).status, 404, bad);
    // Deleting the video removes what was made for playing it.
    assert.equal((await fetch(`${base}/api/videos/${name}`, { method: 'DELETE' })).status, 200);
    assert.equal((await fetch(`${base}/videos/play/${name}`)).status, 404);
    assert.deepEqual(fs.readdirSync(path.join(data, 'videos', 'play')), []);
  } finally {
    p.kill();
  }
});
