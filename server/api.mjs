// The local AI API on /v1: OpenAI-compatible (chat/completions, completions, embeddings, responses)
// and Anthropic-compatible (messages, count_tokens). Requests go to the engine; Hearth logs each one
// for the Monitor and loads the last model on demand, so coding tools work even right after a restart.
import fs from 'node:fs';
import path from 'node:path';
import { getSettings, DIRS } from './settings.mjs';
import { engineState, ensureEngine, resolveEngine, modelAlias } from './engine.mjs';
import { skillsList, activeSkillsPrompt } from './extensions.mjs';
import { connectorToolsList } from './tools.mjs';
import { listLocalModels } from './models.mjs';
import { beginRequest, finishRequest, clientName } from './monitor.mjs';
import { readBody, sendJson, isLoopback, fetchLong } from './util.mjs';
import { getAssistant, memoryPrompt } from './assistants.mjs';
import { pairedDevice } from './phone.mjs';
import { t, locale } from './i18n.mjs';

const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };

function apiKind(p) {
  return p.startsWith('/v1/messages') ? 'anthropic' : 'openai';
}

function sendApiError(res, kind, status, message) {
  if (res.headersSent) return res.end();
  if (kind === 'anthropic') {
    const type = status === 401 ? 'authentication_error' : status === 404 ? 'not_found_error' : status === 503 ? 'overloaded_error' : 'api_error';
    return sendJson(res, status, { type: 'error', error: { type, message } });
  }
  return sendJson(res, status, { error: { message, type: status === 401 ? 'invalid_api_key' : 'server_error', code: status } });
}

function keyOf(req) {
  const auth = String(req.headers.authorization || '');
  return (auth.startsWith('Bearer ') ? auth.slice(7) : '') || String(req.headers['x-api-key'] || '');
}

// Apps on this computer don't need the key. Other devices on the network do.
export function apiAllowed(req) {
  // Browsers mark requests from web pages with Origin; apps don't. Only Hearth's own page may use the API from a browser.
  const origin = req.headers.origin;
  if (origin) {
    try {
      const o = new URL(origin);
      // Hearth's own page has the address the request came to, port included: a page of another program on this
      // computer (the same name, another port) is not Hearth.
      const same = o.host.toLowerCase() === String(req.headers.host || '').toLowerCase();
      const own = same && (/^(127\.0\.0\.1|localhost|\[::1\])$/.test(o.hostname) || Boolean(pairedDevice(req)));
      if (!own) return false;
    } catch {
      return false;
    }
  }
  if (isLoopback(req.socket.remoteAddress)) return true;
  // A paired phone's own page (its Origin is the address it opened Hearth at).
  if (pairedDevice(req) && (!origin || new URL(origin).host === req.headers.host)) return true;
  return getSettings().access === 'lan' && keyOf(req) === getSettings().apiKey;
}

function lastModelFinder(last) {
  const list = listLocalModels(true);
  return list.find((m) => m.id === last.id) || list.find((m) => m.path === last.path) || null;
}

// Images the chat uploaded are referenced as /uploads/<file>; the engine needs the bytes.
function uploadToData(url) {
  const m = /^(?:https?:\/\/[^/]+)?\/uploads\/([\w.-]+)$/.exec(url || '');
  if (!m) return null;
  const file = path.join(DIRS.uploads, path.basename(m[1]));
  const mime = MIME[path.extname(file).toLowerCase()];
  if (!mime || !fs.existsSync(file)) return null;
  return { mime, b64: fs.readFileSync(file).toString('base64') };
}

function prepareBody(body, kind, req) {
  if (!body || typeof body !== 'object') return body;
  for (const msg of body.messages || []) {
    if (!Array.isArray(msg.content)) continue;
    for (const part of msg.content) {
      if (part.type === 'image_url' && part.image_url?.url) {
        const d = uploadToData(part.image_url.url);
        if (d) part.image_url.url = `data:${d.mime};base64,${d.b64}`;
      } else if (part.type === 'image' && part.source?.type === 'url') {
        const d = uploadToData(part.source.url);
        if (d) part.source = { type: 'base64', media_type: d.mime, data: d.b64 };
      }
    }
  }
  // Coding tools are much faster without "thinking"; the user can switch this in Settings.
  const fromChat = req.headers['x-hearth-client'] === 'chat';
  if (fromChat && body.hearth) {
    addChatContext(body, body.hearth);
    delete body.hearth;
  }
  if (!fromChat && getSettings().apiThinking === 'off' && body.chat_template_kwargs?.enable_thinking === undefined) {
    body.chat_template_kwargs = { ...(body.chat_template_kwargs || {}), enable_thinking: false };
    if (kind === 'anthropic') delete body.thinking;
  }
  return body;
}

