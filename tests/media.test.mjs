// Tests for pictures and videos in the chat: what an answer may show, what the model is given for a video, how a
// video is kept and played back, and pictures that connector tools send. Run with: npm test.
// No GPU, model or network needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-media-'));
process.env.HEARTH_DATA_DIR = DATA;
const { renderMarkdown, mediaHtml } = await import('../public/js/md.js');
const { apiMessages, videoNote, videoType, isVideo, clock } = await import('../public/js/media.js');
const { keepToolImage } = await import('../server/mcp.mjs');
const { saveBody } = await import('../server/util.mjs');
const { saveChat, deleteChat } = await import('../server/chats.mjs');
const { trimWav } = await import('../server/voice.mjs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const html = (md) => renderMarkdown(md).html;

test('an answer shows Hearth’s own pictures and videos at once', () => {
  assert.match(html('Here: ![a cat](/uploads/abc-1.png)'), /<img class="md-img" src="\/uploads\/abc-1\.png" alt="a cat"/);
  assert.match(html('![made](/images/z-image-12.png)'), /<img class="md-img" src="\/images\/z-image-12\.png"/);
  assert.match(html('![clip](/uploads/abc.mp4)'), /<video class="md-video" src="\/uploads\/abc\.mp4" controls/);
  assert.match(html('![clip](/videos/ltx-3.webm)'), /<video class="md-video" src="\/videos\/ltx-3\.webm"/);
  assert.match(html('![dot](data:image/png;base64,AAAA)'), /<img class="md-img" src="data:image\/png;base64,AAAA"/);
});

test('a picture or video on another site waits for the user’s click', () => {
  for (const md of ['![x](https://cdn.example.com/a/b?sig=1)', 'see https://example.com/pic.jpg', '[the clip](https://example.com/v.mp4)', 'https://example.com/movie.webm']) {
    const h = html(md);
    assert.ok(!/<img|<video/.test(h), `nothing is fetched for: ${md}`);
    assert.match(h, /class="md-ask" data-media="https:\/\/(cdn\.)?example\.com\//, md);
    assert.match(h, /data-media-act="show"/);
    assert.match(h, /data-media-act="always"/);
  }
  assert.match(html('see https://example.com/pic.jpg'), /<a href="https:\/\/example\.com\/pic\.jpg"/, 'the link stays');
  assert.match(html('![x](https://cdn.example.com/a/b)'), /data-kind="image"/, 'the picture form counts without a file ending');
  assert.match(html('https://example.com/movie.webm'), /data-kind="video"/);
  // An ordinary link is only a link.
  assert.ok(!/md-ask/.test(html('[docs](https://example.com/page) and https://example.com/a.pdf')));
});

test('what is not a picture stays text, and nothing slips into the page', () => {
  for (const md of ['![x](javascript:alert(1))', '![x](data:text/html;base64,AAAA)', '![x](data:image/svg+xml;base64,AAAA)', '![x](/uploads/../settings.json)', '![x](/api/settings)', '![x](file:///etc/passwd)', '![x](//evil.example/a.png)']) {
    assert.ok(!/<img|<video|md-ask/.test(html(md)), md);
  }
  const h = html('![a"onerror="alert(1)](/uploads/a.png) ![b](https://e.example/a.png"onerror="x)');
  assert.ok(!/onerror="alert/.test(h) && !/png"onerror/.test(h), 'quotes are escaped');
  assert.equal(mediaHtml('https://example.com/page'), '');
  assert.equal(mediaHtml('mailto:a@example.com'), '');
});

test('videos: which files count, and how long they are said to be', () => {
  assert.equal(videoType({ name: 'IMG_1.MOV', type: '' }), 'video/quicktime');
  assert.equal(videoType({ name: 'a.mp4', type: 'video/mp4' }), 'video/mp4');
  assert.equal(videoType({ name: 'clip', type: 'video/webm' }), 'video/webm');
  assert.equal(videoType({ name: 'a.mkv', type: 'video/x-matroska' }), '', 'not one Hearth can play');
  assert.ok(isVideo({ name: 'a.mkv', type: '' }) && isVideo({ name: 'x', type: 'video/avi' }), 'still known as a video, to say so');
  assert.ok(!isVideo({ name: 'notes.txt', type: 'text/plain' }));
  assert.equal(clock(0), '0:00');
  assert.equal(clock(75.9), '1:15');
});

test('the model gets a video as frames in order, with their times and what is said', () => {
  const video = { url: '/uploads/v.mp4', name: 'party.mp4', duration: 12, frames: [{ at: 1, url: '/uploads/f1.jpg' }, { at: 6, url: '/uploads/f2.jpg' }, { at: 11, url: '/uploads/f3.jpg' }], transcript: 'Happy birthday!' };
  const [m] = apiMessages([{ role: 'user', content: 'What is this?', images: [{ url: '/uploads/photo.png' }], videos: [video] }]);
  assert.deepEqual(m.content.slice(1).map((p) => p.image_url.url), ['/uploads/photo.png', '/uploads/f1.jpg', '/uploads/f2.jpg', '/uploads/f3.jpg'], 'the photo, then the frames');
  const text = m.content[0].text;
  assert.match(text, /^What is this\?/);
  assert.match(text, /Video "party\.mp4", 0:12 long\. Pictures 2 to 4 below are 3 frames from it, in order, taken at 0:01, 0:06, 0:11\./);
  assert.match(text, /What is said in it: "Happy birthday!"/);
  // The video file itself never goes to the model.
  assert.ok(!JSON.stringify(m).includes('/uploads/v.mp4'));

  // Two videos: each note points at its own pictures.
  const two = apiMessages([{ role: 'user', content: '', videos: [video, { ...video, name: 'b.mov', transcript: '', frames: [{ at: 0, url: '/uploads/g1.jpg' }] }] }])[0];
  assert.match(two.content[0].text, /^Watch this video/);
  assert.match(two.content[0].text, /"party\.mp4".*Pictures 1 to 3 below/s);
  assert.match(two.content[0].text, /"b\.mov".*Picture 4 below is a frame from it\. Its sound is not included\./s);
  assert.equal(two.content.length, 5);

  assert.match(videoNote({ ...video, speechCut: true }, 1, true), /\(the first 10 minutes\)/);
});

test('a model that can’t see gets words only: the speech of a video, and a note about pictures', () => {
  const video = { url: '/uploads/v.mp4', name: 'talk.mp4', duration: 60, frames: [{ at: 5, url: '/uploads/f1.jpg' }], transcript: 'Welcome to the shop.' };
  const [m] = apiMessages([{ role: 'user', content: 'Sum it up', images: [{ url: '/uploads/p.png' }], videos: [video] }], { sees: false });
  assert.equal(typeof m.content, 'string', 'no picture parts');
  assert.match(m.content, /1 picture\(s\) came with this message, but the loaded model can’t see pictures/);
  assert.match(m.content, /Its frames are not included/);
  assert.match(m.content, /Welcome to the shop\./);
  // Plain messages are as before.
  assert.deepEqual(apiMessages([{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }]), [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }]);
});

test('a picture from a connector tool is kept so the chat can show it; anything else is not', () => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  const note = keepToolImage({ type: 'image', mimeType: 'image/png', data: png.toString('base64') });
  const name = /\/uploads\/(tool-[\w-]+\.png)/.exec(note)?.[1];
  assert.ok(name, note);
  assert.deepEqual(fs.readFileSync(path.join(DATA, 'uploads', name)), png);
  const before = fs.readdirSync(path.join(DATA, 'uploads')).length;
  assert.equal(keepToolImage({ type: 'image', mimeType: 'image/svg+xml', data: 'PHN2Zz4=' }), '', 'no SVG (it can carry script)');
  assert.equal(keepToolImage({ type: 'image', mimeType: 'text/html', data: 'PGI+' }), '');
  assert.equal(keepToolImage({ type: 'image', mimeType: 'image/png', data: '../../etc' }), '');
  assert.equal(keepToolImage({ type: 'image', mimeType: 'image/png' }), '');
  assert.equal(fs.readdirSync(path.join(DATA, 'uploads')).length, before);
});

