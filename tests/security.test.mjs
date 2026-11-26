// What the security review of November 2026 found and 0.2.33 changed: one test for each fix, with dummy data only.
// (The approval of connector tools is in connectors.test.mjs; the browser gate and PDFs are in reading.test.mjs.)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { EventEmitter } from 'node:events';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-test-'));
process.env.HEARTH_DATA_DIR = path.join(tmp, 'data');
process.env.HEARTH_BOTS_DIR = path.join(tmp, 'bots');
const settings = await import('../server/settings.mjs');
const util = await import('../server/util.mjs');
const phone = await import('../server/phone.mjs');
const api = await import('../server/api.mjs');
const web = await import('../server/web.mjs');
const voice = await import('../server/voice.mjs');
const opus = await import('../server/opus.mjs');
const ext = await import('../server/extensions.mjs');
const inst = await import('../server/ext-install.mjs');
const bots = await import('../server/bots.mjs');
const work = await import('../server/workfiles.mjs');
const { modelFileDest } = await import('../server/catalog.mjs');
const { wordsFor } = await import('../server/natural-voice.mjs');
const { zipStore } = await import('../public/js/xlsx.js');
const { extractDocument } = await import('../public/js/docs.js');
const { renderMarkdown } = await import('../public/js/md.js');
settings.updateSettings({ language: 'en' });

const lanReq = (headers = {}) => ({ socket: { remoteAddress: '192.168.1.77' }, headers });
const localReq = (headers = {}) => ({ socket: { remoteAddress: '127.0.0.1' }, headers });

test('a paired phone gets no API key and no connector settings, and may change everyday settings only', () => {
  settings.updateSettings({ mcpConfig: JSON.stringify({ mcpServers: { demo: { url: 'https://example.invalid/mcp', headers: { authorization: 'Bearer dummy-connector-key' } } } }) });
  const own = settings.publicSettings();
  assert.ok(own.apiKey.startsWith('hearth-') && own.mcpConfig.includes('dummy-connector-key'), 'the computer itself sees both');
  const phoneView = settings.publicSettings({ local: false });
  assert.equal(phoneView.apiKey, '');
  assert.equal(phoneView.mcpConfig, '');
  assert.ok(!JSON.stringify(phoneView).includes('dummy-connector-key'));
  for (const k of ['searchUrl', 'searchProvider', 'searchKey', 'hfToken', 'access', 'phoneAccess', 'mcpConfig', 'toolFolders', 'toolApproval', 'enginePath', 'engineArgs', 'modelsDir', 'renderPages', 'keepAwake', 'port']) assert.ok(!settings.PHONE_MAY_SET.has(k), `${k} is the computer's own setting`);
  for (const k of ['theme', 'language', 'memoryOn', 'toolsOn', 'systemPrompt']) assert.ok(settings.PHONE_MAY_SET.has(k));
  settings.updateSettings({ mcpConfig: '' });
});

test('the pairing code works once: a used or kept link cannot pair another device, and a disconnected one cannot come back', () => {
  phone.setPhoneAccess(true);
  phone.resetDevices();
  const token = () => JSON.parse(fs.readFileSync(path.join(process.env.HEARTH_DATA_DIR, 'settings.json'), 'utf8')).phoneToken;
  const res = () => ({ headers: {}, setHeader(k, v) { this.headers[k] = v; } });
  const first = token();
  assert.equal(phone.pair(lanReq(), res(), first).ok, true);
  assert.notEqual(token(), first, 'a new code after each pairing');
  assert.equal(phone.pair({ socket: { remoteAddress: '192.168.1.78' }, headers: {} }, res(), first).status, 403, 'the used code is refused');
  const second = token();
  assert.equal(phone.pair({ socket: { remoteAddress: '192.168.1.79' }, headers: {} }, res(), second).ok, true);
  const kept = token();
  phone.forgetDevice(phone.phoneInfo(7420).devices[0].id);
  assert.notEqual(token(), kept, 'disconnecting one device also replaces the code');
  phone.setPhoneAccess(false);
});

