// Models page: this computer, the engine, models already here, downloads, updates, and new models from Hugging Face.
import { html, useState, useEffect, useRef } from '../vendor/preact-htm.js';
import { Icon } from './icons.js';
import { t, tn, locale } from './i18n.js';
import { useStore, api, toast, toastError, refreshModels, refreshDownloads, refreshStatus, refreshUpdates, loadModel, stopModel, makePrimary, fmtBytes, fmtDuration, modelLabel, getState, set, go } from './store.js';
import { openModelSettings } from './model-settings.js';
import { Popover, confirmDialog, FitBadge, PageHead } from './ui.js';

const GBs = (n) => t('{n} GB', { n: (n / 1e9).toLocaleString(locale(), { maximumFractionDigits: n >= 1e11 ? 0 : 1, minimumFractionDigits: n >= 1e11 ? 0 : 1 }) });
// Memory is sold in binary gigabytes (a "48 GB" Mac has 48 × 1024³ bytes).
const ramGB = (n) => t('{n} GB', { n: Math.round(n / 1024 ** 3) });

function HardwareCards({ status, engines, onInstall, installing, onBackend, onRecheck, onReload }) {
  const hw = status?.hardware;
  // The engine the next load uses (as the server picks it): one set by hand, else a download of the chosen type.
  const list = engines?.engines || [];
  // Of several downloads of the chosen type, the one that sees the graphics card.
  const mine = list.filter((e) => e.source === 'downloaded' && e.backend === engines.backend).sort((a, b) => (a.gpu === false) - (b.gpu === false))[0];
  const cur = list.find((e) => e.source === 'custom') || mine || list[0];
  // Whether a new download sees the graphics card is checked in the background: ask again in a moment.
  const checking = Boolean(mine && mine.gpu === null && hw && !hw.unified);
  useEffect(() => {
    if (!checking) return;
    const timer = setTimeout(onRecheck, 4000);
    return () => clearTimeout(timer);
  }, [checking, mine?.path, engines]);
  if (!hw) return null;
  const gpu = hw.gpus?.[0];
  const latest = engines?.latest;
  const canUpdate = latest && cur && latest.build > cur.build;
  // Windows/Linux: the user can pick another build type (e.g. AMD ROCm instead of Vulkan).
  const haveBackend = !engines || engines.engines.some((e) => e.backend === engines.backend || (e.source === 'system' && hw.os === 'darwin'));
  const showButton = engines && latest && (!cur || canUpdate || !haveBackend);
  const label = engines?.labels?.[engines?.backend] || engines?.backend;
  const broken = !mine && engines?.broken?.find((b) => b.backend === engines.backend);
  // A model running with another engine type than the one chosen now: it switches when it loads again.
  const run = status?.engine;
  const runType = run?.status === 'ready' && run.engine?.backend;
  // (Not when the model runs with Vulkan on purpose: it doesn't fit the card, see the note on the model.)
  const canReload = Boolean(runType && mine && runType !== engines.backend && mine.gpu !== false && run.engineNote?.reason !== 'cpu-part');
  return html`<div class="grid c4">
    <div class="card pad kv"><span class="k">${t('Processor')}</span><span class="v ellipsis" title=${hw.cpuName}>${hw.cpuName || hw.arch}</span><span class="muted" style="font-size:13px">${tn(hw.threads, '{n} thread', '{n} threads')} · ${hw.osName}</span></div>
    <div class="card pad kv"><span class="k">${t('Memory')}</span><span class="v">${ramGB(hw.ram)}</span><span class="muted" style="font-size:13px">${hw.unified ? t('Shared with the graphics chip') : t('System RAM')}</span></div>
    <div class="card pad kv"><span class="k">${t('Graphics')}</span><span class="v ellipsis" title=${gpu?.name}>${gpu ? gpu.name : t('None found')}</span>
      <span class="muted" style="font-size:13px">${hw.unified ? t('Models up to about {size} run well', { size: GBs(hw.gpuBudget * 0.8) }) : gpu ? t('{size} graphics memory', { size: GBs(hw.gpuBudget) }) : t('Models run on the processor')}</span></div>
    <div class="card pad kv"><span class="k">${t('Engine')}</span>
      ${engines == null
        ? html`<span class="v muted">${t('Checking…')}</span>`
        : cur
          ? html`<span class="v">llama.cpp b${cur.build}</span><span class="muted" style="font-size:13px">${(cur.backend && engines.labels?.[cur.backend]) || hw.backendLabel}${cur.source === 'system' ? ` · ${t('installed on this computer')}` : ''}</span>`
          : html`<span class="v" style="color:var(--bad)">${t('Not installed')}</span>`}
      ${engines?.choices?.length > 1 && html`<select class="select" style="margin-top:8px;height:32px;font-size:13px" value=${engines.backend} onChange=${(e) => onBackend(e.target.value)}>
        ${engines.choices.map((c) => html`<option value=${c}>${engines.labels[c]}${c === engines.recommended ? ` (${t('recommended')})` : ''}</option>`)}
      </select>`}
      ${showButton && html`<button class="btn sm ${cur && haveBackend ? '' : 'primary'}" style="margin-top:8px;align-self:flex-start" disabled=${installing} onClick=${onInstall}>
        <${Icon} name=${installing ? 'loader' : 'download'} cls=${installing ? 'spin' : ''} size="sm" /> ${!cur || !haveBackend ? t('Download engine ({size})', { size: fmtBytes(latest.size) }) : t('Update to b{build}', { build: latest.build })}
      </button>`}
      ${engines?.latestError && !cur && html`<span class="muted" style="font-size:12.5px">${t('Could not reach GitHub: {err}', { err: engines.latestError })}</span>`}
      ${broken && html`<span style="font-size:12.5px;color:var(--bad);margin-top:6px">${t('{type} is downloaded but does not start on this computer: {reason}.', { type: label, reason: broken.reason })}</span>`}
      ${mine && mine.gpu === false && html`<span style="font-size:12.5px;color:var(--bad);margin-top:6px">${t('{type} does not see your graphics card here, so Hearth runs models with another engine.', { type: label })}${mine.gpuNote ? ` (${mine.gpuNote})` : ''}</span>`}
      ${checking && html`<span class="muted" style="font-size:12.5px;margin-top:6px">${t('Checking that it sees your graphics card…')}</span>`}
      ${canReload && html`<button class="btn sm primary" style="margin-top:8px;align-self:flex-start" onClick=${onReload}><${Icon} name="refresh-cw" size="sm" /> ${t('Reload the model with it')}</button>`}
    </div>
  </div>`;
}

