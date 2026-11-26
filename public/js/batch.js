// Batch page: one instruction for many photos or files, answered as a table you can edit and save for Excel or a shop.
import { html, useState, useEffect, useRef } from '../vendor/preact-htm.js';
import { Icon } from './icons.js';
import { t, tn, locale } from './i18n.js';
import { useStore, api, toast, toastError, go, fmtDuration, saveFile, getState } from './store.js';
import { confirmDialog, PageHead } from './ui.js';
import { uploadImage, loadPdfjs } from './chat.js';
import { DOC_EXT, extractDocument } from './docs.js';
import { xlsxBlob, csvText } from './xlsx.js';

const PRESETS = () => [
  {
    id: 'product',
    name: t('Product listing'),
    instruction: t('This is a product photo for an online shop. Write a catchy title, a selling description of 2–4 sentences, and 10–15 search tags separated by commas. Describe only what you can see.'),
    fields: [
      { name: t('Title'), hint: t('at most 70 characters') },
      { name: t('Description'), hint: t('2–4 sentences') },
      { name: t('Tags'), hint: t('separated by commas') },
    ],
  },
  {
    id: 'alt',
    name: t('Alt text for photos'),
    instruction: t('Write a short alt text for this image, for people who can’t see it and for search engines.'),
    fields: [{ name: t('Alt text'), hint: t('one sentence') }],
  },
  {
    id: 'social',
    name: t('Social media caption'),
    instruction: t('Write a short social media caption for this picture with a call to action, and fitting hashtags.'),
    fields: [
      { name: t('Caption'), hint: t('1–3 sentences') },
      { name: t('Hashtags'), hint: t('5–10, separated by spaces') },
    ],
  },
  {
    id: 'summary',
    name: t('Document summary'),
    instruction: t('Read this document and summarize it.'),
    fields: [
      { name: t('Summary'), hint: t('3–5 sentences') },
      { name: t('Key facts'), hint: t('dates, amounts, names; separated by semicolons') },
    ],
  },
  { id: 'custom', name: t('My own'), instruction: '', fields: [{ name: t('Answer'), hint: '' }] },
];

const STATUS = () => ({ queued: t('Waiting'), running: t('Working'), done: t('Done'), stopped: t('Stopped'), error: t('Failed') });
const BADGE = { queued: '', running: 'accent', done: 'ok', stopped: 'warn', error: 'bad' };