test('secrets have the length they are asked for, and a too-large request is answered before the connection closes', async () => {
  assert.equal(util.uid(32).length, 32);
  assert.equal(util.uid(40).length, 40);
  assert.match(util.uid(64), /^[A-Za-z0-9]{64}$/);
  const req = new EventEmitter();
  let destroyed = false;
  req.destroy = () => (destroyed = true);
  const body = util.readBody(req, 4096);
  req.emit('data', Buffer.alloc(3000));
  req.emit('data', Buffer.alloc(3000));
  req.emit('data', Buffer.alloc(3000));
  await assert.rejects(body, (err) => err.status === 413);
  assert.equal(destroyed, false, 'the handler can still send its 413 answer');
});

test('the API gives a network device the model, not the app: no chat context, no addresses to visit', () => {
  const body = () => ({ hearth: { tools: true }, messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] }] });
  // A device on the network that holds the key and claims to be the chat page: the claim is ignored.
  const fromLan = api.prepareBody(body(), 'openai', lanReq({ 'x-hearth-client': 'chat' }));
  assert.equal(fromLan.hearth, undefined);
  assert.equal(fromLan.messages.length, 1, 'no system message with memory or instructions was added');
  assert.equal(fromLan.messages[0].role, 'user');
  // The page on this computer does get its context.
  settings.updateSettings({ systemPrompt: 'CANARY-INSTRUCTION' });
  const fromPage = api.prepareBody(body(), 'openai', localReq({ 'x-hearth-client': 'chat' }));
  assert.equal(fromPage.messages[0].role, 'system');
  assert.match(fromPage.messages[0].content, /CANARY-INSTRUCTION/);
  settings.updateSettings({ systemPrompt: '' });
  // A picture address the engine would go and fetch is refused from the network, in both API shapes.
  const link = (url) => ({ messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url } }] }] });
  assert.throws(() => api.prepareBody(link('http://127.0.0.1:9/probe.png'), 'openai', lanReq()), (err) => err.status === 400);
  assert.throws(() => api.prepareBody({ messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'url', url: 'https://example.com/a.png' } }] }] }, 'anthropic', lanReq()), (err) => err.status === 400);
  assert.doesNotThrow(() => api.prepareBody(link('data:image/png;base64,AAAA'), 'openai', lanReq()));
  assert.doesNotThrow(() => api.prepareBody(link('https://example.com/a.png'), 'openai', localReq()), 'a program on this computer is trusted as before');
  assert.doesNotThrow(() => api.prepareBody({ messages: [null, { content: [null, 'x'] }] }, 'openai', lanReq()), 'odd shapes do not crash it');
});

