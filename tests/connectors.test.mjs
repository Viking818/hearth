// Tests for connectors (MCP servers) in the chat: a connector that failed must not be started over and over by pages
// and chats that ask often; connectors with many long tools reach the model through find_tool and use_tool instead of
// all at once; and the engine's answer may take longer than five minutes to start.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
process.env.HEARTH_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-test-'));
const { updateSettings } = await import('../server/settings.mjs');
const mcp = await import('../server/mcp.mjs');
const tools = await import('../server/tools.mjs');
const { addChatContext } = await import('../server/api.mjs');
const { fetchLong } = await import('../server/util.mjs');
updateSettings({ language: 'en', toolsOn: true, toolApproval: 'ask', mcpConfig: '' });
after(() => mcp.stopMcp());

const server = (name) => mcp.mcpServers().find((s) => s.name === name);

test('a program that quits at once waits a minute before it starts again, unless the chat calls it or its settings change', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const log = path.join(process.env.HEARTH_DATA_DIR, 'starts.txt');
  const starts = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').length : 0);
  // Writes one letter each time it starts, then quits.
  const broken = { command: process.execPath, args: ['-e', "require('fs').appendFileSync(process.env.STARTS, 'x'); process.exit(3)"], env: { STARTS: log } };
  const use = (cfg) => updateSettings({ mcpConfig: JSON.stringify({ mcpServers: { broken: cfg } }) });

  use(broken);
  await mcp.ensureMcp();
  assert.equal(server('broken').status, 'error');
  assert.match(server('broken').error, /stopped \(code 3\)/);
  assert.equal(starts(), 1);

  // The Extensions page asks every second and a half without waiting (GET /api/extensions), and each chat message
  // asks too: the failure shows as it is, and nothing starts again.
  for (let i = 0; i < 6; i++) {
    mcp.ensureMcp().catch(() => {});
    assert.equal(server('broken').status, 'error', 'not "starting" again');
    await mcp.ensureMcp();
  }
  t.mock.timers.tick(59000);
  await mcp.ensureMcp();
  assert.equal(starts(), 1, 'nothing starts again within the minute');

  // The chat calls one of its tools: that tries again at once.
  await assert.rejects(mcp.callMcp('broken', 'anything', {}), /stopped \(code 3\)/);
  assert.equal(starts(), 2);
  t.mock.timers.tick(59000);
  await mcp.ensureMcp();
  assert.equal(starts(), 2, 'the minute counts from the last failure');

  // A minute after the last failure, the next request starts it once more.
  t.mock.timers.tick(2000);
  await mcp.ensureMcp();
  await mcp.ensureMcp();
  assert.equal(starts(), 3);

  // Changed settings start it at once.
  use({ ...broken, args: [...broken.args, 'changed'] });
  await mcp.ensureMcp();
  assert.equal(starts(), 4);

  updateSettings({ mcpConfig: '' });
  await mcp.ensureMcp();
  assert.equal(server('broken'), undefined);
});

const program = (file) => ({ command: process.execPath, args: [path.join(HERE, file)] });
const sentSize = (list) => JSON.stringify(list.filter((x) => x.schema).map((x) => x.schema)).length;

test('a few short connector tools go to the model as they are', async () => {
  updateSettings({ mcpConfig: JSON.stringify({ mcpServers: { calc: program('mcp-mock.mjs') } }) });
  const l = await tools.listTools();
  assert.equal(l.lookup, false);
  assert.equal(tools.connectorToolsMode(), 'full');
  assert.ok(l.tools.find((x) => x.name === 'calc__add').schema, 'its full instructions are sent');
  assert.ok(!l.tools.some((x) => x.name === 'find_tool' || x.name === 'use_tool'));
  updateSettings({ mcpConfig: '' });
  await mcp.ensureMcp();
});

