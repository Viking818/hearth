// MCP client ("connectors"): tools from MCP servers for the chat. The user's own are kept in the same JSON shape as
// Claude Desktop's "mcpServers"; plugins bring more (named "plugin:server"), each off until the user turns it on.
// A server is either a program Hearth starts (stdio) or an address (Streamable HTTP). Addresses that need the user to
// sign in get a "Sign in" button: oauth.mjs does the signing in and keeps the tokens.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { getSettings, updateSettings, APP_VERSION, DIRS } from './settings.mjs';
import { IS_WIN, uid } from './util.mjs';
import { t } from './i18n.mjs';
import { pluginConnectors } from './extensions.mjs';
import { serviceKey, usesOAuth, parseChallenge, noteChallenge, accessToken, renewToken, tokenRefused, hasTokens, authState, beginSignIn, saveToken, signOut, signInCallback, openInBrowser, advertisesSignIn } from './oauth.mjs';

const PROTOCOL = '2025-06-18';
const RETRY_AFTER = 60000; // a connector that failed starts again after a minute, sooner only when the chat calls it
const servers = new Map(); // name → { name, cfg, status, error, tools, conn, failedAt }
let configSig = null;

export function parseMcpConfig(text) {
  if (!String(text || '').trim()) return {};
  let j;
  try {
    j = JSON.parse(text);
  } catch (err) {
    throw new Error(t('The MCP settings are not valid JSON: {msg}', { msg: err.message }));
  }
  const list = j.mcpServers || j.mcp_servers || j.servers || j;
  if (!list || typeof list !== 'object' || Array.isArray(list)) throw new Error(t('Expected an object of servers, like Claude Desktop’s "mcpServers".'));
  const out = {};
  for (const [name, cfg] of Object.entries(list)) {
    if (!cfg || typeof cfg !== 'object' || cfg.disabled) continue;
    if (!cfg.command && !cfg.url) continue;
    out[name] = cfg;
  }
  return out;
}

const safeName = (s) => String(s).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 30);

// On Windows a connector's program starts through cmd.exe (npx and uvx are .cmd files there), which takes one line of
// text: a part with a space or one of cmd's own signs goes in quotes, or "C:\\My Files" would arrive as two arguments.
export function winQuote(a) {
  const s = String(a);
  if (s && !/[\s"&|<>^()%!,;=]/.test(s)) return s;
  return `"${s.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`;
}

// ---- Connections ----

class StdioConn {
  constructor(name, cfg) {
    this.name = name;
    this.pending = new Map();
    this.nextId = 1;
    this.stderr = '';
    this.buf = '';
    const args = (Array.isArray(cfg.args) ? cfg.args : []).map(String);
    this.proc = spawn(IS_WIN ? winQuote(cfg.command) : cfg.command, IS_WIN ? args.map(winQuote) : args, {
      cwd: cfg.cwd || undefined,
      env: { ...process.env, ...(cfg.env || {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: IS_WIN, // npx and uvx are .cmd files on Windows
      windowsHide: true,
    });
    this.proc.stdout.on('data', (d) => this.onData(d));
    this.proc.stdin.on('error', () => {}); // a program that quit at once: writing to it must not stop Hearth
    this.proc.stderr.on('data', (d) => {
      this.stderr = (this.stderr + d).slice(-4000);
    });
    this.closed = new Promise((resolve) => {
      this.proc.on('error', (err) => {
        this.stderr += `\n${err.message}`;
        this.fail(err.message);
        resolve();
      });
      this.proc.on('exit', (code) => {
        this.fail(t('The server stopped (code {code}). {detail}', { code, detail: this.stderr.trim().split('\n').slice(-2).join(' ') }));
        resolve();
      });
    });
  }
  fail(msg) {
    this.dead = msg;
    for (const p of this.pending.values()) p.reject(new Error(msg));
    this.pending.clear();
  }
  onData(d) {
    this.buf += d;
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // servers sometimes print logs on stdout
      }
      if (msg.id != null && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message || 'MCP error'));
        else p.resolve(msg.result);
      } else if (msg.method && msg.id != null) {
        // A request from the server (e.g. ping): answer politely.
        this.send({ jsonrpc: '2.0', id: msg.id, result: {} });
      }
    }
  }
  send(obj) {
    if (this.dead) throw new Error(this.dead);
    this.proc.stdin.write(`${JSON.stringify(obj)}\n`);
  }
  request(method, params, timeout = 60000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(t('The tool took too long to answer.')));
      }, timeout);
      this.pending.set(id, {
        resolve: (v) => (clearTimeout(timer), resolve(v)),
        reject: (e) => (clearTimeout(timer), reject(e)),
      });
      try {
        this.send({ jsonrpc: '2.0', id, method, params });
      } catch (err) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(err);
      }
    });
  }
  notify(method, params) {
    try {
      this.send({ jsonrpc: '2.0', method, params });
    } catch {}
  }
  close() {
    try {
      this.proc.kill();
    } catch {}
  }
}