test('deleting a chat takes its videos along, unless a branch still shows them; pictures stay', () => {
  const up = path.join(DATA, 'uploads');
  for (const f of ['vid-1.mp4', 'vid-1a.jpg', 'vid-1b.jpg', 'photo-1.png', 'other-9.mov']) fs.writeFileSync(path.join(up, f), 'x');
  const message = { id: 'm1', role: 'user', content: 'look', images: [{ url: '/uploads/photo-1.png' }], videos: [{ url: '/uploads/vid-1.mp4', name: 'a.mp4', poster: '/uploads/vid-1a.jpg', frames: [{ at: 0, url: '/uploads/vid-1a.jpg' }, { at: 2, url: '/uploads/vid-1b.jpg' }] }] };
  saveChat('chat-one', { title: 'one', messages: [message] });
  saveChat('chat-branch', { title: 'branch', messages: [message] });
  // A made-up address must never reach outside the uploads folder.
  saveChat('chat-odd', { title: 'odd', messages: [{ id: 'm2', role: 'user', videos: [{ url: '/uploads/../settings.json', frames: [{ url: '/uploads/..%2Fx.jpg' }, null, 5] }, 'junk'] }] });
  const left = () => fs.readdirSync(up).filter((f) => /^(vid|photo|other)-/.test(f)).sort();
  deleteChat('chat-one');
  assert.deepEqual(left(), ['other-9.mov', 'photo-1.png', 'vid-1.mp4', 'vid-1a.jpg', 'vid-1b.jpg'], 'the branch still shows the video');
  deleteChat('chat-odd');
  deleteChat('chat-branch');
  assert.deepEqual(left(), ['other-9.mov', 'photo-1.png'], 'the video and its frames are gone; the photo and other files stay');
});

