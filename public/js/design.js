// Design: posters, social posts, T-shirt prints, logos, flyers… made by the model as an exact-size HTML page on a
// canvas, changed by asking ("make the headline bigger"), and saved as PNG at print size. Each design is an artifact
// (kind "design") with its versions, its pictures and its format; the brand kit (colours, fonts, logo) is shared.
import { html, useState, useEffect, useRef } from '../vendor/preact-htm.js';
import { Icon } from './icons.js';
import { t, tn } from './i18n.js';
import { api, toast, toastError, go, set, getState, saveFile } from './store.js';
import { confirmDialog, promptDialog, PageHead, Toggle } from './ui.js';
import { FONTS_CYR, FONTS_LAT, designSystem, htmlFrom } from './design-prompt.js';
import { uploadImage, readStream } from './chat.js';
import { Thumb, when } from './artifacts.js';

export const FORMATS = () => [
  { id: 'ig-post', group: 'social', name: t('Instagram post'), w: 1080, h: 1080, scale: 1 },
  { id: 'ig-portrait', group: 'social', name: t('Instagram portrait'), w: 1080, h: 1350, scale: 1 },
  { id: 'story', group: 'social', name: t('Stories, Reels, TikTok'), w: 1080, h: 1920, scale: 1 },
  { id: 'pin', group: 'social', name: t('Pinterest pin'), w: 1000, h: 1500, scale: 1 },
  { id: 'fb', group: 'social', name: t('Facebook post'), w: 1200, h: 630, scale: 1 },
  { id: 'yt', group: 'social', name: t('YouTube thumbnail'), w: 1280, h: 720, scale: 1 },
  { id: 'tshirt', group: 'print', name: t('T-shirt print'), w: 1500, h: 1800, scale: 3, transparent: true },
  { id: 'logo', group: 'print', name: t('Logo'), w: 1000, h: 1000, scale: 2, transparent: true },
  { id: 'flyer', group: 'print', name: t('Flyer A5'), w: 874, h: 1240, scale: 2 },
  { id: 'poster', group: 'print', name: t('Poster A3'), w: 1169, h: 1654, scale: 3 },
  { id: 'card', group: 'print', name: t('Business card'), w: 1050, h: 600, scale: 1 },
  { id: 'banner', group: 'web', name: t('Website banner'), w: 1440, h: 600, scale: 1 },
];
const GROUPS = () => [['social', t('Social media')], ['print', t('Print')], ['web', t('Website')]];
const pixels = (f) => `${f.w * f.scale} × ${f.h * f.scale}`;

// A design's pictures go inside the page as data: browsers don't let a sandboxed page load anything from Hearth's own
// (local) address. They are read once here (the page itself may) and kept.
const pictureData = new Map(); // address → data: URL
async function loadPictures(list = []) {
  await Promise.all(
    list
      .filter((u) => !pictureData.has(u))
      .map(async (u) => {
        try {
          const blob = await (await fetch(u)).blob();
          pictureData.set(u, await new Promise((resolve) => {
            const r = new FileReader();
            r.onload = () => resolve(String(r.result));
            r.readAsDataURL(blob);
          }));
        } catch {}
      }),
  );
}
const shown = (code, images) => code.replace(/\{\{\s*image:(\d+)\s*\}\}/g, (m, n) => pictureData.get(images[Number(n) - 1]) || '');

// Turning a design into a PNG: html2canvas draws it inside a hidden frame. html2canvas copies the page into a frame of
// its own and must reach it, which a frame with no origin can't, so this one frame keeps Hearth's origin. To keep
// that safe:
//  - the design is read into a tree with scripting off and cleaned there: no scripts, frames, plug-ins, event
//    handlers, and none of the elements a browser reads differently the second time (noscript, template);
//  - the cleaned tree is never turned back into text and read again. Its nodes are moved, as nodes, into a frame
//    that Hearth wrote itself. (Until 0.2.33 the tree was written out as text and parsed again by the frame; what a
//    browser makes of such text can differ from the tree that was checked.)
//  - that frame's own page carries a security policy that lets only Hearth's two scripts run (each has a one-time
//    key, a nonce), and it is in place before any node of the design arrives.
export function cleanDesign(doc) {
  const d = new DOMParser().parseFromString(doc, 'text/html');
  d.querySelectorAll('script, iframe, frame, frameset, object, embed, applet, portal, noscript, template, meta[http-equiv], base, form, link[rel]:not([rel~="stylesheet"])').forEach((n) => n.remove());
  // An SVG animation can write a "javascript:" address into a link after the check: those go too.
  d.querySelectorAll('set, animate, animateTransform, animateMotion').forEach((n) => /href/i.test(n.getAttribute('attributeName') || '') && n.remove());
  for (const el of d.querySelectorAll('*'))
    for (const at of [...el.attributes]) {
      const n = at.name.toLowerCase();
      // Browsers skip tabs, line breaks and leading control characters in an address: "java<tab>script:" still runs.
      if (n.startsWith('on') || n === 'srcdoc' || /^(javascript|vbscript):/i.test(at.value.replace(/[\u0000-\u0020]/g, ''))) el.removeAttribute(at.name);
    }
  return d;
}