test('many long connector tools: names in the instructions, find_tool shows one when needed, use_tool runs it', async () => {
  updateSettings({ mcpConfig: JSON.stringify({ mcpServers: { notes: program('mcp-many-mock.mjs'), calc: program('mcp-mock.mjs') } }) });
  const l = await tools.listTools();
  assert.equal(l.lookup, true);
  const all = l.tools.filter((x) => x.source === 'mcp');
  assert.equal(all.length, 31);
  assert.ok(all.every((x) => !x.schema && x.title && x.server), 'connector tools come without instructions, but the page still knows them');
  assert.equal(all.find((x) => x.name === 'notes__notes-create-pages').tool, 'notes-create-pages');
  const fullSize = mcp.mcpTools().reduce((n, m) => n + JSON.stringify(m).length, 0);
  assert.ok(fullSize > 40000, `the connectors' full instructions are long (${fullSize})`);
  assert.ok(sentSize(l.tools) < 6000, `what the chat sends with every message stays short (${sentSize(l.tools)})`);
  assert.equal(l.tools.find((x) => x.name === 'use_tool').ask, true, 'running a connector tool still asks first');
  assert.equal(l.tools.find((x) => x.name === 'find_tool').ask, false);

  // The model sees every tool's name in its instructions, but only when the chat sent find_tool.
  const names = tools.connectorToolsList();
  assert.match(names, /^Connector tools \(31\)/);
  assert.match(names, /- notes: notes-search, notes-fetch, notes-create-pages,/);
  assert.match(names, /- calc: add/);
  const body = { messages: [{ role: 'user', content: 'Hi' }], tools: l.tools.filter((x) => x.schema).map((x) => x.schema) };
  addChatContext(body, { tools: true });
  assert.equal(body.messages[0].role, 'system');
  assert.match(body.messages[0].content, /call find_tool/);
  assert.match(body.messages[0].content, /notes-update-database/);
  const plain = { messages: [{ role: 'user', content: 'Hi' }], tools: [] };
  addChatContext(plain, { tools: true });
  assert.doesNotMatch(plain.messages[0].content, /Connector tools/);

  // find_tool: by a few words, the best matches with their arguments; by a name, that tool in full.
  const found = await tools.callTool('find_tool', { query: 'create a new page' });
  assert.match(found.split('\n')[0], /^### notes__notes-create-pages \(notes\)/, 'the best match comes first');
  assert.match(found, /Arguments: \{/);
  assert.ok(found.length <= 24000);
  const one = await tools.callTool('find_tool', { query: 'notes-query-data' });
  assert.equal(one.match(/^### /gm).length, 1);
  assert.ok(JSON.parse(one.split('Arguments: ')[1]).properties.parent.properties.page_id, 'the whole shape of its arguments');
  assert.match(await tools.callTool('find_tool', { query: 'zzzz qqqq' }), /No connector tool matches/);

  // use_tool: by the full name or the tool's own name; arguments as an object or as JSON text.
  assert.equal(await tools.callTool('use_tool', { name: 'notes-create-pages', arguments: { title: 'Ink order' } }), 'notes-create-pages: {"title":"Ink order"}');
  assert.equal(await tools.callTool('use_tool', { name: 'notes__notes-search', arguments: '{"title":"blue"}' }), 'notes-search: {"title":"blue"}');
  assert.equal(await tools.callTool('use_tool', { name: 'calc:add', arguments: { a: 2, b: 3 } }), '5');
  await assert.rejects(tools.callTool('use_tool', { name: 'notes-nothing' }), /No connector tool named “notes-nothing”/);
  await assert.rejects(tools.callTool('use_tool', { name: 'notes-search', arguments: '{oops' }), /must be a JSON object/);

  // Two different connectors with the same tool name: the model is told which names to use.
  updateSettings({ mcpConfig: JSON.stringify({ mcpServers: { notes: program('mcp-many-mock.mjs'), other: program('mcp-many-mock.mjs') } }) });
  await tools.listTools();
  await assert.rejects(tools.callTool('use_tool', { name: 'notes-search' }), /Several connectors have a tool named “notes-search”: notes__notes-search, other__notes-search/);
  assert.equal(await tools.callTool('use_tool', { name: 'other__notes-search', arguments: {} }), 'notes-search: {}');
  updateSettings({ mcpConfig: '' });
  await mcp.ensureMcp();
});

test('long arguments are shortened, explanations first, and stay readable', () => {
  const schema = { type: 'object', additionalProperties: false, properties: { a: { type: 'string', description: 'x'.repeat(3000) }, b: { type: 'object', properties: { c: { type: 'number', description: 'y'.repeat(3000), examples: [1, 2] } } } }, required: ['a'] };
  const short = tools.compactSchema(schema, 1200);
  assert.ok(short.length <= 1200, short.length);
  const back = JSON.parse(short);
  assert.deepEqual(back.required, ['a']);
  assert.equal(back.properties.b.properties.c.type, 'number');
  assert.equal(back.additionalProperties, undefined);
  assert.equal(tools.compactSchema({ type: 'object' }, 1000), '{"type":"object"}', 'short ones stay as they are');
  assert.match(tools.compactSchema({ type: 'object', properties: Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`field${i}`, { type: 'string' }])) }, 500), /cut short/);
});

test('the engine may take more than five minutes to start answering; a stop still stops it', async () => {
  // A pretend engine: headers after a pause (as when a request waits its turn), then a stream in parts.
  const engine = http.createServer((req, res) => {
    if (req.url === '/json') return res.end(JSON.stringify({ ok: true }));
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      let n = 0;
      const tick = setInterval(() => {
        res.write(`data: {"n":${++n}}\n\n`);
        if (n === 3) {
          clearInterval(tick);
          res.end('data: [DONE]\n\n');
        }
      }, 50);
    }, 800);
  });
  await new Promise((resolve) => engine.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${engine.address().port}`;
  try {
    const r = await fetchLong(`${base}/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ x: 'привет' }) });
    assert.equal(r.status, 200);
    assert.equal(r.ok, true);
    assert.equal(r.headers.get('Content-Type'), 'text/event-stream');
    let text = '';
    for await (const chunk of r.body) text += chunk;
    assert.match(text, /"n":3[\s\S]*\[DONE\]/);
    assert.equal(await (await fetchLong(`${base}/json`)).text(), '{"ok":true}');
    // Stopped while waiting for the first byte.
    const stop = new AbortController();
    setTimeout(() => stop.abort(), 100);
    await assert.rejects(fetchLong(`${base}/chat`, { method: 'POST', body: '{}', signal: stop.signal }), /abort/i);
  } finally {
    engine.close();
    engine.closeAllConnections?.();
  }
});