// The engine types' names, as the server's BACKEND_LABELS has them.
const ENGINE_LABELS = { metal: 'Apple Metal', cuda: 'NVIDIA CUDA', rocm: 'AMD ROCm (HIP)', vulkan: 'Vulkan', cpu: 'CPU only' };

// One loaded model: state, what it runs with, and its controls.
function LoadedRun({ e, many }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (e.status !== 'starting') return;
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, [e.status]);
  const m = e.model;
  const label = { ready: t('Running'), starting: t('Loading'), stopping: t('Stopping'), stopped: t('Stopped'), error: t('Could not load') }[e.status];
  const badge = { ready: 'ok', starting: 'warn', stopping: 'warn', error: 'bad' }[e.status] || '';
  const o = e.options || {};
  const local = getState().models.find((x) => x.id === m?.id);
  return html`<div class="col" style="gap:10px">
    <div class="row wrap" style="gap:14px">
      <span class=${`badge ${badge}`}>${e.status === 'starting' ? html`<${Icon} name="loader" cls="spin" />` : ''} ${label}</span>
      <b style="font-size:16px">${modelLabel(m)}</b>
      ${many && e.primary && html`<span class="badge accent" title=${t('The chat, and apps that don’t name a model, use this one.')}>${t('Default')}</span>`}
      <span class="muted">${[e.ctx && t('{n}K context', { n: Math.round(e.ctx / 1024) }), e.vision && (o.visionCpu ? t('sees images (on the processor)') : t('sees images')), o.kv && o.kv !== 'f16' && t('context memory {type}', { type: o.kv === 'q8_0' ? 'INT8' : 'INT4' }), o.threads && t('leaves 20% for your work'), e.speculative && (e.speculative.startsWith('mtp') ? t('MTP drafting on') : t('guess-and-check on')), m && fmtBytes(m.size), e.engine && (e.engine.kind === 'colibri' ? t('Colibri {tag}', { tag: e.engine.tag }) : t('engine b{build}', { build: e.engine.build }))].filter(Boolean).join(' · ')}</span>
      <span class="grow"></span>
      ${e.status === 'starting' && html`<span class="muted">${fmtDuration(now - e.startedAt)}</span>`}
      ${e.status === 'ready' && e.readyAt && html`<span class="muted">${t('Loaded in {time}', { time: fmtDuration(e.readyAt - e.startedAt) })}</span>`}
      ${many && !e.primary && e.status === 'ready' && html`<button class="btn sm" onClick=${() => makePrimary(m.id)}>${t('Make default')}</button>`}
      ${local && html`<button class="btn sm" onClick=${() => openModelSettings(local)}><${Icon} name="sliders" size="sm" /> ${t('Settings')}</button>`}
      ${(e.status === 'ready' || e.status === 'starting' || e.status === 'error') && html`<button class="btn sm danger" onClick=${() => stopModel(m?.id)}><${Icon} name="power" size="sm" /> ${e.status === 'error' ? t('Close') : t('Stop')}</button>`}
    </div>
    ${(e.plan?.mode === 'split' || e.plan?.mode === 'ssd-experts') && html`<div class="notice accent"><${Icon} name="hard-drive" /><div><b>${t('Big model mode.')}</b> ${e.plan.detail}. ${t('The first answers are slower while the computer reads the busy experts from the SSD; it speeds up as they settle in memory.')}</div></div>`}
    ${e.gpuBusy && html`<div class="notice"><${Icon} name="alert" /><div><b>${t('Another program is using {used} of the graphics card’s memory.', { used: fmtBytes(e.gpuBusy.used) })}</b> ${t('This model got only {free} of {total}, so it runs slower. Close the other program (Strata, a game, or a second Hearth window) and load the model again.', { free: fmtBytes(e.gpuBusy.free), total: fmtBytes(e.gpuBusy.total) })}</div></div>`}
    ${e.engineNote?.reason === 'cpu-part' && html`<div class="notice accent"><${Icon} name="info" /><div>${t('Part of this model runs on the processor, where AMD’s ROCm build is slow, so it runs with {other}. Models that fit fully on the graphics card use AMD ROCm.', { other: ENGINE_LABELS[e.engineNote.used] || e.engineNote.used })}</div></div>`}
    ${e.engineNote && e.engineNote.reason !== 'cpu-part' && html`<div class="notice"><${Icon} name="alert" /><div>${t('{type} does not see your graphics card here{why}, so this model runs with {other}.', { type: ENGINE_LABELS[e.engineNote.skipped] || e.engineNote.skipped, why: e.engineNote.why ? ` (${e.engineNote.why})` : '', other: ENGINE_LABELS[e.engineNote.used] || e.engineNote.used })}</div></div>`}
    ${e.fallbacks?.length > 0 && !e.engineNote && e.engine?.backend === 'vulkan' && getState().status?.hardware?.gpus?.some((g) => g.vendor === 'amd') && html`<div class="notice accent"><${Icon} name="zap" /><div><b>${t('This model may run faster with the AMD ROCm engine.')}</b> ${t('Some of its steps are not built into the Vulkan engine yet, so they run a slower way ({steps}). Choose AMD ROCm (HIP) under Engine above, download it, and compare with a speed test.', { steps: e.fallbacks.join(', ') })}</div></div>`}
    ${e.status === 'error' && html`<div class="notice bad"><${Icon} name="alert" /><div>${e.error === 'NO_ENGINE' ? t('Download the engine above, then load the model again.') : e.error}</div></div>`}
  </div>`;
}