test('speech from a video: the first ten minutes of its sound, and silence is not sent to the speech engine', () => {
  const wav = (samples, extra = Buffer.alloc(0)) => {
    const head = Buffer.alloc(12);
    head.write('RIFF', 0, 'latin1');
    head.write('WAVE', 8, 'latin1');
    const fmt = Buffer.alloc(24);
    fmt.write('fmt ', 0, 'latin1');
    fmt.writeUInt32LE(16, 4);
    const data = Buffer.alloc(8 + samples.length * 2);
    data.write('data', 0, 'latin1');
    data.writeUInt32LE(samples.length * 2, 4);
    samples.forEach((v, i) => data.writeInt16LE(v, 8 + i * 2));
    return Buffer.concat([head, fmt, extra, data]);
  };
  // macOS puts a filler chunk before the sound; it is stepped over.
  const filler = Buffer.alloc(8 + 6);
  filler.write('FLLR', 0, 'latin1');
  filler.writeUInt32LE(6, 4);
  const loud = trimWav(wav(Array.from({ length: 16000 }, (_, i) => (i % 2 ? 9000 : -9000)), filler));
  assert.equal(loud.silent, false);
  assert.equal(loud.cut, false);
  assert.equal(loud.wav.length, 44 + 32000);
  assert.equal(loud.wav.readUInt32LE(40), 32000);
  assert.equal(loud.wav.readUInt32LE(24), 16000);
  assert.equal(loud.wav.readInt16LE(44 + 2), 9000);
  assert.equal(trimWav(wav(new Array(16000).fill(3))).silent, true);
  const long = trimWav(wav(new Array(16000 * 3).fill(5000)), 2);
  assert.equal(long.cut, true);
  assert.equal(long.wav.length, 44 + 2 * 32000);
  assert.equal(trimWav(Buffer.from('not a wav file at all, just some text that is long enough')), null);
});