test('an address is handed to the system without a command line, and network paths are refused before they are touched', async () => {
  const url = 'https://example.invalid/%USERNAME%/%CMDCMDLINE:~-1%&echo/authorize?a=1&b=2';
  assert.deepEqual(util.openCommand(url, 'win32'), ['rundll32.exe', ['url.dll,FileProtocolHandler', url]], 'no cmd.exe, so %NAME% is never filled in');
  assert.deepEqual(util.openCommand(url, 'darwin'), ['open', [url]]);
  assert.deepEqual(util.openCommand(url, 'linux'), ['xdg-open', [url]]);
  for (const src of ['oauth.mjs', 'index.mjs']) assert.ok(!/spawn\(\s*'cmd'/.test(fs.readFileSync(new URL(`../server/${src}`, import.meta.url), 'utf8')), `${src} starts nothing through cmd`);
  assert.equal(util.isNetworkPath('\\\\evil-host\\share\\x.txt'), true);
  assert.equal(util.isNetworkPath('//evil-host/share/x.txt'), true);
  assert.equal(util.isNetworkPath('/Users/me/notes.txt'), false);
  assert.equal(util.isNetworkPath('C:\\Users\\me\\notes.txt'), false);
  const bot = await bots.createBot({ template: 'helper' });
  await assert.rejects(work.callFileTool(bot, 'read_file', { path: '\\\\127.0.0.1\\hearth-test\\x.txt' }), /outside your work folder/);
  await assert.rejects(work.callFileTool(bot, 'list_files', { path: '//127.0.0.1/hearth-test' }), /outside your work folder/);
});

test('a model file lands inside its own folder, whatever the listing calls it (Windows separators too)', () => {
  const root = 'C:\\Users\\me\\AppData\\Local\\Hearth\\models\\owner\\repo';
  const win = (f) => modelFileDest(root, f, path.win32.join, path.win32.sep);
  assert.equal(win('sub/model-Q4_K_M.gguf'), `${root}\\sub\\model-Q4_K_M.gguf`);
  for (const f of ['sub/a\\..\\..\\..\\outside-Q4_K_M.gguf', '../outside.gguf', 'a/../../b.gguf', 'C:evil.gguf', '/abs.gguf', 'a//b.gguf', '']) assert.throws(() => win(f), /does not accept/, f);
  const posix = (f) => modelFileDest('/data/models/owner/repo', f, path.posix.join, path.posix.sep);
  assert.equal(posix('model.gguf'), '/data/models/owner/repo/model.gguf');
  assert.throws(() => posix('../x.gguf'), /does not accept/);
});

test('a sound file is known by its bytes, never by its name, and a recording is decoded only as far as allowed', async () => {
  const b = (s, n = 16) => Buffer.concat([Buffer.from(s, 'latin1'), Buffer.alloc(n)]);
  assert.equal(voice.soundKind(b('OggS')), 'ogg');
  assert.equal(voice.soundKind(b('RIFF\0\0\0\0WAVE')), 'wav');
  assert.equal(voice.soundKind(b('\0\0\0\x20ftypM4A ')), 'mp4');
  assert.equal(voice.soundKind(b('ID3')), 'mp3');
  assert.equal(voice.soundKind(b('fLaC')), 'flac');
  assert.equal(voice.soundKind(b('#EXTM3U\n#EXT-X-TARGETDURATION:10\n/Users/me/private.wav\n')), '', 'a playlist is not sound');
  // Named like a playlist or like a song, a playlist is refused before any program sees it.
  for (const name of ['note.m3u8', 'song.mp3']) await assert.rejects(voice.audioToWav(b('#EXTM3U\n#EXTINF:10,\n/Users/me/private.wav\n#EXT-X-ENDLIST\n'), name), (err) => err.code === 'BAD_SOUND');
  // A recording made of one-byte packets: 3,000 packets stand for minutes of sound. With a limit of 5 seconds
  // only about 5 seconds are decoded, however long the file is.
  const head = Buffer.alloc(19);
  head.write('OpusHead', 0, 'latin1');
  head[8] = 1;
  head[9] = 1;
  head.writeUInt32LE(16000, 12);
  const pages = [opus.oggPage([head], { serial: 7, seq: 0, granule: 0, flags: 2 }), opus.oggPage([Buffer.concat([Buffer.from('OpusTags'), Buffer.alloc(8)])], { serial: 7, seq: 1, granule: 0 })];
  for (let i = 0; i < 15; i++) pages.push(opus.oggPage(Array.from({ length: 200 }, () => Buffer.from([0x18])), { serial: 7, seq: 2 + i, granule: 0 }));
  const long = Buffer.concat(pages);
  const cut = opus.wavSamples(await opus.oggOpusToWav(long, { maxSeconds: 5 }));
  const seconds = cut.pcm.length / cut.rate;
  assert.ok(seconds >= 4.9 && seconds < 6, `decoded ${seconds.toFixed(2)} s`);
  const whole = opus.wavSamples(await opus.oggOpusToWav(long, { maxSeconds: 3600 }));
  assert.ok(whole.pcm.length / whole.rate > 60, 'without the limit the same file is minutes long');
});

// A zip with one entry changed into a link (its Unix file type in the list of contents).
async function zip(files, { link } = {}) {
  const bytes = Buffer.from(await zipStore(files).arrayBuffer());
  if (link) {
    let at = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    while (at >= 0) {
      const name = bytes.toString('utf8', at + 46, at + 46 + bytes.readUInt16LE(at + 28));
      if (name === link) bytes.writeUInt32LE((0xa1ff << 16) >>> 0, at + 38);
      at = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]), at + 4);
    }
  }
  return bytes;
}