function LoadedCard({ status }) {
  const e = status?.engine;
  const [showLog, setShowLog] = useState(false);
  const [logs, setLogs] = useState([]);
  useEffect(() => {
    if (!showLog) return;
    const load = () => api('/api/engine/logs?n=120').then((r) => setLogs(r.logs)).catch(() => {});
    load();
    const timer = setInterval(load, 1500);
    return () => clearInterval(timer);
  }, [showLog]);
  const runs = e?.loaded || [];
  if (!runs.length) return null;
  const starting = runs.find((r) => r.status === 'starting');
  return html`<div class="section">
    <h2>${runs.length > 1 ? t('Loaded now ({n})', { n: runs.length }) : t('Loaded now')}</h2>
    <div class="card pad col" style="gap:16px">
      ${runs.map((r, i) => html`${i > 0 && html`<div class="pop-sep" style="margin:0"></div>`}<${LoadedRun} key=${r.model?.id} e=${r} many=${runs.length > 1} />`)}
      ${starting && html`<div class="muted mono ellipsis" style="font-size:12.5px">${e.logTail?.[e.logTail.length - 1] || t('Starting the engine…')}</div>`}
      <div class="row">
        <button class="btn sm" onClick=${() => setShowLog(!showLog)}><${Icon} name="terminal" size="sm" /> ${showLog ? t('Hide log') : t('Log')}</button>
        ${runs.length > 1 && html`<button class="btn sm danger" onClick=${() => stopModel()}><${Icon} name="power" size="sm" /> ${t('Stop all')}</button>`}
      </div>
      ${showLog && html`<div class="logbox" style="height:260px">${logs.map((l) => html`<div class=${l.stream === 'hearth' ? 'hearth' : ''}>${l.text}</div>`)}</div>`}
    </div>
  </div>`;
}