test('a big upload goes straight to a file, and one that is too big or cut off leaves nothing', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-body-'));
  let limit = 1 << 20;
  const got = [];
  const srv = http.createServer(async (req, res) => {
    try {
      got.push(await saveBody(req, path.join(dir, req.url.slice(1)), limit));
      res.end('ok');
    } catch (err) {
      got.push(err.status || err.message);
      res.writeHead(err.status || 500, { connection: 'close' }).end();
    }
  }).listen(0, '127.0.0.1');
  await new Promise((r) => srv.once('listening', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    const body = Buffer.alloc(300000, 7);
    assert.equal((await fetch(`${base}/a.mp4`, { method: 'POST', body })).status, 200);
    assert.deepEqual(fs.readFileSync(path.join(dir, 'a.mp4')), body);
    limit = 1000;
    assert.equal((await fetch(`${base}/b.mp4`, { method: 'POST', body }).catch(() => ({ status: 413 }))).status, 413);
    // Cut off in the middle: the sender says 5000 bytes, sends 100 and goes away.
    limit = 1 << 20;
    await new Promise((resolve) => {
      const req = http.request(`${base}/c.mp4`, { method: 'POST', headers: { 'content-length': 5000 } });
      req.on('error', () => {});
      req.write(Buffer.alloc(100));
      setTimeout(() => {
        req.destroy();
        resolve();
      }, 200);
    });
    await sleep(300);
    assert.deepEqual(fs.readdirSync(dir), ['a.mp4'], 'no half files');
    assert.deepEqual(got, [300000, 413, 400]);
  } finally {
    srv.close();
  }
});

test('over HTTP: a video is kept, plays with seeking, and other kinds of file are refused', { timeout: 60000 }, async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-media-http-'));
  const PORT = 7486;
  fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ port: PORT, language: 'en', autoLoad: false }));
  const p = spawn(process.execPath, [path.join(ROOT, 'server', 'index.mjs')], { cwd: ROOT, env: { ...process.env, HEARTH_DATA_DIR: data }, stdio: 'ignore' });
  const base = `http://127.0.0.1:${PORT}`;
  try {
    let up = false;
    for (let i = 0; i < 100 && !up; i++) {
      up = await fetch(`${base}/api/status`).then((r) => r.ok, () => false);
      if (!up) await sleep(200);
    }
    assert.ok(up, 'Hearth started');
    const bytes = Buffer.from(Array.from({ length: 5000 }, (_, i) => i % 251));
    const post = (type, body = bytes, headers = {}) => fetch(`${base}/api/uploads`, { method: 'POST', headers: { 'content-type': type, ...headers }, body });

    for (const [type, ext] of [['video/mp4', '.mp4'], ['video/quicktime', '.mov'], ['video/webm', '.webm'], ['video/x-m4v', '.m4v']]) {
      const r = await post(type);
      assert.equal(r.status, 200, type);
      const j = await r.json();
      assert.match(j.url, new RegExp(`^/uploads/[\\w-]+\\${ext}$`));
      assert.equal(j.size, bytes.length);
    }
    const { url } = await (await post('video/mp4; codecs=avc1')).json();
    assert.deepEqual(fs.readFileSync(path.join(data, 'uploads', path.basename(url))), bytes);

    // Players ask for parts of the file (Safari plays nothing without this).
    const whole = await fetch(base + url);
    assert.equal(whole.status, 200);
    assert.equal(whole.headers.get('content-type'), 'video/mp4');
    assert.equal(whole.headers.get('accept-ranges'), 'bytes');
    assert.equal(whole.headers.get('x-content-type-options'), 'nosniff');
    assert.equal((await whole.arrayBuffer()).byteLength, bytes.length);
    const part = await fetch(base + url, { headers: { range: 'bytes=100-199' } });
    assert.equal(part.status, 206);
    assert.equal(part.headers.get('content-range'), `bytes 100-199/${bytes.length}`);
    assert.deepEqual(Buffer.from(await part.arrayBuffer()), bytes.subarray(100, 200));
    const tail = await fetch(base + url, { headers: { range: 'bytes=-10' } });
    assert.deepEqual(Buffer.from(await tail.arrayBuffer()), bytes.subarray(-10));
    assert.equal((await fetch(base + url, { headers: { range: 'bytes=9999-' } })).status, 416);
    assert.equal((await fetch(`${base}/uploads/nothing.mp4`)).status, 404);
    assert.equal((await fetch(`${base}/uploads/..%2Fsettings.json`)).status, 404);

    // Pictures as before; other kinds are refused, and so is another site's page.
    assert.match((await (await post('image/png')).json()).url, /\.png$/);
    for (const type of ['video/x-matroska', 'video/avi', 'application/octet-stream', 'text/html', 'image/svg+xml', '']) assert.equal((await post(type)).status, 415, type || 'no type');
    assert.equal((await post('video/mp4', bytes, { origin: 'https://evil.example' })).status, 403);
    assert.ok(!fs.readdirSync(path.join(data, 'uploads')).some((f) => /\.(part|html|svg|mkv)$/.test(f)));

    // Speech of a video: only a video in the uploads folder can be named.
    const speech = (u) => fetch(`${base}/api/voice/video`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: u }) });
    for (const u of ['/uploads/../settings.json', '/uploads/nothing.mov', '/images/a.mp4', '', '/uploads/a.txt']) assert.equal((await speech(u)).status, 404, u);
    assert.deepEqual(await (await speech(url)).json(), { text: '', cut: false }, 'no speech engine here: no text, no error');

    // An iPhone photo (HEIC): a Mac turns it into a JPEG; elsewhere Hearth says what to do.
    const heic = await post('image/heic', Buffer.from('not a real photo'));
    assert.equal(heic.status, 415);
    assert.match((await heic.json()).error.message, /HEIC/);
  } finally {
    p.kill();
  }
});

