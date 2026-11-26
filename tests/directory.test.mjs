// Tests for the connector directory (Customize → Connectors): every entry is complete and has its logo, the words
// come in the page's language, and connecting one adds it and, for a service with a sign-in, opens its sign-in page.
// Pretend services run on this computer: no real accounts, no network.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.HEARTH_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-test-'));
const { updateSettings } = await import('../server/settings.mjs');
const mcp = await import('../server/mcp.mjs');
const { DIRECTORY, CATEGORIES, MOVED, directory, connectFromDirectory, fixMovedConnectors } = await import('../server/directory.mjs');
const { startMockService } = await import('./oauth-mock.mjs');
const { inLang } = await import('../server/i18n.mjs');
updateSettings({ language: 'en', toolsOn: true, mcpConfig: '' });

// Hearth's /oauth/callback on a port of its own, as index.mjs serves it.
const cb = http.createServer((req, res) => mcp.oauthCallback(req, res, new URL(req.url, 'http://127.0.0.1')));
await new Promise((resolve) => cb.listen(0, '127.0.0.1', resolve));
const redirectUri = `http://127.0.0.1:${cb.address().port}/oauth/callback`;
const opened = [];
const open = (url) => opened.push(url); // instead of the real browser
const services = [];
after(() => {
  mcp.stopMcp();
  for (const s of services) s.close?.();
  cb.close();
  cb.closeAllConnections?.();
});

// An MCP server anyone may use, like Hugging Face's.
async function openService() {
  const srv = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const m = raw ? JSON.parse(raw) : {};
      res.writeHead(m.id === undefined ? 202 : 200, { 'content-type': 'application/json' });
      if (m.id === undefined) return res.end();
      if (m.method === 'initialize') return res.end(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'open', version: '1' } } }));
      if (m.method === 'tools/list') return res.end(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'find_models', description: 'Find models', inputSchema: { type: 'object', properties: {} } }] } }));
      res.end(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: {} }));
    });
  });
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  services.push(srv);
  return `http://127.0.0.1:${srv.address().port}/mcp`;
}

