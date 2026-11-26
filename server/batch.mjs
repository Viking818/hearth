// Batch jobs: one instruction for many photos or texts, answered as rows of a table (e.g. title, description and
// tags for 50 product photos). Jobs run here, one item at a time, so they go on when the window is closed.
import fs from 'node:fs';
import path from 'node:path';
import { DIRS } from './settings.mjs';
import { readJson, writeJson, uid } from './util.mjs';
import { engineState, ensureEngine, resolveEngine, explainEngineError } from './engine.mjs';
import { listLocalModels } from './models.mjs';
import { beginRequest, finishRequest } from './monitor.mjs';
import { t } from './i18n.mjs';

const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };
const fileOf = (id) => path.join(DIRS.batches, `${id}.json`);
const safeId = (id) => /^[\w-]{4,40}$/.test(String(id || ''));

let running = null; // { id, controller }
const queue = [];

export function listBatches() {
  const out = [];
  for (const f of fs.readdirSync(DIRS.batches)) {
    if (!f.endsWith('.json')) continue;
    const j = readJson(path.join(DIRS.batches, f), null);
    if (!j?.id) continue;
    const done = j.items.filter((i) => i.status === 'done').length;
    out.push({ id: j.id, title: j.title, status: j.status, total: j.items.length, done, failed: j.items.filter((i) => i.status === 'error').length, createdAt: j.createdAt, updatedAt: j.updatedAt });
  }
  return out.sort((a, b) => b.createdAt - a.createdAt);
}

export function getBatch(id) {
  return safeId(id) ? readJson(fileOf(id), null) : null;
}

function save(job) {
  job.updatedAt = Date.now();
  writeJson(fileOf(job.id), job);
}

export function createBatch(body) {
  const fields = (Array.isArray(body.fields) ? body.fields : [])
    .map((f) => ({ name: String(f.name || '').trim().slice(0, 60), hint: String(f.hint || '').trim().slice(0, 300) }))
    .filter((f) => f.name);
  if (!fields.length) throw Object.assign(new Error(t('Add at least one column.')), { status: 400 });
  if (new Set(fields.map((f) => f.name.toLowerCase())).size !== fields.length) throw Object.assign(new Error(t('Column names must be different.')), { status: 400 });
  const items = (Array.isArray(body.items) ? body.items : []).slice(0, 2000).map((it) => ({
    id: uid(8),
    name: String(it.name || '').slice(0, 200),
    kind: it.kind === 'image' ? 'image' : 'text',
    url: it.kind === 'image' ? String(it.url || '') : '',
    text: it.kind === 'image' ? '' : String(it.text || '').slice(0, 200000),
    status: 'waiting',
    result: {},
    error: '',
  }));
  if (!items.length) throw Object.assign(new Error(t('Add photos or files first.')), { status: 400 });
  const instruction = String(body.instruction || '').trim().slice(0, 8000);
  if (!instruction) throw Object.assign(new Error(t('Write what to do with each item.')), { status: 400 });
  const job = { id: uid(10), title: String(body.title || '').trim().slice(0, 120) || instruction.slice(0, 60), instruction, fields, items, status: 'queued', error: '', createdAt: Date.now(), updatedAt: Date.now() };
  save(job);
  enqueue(job.id);
  return job;
}

export function stopBatch(id) {
  const job = getBatch(id);
  if (!job) return null;
  const qi = queue.indexOf(id);
  if (qi >= 0) queue.splice(qi, 1);
  if (running?.id === id) running.controller.abort();
  if (job.status === 'running' || job.status === 'queued') {
    job.status = 'stopped';
    for (const it of job.items) if (it.status === 'working') it.status = 'waiting';
    save(job);
  }
  return job;
}

// Run the waiting and failed items again (or just the failed ones).
export function resumeBatch(id, { failedOnly = false } = {}) {
  const job = getBatch(id);
  if (!job) return null;
  for (const it of job.items) {
    if (it.status === 'error' || (!failedOnly && it.status !== 'done')) {
      it.status = 'waiting';
      it.error = '';
    }
  }
  job.status = 'queued';
  save(job);
  enqueue(id);
  return job;
}

export function editBatchCell(id, itemId, field, value) {
  const job = getBatch(id);
  const it = job?.items.find((i) => i.id === itemId);
  if (!it) throw Object.assign(new Error(t('Not found')), { status: 404 });
  it.result = { ...it.result, [field]: String(value ?? '').slice(0, 20000) };
  it.edited = true;
  save(job);
  return it;
}

export function deleteBatch(id) {
  stopBatch(id);
  if (safeId(id)) fs.rmSync(fileOf(id), { force: true });
}

function enqueue(id) {
  if (!queue.includes(id) && running?.id !== id) queue.push(id);
  if (!running) next();
}

async function next() {
  const id = queue.shift();
  if (!id) return;
  const controller = new AbortController();
  running = { id, controller };
  try {
    await runJob(id, controller.signal);
  } catch {}
  running = null;
  next();
}

function lastModelFinder(last) {
  const list = listLocalModels(true);
  return list.find((m) => m.id === last.id) || list.find((m) => m.path === last.path) || null;
}

