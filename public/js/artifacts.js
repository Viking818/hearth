// Artifacts: the pages, apps and pictures the model made in chats, and the designs, in one gallery with search.
// They are always shown sandboxed (server/artifacts.mjs): what the model wrote runs, but can't reach Hearth.
import { html, useState, useEffect, useRef } from '../vendor/preact-htm.js';
import { Icon } from './icons.js';
import { t, tn, locale } from './i18n.js';
import { api, toast, toastError, go, copyText, set } from './store.js';
import { confirmDialog, promptDialog, PageHead } from './ui.js';

export const KINDS = () => ({ html: [t('Page or app'), 'code'], svg: [t('Picture'), 'image'], design: [t('Design'), 'palette'] });
const FILTERS = () => [['', t('All')], ['html', t('Pages and apps')], ['svg', t('Pictures')], ['design', t('Designs')]];

export function when(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  return new Date().toDateString() === d.toDateString() ? d.toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString(locale(), { day: 'numeric', month: 'short', year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
}

// The size an artifact is drawn at before it is scaled down to fit.
export const frameOf = (a) => (a.format ? { w: a.format.w, h: a.format.h } : a.kind === 'svg' ? { w: 900, h: 900 } : { w: 1280, h: 800 });

// The page of an artifact, as text, for a sandboxed frame (srcdoc). A frame with no origin may not load anything from
// Hearth's own (local) address in Chrome, its own page included, so the page goes in as text.
export function useArtifactDoc(id, v, on = true) {
  const [doc, setDoc] = useState('');
  useEffect(() => {
    if (!on) return;
    let alive = true;
    api(`/api/artifacts/${id}/doc?v=${v}`)
      .then((r) => alive && setDoc(r.doc))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [id, v, on]);
  return doc;
}

// An artifact drawn small: a live page, scaled to the space it is given; read only once it comes into view.
export function Thumb({ a, v = 0, fit = 'width', bg = '' }) {
  const box = useRef(null);
  const [scale, setScale] = useState(0);
  const [seen, setSeen] = useState(false);
  const { w, h } = frameOf(a);
  const doc = useArtifactDoc(a.id, v || a.version, seen);
  useEffect(() => {
    const el = box.current;
    if (!el || seen) return;
    const io = new IntersectionObserver((es) => es.some((e) => e.isIntersecting) && setSeen(true), { rootMargin: '200px' });
    io.observe(el);
    return () => io.disconnect();
  }, [seen]);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const fitNow = () => setScale(fit === 'both' ? Math.min(el.clientWidth / w, el.clientHeight / h) : el.clientWidth / w);
    fitNow();
    const ro = new ResizeObserver(fitNow);
    ro.observe(el);
    return () => ro.disconnect();
  }, [w, h, fit]);
  return html`<div class=${`thumb ${fit === 'both' ? 'fill' : ''} ${a.format?.transparent ? 'checker' : ''}`} ref=${box} style=${fit === 'both' ? {} : { aspectRatio: `${w} / ${h}` }}>
    ${scale > 0 && doc && html`<iframe srcdoc=${doc} tabindex="-1" title="" sandbox="allow-scripts" style=${{ width: `${w}px`, height: `${h}px`, transform: `translate(-50%, -50%) scale(${scale})`, background: bg }}></iframe>`}
  </div>`;
}

// ---------------- Making a new one ----------------

const IDEAS = () => [
  { icon: 'table', title: t('Price calculator'), text: t('A price calculator for DTF printing on T-shirts and hoodies: product, quantity, print size and sides; it shows the price per item and the total.') },
  { icon: 'globe', title: t('Landing page'), text: t('A one-page website for a print shop: a bright first screen, what we print, prices from, examples, how to order, contacts.') },
  { icon: 'pen-line', title: t('Order form'), text: t('An order form for custom prints: name, contact, product, sizes and quantities, colours, a file link, a deadline; it shows a summary to copy.') },
  { icon: 'gamepad', title: t('Mini game'), text: t('A small game in the browser that is fun for a minute, with a score and a restart button.') },
  { icon: 'activity', title: t('Chart from numbers'), text: t('A clean page with a bar chart and a table where I can type monthly sales and see the totals.') },
  { icon: 'list', title: t('Quiz'), text: t('A short quiz of 6 questions that suggests which T-shirt print suits the person, with a nice result card.') },
];

// The instructions the model gets with the user's words (they see only their own words in the chat).
export const artifactPrompt = (desc) =>
  `Make this as an artifact: one self-contained HTML file (CSS and JavaScript inside it; Google Fonts are fine) that works when opened on its own in a browser. Give it a <title>. Make it look polished and modern, work on a phone and a computer, and be easy to use. Put the whole file in one \`\`\`html block, then say in one or two sentences what it does. Use the language of the request for the page's text.\n\nWhat to make: ${desc}`;

function NewArtifact({ onClose }) {
  const [text, setText] = useState('');
  const start = () => {
    if (!text.trim()) return;
    set({ chatDraft: { send: true, text: text.trim(), prompt: artifactPrompt(text.trim()) }, newChatTick: Date.now() });
    onClose();
    go('#/');
  };
  return html`<div class="overlay" onMouseDown=${(e) => e.target === e.currentTarget && onClose()}>
    <div class="dialog wide">
      <h3>${t('New artifact')}</h3>
      <p class="muted" style="margin:0">${t('Describe a page, an app or a tool. Hearth writes it in a chat, and it lands here.')}</p>
      <div class="idea-grid">${IDEAS().map((x) => html`<button class="idea" onClick=${() => setText(x.text)}><${Icon} name=${x.icon} size="sm" /> ${x.title}</button>`)}</div>
      <textarea class="textarea" style="min-height:120px" value=${text} onInput=${(e) => setText(e.target.value)} placeholder=${t('For example: a price calculator for printing on hoodies, with the price per item and the total.')} onKeyDown=${(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) start(); }}></textarea>
      <div class="row wrap">
        <button class="btn ghost" onClick=${() => { onClose(); go('#/design'); }}><${Icon} name="palette" size="sm" /> ${t('A poster or a post picture? Use Design')}</button>
        <span class="grow"></span>
        <button class="btn" onClick=${onClose}>${t('Cancel')}</button>
        <button class="btn primary" disabled=${!text.trim()} onClick=${start}><${Icon} name="sparkles" size="sm" /> ${t('Make it')}</button>
      </div>
    </div>
  </div>`;
}

// ---------------- The gallery ----------------

function Gallery() {
  const [q, setQ] = useState('');
  const [kind, setKind] = useState('');
  const [list, setList] = useState(null);
  const [creating, setCreating] = useState(false);
  useEffect(() => {
    const tm = setTimeout(() => api(`/api/artifacts?q=${encodeURIComponent(q.trim())}&kind=${kind}`).then((r) => setList(r.artifacts)).catch(toastError), q ? 250 : 0);
    return () => clearTimeout(tm);
  }, [q, kind]);
  const empty = list && !list.length && !q && !kind;
  return html`<div class="page"><div class="page-inner">
    <${PageHead} title=${t('Artifacts')} text=${t('Pages, apps, pictures and designs Hearth made for you. Open one, find it by its words, or make a new one.')}>
      <button class="btn primary" onClick=${() => setCreating(true)}><${Icon} name="plus" size="sm" /> ${t('New artifact')}</button>
    <//>
    ${!empty && html`<div class="row wrap" style="gap:10px;margin-bottom:16px">
      <label class="search-box grow"><${Icon} name="search" size="sm" /><input placeholder=${t('Search artifacts')} value=${q} onInput=${(e) => setQ(e.target.value)} />${q && html`<button class="icon-btn" style="width:24px;height:24px" title=${t('Clear')} onClick=${() => setQ('')}><${Icon} name="x" size="sm" /></button>`}</label>
      <div class="seg">${FILTERS().map(([k, label]) => html`<button class=${kind === k ? 'on' : ''} onClick=${() => setKind(k)}>${label}</button>`)}</div>
    </div>`}
    ${list === null
      ? html`<div class="empty"><${Icon} name="loader" cls="spin" /></div>`
      : empty
        ? html`<div class="card pad col" style="gap:14px;align-items:flex-start">
            <div class="row" style="gap:12px"><span class="a-icon"><${Icon} name="layout-grid" /></span><div><b style="font-size:16px">${t('No artifacts yet')}</b><p class="muted" style="margin:4px 0 0">${t('When the chat writes a page, an app, a game or a picture, it is kept here. Make one now:')}</p></div></div>
            <div class="idea-grid">${IDEAS().map((x) => html`<button class="idea" onClick=${() => { set({ chatDraft: { send: true, text: x.text, prompt: artifactPrompt(x.text) }, newChatTick: Date.now() }); go('#/'); }}><${Icon} name=${x.icon} size="sm" /> ${x.title}</button>`)}</div>
          </div>`
        : !list.length
          ? html`<div class="card empty">${t('Nothing found.')}</div>`
          : html`<div class="art-grid">${list.map((a) => {
              const [kname, kicon] = KINDS()[a.kind] || KINDS().html;
              return html`<a class="art-card" href=${`#/artifacts/${a.id}`} key=${a.id}>
                <${Thumb} a=${a} fit="both" />
                <div class="art-meta">
                  <${Icon} name=${kicon} size="sm" />
                  <div class="grow" style="min-width:0"><div class="ellipsis art-title">${a.title}</div><div class="faint" style="font-size:12.5px">${kname}${a.format ? ` · ${a.format.w}×${a.format.h}` : ''} · ${when(a.updatedAt)}${a.versions?.length > 1 ? ` · ${tn(a.versions.length, '{n} version', '{n} versions')}` : ''}</div></div>
                </div>
              </a>`;
            })}</div>`}
    ${creating && html`<${NewArtifact} onClose=${() => setCreating(false)} />`}
  </div></div>`;
}

// ---------------- One artifact ----------------

function ArtifactView({ id }) {
  const [a, setA] = useState(null);
  const [v, setV] = useState(0);
  const [tab, setTab] = useState('preview');
  const doc = useArtifactDoc(id, a?.shown || 0, Boolean(a) && a.kind === 'html');
  const load = (ver = v) =>
    api(`/api/artifacts/${id}${ver ? `?v=${ver}` : ''}`)
      .then(setA)
      .catch((err) => {
        toastError(err);
        go('#/artifacts');
      });
  useEffect(() => {
    load(v);
  }, [id, v]);
  if (!a) return html`<div class="page"><div class="page-inner"><div class="empty"><${Icon} name="loader" cls="spin" /></div></div></div>`;
  const [kname, kicon] = KINDS()[a.kind] || KINDS().html;
  const vi = a.versions.indexOf(a.shown);
  const old = a.shown !== a.version;
  const rename = async () => {
    const title = await promptDialog({ title: t('Rename'), value: a.title, ok: t('Save') });
    if (title && title.trim()) setA(await api(`/api/artifacts/${id}`, { method: 'PUT', body: { title } }).catch(toastError) || a);
  };
  const restore = async () => {
    await api(`/api/artifacts/${id}`, { method: 'PUT', body: { restore: a.shown } }).catch(toastError);
    toast(t('This version is the current one again.'));
    setV(0);
    load(0);
  };
  const del = async () => {
    if (!(await confirmDialog({ title: t('Delete “{name}”?', { name: a.title }), text: t('All its versions are deleted from this computer.'), ok: t('Delete'), danger: true }))) return;
    await api(`/api/artifacts/${id}`, { method: 'DELETE' }).catch(toastError);
    go('#/artifacts');
  };
  return html`<div class="page art-page"><div class="art-bar">
      <button class="icon-btn" title=${t('All artifacts')} onClick=${() => go('#/artifacts')}><${Icon} name="chevron-left" /></button>
      <${Icon} name=${kicon} size="sm" />
      <button class="art-name ellipsis" title=${t('Rename')} onClick=${rename}>${a.title}</button>
      <span class="badge">${kname}${a.format ? ` · ${a.format.w}×${a.format.h}` : ''}</span>
      ${a.versions.length > 1 && html`<span class="ver-nav">
        <button class="icon-btn" disabled=${vi <= 0} title=${t('Earlier version')} onClick=${() => setV(a.versions[vi - 1])}><${Icon} name="chevron-left" size="sm" /></button>
        <span class="faint">${t('Version {n} of {total}', { n: vi + 1, total: a.versions.length })}</span>
        <button class="icon-btn" disabled=${vi >= a.versions.length - 1} title=${t('Later version')} onClick=${() => setV(a.versions[vi + 1])}><${Icon} name="chevron-right" size="sm" /></button>
      </span>`}
      <span class="grow"></span>
      ${old && html`<button class="btn sm" onClick=${restore}><${Icon} name="rotate-ccw" size="sm" /> ${t('Make this the current one')}</button>`}
      <div class="seg"><button class=${tab === 'preview' ? 'on' : ''} onClick=${() => setTab('preview')}><${Icon} name="eye" size="sm" /> ${t('Preview')}</button><button class=${tab === 'code' ? 'on' : ''} onClick=${() => setTab('code')}><${Icon} name="code" size="sm" /> ${t('Code')}</button></div>
      ${a.kind === 'design' && html`<button class="btn sm primary" onClick=${() => go(`#/design/${a.id}`)}><${Icon} name="palette" size="sm" /> ${t('Edit in Design')}</button>`}
      ${a.chatId && html`<button class="btn sm" onClick=${() => go(`#/chat/${a.chatId}`)}><${Icon} name="message-square" size="sm" /> ${t('Open the chat')}</button>`}
      <button class="icon-btn" title=${t('Copy code')} onClick=${() => copyText(a.code)}><${Icon} name="copy" /></button>
      <a class="icon-btn" title=${t('Download')} href=${`/api/artifacts/${id}/download?v=${a.shown}`} download><${Icon} name="download" /></a>
      <a class="icon-btn" title=${t('Open in a new window')} href=${`/api/artifacts/${id}/view?v=${a.shown}`} target="_blank" rel="noopener"><${Icon} name="external-link" /></a>
      <button class="icon-btn" title=${t('Delete')} onClick=${del}><${Icon} name="trash" /></button>
    </div>
    <div class="art-stage">
      ${tab === 'code'
        ? html`<pre class="art-code">${a.code}</pre>`
        : a.kind === 'html'
          ? html`<iframe class="art-frame" key=${a.shown} srcdoc=${doc} title=${a.title} sandbox="allow-scripts allow-forms allow-modals allow-popups allow-pointer-lock allow-downloads"></iframe>`
          : html`<div class="art-canvas"><${Thumb} a=${a} v=${a.shown} fit="both" /></div>`}
    </div>
    ${a.kind === 'design' && a.prompts?.length > 0 && tab === 'preview' && html`<div class="art-foot faint">${t('Last change')}: ${a.prompts.at(-1).text}</div>`}
  </div>`;
}

export function ArtifactsPage({ route }) {
  return route.id ? html`<${ArtifactView} id=${route.id} key=${route.id} />` : html`<${Gallery} />`;
}

