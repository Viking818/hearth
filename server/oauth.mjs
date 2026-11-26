// Signing in to connectors that are web services (OAuth, the way MCP describes it). When a service answers "sign in
// first" (401), Hearth asks it where its sign-in server is (RFC 9728, then RFC 8414), registers itself there as an app
// (RFC 7591) and opens the service's own sign-in page in the browser (authorization code with PKCE). The browser comes
// back to http://127.0.0.1:<port>/oauth/callback (http://localhost:… for services that refuse the number, like
// Calendly), asking only for the access the registration allows. The tokens are kept in the data folder, one file per service, so
// connectors with the same address share one sign-in. They are refreshed before they run out, sent only to that
// service, and never to the page. Services that only take apps they approved in advance (GitHub, Slack…) can't be
// signed in to this way; where the service gives out access tokens (GitHub's personal access tokens), the user pastes
// one instead, and it is kept the same way.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { DIRS, APP_NAME } from './settings.mjs';
import { readJson, uid, isLoopback, IS_MAC, IS_WIN, openCommand } from './util.mjs';
import { t, getLang, inLang, defaultLang } from './i18n.mjs';

export const OAUTH_DIR = path.join(DIRS.data, 'oauth');
const FLOW_TTL = 10 * 60 * 1000; // a sign-in started in the browser must come back within 10 minutes
const EARLY = 2 * 60 * 1000; // tokens are refreshed this long before they run out
const TIMEOUT = 20000;
const LOOPBACK = /^(127\.\d+\.\d+\.\d+|localhost|\[::1\])$/i;

// `say` makes the message: it is said again in the page's language whenever the page asks (it may switch languages).
const fail = (say, code = '', status = 400) => Object.assign(new Error(say()), { say, code, status });
const NO_DCR = () => t('This service only lets apps it approved in advance sign in, so Hearth can’t connect to it.');

const flows = new Map(); // state → a sign-in waiting for the browser
const hints = new Map(); // service → what its last "401" said (where its sign-in settings are, which access it wants)
const errors = new Map(); // service → { say, code } of the last sign-in that went wrong
const refreshing = new Map(); // service → the refresh under way
const cache = new Map(); // service → its file, as read

// ---- Services ----

// Connectors with the same address share a sign-in: the address without its query and fragment.
export function serviceKey(url) {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
  } catch {
    return String(url || '');
  }
}

// A short name people know: "notion.com" for https://mcp.notion.com/mcp.
const KNOWN = { 'githubcopilot.com': 'github.com' }; // services whose MCP address isn't on their usual domain
export function serviceName(url) {
  try {
    const host = new URL(url).host.replace(/^(mcp|api|www)\./i, '');
    return KNOWN[host] || host;
  } catch {
    return String(url || '');
  }
}

// Whether OAuth applies: a web address, and no key or token of its own in the settings.
export function usesOAuth(cfg) {
  return Boolean(cfg?.url) && !Object.keys(cfg.headers || {}).some((k) => k.toLowerCase() === 'authorization');
}

// Sign-in addresses must be https. A connector that is itself plain http on this computer (a test, or a server the
// user runs at home) may use plain-http sign-in addresses on this computer too. Nothing else: no file: links to open.
export function endpointAllowed(target, serverUrl) {
  let u;
  let s;
  try {
    u = new URL(target);
    s = new URL(serverUrl);
  } catch {
    return false;
  }
  if (u.username || u.password) return false;
  if (u.protocol === 'https:') return true;
  return u.protocol === 'http:' && s.protocol === 'http:' && LOOPBACK.test(u.hostname) && LOOPBACK.test(s.hostname);
}

// The way back to Hearth with the computer's name instead of its number: some services refuse http://127.0.0.1 as an
// app's way back but take http://localhost (Calendly). '' when there is no such other form.
function byName(uri) {
  try {
    const u = new URL(uri);
    if (u.protocol !== 'http:' || u.hostname !== '127.0.0.1') return '';
    u.hostname = 'localhost';
    return u.href;
  } catch {
    return '';
  }
}
const sameWayBack = (saved, uri) => saved === uri || (Boolean(saved) && saved === byName(uri));