function Updates({ updates, onEngine }) {
  const [busy, setBusy] = useState('');
  if (!updates || (!updates.engine && !updates.images && !updates.models?.length)) return null;
  const updateImages = async () => {
    setBusy('images');
    try {
      await api('/api/updates/images-engine', { method: 'POST' });
      toast(t('Download started'));
      refreshDownloads();
      set({ updates: { ...updates, images: null } });
    } catch (err) {
      toastError(err);
    }
    setBusy('');
  };
  const updateModel = async (m) => {
    if (!(await confirmDialog({ title: t('Update {name}?', { name: `${m.name} ${m.quant || ''}` }), text: t('Hearth downloads the changed files ({files}) again. If the model is loaded, it stops first.', { files: m.files.join(', ') }), ok: t('Update') }))) return;
    setBusy(m.id);
    try {
      await api('/api/updates/model', { method: 'POST', body: { id: m.id } });
      toast(t('Download started'));
      refreshDownloads();
      set({ updates: { ...updates, models: updates.models.filter((x) => x.id !== m.id) } });
    } catch (err) {
      toastError(err);
    }
    setBusy('');
  };
  return html`<div class="section">
    <h2><${Icon} name="arrow-up-circle" /> ${t('Updates')}</h2>
    <div class="card list">
      ${updates.engine && html`<div class="list-row">
        <div class="grow"><div class="name">${t('Engine llama.cpp b{build}', { build: updates.engine.latest })}</div><div class="meta">${t('You have b{build}. New builds run new models and are often faster.', { build: updates.engine.current || '–' })} · ${fmtBytes(updates.engine.size)}</div></div>
        <button class="btn sm primary" onClick=${onEngine}><${Icon} name="download" size="sm" /> ${t('Update')}</button>
      </div>`}
      ${updates.images && html`<div class="list-row">
        <div class="grow"><div class="name">${t('Picture and video engine (stable-diffusion.cpp)')}</div><div class="meta">${t('A newer build is out ({latest}; yours is {behind} builds older). New builds fix problems with pictures and videos and can be faster.', { latest: updates.images.latest, behind: updates.images.behind })} · ${fmtBytes(updates.images.size)}</div></div>
        <button class="btn sm primary" disabled=${busy === 'images'} onClick=${updateImages}><${Icon} name="download" size="sm" /> ${t('Update')}</button>
      </div>`}
      ${updates.models?.map((m) => html`<div class="list-row" key=${m.id}>
        <div class="grow"><div class="name">${m.name} ${m.quant}</div><div class="meta">${t('Its maker changed the files on Hugging Face: {files}', { files: m.files.join(', ') })}</div></div>
        <button class="btn sm" disabled=${busy === m.id} onClick=${() => updateModel(m)}><${Icon} name="download" size="sm" /> ${t('Update')}</button>
      </div>`)}
    </div>
  </div>`;
}

function LocalModels({ models, status }) {
  const e = status?.engine;
  const chat = models.filter((m) => m.kind === 'chat');
  const del = async (m) => {
    if (!(await confirmDialog({ title: t('Delete {name}?', { name: modelLabel(m) }), text: t('This frees {size} on your disk. You can download it again later.', { size: fmtBytes(m.size) }), ok: t('Delete'), danger: true }))) return;
    try {
      await api(`/api/models/${m.id}`, { method: 'DELETE' });
      toast(t('Model deleted'));
      refreshModels();
    } catch (err) {
      toastError(err);
    }
  };
  return html`<div class="section">
    <h2>${t('On this computer')}</h2>
    <p class="sub">${t('Hearth also finds models you already have from LM Studio, Ollama and Hugging Face, and runs them without copying.')}</p>
    <div class="card list">
      ${!chat.length && html`<div class="empty col" style="gap:12px;align-items:center">${t('No models yet. Pick one to download; Hearth suggests the size that fits this computer.')}
        <button class="btn primary" onClick=${() => go('#/models/get')}><${Icon} name="download" size="sm" /> ${t('Get models')}</button></div>`}
      ${chat.map((m) => {
        const run = e?.loaded?.find((r) => r.model?.id === m.id);
        const loaded = run?.status === 'ready';
        const loading = run?.status === 'starting';
        return html`<div class="list-row" key=${m.id}>
          <div class="grow" style="min-width:0">
            <div class="row" style="gap:8px"><span class="name ellipsis">${m.name}</span>${m.quant && html`<span class="badge">${m.quant}</span>`}</div>
            <div class="meta">
              <span>${fmtBytes(m.size)}</span>
              <span>${m.sourceLabel}</span>
              ${m.vision && html`<span class="row" style="gap:4px"><${Icon} name="eye" size="sm" /> ${t('sees images')}</span>`}
              ${m.moe && html`<span>${t('mixture of experts')}</span>`}
              ${m.ctxTrain > 0 && html`<span>${t('up to {n}K context', { n: Math.round(m.ctxTrain / 1024) })}</span>`}
              ${m.note && html`<span class="fit-ok">${t(m.note)}</span>`}
            </div>
            ${m.fit?.detail && (m.fit.level === 'ssd' || m.fit.ssd > 0) && html`<div class="meta" style="margin-top:4px;flex-wrap:nowrap;align-items:flex-start"><${Icon} name="hard-drive" size="sm" /><span>${m.fit.detail}</span></div>`}
          </div>
          <${FitBadge} fit=${m.fit} />
          ${loaded
            ? html`<span class="badge ok"><${Icon} name="check" /> ${t('Loaded')}</span>`
            : html`<button class="btn sm ${loading ? '' : 'primary'}" disabled=${loading} onClick=${() => loadModel(m)}>${loading ? html`<${Icon} name="loader" cls="spin" size="sm" /> ${t('Loading')}` : html`<${Icon} name="play" size="sm" /> ${t('Load')}`}</button>`}
          <button class="icon-btn" title=${t('Model settings')} onClick=${() => openModelSettings(m)}><${Icon} name="sliders" /></button>
          <${Popover} align="right" button=${({ toggle }) => html`<button class="icon-btn" onClick=${toggle} title=${t('More')}><${Icon} name="more" /></button>`}>
            <button class="pop-item" data-close onClick=${() => openModelSettings(m)}><${Icon} name="sliders" size="sm" /> ${t('Model settings')}</button>
            <button class="pop-item" data-close onClick=${() => api('/api/reveal', { method: 'POST', body: { id: m.id } })}><${Icon} name="folder" size="sm" /> ${t('Show in folder')}</button>
            ${m.source === 'hearth' && html`<button class="pop-item danger" data-close onClick=${() => del(m)}><${Icon} name="trash" size="sm" /> ${t('Delete')}</button>`}
          <//>
        </div>`;
      })}
    </div>
  </div>`;
}

