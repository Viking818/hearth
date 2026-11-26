// One model's own settings: conversation context, drafting, how much of the computer it may take, pictures, and for
// experts the context memory, low-memory mode, several models at once and extra engine options. Named sets of
// settings can be saved and applied to any model, and a speed test shows what a choice does on this computer.
import { html, useState, useEffect, useRef } from '../vendor/preact-htm.js';
import { Icon } from './icons.js';
import { t } from './i18n.js';
import { api, toast, toastError, set, getState, refreshModels, refreshStatus, pollEngine, fmtMem, fmtDec, fmtDuration, fmtBytes } from './store.js';
import { Popover, Toggle, FitBadge, promptDialog } from './ui.js';

const CTX = [8192, 16384, 32768, 65536, 131072, 262144];

function Field({ label, children, hint }) {
  return html`<div class="field"><span>${label}</span>${children}${hint && html`<small class="muted">${hint}</small>`}</div>`;
}

export function ModelSettingsDialog({ model, onClose }) {
  const [data, setData] = useState(null);
  const [v, setV] = useState(null);
  const [plan, setPlan] = useState(null);
  const [uses, setUses] = useState('');
  const [presets, setPresets] = useState([]);
  const [busy, setBusy] = useState('');
  const [test, setTest] = useState(null);
  const [testLoads, setTestLoads] = useState(false); // the test (re)loads the model first
  const [dirty, setDirty] = useState(false);
  const [tests, setTests] = useState({}); // the last test with each engine
  const [colibri, setColibri] = useState(null);
  const timer = useRef(0);

  useEffect(() => {
    api(`/api/models/${model.id}/settings`)
      .then((d) => {
        setData(d);
        const { lastTest, tests: byEngine, ...s } = d.settings;
        setV(s);
        setTests(byEngine || {});
        setColibri(d.colibri || null);
        setPlan(d.plan);
        setUses(d.options?.draftingUses || '');
        setPresets(d.presets);
        setTest(lastTest);
      })
      .catch((err) => {
        toastError(err);
        onClose();
      });
  }, [model.id]);

  // The memory estimate follows every change, like the size next to a version in Strata.
  const latest = useRef(null); // the newest values, so quick changes in a row all count
  latest.current = latest.current || v;
  const change = (patch) => {
    const next = { ...latest.current, ...patch };
    latest.current = next;
    setV(next);
    setDirty(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => api(`/api/models/${model.id}/plan`, { method: 'POST', body: next }).then((r) => { setPlan(r.plan); setUses(r.options?.draftingUses || ''); }).catch(() => {}), 200);
  };

  const save = async () => {
    await api(`/api/models/${model.id}/settings`, { method: 'PUT', body: latest.current || v });
    setDirty(false);
    refreshModels();
  };
  const loaded = getState().status?.engine?.loaded?.find((r) => r.model?.id === model.id && (r.status === 'ready' || r.status === 'starting'));
  const saveAndLoad = async () => {
    setBusy('load');
    try {
      await save();
      await api('/api/engine/start', { method: 'POST', body: { id: model.id } });
      pollEngine();
      toast(loaded ? t('Reloading with the new settings…') : t('Loading…'));
      onClose();
    } catch (err) {
      toastError(err);
    }
    setBusy('');
  };
  const runTest = async () => {
    setBusy('test');
    setTestLoads(!loaded || dirty);
    try {
      if (dirty || loaded) await save();
      // Hearth reloads the model itself when its saved settings changed, and waits for it before testing.
      pollEngine();
      const r = await api(`/api/models/${model.id}/speedtest`, { method: 'POST' });
      setTest(r);
      setTests((x) => ({ ...x, [r.engine || 'llama']: r }));
      refreshStatus();
    } catch (err) {
      toastError(err);
    }
    setBusy('');
  };
  // Colibri, the second engine: downloaded once (about 30 MB with its Python on Windows), on the computer itself.
  const installColibri = async () => {
    try {
      await api('/api/colibri/install', { method: 'POST' });
      for (let i = 0; i < 600; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        const st = await api('/api/colibri');
        setColibri((c) => ({ ...c, ...st }));
        if (st.installed || (!st.job && st.error)) {
          if (st.error && !st.installed) toastError(new Error(st.error));
          else toast(t('Colibri {tag} is ready.', { tag: st.installed.tag }));
          break;
        }
      }
    } catch (err) {
      toastError(err);
    }
  };
  const savePresetAs = async () => {
    const name = await promptDialog({ title: t('Save these settings'), placeholder: t('For example: Long documents'), ok: t('Save') });
    if (!name?.trim()) return;
    try {
      await api('/api/presets', { method: 'POST', body: { name, settings: latest.current || v } });
      setPresets((await api('/api/presets')).presets);
      toast(t('Saved'));
    } catch (err) {
      toastError(err);
    }
  };
  const deletePreset = async (id) => setPresets((await api(`/api/presets/${id}`, { method: 'DELETE' })).presets);
  const setMulti = async (on) => {
    const next = await api('/api/settings', { method: 'PUT', body: { multiModel: on } });
    set({ status: { ...getState().status, settings: next } });
    setData({ ...data, general: { ...data.general, multiModel: on } });
  };

  if (!data || !v) return html`<div class="overlay"><div class="dialog"><${Icon} name="loader" cls="spin" /></div></div>`;
  const g = data.general;
  const maxCtx = model.ctxTrain || 262144;
  const hasPictures = Boolean(model.mmproj);
  const draft = (model.drafts || [])[0];
  const moe = Boolean(model.moe);
  const useColibri = v.engine === 'colibri';
  const colibriMissing = useColibri && !colibri?.installed;
  const job = colibri?.job;
  return html`<div class="overlay" onMouseDown=${(e) => e.target === e.currentTarget && onClose()}>
    <div class="dialog wide msettings">
      <div class="row" style="align-items:flex-start">
        <div class="grow">
          <h3 style="margin:0">${model.name}</h3>
          <div class="row wrap muted" style="gap:8px;font-size:13px;margin-top:4px">${model.quant && html`<span class="badge">${model.quant}</span>`}<span>${model.sourceLabel}</span>${loaded && html`<span class="badge ok">${t('Loaded')}</span>`}</div>
        </div>
        <button class="icon-btn" title=${t('Close')} onClick=${onClose}><${Icon} name="x" /></button>
      </div>

      ${!useColibri && html`<div class="ms-version">
        <div class="grow" style="min-width:0">
          <div class="ms-need">${plan ? t('About {size} of memory', { size: fmtMem(plan.need) }) : '–'}</div>
          ${plan?.detail && html`<div class="muted" style="font-size:13px">${plan.detail}</div>`}
        </div>
        <${FitBadge} fit=${plan} />
      </div>`}

      ${colibri?.supported && colibri?.available && html`<div class="ms-row ms-engine">
        <div class="grow" style="min-width:0">
          <b>${t('Engine')}</b> ${useColibri && html`<span class="badge">${t('experimental')}</span>`}<br />
          <span class="muted" style="font-size:13px">${useColibri ? t('Colibri keeps the most used experts on the graphics card, the others in memory and the rest on the disk, and an agent’s next turn reads only what is new. It plans the memory itself. Compare the two with the speed test.') : t('llama.cpp, the usual engine. Colibri is a second engine made for big mixture-of-experts models like this one.')}</span>
          ${colibriMissing && html`<div class="row" style="gap:8px;margin-top:8px">${job
            ? html`<span class="muted"><${Icon} name="loader" cls="spin" size="sm" /> ${job.state === 'finishing' ? t('Setting up Colibri…') : t('Downloading Colibri… {pct}%', { pct: job.total ? Math.round((job.done / job.total) * 100) : 0 })}</span>`
            : html`<button class="btn sm primary" onClick=${installColibri}><${Icon} name="download" size="sm" /> ${colibri.python?.private ? t('Download Colibri (about 30 MB, with its Python)') : t('Download Colibri (about 20 MB)')}</button>${colibri.error && html`<span class="bad-text" style="font-size:12.5px">${colibri.error}</span>`}`}</div>`}
          ${useColibri && colibri?.installed && html`<div class="faint" style="font-size:12.5px;margin-top:4px">${t('Colibri {tag} is installed.', { tag: colibri.installed.tag })}</div>`}
        </div>
        <div class="seg" style="align-self:flex-start">
          <button class=${!useColibri ? 'on' : ''} onClick=${() => change({ engine: 'llama' })}>llama.cpp</button>
          <button class=${useColibri ? 'on' : ''} onClick=${() => change({ engine: 'colibri' })}>Colibri</button>
        </div>
      </div>`}

      <div class="grid c2">
        <${Field} label=${t('Conversation context')}>
          <select class="select" value=${v.ctx} onChange=${(e) => change({ ctx: Number(e.target.value) })}>
            <option value="0">${t('As in Settings ({n}K)', { n: Math.round(Math.min(g.contextSize, maxCtx) / 1024) })}</option>
            ${CTX.filter((c) => c <= maxCtx).map((c) => html`<option value=${c}>${t('{n}K tokens', { n: c / 1024 })}</option>`)}
          </select>
        <//>
        ${!useColibri && html`<${Field} label=${t('Drafting')} hint=${g.speculative === 'off' ? t('Turned off for all models in Settings.') : `${uses === 'mtp' ? t('Uses the MTP draft {name} ({size}): it guesses the next words, the model checks them. Same answers, faster.', { name: draft?.name || '', size: fmtBytes(draft?.size || 0) }) : uses === 'ngram' ? t('Uses guesses from the text itself: much faster for code and edits, the same for new text.') : t('No guessing: every word is worked out one by one.')}${v.drafting === 'auto' && draft && uses === 'ngram' ? ` ${t('The MTP draft is skipped: it would push the model out of graphics memory and slow it down.')}` : ''}`}>
          <select class="select" value=${v.drafting} onChange=${(e) => change({ drafting: e.target.value })}>
            <option value="auto">${t('Automatic (recommended)')}</option>
            <option value="mtp" disabled=${!draft}>${t('MTP draft')}</option>
            <option value="ngram">${t('Guesses from the text')}</option>
            <option value="off">${t('Off')}</option>
          </select>
        <//>`}
      </div>

      ${!useColibri && html`<${Field} label=${t('Computer use')} hint=${v.computer === 'leave20' ? t('The model leaves a fifth of the processor and graphics memory free, so other apps stay quick. Big models get a little slower.') : t('The model may use the whole processor and all the graphics memory it can get.')}>
        <div class="seg" style="align-self:flex-start">
          <button class=${v.computer === 'leave20' ? 'on' : ''} onClick=${() => change({ computer: 'leave20' })}>${t('Leave 20% for my work')}</button>
          <button class=${v.computer === 'full' ? 'on' : ''} onClick=${() => change({ computer: 'full' })}>${t('Full performance')}</button>
        </div>
      <//>`}

      ${hasPictures && !useColibri &&
      html`<div class="ms-row">
        <label class="row grow" style="align-items:flex-start;gap:10px;cursor:pointer">
          <input type="checkbox" class="check" checked=${v.vision} onChange=${(e) => change({ vision: e.target.checked })} />
          <span><b>${t('Read pictures')}</b> <span class="muted" style="font-size:12.5px">${t('On by default')}</span><br /><span class="muted" style="font-size:13px">${g.vision ? t('Understand photos, screenshots and charts. Turn it off to save memory.') : t('Pictures are turned off for all models in Settings.')}</span></span>
        </label>
        <select class="select" style="width:auto" disabled=${!v.vision || !g.vision} value=${v.visionOn} onChange=${(e) => change({ visionOn: e.target.value })}>
          <option value="auto">${t('Automatic')}</option>
          <option value="cpu">${t('On the processor (saves graphics memory)')}</option>
        </select>
      </div>`}

      <div class="ms-expert">
        <b>${t('Expert settings')}</b>
        <div class="ms-row">
          <div class="grow"><b>${t('Run several models')}</b><br /><span class="muted" style="font-size:13px">${t('Loading another model keeps this one loaded. Apps choose a model by its name; the chat uses the last one loaded. Applies to all models.')}</span></div>
          <${Toggle} on=${g.multiModel} onChange=${setMulti} />
        </div>
        ${!useColibri && html`<div class="grid c2">
          <${Field} label=${t('Context memory')} hint=${t('INT8 halves the memory a long conversation takes, with almost no change in answers.')}>
            <select class="select" value=${v.kv} onChange=${(e) => change({ kv: e.target.value })}>
              <option value="auto">${t('Automatic (INT8 from 64K)')}</option>
              <option value="f16">${t('Full precision (F16)')}</option>
              <option value="q8_0">INT8</option>
              <option value="q4_0">${t('INT4 (least memory)')}</option>
            </select>
          <//>
          <${Field} label=${t('Low-RAM mode')} hint=${moe ? t('For a computer short on memory: the experts stay in the model file and are read from the SSD. Much slower.') : t('Only for mixture-of-experts models.')}>
            <select class="select" value=${v.lowRam} disabled=${!moe} onChange=${(e) => change({ lowRam: e.target.value })}>
              <option value="auto">${t('Automatic')}</option>
              <option value="ssd">${t('Experts from the SSD')}</option>
            </select>
          <//>
        </div>
        <${Field} label=${t('Extra engine options for this model')}>
          <input class="input mono" value=${v.args} placeholder=${t('Optional, e.g. --n-cpu-moe 10')} onInput=${(e) => change({ args: e.target.value })} />
        <//>`}
      </div>

      <div class="ms-foot">
        <${Popover} button=${({ toggle }) => html`<button class="btn sm" onClick=${toggle}><${Icon} name="layers" size="sm" /> ${t('Saved settings')} <${Icon} name="chevron-down" size="sm" /></button>`}>
          ${!presets.length && html`<div class="pop-item muted">${t('Nothing saved yet')}</div>`}
          ${presets.map((p) => html`<div class="pop-item" key=${p.id}>
            <button class="grow" style="text-align:left" data-close onClick=${() => { change({ ...p.settings }); toast(t('Applied “{name}”. Save to keep it.', { name: p.name })); }}>${p.name}</button>
            <button class="icon-btn" style="width:24px;height:24px" title=${t('Delete')} onClick=${() => deletePreset(p.id)}><${Icon} name="x" size="sm" /></button>
          </div>`)}
          <div class="pop-sep"></div>
          <button class="pop-item" data-close onClick=${savePresetAs}><${Icon} name="save" size="sm" /> ${t('Save these settings as…')}</button>
        <//>
        <span class="grow ms-test">${busy === 'test'
          ? html`<${Icon} name="loader" cls="spin" size="sm" /> ${testLoads ? t('Loading the model and measuring…') : t('Measuring…')}`
          : tests.llama && tests.colibri
            ? html`${['llama', 'colibri'].map((k) => html`<span class="ms-cmp">${k === 'llama' ? 'llama.cpp' : 'Colibri'}: ${t('reading {read} · writing {write} tok/s', { read: fmtDec(tests[k].read, 0), write: fmtDec(tests[k].write) })}</span>`)}`
            : test
              ? html`${t('Reading {read} tok/s · writing {write} tok/s', { read: fmtDec(test.read, 0), write: fmtDec(test.write) })}${test.loadMs ? ` · ${t('loaded in {time}', { time: fmtDuration(test.loadMs) })}` : ''}`
              : ''}</span>
        <button class="btn" disabled=${!!busy || colibriMissing} onClick=${runTest} title=${t('Load the model with these settings and measure how fast it reads and writes')}><${Icon} name="gauge" size="sm" /> ${t('Speed test')}</button>
        <button class="btn" disabled=${!!busy || !dirty} onClick=${async () => { try { await save(); toast(t('Saved. Reload the model to use it.')); } catch (err) { toastError(err); } }}>${t('Save')}</button>
        <button class="btn primary" disabled=${!!busy || colibriMissing} onClick=${saveAndLoad}><${Icon} name="play" size="sm" /> ${loaded ? t('Save and reload') : t('Save and load')}</button>
      </div>
    </div>
  </div>`;
}

export function openModelSettings(model) {
  set({ modelSettings: model });
}

