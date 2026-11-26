// Tests for signing in to connectors that are web services (OAuth): finding the sign-in server, registering Hearth,
// the browser round trip with PKCE, tokens kept per service and refreshed, sign-out, and the clear messages.
// A pretend service runs on this computer (tests/oauth-mock.mjs): no real accounts, no network.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

process.env.HEARTH_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-test-'));
const { updateSettings, DIRS } = await import('../server/settings.mjs');
const mcp = await import('../server/mcp.mjs');
const oauth = await import('../server/oauth.mjs');
const ext = await import('../server/extensions.mjs');
const { inspect, install } = await import('../server/ext-install.mjs');
const { listTools, callTool } = await import('../server/tools.mjs');
const { startMockService } = await import('./oauth-mock.mjs');
const { inLang } = await import('../server/i18n.mjs');
updateSettings({ language: 'en', toolsOn: true, toolApproval: 'ask', mcpConfig: '' });

// Hearth's /oauth/callback on a port of its own, as index.mjs serves it.
const cb = http.createServer((req, res) => mcp.oauthCallback(req, res, new URL(req.url, 'http://127.0.0.1')));
await new Promise((resolve) => cb.listen(0, '127.0.0.1', resolve));
const redirectUri = `http://127.0.0.1:${cb.address().port}/oauth/callback`;
const opened = [];
const open = (url) => opened.push(url); // instead of the real browser
after(() => {
  mcp.stopMcp();
  cb.close();
  cb.closeAllConnections?.();
});

const server = (name) => mcp.mcpServers().find((s) => s.name === name);
async function useConnectors(list) {
  updateSettings({ mcpConfig: Object.keys(list).length ? JSON.stringify({ mcpServers: list }) : '' });
  await mcp.ensureMcp();
}
// The file Hearth keeps for a service, read back (null when there is none).
function savedFor(url) {
  for (const f of fs.existsSync(oauth.OAUTH_DIR) ? fs.readdirSync(oauth.OAUTH_DIR) : []) {
    const rec = JSON.parse(fs.readFileSync(path.join(oauth.OAUTH_DIR, f), 'utf8'));
    if (rec.key === oauth.serviceKey(url)) return { file: path.join(oauth.OAUTH_DIR, f), rec };
  }
  return null;
}
async function signIn(name, svc) {
  const r = await mcp.signInConnector(name, { redirectUri, open });
  const back = await svc.browse(r.url);
  await mcp.ensureMcp();
  return { ...r, back };
}

test('sign-in headers from real services, safe addresses only', () => {
  assert.deepEqual(oauth.parseChallenge('Bearer realm="OAuth", resource_metadata="https://mcp.notion.com/.well-known/oauth-protected-resource/mcp", scope="default"'), { resourceMetadata: 'https://mcp.notion.com/.well-known/oauth-protected-resource/mcp', scope: 'default', error: '' });
  // Figma writes no space after the commas.
  assert.equal(oauth.parseChallenge('Bearer resource_metadata="https://mcp.figma.com/.well-known/oauth-protected-resource",scope="mcp:connect",authorization_uri="https://api.figma.com/x"').scope, 'mcp:connect');
  assert.deepEqual(oauth.parseChallenge('Bearer error="invalid_token", error_description="Say \\"hi\\", then go", scope=read'), { resourceMetadata: '', scope: 'read', error: 'invalid_token' });
  assert.deepEqual(oauth.parseChallenge(null), { resourceMetadata: '', scope: '', error: '' });

  const s = 'https://mcp.example.com/mcp';
  assert.ok(oauth.endpointAllowed('https://auth.example.com/authorize', s));
  for (const bad of ['http://auth.example.com/authorize', 'file:///Applications/Calculator.app', 'javascript:alert(1)', 'http://127.0.0.1:7420/api/shutdown', 'https://user:pw@auth.example.com/', 'not a url']) assert.ok(!oauth.endpointAllowed(bad, s), bad);
  assert.ok(oauth.endpointAllowed('http://127.0.0.1:9001/token', 'http://127.0.0.1:9000/mcp'), 'a test service on this computer');
  assert.ok(!oauth.endpointAllowed('http://192.168.1.5/token', 'http://127.0.0.1:9000/mcp'));

  assert.ok(oauth.resourceAllowed('https://mcp.slack.com/mcp', 'https://mcp.slack.com'));
  assert.ok(oauth.resourceAllowed('https://mcp.box.com', 'https://mcp.box.com/'));
  assert.ok(oauth.resourceAllowed('https://api.githubcopilot.com/mcp/', 'https://api.githubcopilot.com/mcp/'));
  assert.ok(!oauth.resourceAllowed('https://mcp.example.com/mcp', 'https://mcp.notion.com/mcp'));
  assert.ok(!oauth.resourceAllowed('https://mcp.example.com/mcp', 'https://mcp.example.com/mcp-other'));

  assert.equal(oauth.serviceKey('https://mcp.notion.com/mcp?x=1#y'), 'https://mcp.notion.com/mcp');
  assert.equal(oauth.serviceName('https://mcp.notion.com/mcp'), 'notion.com');
  assert.equal(oauth.serviceName('https://api.githubcopilot.com/mcp/'), 'github.com');
  assert.ok(oauth.usesOAuth({ url: s }));
  assert.ok(!oauth.usesOAuth({ url: s, headers: { authorization: 'Bearer mine' } }), 'a key of the user’s own wins');
  assert.ok(!oauth.usesOAuth({ command: 'npx' }));
});

