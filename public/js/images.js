// Pictures page: describe a picture, get it drawn on this computer (Z-Image Turbo), keep a gallery.
import { html, useState, useEffect } from '../vendor/preact-htm.js';
import { Icon } from './icons.js';
import { t, tn } from './i18n.js';
import { useStore, api, toast, toastError, go, set, fmtBytes, fmtDuration, saveFile, copyText, loadModel, getState, refreshDownloads, readPref, writePref } from './store.js';
import { confirmDialog, PageHead } from './ui.js';
import { Downloads } from './models.js';

const STYLES = () => [
  { id: 'none', name: t('No style'), text: '' },
  { id: 'photo', name: t('Photo'), text: 'professional photograph, natural light, sharp focus, high detail' },
  { id: 'shirt', name: t('T-shirt print'), text: 'print-ready t-shirt design, bold clean vector illustration, limited color palette, centered composition, isolated on a plain white background, high contrast, no mockup' },
  { id: 'illustration', name: t('Illustration'), text: 'detailed digital illustration, vibrant colors, clean shapes' },
  { id: 'logo', name: t('Logo'), text: 'minimal flat vector logo, simple geometric shapes, two colors, white background' },
  { id: 'mockup', name: t('Product mockup'), text: 'studio product photo of a folded cotton t-shirt with the design printed on the chest, soft shadows, neutral background' },
];
const SIZES = () => [
  ['square', t('Square'), '1:1'],
  ['portrait', t('Portrait'), '2:3'],
  ['landscape', t('Landscape'), '3:2'],
  ['story', t('Story'), '9:16'],
  ['wide', t('Wide'), '16:9'],
];

function Setup({ st, reload }) {
  const { downloads } = useStore();
  const [setId, setSetId] = useState(st.recommended);
  const install = async () => {
    try {
      await api('/api/images/install', { method: 'POST', body: { set: setId } });
      refreshDownloads();
      reload();
    } catch (err) {
      toastError(err);
    }
  };
  useEffect(() => {
    const timer = setInterval(refreshDownloads, 1500);
    return () => clearInterval(timer);
  }, []);
  return html`<div class="card pad col" style="gap:14px">
    <div class="row" style="gap:12px;align-items:flex-start"><span class="a-icon"><${Icon} name="wand" /></span>
      <div class="grow"><b style="font-size:16px">${t('Make pictures on this computer')}</b>
        <p class="muted" style="margin:4px 0 0">${t('Hearth uses Z-Image Turbo, an open model (Apache 2.0) that handles text in pictures well. A picture takes about one to two minutes on a fast Mac. Free, no limits, and nothing leaves your computer. It is not as strong as the best cloud services.')}</p></div></div>
    <div class="col" style="gap:8px">
      ${st.sets.map((s) => html`<label class=${`choice ${setId === s.id ? 'on' : ''}`}>
        <input type="radio" name="set" checked=${setId === s.id} onChange=${() => setSetId(s.id)} />
        <span class="grow"><b>${s.name} · ${s.quality}</b>${s.id === st.recommended ? html` <span class="badge ok">${t('recommended')}</span>` : ''}<br /><span class="muted" style="font-size:13px">${t('Download {size}', { size: fmtBytes(s.size) })}${s.fits ? '' : ` · ${t('may be too big for this computer')}`}${s.installed ? ` · ${t('downloaded')}` : ''}</span></span>
      </label>`)}
    </div>
    <div class="row"><button class="btn primary" disabled=${st.installing} onClick=${install}><${Icon} name=${st.installing ? 'loader' : 'download'} cls=${st.installing ? 'spin' : ''} size="sm" /> ${st.installing ? t('Downloading…') : t('Install')}</button>
      ${!st.engine && html`<span class="muted" style="font-size:13px">${t('The picture engine (stable-diffusion.cpp, about 40 MB) comes with it.')}</span>`}</div>
    <${Downloads} downloads=${downloads} kinds=${['images']} />
  </div>`;
}