test('an iPhone photo (HEIC) becomes a JPEG on a Mac', { skip: process.platform !== 'darwin', timeout: 60000 }, async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-heic-'));
  const PORT = 7487;
  fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ port: PORT, language: 'en', autoLoad: false }));
  // A real HEIC, made by macOS itself from a tiny PNG.
  const png = path.join(data, 'dot.png');
  const heic = path.join(data, 'dot.heic');
  fs.writeFileSync(png, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAQklEQVR42u3PMQEAAAgDoGn/zlrB5wMS0JNqK+0EBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEvg4c1AGAoahCnAAAAABJRU5ErkJggg==', 'base64'));
  const made = await new Promise((r) => spawn('/usr/bin/sips', ['-s', 'format', 'heic', png, '--out', heic], { stdio: 'ignore' }).once('exit', r).once('error', () => r(1)));
  if (made !== 0 || !fs.existsSync(heic)) return; // this macOS can't write HEIC: nothing to test with
  const p = spawn(process.execPath, [path.join(ROOT, 'server', 'index.mjs')], { cwd: ROOT, env: { ...process.env, HEARTH_DATA_DIR: data }, stdio: 'ignore' });
  const base = `http://127.0.0.1:${PORT}`;
  try {
    let up = false;
    for (let i = 0; i < 100 && !up; i++) {
      up = await fetch(`${base}/api/status`).then((r) => r.ok, () => false);
      if (!up) await sleep(200);
    }
    assert.ok(up, 'Hearth started');
    const r = await fetch(`${base}/api/uploads`, { method: 'POST', headers: { 'content-type': 'image/heic' }, body: fs.readFileSync(heic) });
    assert.equal(r.status, 200);
    const { url } = await r.json();
    assert.match(url, /\.jpg$/);
    const jpg = Buffer.from(await (await fetch(base + url)).arrayBuffer());
    assert.deepEqual([jpg[0], jpg[1], jpg[2]], [0xff, 0xd8, 0xff], 'a JPEG');
    assert.ok(!fs.readdirSync(path.join(data, 'uploads')).some((f) => f.endsWith('.heic')), 'the original is not kept');
  } finally {
    p.kill();
  }
});