test('every connector in the directory is complete, has its logo, and says why it can’t be used when it can’t', () => {
  const cats = new Set(CATEGORIES.map((c) => c.id));
  const ids = new Set();
  for (const d of DIRECTORY) {
    assert.match(d.id, /^[a-z0-9]+$/, d.id);
    assert.ok(!ids.has(d.id), `the same id twice: ${d.id}`);
    ids.add(d.id);
    assert.ok(cats.has(d.category), `${d.id}: category`);
    assert.ok(['oauth', 'open', 'token', 'approved'].includes(d.auth), `${d.id}: auth`);
    assert.match(d.url, /^https:\/\//, `${d.id}: address`);
    assert.ok(d.description.length > 10, `${d.id}: description`);
    assert.ok(fs.existsSync(path.join(ROOT, 'public', 'brands', d.logo)), `${d.id}: logo ${d.logo}`);
    if (d.auth === 'approved' || d.auth === 'token') assert.ok(d.note, `${d.id}: a note saying why`);
  }
  assert.ok(DIRECTORY.length >= 50);
  // An address that moved points at one the directory has now (Higgsfield's MCP server is at …/mcp, not the root).
  for (const to of Object.values(MOVED)) assert.ok(DIRECTORY.some((d) => d.url === to), to);
  assert.equal(DIRECTORY.find((d) => d.id === 'higgsfield').url, 'https://mcp.higgsfield.ai/mcp');
  assert.ok(DIRECTORY.filter((d) => d.featured).length >= 8);
  // Every logo file belongs to a connector (none left over).
  const used = new Set(DIRECTORY.map((d) => d.logo));
  for (const f of fs.readdirSync(path.join(ROOT, 'public', 'brands'))) if (f !== 'README.md') assert.ok(used.has(f), `unused logo ${f}`);
});

test('the directory speaks the page’s language; brand names stay as they are', () => {
  const ru = inLang('ru', () => directory());
  const canva = ru.items.find((d) => d.id === 'canva');
  assert.equal(canva.name, 'Canva');
  assert.match(canva.description, /дизайн/i);
  assert.equal(ru.categories.find((c) => c.id === 'shop').name, 'Магазин и оплата');
  assert.match(ru.items.find((d) => d.id === 'gmail').note, /Zapier/);
  assert.equal(directory().categories[0].name, 'Design & media');
});

test('connecting: a service without an account is ready at once; one with a sign-in opens its page, then has tools', async () => {
  DIRECTORY.push({ id: 'testopen', name: 'Open test', category: 'dev', url: await openService(), auth: 'open', logo: 'huggingface.svg', description: 'A test service anyone may use.' });
  const r1 = await connectFromDirectory('testopen', { redirectUri, open });
  assert.deepEqual(r1, { name: 'testopen', url: '' });
  assert.equal(mcp.mcpServers().find((s) => s.name === 'testopen').status, 'ready');
  assert.ok(mcp.mcpServers().find((s) => s.name === 'testopen').tools.some((n) => n.includes('find_models')));

  const svc = await startMockService();
  services.push(svc);
  DIRECTORY.push({ id: 'testshop', name: 'Shop test', category: 'shop', url: svc.mcpUrl, auth: 'oauth', logo: 'shopify.svg', description: 'A test service with a sign-in.' });
  const r2 = await connectFromDirectory('testshop', { redirectUri, open });
  assert.equal(r2.name, 'testshop');
  assert.ok(r2.url.startsWith(svc.asUrl), 'its sign-in page');
  assert.equal(opened.at(-1), r2.url);
  assert.equal(svc.log.registrations.length, 1, 'Hearth registered itself');
  const back = await svc.browse(r2.url);
  assert.equal(back.status, 200);
  await mcp.ensureMcp();
  const st = mcp.mcpServers().find((s) => s.name === 'testshop');
  assert.equal(st.status, 'ready');
  assert.ok(st.auth.signedIn);
  assert.ok(st.tools.length > 0);
  // Connecting again keeps one connector of that name and needs no new sign-in.
  const again = await connectFromDirectory('testshop', { redirectUri, open });
  assert.equal(again.url, '');
  assert.equal(mcp.ownConnectors().filter((c) => c.name === 'testshop').length, 1);
});

test('a service that takes only approved apps is not added, and says why', async () => {
  await assert.rejects(connectFromDirectory('gmail', { redirectUri, open }), /Google lets only apps it approved/);
  assert.ok(!mcp.ownConnectors().some((c) => c.name === 'gmail'));
  await assert.rejects(connectFromDirectory('nothing-like-this', { redirectUri, open }), /Not found/);
});

test('a service that connects without an account but whose tools want one (like Fourthwall): Hearth asks to sign in', async () => {
  // From the directory: it connects and lists its tools, and still its sign-in page opens at once.
  const svc = await startMockService({ toolSignIn: true });
  services.push(svc);
  DIRECTORY.push({ id: 'testmerch', name: 'Merch test', category: 'shop', url: svc.mcpUrl, auth: 'oauth', logo: 'fourthwall.png', description: 'A test shop whose tools want a sign-in.' });
  const r = await connectFromDirectory('testmerch', { redirectUri, open });
  assert.ok(r.url.startsWith(svc.asUrl), 'its sign-in page');
  assert.equal(opened.at(-1), r.url);
  assert.equal((await svc.browse(r.url)).status, 200);
  await mcp.ensureMcp();
  const st = mcp.mcpServers().find((s) => s.name === 'testmerch');
  assert.equal(st.status, 'ready');
  assert.ok(st.auth.signedIn);
  assert.deepEqual(await mcp.callMcp('testmerch', 'list_notes', {}), { text: 'Note 1: order blue ink', isError: false });

  // Added some other way: the first tool that says "sign in" makes the connector wait for a sign-in, with its button.
  const other = await startMockService({ toolSignIn: true });
  services.push(other);
  mcp.editOwnConnectors((list) => (list.merch2 = { type: 'http', url: other.mcpUrl }));
  await mcp.ensureMcp();
  assert.equal(mcp.mcpServers().find((s) => s.name === 'merch2').status, 'ready');
  const res = await mcp.callMcp('merch2', 'list_notes', {});
  assert.equal(res.isError, true);
  assert.match(res.text, /Sign in to Mock Notes/);
  const waiting = mcp.mcpServers().find((s) => s.name === 'merch2');
  assert.equal(waiting.status, 'signin');
  assert.equal(waiting.auth.signedIn, false);
  assert.equal(waiting.auth.canSignIn, true);
});

test('a connector added at a directory address that has since moved goes to the new address', async () => {
  const url = await openService();
  const old = url.replace(/\/mcp$/, '/old');
  MOVED[old] = url;
  try {
    mcp.editOwnConnectors((list) => (list.moved = { type: 'http', url: `${old}/` }));
    assert.equal(fixMovedConnectors(), 1);
    assert.equal(mcp.ownConnectors().find((c) => c.name === 'moved').cfg.url, url);
    assert.equal(fixMovedConnectors(), 0, 'once');
    await mcp.ensureMcp();
    assert.equal(mcp.mcpServers().find((s) => s.name === 'moved').status, 'ready');
  } finally {
    delete MOVED[old];
  }
});