test('an archive is checked before it is unpacked: real zip files only, no links, no names that point out, not too big', async () => {
  const file = path.join(tmp, 'a.zip');
  fs.writeFileSync(file, await zip([['skill/SKILL.md', '---\nname: ok\ndescription: fine\n---\nHi'], ['skill/notes.md', 'x']]));
  assert.deepEqual(inst.zipSummary(file), { entries: 2, bytes: Buffer.byteLength('---\nname: ok\ndescription: fine\n---\nHi') + 1, bad: '' });
  fs.writeFileSync(file, await zip([['skill/SKILL.md', '/etc/passwd']], { link: 'skill/SKILL.md' }));
  assert.equal(inst.zipSummary(file).bad, 'skill/SKILL.md', 'a link inside the archive is named');
  await assert.rejects(inst.inspect({ upload: fs.readFileSync(file), name: 'a.zip' }), /holds a link or a file name that points outside/);
  for (const name of ['../outside.md', '/abs.md', 'a\\b.md', 'C:x.md']) {
    fs.writeFileSync(file, await zip([[name, 'x']]));
    assert.equal(inst.zipSummary(file).bad, name);
  }
  fs.writeFileSync(file, 'this is a tar or anything else, named .zip');
  assert.equal(inst.zipSummary(file), null);
  await assert.rejects(inst.inspect({ upload: fs.readFileSync(file), name: 'a.zip' }), /Use a \.zip file/);
  // What is on the disk after unpacking is counted too, and anything that is not a plain file or folder is removed.
  const dir = fs.mkdtempSync(path.join(tmp, 'unpacked-'));
  fs.mkdirSync(path.join(dir, 'skill'));
  fs.writeFileSync(path.join(dir, 'skill', 'SKILL.md'), 'ok');
  fs.symlinkSync('/etc/hosts', path.join(dir, 'skill', 'link.md'));
  assert.deepEqual(inst.tidyUnpacked(dir), { files: 1, bytes: 2 });
  assert.equal(fs.existsSync(path.join(dir, 'skill', 'link.md')), false, 'the link is gone');
  // Nothing of a refused or closed preview stays on the disk.
  const cache = path.join(process.env.HEARTH_DATA_DIR, 'cache');
  const good = await inst.inspect({ upload: await zip([['skill/SKILL.md', '---\nname: ok\ndescription: fine\n---\nHi']]), name: 'ok.zip' });
  assert.equal(fs.readdirSync(cache).filter((n) => n.startsWith('ext-')).length, 1);
  assert.equal(inst.dropPreview(good.token), true);
  assert.equal(fs.readdirSync(cache).filter((n) => n.startsWith('ext-')).length, 0);
});

const plugin = (root, name, url) => {
  const dir = path.join(root, name);
  fs.mkdirSync(path.join(dir, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'Demo', description: 'd', version: '1' }));
  fs.writeFileSync(path.join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { calc: { url, headers: { 'x-key': '${DEMO_TOKEN}' } } } }));
  return dir;
};

test('what the user allowed and typed for a plugin does not pass to another package with the same name', async () => {
  const a = plugin(tmp, 'pack-a', 'https://a.example.invalid/mcp');
  await inst.install((await inst.inspect({ folder: a })).token);
  ext.updatePlugin('demo', { connector: 'calc', connectorOn: true });
  ext.updatePlugin('demo', { values: { DEMO_TOKEN: 'dummy-typed-secret' } });
  assert.equal(ext.pluginConnectors()['demo:calc'].headers['x-key'], 'dummy-typed-secret');
  // The same plugin installed again from the same place, unchanged: it stays as the user set it.
  await inst.install((await inst.inspect({ folder: a })).token);
  assert.equal(ext.pluginConnectors()['demo:calc']?.headers['x-key'], 'dummy-typed-secret');
  // The same place, but the connector now points somewhere else: it is off again until the user turns it on.
  fs.writeFileSync(path.join(a, '.mcp.json'), JSON.stringify({ mcpServers: { calc: { url: 'https://moved.example.invalid/mcp', headers: { 'x-key': '${DEMO_TOKEN}' } } } }));
  await inst.install((await inst.inspect({ folder: a })).token);
  assert.deepEqual(ext.pluginConnectors(), {});
  ext.updatePlugin('demo', { connector: 'calc', connectorOn: true });
  assert.ok(ext.pluginConnectors()['demo:calc']);
  // Another package that only shares the name: nothing is switched on, and the typed value is not handed over.
  const b = plugin(tmp, 'pack-b', 'https://b.example.invalid/mcp');
  await inst.install((await inst.inspect({ folder: b })).token);
  assert.deepEqual(ext.pluginConnectors(), {});
  ext.updatePlugin('demo', { connector: 'calc', connectorOn: true });
  assert.deepEqual(ext.pluginConnectors(), {}, 'switched on, but its value is missing: the old one is gone');
});