const STATE_LABEL = () => ({ queued: t('Waiting'), finishing: t('Unpacking'), done: t('Done'), error: t('Failed'), cancelled: t('Cancelled') });

export function Downloads({ downloads, kinds }) {
  const list = kinds ? downloads.filter((d) => kinds.includes(d.kind)) : downloads;
  if (!list.length) return null;
  return html`<div class="section">
    <h2>${t('Downloads')}</h2>
    <div class="card list">
      ${list.map((d) => {
        const pct = d.total ? Math.min(100, (d.done / d.total) * 100) : 0;
        const eta = d.speed > 0 ? ((d.total - d.done) / d.speed) * 1000 : null;
        const active = d.state === 'downloading' || d.state === 'queued' || d.state === 'finishing';
        return html`<div class="list-row" key=${d.id}>
          <div class="grow col" style="gap:6px;min-width:0">
            <div class="row"><span class="name ellipsis">${d.label}</span>
              <span class=${`badge ${d.state === 'done' ? 'ok' : d.state === 'error' ? 'bad' : active ? 'accent' : ''}`}>${d.state === 'downloading' ? `${pct.toFixed(0)}%` : STATE_LABEL()[d.state]}</span></div>
            ${active && html`<div class="progress"><i style=${{ width: `${pct}%` }}></i></div>`}
            <div class="meta">${t('{done} of {total}', { done: fmtBytes(d.done), total: fmtBytes(d.total) })}${d.speed > 0 ? ` · ${fmtBytes(d.speed)}/${t('s')} · ${t('{time} left', { time: fmtDuration(eta) })}` : ''}${d.error ? html` · <span style="color:var(--bad)">${d.error}</span>` : ''}</div>
          </div>
          <button class="btn sm" onClick=${() => api(`/api/downloads/${d.id}`, { method: 'DELETE' }).then(refreshDownloads)}>${active ? t('Cancel') : t('Remove')}</button>
        </div>`;
      })}
    </div>
  </div>`;
}

// The maker's initials for the card's round logo ("Qwen · ISTA-DASLab" → QI; the dot is not a word).
function initials(name) {
  return name.split(/[\s·]+/).filter((w) => /^[\p{L}\d]/u.test(w)).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
}

