// Monitor page: what the model is doing right now, speed, graphics/processor/memory load, and recent requests.
import { html, useState, useEffect, useRef } from '../vendor/preact-htm.js';
import { Icon } from './icons.js';
import { useStore, api, fmtMem, fmtNum, fmtDec, fmtDuration, modelLabel, copyText } from './store.js';
import { Sparkline, PageHead } from './ui.js';
import { t, tn, locale } from './i18n.js';

const STATES = () => [
  ['idle', t('Idle')],
  ['starting', t('Loading')],
  ['reading', t('Reading')],
  ['generating', t('Generating')],
  ['error', t('Error')],
];
const STATE_TEXT = () => ({
  idle: t('Ready, waiting for a message'),
  starting: t('Loading the model'),
  reading: t('Reading the prompt'),
  generating: t('Writing a reply'),
  error: t('Something went wrong'),
  stopped: t('No model loaded'),
  stopping: t('Stopping'),
});

function Stat({ label, big, unit, detail, spark, max, bar, color }) {
  return html`<div class="card stat">
    <span class="label">${label}</span>
    <span class="big">${big}${unit && html`<small>${unit}</small>`}</span>
    <span class="detail">${detail || ' '}</span>
    ${spark && html`<${Sparkline} values=${spark} max=${max} color=${color} />`}
    ${bar != null && html`<div class="progress ${bar < 0.85 ? '' : ''}"><i style=${{ width: `${Math.min(100, bar * 100)}%`, background: bar > 0.9 ? 'var(--bad)' : bar > 0.75 ? 'var(--warn)' : '' }}></i></div>`}
  </div>`;
}

function Overview({ snap, status }) {
  const { live, stats, history, engine, hardware } = snap;
  const gpu = stats?.gpu;
  const lastDone = snap.requests.find((r) => r.status === 'done' && r.tokPerSec);
  const speedNow = live.state === 'generating' ? live.tokPerSec : 0;
  const ctxFill = live.ctxMax ? live.ctxUsed / live.ctxMax : 0;
  const gpuName = hardware.gpus?.[0]?.name || t('Graphics');
  return html`
    <div class="grid c4">
      <${Stat} label=${t('Speed')} big=${speedNow ? fmtDec(speedNow) : lastDone ? fmtDec(lastDone.tokPerSec) : '–'} unit=${t('tok/s')} detail=${speedNow ? t('now') : lastDone ? t('last reply') : t('no replies yet')} spark=${history.speed} />
      <${Stat} label=${t('Graphics load')} big=${gpu?.util != null ? gpu.util : '–'} unit=${gpu?.util != null ? '%' : ''} detail=${gpuName} spark=${history.gpu} max=${100} color="var(--info)" />
      <${Stat} label=${hardware.unified ? t('Graphics memory (shared)') : t('Graphics memory')} big=${gpu?.memUsed != null ? fmtMem(gpu.memUsed) : '–'} detail=${gpu?.memTotal ? t('of {total} the GPU can use', { total: fmtMem(gpu.memTotal) }) : ''} bar=${gpu?.memUsed != null && gpu?.memTotal ? gpu.memUsed / gpu.memTotal : null} />
      <${Stat} label=${t('Processor')} big=${stats?.cpu ?? '–'} unit=${stats?.cpu != null ? '%' : ''} detail=${tn(hardware.threads, '{n} thread', '{n} threads')} spark=${history.cpu} max=${100} color="var(--warn)" />
      <${Stat} label=${t('System memory')} big=${stats ? fmtMem(stats.ramUsed) : '–'} detail=${stats ? t('of {total}', { total: fmtMem(stats.ramTotal) }) : ''} bar=${stats ? stats.ramUsed / stats.ramTotal : null} />
      <${Stat} label=${t('Context fill')} big=${live.ctxMax ? `${Math.round(ctxFill * 100)}` : '–'} unit=${live.ctxMax ? '%' : ''} detail=${live.ctxMax ? t('{used} of {max} tokens', { used: fmtNum(live.ctxUsed), max: fmtNum(live.ctxMax) }) : t('no model loaded')} bar=${live.ctxMax ? ctxFill : null} />
      <${Stat} label=${t('Engine memory')} big=${stats?.engineMem ? fmtMem(stats.engineMem) : '–'} detail=${engine.model ? modelLabel(engine.model) : ''} />
      ${gpu?.temp != null && Number.isFinite(gpu.temp)
        ? html`<${Stat} label=${t('Graphics temperature')} big=${gpu.temp} unit="°C" detail=${gpu.power ? t('{w} W of {max} W', { w: gpu.power, max: gpu.powerLimit }) : ''} />`
        : html`<${Stat} label=${t('Totals')} big=${fmtNum(snap.totals.requests)} unit=${t('requests')} detail=${t('{read} read · {written} written', { read: fmtNum(snap.totals.promptTokens), written: fmtNum(snap.totals.outputTokens) })} />`}
    </div>
    <div class="section">
      <h2>${t('Recent requests')}</h2>
      <${Requests} requests=${snap.requests.slice(0, 12)} />
    </div>`;
}