let painter = null;
const painterCode = () => (painter ||= fetch('/vendor/html2canvas/html2canvas.min.js').then((r) => (r.ok ? r.text() : Promise.reject(new Error(t('Could not load the picture maker.'))))));
const EXPORTER = (lib, nonce) => `<script nonce="${nonce}">${lib.replace(/<\/script/gi, '<\\/script')}</script><script nonce="${nonce}">
addEventListener('message', async (e) => {
  if (!e.data || e.data.type !== 'hearth-export') return;
  try {
    if (document.fonts) await document.fonts.ready;
    await Promise.all([...document.images].map((i) => (i.complete ? 0 : new Promise((r) => { i.onload = i.onerror = r; }))));
    const el = document.getElementById('design') || document.body;
    const c = await html2canvas(el, { scale: e.data.scale, backgroundColor: e.data.transparent ? null : '#ffffff', useCORS: true, logging: false, width: e.data.w, height: e.data.h, windowWidth: e.data.w, windowHeight: e.data.h });
    parent.postMessage({ type: 'hearth-export-done', url: c.toDataURL('image/png') }, '*');
  } catch (err) {
    parent.postMessage({ type: 'hearth-export-done', error: String(err && err.message || err) }, '*');
  }
});
</script>`;

// The design as a PNG at its print size: drawn in a hidden sandboxed frame at full size, then saved.
async function exportPng(id, a) {
  const [{ doc }, lib] = await Promise.all([api(`/api/artifacts/${id}/doc`), painterCode()]);
  const fmt = a.format;
  const nonce = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');
  const policy = `<meta http-equiv="Content-Security-Policy" content="script-src 'nonce-${nonce}'; object-src 'none'; base-uri 'none'; form-action 'none'">`;
  const design = cleanDesign(doc);
  const frame = document.createElement('iframe');
  frame.setAttribute('sandbox', 'allow-scripts allow-same-origin');
  frame.style.cssText = `position:fixed;left:-${fmt.w + 200}px;top:0;width:${fmt.w}px;height:${fmt.h}px;border:0;opacity:0;pointer-events:none`;
  // The frame's page is Hearth's own text: the policy and the two scripts, nothing of the design.
  frame.srcdoc = `<!doctype html><html><head><meta charset="utf-8">${policy}</head><body>${EXPORTER(lib, nonce)}</body></html>`;
  document.body.appendChild(frame);
  try {
    await new Promise((resolve) => (frame.onload = resolve));
    // Now the design's cleaned nodes move in, as nodes: its styles after the policy, its content before the scripts.
    const fd = frame.contentDocument;
    for (const [from, to] of [[design.documentElement, fd.documentElement], [design.body, fd.body]]) for (const at of [...from.attributes]) to.setAttribute(at.name, at.value);
    for (const n of [...design.head.childNodes]) fd.head.appendChild(fd.adoptNode(n));
    const scripts = fd.body.firstChild;
    for (const n of [...design.body.childNodes]) fd.body.insertBefore(fd.adoptNode(n), scripts);
    const url = await new Promise((resolve, reject) => {
      const tm = setTimeout(() => reject(new Error(t('Saving the picture took too long.'))), 120000);
      const on = (e) => {
        if (e.source !== frame.contentWindow || e.data?.type !== 'hearth-export-done') return;
        clearTimeout(tm);
        removeEventListener('message', on);
        e.data.error ? reject(new Error(e.data.error)) : resolve(e.data.url);
      };
      addEventListener('message', on);
      frame.contentWindow.postMessage({ type: 'hearth-export', scale: fmt.scale, transparent: Boolean(fmt.transparent), w: fmt.w, h: fmt.h }, '*');
    });
    const blob = await (await fetch(url)).blob();
    saveFile(`${(a.title || 'design').replace(/[\\/:*?"<>|]+/g, '-').slice(0, 60)}.png`, blob);
  } finally {
    frame.remove();
  }
}