function Lightbox({ img, onClose, onDelete, onReuse }) {
  const toChat = async () => {
    try {
      const blob = await (await fetch(img.url)).blob();
      const r = await api('/api/uploads', { method: 'POST', raw: blob, headers: { 'content-type': 'image/png' } });
      set({ chatDraft: { images: [{ url: r.url, name: img.name }], text: '' }, newChatTick: Date.now() });
      go('#/');
    } catch (err) {
      toastError(err);
    }
  };
  return html`<div class="overlay lightbox-pane" onClick=${(e) => e.target === e.currentTarget && onClose()}>
    <div class="lb-card">
      <img src=${img.url} alt="" />
      <div class="lb-side col" style="gap:10px">
        <div class="row"><b class="grow">${t('Picture')}</b><button class="icon-btn" title=${t('Close')} onClick=${onClose}><${Icon} name="x" /></button></div>
        <p class="lb-prompt">${img.prompt}</p>
        <div class="muted" style="font-size:13px">${img.width}×${img.height} · ${t('seed')} ${img.seed} · ${img.ms ? fmtDuration(img.ms) : ''}</div>
        <div class="col" style="gap:6px">
          <button class="btn sm" onClick=${() => saveFile(img.name, img.url)}><${Icon} name="download" size="sm" /> ${t('Save')}</button>
          <button class="btn sm" onClick=${() => { writePref('hearth.vidFromPicture', img.name); go('#/video'); }}><${Icon} name="film" size="sm" /> ${t('Animate this picture')}</button>
          <button class="btn sm" onClick=${toChat}><${Icon} name="message-square" size="sm" /> ${t('Ask about it in a chat')}</button>
          <button class="btn sm" onClick=${() => onReuse(img)}><${Icon} name="refresh-cw" size="sm" /> ${t('Use these settings')}</button>
          <button class="btn sm" onClick=${() => copyText(img.prompt)}><${Icon} name="copy" size="sm" /> ${t('Copy description')}</button>
          <button class="btn sm danger" onClick=${() => onDelete(img)}><${Icon} name="trash" size="sm" /> ${t('Delete')}</button>
        </div>
      </div>
    </div>
  </div>`;
}