function Requests({ requests }) {
  const many = new Set(requests.map((r) => r.model).filter(Boolean)).size > 1;
  if (!requests.length) return html`<div class="card empty">${t('No requests yet. Send a chat message or connect an app.')}</div>`;
  return html`<div class="card" style="overflow-x:auto">
    <table class="table">
      <thead><tr><th>${t('Time')}</th><th>${t('App')}</th><th>API</th><th>${t('Status')}</th><th class="num">${t('Prompt')}</th><th class="num">${t('Reused')}</th><th class="num">${t('Output')}</th><th class="num">${t('tok/s')}</th><th class="num">${t('Duration')}</th></tr></thead>
      <tbody>
        ${requests.map((r) => html`<tr key=${r.id} title=${r.error || r.path}>
          <td>${new Date(r.at).toLocaleTimeString(locale())}</td>
          <td>${r.client === 'Hearth chat' ? t('Hearth chat') : r.client}${r.model && many ? html`<div class="faint" style="font-size:12px">${r.model}</div>` : ''}</td>
          <td class="muted">${r.api === 'anthropic' ? 'Anthropic' : r.path?.includes('responses') ? 'Responses' : 'OpenAI'}</td>
          <td><span class=${`badge ${r.status === 'done' ? 'ok' : r.status === 'running' ? 'accent' : r.status === 'cancelled' ? '' : 'bad'}`}>${{ done: t('Done'), running: t('Running'), error: t('Error'), cancelled: t('Stopped') }[r.status] || r.status}</span></td>
          <td class="num">${fmtNum(r.promptTokens)}</td>
          <td class="num">${fmtNum(r.cachedTokens)}</td>
          <td class="num">${fmtNum(r.outputTokens)}</td>
          <td class="num">${r.tokPerSec ? fmtDec(r.tokPerSec) : '–'}</td>
          <td class="num">${r.status === 'running' ? fmtDuration(Date.now() - r.at) : fmtDuration(r.ms)}</td>
        </tr>`)}
      </tbody>
    </table>
  </div>`;
}

