// Bots page: helpers that work on their own on this computer. Give one a task, put it on a schedule, or write to it
// in Telegram. The work runs in Hearth (server/agent.mjs), so it goes on when this window is closed.
import { html, useState, useEffect, useRef, useMemo } from '../vendor/preact-htm.js';
import { Icon } from './icons.js';
import { t, tn, locale } from './i18n.js';
import { api, toast, toastError, go, fmtDuration, copyText, refreshBots } from './store.js';
import { confirmDialog, PageHead, Toggle } from './ui.js';
import { renderMarkdown } from './md.js';
import { QrCode } from './settings.js';

const EMOJIS = ['🤖', '💬', '☀️', '🔎', '🏷️', '✨', '🎨', '👕', '📦', '📈', '🧾', '🛒', '📣', '🧠', '📅', '✉️', '🗂️', '💡'];
const STATUS = () => ({ new: t('New'), queued: t('Waiting'), running: t('Working'), done: t('Done'), stopped: t('Stopped'), error: t('Failed') });
const BADGE = { queued: '', running: 'accent', done: 'ok', stopped: 'warn', error: 'bad' };
const SOURCE_ICON = { app: 'message-square', schedule: 'clock', telegram: 'smartphone' };

const dayName = (d) => new Date(2026, 10, 8 + d).toLocaleDateString(locale(), { weekday: 'short' }); // 9 Nov 2026 is a Monday