// ---------------- The canvas ----------------

// The design at its real size in a sandboxed frame, scaled to fit the space it is given. A new version loads in a
// hidden frame on top and shows once it is ready (fonts and all), so the canvas never flashes white.
function Canvas({ doc, fmt }) {
  const box = useRef(null);
  const seq = useRef(0);
  const [scale, setScale] = useState(0);
  const [frames, setFrames] = useState([]); // { id, doc, ready }
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const fit = () => setScale(Math.min((el.clientWidth - 48) / fmt.w, (el.clientHeight - 48) / fmt.h, 1));
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [fmt.w, fmt.h]);
  useEffect(() => {
    if (!doc) return;
    setFrames((fs) => (fs.at(-1)?.doc === doc ? fs : [...fs.filter((f) => f.ready).slice(-1), { id: ++seq.current, doc, ready: false }]));
  }, [doc]);
  const loaded = (id) =>
    setFrames((fs) => {
      const i = fs.findIndex((f) => f.id === id);
      return i < 0 ? fs : fs.slice(i).map((f, j) => (j === 0 ? { ...f, ready: true } : f));
    });
  const ready = frames.some((f) => f.ready);
  return html`<div class="dz-canvas" ref=${box}>
    ${scale > 0 && html`<div class=${`dz-paper ${fmt.transparent ? 'checker' : ''}`} style=${{ width: `${fmt.w * scale}px`, height: `${fmt.h * scale}px` }}>
      ${frames.map((f) => html`<iframe key=${f.id} title=${t('Design')} sandbox="allow-scripts" srcdoc=${f.doc} onLoad=${() => loaded(f.id)} style=${{ width: `${fmt.w}px`, height: `${fmt.h}px`, transform: `scale(${scale})`, opacity: f.ready ? 1 : 0 }}></iframe>`)}
      ${!ready && html`<div class="dz-empty"><${Icon} name="loader" cls="spin" /></div>`}
    </div>`}
  </div>`;
}

// ---------------- Pictures and the brand ----------------

function PicturePicker({ onPick, onClose }) {
  const [list, setList] = useState(null);
  const file = useRef(null);
  useEffect(() => {
    api('/api/images/gallery').then((r) => setList(r.images)).catch(() => setList([]));
  }, []);
  const upload = async (files) => {
    for (const f of files) {
      try {
        onPick((await uploadImage(f)).url);
      } catch (err) {
        toastError(err);
      }
    }
    onClose();
  };
  return html`<div class="overlay" onMouseDown=${(e) => e.target === e.currentTarget && onClose()}>
    <div class="dialog wide">
      <h3>${t('Add a picture')}</h3>
      <button class="btn" onClick=${() => file.current.click()}><${Icon} name="upload" size="sm" /> ${t('From this computer')}</button>
      <input ref=${file} type="file" hidden multiple accept="image/*" onChange=${(e) => { upload([...e.target.files]); e.target.value = ''; }} />
      <div class="ext-sub" style="margin-top:6px">${t('From Pictures')}</div>
      ${list === null ? html`<div class="empty"><${Icon} name="loader" cls="spin" /></div>` : !list.length ? html`<p class="muted" style="margin:0">${t('No pictures made yet.')}</p>` : html`<div class="dz-pics">${list.slice(0, 60).map((im) => html`<button class="dz-pic" onClick=${() => { onPick(im.url); onClose(); }}><img src=${im.url} alt="" loading="lazy" /></button>`)}</div>`}
      <div class="row" style="justify-content:flex-end"><button class="btn" onClick=${onClose}>${t('Cancel')}</button></div>
    </div>
  </div>`;
}