// Hearth's chat adds the date, the chosen assistant's instructions, what Memory holds and the skills, on the server,
// so they stay current (the page only says which assistant and which skills).
// The parts that change least come first: the engine then reuses its reading of them from the last message (its
// prompt cache) instead of reading them again, which matters with a long list of skills on a local model.
export function addChatContext(body, ctx) {
  const parts = [];
  if (ctx.tools) {
    parts.push(t('You can use tools. Search or open pages when the answer depends on current or exact facts, and say which sources you used. When a tool fails, say so instead of guessing.'));
    const list = skillsList();
    if (list) parts.push(list);
    // Many connector tools: the page sent find_tool and use_tool in their place; the model gets their names here.
    if (Array.isArray(body.tools) && body.tools.some((x) => x?.function?.name === 'find_tool')) {
      const names = connectorToolsList();
      if (names) parts.push(names);
    }
  }
  const user = getSettings().systemPrompt;
  if (user) parts.push(user);
  if (ctx.memory !== false) {
    const mem = memoryPrompt();
    if (mem) parts.push(mem);
  }
  // A conversation by voice: the answer is read aloud by the computer.
  if (ctx.voice) parts.push('The user is talking to you by voice, and your answer is read aloud. Answer the way people speak: a few short sentences in plain words. No lists, tables, headings, code, links or emoji unless asked for. If the answer would be long, say the main point and offer the details. The words you get were made from speech, so a word or a name may be wrong: go by what makes sense.');
  const a = ctx.assistantId ? getAssistant(String(ctx.assistantId)) : null;
  if (a?.instructions) parts.push(a.instructions);
  const active = activeSkillsPrompt(Array.isArray(ctx.skills) ? ctx.skills.slice(0, 20) : []);
  if (active) parts.push(active);
  // The day only: a time to the minute would make the engine read everything again every minute.
  parts.push(t('Today is {date}.', { date: new Date().toLocaleDateString(locale(), { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }) }));
  const msgs = Array.isArray(body.messages) ? body.messages : [];
  const sys = parts.join('\n\n');
  if (msgs[0]?.role === 'system' && typeof msgs[0].content === 'string') msgs[0].content = `${sys}\n\n${msgs[0].content}`;
  else msgs.unshift({ role: 'system', content: sys });
  body.messages = msgs;
}

// The loaded models (the default one first), or the last one when none is loaded: apps list them as choices.
function modelsList() {
  const st = engineState();
  const loaded = st.loaded.filter((r) => r.status === 'ready' || r.status === 'starting').sort((a, b) => (b.primary ? 1 : 0) - (a.primary ? 1 : 0));
  const list = loaded.length ? loaded : getSettings().lastModel ? [{ model: getSettings().lastModel, readyAt: 0, ctx: 0 }] : [];
  const data = list.map((r) => {
    const created = Math.floor((r.readyAt || Date.now()) / 1000);
    return { id: modelAlias(r.model), object: 'model', type: 'model', created, created_at: new Date(created * 1000).toISOString(), owned_by: 'hearth', display_name: `${r.model.name}${r.model.quant ? ` ${r.model.quant}` : ''}`, context_length: r.ctx || undefined };
  });
  return { object: 'list', data, has_more: false, first_id: data[0]?.id, last_id: data[data.length - 1]?.id };
}

// Picks numbers out of the engine's answer (streamed or not) for the request log.
function readUsage(r, obj, kind) {
  if (!obj || typeof obj !== 'object') return;
  if (kind === 'anthropic') {
    const u = obj.usage || obj.message?.usage;
    if (u) {
      if (u.input_tokens != null) r.promptTokens = u.input_tokens + (u.cache_read_input_tokens || 0);
      if (u.cache_read_input_tokens != null) r.cachedTokens = u.cache_read_input_tokens;
      if (u.output_tokens != null) r.outputTokens = u.output_tokens;
    }
    if (!r.firstTokenAt && obj.type === 'content_block_delta') r.firstTokenAt = Date.now();
  } else {
    const u = obj.usage;
    if (u) {
      r.promptTokens = u.prompt_tokens ?? u.input_tokens ?? r.promptTokens;
      r.outputTokens = u.completion_tokens ?? u.output_tokens ?? r.outputTokens;
      r.cachedTokens = u.prompt_tokens_details?.cached_tokens ?? r.cachedTokens;
    }
    const d = obj.choices?.[0]?.delta;
    if (!r.firstTokenAt && d && (d.content || d.reasoning_content || d.tool_calls)) r.firstTokenAt = Date.now();
    if (!r.firstTokenAt && obj.type === 'response.output_text.delta') r.firstTokenAt = Date.now();
    if (obj.response?.usage) readUsage(r, { usage: obj.response.usage }, kind);
  }
  const t = obj.timings;
  if (t) {
    if (t.predicted_per_second) r.tokPerSec = t.predicted_per_second;
    if (t.prompt_per_second) r.promptPerSec = t.prompt_per_second;
    if (t.cache_n != null) r.cachedTokens = t.cache_n;
    if (t.predicted_n != null) r.outputTokens = t.predicted_n;
    if (t.prompt_n != null) r.promptTokens = t.prompt_n + (t.cache_n || 0);
  }
}