async function runJob(id, signal) {
  let job = getBatch(id);
  if (!job) return;
  job.status = 'running';
  job.error = '';
  save(job);
  if (!(await ensureEngine(lastModelFinder))) {
    job = getBatch(id);
    job.status = 'error';
    job.error = t('No model is loaded. Open Hearth and pick a model.');
    save(job);
    return;
  }
  for (;;) {
    if (signal.aborted) return;
    job = getBatch(id);
    if (!job || job.status !== 'running') return;
    const it = job.items.find((i) => i.status === 'waiting');
    if (!it) break;
    it.status = 'working';
    save(job);
    const t0 = Date.now();
    try {
      it.result = await runItem(job, it, signal);
      it.status = 'done';
      it.error = '';
    } catch (err) {
      if (signal.aborted) return;
      it.status = 'error';
      it.error = String(err.message || err).slice(0, 500);
    }
    it.ms = Date.now() - t0;
    const fresh = getBatch(id);
    if (!fresh || fresh.status !== 'running') return; // stopped or deleted meanwhile
    fresh.items = fresh.items.map((x) => (x.id === it.id ? it : x));
    save(fresh);
  }
  job = getBatch(id);
  if (job && job.status === 'running') {
    job.status = 'done';
    save(job);
  }
}

function imagePart(url) {
  const m = /^\/uploads\/([\w.-]+)$/.exec(url || '');
  if (!m) throw new Error(t('The photo is missing.'));
  const file = path.join(DIRS.uploads, path.basename(m[1]));
  const mime = MIME[path.extname(file).toLowerCase()];
  if (!mime || !fs.existsSync(file)) throw new Error(t('The photo is missing.'));
  return { type: 'image_url', image_url: { url: `data:${mime};base64,${fs.readFileSync(file).toString('base64')}` } };
}

async function runItem(job, it, signal) {
  const keys = job.fields.map((f) => f.name);
  const system =
    'You fill in one row of a table for each item the user gives you. Follow the user’s instruction for every column. ' +
    'Answer with a JSON object that has exactly these keys and string values: ' +
    job.fields.map((f) => `"${f.name}"${f.hint ? ` (${f.hint})` : ''}`).join(', ') +
    '. Write the values in the language of the instruction. Never invent facts you cannot see or read; leave a value empty if it cannot be known.';
  const intro = `${job.instruction}\n\n${it.name ? `Item: ${it.name}\n` : ''}`;
  const content = it.kind === 'image' ? [{ type: 'text', text: intro }, imagePart(it.url)] : `${intro}\n${it.text}`;
  if (it.kind === 'image' && !engineState().vision) throw new Error(t('The loaded model can’t see images. Load one that does (Models → “sees images”).'));
  const body = {
    model: 'local',
    messages: [
      { role: 'system', content: system },
      { role: 'user', content },
    ],
    stream: false,
    temperature: 0.4,
    // DRY stops loops like "ocean, ocean, ocean" in tag lists without touching the JSON punctuation.
    dry_multiplier: 0.8,
    max_tokens: 2000,
    chat_template_kwargs: { enable_thinking: false },
    response_format: {
      type: 'json_schema',
      json_schema: { name: 'row', strict: true, schema: { type: 'object', properties: Object.fromEntries(keys.map((k) => [k, { type: 'string' }])), required: keys, additionalProperties: false } },
    },
  };
  const r = beginRequest({ api: 'openai', path: '/v1/chat/completions', client: t('Batch'), stream: false });
  let res;
  try {
    const target = await resolveEngine('');
    if (!target) throw new Error(t('No model is loaded. Open Hearth and pick a model.'));
    res = await fetch(`${target.url}/v1/chat/completions`, { method: 'POST', headers: target.headers({ 'content-type': 'application/json' }), body: JSON.stringify(target.adapt(body)), signal });
  } catch (err) {
    finishRequest(r, { status: signal.aborted ? 'cancelled' : 'error', error: String(err.message || err) });
    throw err;
  }
  const j = await res.json().catch(() => null);
  const tm = j?.timings || {};
  finishRequest(r, { status: res.ok ? 'done' : 'error', promptTokens: (tm.prompt_n || 0) + (tm.cache_n || 0), cachedTokens: tm.cache_n || 0, outputTokens: tm.predicted_n || j?.usage?.completion_tokens || 0, tokPerSec: tm.predicted_per_second || 0, error: res.ok ? '' : j?.error?.message || `HTTP ${res.status}` });
  if (!res.ok) throw new Error(explainEngineError(j?.error?.message) || t('The model answered with an error ({status}).', { status: res.status }));
  const text = j?.choices?.[0]?.message?.content || '';
  let obj;
  try {
    obj = JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, ''));
  } catch {
    throw new Error(t('The model did not answer in the table format. Try again or simplify the columns.'));
  }
  const out = {};
  for (const k of keys) {
    const v = obj[k];
    out[k] = Array.isArray(v) ? v.join(', ') : v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
  }
  return out;
}

export function batchRunning() {
  return running?.id || '';
}

// Jobs that were running when Hearth closed carry on when it starts again.
export function resumeUnfinished() {
  for (const b of listBatches()) if (b.status === 'running' || b.status === 'queued') resumeBatch(b.id);
}