function CatalogCard({ entry, onDownload, downloading }) {
  const { models } = useStore();
  const [quant, setQuant] = useState(entry.suggested);
  useEffect(() => setQuant(entry.suggested), [entry.suggested]);
  const choice = entry.choices.find((c) => c.quant === quant);
  const local = models.find((m) => m.repo === entry.repo && m.quant === quant);
  return html`<div class="card mcard">
    <div class="top">
      <span class="logo">${initials(entry.maker)}</span>
      <div class="grow"><h3>${entry.name}</h3><div class="maker">${entry.maker} · ${entry.params}</div></div>
    </div>
    <div class="row wrap" style="gap:6px">
      ${entry.tags.includes('vision') && html`<span class="badge"><${Icon} name="eye" /> ${t('Images')}</span>`}
      ${entry.tags.includes('code') && html`<span class="badge"><${Icon} name="code" /> ${t('Coding')}</span>`}
      ${entry.tags.includes('moe') && html`<span class="badge"><${Icon} name="layers" /> MoE</span>`}
      ${entry.tags.includes('fast') && html`<span class="badge"><${Icon} name="zap" /> ${t('Fast')}</span>`}
      ${entry.tags.includes('big') && html`<span class="badge accent"><${Icon} name="hard-drive" /> ${t('Uses SSD')}</span>`}
      ${entry.tags.includes('uncensored') && html`<span class="badge warn" title=${t('The built-in refusals were taken out of this model.')}><${Icon} name="alert" /> ${t('Uncensored')}</span>`}
    </div>
    <p>${entry.about}</p>
    ${entry.error
      ? html`<div class="muted" style="font-size:13px">${t('Could not reach Hugging Face: {err}', { err: entry.error })}</div>`
      : html`<select class="select" value=${quant} onChange=${(e) => setQuant(e.target.value)}>
          ${entry.choices.map((c) => html`<option value=${c.quant}>${c.quant} · ${GBs(c.size)} — ${c.fit.label}${c.quant === entry.suggested ? ` (${t('suggested')})` : ''}</option>`)}
        </select>`}
    ${choice?.fit?.detail && (choice.fit.level === 'ssd' || choice.fit.ssd > 0) && html`<div class="muted" style="font-size:12.5px">${choice.fit.detail}</div>`}
    <div class="actions">
      ${choice && html`<${FitBadge} fit=${choice.fit} />`}
      <span class="grow"></span>
      ${local
        ? html`<button class="btn sm" onClick=${() => loadModel(local)}><${Icon} name="play" size="sm" /> ${t('Load')}</button>`
        : html`<button class="btn sm primary" disabled=${!choice || downloading} onClick=${() => onDownload(entry.repo, quant, choice)}>
            <${Icon} name="download" size="sm" /> ${downloading ? t('Downloading') : t('Download')}
          </button>`}
    </div>
  </div>`;
}

function HfSearch({ onDownload }) {
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState(null);
  const [open, setOpen] = useState(null); // { repo, choices, quant }
  const search = async (e) => {
    e.preventDefault();
    if (!q.trim()) return;
    setBusy(true);
    try {
      setResults((await api(`/api/hf/search?q=${encodeURIComponent(q.trim())}`)).results);
    } catch (err) {
      toastError(err);
    }
    setBusy(false);
  };
  const expand = async (repo) => {
    if (open?.repo === repo) return setOpen(null);
    setOpen({ repo, loading: true });
    try {
      const r = await api(`/api/hf/repo?repo=${encodeURIComponent(repo)}`);
      const pick = r.choices.find((c) => c.fit.level === 'great' && /Q4_K_M|Q4_K_XL/.test(c.quant)) || r.choices.find((c) => c.fit.level === 'great') || r.choices[0];
      setOpen({ repo, choices: r.choices, quant: pick?.quant });
    } catch (err) {
      toastError(err);
      setOpen(null);
    }
  };
  return html`<div class="section">
    <h2>${t('Search Hugging Face')}</h2>
    <p class="sub">${t('Any GGUF model on huggingface.co works. Search by name, like “qwen coder” or “llama 8b”.')}</p>
    <form class="row" onSubmit=${search} style="max-width:560px">
      <input class="input" placeholder=${t('Search models')} value=${q} onInput=${(e) => setQ(e.target.value)} />
      <button class="btn" disabled=${busy}>${busy ? html`<${Icon} name="loader" cls="spin" size="sm" />` : html`<${Icon} name="search" size="sm" />`} ${t('Search')}</button>
    </form>
    ${results && html`<div class="card list" style="margin-top:14px">
      ${!results.length && html`<div class="empty">${t('Nothing found.')}</div>`}
      ${results.map((r) => html`<div key=${r.repo}>
        <div class="list-row" style="cursor:pointer" onClick=${() => expand(r.repo)}>
          <${Icon} name=${open?.repo === r.repo ? 'chevron-down' : 'chevron-right'} size="sm" />
          <span class="grow ellipsis name">${r.repo}</span>
          <span class="muted" style="font-size:13px">${tn(r.downloads || 0, '{n} download', '{n} downloads', { n: (r.downloads || 0).toLocaleString(locale()) })}</span>
        </div>
        ${open?.repo === r.repo && html`<div class="list-row wrap" style="border-top:0;padding-top:0">
          ${open.loading
            ? html`<span class="muted"><${Icon} name="loader" cls="spin" size="sm" /> ${t('Reading files…')}</span>`
            : open.choices.length
              ? html`<select class="select" style="max-width:460px" value=${open.quant} onChange=${(e) => setOpen({ ...open, quant: e.target.value })}>
                  ${open.choices.map((c) => html`<option value=${c.quant}>${c.quant} · ${GBs(c.size)} — ${c.fit.label}</option>`)}
                </select>
                <button class="btn sm primary" onClick=${() => onDownload(open.repo, open.quant, open.choices.find((c) => c.quant === open.quant))}><${Icon} name="download" size="sm" /> ${t('Download')}</button>`
              : html`<span class="muted">${t('No GGUF model files in this repo.')}</span>`}
        </div>`}
      </div>`)}
    </div>`}
  </div>`;
}

