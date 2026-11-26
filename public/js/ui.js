// Small shared pieces: popovers, confirm dialog, toggle, sparkline, copy field.
import { html, useState, useEffect, useRef } from '../vendor/preact-htm.js';
import { Icon } from './icons.js';
import { set, getState, copyText, useStore } from './store.js';
import { t } from './i18n.js';

// A popover that closes on outside click or Escape.
export function Popover({ button, children, align = 'left', cls = '' }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  return html`<div class=${`pop-anchor ${cls}`} ref=${ref}>
    ${button({ open, toggle: () => setOpen(!open) })}
    ${open && html`<div class=${`pop ${align === 'right' ? 'right' : ''}`} onClick=${(e) => e.target.closest('[data-close]') && setOpen(false)}>${children}</div>`}
  </div>`;
}

// confirmDialog({ title, text, ok, danger }) → Promise<boolean>
export function confirmDialog(opts) {
  return new Promise((resolve) => {
    set({ dialog: { ...opts, resolve } });
  });
}

export function promptDialog(opts) {
  return new Promise((resolve) => {
    set({ dialog: { ...opts, input: opts.value ?? '', resolve } });
  });
}

export function Dialogs() {
  const d = getState().dialog;
  const [value, setValue] = useState('');
  const inputRef = useRef(null);
  useEffect(() => {
    if (d && d.input !== undefined) {
      setValue(d.input);
      setTimeout(() => inputRef.current?.select(), 30);
    }
  }, [d]);
  if (!d) return null;
  const close = (result) => {
    set({ dialog: null });
    d.resolve(result);
  };
  const isPrompt = d.input !== undefined;
  return html`<div class="overlay" onMouseDown=${(e) => e.target === e.currentTarget && close(isPrompt ? null : false)}>
    <form class="dialog" onSubmit=${(e) => { e.preventDefault(); close(isPrompt ? value : true); }}>
      <h3>${d.title}</h3>
      ${d.text && html`<p>${d.text}</p>`}
      ${isPrompt &&
      (d.multiline
        ? html`<textarea ref=${inputRef} class="textarea" value=${value} onInput=${(e) => setValue(e.target.value)} style="margin-bottom:18px;min-height:140px"></textarea>`
        : html`<input ref=${inputRef} class="input" value=${value} placeholder=${d.placeholder || ''} onInput=${(e) => setValue(e.target.value)} style="margin-bottom:18px" />`)}
      <div class="row" style="justify-content:flex-end">
        <button type="button" class="btn" onClick=${() => close(isPrompt ? null : false)}>${d.cancel || t('Cancel')}</button>
        <button type="submit" class=${`btn ${d.danger ? 'danger' : 'primary'}`} autofocus>${d.ok || t('OK')}</button>
      </div>
    </form>
  </div>`;
}

export function Toasts() {
  const { toasts } = getState();
  return html`<div class="toasts">${toasts.map((t) => html`<div key=${t.id} class=${`toast ${t.kind}`}>${t.text}</div>`)}</div>`;
}

export function Toggle({ on, onChange, disabled }) {
  return html`<button type="button" role="switch" aria-checked=${on} disabled=${disabled} class=${`toggle ${on ? 'on' : ''}`} onClick=${() => onChange(!on)}></button>`;
}

// A tiny line chart of recent values.
export function Sparkline({ values = [], max, color = 'var(--accent)' }) {
  const pts = values.map((v) => (v == null ? null : v));
  const top = max || Math.max(1, ...pts.filter((v) => v != null));
  const w = 100;
  const h = 30;
  const n = Math.max(pts.length, 2);
  const coords = pts.map((v, i) => (v == null ? null : [(i / (n - 1)) * w, h - (Math.min(v, top) / top) * (h - 2) - 1]));
  let d = '';
  coords.forEach((c, i) => {
    if (!c) return;
    d += `${d && coords[i - 1] ? 'L' : 'M'}${c[0].toFixed(1)},${c[1].toFixed(1)}`;
  });
  const valid = coords.filter(Boolean);
  const area = valid.length > 1 ? `${d}L${valid[valid.length - 1][0].toFixed(1)},${h}L${valid[0][0].toFixed(1)},${h}Z` : '';
  return html`<svg class="spark" viewBox=${`0 0 ${w} ${h}`} preserveAspectRatio="none">
    ${area && html`<path d=${area} fill=${color} opacity="0.12" />`}
    ${d && html`<path d=${d} fill="none" stroke=${color} stroke-width="1.6" vector-effect="non-scaling-stroke" stroke-linejoin="round" />`}
  </svg>`;
}

export function CopyField({ value, mask }) {
  const [show, setShow] = useState(!mask);
  return html`<div class="copy-field">
    <span>${show ? value : '•'.repeat(Math.min(32, String(value).length))}</span>
    ${mask && html`<button class="icon-btn" title=${show ? t('Hide') : t('Show')} onClick=${() => setShow(!show)}><${Icon} name=${show ? 'eye-off' : 'eye'} size="sm" /></button>`}
    <button class="icon-btn" title=${t('Copy')} onClick=${() => copyText(value)}><${Icon} name="copy" size="sm" /></button>
  </div>`;
}

export function Snippet({ code }) {
  return html`<div class="snippet"><pre>${code}</pre><button class="btn sm copy" onClick=${() => copyText(code)}><${Icon} name="copy" size="sm" /> ${t('Copy')}</button></div>`;
}

export function FitBadge({ fit }) {
  if (!fit) return null;
  const cls = { great: 'ok', ok: 'warn', ssd: 'accent', slow: 'warn', no: 'bad' }[fit.level] || '';
  return html`<span class=${`badge ${cls}`} title=${fit.detail || ''}>${fit.level === 'ssd' ? html`<${Icon} name="hard-drive" />` : ''}${fit.label}</span>`;
}

// A page header: title, one line of text, and buttons on the right.
export function PageHead({ title, text, children }) {
  return html`<div class="page-head">
    <div class="row" style="align-items:flex-start"><${SidebarToggle} /><div><h1>${title}</h1>${text && html`<p>${text}</p>`}</div></div>
    ${children && html`<div class="row wrap">${children}</div>`}
  </div>`;
}

export function engineDot(status) {
  const s = status?.engine?.status;
  return s === 'ready' ? 'ready' : s === 'starting' || s === 'stopping' ? 'starting' : s === 'error' ? 'error' : '';
}

// Shows the "open sidebar" button on pages when the sidebar is hidden.
export function SidebarToggle() {
  const { sidebarOpen } = useStore();
  if (sidebarOpen && window.innerWidth > 900) return null;
  return html`<button class="icon-btn" title=${t('Show sidebar')} onClick=${() => set({ sidebarOpen: true })}><${Icon} name="panel-left" /></button>`;
}