class HttpConn {
  constructor(name, cfg) {
    this.name = name;
    this.url = cfg.url;
    this.headers = cfg.headers || {};
    this.oauth = usesOAuth(cfg); // a key or token in the settings wins over signing in
    this.key = serviceKey(cfg.url);
    this.session = '';
    this.nextId = 1;
  }
  async post(body, timeout = 60000, again = false) {
    const token = this.oauth ? await accessToken(this.key) : '';
    const res = await fetch(this.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': PROTOCOL, ...(this.session ? { 'mcp-session-id': this.session } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...this.headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeout),
    });
    const sid = res.headers.get('mcp-session-id');
    if (sid) this.session = sid;
    if (res.status === 202) return null;
    const challenge = res.headers.get('www-authenticate');
    if (res.status === 401 || (res.status === 403 && challenge)) {
      res.body?.cancel().catch(() => {});
      if (!this.oauth) throw new Error(t('The service didn’t accept the key or token saved for this connector.'));
      // A token the service no longer takes: refresh it once and try again; otherwise the user signs in (again).
      if (token && !again && res.status === 401 && (await renewToken(this.key, token))) return this.post(body, timeout, true);
      noteChallenge(this.key, parseChallenge(challenge));
      throw Object.assign(new Error(token ? tokenRefused(this.key) : t('Sign in to use this connector.')), { code: 'SIGN_IN' });
    }
    // A bare 403 before any sign-in (Adobe's): if the service says how to sign in to it, that is what it wants.
    if (res.status === 403 && this.oauth && !token && (await advertisesSignIn(this.url))) {
      res.body?.cancel().catch(() => {});
      throw Object.assign(new Error(t('Sign in to use this connector.')), { code: 'SIGN_IN' });
    }
    if (!res.ok) throw new Error(t('The MCP server answered with an error ({status}).', { status: res.status }));
    const type = res.headers.get('content-type') || '';
    if (type.includes('text/event-stream')) {
      const text = await res.text();
      for (const line of text.split('\n')) {
        if (!line.startsWith('data:')) continue;
        try {
          const msg = JSON.parse(line.slice(5));
          if (msg.id === body.id) return msg;
        } catch {}
      }
      return null;
    }
    return res.json();
  }
  async request(method, params, timeout) {
    const id = this.nextId++;
    const msg = await this.post({ jsonrpc: '2.0', id, method, params }, timeout);
    if (msg?.error) throw new Error(msg.error.message || 'MCP error');
    return msg?.result;
  }
  notify(method, params) {
    this.post({ jsonrpc: '2.0', method, params }).catch(() => {});
  }
  close() {}
}

async function connect(rec) {
  rec.status = 'starting';
  rec.error = '';
  const conn = rec.cfg.url ? new HttpConn(rec.name, rec.cfg) : new StdioConn(rec.name, rec.cfg);
  rec.conn = conn;
  try {
    await conn.request('initialize', { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'Hearth', version: APP_VERSION } }, 45000);
    conn.notify('notifications/initialized', {});
    const tools = [];
    let cursor;
    for (let page = 0; page < 10; page++) {
      const r = await conn.request('tools/list', cursor ? { cursor } : {}, 30000);
      tools.push(...(r?.tools || []));
      cursor = r?.nextCursor;
      if (!cursor) break;
    }
    rec.tools = tools;
    rec.status = 'ready';
    rec.failedAt = 0;
  } catch (err) {
    // Waiting for a sign-in, unless one finished while this was connecting (then the next check connects again).
    rec.status = err.code !== 'SIGN_IN' ? 'error' : hasTokens(serviceKey(rec.cfg.url)) ? 'stopped' : 'signin';
    if (rec.status === 'error') rec.failedAt = Date.now();
    const msg = String(err.message || err);
    const tail = (conn.stderr || '').trim().split('\n').slice(-2).join(' ');
    rec.error = tail && !msg.includes(tail.slice(0, 40)) ? `${msg} ${tail}` : msg;
    conn.close();
    rec.conn = null;
  }
  return rec;
}