test('a service that wants a sign-in: registration, the browser round trip with PKCE, then its tools', async () => {
  const svc = await startMockService();
  try {
    await useConnectors({ notes: { type: 'http', url: svc.mcpUrl } });
    let st = server('notes');
    assert.equal(st.status, 'signin');
    assert.deepEqual(st.auth, { service: new URL(svc.mcpUrl).host, signedIn: false, token: false, pending: false, error: '', canSignIn: true });
    assert.equal(svc.log.mcpAuth[0], '', 'no token before signing in');
    // Waiting for the user: pages and chats that ask again don't knock on the service again.
    for (let i = 0; i < 4; i++) await mcp.ensureMcp();
    assert.equal(svc.log.mcpAuth.length, 1);

    // "Sign in": Hearth registers itself and opens the service's own page in the browser.
    const r = await mcp.signInConnector('notes', { redirectUri, open });
    assert.equal(opened.at(-1), r.url);
    assert.equal(svc.log.registrations.length, 1);
    const reg = svc.log.registrations[0];
    assert.equal(reg.client_name, 'Hearth');
    assert.deepEqual(reg.redirect_uris, [redirectUri]);
    assert.deepEqual(reg.grant_types, ['authorization_code', 'refresh_token']);
    assert.equal(reg.token_endpoint_auth_method, 'none');
    const q = new URL(r.url).searchParams;
    assert.equal(r.url.startsWith(`${svc.asUrl}/authorize?`), true);
    assert.equal(q.get('client_id'), 'client-1');
    assert.equal(q.get('redirect_uri'), redirectUri);
    assert.equal(q.get('code_challenge_method'), 'S256');
    assert.match(q.get('code_challenge'), /^[\w-]{43}$/);
    assert.ok(q.get('state').length >= 32);
    assert.equal(q.get('scope'), 'notes:read', 'the access the 401 asked for');
    assert.equal(q.get('resource'), svc.mcpUrl, 'RFC 8707: tokens only for this service');
    assert.equal(server('notes').auth.pending, true);

    // The user approves; the browser comes back to Hearth, which trades the code (and PKCE secret) for tokens.
    const back = await svc.browse(r.url);
    assert.equal(back.status, 200);
    assert.match(back.html, /Signed in/);
    assert.match(back.html, /Hearth is now connected to 127\.0\.0\.1/);
    assert.equal(svc.log.token.at(-1).grant_type, 'authorization_code');
    await mcp.ensureMcp();
    st = server('notes');
    assert.equal(st.status, 'ready');
    assert.deepEqual(st.tools, ['list_notes']);
    assert.deepEqual(st.auth, { service: new URL(svc.mcpUrl).host, signedIn: true, token: false, pending: false, error: '', canSignIn: true });
    assert.match(svc.log.mcpAuth.at(-1), /^Bearer at-\d+$/);

    // Its tools work in the chat.
    const tool = (await listTools()).tools.find((x) => x.name === 'notes__list_notes');
    assert.ok(tool && tool.ask, 'asks before running, like every connector tool');
    assert.equal(await callTool(tool.name, {}, { approved: tool.name }), 'Note 1: order blue ink');

    // The tokens stay on the server: one file in the data folder, readable only by this user, never sent to the page.
    assert.equal(fs.readdirSync(oauth.OAUTH_DIR).length, 1);
    assert.equal(oauth.OAUTH_DIR, path.join(DIRS.data, 'oauth'));
    const { file, rec: saved } = savedFor(svc.mcpUrl);
    if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.match(saved.tokens.access_token, /^at-/);
    for (const secret of [saved.tokens.access_token, saved.tokens.refresh_token]) {
      assert.ok(!JSON.stringify(mcp.mcpServers()).includes(secret));
      assert.ok(!JSON.stringify((await listTools()).servers).includes(secret));
    }

    // The way back works once.
    const again = await fetch(back.location);
    assert.equal(again.status, 400);
    assert.match(await again.text(), /expired or was already used/);
  } finally {
    svc.close();
    await useConnectors({});
  }
});