export function BrandDialog({ onClose }) {
  const [b, setB] = useState(null);
  const [pick, setPick] = useState(false);
  useEffect(() => {
    api('/api/brand').then(setB).catch(toastError);
  }, []);
  if (!b) return null;
  const save = async () => {
    try {
      await api('/api/brand', { method: 'PUT', body: b });
      toast(t('Saved'));
      onClose();
    } catch (err) {
      toastError(err);
    }
  };
  const font = (k) => html`<select class="select" value=${b[k]} onChange=${(e) => setB({ ...b, [k]: e.target.value })}><option value="">${t('Any')}</option>${[...FONTS_CYR, ...FONTS_LAT].map((f) => html`<option value=${f}>${f}${FONTS_CYR.includes(f) ? '' : ` (${t('Latin only')})`}</option>`)}</select>`;
  return html`<div class="overlay" onMouseDown=${(e) => e.target === e.currentTarget && onClose()}>
    <div class="dialog wide">
      <h3>${t('Your brand')}</h3>
      <p class="muted" style="margin:0">${t('Designs that use the brand get these colours, fonts and logo.')}</p>
      <div class="row wrap" style="gap:12px">
        <label class="field grow"><span>${t('Name')}</span><input class="input" value=${b.name} onInput=${(e) => setB({ ...b, name: e.target.value })} /></label>
        <label class="field grow"><span>${t('Slogan')}</span><input class="input" value=${b.slogan} onInput=${(e) => setB({ ...b, slogan: e.target.value })} /></label>
      </div>
      <div class="field"><span>${t('Colours')}</span>
        <div class="row wrap" style="gap:8px">
          ${b.colors.map((c, i) => html`<span class="swatch-edit"><input type="color" value=${c} onInput=${(e) => setB({ ...b, colors: b.colors.map((x, j) => (j === i ? e.target.value : x)) })} /><button class="icon-btn" title=${t('Remove')} onClick=${() => setB({ ...b, colors: b.colors.filter((_, j) => j !== i) })}><${Icon} name="x" size="sm" /></button></span>`)}
          ${b.colors.length < 8 && html`<button class="btn sm" onClick=${() => setB({ ...b, colors: [...b.colors, '#ff6a2b'] })}><${Icon} name="plus" size="sm" /> ${t('Add a colour')}</button>`}
        </div>
      </div>
      <div class="row wrap" style="gap:12px">
        <label class="field grow"><span>${t('Headings font')}</span>${font('headingFont')}</label>
        <label class="field grow"><span>${t('Text font')}</span>${font('bodyFont')}</label>
      </div>
      <div class="field"><span>${t('Logo')}</span>
        <div class="row" style="gap:10px">${b.logo ? html`<img class="dz-logo" src=${b.logo} alt="" /><button class="btn sm" onClick=${() => setB({ ...b, logo: '' })}>${t('Remove')}</button>` : ''}<button class="btn sm" onClick=${() => setPick(true)}><${Icon} name="upload" size="sm" /> ${b.logo ? t('Change') : t('Add the logo')}</button></div>
      </div>
      <label class="field"><span>${t('Notes for the designer')}</span><textarea class="textarea" value=${b.notes} onInput=${(e) => setB({ ...b, notes: e.target.value })} placeholder=${t('For example: playful and bold, lots of orange, never use pink.')}></textarea></label>
      <div class="row" style="justify-content:flex-end"><button class="btn" onClick=${onClose}>${t('Cancel')}</button><button class="btn primary" onClick=${save}>${t('Save')}</button></div>
      ${pick && html`<${PicturePicker} onPick=${(url) => setB({ ...b, logo: url })} onClose=${() => setPick(false)} />`}
    </div>
  </div>`;
}

// ---------------- Starting a design ----------------