// Starts the connectors that are on (once); when the list changes, only the ones that changed restart. One that failed
// waits a minute before it starts again, so pages and chats that ask often don't start it over and over (a new
// program, or a new request to the service, each time); `force` (the chat calling its tool) tries that one at once.
export async function ensureMcp({ force = '' } = {}) {
  let cfgs = {};
  let bad = '';
  try {
    cfgs = parseMcpConfig(getSettings().mcpConfig || '');
  } catch (err) {
    bad = err.message;
  }
  try {
    Object.assign(cfgs, pluginConnectors());
  } catch {}
  const sig = JSON.stringify([cfgs, bad]);
  if (sig !== configSig) {
    configSig = sig;
    for (const [name, rec] of servers) {
      if (name === 'settings' || JSON.stringify(cfgs[name]) !== JSON.stringify(rec.cfg)) {
        rec.conn?.close();
        servers.delete(name);
      }
    }
    if (bad) servers.set('settings', { name: 'settings', cfg: {}, status: 'error', error: bad, tools: [] });
    for (const [name, cfg] of Object.entries(cfgs)) if (!servers.has(name)) servers.set(name, { name, cfg, status: 'stopped', error: '', tools: [] });
  }
  await Promise.all(
    [...servers.values()].map((rec) => {
      if (rec.status === 'ready' && rec.conn && !rec.conn.dead) return null;
      if (rec.status === 'starting') return rec.starting;
      if (rec.status === 'signin' && !hasTokens(serviceKey(rec.cfg.url))) return null; // waits for the user to sign in
      if (rec.status === 'error' && rec.name !== force && Date.now() - (rec.failedAt || 0) < RETRY_AFTER) return null;
      if (!rec.cfg.command && !rec.cfg.url) return null;
      rec.starting = connect(rec);
      return rec.starting;
    }),
  );
}

export function mcpServers() {
  return [...servers.values()].map((r) => ({
    name: r.name,
    status: r.status,
    error: r.error,
    tools: r.tools.map((x) => x.name),
    kind: r.cfg.url ? 'http' : 'program',
    plugin: r.name.includes(':') ? r.name.split(':')[0] : '',
    auth: usesOAuth(r.cfg) ? authState(serviceKey(r.cfg.url)) : null, // signed in or not; never a token
  }));
}

// ---- Signing in to connectors that are web services ----

const fail = (msg, status = 400) => Object.assign(new Error(msg), { status });

function running(name) {
  const rec = servers.get(name);
  if (!rec) throw fail(t('Turn the connector on first.'), 404);
  if (!usesOAuth(rec.cfg)) throw fail(t('This connector doesn’t need a sign-in.'));
  return rec;
}

// Every connector to this service connects again (they share the sign-in).
function reconnect(key) {
  for (const rec of servers.values()) {
    if (!rec.cfg.url || serviceKey(rec.cfg.url) !== key || rec.status === 'starting') continue;
    rec.conn?.close();
    rec.conn = null;
    rec.status = 'stopped';
    rec.error = '';
  }
  ensureMcp().catch(() => {});
}

// Opens the service's sign-in page in the browser; the page comes back to redirectUri (/oauth/callback).
export async function signInConnector(name, { redirectUri, open = openInBrowser } = {}) {
  const rec = running(name);
  const r = await beginSignIn(rec.cfg.url, redirectUri);
  open(r.url);
  return r;
}

// A token the user pasted for a service Hearth can't sign in to (GitHub's personal access token, say).
export function useConnectorToken(name, token) {
  const rec = running(name);
  reconnect(saveToken(rec.cfg.url, token));
}

export async function signOutConnector(name) {
  const key = serviceKey(running(name).cfg.url);
  await signOut(key);
  reconnect(key);
}

// GET /oauth/callback (index.mjs): the browser is back from the service's sign-in page.
export function oauthCallback(req, res, url) {
  return signInCallback(req, res, url, reconnect);
}

// ---- The user's own connectors, edited one by one (the page) instead of as JSON (still possible in Settings) ----

function ownDoc() {
  const text = getSettings().mcpConfig || '';
  if (!text.trim()) return { mcpServers: {} };
  let j;
  try {
    j = JSON.parse(text);
  } catch (err) {
    throw Object.assign(new Error(t('The MCP settings are not valid JSON: {msg}', { msg: err.message })), { status: 400 });
  }
  const list = j.mcpServers || j.mcp_servers || j.servers || j;
  return { mcpServers: list && typeof list === 'object' && !Array.isArray(list) ? list : {} };
}