function Logs({ source = 'engine' }) {
  const [logs, setLogs] = useState([]);
  const [follow, setFollow] = useState(true);
  const box = useRef(null);
  useEffect(() => {
    // Hearth's own log is plain lines with the time in front; the engine's is a list of entries.
    const load = () =>
      (source === 'hearth' ? api('/api/logs/hearth?n=600').then((r) => r.lines.map((x) => ({ t: Date.parse(x.slice(0, 24)) || 0, text: x.slice(25), stream: 'out' }))) : api('/api/engine/logs?n=600').then((r) => r.logs))
        .then(setLogs)
        .catch(() => {});
    load();
    const t = setInterval(load, 1500);
    return () => clearInterval(t);
  }, [source]);
  useEffect(() => {
    if (follow && box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [logs, follow]);
  return html`<div>
    <div class="row" style="margin-bottom:10px">
      <span class="muted grow">${source === 'hearth' ? t('Hearth’s own messages: start-up and errors.') : t('The engine’s own messages. Useful when a model won’t load.')}</span>
      <label class="row" style="gap:6px;font-size:14px"><input type="checkbox" checked=${follow} onChange=${(e) => setFollow(e.target.checked)} /> ${t('Follow')}</label>
      <button class="btn sm" onClick=${() => copyText(logs.map((l) => l.text).join('\n'))}><${Icon} name="copy" size="sm" /> ${t('Copy')}</button>
    </div>
    <div class="logbox" ref=${box}>
      ${!logs.length && html`<span class="faint">${t('Nothing yet. Load a model to see the engine start.')}</span>`}
      ${logs.map((l) => html`<div class=${l.stream === 'hearth' ? 'hearth' : ''}><span class="t">${new Date(l.t).toLocaleTimeString(locale())} </span>${l.text}</div>`)}
    </div>
  </div>`;
}

export function MonitorPage() {
  const { status } = useStore();
  const [snap, setSnap] = useState(null);
  const [tab, setTab] = useState('overview');
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const s = await api('/api/monitor');
        if (alive) setSnap(s);
      } catch {}
      if (alive) setTimeout(tick, 1000);
    };
    tick();
    return () => {
      alive = false;
    };
  }, []);
  const live = snap?.live;
  const eng = snap?.engine;
  const state = live?.state || 'stopped';
  const url = status?.urls?.app || '';
  const progress = state === 'reading' && live.promptTokens ? live.promptDone / live.promptTokens : state === 'generating' ? null : null;
  return html`<div class="page"><div class="page-inner">
    <${PageHead} title=${t('Monitor')} text=${t('Watch your model and your computer while it works.')} />
    <div class="card mon-head">
      <span class="live-pill"><span class=${`dot ${state === 'idle' ? 'ready' : state}`}></span>${STATE_TEXT()[state] || state}${state === 'reading' && progress != null ? ` · ${Math.round(progress * 100)}%` : ''}${state === 'generating' && live.decoded ? ` · ${tn(live.decoded, '{n} token', '{n} tokens', { n: fmtNum(live.decoded) })}` : ''}</span>
      <span class="grow"></span>
      ${eng?.model && html`<span class="muted">${modelLabel(eng.model)}${eng.ctx ? ` · ${Math.round(eng.ctx / 1024)}K` : ''}</span>`}
      <span class="url">${url}</span>
      <span class="badge accent">${t('LIVE')}</span>
    </div>
    <div style="margin:16px 0 18px">
      <div class="state-bar">${STATES().map(([k, l]) => html`<span class=${`${state === k ? `on ${k}` : ''}`}>${l}</span>`)}</div>
      <div class="progress" style="height:8px"><i style=${{ width: `${state === 'reading' && progress != null ? progress * 100 : state === 'generating' ? 100 : state === 'idle' ? 0 : 0}%`, opacity: state === 'generating' ? 0.55 : 1 }}></i></div>
    </div>
    <div class="tabs">
      <button class=${tab === 'overview' ? 'on' : ''} onClick=${() => setTab('overview')}><${Icon} name="gauge" size="sm" /> ${t('Overview')}</button>
      <button class=${tab === 'requests' ? 'on' : ''} onClick=${() => setTab('requests')}><${Icon} name="activity" size="sm" /> ${t('Requests')}</button>
      <button class=${tab === 'logs' ? 'on' : ''} onClick=${() => setTab('logs')}><${Icon} name="terminal" size="sm" /> ${t('Engine log')}</button>
      <button class=${tab === 'hearth' ? 'on' : ''} onClick=${() => setTab('hearth')}><${Icon} name="file-text" size="sm" /> ${t('Hearth log')}</button>
    </div>
    ${!snap
      ? html`<div class="card empty"><${Icon} name="loader" cls="spin" /> ${t('Reading…')}</div>`
      : tab === 'overview'
        ? html`<${Overview} snap=${snap} status=${status} />`
        : tab === 'requests'
          ? html`<${Requests} requests=${snap.requests} />`
          : html`<${Logs} key=${tab} source=${tab === 'hearth' ? 'hearth' : 'engine'} />`}
  </div></div>`;
}