function NewDesign({ onClose }) {
  const [fmt, setFmt] = useState(FORMATS()[0]);
  const [custom, setCustom] = useState({ w: 1080, h: 1080 });
  const [text, setText] = useState('');
  const [images, setImages] = useState([]);
  const [brand, setBrand] = useState(true);
  const [pick, setPick] = useState(false);
  const [hasBrand, setHasBrand] = useState(false);
  useEffect(() => {
    api('/api/brand').then((b) => setHasBrand(Boolean(b.name || b.colors.length || b.logo))).catch(() => {});
  }, []);
  const start = () => {
    const f = fmt.id === 'custom' ? { id: 'custom', name: t('Own size'), w: Math.max(100, Math.min(4000, Number(custom.w) || 1080)), h: Math.max(100, Math.min(4000, Number(custom.h) || 1080)), scale: 1 } : fmt;
    set({ designDraft: { format: f, brief: text.trim(), images, brand: brand && hasBrand } });
    onClose();
    go('#/design/new');
  };
  return html`<div class="overlay" onMouseDown=${(e) => e.target === e.currentTarget && onClose()}>
    <div class="dialog wide dz-new">
      <h3>${t('New design')}</h3>
      ${GROUPS().map(([g, label]) => html`<div class="ext-sub">${label}</div>
        <div class="fmt-grid">${FORMATS().filter((f) => f.group === g).map((f) => html`<button class=${`fmt ${fmt.id === f.id ? 'on' : ''}`} onClick=${() => setFmt(f)}>
          <span class="fmt-shape" style=${{ aspectRatio: `${f.w} / ${f.h}` }}></span>
          <b>${f.name}</b><span class="faint">${pixels(f)}${f.transparent ? ` · ${t('transparent')}` : ''}</span>
        </button>`)}${g === 'web' && html`<button class=${`fmt ${fmt.id === 'custom' ? 'on' : ''}`} onClick=${() => setFmt({ id: 'custom' })}><span class="fmt-shape" style=${{ aspectRatio: '1 / 1', borderStyle: 'dashed' }}></span><b>${t('Own size')}</b><span class="faint">${t('in pixels')}</span></button>`}</div>`)}
      ${fmt.id === 'custom' && html`<div class="row" style="gap:8px"><input class="input" type="number" style="width:110px" value=${custom.w} onInput=${(e) => setCustom({ ...custom, w: e.target.value })} /> × <input class="input" type="number" style="width:110px" value=${custom.h} onInput=${(e) => setCustom({ ...custom, h: e.target.value })} /> px</div>`}
      <label class="field"><span>${t('What should it be?')}</span>
        <textarea class="textarea" style="min-height:96px" value=${text} onInput=${(e) => setText(e.target.value)} placeholder=${t('For example: an Instagram post for a winter sale, minus 20% on all hoodies, cosy and bright.')}></textarea></label>
      <div class="row wrap" style="gap:10px">
        ${images.map((u) => html`<span class="dz-att"><img src=${u} alt="" /><button title=${t('Remove')} onClick=${() => setImages(images.filter((x) => x !== u))}><${Icon} name="x" size="sm" /></button></span>`)}
        ${images.length < 6 && html`<button class="btn sm" onClick=${() => setPick(true)}><${Icon} name="image" size="sm" /> ${t('Add a picture')}</button>`}
        <span class="grow"></span>
        ${hasBrand && html`<label class="row" style="gap:8px"><${Toggle} on=${brand} onChange=${setBrand} /> ${t('Use my brand')}</label>`}
      </div>
      <div class="row" style="justify-content:flex-end"><button class="btn" onClick=${onClose}>${t('Cancel')}</button><button class="btn primary" disabled=${!text.trim()} onClick=${start}><${Icon} name="sparkles" size="sm" /> ${t('Design it')}</button></div>
      ${pick && html`<${PicturePicker} onPick=${(url) => setImages((x) => [...x, url])} onClose=${() => setPick(false)} />`}
    </div>
  </div>`;
}

// ---------------- The editor ----------------

const QUICK = () => [t('Make the headline bigger'), t('Try other colours'), t('More minimal'), t('Add a call to action'), t('Make it bolder and brighter')];