function NewBatch({ onCreated }) {
  const [items, setItems] = useState([]); // {id, kind, name, url?, text?, busy}
  const [preset, setPreset] = useState('product');
  const presets = PRESETS();
  const [instruction, setInstruction] = useState(presets[0].instruction);
  const [fields, setFields] = useState(presets[0].fields);
  const [drag, setDrag] = useState(false);
  const [busy, setBusy] = useState(false);
  const input = useRef(null);
  const pickPreset = (id) => {
    const p = presets.find((x) => x.id === id);
    setPreset(id);
    if (p.instruction || id === 'custom') setInstruction(p.instruction);
    setFields(p.fields.map((f) => ({ ...f })));
  };
  const add = async (list) => {
    for (const file of list) {
      const id = Math.random().toString(36).slice(2);
      if (file.type.startsWith('image/')) {
        setItems((x) => [...x, { id, kind: 'image', name: file.name, url: URL.createObjectURL(file), busy: true }]);
        try {
          const r = await uploadImage(file);
          setItems((x) => x.map((it) => (it.id === id ? { ...it, url: r.url, busy: false } : it)));
        } catch (err) {
          setItems((x) => x.filter((it) => it.id !== id));
          toastError(err);
        }
      } else if (DOC_EXT.test(file.name) || /\.(txt|md|csv|json|html?)$/i.test(file.name)) {
        setItems((x) => [...x, { id, kind: 'text', name: file.name, busy: true }]);
        try {
          let text;
          if (DOC_EXT.test(file.name)) {
            const bytes = new Uint8Array(await file.arrayBuffer());
            text = (await extractDocument(file.name, bytes, { pdfjs: /\.pdf$/i.test(file.name) ? await loadPdfjs() : null, maxChars: 60000 })).text;
          } else text = (await file.text()).slice(0, 60000);
          setItems((x) => x.map((it) => (it.id === id ? { ...it, text, busy: false } : it)));
        } catch (err) {
          setItems((x) => x.filter((it) => it.id !== id));
          toast(t('Could not read {name}: {err}', { name: file.name, err: err.message || err }), 'bad');
        }
      } else toast(t('{name}: add photos, documents or text files.', { name: file.name }), 'bad');
    }
  };
  const start = async () => {
    if (items.some((i) => i.busy)) return toast(t('Wait a moment, the files are still being read.'));
    setBusy(true);
    try {
      const job = await api('/api/batches', { method: 'POST', body: { title: presets.find((p) => p.id === preset)?.name, instruction, fields, items: items.map(({ kind, name, url, text }) => ({ kind, name, url, text })) } });
      setItems([]);
      onCreated(job.id);
    } catch (err) {
      toastError(err);
    }
    setBusy(false);
  };
  const images = items.filter((i) => i.kind === 'image').length;
  const st = getState().status;
  const vision = st?.engine?.vision || getState().models.find((m) => m.id === st?.settings?.lastModel?.id)?.vision;
  return html`<div class="card pad col" style="gap:16px">
    <div
      class=${`dropzone ${drag ? 'drag' : ''}`}
      onClick=${() => input.current.click()}
      onDragOver=${(e) => { e.preventDefault(); setDrag(true); }}
      onDragLeave=${() => setDrag(false)}
      onDrop=${(e) => { e.preventDefault(); setDrag(false); add([...e.dataTransfer.files]); }}
    >
      <${Icon} name="upload" />
      <b>${t('Drop photos or files here')}</b>
      <span class="muted">${t('or click to choose. Photos, PDF, Word, Excel and text files; up to 2000 at once.')}</span>
      <input ref=${input} type="file" multiple hidden accept="image/*,.pdf,.docx,.xlsx,.pptx,.odt,.txt,.md,.csv,.json,.html" onChange=${(e) => { add([...e.target.files]); e.target.value = ''; }} />
    </div>
    ${items.length > 0 && html`<div class="batch-items">
      ${items.slice(0, 60).map((it) => html`<div class="bitem" key=${it.id} title=${it.name}>
        ${it.kind === 'image' ? html`<img src=${it.url} alt="" />` : html`<div class="bdoc"><${Icon} name="file-text" /></div>`}
        ${it.busy && html`<div class="loading"><${Icon} name="loader" cls="spin" /></div>`}
        <button class="x" title=${t('Remove')} onClick=${() => setItems((x) => x.filter((i) => i.id !== it.id))}><${Icon} name="x" /></button>
      </div>`)}
      ${items.length > 60 && html`<div class="bmore">+${items.length - 60}</div>`}
    </div>
    <div class="row"><span class="muted">${tn(items.length, '{n} item', '{n} items')}</span><span class="grow"></span><button class="btn sm" onClick=${() => setItems([])}>${t('Clear')}</button></div>`}
    ${images > 0 && vision === false && html`<div class="notice warn"><${Icon} name="alert" /><div>${t('The loaded model can’t see images. Load one that does (Models → “sees images”).')}</div></div>`}
    <div class="field"><span>${t('What to do with each item')}</span>
      <div class="seg wrap" style="margin-bottom:8px">${presets.map((p) => html`<button class=${preset === p.id ? 'on' : ''} onClick=${() => pickPreset(p.id)}>${p.name}</button>`)}</div>
      <textarea class="textarea" value=${instruction} onInput=${(e) => setInstruction(e.target.value)} placeholder=${t('For example: Write a title and a short description for this T-shirt design.')}></textarea>
    </div>
    <div class="field"><span>${t('Columns of the table')}</span>
      <div class="col" style="gap:8px">
        ${fields.map((f, i) => html`<div class="row" key=${i}>
          <input class="input" style="max-width:220px" value=${f.name} placeholder=${t('Column name')} onInput=${(e) => setFields(fields.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
          <input class="input grow" value=${f.hint} placeholder=${t('Hint for the model (optional), e.g. “at most 70 characters”')} onInput=${(e) => setFields(fields.map((x, j) => (j === i ? { ...x, hint: e.target.value } : x)))} />
          <button class="icon-btn" title=${t('Remove')} disabled=${fields.length < 2} onClick=${() => setFields(fields.filter((_, j) => j !== i))}><${Icon} name="x" size="sm" /></button>
        </div>`)}
        <div><button class="btn sm" onClick=${() => setFields([...fields, { name: '', hint: '' }])}><${Icon} name="plus" size="sm" /> ${t('Add a column')}</button></div>
      </div>
    </div>
    <div class="row"><span class="grow muted" style="font-size:13px">${t('It runs on this computer, one item after another, and goes on if you close this window.')}</span>
      <button class="btn primary lg" disabled=${busy || !items.length || !instruction.trim() || !fields.some((f) => f.name.trim())} onClick=${start}><${Icon} name="play" size="sm" /> ${t('Start')}</button></div>
  </div>`;
}

function Cell({ value, onSave }) {
  const [edit, setEdit] = useState(null);
  if (edit != null)
    return html`<textarea class="cell-edit" autofocus value=${edit} onInput=${(e) => setEdit(e.target.value)} onBlur=${() => { if (edit !== value) onSave(edit); setEdit(null); }} onKeyDown=${(e) => { if (e.key === 'Escape') setEdit(null); if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) e.currentTarget.blur(); }}></textarea>`;
  return html`<div class="cell" title=${t('Click to edit')} onClick=${() => setEdit(value || '')}>${value || html`<span class="faint">—</span>`}</div>`;
}

function BatchView({ id }) {
  const [job, setJob] = useState(null);
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const j = await api(`/api/batches/${id}`);
        if (!alive) return;
        setJob(j);
        setTimeout(() => alive && tick(), j.status === 'running' || j.status === 'queued' ? 1500 : 6000);
      } catch (err) {
        if (alive) {
          toastError(err);
          go('#/batch');
        }
      }
    };
    tick();
    return () => {
      alive = false;
    };
  }, [id]);
  if (!job) return html`<div class="card empty"><${Icon} name="loader" cls="spin" /></div>`;
  const done = job.items.filter((i) => i.status === 'done').length;
  const failed = job.items.filter((i) => i.status === 'error').length;
  const running = job.status === 'running' || job.status === 'queued';
  const times = job.items.filter((i) => i.ms).map((i) => i.ms);
  const avg = times.length ? times.reduce((a, b) => a + b, 0) / times.length : 0;
  const left = job.items.length - done - failed;
  const act = async (path, method = 'POST') => {
    try {
      setJob(await api(`/api/batches/${id}${path}`, { method }));
    } catch (err) {
      toastError(err);
    }
  };
  const del = async () => {
    if (!(await confirmDialog({ title: t('Delete this batch?'), text: t('The table is removed. The photos stay in Hearth’s uploads folder.'), ok: t('Delete'), danger: true }))) return;
    await api(`/api/batches/${id}`, { method: 'DELETE' }).catch(toastError);
    go('#/batch');
  };
  const rows = () => [[t('File'), ...job.fields.map((f) => f.name)], ...job.items.map((it) => [it.name, ...job.fields.map((f) => it.result?.[f.name] || '')])];
  const base = (job.title || 'batch').replace(/[^\p{L}\p{N}\s-]/gu, '').trim().slice(0, 40) || 'batch';
  const saveCell = async (it, field, value) => {
    try {
      await api(`/api/batches/${id}/items/${it.id}`, { method: 'PUT', body: { field, value } });
      setJob({ ...job, items: job.items.map((x) => (x.id === it.id ? { ...x, result: { ...x.result, [field]: value } } : x)) });
    } catch (err) {
      toastError(err);
    }
  };
  return html`<div class="col" style="gap:14px">
    <div class="card pad col" style="gap:12px">
      <div class="row wrap">
        <b style="font-size:16px" class="grow">${job.title}</b>
        <span class=${`badge ${BADGE[job.status] || ''}`}>${running ? html`<${Icon} name="loader" cls="spin" />` : ''} ${STATUS()[job.status] || job.status}</span>
      </div>
      <div class="progress"><i style=${{ width: `${(done / job.items.length) * 100}%` }}></i></div>
      <div class="row wrap" style="gap:8px">
        <span class="muted grow">${t('{done} of {total} done', { done, total: job.items.length })}${failed ? ` · ${tn(failed, '{n} failed', '{n} failed')}` : ''}${running && avg && left ? ` · ${t('about {time} left', { time: fmtDuration(avg * left) })}` : ''}</span>
        ${running && html`<button class="btn sm" onClick=${() => act('/stop')}><${Icon} name="pause" size="sm" /> ${t('Stop')}</button>`}
        ${!running && left > 0 && html`<button class="btn sm primary" onClick=${() => act('/resume')}><${Icon} name="play" size="sm" /> ${t('Continue')}</button>`}
        ${!running && failed > 0 && html`<button class="btn sm" onClick=${() => act('/resume?failed=1')}><${Icon} name="rotate-ccw" size="sm" /> ${t('Retry failed')}</button>`}
        <button class="btn sm" disabled=${!done} onClick=${() => saveFile(`${base}.xlsx`, xlsxBlob(rows(), { sheet: base, widths: [24, ...job.fields.map(() => 48)] }))}><${Icon} name="file-spreadsheet" size="sm" /> Excel</button>
        <button class="btn sm" disabled=${!done} onClick=${() => saveFile(`${base}.csv`, csvText(rows()), 'text/csv')}><${Icon} name="download" size="sm" /> CSV</button>
        <button class="icon-btn" title=${t('Delete')} onClick=${del}><${Icon} name="trash" size="sm" /></button>
      </div>
      ${job.error && html`<div class="notice bad"><${Icon} name="alert" /><div>${job.error}</div></div>`}
    </div>
    <div class="card" style="overflow-x:auto">
      <table class="table batch-table">
        <thead><tr><th style="width:84px"></th>${job.fields.map((f) => html`<th>${f.name}</th>`)}</tr></thead>
        <tbody>
          ${job.items.map((it) => html`<tr key=${it.id}>
            <td class="bthumb" title=${it.name}>
              ${it.kind === 'image' ? html`<img src=${it.url} alt="" />` : html`<div class="bdoc sm"><${Icon} name="file-text" size="sm" /></div>`}
              <div class="bname ellipsis">${it.name}</div>
              ${it.status === 'working' && html`<span class="badge accent"><${Icon} name="loader" cls="spin" /></span>`}
              ${it.status === 'error' && html`<span class="badge bad" title=${it.error}>${t('Failed')}</span>`}
            </td>
            ${job.fields.map((f) => html`<td>${it.status === 'error' && !it.result?.[f.name] ? html`<span class="muted" style="font-size:13px">${it.error}</span>` : html`<${Cell} value=${it.result?.[f.name] || ''} onSave=${(v) => saveCell(it, f.name, v)} />`}</td>`)}
          </tr>`)}
        </tbody>
      </table>
    </div>
  </div>`;
}

