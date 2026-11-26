// Tests for the 0.2 features: languages, documents, tables, tools and their limits, MCP, batch checks, phones.
// Run with: npm test. No GPU, model or network needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
process.env.HEARTH_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-test-'));
const { t, tn } = await import('../public/js/i18n.js');
const { collectKeys } = await import('../scripts/i18n-keys.mjs');
const ru = (await import('../public/js/lang/ru.js')).default;
const { extractDocument, estimateTokens } = await import('../public/js/docs.js');
const { xlsxBlob, csvText, zipStore } = await import('../public/js/xlsx.js');
const { isPrivateIp, htmlToText, fetchPublic } = await import('../server/web.mjs');
const { updateSettings } = await import('../server/settings.mjs');
const { callTool, listTools } = await import('../server/tools.mjs');
const { parseMcpConfig, stopMcp, winQuote } = await import('../server/mcp.mjs');
const { createBatch, getBatch, stopBatch, editBatchCell } = await import('../server/batch.mjs');
const { pair, lanHostOk, setPhoneAccess, resetDevices } = await import('../server/phone.mjs');
const { runWithLang } = await import('../server/i18n.mjs');
const { planModel } = await import('../server/plan.mjs');
const { listAssistants, saveAssistant, deleteAssistant, resetAssistants, addMemory, listMemory, memoryPrompt } = await import('../server/assistants.mjs');

const bytes = async (blob) => new Uint8Array(await blob.arrayBuffer());
// Server messages follow the system language when no page asked; the tests pin English.
updateSettings({ language: 'en' });
const inRussian = (fn) => runWithLang({ headers: { 'x-hearth-lang': 'ru' } }, fn);