test('a web-address connector gets only what the user typed, never Hearth’s own environment', () => {
  process.env.HEARTH_TEST_SECRET = 'from-the-environment';
  try {
    const webCfg = { url: 'https://c.example.invalid/mcp?k=${HEARTH_TEST_SECRET:-}', headers: { 'x-probe': '${HEARTH_TEST_SECRET}' } };
    const filled = ext.fillConnector(webCfg, {});
    assert.ok(!JSON.stringify(filled).includes('from-the-environment'));
    assert.deepEqual(filled.missing, ['HEARTH_TEST_SECRET']);
    assert.deepEqual(ext.connectorNeeds(webCfg), ['HEARTH_TEST_SECRET'], 'a name with a fallback is listed too: nothing is filled in unseen');
    assert.equal(ext.fillConnector(webCfg, { HEARTH_TEST_SECRET: 'typed' }).cfg.headers['x-probe'], 'typed');
    // A connector that is a program could read the environment anyway, so it may use it, as before.
    assert.equal(ext.fillConnector({ command: 'node', env: { KEY: '${HEARTH_TEST_SECRET}' } }, {}).cfg.env.KEY, 'from-the-environment');
  } finally {
    delete process.env.HEARTH_TEST_SECRET;
  }
});

test('"public addresses only" also means: not this computer and not its own network, whatever range they are in', () => {
  const ifaces = { en0: [{ address: '203.0.113.7', family: 'IPv4', cidr: '203.0.113.7/24' }, { address: '2001:db8:1:2:aaaa:bbbb:cccc:dddd', family: 'IPv6', cidr: '2001:db8:1:2:aaaa:bbbb:cccc:dddd/64' }], utun9: [{ address: '2001:db8:ffff::1', family: 'IPv6', cidr: '2001:db8:ffff::1/0' }] };
  for (const ip of ['203.0.113.7', '203.0.113.200', '2001:db8:1:2:aaaa:bbbb:cccc:dddd', '2001:db8:1:2::99', '::ffff:203.0.113.9', '2001:db8:ffff::1']) assert.equal(web.isLocalAddress(ip, ifaces), true, ip);
  for (const ip of ['203.0.114.1', '2001:db8:1:3::99', '8.8.8.8', '2606:4700::1111', '2001:db8:ffff::2']) assert.equal(web.isLocalAddress(ip, ifaces), false, ip);
  assert.equal(web.isLocalAddress('192.168.1.1', {}), true, 'the private ranges as before');
  // The real machine: every address it has is refused.
  for (const a of Object.values(os.networkInterfaces()).flat()) assert.equal(web.isLocalAddress(a.address), true, a.address);
});