export function ModelsPage({ route }) {
  const tab = route?.id === 'get' ? 'get' : 'mine';
  const { models, status, downloads, updates } = useStore();
  const [catalog, setCatalog] = useState(null);
  const [engines, setEngines] = useState(null);
  const [installing, setInstalling] = useState(false);
  const seenDone = useRef(new Set());

  const loadEngines = (backend) => api(`/api/engines${backend ? `?backend=${backend}` : ''}`).then(setEngines).catch(() => setEngines({ engines: [], latest: null }));
  useEffect(() => {
    refreshModels();
    refreshStatus();
    refreshUpdates();
    loadEngines();
    api('/api/catalog').then((r) => setCatalog(r.catalog)).catch((err) => { toastError(err); setCatalog([]); });
  }, []);

  // Watch downloads; when one finishes, refresh the lists and offer to load it.
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      await refreshDownloads();
      if (!alive) return;
      for (const d of getState().downloads) {
        if (d.state === 'done' && !seenDone.current.has(d.id)) {
          seenDone.current.add(d.id);
          if (Date.now() - d.createdAt < 24 * 3600e3 && d.finishedAt && Date.now() - d.finishedAt < 10000) {
            if (d.kind === 'engine') {
              toast(t('Engine installed. Load a model to use it.'));
              loadEngines();
              refreshUpdates();
              setInstalling(false);
            } else if (d.kind === 'model') {
              toast(t('{name} is ready to load', { name: d.label }));
              refreshModels();
            }
          }
        }
        if (d.kind === 'engine' && d.state === 'error') setInstalling(false);
      }
      const busy = getState().downloads.some((d) => d.state === 'downloading' || d.state === 'queued' || d.state === 'finishing');
      setTimeout(() => alive && tick(), busy ? 1000 : 4000);
    };
    tick();
    return () => {
      alive = false;
    };
  }, []);

  const download = async (repo, quant, choice) => {
    if (choice?.fit?.level === 'no' && !(await confirmDialog({ title: t('This size is too big'), text: t('{quant} needs about {size} of memory, more than this computer can give it. Download anyway?', { quant, size: GBs(choice.fit.need) }), ok: t('Download anyway') }))) return;
    try {
      await api('/api/models/download', { method: 'POST', body: { repo, quant } });
      toast(t('Download started'));
      refreshDownloads();
    } catch (err) {
      toastError(err);
    }
  };
  // The choice is saved at once, so it stays when the page refreshes and the next load uses it.
  const chooseBackend = async (backend) => {
    setEngines((e) => (e ? { ...e, backend } : e));
    try {
      setEngines(await api('/api/engines/backend', { method: 'POST', body: { backend } }));
    } catch (err) {
      toastError(err);
      loadEngines();
    }
  };
  const installEngine = async () => {
    setInstalling(true);
    try {
      await api('/api/engines/install', { method: 'POST', body: { backend: engines?.backend } });
      refreshDownloads();
    } catch (err) {
      setInstalling(false);
      toastError(err);
    }
  };
  const checkNow = async () => {
    try {
      set({ updates: await api('/api/updates/check', { method: 'POST' }) });
      const u = getState().updates;
      if (!u.engine && !u.images && !u.models.length) toast(t('Everything is up to date.'));
    } catch (err) {
      toastError(err);
    }
  };
  const activeRepos = new Set(downloads.filter((d) => d.kind === 'model' && (d.state === 'downloading' || d.state === 'queued')).map((d) => `${d.meta?.repo}|${d.meta?.quant}`));

  return html`<div class="page"><div class="page-inner">
    <${PageHead} title=${t('Models')} text=${t('Pick a model to run on this computer. Hearth suggests the size that fits.')}>
      <button class="btn" onClick=${() => api('/api/reveal', { method: 'POST', body: { what: 'models' } })}><${Icon} name="folder" size="sm" /> ${t('Models folder')}</button>
      <button class="btn" onClick=${checkNow} title=${t('Look for a newer engine and changed model files')}><${Icon} name="arrow-up-circle" size="sm" /> ${t('Check for updates')}</button>
      <button class="btn" onClick=${() => { refreshModels(); loadEngines(); }}><${Icon} name="refresh-cw" size="sm" /> ${t('Refresh')}</button>
    <//>

    <div class="tabs">
      <button class=${tab === 'mine' ? 'on' : ''} onClick=${() => go('#/models')}><${Icon} name="hard-drive" size="sm" /> ${t('Your models')}${models.filter((m) => m.kind === 'chat').length ? html` <span class="tab-count">${models.filter((m) => m.kind === 'chat').length}</span>` : ''}</button>
      <button class=${tab === 'get' ? 'on' : ''} onClick=${() => go('#/models/get')}><${Icon} name="download" size="sm" /> ${t('Get models')}</button>
    </div>

    ${tab === 'mine'
      ? html`
        <${HardwareCards} status=${status} engines=${engines} onBackend=${chooseBackend} onRecheck=${() => loadEngines()} onReload=${() => status?.engine?.model && loadModel(status.engine.model)} onInstall=${installEngine} installing=${installing || downloads.some((d) => d.kind === 'engine' && (d.state === 'downloading' || d.state === 'finishing'))} />
        <${LoadedCard} status=${status} />
        <${Updates} updates=${updates} onEngine=${installEngine} />
        <${Downloads} downloads=${downloads} kinds=${['model', 'engine']} />
        <${LocalModels} models=${models} status=${status} />`
      : html`
        <${Downloads} downloads=${downloads.filter((d) => d.state === 'downloading' || d.state === 'queued' || d.state === 'finishing')} kinds=${['model', 'engine']} />
        <${Catalog} catalog=${catalog} onDownload=${download} activeRepos=${activeRepos} />
        <${HfSearch} onDownload=${download} />`}
  </div></div>`;
}