test('every text in the code has a Russian translation, with three plural forms where counted', () => {
  const keys = collectKeys();
  assert.ok(keys.size > 700);
  for (const [k, e] of keys) {
    assert.ok(k in ru, `missing in ru.js: ${k}`);
    if (e.plural) assert.ok(Array.isArray(ru[k]) && ru[k].length === 3, `plural forms for ${k}`);
    else assert.equal(typeof ru[k], 'string', `string for ${k}`);
  }
  // Placeholders survive translation.
  for (const [k, v] of Object.entries(ru)) {
    const want = [...k.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join();
    for (const form of [v].flat()) assert.equal([...form.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).filter((x, i, a) => a.indexOf(x) === i).sort().join(), [...new Set(want.split(','))].filter(Boolean).sort().join(), `placeholders in ${k}`);
  }
});

test('Russian plurals and placeholders', () => {
  inRussian(() => {
    assert.equal(tn(1, '{n} page', '{n} pages'), '1 страница');
    assert.equal(tn(3, '{n} page', '{n} pages'), '3 страницы');
    assert.equal(tn(11, '{n} page', '{n} pages'), '11 страниц');
    assert.equal(tn(22, '{n} page', '{n} pages'), '22 страницы');
    assert.equal(t('{n} GB', { n: 48 }), '48 ГБ');
    assert.equal(t('A sentence nobody translated'), 'A sentence nobody translated');
  });
  assert.equal(tn(1, '{n} page', '{n} pages'), '1 page');
  assert.equal(tn(5, '{n} page', '{n} pages'), '5 pages');
});

test('the server answers in the language of the page that asked', async () => {
  const hw = { unified: true, gpuBudget: 40 * 1024 ** 3, ram: 48 * 1024 ** 3 };
  const model = { size: 5e9, moe: false };
  const plan = (lang) => runWithLang({ headers: { 'x-hearth-lang': lang } }, () => planModel(hw, model, { ctx: 8192, vision: false }));
  assert.equal(plan('ru').label, 'Работает хорошо');
  assert.equal(plan('en').label, 'Runs well');
  assert.match(plan('ru').detail, /ГБ/);
});

test('Excel files Hearth writes can be read back, Cyrillic, quotes and all', async () => {
  const rows = [['Файл', 'Название', 'Теги'], ['кот.png', 'Кот "Сёрфер" & волна', 'кот, море'], ['2.png', 'Line\nbreak <b>', '']];
  const blob = xlsxBlob(rows, { sheet: 'Товары' });
  const doc = await extractDocument('t.xlsx', await bytes(blob));
  assert.match(doc.text, /## Товары/);
  assert.match(doc.text, /\| кот\.png \| Кот "Сёрфер" & волна \| кот, море \|/);
  assert.match(doc.text, /Line break <b>/);
});

test('CSV for Excel and shops: BOM, commas and quotes escaped', () => {
  const csv = csvText([['a', 'b'], ['1,5', 'say "hi"'], ['line\nbreak', 'ок']]);
  assert.ok(csv.startsWith('﻿'));
  assert.equal(csv.slice(1), 'a,b\r\n"1,5","say ""hi"""\r\n"line\nbreak",ок\r\n');
});

test('Word: headings, lists, tables; PowerPoint: slides in order', async () => {
  const docx = zipStore([
    ['word/document.xml', '<w:document><w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Заказ</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>Товар</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Цена</w:t></w:r></w:p></w:tc></w:tr><w:tr><w:tc><w:p><w:r><w:t>Худи</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>3200 &amp; доставка</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:p><w:pPr><w:numPr/></w:pPr><w:r><w:t>Срок 3 дня</w:t></w:r></w:p></w:body></w:document>'],
  ]);
  const w = await extractDocument('a.docx', await bytes(docx));
  assert.equal(w.text, '# Заказ\n| Товар | Цена |\n| --- | --- |\n| Худи | 3200 & доставка |\n- Срок 3 дня');
  const pptx = zipStore([
    ['ppt/slides/slide10.xml', '<p:sld><a:p><a:r><a:t>Десятый</a:t></a:r></a:p></p:sld>'],
    ['ppt/slides/slide2.xml', '<p:sld><a:p><a:r><a:t>Второй</a:t></a:r></a:p></p:sld>'],
  ]);
  const p = await extractDocument('b.pptx', await bytes(pptx));
  assert.ok(p.text.indexOf('Второй') < p.text.indexOf('Десятый'));
});

test('token estimate counts Cyrillic as denser than Latin text', () => {
  assert.ok(estimateTokens('привет '.repeat(100)) > estimateTokens('hello! '.repeat(100)));
});

test('web pages: private addresses are refused; HTML turns into readable text', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.1.20', '172.20.0.1', '169.254.1.1', '::1', 'fd00::1', '::ffff:192.168.0.1', '100.64.0.1']) assert.ok(isPrivateIp(ip), ip);
  for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700::1111']) assert.ok(!isPrivateIp(ip), ip);
  // An IPv4 address inside an IPv6 one, in every way of writing it: the system connects to the IPv4 one.
  for (const ip of ['::ffff:7f00:1', '::ffff:c0a8:101', '0:0:0:0:0:ffff:7f00:1', '::7f00:1', '::127.0.0.1', '::', '::ffff:0:7f00:1', '64:ff9b::7f00:1', '64:ff9b::c0a8:101', '2002:7f00:1::1', '2002:c0a8:101::', 'fe80::1%en0', 'fec0::1', 'ff02::1', '2001:0:1::1', 'not-an-address']) assert.ok(isPrivateIp(ip), ip);
  for (const ip of ['::ffff:8.8.8.8', '::ffff:808:808', '64:ff9b::808:808', '2002:808:808::1', '2a00:1450:4001:81b::200e']) assert.ok(!isPrivateIp(ip), ip);
  const { title, text } = htmlToText('<html><head><title>Цены &amp; сроки</title><style>x{}</style></head><body><nav>menu</nav><h1>Футболки</h1><p>От 1500&nbsp;₽</p><ul><li>Хлопок</li></ul><script>alert(1)</script></body></html>');
  assert.equal(title, 'Цены & сроки');
  assert.match(text, /# Футболки/);
  assert.match(text, /От 1500 ₽/);
  assert.match(text, /- Хлопок/);
  assert.doesNotMatch(text, /alert|menu/);
});

test('file tools read only inside the allowed folders', async () => {
  const allowed = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-allowed-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-outside-'));
  fs.writeFileSync(path.join(allowed, 'notes.txt'), 'секрет фирмы: печать за 3 дня');
  fs.writeFileSync(path.join(outside, 'private.txt'), 'nope');
  fs.symlinkSync(path.join(outside, 'private.txt'), path.join(allowed, 'link.txt'));
  updateSettings({ toolsOn: true, toolFolders: [allowed], mcpConfig: '' });
  const names = (await listTools()).tools.map((x) => x.name);
  assert.ok(names.includes('read_file') && names.includes('web_search'));
  assert.match(await callTool('read_file', { path: 'notes.txt' }), /печать за 3 дня/);
  assert.match(await callTool('find_files', { query: 'notes' }), /notes\.txt/);
  await assert.rejects(callTool('read_file', { path: path.join(outside, 'private.txt') }), /outside the folders/);
  await assert.rejects(callTool('read_file', { path: 'link.txt' }), /outside the folders/); // a link pointing out
  await assert.rejects(callTool('read_file', { path: '../' + path.basename(outside) + '/private.txt' }), /outside the folders/);
  updateSettings({ toolFolders: [] });
  assert.ok(!(await listTools()).tools.some((x) => x.name === 'read_file'));
});

test('MCP: Claude Desktop config shape, and a real stdio server end to end', async () => {
  assert.deepEqual(Object.keys(parseMcpConfig('{"mcpServers":{"a":{"command":"x"},"off":{"command":"y","disabled":true},"web":{"url":"http://h/mcp"}}}')), ['a', 'web']);
  assert.throws(() => parseMcpConfig('{oops'), /not valid JSON/);
  const server = path.join(HERE, 'mcp-mock.mjs');
  updateSettings({ toolsOn: true, toolApproval: 'ask', mcpConfig: JSON.stringify({ mcpServers: { calc: { command: process.execPath, args: [server] } } }) });
  const l = await listTools();
  const add = l.tools.find((x) => x.name === 'calc__add');
  assert.ok(add && add.ask, 'MCP tools ask first by default');
  assert.equal(await callTool('calc__add', { a: 2, b: 40 }), '42');
  stopMcp();
  updateSettings({ mcpConfig: '' });
});

test('assistants: built-ins in the page language, edits kept, reset brings them back; memory feeds the chat', () => {
  const before = listAssistants();
  assert.ok(before.some((a) => a.id === 'product'));
  const ruNames = inRussian(() => listAssistants().map((a) => a.name));
  assert.ok(ruNames.includes('Описания товаров'));
  saveAssistant('product', { name: 'Карточки', instructions: 'Мои правила', icon: 'tag' });
  assert.equal(listAssistants().find((a) => a.id === 'product').instructions, 'Мои правила');
  const mine = saveAssistant('new', { name: 'Мой', instructions: 'x' });
  assert.match(mine.id, /^a-/);
  deleteAssistant('reply');
  assert.ok(!listAssistants().some((a) => a.id === 'reply'));
  resetAssistants();
  assert.ok(listAssistants().some((a) => a.id === 'reply'));
  assert.equal(listAssistants().find((a) => a.id === 'product').edited, false);
  addMemory('Магазин называется «Принт Лаб»');
  addMemory('магазин называется «принт лаб»'); // same fact twice is kept once
  assert.equal(listMemory().length, 1);
  assert.match(memoryPrompt(), /Принт Лаб/);
  updateSettings({ memoryOn: false });
  assert.equal(memoryPrompt(), '');
  updateSettings({ memoryOn: true });
});

test('batch jobs check their input and keep edited cells', () => {
  assert.throws(() => createBatch({ instruction: 'x', fields: [], items: [{ kind: 'text', text: 'a' }] }), /at least one column/);
  assert.throws(() => createBatch({ instruction: 'x', fields: [{ name: 'A' }, { name: 'a' }], items: [{ kind: 'text', text: 'a' }] }), /must be different/);
  assert.throws(() => createBatch({ instruction: 'x', fields: [{ name: 'A' }], items: [] }), /photos or files/);
  const job = createBatch({ instruction: 'Describe', fields: [{ name: 'Title' }], items: [{ kind: 'text', name: 'a.txt', text: 'hello' }] });
  stopBatch(job.id);
  editBatchCell(job.id, job.items[0].id, 'Title', 'Привет');
  assert.equal(getBatch(job.id).items[0].result.Title, 'Привет');
  assert.equal(getBatch(job.id).status, 'stopped');
});

test('phones: only the QR secret pairs a device, and only through this computer’s own addresses', () => {
  setPhoneAccess(true);
  resetDevices();
  const token = JSON.parse(fs.readFileSync(path.join(process.env.HEARTH_DATA_DIR, 'settings.json'), 'utf8')).phoneToken;
  const req = (ip) => ({ socket: { remoteAddress: ip }, headers: { 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X)' } });
  const res = () => ({ headers: {}, setHeader(k, v) { this.headers[k] = v; } });
  const bad = pair(req('192.168.1.50'), res(), 'wrong');
  assert.equal(bad.ok, false);
  const r = res();
  assert.equal(pair(req('192.168.1.51'), r, token).ok, true);
  assert.match(r.headers['set-cookie'], /^hearth_device=\w+; Path=\/; Max-Age=\d+; HttpOnly; SameSite=Strict$/);
  for (let i = 0; i < 12; i++) pair(req('192.168.1.99'), res(), 'guess' + i);
  assert.equal(pair(req('192.168.1.99'), res(), token).status, 429, 'guessing is slowed down');
  assert.equal(lanHostOk('evil.example.com:7420'), false);
  assert.equal(lanHostOk(`${os.hostname().replace(/\.local$/, '')}.local:7420`), true);
  setPhoneAccess(false);
});

test('per-model settings: choices are checked, INT8 from 64K, leave-20% takes threads and GPU memory', async () => {
  const { cleanModelSettings, effectiveOptions, setModelSettings, getModelSettings, savePreset, listPresets, deletePreset } = await import('../server/model-settings.mjs');
  assert.deepEqual(cleanModelSettings({ ctx: '65536', kv: 'q8_0', computer: 'leave20', lowRam: 'nope', bogus: 1, vision: 0 }), { ctx: 65536, kv: 'q8_0', computer: 'leave20', vision: false });
  const hw = { unified: true, gpuBudget: 40 * 1024 ** 3, ram: 48 * 1024 ** 3, perfCores: 12, threads: 16 };
  const model = { id: 'testmodel1', ctxTrain: 131072, moe: true, mmproj: '/x/mmproj.gguf' };
  updateSettings({ contextSize: 32768, vision: true, speculative: 'auto' });
  let o = effectiveOptions(model, hw, { ...getModelSettings('testmodel1') });
  assert.equal(o.ctx, 32768);
  assert.equal(o.kv, 'f16');
  assert.equal(o.threads, 0);
  o = effectiveOptions(model, hw, { ...getModelSettings('none'), ctx: 65536, computer: 'leave20', visionOn: 'cpu', lowRam: 'ssd' });
  assert.equal(o.kv, 'q8_0');
  assert.equal(o.threads, 9); // four fifths of 12 fast cores
  assert.equal(o.margin, 8 * 1024 ** 3); // a fifth of the 40 GB the GPU may use
  assert.ok(o.visionCpu && o.lowRam);
  updateSettings({ speculative: 'off' });
  assert.equal(effectiveOptions(model, hw).drafting, 'off', 'the general switch wins');
  updateSettings({ speculative: 'auto' });
  setModelSettings('testmodel1', { kv: 'q4_0' });
  assert.equal(getModelSettings('testmodel1').kv, 'q4_0');
  const p = savePreset('Длинные документы', { ctx: 131072, kv: 'q8_0' });
  assert.ok(listPresets().some((x) => x.id === p.id && x.settings.ctx === 131072));
  deletePreset(p.id);
  assert.ok(!listPresets().some((x) => x.id === p.id));
});

test('memory plan follows the per-model choices', () => {
  const GB = 1024 ** 3;
  const hw = { unified: true, gpuBudget: 40 * GB, ram: 48 * GB };
  const meta = { layers: 48, fullAttentionInterval: 4, headKv: 2, keyLength: 256, valueLength: 256 };
  const model = { size: 38e9, moe: true, mmprojSize: 0.9e9, meta, layout: { experts: 34e9, table: 28.8e9, dense: 3.6e9, expertLayers: 48 } };
  // On a machine where everything fits, the totals can be compared directly.
  const big = { unified: true, gpuBudget: 200 * GB, ram: 256 * GB };
  const f16 = planModel(big, model, { ctx: 262144, vision: false });
  const int8 = planModel(big, model, { ctx: 262144, vision: false, kv: 'q8_0' });
  assert.ok(int8.need < f16.need - 1 * GB, 'INT8 context memory is smaller');
  assert.ok(int8.args.includes('-ctk') && int8.args.includes('q8_0'));
  const cpuPictures = planModel(hw, model, { ctx: 32768, vision: true, visionCpu: true });
  assert.ok(cpuPictures.args.includes('--no-mmproj-offload'));
  const low = planModel(hw, model, { ctx: 32768, vision: false, lowRam: true });
  assert.equal(low.mode, 'ssd-experts');
  assert.ok(low.args.includes('--cpu-moe') && low.args.includes('--moe-cache-mib'));
  assert.ok(low.need < 15 * GB);
  const small = { size: 5e9, moe: false };
  assert.equal(planModel(hw, small, { ctx: 8192, vision: false }).level, 'great');
  // Another model already takes most of the GPU: the new one is told to leave room for it.
  const squeezed = planModel(hw, small, { ctx: 8192, vision: false, othersNeed: 34 * GB });
  assert.notEqual(squeezed.level, 'great');
  assert.ok(squeezed.args.includes('--fit-target'));
});

test('MTP drafts in a repo are drafts, not a size of the model', async () => {
  const { quantsOf } = await import('../server/catalog.mjs');
  const files = [
    { path: 'UD-Q4_K_XL/Qwen3.8-Flash-Next-UD-Q4_K_XL-00001-of-00002.gguf', size: 40e9 },
    { path: 'UD-Q4_K_XL/Qwen3.8-Flash-Next-UD-Q4_K_XL-00002-of-00002.gguf', size: 29e9 },
    { path: 'MTP/mtp-Qwen3.8-Flash-Next-Q4_K_M.gguf', size: 2.79e9 },
    { path: 'MTP/mtp-Qwen3.8-Flash-Next-shared-Q4_K_M.gguf', size: 1.9e9 },
    { path: 'mmproj-F16.gguf', size: 0.9e9 },
  ];
  const r = quantsOf(files);
  assert.deepEqual(r.quants.map((q) => q.quant), ['UD-Q4_K_XL']);
  assert.equal(r.drafts.length, 2);
  assert.equal(r.mmproj.path, 'mmproj-F16.gguf');
});

// Found in the 0.2.19 review: "http://[::ffff:127.0.0.1]:port/" reached a service on this computer.
test('web tools refuse this computer however its address is written', async () => {
  const http = await import('node:http');
  let hits = 0;
  const srv = http.createServer((req, res) => {
    hits++;
    res.end('a page on this computer');
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  try {
    for (const host of ['127.0.0.1', 'localhost', '[::ffff:127.0.0.1]', '[::ffff:7f00:1]', '[::127.0.0.1]', '[::1]', '2130706433', '0x7f.1']) {
      await assert.rejects(fetchPublic(`http://${host}:${port}/`, { timeout: 3000 }), /public web addresses/, host);
    }
    assert.equal(hits, 0, 'nothing reached the local service');
  } finally {
    srv.close();
  }
});

test('Windows: a connector program’s arguments with spaces or cmd signs go in quotes', () => {
  assert.equal(winQuote('npx'), 'npx');
  assert.equal(winQuote('-y'), '-y');
  assert.equal(winQuote('@modelcontextprotocol/server-filesystem'), '@modelcontextprotocol/server-filesystem');
  assert.equal(winQuote('C:\\Users\\alex\\My Files'), '"C:\\Users\\alex\\My Files"');
  assert.equal(winQuote('C:\\My Files\\'), '"C:\\My Files\\\\"'); // a last backslash must not swallow the closing quote
  assert.equal(winQuote('a&b'), '"a&b"');
  assert.equal(winQuote('say "hi"'), '"say \\"hi\\""');
  assert.equal(winQuote(''), '""');
});

test('files with keys and tokens can be read by this user only', { skip: process.platform === 'win32' }, async () => {
  const { DIRS } = await import('../server/settings.mjs');
  const bots = await import('../server/bots.mjs');
  updateSettings({ searchKey: 'a-key' });
  await bots.createBot({ template: 'blank' });
  for (const f of [path.join(DIRS.data, 'settings.json'), path.join(DIRS.bots, 'bots.json')]) assert.equal(fs.statSync(f).mode & 0o777, 0o600, f);
});