test('tokens are refreshed before they run out, again when the service turns one down, else sign in again', async () => {
  const svc = await startMockService({ expiresIn: (n) => (n === 1 ? 60 : 3600) }); // the first token has a minute left
  try {
    await useConnectors({ notes: { type: 'http', url: svc.mcpUrl } });
    await signIn('notes', svc);
    assert.equal(server('notes').status, 'ready');
    assert.deepEqual(svc.log.token.map((x) => x.grant_type), ['authorization_code', 'refresh_token'], 'a token with a minute left is refreshed before use');
    assert.equal(svc.log.token[1].resource, svc.mcpUrl);
    const t1 = svc.log.mcpAuth.at(-1);

    // The service stops taking the token: Hearth refreshes it once and tries again, without bothering the user.
    svc.expireAll();
    assert.equal((await mcp.callMcp('notes', 'list_notes', {})).text, 'Note 1: order blue ink');
    assert.equal(svc.log.token.at(-1).grant_type, 'refresh_token');
    assert.notEqual(svc.log.mcpAuth.at(-1), t1);

    // The refresh is refused too: the connector asks the user to sign in again; Hearth's registration is kept.
    svc.expireAll();
    svc.revokeRefresh();
    await assert.rejects(mcp.callMcp('notes', 'list_notes', {}), /sign-in has expired/);
    assert.equal(server('notes').status, 'signin');
    assert.equal(server('notes').auth.signedIn, false);
    assert.ok(!(await listTools()).tools.some((x) => x.name === 'notes__list_notes'), 'its tools leave the chat');
    await signIn('notes', svc);
    assert.equal(server('notes').status, 'ready');
    assert.equal(svc.log.registrations.length, 1, 'registered once');
  } finally {
    svc.close();
    await useConnectors({});
  }
});

test('connectors with the same address share one sign-in, a plugin’s too; signing out signs them all out', async () => {
  const svc = await startMockService({ secret: true });
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-plugin-'));
  fs.mkdirSync(path.join(src, '.claude-plugin'));
  fs.writeFileSync(path.join(src, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'Notes Kit', description: 'Notes from the pretend service' }));
  fs.writeFileSync(path.join(src, '.mcp.json'), JSON.stringify({ mcpServers: { notes: { type: 'http', url: svc.mcpUrl } } }));
  try {
    await install((await inspect({ folder: src })).token);
    ext.updatePlugin('notes-kit', { connector: 'notes', connectorOn: true });
    await useConnectors({ mine: { type: 'http', url: svc.mcpUrl } });
    assert.equal(server('notes-kit:notes').status, 'signin');
    assert.equal(server('mine').status, 'signin');

    // Signing in on the plugin's connector (named "plugin:server") signs in the other one too.
    const r = await signIn('notes-kit:notes', svc);
    assert.equal(r.back.status, 200);
    assert.equal(server('notes-kit:notes').status, 'ready');
    assert.equal(server('mine').status, 'ready');
    assert.equal(svc.log.token[0].client_secret, 'secret-1', 'a client secret the service gave is used');

    // Signing out: the service is asked to forget the tokens, the file goes, and both wait for a sign-in again.
    const saved = savedFor(svc.mcpUrl).rec;
    await mcp.signOutConnector('mine');
    assert.deepEqual(svc.log.revoked, [saved.tokens.refresh_token, saved.tokens.access_token]);
    assert.equal(savedFor(svc.mcpUrl), null);
    await mcp.ensureMcp();
    assert.equal(server('mine').status, 'signin');
    assert.equal(server('notes-kit:notes').status, 'signin');
    assert.equal(server('mine').auth.signedIn, false);
  } finally {
    svc.close();
    ext.removePlugin('notes-kit');
    await useConnectors({});
  }
});