export function BatchPage({ route }) {
  const [list, setList] = useState(null);
  const load = () => api('/api/batches').then((r) => setList(r.batches)).catch(() => setList([]));
  useEffect(() => {
    load();
    const timer = setInterval(load, 5000);
    return () => clearInterval(timer);
  }, []);
  const id = route?.id;
  return html`<div class="page"><div class="page-inner">
    <${PageHead} title=${t('Batch')} text=${t('One instruction for many photos or files. The answers come as a table you can edit and save for Excel or your shop.')}>
      ${id && html`<button class="btn" onClick=${() => go('#/batch')}><${Icon} name="plus" size="sm" /> ${t('New batch')}</button>`}
    <//>
    ${id ? html`<${BatchView} id=${id} />` : html`<${NewBatch} onCreated=${(jid) => { load(); go(`#/batch/${jid}`); }} />`}
    ${list?.length > 0 &&
    html`<div class="section">
      <h2>${t('Earlier batches')}</h2>
      <div class="card list">
        ${list.map((b) => html`<a class=${`list-row link ${b.id === id ? 'active' : ''}`} href=${`#/batch/${b.id}`} key=${b.id}>
          <${Icon} name="table" size="sm" />
          <span class="grow ellipsis name">${b.title}</span>
          <span class="muted" style="font-size:13px">${t('{done} of {total}', { done: b.done, total: b.total })} · ${new Date(b.createdAt).toLocaleDateString(locale())}</span>
          <span class=${`badge ${BADGE[b.status] || ''}`}>${STATUS()[b.status] || b.status}</span>
        </a>`)}
      </div>
    </div>`}
  </div></div>`;
}