function Editor({ id }) {
  const [a, setA] = useState(null); // the artifact (null while a new one is being made)
  const [draft] = useState(() => (id === 'new' ? getState().designDraft : null));
  const [v, setV] = useState(0);
  const [doc, setDoc] = useState('');
  const [busy, setBusy] = useState(false);
  const [live, setLive] = useState(0);
  const [text, setText] = useState('');
  const [pick, setPick] = useState(false);
  const [brandOpen, setBrandOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const ctrl = useRef(null);
  const fmt = a?.format || draft?.format;
  const images = a?.images || draft?.images || [];

  const load = async (aid = id, ver = v) => {
    const x = await api(`/api/artifacts/${aid}${ver ? `?v=${ver}` : ''}`);
    await loadPictures(x.images || []);
    setA(x);
    setDoc(shown(x.code, x.images || []));
    return x;
  };
  useEffect(() => {
    if (id !== 'new') load(id, v).catch(() => go('#/design'));
    else if (!draft) go('#/design');
    else generate(draft.brief, true);
    return () => ctrl.current?.abort();
  }, [id]);
  useEffect(() => {
    if (id !== 'new' && a && v) load(id, v).catch(toastError);
  }, [v]);

  // Ask the model for the design (or a change), show it as it comes, and keep it as a new version.
  async function generate(request, first = false) {
    if (busy) return;
    const brief = first ? request : a.prompts?.[0]?.text || a.title;
    const useBrand = first ? draft.brand : a.brand;
    const brand = useBrand ? await api('/api/brand').catch(() => null) : null;
    let imgs = first ? draft.images : a.images || [];
    let logoIndex = 0;
    if (brand?.logo) {
      if (!imgs.includes(brand.logo)) imgs = [...imgs, brand.logo];
      logoIndex = imgs.indexOf(brand.logo) + 1;
    }
    const f = first ? draft.format : a.format;
    const current = first ? '' : a.code;
    await loadPictures(imgs);
    const messages = [{ role: 'system', content: designSystem({ fmt: f, brand, images: imgs, logoIndex }) }, { role: 'user', content: brief }];
    if (current && request !== brief) messages.push({ role: 'assistant', content: `\`\`\`html\n${current}\n\`\`\`` }, { role: 'user', content: `Change the design: ${request}\nGive the whole new file.` });
    setBusy(true);
    setLive(0);
    const c = new AbortController();
    ctrl.current = c;
    let out = '';
    let tokens = 0;
    let lastShow = 0;
    try {
      const res = await fetch('/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json', 'x-hearth-client': 'Design', 'x-hearth-lang': document.documentElement.lang || 'en' }, body: JSON.stringify({ model: 'local', stream: true, stream_options: { include_usage: true }, messages, max_tokens: 7000, chat_template_kwargs: { enable_thinking: false } }), signal: c.signal });
      if (!res.ok) {
        let msg = t('The model answered with an error ({status}).', { status: res.status });
        try {
          msg = (await res.json()).error?.message || msg;
        } catch {}
        throw new Error(msg);
      }
      await readStream(res, (d) => {
        if (!d.content) return;
        out += d.content;
        tokens++;
        setLive(tokens);
        // Show the design while it is written, at most every 1.2 s.
        if (Date.now() - lastShow > 1200) {
          lastShow = Date.now();
          const partial = /```html?\s*\n([\s\S]*)$/i.exec(out)?.[1]?.replace(/```[\s\S]*$/, '');
          if (partial && /<body/i.test(partial)) setDoc(shown(partial, imgs));
        }
      });
      const code = htmlFrom(out);
      if (!code) throw new Error(t('The model didn’t give a design. Try again, or describe it differently.'));
      let saved;
      if (first) {
        saved = await api('/api/artifacts', { method: 'POST', body: { kind: 'design', source: 'design', title: brief.replace(/\s+/g, ' ').slice(0, 60), code, format: f, images: imgs, brand: Boolean(useBrand), prompt: request } });
        history.replaceState(null, '', `#/design/${saved.id}`);
        set({ route: { page: 'design', id: saved.id }, designDraft: null });
      } else {
        if (imgs.length !== (a.images || []).length) await api(`/api/artifacts/${a.id}`, { method: 'PUT', body: { images: imgs } });
        saved = await api(`/api/artifacts/${a.id}`, { method: 'PUT', body: { code, prompt: request } });
      }
      setV(0);
      await loadPictures(saved.images || []);
      setA(saved);
      setDoc(shown(saved.code, saved.images || []));
    } catch (err) {
      if (!c.signal.aborted) toastError(err);
      if (a) setDoc(shown(a.code, a.images || []));
    } finally {
      setBusy(false);
      ctrl.current = null;
    }
  }

  if (!fmt) return html`<div class="page"><div class="page-inner"><div class="empty"><${Icon} name="loader" cls="spin" /></div></div></div>`;
  const vi = a ? a.versions.indexOf(a.shown) : -1;
  const old = a && a.shown !== a.version;
  const send = () => {
    if (!text.trim() || !a) return;
    const r = text.trim();
    setText('');
    generate(r);
  };
  const save = async () => {
    setExporting(true);
    try {
      await exportPng(a.id, a);
    } catch (err) {
      toastError(err);
    }
    setExporting(false);
  };
  const updateMeta = async (body) => {
    try {
      const x = await api(`/api/artifacts/${a.id}`, { method: 'PUT', body });
      await loadPictures(x.images || []);
      setA(x);
      setDoc(shown(x.code, x.images || []));
    } catch (err) {
      toastError(err);
    }
  };
  const rename = async () => {
    const title = await promptDialog({ title: t('Rename'), value: a.title, ok: t('Save') });
    if (title?.trim()) updateMeta({ title });
  };
  const del = async () => {
    if (!(await confirmDialog({ title: t('Delete “{name}”?', { name: a.title }), text: t('All its versions are deleted from this computer.'), ok: t('Delete'), danger: true }))) return;
    await api(`/api/artifacts/${a.id}`, { method: 'DELETE' }).catch(toastError);
    go('#/design');
  };
  return html`<div class="page dz-page">
    <div class="art-bar">
      <button class="icon-btn" title=${t('All designs')} onClick=${() => go('#/design')}><${Icon} name="chevron-left" /></button>
      <${Icon} name="palette" size="sm" />
      ${a ? html`<button class="art-name ellipsis" title=${t('Rename')} onClick=${rename}>${a.title}</button>` : html`<span class="art-name ellipsis">${draft?.brief}</span>`}
      <span class="badge">${fmt.name} · ${pixels(fmt)}</span>
      ${a && a.versions.length > 1 && html`<span class="ver-nav">
        <button class="icon-btn" disabled=${vi <= 0 || busy} title=${t('Earlier version')} onClick=${() => setV(a.versions[vi - 1])}><${Icon} name="chevron-left" size="sm" /></button>
        <span class="faint">${t('Version {n} of {total}', { n: vi + 1, total: a.versions.length })}</span>
        <button class="icon-btn" disabled=${vi >= a.versions.length - 1 || busy} title=${t('Later version')} onClick=${() => setV(a.versions[vi + 1])}><${Icon} name="chevron-right" size="sm" /></button>
      </span>`}
      <span class="grow"></span>
      ${old && html`<button class="btn sm" disabled=${busy} onClick=${async () => { await updateMeta({ restore: a.shown }); setV(0); }}><${Icon} name="rotate-ccw" size="sm" /> ${t('Make this the current one')}</button>`}
      ${a && html`<button class="btn sm primary" disabled=${busy || exporting} onClick=${save}>${exporting ? html`<${Icon} name="loader" cls="spin" size="sm" />` : html`<${Icon} name="download" size="sm" />`} ${t('Save PNG')}</button>
        <a class="icon-btn" title=${t('Download the HTML')} href=${`/api/artifacts/${a.id}/download?v=${a.shown}`} download><${Icon} name="code" /></a>
        <button class="icon-btn" title=${t('Delete')} onClick=${del}><${Icon} name="trash" /></button>`}
    </div>
    <div class="dz-body">
      <div class="dz-stage">
        <${Canvas} doc=${doc} fmt=${fmt} />
        ${busy && html`<div class="dz-live"><${Icon} name="loader" cls="spin" size="sm" /> ${live ? t('Designing… {n} tokens', { n: live }) : t('Reading the brief…')} <button class="btn sm" onClick=${() => ctrl.current?.abort()}>${t('Stop')}</button></div>`}
      </div>
      <aside class="dz-side">
        <div class="dz-history">
          ${(a?.prompts || (draft ? [{ text: draft.brief, version: 0 }] : [])).map((p, i) => html`<div class="dz-msg" key=${i}>
            <div class="bubble">${p.text}</div>
            ${p.version ? html`<button class="link-btn" onClick=${() => setV(p.version)}>${t('Version {n}', { n: a.versions.indexOf(p.version) + 1 || p.version })}</button>` : ''}
          </div>`)}
        </div>
        ${!a && !busy && draft && html`<div class="dz-tools"><button class="btn primary" onClick=${() => generate(draft.brief, true)}><${Icon} name="refresh-cw" size="sm" /> ${t('Try again')}</button></div>`}
        ${a && html`<div class="dz-tools">
          <div class="row wrap" style="gap:6px">
            ${images.map((u, i) => html`<span class="dz-att" title=${`{{image:${i + 1}}}`}><img src=${u} alt="" /><button title=${t('Remove')} onClick=${() => updateMeta({ images: images.filter((x) => x !== u) })}><${Icon} name="x" size="sm" /></button></span>`)}
            ${images.length < 8 && html`<button class="btn sm" onClick=${() => setPick(true)}><${Icon} name="image" size="sm" /> ${t('Picture')}</button>`}
            <span class="grow"></span>
            <label class="row" style="gap:6px;font-size:13px"><${Toggle} on=${a.brand} onChange=${(on) => updateMeta({ brand: on })} /> ${t('Brand')}</label>
            <button class="icon-btn" title=${t('Your brand')} onClick=${() => setBrandOpen(true)}><${Icon} name="sliders" size="sm" /></button>
          </div>
          <div class="dz-quick">${QUICK().map((q) => html`<button class="chip-btn outline" disabled=${busy} onClick=${() => generate(q)}>${q}</button>`)}<button class="chip-btn outline" disabled=${busy} onClick=${() => generate(a.prompts?.[0]?.text || a.title)}><${Icon} name="refresh-cw" size="sm" /> ${t('A new take')}</button></div>
          <div class="dz-ask">
            <textarea class="textarea" rows="3" value=${text} disabled=${busy} placeholder=${t('What to change? For example: put the price in a red circle.')} onInput=${(e) => setText(e.target.value)} onKeyDown=${(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}></textarea>
            <button class="btn primary" disabled=${busy || !text.trim()} onClick=${send}><${Icon} name="arrow-up" size="sm" /></button>
          </div>
        </div>`}
      </aside>
    </div>
    ${pick && html`<${PicturePicker} onPick=${(url) => updateMeta({ images: [...images, url] })} onClose=${() => setPick(false)} />`}
    ${brandOpen && html`<${BrandDialog} onClose=${() => setBrandOpen(false)} />`}
  </div>`;
}