test('services that only take apps they approved get a clear message and no Sign in button', async () => {
  for (const opts of [{ dcr: false }, { dcrStatus: 403 }]) {
    const svc = await startMockService(opts);
    try {
      await useConnectors({ chat: { type: 'http', url: svc.mcpUrl } });
      const before = opened.length;
      await assert.rejects(mcp.signInConnector('chat', { redirectUri, open }), (err) => err.code === 'NO_DCR' && /only lets apps it approved in advance/.test(err.message));
      assert.equal(opened.length, before, 'no browser');
      const { auth } = server('chat');
      assert.match(auth.error, /only lets apps it approved in advance/);
      assert.match(inLang('ru', () => server('chat').auth.error), /пускает только заранее одобренные/, 'said again in the page’s language');
      assert.equal(auth.canSignIn, false);
      assert.equal(auth.pending, false);
    } finally {
      svc.close();
      await useConnectors({});
    }
  }
});

test('a service Hearth can’t sign in to takes a pasted token: kept private, sent as Bearer, forgotten when refused', async () => {
  const svc = await startMockService({ dcr: false });
  try {
    await useConnectors({ gh: { type: 'http', url: svc.mcpUrl } });
    await assert.rejects(mcp.signInConnector('gh', { redirectUri, open }), (err) => err.code === 'NO_DCR');
    assert.equal(server('gh').auth.canSignIn, false, 'the page offers the token box');

    // Pasted with or without "Bearer"; anything with spaces or line breaks (or nothing) is refused.
    for (const bad of ['', '   ', 'two words', 'line\nbreak']) assert.throws(() => mcp.useConnectorToken('gh', bad), /Paste the token first|doesn’t look like a token/);
    svc.allow('pat-from-the-site');
    mcp.useConnectorToken('gh', ' Bearer pat-from-the-site ');
    await mcp.ensureMcp();
    let st = server('gh');
    assert.equal(st.status, 'ready');
    assert.deepEqual(st.tools, ['list_notes']);
    assert.deepEqual(st.auth, { service: new URL(svc.mcpUrl).host, signedIn: true, token: true, pending: false, error: '', canSignIn: true });
    assert.equal(svc.log.mcpAuth.at(-1), 'Bearer pat-from-the-site');
    const { file, rec } = savedFor(svc.mcpUrl);
    assert.equal(rec.kind, 'token');
    if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.ok(!JSON.stringify(mcp.mcpServers()).includes('pat-from-the-site'), 'never sent to the page');

    // The service stops taking it (deleted on the site): Hearth forgets it and asks for a new one.
    svc.expireAll();
    await assert.rejects(mcp.callMcp('gh', 'list_notes', {}), /didn’t accept this token/);
    st = server('gh');
    assert.equal(st.status, 'signin');
    assert.equal(st.auth.signedIn, false);
    assert.equal(st.auth.canSignIn, false, 'the token box again, no Sign in button');
    assert.match(st.auth.error, /didn’t accept this token/);
    assert.equal(savedFor(svc.mcpUrl), null);
    assert.equal(svc.log.token.length, 0, 'no refresh attempts: there is nothing to refresh');

    // A new token works; removing it forgets it here and sends it nowhere.
    svc.allow('pat-2');
    mcp.useConnectorToken('gh', 'pat-2');
    await mcp.ensureMcp();
    assert.equal(server('gh').status, 'ready');
    await mcp.signOutConnector('gh');
    assert.equal(savedFor(svc.mcpUrl), null);
    assert.deepEqual(svc.log.revoked, []);
    await mcp.ensureMcp();
    assert.equal(server('gh').status, 'signin');
    assert.equal(server('gh').auth.canSignIn, false, 'straight back to the token box');
  } finally {
    svc.close();
    await useConnectors({});
  }
});