// RFC 9728: the service may name a resource that covers its address (https://mcp.slack.com for …/mcp), never another.
export function resourceAllowed(serverUrl, resource) {
  try {
    const want = new URL(serverUrl);
    const got = new URL(resource);
    if (want.origin !== got.origin) return false;
    const a = want.pathname.endsWith('/') ? want.pathname : `${want.pathname}/`;
    const b = got.pathname.endsWith('/') ? got.pathname : `${got.pathname}/`;
    return a.startsWith(b);
  } catch {
    return false;
  }
}

// "Bearer realm="OAuth", resource_metadata="https://…", scope="read write"" → its parts.
export function parseChallenge(header) {
  const out = {};
  for (const m of String(header || '').matchAll(/([A-Za-z0-9_-]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s,"]+))/g)) {
    const k = m[1].toLowerCase();
    if (!(k in out)) out[k] = m[2] !== undefined ? m[2].replace(/\\(.)/g, '$1') : m[3];
  }
  return { resourceMetadata: out.resource_metadata || '', scope: out.scope || '', error: out.error || '' };
}

// ---- Files: one per service, readable only by this user ----

function fileFor(key) {
  let host = 'service';
  try {
    host = new URL(key).host.replace(/[^\w.-]/g, '_');
  } catch {}
  return path.join(OAUTH_DIR, `${host}-${crypto.createHash('sha256').update(key).digest('hex').slice(0, 12)}.json`);
}

function load(key) {
  if (!cache.has(key)) cache.set(key, readJson(fileFor(key), null));
  return cache.get(key);
}

function save(key, rec) {
  fs.mkdirSync(OAUTH_DIR, { recursive: true, mode: 0o700 });
  const file = fileFor(key);
  const tmp = `${file}.${process.pid}.${uid(6)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ ...rec, key }, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
  cache.set(key, { ...rec, key });
}

function remove(key) {
  fs.rmSync(fileFor(key), { force: true });
  cache.set(key, null);
}

export function hasTokens(key) {
  return Boolean(load(key)?.tokens?.access_token);
}

// What the page may know: never a token.
// canSignIn false: the service doesn't let Hearth sign in, so the page offers to paste a token instead.
export function authState(key) {
  const now = Date.now();
  const e = errors.get(key);
  return {
    service: serviceName(key),
    signedIn: hasTokens(key),
    token: load(key)?.kind === 'token', // a token the user pasted, not a sign-in
    pending: [...flows.values()].some((f) => f.key === key && now - f.at < FLOW_TTL),
    error: e ? e.say() : '',
    canSignIn: e?.code !== 'NO_DCR' && e?.code !== 'TOKEN',
  };
}

// The service said "sign in" (a 401): keep what it said for the sign-in.
export function noteChallenge(key, challenge) {
  if (challenge && (challenge.resourceMetadata || challenge.scope)) hints.set(key, challenge);
}

// ---- Talking to sign-in servers ----

async function request(url, serverUrl, opts = {}, hops = 0) {
  if (!endpointAllowed(url, serverUrl)) throw fail(() => t('Sign-in addresses must be secure (https).'), 'INSECURE');
  const { timeout = TIMEOUT, ...init } = opts;
  let res;
  try {
    res = await fetch(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(timeout) });
  } catch (err) {
    throw fail(() => t('The sign-in server didn’t answer: {detail}', { detail: err.cause?.message || err.message }), 'NETWORK', 502);
  }
  const to = res.headers.get('location');
  if (res.status >= 300 && res.status < 400 && to && !opts.method && hops < 3) return request(new URL(to, url).href, serverUrl, opts, hops + 1);
  return res;
}

async function bodyOf(res) {
  const text = await res.text().catch(() => '');
  try {
    return JSON.parse(text);
  } catch {
    // Some token endpoints answer like a form: access_token=…&scope=…
    return /^[\w.-]+=/.test(text) ? Object.fromEntries(new URLSearchParams(text)) : {};
  }
}

const detailOf = (j, res) => String(j?.error_description || j?.error || `HTTP ${res.status}`).slice(0, 300);

async function getJson(url, serverUrl) {
  const res = await request(url, serverUrl, { headers: { accept: 'application/json' } });
  if (!res.ok) {
    res.body?.cancel().catch(() => {});
    return null;
  }
  const j = await bodyOf(res);
  return j && typeof j === 'object' && !Array.isArray(j) ? j : null;
}

// A metadata address that isn't there is skipped; a network or https problem is reported.
const skipMissing = (err) => {
  if (err.code === 'NETWORK' || err.code === 'INSECURE') throw err;
  return null;
};

// RFC 9728: what the service says about itself: its sign-in servers and the access it offers.
async function findResource(serverUrl, hint) {
  const u = new URL(serverUrl);
  const p = u.pathname.replace(/\/+$/, '');
  const tries = [hint, p && `${u.origin}/.well-known/oauth-protected-resource${p}`, `${u.origin}/.well-known/oauth-protected-resource`].filter(Boolean);
  for (const url of [...new Set(tries)]) {
    const j = await getJson(url, serverUrl).catch(skipMissing);
    if (j && (Array.isArray(j.authorization_servers) || j.resource)) return j;
  }
  return null;
}

// RFC 8414 (or OpenID's discovery): the sign-in server's addresses.
async function findAuthServer(issuer, serverUrl) {
  const u = new URL(issuer);
  const p = u.pathname.replace(/\/+$/, '');
  const tries = p
    ? [`${u.origin}/.well-known/oauth-authorization-server${p}`, `${u.origin}/.well-known/openid-configuration${p}`, `${u.origin}${p}/.well-known/openid-configuration`]
    : [`${u.origin}/.well-known/oauth-authorization-server`, `${u.origin}/.well-known/openid-configuration`];
  for (const url of tries) {
    const j = await getJson(url, serverUrl).catch(skipMissing);
    if (j?.authorization_endpoint && j.token_endpoint) return j;
  }
  return null;
}

// RFC 7591: Hearth registers itself with the sign-in server. Services that only accept apps they approved in advance
// (Slack, HubSpot, GitHub…) have no registration address, or refuse.
async function register(as, redirectUri, serverUrl) {
  if (!as.registration_endpoint) throw fail(NO_DCR, 'NO_DCR');
  const methods = Array.isArray(as.token_endpoint_auth_methods_supported) ? as.token_endpoint_auth_methods_supported : null;
  const method = !methods || methods.includes('none') ? 'none' : methods.includes('client_secret_post') ? 'client_secret_post' : 'client_secret_basic';
  const res = await request(as.registration_endpoint, serverUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ client_name: APP_NAME, redirect_uris: [redirectUri], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: method }),
  });
  const j = await bodyOf(res);
  if (res.status === 401 || res.status === 403) throw fail(NO_DCR, 'NO_DCR');
  if (!res.ok || !j.client_id) throw fail(() => t('The service refused to register Hearth: {detail}', { detail: detailOf(j, res) }), 'REGISTER');
  const secret = typeof j.client_secret === 'string' ? j.client_secret : '';
  return {
    client_id: String(j.client_id),
    client_secret: secret,
    auth_method: j.token_endpoint_auth_method || (secret ? (methods?.includes('client_secret_post') ? 'client_secret_post' : 'client_secret_basic') : 'none'),
    redirect_uri: redirectUri,
    scope: typeof j.scope === 'string' ? j.scope.trim().slice(0, 2000) : '', // the access this app may ask for, when the service says
    secret_expires_at: Number(j.client_secret_expires_at) > 0 ? Number(j.client_secret_expires_at) * 1000 : 0,
  };
}

// Registers Hearth; when the service turns down http://127.0.0.1 as the way back, again with http://localhost.
async function registerAny(as, redirectUri, serverUrl) {
  try {
    return await register(as, redirectUri, serverUrl);
  } catch (err) {
    const other = byName(redirectUri);
    if (err.code !== 'REGISTER' || !other) throw err;
    return register(as, other, serverUrl).catch(() => {
      throw err;
    });
  }
}

// Only access the registration allows (Adobe lists more than it lets a new app ask for, and then refuses it all).
function allowedScope(wanted, client) {
  if (!client?.scope) return wanted;
  const granted = client.scope.split(/[\s,]+/).filter(Boolean);
  const keep = wanted.split(/\s+/).filter((s) => granted.includes(s));
  return (keep.length ? keep : granted).join(' ');
}

// Whether a service that turned Hearth away without a word (a bare 403, as Adobe's does) has a sign-in after all.
export async function advertisesSignIn(serverUrl) {
  const prm = await findResource(serverUrl, '').catch(() => null);
  return Array.isArray(prm?.authorization_servers) && prm.authorization_servers.some((x) => typeof x === 'string');
}

function withClient(client, body, headers) {
  if (client.client_secret && client.auth_method === 'client_secret_basic') {
    headers.authorization = `Basic ${Buffer.from(`${client.client_id}:${client.client_secret}`).toString('base64')}`;
  } else {
    body.set('client_id', client.client_id);
    if (client.client_secret) body.set('client_secret', client.client_secret);
  }
}

async function tokenRequest(rec, params) {
  const body = new URLSearchParams(params);
  const headers = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' };
  withClient(rec.client, body, headers);
  if (rec.resource) body.set('resource', rec.resource);
  const res = await request(rec.as.token_endpoint, rec.url, { method: 'POST', headers, body: body.toString() });
  const j = await bodyOf(res);
  if (!res.ok || j.error || !j.access_token) throw fail(() => t('The service refused the sign-in: {detail}', { detail: detailOf(j, res) }), j.error || 'TOKEN', res.status >= 500 ? 502 : 400);
  const life = Number(j.expires_in);
  return {
    access_token: String(j.access_token),
    refresh_token: j.refresh_token ? String(j.refresh_token) : '',
    token_type: String(j.token_type || 'Bearer'),
    scope: String(j.scope || rec.scope || ''),
    expires_at: life > 0 ? Date.now() + life * 1000 : 0,
  };
}

// ---- Signing in ----

// Finds the sign-in server, registers Hearth if needed, and returns the page to open in the browser.
export async function beginSignIn(serverUrl, redirectUri) {
  const key = serviceKey(serverUrl);
  errors.delete(key);
  const now = Date.now();
  for (const [state, f] of flows) if (f.key === key || now - f.at > FLOW_TTL) flows.delete(state);
  try {
    const hint = hints.get(key) || {};
    const prm = await findResource(serverUrl, hint.resourceMetadata && endpointAllowed(hint.resourceMetadata, serverUrl) ? hint.resourceMetadata : '');
    if (prm?.resource && !resourceAllowed(serverUrl, prm.resource)) throw fail(() => t('This service’s sign-in settings are for another address, so Hearth didn’t use them.'), 'RESOURCE');
    const issuer = (Array.isArray(prm?.authorization_servers) && prm.authorization_servers.find((x) => typeof x === 'string')) || new URL(serverUrl).origin;
    const meta = await findAuthServer(issuer, serverUrl);
    if (!meta) throw fail(() => t('This service doesn’t say how to sign in to it. If it gave you a key, add the connector with that key instead.'), 'NO_AUTH');
    if (!endpointAllowed(meta.authorization_endpoint, serverUrl) || !endpointAllowed(meta.token_endpoint, serverUrl)) throw fail(() => t('Sign-in addresses must be secure (https).'), 'INSECURE');
    const as = {
      issuer: String(meta.issuer || ''),
      authorization_endpoint: meta.authorization_endpoint,
      token_endpoint: meta.token_endpoint,
      revocation_endpoint: endpointAllowed(meta.revocation_endpoint || '', serverUrl) ? meta.revocation_endpoint : '',
      iss_supported: meta.authorization_response_iss_parameter_supported === true,
    };
    // Reuse Hearth's registration unless the sign-in server, the return address (Hearth's port) or the secret changed.
    const saved = load(key);
    let client = saved?.client;
    if (!client || !sameWayBack(client.redirect_uri, redirectUri) || saved.as?.token_endpoint !== as.token_endpoint || (client.secret_expires_at && client.secret_expires_at < now + 60000)) {
      client = await registerAny(meta, redirectUri, serverUrl);
      save(key, { ...(saved || {}), url: serverUrl, as, client });
    }
    const scope = allowedScope(hint.scope || (Array.isArray(prm?.scopes_supported) ? prm.scopes_supported.filter((x) => typeof x === 'string').join(' ') : ''), client);
    const resource = typeof prm?.resource === 'string' ? prm.resource : '';
    const verifier = crypto.randomBytes(32).toString('base64url');
    const state = crypto.randomBytes(24).toString('base64url');
    const url = new URL(as.authorization_endpoint);
    const q = {
      response_type: 'code',
      client_id: client.client_id,
      redirect_uri: client.redirect_uri, // the one the service took (http://localhost for some)
      code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
      state,
      ...(scope ? { scope } : {}),
      ...(resource ? { resource } : {}),
    };
    for (const [k, v] of Object.entries(q)) url.searchParams.set(k, v);
    flows.set(state, { key, url: serverUrl, verifier, client, as, resource, scope, at: now });
    return { url: url.href, key, service: serviceName(serverUrl) };
  } catch (err) {
    errors.set(key, { say: err.say || (() => err.message), code: err.code || '' });
    throw err;
  }
}

// The browser came back with ?code=…&state=… (or an error): trade the code for tokens.
export async function finishSignIn(params) {
  const state = params.get('state') || '';
  const flow = state ? flows.get(state) : null;
  flows.delete(state);
  if (!flow || Date.now() - flow.at > FLOW_TTL) throw fail(() => t('This sign-in has expired or was already used.'), 'STATE');
  const { key } = flow;
  try {
    const iss = params.get('iss');
    if (flow.as.issuer && (iss || flow.as.iss_supported) && iss !== flow.as.issuer) throw fail(() => t('The answer came from a different sign-in server than expected, so Hearth ignored it.'), 'ISS');
    const error = params.get('error');
    const why = String(params.get('error_description') || error).slice(0, 300);
    if (error) throw fail(() => (error === 'access_denied' ? t('You didn’t allow access.') : t('The service refused the sign-in: {detail}', { detail: why })), 'DENIED');
    const code = params.get('code');
    if (!code) throw fail(() => t('The service didn’t send a sign-in code.'), 'CODE');
    const tokens = await tokenRequest(flow, { grant_type: 'authorization_code', code, redirect_uri: flow.client.redirect_uri, code_verifier: flow.verifier });
    save(key, { url: flow.url, resource: flow.resource, scope: flow.scope, as: flow.as, client: flow.client, tokens });
    errors.delete(key);
    hints.delete(key);
    return { key, service: serviceName(flow.url) };
  } catch (err) {
    errors.set(key, { say: err.say || (() => err.message), code: err.code || '' });
    throw err;
  }
}

// ---- Tokens ----

// A token the user pasted (a personal access token, say), for a service Hearth can't sign in to. Like sign-in tokens,
// it stays in this service's file and goes only to the service.
export function saveToken(serverUrl, raw) {
  const token = String(raw || '').trim().replace(/^bearer\s+/i, '');
  if (!token) throw fail(() => t('Paste the token first.'));
  if (token.length > 4096 || /[\s\x00-\x1f\x7f]/.test(token)) throw fail(() => t('That doesn’t look like a token: it has spaces or line breaks.'));
  const key = serviceKey(serverUrl);
  save(key, { url: serverUrl, kind: 'token', tokens: { access_token: token, refresh_token: '', token_type: 'Bearer', scope: '', expires_at: 0 } });
  errors.delete(key);
  hints.delete(key);
  return key;
}

// The service turned down the token Hearth sent: forget it, and say what to do.
export function tokenRefused(key) {
  const pasted = load(key)?.kind === 'token';
  dropTokens(key);
  if (!pasted) return t('Your sign-in has expired. Sign in again.');
  const say = () => t('The service didn’t accept this token. Check it, or paste a new one.');
  errors.set(key, { say, code: 'TOKEN' });
  return say();
}

// Forget the tokens (the service no longer takes them); with `client`, Hearth's registration too.
export function dropTokens(key, client = false) {
  const rec = load(key);
  if (!rec) return;
  const { tokens, ...rest } = rec;
  if (client || !rest.client) remove(key);
  else save(key, rest);
}

function refresh(key) {
  if (refreshing.has(key)) return refreshing.get(key);
  const job = (async () => {
    const rec = load(key);
    if (!rec?.tokens?.refresh_token || !rec.client || !rec.as) return '';
    let tokens;
    try {
      tokens = await tokenRequest(rec, { grant_type: 'refresh_token', refresh_token: rec.tokens.refresh_token });
    } catch (err) {
      if (err.status >= 500) throw err; // the network or the service is down: keep the tokens and try later
      dropTokens(key, err.code === 'invalid_client');
      return '';
    }
    save(key, { ...load(key), tokens: { ...tokens, refresh_token: tokens.refresh_token || rec.tokens.refresh_token } });
    return tokens.access_token;
  })().finally(() => refreshing.delete(key));
  refreshing.set(key, job);
  return job;
}

// The token for a request ('' when there is none), refreshed when it is about to run out.
export async function accessToken(key) {
  const tok = load(key)?.tokens;
  if (!tok?.access_token) return '';
  const now = Date.now();
  if (!tok.expires_at || tok.expires_at - now > EARLY) return tok.access_token;
  const expired = tok.expires_at <= now;
  if (!tok.refresh_token) return expired ? '' : tok.access_token;
  try {
    return await refresh(key);
  } catch (err) {
    if (!expired) return tok.access_token; // still good for a moment
    throw err;
  }
}

// The service refused `used`: a newer token if one was made meanwhile or a refresh works, else ''.
export async function renewToken(key, used) {
  const cur = load(key)?.tokens?.access_token;
  if (cur && cur !== used) return cur;
  try {
    return await refresh(key);
  } catch {
    return '';
  }
}

// Sign out: forget everything about the service here, and ask the service to forget the tokens too.
export async function signOut(key) {
  const rec = load(key);
  remove(key);
  // After a pasted token, the page offers the token box again (the service still can't be signed in to).
  if (rec?.kind === 'token') errors.set(key, { say: NO_DCR, code: 'NO_DCR' });
  else errors.delete(key);
  for (const [state, f] of flows) if (f.key === key) flows.delete(state);
  if (!rec?.tokens || rec.kind === 'token' || !rec.as?.revocation_endpoint || !rec.client) return; // a pasted token is the user's to delete
  for (const [token, hint] of [
    [rec.tokens.refresh_token, 'refresh_token'],
    [rec.tokens.access_token, 'access_token'],
  ]) {
    if (!token) continue;
    const body = new URLSearchParams({ token, token_type_hint: hint });
    const headers = { 'content-type': 'application/x-www-form-urlencoded' };
    withClient(rec.client, body, headers);
    await request(rec.as.revocation_endpoint, rec.url, { method: 'POST', headers, body: body.toString(), timeout: 8000 })
      .then((res) => res.body?.cancel())
      .catch(() => {});
  }
}

// ---- The browser ----

// The service's sign-in page opens in the user's own browser, where they may already be signed in to it.
export function openInBrowser(url) {
  try {
    const u = new URL(url); // only a web address is ever handed to the system
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
    const [cmd, args] = openCommand(u.href);
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', () => {});
    child.unref();
  } catch {}
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function callbackPage({ ok, service, message }) {
  const title = ok ? t('Signed in') : t('Couldn’t sign in');
  const text = ok ? t('Hearth is now connected to {service}. You can close this tab and go back to Hearth.', { service }) : `${message} ${t('Go back to Hearth and try again.')}`;
  return `<!doctype html>
<html lang="${getLang()}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · ${APP_NAME}</title>
<style>
:root{--bg:#fafaf9;--card:#fff;--text:#1c1917;--muted:#78716c;--border:#e6e3de;--ok:#16a34a;--bad:#dc2626;color-scheme:light dark}
@media (prefers-color-scheme:dark){:root{--bg:#161412;--card:#1b1917;--text:#f5f3f0;--muted:#a8a29e;--border:#2f2b27;--ok:#34d399;--bad:#f87171}}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--text);font:15px/1.5 ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif}
main{max-width:420px;margin:16px;padding:32px 28px;background:var(--card);border:1px solid var(--border);border-radius:14px;text-align:center}
.mark{width:44px;height:44px;margin:0 auto 14px;border-radius:50%;display:grid;place-items:center;font-size:22px;font-weight:700;color:#fff;background:var(--${ok ? 'ok' : 'bad'})}
h1{font-size:20px;margin:0 0 8px}p{margin:0;color:var(--muted)}
</style></head>
<body><main><div class="mark">${ok ? '✓' : '!'}</div><h1>${esc(title)}</h1><p>${esc(text)}</p></main></body></html>`;
}

// GET /oauth/callback: only from this computer's own browser, in the language Hearth's page uses.
export async function signInCallback(req, res, url, onSignedIn) {
  const host = String(req.headers.host || '').toLowerCase();
  const local = isLoopback(req.socket.remoteAddress) && /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host); // no DNS-rebinding tricks
  let ok = false;
  const page = await inLang(defaultLang(), async () => {
    if (!local) return callbackPage({ ok: false, message: t('Sign in on the computer Hearth runs on.') });
    try {
      const r = await finishSignIn(url.searchParams);
      ok = true;
      onSignedIn?.(r.key);
      return callbackPage({ ok: true, service: r.service });
    } catch (err) {
      return callbackPage({ ok: false, message: err.message });
    }
  });
  res.writeHead(ok ? 200 : 400, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'",
  });
  res.end(page);
}