export async function handleApi(req, res, url) {
  const p = url.pathname.replace(/\/+$/, '');
  const kind = apiKind(p);
  if (!apiAllowed(req)) return sendApiError(res, kind, 401, t('Missing or wrong API key. Find it in Hearth → Connect.'));

  if (req.method === 'GET' && p === '/v1/models') return sendJson(res, 200, modelsList());
  if (req.method === 'GET' && p.startsWith('/v1/models/')) {
    const list = modelsList();
    const want = decodeURIComponent(p.slice('/v1/models/'.length));
    const m = list.data.find((x) => x.id === want) || list.data[0];
    return m ? sendJson(res, 200, m) : sendApiError(res, kind, 404, t('No model loaded'));
  }
  if (req.method !== 'POST') return sendApiError(res, kind, 404, `Unknown endpoint ${req.method} ${p}`);

  let raw;
  try {
    raw = await readBody(req, 256 << 20);
  } catch (err) {
    return sendApiError(res, kind, err.status || 400, err.message);
  }
  let body = null;
  try {
    body = raw.length ? JSON.parse(raw.toString('utf8')) : {};
  } catch {
    return sendApiError(res, kind, 400, t('Body is not valid JSON'));
  }

  const countOnly = p.endsWith('/count_tokens');
  const r = countOnly ? null : beginRequest({ api: kind, path: p, client: clientName(req), stream: Boolean(body.stream) });

  if (!(await ensureEngine(lastModelFinder))) {
    const st = engineState();
    const msg = st.status === 'error' && st.error ? t('The model could not be loaded: {error}', { error: st.error === 'NO_ENGINE' ? t('Hearth needs its engine (llama.cpp) to run models.') : st.error }) : t('No model is loaded. Open Hearth and pick a model.');
    if (r) finishRequest(r, { status: 'error', error: msg });
    return sendApiError(res, kind, 503, msg);
  }

  body = prepareBody(body, kind, req);
  // Several models loaded: the request goes to the one it names; anything else goes to the default one.
  const target = await resolveEngine(typeof body.model === 'string' ? body.model : '');
  if (!target) {
    if (r) finishRequest(r, { status: 'error', error: t('No model is loaded. Open Hearth and pick a model.') });
    return sendApiError(res, kind, 503, t('No model is loaded. Open Hearth and pick a model.'));
  }
  if (r) r.model = target.state.model?.name || '';
  body = target.adapt(body); // in the loaded engine's dialect (Colibri's differs a little from llama.cpp's)
  const controller = new AbortController();
  res.on('close', () => {
    if (!res.writableFinished) controller.abort(); // the app hung up: stop generating
  });

  let upstream;
  try {
    upstream = await fetchLong(`${target.url}${p}${url.search}`, {
      method: 'POST',
      headers: target.headers({ 'content-type': 'application/json', ...(req.headers['anthropic-version'] ? { 'anthropic-version': req.headers['anthropic-version'] } : {}) }),
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    if (r) finishRequest(r, { status: controller.signal.aborted ? 'cancelled' : 'error', error: String(err.message || err) });
    return sendApiError(res, kind, 502, t('The engine did not answer: {error}', { error: err.message || err }));
  }

  const type = upstream.headers.get('content-type') || 'application/json';
  res.writeHead(upstream.status, { 'content-type': type, 'cache-control': 'no-store', ...(type.includes('event-stream') ? { 'x-accel-buffering': 'no' } : {}) });

  if (!type.includes('event-stream')) {
    const text = await upstream.text().catch(() => '');
    res.end(text);
    if (r) {
      let obj = null;
      try {
        obj = JSON.parse(text);
      } catch {}
      readUsage(r, obj, kind);
      finishRequest(r, upstream.ok ? {} : { status: 'error', error: obj?.error?.message || `HTTP ${upstream.status}` });
    }
    return;
  }

  // Stream: pass every byte straight through, and read the numbers on the way.
  const decoder = new TextDecoder();
  let buf = '';
  try {
    for await (const chunk of upstream.body) {
      res.write(chunk);
      if (!r) continue;
      buf += decoder.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        try {
          readUsage(r, JSON.parse(data), kind);
        } catch {}
      }
    }
    res.end();
    if (r) finishRequest(r, upstream.ok ? {} : { status: 'error', error: `HTTP ${upstream.status}` });
  } catch {
    if (r) finishRequest(r, { status: controller.signal.aborted ? 'cancelled' : 'error', error: controller.signal.aborted ? 'Stopped' : 'Stream broke' });
    res.end();
  }
}