function when(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const today = new Date().toDateString() === d.toDateString();
  return today ? d.toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' }) : d.toLocaleString(locale(), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

export function scheduleText(s) {
  if (s.every) return s.every === 1 ? t('Every hour') : t('Every {n} hours', { n: s.every });
  const d = s.days || [];
  if (d.length === 7) return t('Every day at {time}', { time: s.time });
  if (d.join() === '1,2,3,4,5') return t('On weekdays at {time}', { time: s.time });
  if (d.join() === '6,7') return t('On weekends at {time}', { time: s.time });
  return t('{days} at {time}', { days: d.map(dayName).join(', '), time: s.time });
}

// ---------------- The list of bots ----------------

function NewBotDialog({ templates, onClose }) {
  const [busy, setBusy] = useState('');
  const make = async (id) => {
    setBusy(id);
    try {
      const b = await api('/api/bots', { method: 'POST', body: { template: id } });
      onClose();
      go(`#/bots/${b.id}`);
    } catch (err) {
      toastError(err);
    }
    setBusy('');
  };
  return html`<div class="overlay" onMouseDown=${(e) => e.target === e.currentTarget && onClose()}>
    <div class="dialog wide">
      <h3>${t('New bot')}</h3>
      <p class="muted" style="margin:0">${t('Start from a ready-made bot; you can change everything afterwards.')}</p>
      <${Templates} templates=${templates} busy=${busy} onPick=${make} />
      <div class="row" style="justify-content:flex-end"><button class="btn" onClick=${onClose}>${t('Cancel')}</button></div>
    </div>
  </div>`;
}

function Templates({ templates, busy, onPick }) {
  return html`<div class="tpl-grid">
    ${templates.map(
      (x) => html`<button class="tpl" key=${x.id} disabled=${Boolean(busy)} onClick=${() => onPick(x.id)}>
        <span class="bot-emoji sm">${busy === x.id ? html`<${Icon} name="loader" cls="spin" />` : x.emoji}</span>
        <span class="grow" style="min-width:0">
          <b>${x.name}</b>
          <span>${x.description}</span>
          ${(x.schedules > 0 || x.telegram) && html`<span class="tpl-tags">${x.schedules > 0 && html`<span><${Icon} name="clock" size="sm" /> ${t('on a schedule')}</span>`}${x.telegram && html`<span><${Icon} name="smartphone" size="sm" /> ${t('for Telegram')}</span>`}</span>`}
        </span>
      </button>`,
    )}
  </div>`;
}

function BotsHome() {
  const [data, setData] = useState(null);
  const [picking, setPicking] = useState(false);
  const load = () => api('/api/bots').then(setData).catch(toastError);
  useEffect(() => {
    load();
    const timer = setInterval(load, 4000);
    return () => clearInterval(timer);
  }, []);
  if (!data) return html`<div class="page"><div class="page-inner"><div class="card empty"><${Icon} name="loader" cls="spin" /></div></div></div>`;
  const { bots, templates } = data;
  return html`<div class="page"><div class="page-inner">
    <${PageHead} title=${t('Bots')} text=${t('Helpers that work on their own: give one a task, put it on a schedule, or write to it in Telegram. They run on this computer, also with this window closed.')}>
      ${bots.length > 0 && html`<button class="btn primary" onClick=${() => setPicking(true)}><${Icon} name="plus" size="sm" /> ${t('New bot')}</button>`}
    <//>
    ${bots.length === 0
      ? html`<div class="card pad col" style="gap:14px">
          <div class="row" style="gap:14px;align-items:flex-start"><span class="bot-emoji">🤖</span><div><b style="font-size:16px">${t('Your first bot')}</b><p class="muted" style="margin:4px 0 0">${t('A bot takes a task and does it step by step: it searches the web, reads and writes files, and gives you the result. It can work on a schedule and answer in Telegram. Pick one to start:')}</p></div></div>
          <${Templates} templates=${templates} busy="" onPick=${async (id) => {
            try {
              const b = await api('/api/bots', { method: 'POST', body: { template: id } });
              go(`#/bots/${b.id}`);
            } catch (err) {
              toastError(err);
            }
          }} />
        </div>`
      : html`<div class="bot-grid">
          ${bots.map(
            (b) => html`<a class="card bot-card" href=${`#/bots/${b.id}`} key=${b.id}>
              <div class="row" style="gap:12px">
                <span class="bot-emoji">${b.emoji}</span>
                <div class="grow" style="min-width:0"><b class="ellipsis" style="display:block;font-size:15.5px">${b.name}</b><span class="desc">${b.description}</span></div>
                ${b.unread > 0 && html`<span class="badge accent" title=${t('New results')}>${b.unread}</span>`}
              </div>
              <div class="bot-chips">
                ${b.working ? html`<span class="badge accent"><${Icon} name="loader" cls="spin" /> ${t('Working')}</span>` : html`<span class="badge">${t('Free')}</span>`}
                ${b.schedules?.some((s) => s.on) && html`<span class="badge"><${Icon} name="clock" /> ${scheduleText(b.schedules.find((s) => s.on))}</span>`}
                ${b.telegram?.connected && html`<span class=${`badge ${b.telegram.error ? 'bad' : ''}`}><${Icon} name="smartphone" /> @${b.telegram.username}</span>`}
              </div>
              ${b.last && html`<div class="muted ellipsis" style="font-size:13px">${t('Last task')}: ${b.last.title} · ${when(b.last.updatedAt)}</div>`}
            </a>`,
          )}
        </div>`}
    ${picking && html`<${NewBotDialog} templates=${templates} onClose=${() => setPicking(false)} />`}
  </div></div>`;
}

// ---------------- One bot ----------------

export function BotsPage({ route }) {
  return route.id ? html`<${BotPage} id=${route.id} key=${route.id} />` : html`<${BotsHome} />`;
}

function BotPage({ id }) {
  const [data, setData] = useState(null);
  const [tab, setTab] = useState('tasks');
  const [sel, setSel] = useState('');
  const busy = data && (data.activity.running?.botId === id || data.tasks.some((k) => k.status === 'queued'));
  const load = () =>
    api(`/api/bots/${id}`)
      .then((d) => {
        setData(d);
        refreshBots();
      })
      .catch((err) => {
        toastError(err);
        go('#/bots');
      });
  useEffect(() => {
    load();
  }, [id]);
  useEffect(() => {
    const timer = setInterval(load, busy ? 2000 : 6000);
    return () => clearInterval(timer);
  }, [id, busy]);
  if (!data) return html`<div class="page"><div class="page-inner"><div class="card empty"><${Icon} name="loader" cls="spin" /></div></div></div>`;
  const { bot, tasks } = data;
  const working = data.activity.running?.botId === id;
  const onTabs = [
    ['tasks', t('Tasks'), tasks.length],
    ['schedule', t('Schedule'), bot.schedules.length],
    ['telegram', 'Telegram', bot.telegram.connected ? '✓' : ''],
    ['settings', t('Settings'), ''],
  ];
  return html`<div class="page"><div class="page-inner">
    <div class="page-head" style="align-items:center">
      <div class="row" style="gap:14px;min-width:0">
        <button class="icon-btn" title=${t('All bots')} onClick=${() => go('#/bots')}><${Icon} name="chevron-left" /></button>
        <span class="bot-emoji">${bot.emoji}</span>
        <div style="min-width:0"><h1 style="margin:0" class="ellipsis">${bot.name}</h1>${bot.description && html`<p class="ellipsis">${bot.description}</p>`}</div>
      </div>
      <div class="row wrap">
        ${working ? html`<span class="badge accent"><${Icon} name="loader" cls="spin" /> ${t('Working')}</span>` : html`<span class="badge">${t('Free')}</span>`}
        ${data.onComputer && html`<button class="btn sm" onClick=${() => api(`/api/bots/${id}/open`, { method: 'POST', body: {} }).catch(toastError)}><${Icon} name="folder" size="sm" /> ${t('Open its folder')}</button>`}
      </div>
    </div>
    <div class="tabs">${onTabs.map(([k, label, n]) => html`<button class=${tab === k ? 'on' : ''} onClick=${() => setTab(k)}>${label}${n !== '' && n !== 0 ? html` <span class="tab-count">${n}</span>` : ''}</button>`)}</div>
    ${tab === 'tasks' && html`<${TasksTab} data=${data} sel=${sel || tasks[0]?.id || ''} setSel=${setSel} reload=${load} />`}
    ${tab === 'schedule' && html`<${ScheduleTab} bot=${bot} reload=${load} onRun=${(taskId) => { setSel(taskId); setTab('tasks'); load(); }} />`}
    ${tab === 'telegram' && html`<${TelegramTab} bot=${bot} reload=${load} />`}
    ${tab === 'settings' && html`<${SettingsTab} data=${data} reload=${load} />`}
  </div></div>`;
}

// ---------------- Tasks ----------------

function Composer({ placeholder, button, onSend, autoFocus }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const send = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    try {
      await onSend(text.trim());
      setText('');
    } catch (err) {
      toastError(err);
    }
    setBusy(false);
  };
  return html`<div class="bot-composer">
    <textarea class="textarea" rows="2" value=${text} placeholder=${placeholder} autofocus=${autoFocus} onInput=${(e) => setText(e.target.value)} onKeyDown=${(e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        send();
      }
    }}></textarea>
    <div class="row"><span class="grow faint" style="font-size:12.5px"><span class="kbd">Ctrl</span>+<span class="kbd">Enter</span></span><button class="btn primary" disabled=${busy || !text.trim()} onClick=${send}><${Icon} name=${busy ? 'loader' : 'play'} cls=${busy ? 'spin' : ''} size="sm" /> ${button}</button></div>
  </div>`;
}

function TasksTab({ data, sel, setSel, reload }) {
  const { bot, tasks } = data;
  const start = async (text) => {
    const k = await api(`/api/bots/${bot.id}/tasks`, { method: 'POST', body: { text } });
    setSel(k.id);
    reload();
  };
  return html`<div class="col" style="gap:16px">
    <div class="card pad"><${Composer} placeholder=${t('What should the bot do? For example: find 10 ideas for winter T-shirt prints and save them as a table.')} button=${t('Start')} onSend=${start} autoFocus=${!tasks.length} /></div>
    ${tasks.length > 0 &&
    html`<div class="bot-layout">
      <div class="card list task-list">
        ${tasks.map(
          (k) => html`<button class=${`list-row ${k.id === sel ? 'active' : ''}`} key=${k.id} onClick=${() => setSel(k.id)}>
            <${Icon} name=${SOURCE_ICON[k.source] || 'message-square'} size="sm" />
            <span class="grow" style="min-width:0;text-align:left">
              <span class="ellipsis" style="display:block;font-weight:550">${k.title}</span>
              <span class="muted" style="font-size:12.5px">${when(k.updatedAt)}${k.files ? ` · ${tn(k.files, '{n} file', '{n} files')}` : ''}</span>
            </span>
            ${k.unread && html`<span class="unread-dot" title=${t('New result')}></span>`}
            ${k.status !== 'done' && k.status !== 'new' && html`<span class=${`badge ${BADGE[k.status] || ''}`}>${k.status === 'running' ? html`<${Icon} name="loader" cls="spin" />` : STATUS()[k.status]}</span>`}
          </button>`,
        )}
      </div>
      ${sel ? html`<${TaskView} key=${sel} bot=${bot} taskId=${sel} onComputer=${data.onComputer} reload=${reload} onGone=${() => setSel('')} />` : html`<div></div>`}
    </div>`}
  </div>`;
}

function liveText(live) {
  if (!live) return '';
  const n = live.tokens || 0;
  const what = {
    starting: t('Starting…'),
    notes: t('Summing up its notes…'),
    reading: t('Reading…'),
    thinking: t('Thinking… {n} tokens', { n }),
    writing: t('Writing… {n} tokens', { n }),
    'tool-args': t('Preparing a step… {n} tokens', { n }),
    tool: t('Working: {tool}', { tool: live.tool }),
  }[live.phase] || t('Working…');
  return `${what}${live.round > 1 ? ` · ${t('step {n}', { n: live.round })}` : ''} · ${fmtDuration(live.elapsed)}`;
}

function Steps({ steps }) {
  if (!steps?.length) return null;
  return html`<div class="tool-steps">
    ${steps.map((s) => {
      if (s.status === 'note') return html`<div class="step-note" key=${s.id}>${s.title}</div>`;
      const arg = s.args?.path || s.args?.query || s.args?.url || s.args?.name || s.args?.fact || '';
      return html`<details class=${`tool-step ${s.status}`} key=${s.id}>
        <summary>
          ${s.status === 'running' ? html`<${Icon} name="loader" cls="spin" size="sm" />` : html`<${Icon} name=${s.status === 'error' ? 'x-circle' : s.icon || 'wrench'} size="sm" />`}
          <span class="ts-title">${s.title}</span>
          ${arg && html`<span class="ts-arg ellipsis">${arg}</span>`}
          ${s.ms > 1500 && html`<span class="faint" style="margin-left:auto;font-size:12px">${fmtDuration(s.ms)}</span>`}
        </summary>
        <pre class="ts-body">${s.error ? `${t('Error')}: ${s.error}` : s.result || ''}</pre>
      </details>`;
    })}
  </div>`;
}

function FileChips({ bot, files, onComputer }) {
  if (!files?.length) return null;
  const open = (p) => api(`/api/bots/${bot.id}/open`, { method: 'POST', body: { path: p } }).catch(toastError);
  return html`<div class="bot-files">
    ${files.map(
      (p) => html`<span class="file-chip" key=${p}>
        <${Icon} name=${/\.(xlsx|csv)$/i.test(p) ? 'file-spreadsheet' : 'file-text'} size="sm" />${p}
        ${onComputer && html`<button class="icon-btn" title=${t('Open')} onClick=${() => open(p)}><${Icon} name="external-link" size="sm" /></button>`}
        <a class="icon-btn" title=${t('Download')} href=${`/api/bots/${bot.id}/file?path=${encodeURIComponent(p)}`} download><${Icon} name="download" size="sm" /></a>
      </span>`,
    )}
  </div>`;
}

// The answer's Markdown (renderMarkdown escapes any HTML in it). Code blocks can be copied.
function Answer({ m }) {
  const { html: body, blocks } = useMemo(() => renderMarkdown(m.content || ''), [m.content]);
  const onClick = (e) => {
    const b = e.target.closest('[data-act]');
    if (b) copyText(blocks[Number(b.dataset.i)]?.code || '');
  };
  return m.content ? html`<div class="md" onClick=${onClick} dangerouslySetInnerHTML=${{ __html: body }}></div>` : null;
}

function TaskView({ bot, taskId, onComputer, reload, onGone }) {
  const [k, setK] = useState(null);
  const bottom = useRef(null);
  const active = k && (k.live || k.queuePos > 0);
  const load = () =>
    api(`/api/bots/${bot.id}/tasks/${taskId}?seen=1`)
      .then(setK)
      .catch(() => onGone());
  useEffect(() => {
    load();
  }, [taskId]);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(load, 1500);
    return () => clearInterval(timer);
  }, [taskId, active]);
  useEffect(() => {
    if (active) bottom.current?.scrollIntoView({ block: 'nearest' });
  }, [k?.updatedAt]);
  if (!k) return html`<div class="card empty"><${Icon} name="loader" cls="spin" /></div>`;
  const stop = async () => {
    await api(`/api/bots/${bot.id}/tasks/${taskId}/stop`, { method: 'POST' }).catch(toastError);
    load();
    reload();
  };
  const del = async () => {
    if (!(await confirmDialog({ title: t('Delete this task?'), text: t('Its steps and answers are removed. Files the bot made stay in its folder.'), ok: t('Delete'), danger: true }))) return;
    await api(`/api/bots/${bot.id}/tasks/${taskId}`, { method: 'DELETE' }).catch(toastError);
    onGone();
    reload();
  };
  const more = async (text) => {
    await api(`/api/bots/${bot.id}/tasks`, { method: 'POST', body: { text, taskId } });
    load();
    reload();
  };
  return html`<div class="card task-view col" style="gap:14px">
    <div class="row wrap">
      <${Icon} name=${SOURCE_ICON[k.source] || 'message-square'} size="sm" />
      <b class="grow" style="min-width:0">${k.title}</b>
      <span class=${`badge ${BADGE[k.status] || ''}`}>${STATUS()[k.status] || k.status}</span>
      ${active && html`<button class="btn sm" onClick=${stop}><${Icon} name="square" size="sm" /> ${t('Stop')}</button>`}
      <button class="icon-btn" title=${t('Delete')} onClick=${del}><${Icon} name="trash" size="sm" /></button>
    </div>
    ${k.chat && html`<div class="muted" style="font-size:13px"><${Icon} name="smartphone" size="sm" /> ${k.chat.owner ? t('You, in Telegram') : t('{name} in Telegram (a customer)', { name: k.chat.name })}</div>`}
    ${k.messages.map((m) =>
      m.role === 'user'
        ? html`<div class="msg user" key=${m.id}>
            ${m.images?.length > 0 && html`<div class="msg-images">${m.images.map((u) => html`<img src=${u} alt="" />`)}</div>`}
            ${m.content && html`<div class="bubble">${m.content}</div>`}
            ${!m.sent && html`<span class="faint" style="font-size:12px">${t('waiting for the bot')}</span>`}
          </div>`
        : html`<div class="msg assistant" key=${m.id}>
            <${Steps} steps=${m.steps} />
            <${Answer} m=${m} />
            <${FileChips} bot=${bot} files=${m.files} onComputer=${onComputer} />
            ${m.error && html`<div class="notice bad msg-error"><${Icon} name="alert" /><div>${m.error}</div></div>`}
            ${m.stopped && !m.error && html`<div class="faint" style="font-size:13px">${t('Stopped.')}</div>`}
            ${m.stats && html`<div class="msg-stats" style="margin:6px 0 0">${tn(m.stats.steps || 0, '{n} step', '{n} steps')} · ${fmtDuration(m.stats.ms)}${m.stats.tokPerSec ? ` · ${m.stats.tokPerSec.toFixed(1)} ${t('tok/s')}` : ''}</div>`}
          </div>`,
    )}
    ${k.live && html`<div class="live"><${Icon} name="loader" cls="spin" size="sm" /> ${liveText(k.live)}</div>`}
    ${k.queuePos > 0 && html`<div class="live"><${Icon} name="clock" size="sm" /> ${t('Waiting for its turn: bots work one at a time.')}</div>`}
    ${k.error && !k.messages.some((m) => m.error === k.error) && html`<div class="notice bad"><${Icon} name="alert" /><div>${k.error}</div></div>`}
    <div ref=${bottom}></div>
    ${k.source !== 'telegram' && html`<${Composer} placeholder=${active ? t('Add something; the bot reads it when it finishes its current answer…') : t('Ask for changes or more…')} button=${t('Send')} onSend=${more} />`}
  </div>`;
}

// ---------------- Schedule ----------------

function ScheduleEditor({ s, telegram, onSave, onCancel }) {
  const [v, setV] = useState({ task: '', time: '09:00', days: [1, 2, 3, 4, 5, 6, 7], every: 0, telegram: true, on: true, ...s });
  const kind = v.every ? 'every' : 'time';
  const toggleDay = (d) => setV({ ...v, days: v.days.includes(d) ? v.days.filter((x) => x !== d) : [...v.days, d].sort() });
  return html`<div class="card pad col" style="gap:14px">
    <label class="field"><span>${t('What the bot should do')}</span>
      <textarea class="textarea" value=${v.task} onInput=${(e) => setV({ ...v, task: e.target.value })} placeholder=${t('For example: Check what is new about T-shirt printing and send me a short summary.')}></textarea></label>
    <div class="field"><span>${t('When')}</span>
      <div class="seg" style="align-self:flex-start"><button class=${kind === 'time' ? 'on' : ''} onClick=${() => setV({ ...v, every: 0 })}>${t('At a time')}</button><button class=${kind === 'every' ? 'on' : ''} onClick=${() => setV({ ...v, every: v.every || 3 })}>${t('Every few hours')}</button></div>
    </div>
    ${kind === 'time'
      ? html`<div class="row wrap" style="gap:12px">
          <input class="input" type="time" style="width:130px" value=${v.time} onInput=${(e) => setV({ ...v, time: e.target.value })} />
          <div class="day-chips">${[1, 2, 3, 4, 5, 6, 7].map((d) => html`<button class=${`chip-btn outline ${v.days.includes(d) ? 'on filter' : ''}`} onClick=${() => toggleDay(d)}>${dayName(d)}</button>`)}</div>
          <button class="btn sm ghost" onClick=${() => setV({ ...v, days: [1, 2, 3, 4, 5, 6, 7] })}>${t('Every day')}</button>
          <button class="btn sm ghost" onClick=${() => setV({ ...v, days: [1, 2, 3, 4, 5] })}>${t('Weekdays')}</button>
        </div>`
      : html`<div class="row"><span>${t('Every')}</span><select class="select" style="width:auto" value=${v.every} onChange=${(e) => setV({ ...v, every: Number(e.target.value) })}>${[1, 2, 3, 4, 6, 8, 12].map((h) => html`<option value=${h}>${tn(h, '{n} hour', '{n} hours')}</option>`)}</select></div>`}
    <label class="row" style="gap:10px"><${Toggle} on=${v.telegram && telegram} disabled=${!telegram} onChange=${(x) => setV({ ...v, telegram: x })} /> <span>${t('Send the result to me in Telegram')}${!telegram ? html` <span class="faint">(${t('connect Telegram first')})</span>` : ''}</span></label>
    <div class="row" style="justify-content:flex-end">
      <button class="btn" onClick=${onCancel}>${t('Cancel')}</button>
      <button class="btn primary" disabled=${!v.task.trim() || (!v.every && !v.days.length)} onClick=${() => onSave(v)}>${t('Save')}</button>
    </div>
  </div>`;
}

function ScheduleTab({ bot, reload, onRun }) {
  const [edit, setEdit] = useState(null); // an entry, or {} for a new one
  const save = async (list) => {
    try {
      await api(`/api/bots/${bot.id}`, { method: 'PUT', body: { schedules: list } });
      setEdit(null);
      reload();
    } catch (err) {
      toastError(err);
    }
  };
  const run = async (s) => {
    try {
      const k = await api(`/api/bots/${bot.id}/schedules/${s.id}/run`, { method: 'POST' });
      onRun(k.id);
    } catch (err) {
      toastError(err);
    }
  };
  const del = async (s) => {
    if (!(await confirmDialog({ title: t('Delete this schedule entry?'), text: s.task, ok: t('Delete'), danger: true }))) return;
    save(bot.schedules.filter((x) => x.id !== s.id));
  };
  const put = (v) => save(v.id ? bot.schedules.map((x) => (x.id === v.id ? v : x)) : [...bot.schedules, v]);
  return html`<div class="col" style="gap:14px">
    <p class="muted" style="margin:0">${t('The bot does these tasks by itself at the times you set, while this computer and Hearth are on. A time missed while the computer was off is made up within six hours.')}</p>
    ${bot.schedules.length > 0 &&
    html`<div class="card list">
      ${bot.schedules.map(
        (s) => html`<div class="list-row" key=${s.id}>
          <${Toggle} on=${s.on} onChange=${(on) => save(bot.schedules.map((x) => (x.id === s.id ? { ...x, on } : x)))} />
          <div class="grow" style="min-width:0">
            <div class="name">${scheduleText(s)}</div>
            <div class="muted ellipsis" style="font-size:13.5px">${s.task}</div>
            <div class="meta">${s.on && s.nextRun ? html`<span>${t('Next: {when}', { when: when(s.nextRun) })}</span>` : ''}${s.lastRun ? html`<span>${t('Last: {when}', { when: when(s.lastRun) })}</span>` : ''}${s.telegram && bot.telegram.connected ? html`<span><${Icon} name="smartphone" size="sm" /> Telegram</span>` : ''}</div>
          </div>
          <button class="btn sm" onClick=${() => run(s)}><${Icon} name="play" size="sm" /> ${t('Run now')}</button>
          <button class="icon-btn" title=${t('Edit')} onClick=${() => setEdit(s)}><${Icon} name="pencil" size="sm" /></button>
          <button class="icon-btn" title=${t('Delete')} onClick=${() => del(s)}><${Icon} name="trash" size="sm" /></button>
        </div>`,
      )}
    </div>`}
    ${edit ? html`<${ScheduleEditor} s=${edit} telegram=${bot.telegram.connected && bot.telegram.owners.length > 0} onSave=${put} onCancel=${() => setEdit(null)} />` : html`<div><button class="btn" onClick=${() => setEdit({})}><${Icon} name="plus" size="sm" /> ${t('Add to the schedule')}</button></div>`}
  </div>`;
}

// ---------------- Telegram ----------------

function TelegramTab({ bot, reload }) {
  const tg = bot.telegram;
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [nat, setNat] = useState(null); // the natural voice: is it installed and on
  useEffect(() => {
    api('/api/voice/natural').then(setNat).catch(() => {});
  }, []);
  const act = async (fn) => {
    setBusy(true);
    try {
      await fn();
      reload();
    } catch (err) {
      toastError(err);
    }
    setBusy(false);
  };
  const connect = () => act(async () => {
    await api(`/api/bots/${bot.id}/telegram`, { method: 'POST', body: { token } });
    setToken('');
    toast(t('Telegram is connected'));
  });
  const disconnect = async () => {
    if (!(await confirmDialog({ title: t('Disconnect Telegram?'), text: t('The bot stops answering in Telegram. The Telegram bot itself stays; you can connect it again later.'), ok: t('Disconnect'), danger: true }))) return;
    act(() => api(`/api/bots/${bot.id}/telegram`, { method: 'DELETE' }));
  };
  const mode = (m) => act(() => api(`/api/bots/${bot.id}`, { method: 'PUT', body: { telegramMode: m } }));
  const voiceReplies = (on) => act(() => api(`/api/bots/${bot.id}`, { method: 'PUT', body: { voiceReplies: on } }));
  // "Hear the voice": the computer reads a short line the way it will read answers.
  const hear = async () => {
    try {
      const res = await fetch('/api/voice/say', { method: 'POST', headers: { 'content-type': 'application/json', 'x-hearth-lang': document.documentElement.lang || 'en' }, body: JSON.stringify({ text: t('Hello! This is how I will answer you by voice.') }) });
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.error?.message || t('Request failed ({status})', { status: res.status }));
      const audio = new Audio(URL.createObjectURL(await res.blob()));
      audio.onended = () => URL.revokeObjectURL(audio.src);
      await audio.play();
    } catch (err) {
      toastError(err);
    }
  };
  const forget = (o) => act(() => api(`/api/bots/${bot.id}/telegram/owners/${encodeURIComponent(o.id)}`, { method: 'DELETE' }));
  if (!tg.connected)
    return html`<div class="card pad col" style="gap:14px;max-width:720px">
      <b style="font-size:16px">${t('Talk to this bot from your phone')}</b>
      <ol class="steps">
        <li>${t('In Telegram, open')} <a href="https://t.me/BotFather" target="_blank" rel="noopener">@BotFather</a> ${t('(Telegram’s own bot for making bots).')}</li>
        <li>${t('Send it /newbot, then a name, then a username that ends in “bot”.')}</li>
        <li>${t('It answers with a token, like 123456789:AAH… Copy it and paste it here:')}</li>
      </ol>
      <div class="row wrap"><input class="input grow" style="min-width:260px" value=${token} placeholder="123456789:AAH…" onInput=${(e) => setToken(e.target.value)} autocomplete="off" spellcheck="false" /><button class="btn primary" disabled=${busy || !token.trim()} onClick=${connect}>${busy ? html`<${Icon} name="loader" cls="spin" size="sm" />` : ''} ${t('Connect Telegram')}</button></div>
      <p class="muted" style="margin:0;font-size:13.5px">${t('Hearth fetches the messages from Telegram itself, so nothing on this computer is opened to the internet. The bot answers while this computer and Hearth are on.')}</p>
    </div>`;
  return html`<div class="col" style="gap:14px;max-width:760px">
    <div class="card pad col" style="gap:12px">
      <div class="row wrap">
        <span class="badge ok"><${Icon} name="check" /> ${t('Connected')}</span>
        <a href=${`https://t.me/${tg.username}`} target="_blank" rel="noopener"><b>@${tg.username}</b></a>
        <span class="grow"></span>
        <button class="btn sm danger" disabled=${busy} onClick=${disconnect}>${t('Disconnect')}</button>
      </div>
      ${tg.error && html`<div class="notice bad"><${Icon} name="alert" /><div>${tg.error}</div></div>`}
    </div>
    <div class="card pad col" style="gap:12px">
      <b>${tg.owners.length ? t('Your Telegram') : t('Let the bot know you')}</b>
      ${tg.owners.map((o) => html`<div class="row" key=${o.id}><${Icon} name="user" size="sm" /> <span class="grow">${o.name}${o.username ? html` <span class="muted">@${o.username}</span>` : ''}</span><button class="btn sm" disabled=${busy} onClick=${() => forget(o)}>${t('Forget')}</button></div>`)}
      <p class="muted" style="margin:0;font-size:13.5px">${tg.owners.length ? t('To add another Telegram account (for example a second phone), open this link there. The link works once.') : t('Open this link on your phone (or scan the code) and press Start. From then on the bot knows it is you. The link works once.')}</p>
      <div class="row wrap" style="gap:16px;align-items:center">
        ${tg.link && html`<${QrCode} text=${tg.link} />`}
        <div class="col">
          <a class="btn primary" href=${tg.link} target="_blank" rel="noopener"><${Icon} name="external-link" size="sm" /> ${t('Open in Telegram')}</a>
          <button class="btn" onClick=${() => copyText(tg.link)}><${Icon} name="copy" size="sm" /> ${t('Copy the link')}</button>
        </div>
      </div>
    </div>
    <div class="card pad col" style="gap:10px">
      <b>${t('Who may write to the bot')}</b>
      <div class="seg" style="align-self:flex-start"><button class=${tg.mode !== 'everyone' ? 'on' : ''} onClick=${() => mode('owner')}>${t('Only me')}</button><button class=${tg.mode === 'everyone' ? 'on' : ''} onClick=${() => mode('everyone')}>${t('Anyone (customers)')}</button></div>
      <p class="muted" style="margin:0;font-size:13.5px">${tg.mode === 'everyone' ? t('Anyone who finds the bot can write to it. Strangers get no access to your files, folders, connectors or memory: the bot answers them from its instructions (and the web, if it is on). Each one can send at most 30 messages an hour.') : t('Others who write to the bot are told it is private.')}</p>
    </div>
    <div class="card pad col" style="gap:10px">
      <div class="row" style="justify-content:space-between;gap:12px"><b>${t('Answer voice messages by voice')}</b><${Toggle} on=${tg.voiceReplies !== false} onChange=${voiceReplies} /></div>
      <p class="muted" style="margin:0;font-size:13.5px">${t('When you speak to the bot, it sends its answer as a voice message too, read by a voice of this computer. Long answers stay written only.')}</p>
      <div class="row wrap">
        <button class="btn sm" onClick=${hear}><${Icon} name="volume-2" size="sm" /> ${t('Hear the voice')}</button>
        ${nat?.supported && html`<span class="muted" style="font-size:13.5px">${nat.ready && nat.on ? t('It reads with the natural voice ({name}).', { name: `${nat.name} · ${nat.voice}` }) : nat.ready ? t('The natural voice is switched off; the system’s voice reads.') : t('Sounds robotic? There is a natural voice to download.')} <a href="#/settings/voice">${nat.ready ? t('Change it in Settings → Voice') : t('Open Settings → Voice')}</a></span>`}
      </div>
    </div>
    <p class="muted" style="margin:0;font-size:13.5px">${t('In Telegram: /new starts a new conversation, /stop stops the current task. You can also send voice messages: the bot listens to them on this computer (voice input must be set up in Settings → Voice). Files the bot makes are sent to you; photos and files you send are saved in its work folder.')}</p>
  </div>`;
}

// ---------------- Settings ----------------

const TOOL_ROWS = () => [
  ['web', 'globe', t('Internet'), t('Search and read web pages.')],
  ['files', 'folder', t('Work folder'), t('Create and change files in its own folder: texts, tables, web pages.')],
  ['folders', 'hard-drive', t('Read my folders'), t('Read (never change) the folders allowed in Settings → Tools.')],
  ['connectors', 'plug', t('Connectors'), t('Use your connected services (Notion and others) without asking each time.')],
  ['skills', 'sparkles', t('Skills'), t('Use the skills from Extensions.')],
  ['memory', 'brain', t('Memory'), t('Knows the facts on the Memory page and can add new ones.')],
];

function SettingsTab({ data, reload }) {
  const { bot } = data;
  const pick = (b) => ({ name: b.name, emoji: b.emoji, description: b.description, instructions: b.instructions, tools: { ...b.tools }, thinking: Boolean(b.thinking) });
  const [v, setV] = useState(() => pick(bot));
  const [busy, setBusy] = useState(false);
  const dirty = JSON.stringify(v) !== JSON.stringify(pick(bot));
  const save = async () => {
    setBusy(true);
    try {
      await api(`/api/bots/${bot.id}`, { method: 'PUT', body: v });
      toast(t('Saved'));
      reload();
    } catch (err) {
      toastError(err);
    }
    setBusy(false);
  };
  const folder = async () => {
    try {
      const r = await api('/api/pick-folder?for=bot', { method: 'POST' });
      if (!r.path) return;
      await api(`/api/bots/${bot.id}`, { method: 'PUT', body: { folder: r.path } });
      reload();
    } catch (err) {
      toastError(err);
    }
  };
  const del = async () => {
    if (!(await confirmDialog({ title: t('Delete “{name}”?', { name: bot.name }), text: t('The bot, its tasks and its schedule are removed, and it stops answering in Telegram. The files in its work folder stay.'), ok: t('Delete'), danger: true }))) return;
    try {
      await api(`/api/bots/${bot.id}`, { method: 'DELETE' });
      go('#/bots');
    } catch (err) {
      toastError(err);
    }
  };
  const tool = (k, on) => setV({ ...v, tools: { ...v.tools, [k]: on } });
  return html`<div class="col" style="gap:16px;max-width:820px">
    <div class="card pad col" style="gap:14px">
      <div class="row wrap" style="gap:12px;align-items:flex-end">
        <label class="field grow"><span>${t('Name')}</span><input class="input" value=${v.name} onInput=${(e) => setV({ ...v, name: e.target.value })} /></label>
      </div>
      <div class="field"><span>${t('Icon')}</span><div class="emoji-pick">${EMOJIS.map((e) => html`<button class=${v.emoji === e ? 'on' : ''} onClick=${() => setV({ ...v, emoji: e })}>${e}</button>`)}</div></div>
      <label class="field"><span>${t('What it does, in one line')}</span><input class="input" value=${v.description} onInput=${(e) => setV({ ...v, description: e.target.value })} /></label>
      <label class="field"><span>${t('Instructions')}</span>
        <textarea class="textarea" style="min-height:200px" value=${v.instructions} onInput=${(e) => setV({ ...v, instructions: e.target.value })} placeholder=${t('What the bot does, for whom, the tone, what to save as files, what it must never do…')}></textarea>
        <small class="muted">${t('Write them like a note to a new employee. The bot reads them before every task.')}</small></label>
    </div>
    <div class="card">
      <div class="set-row"><div class="lbl"><b>${t('What the bot may use')}</b><span>${t('Fewer tools make a bot faster and safer.')}</span></div></div>
      ${TOOL_ROWS().map(
        ([k, icon, name, text]) => html`<div class="set-row" key=${k}>
          <div class="lbl"><b><${Icon} name=${icon} size="sm" /> ${name}</b><span>${text}</span>
            ${k === 'web' && v.tools.web && data.search === 'wikipedia' && html`<span style="display:block;margin-top:4px" class="warn-text">${t('Search covers Wikipedia only right now. For the whole web, add a free Brave Search or Tavily key in Settings → Tools.')}</span>`}
            ${k === 'folders' && v.tools.folders && !data.folders && html`<span style="display:block;margin-top:4px" class="warn-text">${t('No folders are allowed yet: add them in Settings → Tools.')}</span>`}
            ${k === 'files' && html`<span style="display:block;margin-top:4px" class="ellipsis" title=${bot.folder}><${Icon} name="folder" size="sm" /> ${bot.folder}</span>`}
          </div>
          <div class="ctl">
            ${k === 'files' && data.onComputer && html`<button class="btn sm" onClick=${folder}>${t('Change folder')}</button>`}
            <${Toggle} on=${v.tools[k]} onChange=${(on) => tool(k, on)} />
          </div>
        </div>`,
      )}
      <div class="set-row"><div class="lbl"><b><${Icon} name="lightbulb" size="sm" /> ${t('Think before answering')}</b><span>${t('Better on hard tasks, but each step takes longer.')}</span></div><div class="ctl fit"><${Toggle} on=${v.thinking} onChange=${(on) => setV({ ...v, thinking: on })} /></div></div>
    </div>
    <div class="row" style="position:sticky;bottom:0;padding:10px 0;background:var(--bg)">
      <button class="btn danger" onClick=${del}><${Icon} name="trash" size="sm" /> ${t('Delete bot')}</button>
      <span class="grow"></span>
      ${dirty && html`<button class="btn" onClick=${() => setV(pick(bot))}>${t('Undo')}</button>`}
      <button class="btn primary" disabled=${busy || !dirty || !v.name.trim()} onClick=${save}>${t('Save')}</button>
    </div>
  </div>`;
}
