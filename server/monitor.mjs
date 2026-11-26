// Live numbers for the Monitor page: what the model is doing, speed, memory, and recent requests.
import { engineState, engineUrl, engineHeaders } from './engine.mjs';
import { detectHardware, liveStats } from './hardware.mjs';

const HISTORY = 90; // seconds of sparkline
const history = { speed: [], prompt: [], gpu: [], gpuMem: [], cpu: [], ram: [] };
const requests = [];
const totals = { requests: 0, promptTokens: 0, outputTokens: 0, since: Date.now() };

let live = { state: 'stopped', decoded: 0, promptTokens: 0, promptDone: 0, ctxUsed: 0, ctxMax: 0, tokPerSec: 0 };
let stats = null;
let lastDecoded = null;
let lastAt = 0;
let timer = null;
let lastWanted = 0;

function push(arr, v) {
  arr.push(v ?? null);
  if (arr.length > HISTORY) arr.shift();
}

async function sample() {
  const hw = await detectHardware();
  const eng = engineState();
  stats = await liveStats(hw, eng.pid);
  let next = { state: eng.status === 'ready' ? 'idle' : eng.status, decoded: 0, promptTokens: 0, promptDone: 0, ctxUsed: 0, ctxMax: eng.ctx, tokPerSec: 0 };
  const url = engineUrl();
  if (url && eng.engine?.kind === 'colibri') {
    // Colibri has no /slots: its health check says whether it is answering, and how many wait.
    try {
      const sc = (await (await fetch(`${url}/health`, { headers: engineHeaders(), signal: AbortSignal.timeout(1500) })).json())?.scheduler || {};
      if (sc.active > 0) next.state = 'generating';
      if (sc.queued > 0) next.queued = sc.queued;
      const recent = requests.find((r) => r.status === 'done');
      next.ctxUsed = recent ? recent.promptTokens + recent.outputTokens : 0;
    } catch {}
  } else if (url) {
    try {
      const slots = await (await fetch(`${url}/slots`, { headers: engineHeaders(), signal: AbortSignal.timeout(1500) })).json();
      const busy = slots.filter((s) => s.is_processing);
      const s = busy[0];
      if (s) {
        const decoded = s.next_token?.[0]?.n_decoded ?? 0;
        const prompt = s.n_prompt_tokens ?? 0;
        const processed = (s.n_prompt_tokens_processed ?? 0) + (s.n_prompt_tokens_cache ?? 0);
        next = { ...next, state: decoded > 0 ? 'generating' : 'reading', decoded, promptTokens: prompt, promptDone: Math.min(processed, prompt), ctxUsed: prompt + decoded };
        const now = Date.now();
        if (lastDecoded !== null && decoded >= lastDecoded && now > lastAt) next.tokPerSec = ((decoded - lastDecoded) * 1000) / (now - lastAt);
        lastDecoded = decoded;
        lastAt = now;
      } else {
        lastDecoded = null;
        const recent = requests.find((r) => r.status === 'done');
        next.ctxUsed = recent ? recent.promptTokens + recent.outputTokens : 0;
      }
      if (busy.length > 1) next.queued = busy.length - 1;
    } catch {}
  }
  live = next;
  push(history.speed, next.state === 'generating' ? Math.round(next.tokPerSec * 10) / 10 : 0);
  push(history.gpu, stats.gpu?.util ?? null);
  push(history.gpuMem, stats.gpu?.memUsed ?? null);
  push(history.cpu, stats.cpu);
  push(history.ram, stats.ramUsed);
}

// Sample every second only while someone is watching (the Monitor page polls), then go quiet. Requests don't wake
// it: reading the computer's load costs processor time (on Windows a PowerShell), which would slow every answer.
function wake() {
  lastWanted = Date.now();
  if (timer) return;
  timer = setInterval(() => {
    if (Date.now() - lastWanted > 15000) {
      clearInterval(timer);
      timer = null;
      return;
    }
    sample().catch(() => {});
  }, 1000);
  sample().catch(() => {});
}

export async function monitorSnapshot() {
  wake();
  if (!stats) await sample().catch(() => {});
  const hw = await detectHardware();
  return { live, stats, history, requests: requests.slice(0, 60), totals, engine: engineState(), hardware: { gpus: hw.gpus, backend: hw.backend, ram: hw.ram, unified: hw.unified, gpuBudget: hw.gpuBudget, cpuName: hw.cpuName, threads: hw.threads } };
}

// ---- Request log (filled in by the API proxy) ----

export function beginRequest(info) {
  const r = {
    id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    at: Date.now(),
    status: 'running',
    api: info.api,
    path: info.path,
    client: info.client,
    stream: info.stream,
    promptTokens: 0,
    cachedTokens: 0,
    outputTokens: 0,
    tokPerSec: 0,
    promptPerSec: 0,
    ms: 0,
    error: '',
  };
  requests.unshift(r);
  if (requests.length > 200) requests.length = 200;
  totals.requests++;
  return r;
}

export function finishRequest(r, result = {}) {
  Object.assign(r, result);
  r.ms = Date.now() - r.at;
  if (!r.tokPerSec && r.outputTokens && r.firstTokenAt) r.tokPerSec = (r.outputTokens * 1000) / Math.max(1, Date.now() - r.firstTokenAt);
  // No timings in the answer (some non-streamed formats): whole time incl. reading, so a slight underestimate.
  if (!r.tokPerSec && r.outputTokens && r.ms) r.tokPerSec = (r.outputTokens * 1000) / r.ms;
  delete r.firstTokenAt;
  if (r.status === 'running') r.status = 'done';
  totals.promptTokens += r.promptTokens || 0;
  totals.outputTokens += r.outputTokens || 0;
}

// Answers the model is giving now (chats, apps, bots, batches): the computer shouldn't fall asleep in the middle of one.
// A request older than three hours that never finished doesn't count.
export function busyRequests(now = Date.now()) {
  return requests.filter((r) => r.status === 'running' && now - r.at < 3 * 3600e3).length;
}

// Short, human name for the app that sent a request.
export function clientName(req) {
  const own = req.headers['x-hearth-client'];
  if (own) return own === 'chat' ? 'Hearth chat' : String(own).slice(0, 30);
  const ua = String(req.headers['user-agent'] || '');
  const known = [
    [/claude-cli|claude-code/i, 'Claude Code'],
    [/codex/i, 'Codex'],
    [/opencode/i, 'OpenCode'],
    [/cline/i, 'Cline'],
    [/continue/i, 'Continue'],
    [/cursor/i, 'Cursor'],
    [/openwebui|open-webui/i, 'Open WebUI'],
    [/^OpenAI\/Python/i, 'OpenAI Python'],
    [/^OpenAI\/JS/i, 'OpenAI JS'],
    [/^Anthropic\/Python/i, 'Anthropic Python'],
    [/^Anthropic\/JS/i, 'Anthropic JS'],
    [/^curl/i, 'curl'],
    [/python-requests|httpx|aiohttp/i, 'Python'],
  ];
  for (const [re, name] of known) if (re.test(ua)) return name;
  return ua.split(/[\s/]/)[0].slice(0, 24) || 'App';
}