// The hand-picked models, grouped by the computer they suit, with filters for what the user wants.
const GROUPS = () => [
  { id: 'small', title: t('Small and quick'), text: t('For any computer, including laptops without much memory.') },
  { id: 'medium', title: t('Medium'), text: t('Stronger writers and coders, for computers with 16 GB or more.') },
  { id: 'big', title: t('Big models'), text: t('The strongest open models. Hearth keeps their lookup tables and spare experts on the SSD, so they need a fast SSD and plenty of memory.') },
];

const runsHere = (e) => {
  const fit = e.choices?.find((c) => c.quant === e.suggested)?.fit;
  return Boolean(fit && ['great', 'ok', 'ssd'].includes(fit.level));
};

const FILTERS = () => [
  { id: 'all', label: t('All'), test: () => true },
  { id: 'fits', label: t('Runs on this computer'), icon: 'check', test: runsHere },
  { id: 'vision', label: t('Images'), icon: 'eye', test: (e) => e.tags.includes('vision') },
  { id: 'code', label: t('Coding'), icon: 'code', test: (e) => e.tags.includes('code') },
  { id: 'fast', label: t('Fast'), icon: 'zap', test: (e) => e.tags.includes('fast') },
  { id: 'uncensored', label: t('Uncensored'), icon: 'alert', test: (e) => e.tags.includes('uncensored') },
];

function Catalog({ catalog, onDownload, activeRepos }) {
  const [filter, setFilter] = useState(() => {
    try {
      return localStorage.getItem('hearth.modelFilter') || 'all';
    } catch {
      return 'all';
    }
  });
  const pick = (id) => {
    setFilter(id);
    try {
      localStorage.setItem('hearth.modelFilter', id);
    } catch {}
  };
  const filters = FILTERS();
  const active = filters.find((f) => f.id === filter) || filters[0];
  return html`<div class="section">
    <p class="sub" style="margin-top:0">${t('Hand-picked models from Hugging Face. Sizes marked “Runs well” fit this computer comfortably.')}</p>
    <div class="row wrap" style="gap:6px;margin-bottom:6px">
      ${filters.map((f) => {
        const n = catalog ? catalog.filter(f.test).length : 0;
        return html`<button class=${`chip-btn outline filter ${f.id === active.id ? 'on' : ''}`} onClick=${() => pick(f.id)}>${f.icon && html`<${Icon} name=${f.icon} size="sm" />`} ${f.label}${catalog ? html` <span class="muted">${n}</span>` : ''}</button>`;
      })}
    </div>
    ${catalog == null
      ? html`<div class="card empty"><${Icon} name="loader" cls="spin" /> ${t('Asking Hugging Face for the latest files…')}</div>`
      : GROUPS().map((g) => {
          const list = catalog.filter((e) => (e.group || 'medium') === g.id && active.test(e));
          if (!list.length) return null;
          return html`<div class="section" style="margin-top:22px">
            <h2>${g.title} <span class="muted" style="font-weight:500;font-size:14px">${list.length}</span></h2>
            <p class="sub">${g.text}</p>
            <div class="grid c3">${list.map((e) => html`<${CatalogCard} key=${e.repo} entry=${e} onDownload=${onDownload} downloading=${[...activeRepos].some((k) => k.startsWith(`${e.repo}|`))} />`)}</div>
          </div>`;
        })}
    ${catalog && !catalog.some(active.test) && html`<div class="card empty">${t('No hand-picked model matches. Try another filter, or search Hugging Face below.')}</div>`}
  </div>`;
}