test('a sign-in turned down, an answer from the wrong sign-in server, a forged way back', async () => {
  const denied = await startMockService({ deny: true });
  try {
    await useConnectors({ notes: { type: 'http', url: denied.mcpUrl } });
    const { back } = await signIn('notes', denied);
    assert.equal(back.status, 400);
    assert.match(back.html, /You didn’t allow access/);
    assert.equal(server('notes').status, 'signin');
    assert.equal(server('notes').auth.error, 'You didn’t allow access.');
    assert.equal(server('notes').auth.canSignIn, true, 'the user may try again');
  } finally {
    denied.close();
  }
  const mixup = await startMockService({ issValue: 'https://evil.example' });
  try {
    await useConnectors({ notes: { type: 'http', url: mixup.mcpUrl } });
    const { back } = await signIn('notes', mixup);
    assert.match(back.html, /different sign-in server/);
    assert.ok(!mixup.log.token.length, 'the code was never used');
    assert.equal(server('notes').status, 'signin');

    // A way back that names another host (DNS rebinding) or a state Hearth never made is refused.
    const r = await mcp.signInConnector('notes', { redirectUri, open });
    const state = new URL(r.url).searchParams.get('state');
    const odd = await new Promise((resolve) => {
      http.get({ host: '127.0.0.1', port: cb.address().port, path: `/oauth/callback?state=${state}&code=x`, headers: { host: 'attacker.example' } }, (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => resolve({ status: res.statusCode, html: d }));
      });
    });
    assert.equal(odd.status, 400);
    assert.match(odd.html, /Sign in on the computer Hearth runs on/);
    assert.equal(server('notes').auth.pending, true, 'the real sign-in still waits');
    const forged = await fetch(`${redirectUri}?state=made-up&code=x`);
    assert.equal(forged.status, 400);
    assert.match(forged.headers.get('content-security-policy'), /default-src 'none'/);
  } finally {
    mixup.close();
    await useConnectors({});
  }
});

test('a service whose 401 doesn’t say where its sign-in settings are, and a key of the user’s own', async () => {
  const svc = await startMockService({ hint: false });
  try {
    await useConnectors({ notes: { type: 'http', url: svc.mcpUrl }, keyed: { type: 'http', url: svc.mcpUrl, headers: { Authorization: 'Bearer my-own-key' } } });
    const r = await signIn('notes', svc);
    assert.equal(new URL(r.url).searchParams.get('resource'), svc.mcpUrl, 'found at the well-known address');
    assert.equal(server('notes').status, 'ready');
    // The connector with its own key keeps it: Hearth never adds a sign-in to it, and says plainly when it's refused.
    const keyed = server('keyed');
    assert.equal(keyed.status, 'error');
    assert.equal(keyed.auth, null);
    assert.match(keyed.error, /didn’t accept the key or token saved for this connector/);
    assert.ok(svc.log.mcpAuth.includes('Bearer my-own-key'));
    await assert.rejects(mcp.signInConnector('keyed', { redirectUri, open }), /doesn’t need a sign-in/);
    await assert.rejects(mcp.signInConnector('nothing-here', { redirectUri, open }), /Turn the connector on first/);
  } finally {
    svc.close();
    await useConnectors({});
  }
});

test('services that differ: one takes only http://localhost as the way back; one answers a bare 403 and lists more access than it lets a new app ask for', async () => {
  // Like Calendly: registration refuses http://127.0.0.1 and takes http://localhost; the whole sign-in then uses it.
  const cal = await startMockService({ loopback: 'localhost' });
  // Like Adobe: no sign-in header, only 403; its metadata lists access its registration doesn't allow.
  const ado = await startMockService({ forbidden: true, scopes: ['openid', 'notes:read', 'notes:admin'], grantScope: 'openid notes:read' });
  try {
    await useConnectors({ cal: { type: 'http', url: cal.mcpUrl }, ado: { type: 'http', url: ado.mcpUrl } });
    assert.equal(server('cal').status, 'signin');
    assert.equal(server('ado').status, 'signin', 'a bare 403 from a service that has a sign-in means: sign in');

    const c = await signIn('cal', cal);
    assert.deepEqual(cal.log.registrations.map((r) => new URL(r.redirect_uris[0]).hostname), ['127.0.0.1', 'localhost']);
    assert.match(new URL(c.url).searchParams.get('redirect_uri'), /^http:\/\/localhost:\d+\/oauth\/callback$/);
    assert.equal(c.back.status, 200, c.back.html);
    assert.equal(server('cal').status, 'ready');
    assert.equal(cal.log.token.at(-1).redirect_uri, new URL(c.url).searchParams.get('redirect_uri'));
    // Another sign-in keeps the registration that worked.
    const again = await mcp.signInConnector('cal', { redirectUri, open });
    assert.equal(cal.log.registrations.length, 2);
    assert.match(new URL(again.url).searchParams.get('redirect_uri'), /^http:\/\/localhost:/);

    const a = await signIn('ado', ado);
    assert.equal(new URL(a.url).searchParams.get('scope'), 'openid notes:read', 'only the access its registration allows');
    assert.equal(a.back.status, 200, a.back.html);
    assert.equal(server('ado').status, 'ready');
    assert.ok(server('ado').tools.length > 0);
  } finally {
    cal.close();
    ado.close();
    await useConnectors({});
  }
});
