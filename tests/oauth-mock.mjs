// A pretend web service for the sign-in tests and checks: an MCP server that wants a sign-in (401 until it gets a token)
// and its own sign-in server (OAuth: metadata, registration, the "Allow" step, tokens, refresh, revoke). It runs on
// this computer, on ports of its own. No real accounts: it approves every sign-in, or shows an "Allow" page.
import http from 'node:http';
import crypto from 'node:crypto';

const listen = (srv) => new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve(srv.address().port)));
const readText = (req) =>
  new Promise((resolve) => {
    let d = '';
    req.on('data', (c) => (d += c));
    req.on('end', () => resolve(d));
  });
const json = (res, status, obj, headers = {}) => {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(obj));
};
const sha = (s) => crypto.createHash('sha256').update(s).digest('base64url');

// Options: dcr (has a registration address), dcrStatus (registration answers with this error), secret (clients get a
// secret and must send it), iss (sends iss back, or a wrong one: issValue), hint (the 401 says where the metadata is),
// deny (the user says no), approvePage (an "Allow" page instead of approving at once), expiresIn (token life in
// seconds, or a function of the token's number: (n) => n === 1 ? 60 : 3600).
// Ways real services differ, checked on 2026-11-08: loopback 'localhost' (registration refuses http://127.0.0.1 as the
// way back and takes http://localhost, like Calendly); scopes (the access its metadata lists) with grantScope
// (registration says which of it the app may ask for, and the sign-in page refuses anything else, like Adobe);
// forbidden (without a token the MCP server answers a bare 403 with no sign-in header, like Adobe's); toolSignIn
// (without a token the MCP server connects and lists its tools, and each tool answers "sign in" inside its result,
// the way ChatGPT apps do, like Fourthwall's).
export async function startMockService(options = {}) {
  const o = { dcr: true, dcrStatus: 0, secret: false, iss: true, issValue: '', hint: true, deny: false, approvePage: false, expiresIn: 3600, loopback: '127.0.0.1', grantScope: '', scopes: ['notes:read'], forbidden: false, toolSignIn: false, ...options };
  const wayBack = new RegExp(`^http://${o.loopback.replace(/\./g, '\\.')}:\\d+/oauth/callback$`);
  const log = { registrations: [], authorize: [], token: [], revoked: [], mcpAuth: [] };
  const clients = new Map(); // client_id → registration
  const codes = new Map(); // code → what it was issued for
  const access = new Set(); // access tokens the MCP server takes
  const refresh = new Map(); // refresh token → client_id
  let n = 0;
  let asUrl = '';
  let mcpBase = '';

  const finish = (res, q) => {
    const back = new URL(q.get('redirect_uri'));
    back.searchParams.set('state', q.get('state'));
    if (o.deny) back.searchParams.set('error', 'access_denied');
    else {
      const code = `code-${crypto.randomBytes(8).toString('hex')}`;
      codes.set(code, { client_id: q.get('client_id'), redirect_uri: q.get('redirect_uri'), challenge: q.get('code_challenge'), resource: q.get('resource') || '', scope: q.get('scope') || '' });
      back.searchParams.set('code', code);
    }
    if (o.iss) back.searchParams.set('iss', o.issValue || asUrl);
    res.writeHead(302, { location: back.href });
    res.end();
  };

  const issue = (client_id, scope) => {
    n++;
    const tokens = { access_token: `at-${n}`, token_type: 'Bearer', expires_in: typeof o.expiresIn === 'function' ? o.expiresIn(n) : o.expiresIn, refresh_token: `rt-${n}`, scope };
    access.add(tokens.access_token);
    refresh.set(tokens.refresh_token, client_id);
    return tokens;
  };

  const auth = http.createServer(async (req, res) => {
    const u = new URL(req.url, asUrl);
    if (req.method === 'GET' && u.pathname === '/.well-known/oauth-authorization-server') {
      return json(res, 200, {
        issuer: asUrl,
        authorization_endpoint: `${asUrl}/authorize`,
        token_endpoint: `${asUrl}/token`,
        ...(o.dcr ? { registration_endpoint: `${asUrl}/register` } : {}),
        revocation_endpoint: `${asUrl}/revoke`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: o.secret ? ['client_secret_post', 'client_secret_basic'] : ['none'],
        authorization_response_iss_parameter_supported: o.iss,
      });
    }
    if (req.method === 'POST' && u.pathname === '/register') {
      const reg = JSON.parse(await readText(req));
      log.registrations.push(reg);
      if (o.dcrStatus) return json(res, o.dcrStatus, { error: 'access_denied', error_description: 'Only approved apps may register.' });
      if (!Array.isArray(reg.redirect_uris) || !reg.redirect_uris.every((r) => wayBack.test(r))) {
        return o.loopback === 'localhost' ? json(res, 400, { error: 'invalid_client_metadata', errors: { redirect_uri: ['must start with https in Production.'] } }) : json(res, 400, { error: 'invalid_redirect_uri' });
      }
      const client_id = `client-${clients.size + 1}`;
      const client_secret = o.secret ? `secret-${clients.size + 1}` : '';
      clients.set(client_id, { ...reg, client_secret });
      return json(res, 201, { ...reg, client_id, ...(o.grantScope ? { scope: o.grantScope } : {}), ...(client_secret ? { client_secret, client_secret_expires_at: 0, token_endpoint_auth_method: 'client_secret_post' } : {}) });
    }
    if (req.method === 'GET' && (u.pathname === '/authorize' || u.pathname === '/authorize/allow')) {
      const q = u.searchParams;
      log.authorize.push(Object.fromEntries(q));
      const c = clients.get(q.get('client_id'));
      if (!c || !c.redirect_uris.includes(q.get('redirect_uri'))) return json(res, 400, { error: 'invalid_client' });
      if (q.get('response_type') !== 'code' || q.get('code_challenge_method') !== 'S256' || !q.get('code_challenge') || !q.get('state')) return json(res, 400, { error: 'invalid_request' });
      if (o.grantScope) {
        const ok = new Set(o.grantScope.split(' '));
        const asked = (q.get('scope') || '').split(/\s+/).filter(Boolean);
        if (!asked.length || asked.some((s) => !ok.has(s))) {
          const back = new URL(q.get('redirect_uri'));
          back.searchParams.set('error', 'invalid_scope');
          res.writeHead(302, { location: back.href });
          return res.end();
        }
      }
      if (u.pathname === '/authorize' && o.approvePage) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(`<!doctype html><meta charset="utf-8"><title>Mock Notes · Allow</title><body style="font:16px system-ui;margin:40px"><h1>Mock Notes</h1><p><b>${c.client_name}</b> wants to read your notes.</p><p><a id="allow" href="/authorize/allow?${q}">Allow</a></p></body>`);
      }
      return finish(res, q);
    }
    if (req.method === 'POST' && u.pathname === '/token') {
      const f = new URLSearchParams(await readText(req));
      log.token.push(Object.fromEntries(f));
      const client_id = f.get('client_id');
      const c = clients.get(client_id);
      if (!c || (c.client_secret && f.get('client_secret') !== c.client_secret)) return json(res, 401, { error: 'invalid_client' });
      if (f.get('grant_type') === 'authorization_code') {
        const got = codes.get(f.get('code'));
        codes.delete(f.get('code'));
        if (!got || got.client_id !== client_id || got.redirect_uri !== f.get('redirect_uri') || sha(f.get('code_verifier') || '') !== got.challenge || got.resource !== (f.get('resource') || '')) return json(res, 400, { error: 'invalid_grant' });
        return json(res, 200, issue(client_id, got.scope));
      }
      if (f.get('grant_type') === 'refresh_token') {
        const rt = f.get('refresh_token');
        if (refresh.get(rt) !== client_id) return json(res, 400, { error: 'invalid_grant', error_description: 'The refresh token is not valid.' });
        refresh.delete(rt);
        return json(res, 200, issue(client_id, ''));
      }
      return json(res, 400, { error: 'unsupported_grant_type' });
    }
    if (req.method === 'POST' && u.pathname === '/revoke') {
      const f = new URLSearchParams(await readText(req));
      log.revoked.push(f.get('token'));
      access.delete(f.get('token'));
      refresh.delete(f.get('token'));
      res.writeHead(200);
      return res.end();
    }
    res.writeHead(404);
    res.end('Not found');
  });

  const mcp = http.createServer(async (req, res) => {
    const u = new URL(req.url, mcpBase);
    if (req.method === 'GET' && u.pathname === '/.well-known/oauth-protected-resource/mcp') {
      return json(res, 200, { resource: `${mcpBase}/mcp`, authorization_servers: [asUrl], scopes_supported: o.scopes, bearer_methods_supported: ['header'], resource_name: 'Mock Notes' });
    }
    if (u.pathname !== '/mcp' || req.method !== 'POST') {
      res.writeHead(404);
      return res.end('Not found');
    }
    const authz = String(req.headers.authorization || '');
    log.mcpAuth.push(authz);
    const text = await readText(req);
    const m = JSON.parse(text);
    const meta = o.hint ? `, resource_metadata="${mcpBase}/.well-known/oauth-protected-resource/mcp"` : '';
    const signedIn = access.has(authz.replace(/^Bearer /, ''));
    if (!signedIn && o.toolSignIn && m.method === 'tools/call') {
      return json(res, 200, { jsonrpc: '2.0', id: m.id, result: { _meta: { 'mcp/www_authenticate': [`Bearer error="invalid_token", error_description="Sign in to Mock Notes to use this tool"${meta}`] }, content: [{ type: 'text', text: 'Sign in to Mock Notes to use this tool.' }], isError: true } });
    }
    if (!signedIn && !o.toolSignIn) {
      if (o.forbidden) {
        res.writeHead(403);
        return res.end();
      }
      res.writeHead(401, { 'www-authenticate': `Bearer realm="mock", error="invalid_token"${meta}, scope="notes:read"` });
      return res.end();
    }
    if (m.id == null) {
      res.writeHead(202);
      return res.end();
    }
    if (m.method === 'initialize') return json(res, 200, { jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'mock-notes', version: '1' } } }, { 'mcp-session-id': 'session-1' });
    if (m.method === 'tools/list') return json(res, 200, { jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'list_notes', description: 'List the notes', inputSchema: { type: 'object', properties: {} } }] } });
    if (m.method === 'tools/call') return json(res, 200, { jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: 'Note 1: order blue ink' }] } });
    return json(res, 200, { jsonrpc: '2.0', id: m.id, result: {} });
  });

  asUrl = `http://127.0.0.1:${await listen(auth)}`;
  mcpBase = `http://127.0.0.1:${await listen(mcp)}`;
  return {
    mcpUrl: `${mcpBase}/mcp`,
    asUrl,
    log,
    options: o,
    // The service turns down every token it gave (as when they run out), or also every refresh token.
    expireAll: () => access.clear(),
    // A token the user made on the service's site (a personal access token): the MCP server takes it.
    allow: (token) => access.add(token),
    revokeRefresh: () => refresh.clear(),
    // The user's browser: opens the sign-in page, approves, and follows the way back to Hearth.
    async browse(url) {
      const r = await fetch(url, { redirect: 'manual' });
      const location = r.headers.get('location');
      if (!location) return { status: r.status, html: await r.text(), location: '' };
      const back = await fetch(location);
      return { status: back.status, html: await back.text(), location };
    },
    close() {
      for (const s of [auth, mcp]) {
        s.close();
        s.closeAllConnections?.();
      }
    },
  };
}