// ---------------- The page ----------------

function DesignHome() {
  const [list, setList] = useState(null);
  const [creating, setCreating] = useState(false);
  const [brand, setBrand] = useState(false);
  useEffect(() => {
    api('/api/artifacts?kind=design').then((r) => setList(r.artifacts)).catch(toastError);
  }, []);
  return html`<div class="page"><div class="page-inner">
    <${PageHead} title=${t('Design')} text=${t('Posters, social posts, T-shirt prints, logos and flyers: describe it, change it by asking, save it as PNG at print size.')}>
      <button class="btn" onClick=${() => setBrand(true)}><${Icon} name="sliders" size="sm" /> ${t('Your brand')}</button>
      <button class="btn primary" onClick=${() => setCreating(true)}><${Icon} name="plus" size="sm" /> ${t('New design')}</button>
    <//>
    ${list === null
      ? html`<div class="empty"><${Icon} name="loader" cls="spin" /></div>`
      : !list.length
        ? html`<div class="card pad col" style="gap:14px;align-items:flex-start">
            <div class="row" style="gap:12px"><span class="a-icon"><${Icon} name="palette" /></span><div><b style="font-size:16px">${t('Your first design')}</b><p class="muted" style="margin:4px 0 0">${t('Pick a format, say what it should be, and Hearth lays it out. Then ask for changes until you like it, and save a PNG.')}</p></div></div>
            <button class="btn primary" onClick=${() => setCreating(true)}><${Icon} name="plus" size="sm" /> ${t('New design')}</button>
          </div>`
        : html`<div class="art-grid">${list.map((a) => html`<a class="art-card" href=${`#/design/${a.id}`} key=${a.id}>
            <${Thumb} a=${a} fit="both" />
            <div class="art-meta"><${Icon} name="palette" size="sm" /><div class="grow" style="min-width:0"><div class="ellipsis art-title">${a.title}</div><div class="faint" style="font-size:12.5px">${a.format?.name || ''} · ${when(a.updatedAt)}${a.versions?.length > 1 ? ` · ${tn(a.versions.length, '{n} version', '{n} versions')}` : ''}</div></div></div>
          </a>`)}</div>`}
    ${creating && html`<${NewDesign} onClose=${() => setCreating(false)} />`}
    ${brand && html`<${BrandDialog} onClose=${() => setBrand(false)} />`}
  </div></div>`;
}

export function DesignPage({ route }) {
  return route.id ? html`<${Editor} id=${route.id} key=${route.id} />` : html`<${DesignHome} />`;
}
