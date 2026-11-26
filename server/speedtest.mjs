// A quick, repeatable speed check of one model with its saved settings: it reads an order list of about 2,000
// tokens and writes up to 256. The prompt starts with a new number each time, so nothing comes from the cache.
import { startEngine, resolveEngine, modelAlias, engineState, loadedWithSettings, explainEngineError } from './engine.mjs';
import { recordSpeedTest, getModelSettings } from './model-settings.mjs';
import { beginRequest, finishRequest } from './monitor.mjs';
import { uid } from './util.mjs';
import { t } from './i18n.mjs';

function orders() {
  const items = ['T-shirt', 'hoodie', 'cap', 'tote bag', 'mug', 'sticker pack', 'poster', 'sweatshirt'];
  const colors = ['black', 'white', 'navy', 'red', 'sand', 'forest green', 'heather grey'];
  const lines = [];
  for (let i = 1; i <= 90; i++) {
    lines.push(`Order ${1000 + i * 7}: ${items[i % items.length]}, ${colors[(i * 3) % colors.length]}, size ${['S', 'M', 'L', 'XL'][i % 4]}, quantity ${((i * 13) % 40) + 1}, print on the ${['front', 'back', 'sleeve'][i % 3]}, due in ${(i % 9) + 2} days.`);
  }
  return lines.join('\n');
}

export async function speedTest(model) {
  const t0 = Date.now();
  // The model runs with the settings saved for it now (it loads or reloads if needed), so the result belongs to them.
  if (!loadedWithSettings(model)) await startEngine(model);
  const target = await resolveEngine(model.id);
  if (!target || target.id !== model.id) throw Object.assign(new Error(engineState().error || t('The model could not be loaded.')), { status: 409 });
  const loadMs = Date.now() - t0;
  const body = {
    model: modelAlias(model),
    messages: [{ role: 'user', content: `Check ${uid(8)}. These are this week's orders:\n\n${orders()}\n\nWrite a short report: how many orders there are of each item, and which ones are due first.` }],
    max_tokens: 256,
    temperature: 0,
    cache_prompt: false,
    chat_template_kwargs: { enable_thinking: false },
  };
  const colibri = target.kind === 'colibri';
  const req = beginRequest({ api: 'openai', path: '/v1/chat/completions', client: t('Speed test'), stream: colibri });
  let m;
  try {
    m = colibri ? await measureStreamed(target, body) : await measureTimed(target, body);
  } catch (err) {
    finishRequest(req, { status: 'error', error: String(err.message || err) });
    if (err.name === 'TimeoutError') throw err;
    if (err.engineError !== undefined) throw new Error(explainEngineError(err.engineError) || err.message);
    throw new Error(t('The model was reloaded or stopped during the test. Run the test again.'));
  }
  finishRequest(req, { status: 'done', promptTokens: m.promptTokens, outputTokens: m.outputTokens, tokPerSec: m.write, promptPerSec: m.read });
  const { lastTest, tests, ...settings } = getModelSettings(model.id);
  const result = { at: Date.now(), engine: colibri ? 'colibri' : 'llama', read: m.read, write: m.write, promptTokens: m.promptTokens, outputTokens: m.outputTokens, loadMs: loadMs > 500 ? loadMs : 0, settings };
  recordSpeedTest(model.id, result);
  return result;
}

const failed = (status, j) => Object.assign(new Error(j?.error?.message || t('The model answered with an error ({status}).', { status })), { engineError: j?.error?.message || '' });

// llama.cpp times its own reading and writing (its `timings`).
async function measureTimed(target, body) {
  const res = await fetch(`${target.url}/v1/chat/completions`, { method: 'POST', headers: target.headers({ 'content-type': 'application/json' }), body: JSON.stringify(target.adapt(body)), signal: AbortSignal.timeout(10 * 60e3) });
  const j = await res.json().catch(() => null);
  if (!res.ok) throw failed(res.status, j);
  const tm = j?.timings || {};
  return { read: tm.prompt_per_second || 0, write: tm.predicted_per_second || 0, promptTokens: tm.prompt_n || 0, outputTokens: tm.predicted_n || 0 };
}

// Colibri gives counts only, so the answer is streamed and timed here: reading is the prompt over the time to the
// first word, writing the words after it over the time they took. Round trips on this computer cost microseconds.
async function measureStreamed(target, body) {
  const t0 = performance.now();
  const res = await fetch(`${target.url}/v1/chat/completions`, { method: 'POST', headers: target.headers({ 'content-type': 'application/json' }), body: JSON.stringify(target.adapt({ ...body, stream: true, stream_options: { include_usage: true } })), signal: AbortSignal.timeout(10 * 60e3) });
  if (!res.ok) throw failed(res.status, await res.json().catch(() => null));
  let first = 0;
  let last = 0;
  let chunks = 0;
  let usage = null;
  let buf = '';
  const dec = new TextDecoder();
  for await (const part of res.body) {
    buf += dec.decode(part, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line.startsWith('data:') || line === 'data: [DONE]') continue;
      let j;
      try {
        j = JSON.parse(line.slice(5));
      } catch {
        continue;
      }
      if (j.usage) usage = j.usage;
      const d = j.choices?.[0]?.delta;
      if (d && (d.content || d.reasoning_content)) {
        const now = performance.now();
        if (!first) first = now;
        last = now;
        chunks++;
      }
    }
  }
  const promptTokens = usage?.prompt_tokens || 0;
  const outputTokens = usage?.completion_tokens || chunks;
  const read = first ? (promptTokens * 1000) / Math.max(1, first - t0) : 0;
  const write = outputTokens > 1 && last > first ? ((outputTokens - 1) * 1000) / (last - first) : 0;
  return { read, write, promptTokens, outputTokens };
}