export function ImagesPage() {
  const { status } = useStore();
  const [st, setSt] = useState(null);
  const [gallery, setGallery] = useState([]);
  const [prompt, setPrompt] = useState(() => readPref('hearth.imgPrompt', ''));
  const [style, setStyle] = useState(() => readPref('hearth.imgStyle', 'none'));
  const [size, setSize] = useState(() => readPref('hearth.imgSize', 'square'));
  const [count, setCount] = useState(1);
  const [more, setMore] = useState(false);
  const [seed, setSeed] = useState('');
  const [negative, setNegative] = useState('');
  const [job, setJob] = useState(null);
  const [open, setOpen] = useState(null);
  const [unloaded, setUnloaded] = useState('');
  const load = () => api('/api/images').then((r) => {
    setSt(r);
    if (r.job) setJob(r.job);
  }).catch(toastError);
  const loadGallery = () => api('/api/images/gallery').then((r) => setGallery(r.images)).catch(() => {});
  useEffect(() => {
    load();
    loadGallery();
  }, []);
  useEffect(() => {
    if (st && !st.ready && st.installing) {
      const timer = setInterval(load, 3000);
      return () => clearInterval(timer);
    }
  }, [st?.ready, st?.installing]);
  const active = job && ['loading', 'drawing', 'saving'].includes(job.state);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(async () => {
      const r = await api('/api/images/job').catch(() => null);
      if (!r?.job) return;
      setJob(r.job);
      if (r.job.state === 'done') loadGallery();
      if (r.job.state === 'error') toast(r.job.error, 'bad');
    }, 700);
    return () => clearInterval(timer);
  }, [active]);

  const generate = async (unload = false) => {
    const styleText = STYLES().find((s) => s.id === style)?.text;
    const full = styleText ? `${prompt.trim()}. ${styleText}` : prompt.trim();
    writePref('hearth.imgPrompt', prompt);
    writePref('hearth.imgStyle', style);
    writePref('hearth.imgSize', size);
    try {
      const j = await api('/api/images/generate', { method: 'POST', body: { prompt: full, size, count, seed: seed === '' ? undefined : Number(seed), negative, unload } });
      setJob(j);
      if (j.unloaded) setUnloaded(j.unloaded);
    } catch (err) {
      if (err.code === 'NEEDS_MEMORY') {
        if (await confirmDialog({ title: t('Free memory for pictures?'), text: t('The chat model ({name}) is using the memory pictures need. Hearth can stop it while drawing; you can load it again with one click afterwards.', { name: err.data?.error?.model || t('chat model') }), ok: t('Stop it and draw') })) generate(true);
        return;
      }
      toastError(err);
    }
  };
  const del = async (img) => {
    await api(`/api/images/${encodeURIComponent(img.name)}`, { method: 'DELETE' }).catch(toastError);
    setOpen(null);
    loadGallery();
  };
  const reuse = (img) => {
    setPrompt(img.prompt.replace(new RegExp(`\\. (${STYLES().map((s) => s.text).filter(Boolean).map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})$`), ''));
    setSeed(String(img.seed));
    setOpen(null);
    window.scrollTo?.(0, 0);
  };
  const reloadChat = () => {
    const last = status?.settings?.lastModel;
    const m = getState().models.find((x) => x.id === last?.id);
    if (m) loadModel(m);
    setUnloaded('');
  };

  const progress = job && job.steps ? Math.min(1, ((job.image || 0) * job.steps + (job.step || 0)) / (job.steps * (job.count || 1))) : 0;
  return html`<div class="page"><div class="page-inner">
    <${PageHead} title=${t('Pictures')} text=${t('Describe a picture and Hearth draws it on this computer.')} />
    ${!st
      ? html`<div class="card empty"><${Icon} name="loader" cls="spin" /></div>`
      : !st.ready
        ? html`<${Setup} st=${st} reload=${load} />`
        : html`<div class="card pad col" style="gap:14px">
            <textarea class="textarea img-prompt" value=${prompt} onInput=${(e) => setPrompt(e.target.value)} placeholder=${t('For example: a red fox in a space helmet, sticker style, with the words “Stay curious”')} onKeyDown=${(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && prompt.trim() && !active) generate(); }}></textarea>
            <div class="row wrap" style="gap:6px">${STYLES().map((s) => html`<button class=${`chip-btn outline ${style === s.id ? 'on' : ''}`} onClick=${() => setStyle(s.id)}>${s.name}</button>`)}</div>
            <div class="row wrap" style="gap:12px">
              <div class="seg">${SIZES().map(([k, l, r]) => html`<button class=${size === k ? 'on' : ''} title=${r} onClick=${() => setSize(k)}>${l}</button>`)}</div>
              <div class="seg">${[1, 2, 3, 4].map((n) => html`<button class=${count === n ? 'on' : ''} onClick=${() => setCount(n)}>×${n}</button>`)}</div>
              <button class="btn sm ghost" onClick=${() => setMore(!more)}><${Icon} name=${more ? 'chevron-up' : 'chevron-down'} size="sm" /> ${t('More')}</button>
              <span class="grow"></span>
              ${active
                ? html`<button class="btn" onClick=${() => api('/api/images/cancel', { method: 'POST' }).then((r) => setJob(r.job))}><${Icon} name="square" size="sm" /> ${t('Stop')}</button>`
                : html`<button class="btn primary lg" disabled=${!prompt.trim()} onClick=${() => generate()}><${Icon} name="wand" size="sm" /> ${t('Draw')}</button>`}
            </div>
            ${more && html`<div class="grid c2">
              <label class="field"><span>${t('Seed (same seed + same description = same picture)')}</span><input class="input" type="number" min="0" value=${seed} placeholder=${t('random')} onInput=${(e) => setSeed(e.target.value)} /></label>
              <label class="field"><span>${t('Leave out')}</span><input class="input" value=${negative} placeholder=${t('e.g. text, watermark, blurry')} onInput=${(e) => setNegative(e.target.value)} /></label>
            </div>`}
            ${active && html`<div class="col" style="gap:6px">
              <div class="progress"><i style=${{ width: `${Math.max(3, progress * 100)}%` }}></i></div>
              <span class="muted" style="font-size:13px">${job.state === 'loading' ? t('Loading the picture model…') : job.state === 'saving' ? t('Finishing…') : job.count > 1 ? t('Drawing picture {i} of {n}: step {s} of {steps}', { i: (job.image || 0) + 1, n: job.count, s: job.step, steps: job.steps }) : t('Drawing: step {s} of {steps}', { s: job.step, steps: job.steps })}</span>
            </div>`}
            ${unloaded && !active && html`<div class="notice accent"><${Icon} name="info" /><div class="grow">${t('The chat model ({name}) was stopped to free memory.', { name: unloaded })}</div><button class="btn sm" onClick=${reloadChat}>${t('Load it again')}</button></div>`}
            ${job?.state === 'done' && job.images?.length > 0 && html`<div class="img-grid fresh">${job.images.map((n) => {
              const img = gallery.find((g) => g.name === n);
              return img && html`<button class="img-tile" onClick=${() => setOpen(img)}><img src=${img.url} alt="" /></button>`;
            })}</div>`}
          </div>`}
    ${gallery.length > 0 && html`<div class="section">
      <h2>${t('Gallery')} <span class="muted" style="font-weight:400;font-size:14px">${tn(gallery.length, '{n} picture', '{n} pictures')}</span></h2>
      <div class="img-grid">${gallery.map((g) => html`<button class="img-tile" key=${g.name} onClick=${() => setOpen(g)} title=${g.prompt}><img src=${g.url} alt="" loading="lazy" /></button>`)}</div>
    </div>`}
    ${open && html`<${Lightbox} img=${open} onClose=${() => setOpen(null)} onDelete=${del} onReuse=${reuse} />`}
  </div></div>`;
}
