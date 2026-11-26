// What a bot can read and write since 0.2.31: PDFs on every system (the reader is loaded by a file: address),
// pages that build themselves with scripts (opened by a browser of the computer through a gate that lets only public
// addresses through; a small script stands in for the browser here), and Word documents it writes itself.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-test-'));
process.env.HEARTH_DATA_DIR = path.join(tmp, 'data');
process.env.HEARTH_BOTS_DIR = path.join(tmp, 'bots');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const web = await import('../server/web.mjs');
const { readResolved } = await import('../server/tools.mjs');
const { docxBytes } = await import('../server/docx.mjs');
const { extractDocument } = await import('../public/js/docs.js');
const page = await import('../server/browser-page.mjs');
const bots = await import('../server/bots.mjs');
const { callFileTool } = await import('../server/workfiles.mjs');
const { toolsFor } = await import('../server/agent.mjs');
const { updateSettings } = await import('../server/settings.mjs');
updateSettings({ language: 'en' });

// A small PDF written by hand: one page, with a line of text or with none.
function pdf(text) {
  const stream = text ? `BT /F1 12 Tf 20 100 Td (${text}) Tj ET` : '';
  const objects = ['<</Type/Catalog/Pages 2 0 R>>', '<</Type/Pages/Kids[3 0 R]/Count 1>>', '<</Type/Page/Parent 2 0 R/MediaBox[0 0 600 200]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>', `<</Length ${stream.length}>>\nstream\n${stream}\nendstream`, '<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>'];
  let out = '%PDF-1.4\n';
  const at = objects.map((o, i) => {
    const pos = out.length;
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
    return pos;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${at.map((n) => `${String(n).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<</Size ${objects.length + 1}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

test('Hearth loads its own modules by file: addresses, so a Windows path like C:\\… cannot break it', async () => {
  assert.match(web.moduleUrl('public', 'vendor', 'pdfjs', 'pdf.min.mjs'), /^file:\/\/\/.+\/public\/vendor\/pdfjs\/pdf\.min\.mjs$/);
  // No module is loaded by a plain path anywhere in the server (that was why no PDF could be read on Windows).
  for (const f of fs.readdirSync(path.join(ROOT, 'server')).filter((x) => x.endsWith('.mjs'))) {
    const src = fs.readFileSync(path.join(ROOT, 'server', f), 'utf8');
    assert.ok(!/\bimport\(\s*path\./.test(src), `${f} imports by a plain path`);
    assert.ok(!/workerSrc\s*=\s*path\./.test(src), `${f} names the PDF worker by a plain path`);
  }
});

test('a PDF is read as its text; one made of pictures says so instead of looking empty', async () => {
  const words = 'The client agrees to the terms of this retainer agreement, signed in Los Angeles.';
  const file = path.join(tmp, 'form.pdf');
  fs.writeFileSync(file, pdf(words));
  assert.match(await readResolved(file), /The client agrees to the terms of this retainer agreement/);
  fs.writeFileSync(file, pdf(''));
  assert.match(await readResolved(file), /no text in it: its pages are pictures/);
  // The same through open_page, for a link that answers with a PDF.
  const get = async (url) => ({ status: 200, url, headers: { 'content-type': 'application/pdf' }, body: pdf(words) });
  const p = await web.openPage('https://example.com/api/share/1', { get });
  assert.match(p.text, /retainer agreement/);
  assert.equal(p.scanned, false);
});

test('a Word document: written from simple marks, read back with its headings, lists, tables and blank lines of a form', async () => {
  const text = '# Договор\n\nг. Москва, **24 ноября** 2026 года\n\n1. Исполнитель печатает *250* футболок.\n- Цена: 15 000 ₽ & <доставка>\n\n| Позиция | Цена |\n|---|---|\n| Футболка | 60 ₽ |\n\nПодпись: ____________';
  const bytes = await docxBytes(text);
  assert.equal(Buffer.from(bytes.subarray(0, 2)).toString(), 'PK');
  const back = (await extractDocument('x.docx', bytes, {})).text;
  assert.match(back, /^# Договор/);
  assert.match(back, /г\. Москва, 24 ноября 2026 года/);
  assert.match(back, /1\.\tИсполнитель печатает 250 футболок\./);
  assert.match(back, /•\tЦена: 15 000 ₽ & <доставка>/);
  assert.match(back, /\| Позиция \| Цена \|\n\| --- \| --- \|\n\| Футболка \| 60 ₽ \|/);
  assert.match(back, /Подпись: ____________/, 'the line to sign on stays a line');
});

test('a bot with files can save a Word document in its work folder, and only there', async () => {
  const bot = await bots.createBot({ template: 'helper' });
  const names = (await toolsFor({ ...bot, tools: { files: true } })).map((x) => x.name);
  assert.ok(names.includes('write_document') && names.includes('read_file'));
  assert.ok(!(await toolsFor({ ...bot, tools: { web: true } })).some((x) => x.name === 'write_document'), 'not without the files switch');
  const r = await callFileTool(bot, 'write_document', { path: 'letters/answer.pdf', content: '# Answer\n\nDear client, the form is **ready**.' });
  assert.equal(r.file, 'letters/answer.docx', 'always a .docx');
  const read = await callFileTool(bot, 'read_file', { path: 'letters/answer.docx' });
  assert.match(read.text, /# Answer\nDear client, the form is ready\./);
  await assert.rejects(callFileTool(bot, 'write_document', { path: '../outside.docx', content: 'x' }), /inside your work folder/);
  await assert.rejects(callFileTool(bot, 'write_document', { path: 'a.docx', content: '  ' }), /text of the document/);
});

// ---- Pages built by scripts ----

const listen = (server) => new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
// One request through the gate, the way a browser sends it. Returns the status line's code.
function through(gatePort, firstLine, host) {
  return new Promise((resolve, reject) => {
    const s = net.connect(gatePort, '127.0.0.1', () => s.write(`${firstLine}\r\nHost: ${host}\r\n\r\n`));
    let got = '';
    s.on('data', (d) => {
      got += d;
      const m = /^HTTP\/1\.1 (\d+)/.exec(got);
      if (m) {
        resolve(Number(m[1]));
        s.destroy();
      }
    });
    s.on('error', reject);
    s.on('close', () => resolve(0));
  });
}

test('the gate lets a browser reach public addresses only: nothing on this computer or the home network', async () => {
  const home = http.createServer((req, res) => res.end('router settings'));
  const port = await listen(home);
  const gate = await page.startGate();
  try {
    assert.equal(await through(gate.port, `GET http://127.0.0.1:${port}/ HTTP/1.1`, `127.0.0.1:${port}`), 403);
    assert.equal(await through(gate.port, `CONNECT 127.0.0.1:${port} HTTP/1.1`, `127.0.0.1:${port}`), 403);
    assert.equal(await through(gate.port, 'CONNECT 192.168.1.1:443 HTTP/1.1', '192.168.1.1:443'), 403);
    assert.equal(await through(gate.port, 'CONNECT [::1]:443 HTTP/1.1', '[::1]:443'), 403);
    // A name that leads to this computer is stopped when the connection is made.
    assert.notEqual(await through(gate.port, `GET http://localhost:${port}/ HTTP/1.1`, `localhost:${port}`), 200);
    assert.notEqual(await through(gate.port, `CONNECT localhost:${port} HTTP/1.1`, `localhost:${port}`), 200);
    assert.equal(await through(gate.port, 'GET ftp://example.com/ HTTP/1.1', 'example.com'), 403);
  } finally {
    await gate.close();
  }
  // The tests' own gate, open to this computer, does pass: the refusals above are the gate's doing.
  const open = await page.startGate({ allowLocal: true });
  try {
    assert.equal(await through(open.port, `GET http://127.0.0.1:${port}/ HTTP/1.1`, `127.0.0.1:${port}`), 200);
    assert.equal(await through(open.port, `CONNECT 127.0.0.1:${port} HTTP/1.1`, `127.0.0.1:${port}`), 200);
  } finally {
    await open.close();
    home.close();
  }
});

// A stand-in for the browser: it notes how it was started and "shows" a page its scripts would have built.
function standInBrowser(html) {
  const dir = fs.mkdtempSync(path.join(tmp, 'browser-'));
  const bin = path.join(dir, 'browser');
  fs.writeFileSync(path.join(dir, 'page.html'), html);
  fs.writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' "$@" > "${dir}/args.txt"\nfor a in "$@"; do case "$a" in --user-data-dir=*) ls "\${a#--user-data-dir=}/Default" > "${dir}/profile.txt";; esac; done\ncat "${dir}/page.html"\n`, { mode: 0o755 });
  return { bin, args: () => fs.readFileSync(path.join(dir, 'args.txt'), 'utf8').trim().split('\n'), profile: () => fs.readFileSync(path.join(dir, 'profile.txt'), 'utf8'), started: () => fs.existsSync(path.join(dir, 'args.txt')) };
}

const shell = '<html><head><title>Loading…</title></head><body><div id="root"></div><script src="/app.js"></script></body></html>';
const built = '<html><head><title>Client intake form</title></head><body><main><h1>Client intake form</h1><p>Full legal name of the client, the date of birth and the mailing address are required in this form. Please describe the injury and the product in a few sentences so that the firm can review the claim. The firm answers within two working days by phone or by email.</p></main></body></html>';
const get = (html) => async (url) => ({ status: 200, url, headers: { 'content-type': 'text/html; charset=utf-8' }, body: Buffer.from(html) });

test('a page that is empty without its scripts is opened by a browser of the computer, with nothing of the user in it', { skip: process.platform === 'win32' }, async () => {
  const b = standInBrowser(built);
  process.env.HEARTH_BROWSER = b.bin;
  try {
    const p = await web.openPage('https://forms.example.com/intake', { get: get(shell) });
    assert.equal(p.rendered, true);
    assert.equal(p.thin, false);
    assert.equal(p.title, 'Client intake form');
    assert.match(p.text, /Full legal name of the client/);
    const args = b.args();
    assert.equal(args.at(-1), 'https://forms.example.com/intake');
    assert.ok(args.includes('--headless') && args.includes('--dump-dom'), 'no window');
    assert.ok(args.some((a) => /^--proxy-server=http:\/\/127\.0\.0\.1:\d+$/.test(a)) && args.includes('--proxy-bypass-list=<-loopback>'), 'everything it loads goes through the gate');
    const profile = args.find((a) => a.startsWith('--user-data-dir=')).slice(16);
    assert.ok(profile.startsWith(os.tmpdir()) || profile.startsWith(fs.realpathSync(os.tmpdir())), 'a fresh profile in a temporary folder, not the user’s own');
    assert.match(b.profile(), /Preferences/);
    assert.equal(fs.existsSync(profile), false, 'and it is deleted afterwards');
    // A page with enough to read as it is does not start a browser.
    const b2 = standInBrowser(built);
    process.env.HEARTH_BROWSER = b2.bin;
    const plain = await web.openPage('https://example.com/article', { get: get(built) });
    assert.equal(plain.rendered, false);
    assert.equal(b2.started(), false);
    // Switched off in Settings → Tools: the page stays as thin as it came.
    updateSettings({ renderPages: false });
    const off = await web.openPage('https://forms.example.com/intake', { get: get(shell) });
    assert.equal(off.rendered, false);
    assert.equal(b2.started(), false);
    updateSettings({ renderPages: true });
  } finally {
    delete process.env.HEARTH_BROWSER;
  }
});

test('no browser here, or a page that stays empty (a sign-in): the model is told, not left guessing', { skip: process.platform === 'win32' }, async () => {
  process.env.HEARTH_BROWSER = ''; // none on this computer
  try {
    const none = await web.openPage('https://forms.example.com/intake', { get: get(shell) });
    assert.equal(none.rendered, false);
    assert.equal(none.thin, true);
    await assert.rejects(page.renderPage('https://example.com/'), (err) => err.code === 'NO_BROWSER');
    // A browser that also shows next to nothing: a page behind a sign-in.
    process.env.HEARTH_BROWSER = standInBrowser('<html><head><title>Sign in</title></head><body><main><p>Please sign in.</p></main></body></html>').bin;
    const signIn = await web.openPage('https://forms.example.com/intake', { get: get(shell) });
    assert.equal(signIn.thin, true);
    assert.match(signIn.text, /Please sign in/);
    await assert.rejects(page.renderPage('file:///etc/passwd'), /only http and https/);
  } finally {
    delete process.env.HEARTH_BROWSER;
  }
});

// 0.2.32: Edge on Windows neither printed the page nor closed, and Hearth waited for it without end.
test('a browser that hangs is stopped: opening a page always ends in time', { skip: process.platform === 'win32' }, async () => {
  const dir = fs.mkdtempSync(path.join(tmp, 'hang-'));
  const bin = path.join(dir, 'browser');
  fs.writeFileSync(bin, '#!/bin/sh\nsleep 60\n', { mode: 0o755 });
  process.env.HEARTH_BROWSER = bin;
  try {
    const t0 = Date.now();
    assert.equal(await page.renderPage('https://example.com/', { timeout: 2500 }), '');
    assert.ok(Date.now() - t0 < 8000, `it took ${Date.now() - t0} ms`);
    // The next page is not held up by the one before.
    const b = standInBrowser(built);
    process.env.HEARTH_BROWSER = b.bin;
    const p = await web.openPage('https://forms.example.com/intake', { get: get(shell) });
    assert.equal(p.rendered, true);
  } finally {
    delete process.env.HEARTH_BROWSER;
  }
});