test('a page cannot stall Hearth: text is taken out of hostile HTML in time that grows with its size', () => {
  const page = '<html><head><title>T &amp; x</title><style>a{}</style></head><body><!-- c --><nav>menu</nav><main><h1>Head</h1><p>Text <b>bold</b></p><ul><li>one</li></ul><script>alert(1)</script>' + 'word '.repeat(120) + '</main><footer>f</footer></body></html>';
  const r = web.htmlToText(page);
  assert.equal(r.title, 'T & x');
  assert.match(r.text, /^# Head\n\nText bold\n\n- one\n\nword word/);
  assert.ok(!/alert|menu|a\{\}/.test(r.text));
  assert.match(web.htmlToText('<p>kept <svg><circle></p> also kept').text, /kept\s+also kept/, 'an element that is never closed loses only its tag');
  // Quadratic time on these would take minutes; the limit is generous because other tests run at the same time.
  for (const evil of ['<!--'.repeat(150000), '<svg '.repeat(150000), '<h1 '.repeat(150000), '<script>x<!--'.repeat(80000) + '>', '<main '.repeat(120000)]) {
    const t0 = Date.now();
    web.htmlToText(evil);
    assert.ok(Date.now() - t0 < 12000, `${evil.slice(0, 12)}… took ${Date.now() - t0} ms`);
  }
});

test('a file a bot downloads keeps a plain name and never replaces a file that is already there', async () => {
  const bot = await bots.createBot({ template: 'helper' });
  const folder = bots.workFolder(bot);
  await work.callFileTool(bot, 'write_file', { path: 'reports/prices.md', content: 'ORIGINAL' });
  const answer = (headers, url = 'https://files.example/get') => ({ status: 200, cut: false, url, headers, body: Buffer.from('REPLACED') });
  // The server names its download after the owner's file, folder and all.
  let saved = work.saveDownloaded(bot, answer({ 'content-disposition': 'attachment; filename="reports/prices.md"', 'content-type': 'text/plain' }));
  assert.equal(path.relative(folder, saved.file), 'prices.md', 'only the last part of the name is used');
  assert.equal(fs.readFileSync(path.join(folder, 'reports', 'prices.md'), 'utf8'), 'ORIGINAL');
  saved = work.saveDownloaded(bot, answer({}, 'https://files.example/a/reports%2Fprices.md'));
  assert.equal(path.relative(folder, saved.file), 'prices (2).md', 'a second file of the same name gets a number');
  saved = work.saveDownloaded(bot, answer({}, 'https://files.example/100%.pdf'));
  assert.equal(path.basename(saved.file), '100%.pdf', 'a stray % sign no longer stops the download');
  saved = work.saveDownloaded(bot, answer({ 'content-disposition': 'attachment; filename="..hidden"' }));
  assert.equal(path.basename(saved.file), 'hidden');
  // A name the bot chose itself is used as given, like write_file.
  saved = work.saveDownloaded(bot, answer({}), 'reports/prices.md');
  assert.equal(fs.readFileSync(path.join(folder, 'reports', 'prices.md'), 'utf8'), 'REPLACED');
});

test('a document that unpacks into far more than a document is refused instead of taking the memory', async () => {
  // A .docx whose main part is 8 MB of zeros, packed into a few kB; the limit is set to 1 MB for the test
  // (the real one is 96 MB a part).
  const data = zlib.deflateRawSync(Buffer.alloc(8 << 20), { level: 1 });
  const name = Buffer.from('word/document.xml');
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(8 << 20, 22);
  local.writeUInt16LE(name.length, 26);
  const cd = Buffer.alloc(46);
  cd.writeUInt32LE(0x02014b50, 0);
  cd.writeUInt16LE(20, 4);
  cd.writeUInt16LE(20, 6);
  cd.writeUInt16LE(8, 10);
  cd.writeUInt32LE(data.length, 20);
  cd.writeUInt32LE(8 << 20, 24);
  cd.writeUInt16LE(name.length, 28);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(46 + name.length, 12);
  end.writeUInt32LE(30 + name.length + data.length, 16);
  const bomb = new Uint8Array(Buffer.concat([local, name, data, cd, name, end]));
  await assert.rejects(extractDocument('big.docx', bomb, { maxPart: 1 << 20 }), /too big to read/);
  assert.equal((await extractDocument('big.docx', bomb, {})).text, '', 'under the real limit the same file is read (and holds no words)');
});

test('small things from the review: link text with code, very deep quotes, a spoken text that starts with a dash', () => {
  const md = (s) => renderMarkdown(s).html;
  assert.match(md('Run [`npm install`](https://example.com/docs) first.'), /<a href="https:\/\/example\.com\/docs"[^>]*><code>npm install<\/code><\/a>/);
  assert.ok(!md('[x](https://example.com/\u00000\u0000) `code`').includes('href="https://example.com/<code>'), 'a typed placeholder cannot carry a finished piece into an address');
  assert.doesNotThrow(() => md(`${'>'.repeat(20000)} deep`));
  assert.match(md('> a quote\n> > inside'), /<blockquote>.*<blockquote>/s);
  assert.equal(wordsFor('--sid=9 and the rest', 'en'), 'sid=9 and the rest');
  assert.equal(wordsFor('— Привет, это ответ.', 'ru'), 'Привет, это ответ.');
});