export function ownConnectors() {
  try {
    return Object.entries(ownDoc().mcpServers)
      .filter(([, c]) => c && typeof c === 'object')
      .map(([name, c]) => ({ name, kind: c.url ? 'http' : 'program', what: c.url ? String(c.url) : [c.command, ...(Array.isArray(c.args) ? c.args : [])].join(' '), on: !c.disabled, cfg: c }));
  } catch {
    return [];
  }
}

// change(list) gets the servers object and changes it in place.
export function editOwnConnectors(change) {
  const doc = ownDoc();
  change(doc.mcpServers);
  updateSettings({ mcpConfig: Object.keys(doc.mcpServers).length ? JSON.stringify(doc, null, 2) : '' });
  ensureMcp().catch(() => {});
}

export function mcpTools() {
  const out = [];
  for (const rec of servers.values()) {
    if (rec.status !== 'ready') continue;
    for (const tool of rec.tools) {
      out.push({
        name: `${safeName(rec.name)}__${safeName(tool.name)}`.slice(0, 64),
        title: tool.title || tool.name,
        server: rec.name,
        tool: tool.name,
        url: rec.cfg.url || '', // the same service in several plugins has the same address
        description: tool.description || '',
        parameters: tool.inputSchema || { type: 'object', properties: {} },
      });
    }
  }
  return out;
}

// A picture a connector tool sends back is kept with the chat's pictures, so the chat can show it. The model gets
// its address and can repeat it in the answer.
const TOOL_IMAGE = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif' };
export function keepToolImage(c) {
  const ext = TOOL_IMAGE[String(c?.mimeType || '').toLowerCase()];
  const b64 = typeof c?.data === 'string' ? c.data : '';
  if (!ext || !b64 || b64.length > 28e6 || !/^[A-Za-z0-9+/=\s]+$/.test(b64)) return '';
  try {
    const name = `tool-${Date.now().toString(36)}-${uid(8)}${ext}`;
    fs.writeFileSync(path.join(DIRS.uploads, name), Buffer.from(b64, 'base64'));
    return `[The tool made a picture. The user already sees it in the chat. Its address: /uploads/${name}]`;
  } catch {
    return '';
  }
}

export async function callMcp(server, tool, args) {
  const rec = servers.get(server);
  if (!rec) throw new Error(t('No MCP server named {name}.', { name: server }));
  if (rec.status !== 'ready' || !rec.conn || rec.conn.dead) await ensureMcp({ force: server });
  if (rec.status !== 'ready') throw new Error(rec.error || t('The MCP server is not running.'));
  let r;
  try {
    r = await rec.conn.request('tools/call', { name: tool, arguments: args || {} }, 120000);
  } catch (err) {
    if (err.code === 'SIGN_IN') {
      // The sign-in ran out and couldn't be renewed: the connector waits for the user to sign in again.
      rec.status = 'signin';
      rec.error = err.message;
      rec.conn?.close();
      rec.conn = null;
    }
    throw err;
  }
  // The service answered, but the tool needs a sign-in, said inside its result the way ChatGPT apps say it
  // (Fourthwall's): the connector waits for the user to sign in, and its page shows the Sign in button.
  const wants = r?.isError && rec.cfg.url && usesOAuth(rec.cfg) ? [].concat(r?._meta?.['mcp/www_authenticate'] || [])[0] : '';
  if (wants) {
    const key = serviceKey(rec.cfg.url);
    noteChallenge(key, parseChallenge(wants));
    rec.status = 'signin';
    rec.error = hasTokens(key) ? tokenRefused(key) : t('Sign in to use this connector.');
    rec.conn?.close();
    rec.conn = null;
  }
  const parts = [];
  for (const c of r?.content || []) {
    if (c.type === 'text') parts.push(c.text);
    else if (c.type === 'resource' && c.resource?.text) parts.push(c.resource.text);
    else if (c.type === 'image') parts.push(keepToolImage(c) || t('[image from the tool]'));
    else parts.push(JSON.stringify(c).slice(0, 2000));
  }
  if (r?.structuredContent && !parts.length) parts.push(JSON.stringify(r.structuredContent));
  return { text: parts.join('\n\n'), isError: Boolean(r?.isError) };
}

export function stopMcp() {
  for (const rec of servers.values()) rec.conn?.close();
}
