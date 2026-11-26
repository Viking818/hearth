// The chat: messages, streaming answers, images, videos and documents, tools, voice, assistants, editing and branches,
// and the live preview pane.
import { html, useState, useEffect, useRef, useMemo } from '../vendor/preact-htm.js';
import { Icon } from './icons.js';
import { t, tn } from './i18n.js';
import { useStore, set, getState, api, toast, toastError, go, refreshChats, loadModel, makePrimary, pollEngine, copyText, modelLabel, fmtCtx, fmtBytes, fmtDec, saveFile, readPref, writePref } from './store.js';
import { openModelSettings } from './model-settings.js';
import { renderMarkdown, previewFrom, buildDoc } from './md.js';
import { Popover, confirmDialog, promptDialog, SidebarToggle, engineDot } from './ui.js';
import { DOC_EXT, extractDocument, estimateTokens } from './docs.js';
import { canRecord, startRecording, canSpeak, speak, stopSpeaking, speakingNow, resample, encodeWav } from './voice.js';
import { splitSlash, expandCommand, matchSlash } from './commands.js';
import { clock, videoType, isVideo, apiMessages } from './media.js';
import { contextUse, planCompact, summaryParts, summarize } from './compact.js';
import { announce } from './notify.js';
import { TalkPanel, canTalk } from './talk.js';

// "Compute error" is how the engine says it ran out of memory in the middle of an answer.
// A chat longer than the model can keep in mind: the engine refuses the request.
const isFull = (msg) => /exceeds? the available context|context (size|length|window)|too many tokens/i.test(msg || '');
const engineError = (msg) =>
  /compute error|out of memory|insufficient memory|failed to allocate/i.test(msg || '')
    ? t('The model ran out of memory while answering. Close other big apps or unload other models and try again. If it keeps happening, use a shorter context or Low-RAM mode in the model’s settings.')
    : isFull(msg)
      ? t('This chat no longer fits into what the model can keep in mind. Use “Summarize and continue” below, or start a new chat.')
      : msg;
const engineFail = (raw, fallback) => Object.assign(new Error(engineError(raw) || fallback), { full: isFull(raw) });

const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
const TEXT_EXT = /\.(txt|md|markdown|csv|tsv|json|jsonl|js|mjs|cjs|ts|tsx|jsx|py|rb|go|rs|java|kt|swift|c|h|cpp|hpp|cs|php|html|htm|css|scss|xml|svg|yaml|yml|toml|ini|cfg|conf|log|sh|bash|zsh|ps1|bat|sql|r|lua|dart|vue|svelte|env|srt|vtt|tex|rtf)$/i;
const MAX_ROUNDS = 8;

// Big photos are shrunk before upload: the model sees them at a few hundred pixels anyway.
async function prepareImage(file) {
  const MAX = 1600;
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, MAX / Math.max(bmp.width, bmp.height));
    if (scale === 1 && file.size < 3e6 && /png|jpe?g|webp|gif/.test(file.type)) return file;
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * scale);
    c.height = Math.round(bmp.height * scale);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    return await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.9));
  } catch {
    return file;
  }
}

const HEIC = /\.(heic|heif)$/i;

export async function uploadImage(file) {
  const blob = await prepareImage(file);
  // An iPhone photo the browser couldn't open goes as it is: on a Mac, Hearth turns it into a JPEG.
  const type = blob === file && (HEIC.test(file.name || '') || /hei[cf]/i.test(file.type)) ? 'image/heic' : blob.type || 'image/jpeg';
  return api('/api/uploads', { method: 'POST', raw: blob, headers: { 'content-type': type } });
}

// ---------------- Videos ----------------
const MAX_VIDEO = 2 * 1024 ** 3;
const MAX_FRAMES = 8;
const SPEECH_SECONDS = 600;

// A model can't watch a video, but it can look at pictures: a few frames, spread evenly, stand in for it.
async function videoFrames(file, type) {
  // Safari opens a video only when told its kind, and a file's own type is often empty.
  const src = URL.createObjectURL(file.type === type ? file : new Blob([file], { type }));
  const v = document.createElement('video');
  v.muted = true;
  v.playsInline = true;
  v.preload = 'auto';
  const wait = (name) =>
    new Promise((resolve, reject) => {
      const off = new AbortController();
      const end = (fn, arg) => {
        clearTimeout(timer);
        off.abort();
        fn(arg);
      };
      const timer = setTimeout(() => end(reject, new Error('timeout')), 20000);
      v.addEventListener(name, () => end(resolve), { signal: off.signal });
      v.addEventListener('error', () => end(reject, new Error('decode')), { signal: off.signal });
    });
  try {
    const loaded = wait('loadeddata');
    v.src = src;
    // Phones load nothing until a video plays; a silent play, stopped at once, gets it going.
    const nudge = setTimeout(() => v.play().then(() => v.pause(), () => {}), 1500);
    await loaded.finally(() => clearTimeout(nudge));
    v.pause();
    if (!v.videoWidth) throw new Error('decode');
    // Safari says "seeked" a moment before the new frame can be drawn; it tells when the frame is there.
    const webkit = !/Chrom(e|ium)/.test(navigator.userAgent);
    const painted = () =>
      webkit && v.requestVideoFrameCallback
        ? new Promise((r) => {
            const timer = setTimeout(r, 250);
            v.requestVideoFrameCallback(() => {
              clearTimeout(timer);
              r();
            });
          })
        : null;
    let duration = v.duration;
    if (!Number.isFinite(duration)) {
      // A recording without its length written in: the end is where a far jump lands.
      const jumped = wait('seeked');
      v.currentTime = 1e7;
      await jumped;
      duration = v.currentTime;
    }
    const n = Math.max(1, Math.min(MAX_FRAMES, Math.ceil(duration / 1.5)));
    const scale = Math.min(1, 768 / Math.max(v.videoWidth, v.videoHeight));
    // The JPEG is made on the spot: toBlob waits for the page to be idle, about a second per frame when the
    // window is in the background.
    const c = document.createElement('canvas');
    c.width = Math.max(2, Math.round(v.videoWidth * scale));
    c.height = Math.max(2, Math.round(v.videoHeight * scale));
    const jpeg = () => {
      const bin = atob(c.toDataURL('image/jpeg', 0.85).split(',')[1]);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return new Blob([bytes], { type: 'image/jpeg' });
    };
    const frames = [];
    for (let i = 0; i < n; i++) {
      const at = Math.max(0, Math.min(duration - 0.05, (duration * (i + 0.5)) / n));
      const there = wait('seeked');
      const frame = painted();
      v.currentTime = at;
      await there;
      await frame;
      c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
      frames.push({ at: Math.round(at * 10) / 10, blob: jpeg() });
    }
    return { duration, frames };
  } finally {
    v.removeAttribute('src');
    v.load();
    URL.revokeObjectURL(src);
  }
}

// What is said in the video, when Hearth's speech engine is set up (Settings → Voice). Nothing otherwise.
// The page reads the sound itself where it can; where it can't (Safari and MOV files), Hearth tries on its side.
async function videoSpeech(file, url) {
  const st = await api('/api/voice').catch(() => null);
  if (!st?.ready) return null;
  const Off = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  let audio = null;
  if (Off && file.size <= 400e6) {
    // The sound is decoded from the whole file in memory, so not for very big files.
    try {
      const bytes = await file.arrayBuffer();
      audio = await new Promise((resolve, reject) => {
        const p = new Off(1, 16000, 16000).decodeAudioData(bytes, resolve, reject);
        if (p?.then) p.then(resolve, reject);
      });
    } catch {}
  }
  if (!audio) {
    const r = await api('/api/voice/video', { method: 'POST', body: { url } });
    return { text: String(r.text || '').trim(), cut: Boolean(r.cut) };
  }
  const length = Math.min(audio.length, Math.floor(SPEECH_SECONDS * audio.sampleRate));
  const mono = new Float32Array(length);
  let peak = 0;
  for (let ch = 0; ch < audio.numberOfChannels; ch++) {
    const data = audio.getChannelData(ch);
    for (let i = 0; i < length; i++) mono[i] += data[i] / audio.numberOfChannels;
  }
  for (let i = 0; i < length; i += 8) peak = Math.max(peak, Math.abs(mono[i]));
  if (peak < 0.01) return null; // silence
  const { text } = await api('/api/voice/transcribe?lang=auto&long=1', { method: 'POST', raw: encodeWav(resample(mono, audio.sampleRate, 16000), 16000), headers: { 'content-type': 'audio/wav' } });
  return { text: String(text || '').trim(), cut: audio.duration > SPEECH_SECONDS };
}

// A video can be gigabytes, so it is sent with a progress bar and can be stopped.
function uploadVideo(file, type, onProgress) {
  const x = new XMLHttpRequest();
  const promise = new Promise((resolve, reject) => {
    x.open('POST', '/api/uploads');
    x.setRequestHeader('content-type', type);
    x.setRequestHeader('x-hearth-lang', document.documentElement.lang || 'en');
    x.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    x.onload = () => {
      let d = null;
      try {
        d = JSON.parse(x.responseText);
      } catch {}
      if (x.status >= 200 && x.status < 300 && d?.url) resolve(d);
      else reject(new Error(d?.error?.message || t('Request failed ({status})', { status: x.status })));
    };
    x.onerror = () => reject(new Error(t('Hearth is not running. Start it again from the Hearth launcher.')));
    x.onabort = () => reject(new DOMException('stopped', 'AbortError'));
    x.send(file);
  });
  return { promise, abort: () => x.abort() };
}

let pdfjsP = null;
export function loadPdfjs() {
  if (!pdfjsP)
    pdfjsP = import('/vendor/pdfjs/pdf.min.mjs').then((m) => {
      m.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.mjs';
      return m;
    });
  return pdfjsP;
}

// Pages of a scanned PDF as pictures, for models that can see.
async function pdfPagesAsImages(bytes, maxPages = 8) {
  const pdfjs = await loadPdfjs();
  const doc = await pdfjs.getDocument({ data: bytes }).promise;
  const out = [];
  for (let i = 1; i <= Math.min(doc.numPages, maxPages); i++) {
    const page = await doc.getPage(i);
    const vp1 = page.getViewport({ scale: 1 });
    const vp = page.getViewport({ scale: Math.min(2.5, 1400 / vp1.width) });
    const c = document.createElement('canvas');
    c.width = Math.round(vp.width);
    c.height = Math.round(vp.height);
    await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
    const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.85));
    out.push(await api('/api/uploads', { method: 'POST', raw: blob, headers: { 'content-type': 'image/jpeg' } }));
  }
  return { images: out, total: doc.numPages };
}

const ctxLimit = () => {
  const st = getState().status;
  return st?.engine?.ctx || st?.settings?.contextSize || 32768;
};

// ---------------- Model picker (chat header) ----------------
function ModelPicker() {
  const { models, status } = useStore();
  const eng = status?.engine;
  const cur = eng?.model || status?.settings?.lastModel;
  const chatModels = models.filter((m) => m.kind === 'chat');
  const label = cur ? modelLabel(cur) : t('Choose a model');
  return html`<${Popover}
    button=${({ toggle }) => html`<button class="model-pick" onClick=${toggle} title=${t('Model')}>
      <span class=${`dot ${engineDot(status)}`}></span>
      <span class="ellipsis">${eng?.status === 'starting' ? t('Loading {name}…', { name: cur?.name || '' }) : label}</span>
      <${Icon} name="chevron-down" size="sm" />
    </button>`}
  >
    <div class="pop-label">${t('Models on this computer')}</div>
    ${!chatModels.length && html`<div class="pop-item muted">${t('No models yet')}</div>`}
    ${chatModels.map((m) => {
      // A model that is already loaded becomes the chat's model at once; others are loaded first.
      const run = eng?.loaded?.find((r) => r.model?.id === m.id);
      const pick = () => (run?.status === 'ready' ? !run.primary && makePrimary(m.id) : run?.status === 'starting' ? null : loadModel(m));
      return html`<button key=${m.id} class="pop-item" data-close onClick=${pick}>
        <span class="grow">
          <div class="ellipsis" style="font-weight:550">${modelLabel(m)}</div>
          <div class="sub">${fmtBytes(m.size)} · ${m.sourceLabel}${m.vision ? ` · ${t('sees images')}` : ''}</div>
        </span>
        ${run?.status === 'ready' && run.primary ? html`<${Icon} name="check" cls="fit-great" />` : run?.status === 'ready' ? html`<span class="badge ok">${t('loaded')}</span>` : run?.status === 'starting' ? html`<${Icon} name="loader" cls="spin" size="sm" />` : m.fit?.level === 'no' ? html`<span class="badge bad">${t('Too big')}</span>` : ''}
      </button>`;
    })}
    <div class="pop-sep"></div>
    ${models.find((x) => x.id === cur?.id) && html`<button class="pop-item" data-close onClick=${() => openModelSettings(models.find((x) => x.id === cur.id))}><${Icon} name="sliders" size="sm" /> ${t('Model settings')}</button>`}
    <button class="pop-item" data-close onClick=${() => go('#/models/get')}><${Icon} name="download" size="sm" /> ${t('Get more models')}</button>
  <//>`;
}

function AssistantPicker({ value, onChange }) {
  const { assistants } = useStore();
  const cur = assistants.find((a) => a.id === value);
  return html`<${Popover}
    button=${({ toggle }) => html`<button class=${`chip-btn ${cur ? 'on' : ''}`} onClick=${toggle} title=${t('Assistant: a role with its own instructions')}>
      <${Icon} name=${cur?.icon || 'bot'} size="sm" /><span class="chip-label">${cur ? cur.name : t('Assistant')}</span>
    </button>`}
  >
    <div class="pop-label">${t('Assistants')}</div>
    <button class="pop-item" data-close onClick=${() => onChange('')}>
      <${Icon} name="message-square" size="sm" /><span class="grow">${t('Plain chat')}</span>${!cur && html`<${Icon} name="check" size="sm" />`}
    </button>
    ${assistants.map(
      (a) => html`<button key=${a.id} class="pop-item" data-close onClick=${() => onChange(a.id)}>
        <${Icon} name=${a.icon} size="sm" /><span class="grow"><div style="font-weight:550">${a.name}</div><div class="sub">${a.description}</div></span>${cur?.id === a.id && html`<${Icon} name="check" size="sm" />`}
      </button>`,
    )}
    <div class="pop-sep"></div>
    <button class="pop-item" data-close onClick=${() => go('#/assistants')}><${Icon} name="pencil" size="sm" /> ${t('Edit assistants')}</button>
  <//>`;
}

// ---------------- Messages ----------------
export function ToolSteps({ steps }) {
  if (!steps?.length) return null;
  // Pictures a connector tool sent back are kept by Hearth; they are shown under the steps.
  const made = [...new Set(steps.flatMap((s) => String(s.result || '').match(/\/uploads\/tool-[\w-]+\.(?:png|jpg|webp|gif)/g) || []))];
  return html`<div class="tool-steps">
    ${steps.map((s) => {
      const arg = s.args?.query || s.args?.url || s.args?.path || s.args?.fact || '';
      return html`<details class=${`tool-step ${s.status}`} key=${s.id}>
        <summary>
          ${s.status === 'running' ? html`<${Icon} name="loader" cls="spin" size="sm" />` : html`<${Icon} name=${s.status === 'error' || s.status === 'denied' ? 'x-circle' : s.icon || 'wrench'} size="sm" />`}
          <span class="ts-title">${s.title}</span>
          ${arg && html`<span class="ts-arg ellipsis">${arg}</span>`}
          ${s.status === 'denied' && html`<span class="faint">${t('declined')}</span>`}
        </summary>
        <pre class="ts-body">${s.error ? `${t('Error')}: ${s.error}` : s.result || ''}</pre>
      </details>`;
    })}
    ${made.length > 0 && html`<div class="tool-media">${made.map((u) => html`<img key=${u} src=${u} alt="" loading="lazy" data-zoom />`)}</div>`}
  </div>`;
}

function VideoBox({ v }) {
  const [gone, setGone] = useState(false);
  const about = [clock(v.duration), v.transcript ? t('with speech') : ''].filter(Boolean).join(' · ');
  return html`<figure class="msg-video">
    ${gone
      ? html`<div class="msg-video-gone"><${Icon} name="film" /> ${t('The video file is no longer here.')}</div>`
      : html`<video src=${v.url} poster=${v.poster || ''} controls playsinline preload="metadata" onError=${() => setGone(true)}></video>`}
    <figcaption><${Icon} name="film" size="sm" /><span class="ellipsis">${v.name}</span><span class="faint">${about}</span></figcaption>
  </figure>`;
}

function UserMessage({ m, onImage, onEdit, onBranch, onJump, busy }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(m.content || '');
  if (editing)
    return html`<div class="msg user">
      <div class="edit-box">
        <textarea class="textarea" value=${text} onInput=${(e) => setText(e.target.value)} rows="3"></textarea>
        <div class="row" style="justify-content:flex-end">
          <button class="btn sm" onClick=${() => { setEditing(false); setText(m.content || ''); }}>${t('Cancel')}</button>
          <button class="btn sm primary" disabled=${busy || !text.trim()} onClick=${() => { setEditing(false); onEdit(m.id, text.trim()); }}>${t('Send again')}</button>
        </div>
      </div>
    </div>`;
  return html`<div class="msg user" data-mid=${m.id}>
    ${m.quotes?.length > 0 && html`<div class="msg-quotes">${m.quotes.map((q) => html`<button class="msg-quote" title=${t('Go to the quoted message')} onClick=${() => onJump(q.msgId)}><${Icon} name="quote" size="sm" /><span>${q.text}</span></button>`)}</div>`}
    ${m.images?.length > 0 && html`<div class="msg-images">${m.images.map((im) => html`<img src=${im.url} alt=${im.name || ''} onClick=${() => onImage(im.url)} />`)}</div>`}
    ${m.videos?.length > 0 && html`<div class="msg-images">${m.videos.map((v) => html`<${VideoBox} key=${v.url} v=${v} />`)}</div>`}
    ${m.files?.length > 0 && html`<div class="msg-files">${m.files.map((f) => html`<span class="file-chip" title=${f.note || ''}><${Icon} name=${f.kind === 'excel' ? 'file-spreadsheet' : 'file-text'} size="sm" />${f.name}<span class="faint">${f.pages ? tn(f.pages, '{n} page', '{n} pages') : fmtBytes(f.size)}${f.truncated ? ` · ${t('part')}` : ''}</span></span>`)}</div>`}
    ${m.content && html`<div class="bubble">${m.content}</div>`}
    <div class="msg-tools">
      <button class="icon-btn" title=${t('Copy')} onClick=${() => copyText(m.content || '')}><${Icon} name="copy" size="sm" /></button>
      <button class="icon-btn" title=${t('Edit and send again')} disabled=${busy} onClick=${() => setEditing(true)}><${Icon} name="pencil" size="sm" /></button>
      <button class="icon-btn" title=${t('Branch from here')} disabled=${busy} onClick=${() => onBranch(m.id)}><${Icon} name="git-branch" size="sm" /></button>
    </div>
  </div>`;
}

function AssistantMessage({ m, last, streaming, onRegenerate, onPreview, onBranch, onQuote }) {
  const { html: body, blocks } = useMemo(() => renderMarkdown(m.content || ''), [m.content]);
  const [speaking, setSpeaking] = useState(false);
  const loadingModel = getState().status?.engine?.status === 'starting';
  const onClick = (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const i = Number(b.dataset.i);
    const act = b.dataset.act;
    if (act === 'copy') copyText(blocks[i]?.code || '');
    if (act === 'preview' || act === 'code') onPreview(m.id, blocks, i, act === 'code' ? 'code' : 'preview');
  };
  const thinking = m.reasoning && m.reasoning.trim();
  const active = streaming && last;
  const s = m.stats;
  const read = () => {
    if (speaking || speakingNow() === m.id) {
      stopSpeaking();
      setSpeaking(false);
      return;
    }
    setSpeaking(true);
    speak(m.id, m.content, () => setSpeaking(false));
  };
  return html`<div class="msg assistant" data-mid=${m.id}>
    ${thinking && html`<details class="thinking" open=${active && !m.content}>
      <summary><${Icon} name="lightbulb" size="sm" /> ${active && !m.content ? t('Thinking…') : m.stats?.thinkMs ? t('Thought for {n} s', { n: Math.max(1, Math.round(m.stats.thinkMs / 1000)) }) : t('Thought')} <${Icon} name="chevron-down" size="sm" /></summary>
      <div class="think-body">${m.reasoning}</div>
    </details>`}
    <${ToolSteps} steps=${m.steps} />
    ${m.content
      ? html`<div class="md" onClick=${onClick} dangerouslySetInnerHTML=${{ __html: body }}></div>`
      : active && !thinking && !m.steps?.some((x) => x.status === 'running') && html`<div class="row muted">${loadingModel ? html`<${Icon} name="loader" cls="spin" size="sm" /> ${t('Loading the model…')}` : html`<span class="typing"><i></i><i></i><i></i></span>`}</div>`}
    ${m.error && html`<div class="notice bad msg-error"><${Icon} name="alert" /><div>${m.error}</div></div>`}
    ${!active && (m.content || m.error) && html`<div class="msg-tools">
      <button class="icon-btn" title=${t('Copy')} onClick=${() => copyText(m.content || '')}><${Icon} name="copy" size="sm" /></button>
      ${last && html`<button class="icon-btn" title=${t('Answer again')} onClick=${onRegenerate}><${Icon} name="refresh-cw" size="sm" /></button>`}
      ${canSpeak() && m.content && html`<button class=${`icon-btn ${speaking ? 'on' : ''}`} title=${speaking ? t('Stop reading') : t('Read aloud')} onClick=${read}><${Icon} name=${speaking ? 'square' : 'volume-2'} size="sm" /></button>`}
      ${m.content && html`<button class="icon-btn" title=${t('Quote in my next message (select a part first to quote only that)')} onClick=${() => onQuote(m)}><${Icon} name="quote" size="sm" /></button>`}
      <button class="icon-btn" title=${t('Branch from here')} onClick=${() => onBranch(m.id)}><${Icon} name="git-branch" size="sm" /></button>
      ${m.artifact && html`<a class="icon-btn" title=${t('Open in Artifacts')} href=${`#/artifacts/${m.artifact}`}><${Icon} name="layout-grid" size="sm" /></a>`}
      ${s && html`<span class="msg-stats">${s.tokPerSec ? `${fmtDec(s.tokPerSec)} ${t('tok/s')} · ` : ''}${s.outputTokens != null ? tn(s.outputTokens, '{n} token', '{n} tokens') : ''}${s.ms ? ` · ${t('{n} s', { n: fmtDec(s.ms / 1000) })}` : ''}${m.stopped ? ` · ${t('stopped')}` : ''}</span>`}
    </div>`}
  </div>`;
}

// ---------------- Preview pane ----------------
function PreviewPane({ pv, streaming, width, onWidth, onClose, onTab, artifact }) {
  const [shown, setShown] = useState(pv.doc);
  const [reloadKey, setReloadKey] = useState(0);
  const [full, setFull] = useState(false);
  const lastSet = useRef(0);
  // While the model is still writing, refresh the page at most every 0.8 s so it doesn't flicker.
  useEffect(() => {
    const wait = pv.closed || !streaming ? 0 : Math.max(0, 800 - (Date.now() - lastSet.current));
    const timer = setTimeout(() => {
      lastSet.current = Date.now();
      setShown(pv.doc);
    }, wait);
    return () => clearTimeout(timer);
  }, [pv.doc, pv.closed, streaming]);

  const startDrag = (e) => {
    e.preventDefault();
    const el = e.currentTarget;
    el.classList.add('drag');
    const startX = e.clientX;
    const startW = width;
    const frames = document.querySelectorAll('iframe');
    frames.forEach((f) => (f.style.pointerEvents = 'none'));
    const move = (ev) => onWidth(Math.max(320, Math.min(window.innerWidth - 420, startW - (ev.clientX - startX))));
    const up = () => {
      el.classList.remove('drag');
      frames.forEach((f) => (f.style.pointerEvents = ''));
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };
  // A new window shows the page sandboxed, like the pane: what the model wrote never runs as Hearth itself.
  const openWindow = () => {
    if (artifact) return window.open(`/api/artifacts/${artifact}/view`, '_blank', 'noopener');
    const w = window.open('', '_blank');
    if (!w) return;
    w.document.write('<!doctype html><meta charset="utf-8"><title>Hearth</title><style>html,body{margin:0;height:100%}iframe{border:0;width:100%;height:100%;display:block}</style><iframe sandbox="allow-scripts allow-forms allow-modals allow-popups allow-pointer-lock"></iframe>');
    w.document.close();
    w.document.querySelector('iframe').srcdoc = pv.doc;
  };
  const download = () => saveFile(pv.name, pv.kind === 'svg' ? pv.code : pv.doc, pv.kind === 'svg' ? 'image/svg+xml' : 'text/html');
  return html`
    <div class="splitter" onMouseDown=${startDrag}></div>
    <section class=${`preview ${full ? 'full' : ''}`} style=${{ width: `${width}px` }}>
      <div class="preview-head">
        <span class="file-tab"><${Icon} name=${pv.kind === 'svg' ? 'image' : 'code'} size="sm" /><span class="ellipsis">${pv.name}</span></span>
        <div class="seg">
          <button class=${pv.tab === 'preview' ? 'on' : ''} onClick=${() => onTab('preview')}><${Icon} name="eye" size="sm" /> ${t('Preview')}</button>
          <button class=${pv.tab === 'code' ? 'on' : ''} onClick=${() => onTab('code')}><${Icon} name="code" size="sm" /> ${t('Code')}</button>
        </div>
        <span class="grow"></span>
        <button class="icon-btn" title=${t('Reload')} onClick=${() => { setShown(pv.doc); setReloadKey((k) => k + 1); }}><${Icon} name="refresh-cw" /></button>
        <button class="icon-btn" title=${t('Copy code')} onClick=${() => copyText(pv.code)}><${Icon} name="copy" /></button>
        <button class="icon-btn" title=${t('Save file')} onClick=${download}><${Icon} name="download" /></button>
        <button class="icon-btn" title=${t('Open in a new window')} onClick=${openWindow}><${Icon} name="external-link" /></button>
        <button class="icon-btn" title=${full ? t('Exit full screen') : t('Full screen')} onClick=${() => setFull(!full)}><${Icon} name=${full ? 'minimize' : 'maximize'} /></button>
        <button class="icon-btn" title=${t('Close preview')} onClick=${onClose}><${Icon} name="panel-right" /></button>
      </div>
      <div class="preview-body">
        ${!pv.closed && streaming && html`<span class="badge accent preview-badge"><${Icon} name="loader" cls="spin" size="sm" /> ${t('Writing…')}</span>`}
        ${pv.tab === 'preview'
          ? html`<iframe key=${reloadKey} title=${t('Preview')} sandbox="allow-scripts allow-forms allow-modals allow-pointer-lock allow-popups" srcdoc=${shown}></iframe>`
          : html`<pre>${pv.code}</pre>`}
      </div>
    </section>`;
}

// ---------------- Microphone ----------------
function MicButton({ onText, disabled }) {
  const [rec, setRec] = useState(null);
  const [busy, setBusy] = useState(false);
  const [level, setLevel] = useState(0);
  const [secs, setSecs] = useState(0);
  useEffect(() => {
    if (!rec) return;
    const timer = setInterval(() => {
      setLevel(rec.level());
      setSecs(rec.seconds());
    }, 100);
    return () => clearInterval(timer);
  }, [rec]);
  useEffect(() => () => rec?.cancel(), [rec]);
  if (!canRecord()) return null;
  const toggle = async () => {
    if (busy) return;
    if (rec) {
      setBusy(true);
      const r = rec;
      setRec(null);
      try {
        const wav = await r.stop();
        if (r.seconds() < 0.6) return;
        const { text } = await api('/api/voice/transcribe?lang=auto', { method: 'POST', raw: wav, headers: { 'content-type': 'audio/wav' } });
        if (text) onText(text);
        else toast(t('Nothing was heard. Try again a little closer to the microphone.'));
      } catch (err) {
        toastError(err);
      } finally {
        setBusy(false);
      }
      return;
    }
    try {
      const st = await api('/api/voice');
      if (!st.ready) {
        if (await confirmDialog({ title: t('Voice input needs a one-time setup'), text: st.needsHomebrew ? t('Hearth needs the free speech engine whisper.cpp and a {size} speech model. Settings shows how to add them in a minute.', { size: fmtBytes(st.modelSize) }) : t('Hearth will download the speech engine and a {size} speech model. It then works without internet.', { size: fmtBytes(st.modelSize) }), ok: t('Open voice settings') })) go('#/settings/voice');
        return;
      }
      setRec(await startRecording());
    } catch (err) {
      toast(err?.name === 'NotAllowedError' ? t('Hearth may not use the microphone. Allow it in the browser or in System Settings → Privacy → Microphone.') : String(err.message || err), 'bad');
    }
  };
  return html`<button class=${`chip-btn mic ${rec ? 'rec' : ''}`} disabled=${disabled} title=${rec ? t('Stop and turn into text') : t('Speak instead of typing')} onClick=${toggle}>
    ${busy ? html`<${Icon} name="loader" cls="spin" size="sm" />` : html`<${Icon} name=${rec ? 'square' : 'mic'} size="sm" />`}
    ${rec && html`<span class="mic-level" style=${{ transform: `scaleX(${0.15 + level * 0.85})` }}></span><span class="mic-time">${Math.floor(secs / 60)}:${String(Math.floor(secs % 60)).padStart(2, '0')}</span>`}
    ${busy && html`<span class="chip-label">${t('Listening…')}</span>`}
  </button>`;
}

// ---------------- Composer ----------------
function Composer({ streaming, onSend, onStop, vision, think, setThink, tools, setTools, toolsAvailable, assistantId, setAssistant, focusTick, draft, slash = [], skills = [], setSkills, quotes = [], setQuotes, queued, onCompact, use = 0, talking = false, onTalk }) {
  const [text, setTextRaw] = useState('');
  const [sel, setSel] = useState(0);
  const [menuOff, setMenuOff] = useState(false);
  const setText = (v) => {
    setTextRaw(v);
    setMenuOff(false);
  };
  const [images, setImages] = useState([]); // {id, url, name, uploading}
  const [files, setFiles] = useState([]); // {id, name, size, text, kind, pages, truncated, reading}
  const [videos, setVideos] = useState([]); // {id, name, size, url, duration, poster, frames, transcript, busy, progress}
  const stops = useRef(new Map()); // id → stop the upload
  const [drag, setDrag] = useState(false);
  const ta = useRef(null);
  const fileInput = useRef(null);
  const { status } = useStore();

  useEffect(() => ta.current?.focus(), [focusTick]);
  useEffect(() => {
    if (draft?.text) setText(draft.text);
    if (draft?.images?.length) setImages(draft.images.map((im) => ({ id: uid(), ...im })));
    if (draft?.files?.length) setFiles(draft.files.map((f) => ({ id: uid(), ...f })));
    if (draft?.videos?.length) setVideos(draft.videos.map((v) => ({ id: uid(), ...v })));
  }, [draft]);
  useEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 260)}px`;
  }, [text]);

  const addImage = async (file) => {
    const id = uid();
    const local = URL.createObjectURL(file);
    setImages((x) => [...x, { id, url: local, name: file.name, uploading: true }]);
    try {
      const r = await uploadImage(file);
      setImages((x) => x.map((im) => (im.id === id ? { id, url: r.url, name: file.name } : im)));
    } catch (err) {
      setImages((x) => x.filter((im) => im.id !== id));
      toastError(err);
    }
  };

  const addVideo = async (file) => {
    const type = videoType(file);
    if (!type) return toast(t('{name}: this kind of video can’t be added. MP4, MOV and WebM videos work.', { name: file.name }), 'bad');
    if (file.size > MAX_VIDEO) return toast(t('{name} is too big (over 2 GB).', { name: file.name }), 'bad');
    const id = uid();
    const patch = (p) => setVideos((x) => x.map((v) => (v.id === id ? { ...v, ...p } : v)));
    let stopped = false;
    stops.current.set(id, () => (stopped = true));
    setVideos((x) => [...x, { id, name: file.name, size: file.size, busy: 'reading', progress: 0 }]);
    try {
      let shot;
      try {
        shot = await videoFrames(file, type);
      } catch {
        throw new Error(t('this video can’t be opened here. Converting it to an ordinary MP4 usually helps.'));
      }
      const frames = [];
      for (const f of shot.frames) {
        if (stopped) return;
        frames.push({ at: f.at, url: (await api('/api/uploads', { method: 'POST', raw: f.blob, headers: { 'content-type': 'image/jpeg' } })).url });
      }
      if (stopped) return;
      patch({ duration: shot.duration, poster: frames[Math.min(1, frames.length - 1)]?.url || '', frames, busy: 'uploading' });
      const up = uploadVideo(file, type, (progress) => patch({ progress }));
      stops.current.set(id, () => {
        stopped = true;
        up.abort();
      });
      const r = await up.promise;
      patch({ url: r.url, busy: 'listening' });
      const speech = await videoSpeech(file, r.url).catch(() => null);
      patch({ busy: '', ...(speech?.text ? { transcript: speech.text, speechCut: speech.cut } : {}) });
    } catch (err) {
      setVideos((x) => x.filter((v) => v.id !== id));
      if (!stopped) toast(`${file.name}: ${err.message || err}`, 'bad');
    } finally {
      stops.current.delete(id);
    }
  };
  const removeVideo = (id) => {
    stops.current.get(id)?.();
    setVideos((x) => x.filter((v) => v.id !== id));
  };

  const addDocument = async (file) => {
    const id = uid();
    setFiles((x) => [...x, { id, name: file.name, size: file.size, reading: true }]);
    try {
      if (file.size > 150e6) throw new Error(t('{name} is too big (over 150 MB).', { name: file.name }));
      const bytes = new Uint8Array(await file.arrayBuffer());
      const isPdf = /\.pdf$/i.test(file.name);
      const doc = await extractDocument(file.name, bytes.slice(), { pdfjs: isPdf ? await loadPdfjs() : null });
      if (doc.scanned) {
        // A scan has no text layer: send its first pages as pictures to a model that can see.
        setFiles((x) => x.filter((f) => f.id !== id));
        if (!vision) return toast(t('{name} is a scan without text. Load a model that sees images to read it.', { name: file.name }), 'bad');
        const r = await pdfPagesAsImages(bytes);
        setImages((x) => [...x, ...r.images.map((im, i) => ({ id: uid(), url: im.url, name: `${file.name} · ${i + 1}` }))]);
        if (r.total > r.images.length) toast(t('{name}: the model will see the first {n} of {total} pages.', { name: file.name, n: r.images.length, total: r.total }));
        return;
      }
      // Keep within what the model can hold, leaving room for the question and the answer.
      const budget = Math.max(2000, Math.floor(ctxLimit() * 0.7) - 1500);
      let body = doc.text;
      let truncated = doc.truncated;
      const tokens = estimateTokens(body);
      if (tokens > budget) {
        body = `${body.slice(0, Math.floor(body.length * (budget / tokens)))}\n\n[${t('The rest of the document was cut: it is longer than the model can keep in mind. A bigger context in Settings lets it read more.')}]`;
        truncated = true;
        toast(t('{name} is long (about {tokens} tokens); the model will read the first part. A bigger context in Settings helps.', { name: file.name, tokens: Math.round(tokens / 100) * 100 }));
      }
      setFiles((x) => x.map((f) => (f.id === id ? { id, name: file.name, size: file.size, text: body, kind: doc.kind, pages: doc.totalPages || 0, truncated } : f)));
    } catch (err) {
      setFiles((x) => x.filter((f) => f.id !== id));
      toast(t('Could not read {name}: {err}', { name: file.name, err: err.message || err }), 'bad');
    }
  };

  const addFiles = async (list) => {
    for (const file of list) {
      if (file.type.startsWith('image/') || HEIC.test(file.name)) addImage(file);
      else if (isVideo(file)) addVideo(file);
      else if (DOC_EXT.test(file.name)) addDocument(file);
      else if (file.type.startsWith('text/') || TEXT_EXT.test(file.name)) {
        if (file.size > 2e6) {
          toast(t('{name} is too big to add as text (max 2 MB).', { name: file.name }), 'bad');
          continue;
        }
        const tx = await file.text();
        setFiles((x) => [...x, { id: uid(), name: file.name, size: file.size, text: tx, kind: 'text' }]);
      } else toast(t('{name}: Hearth can add images, videos, documents (PDF, Word, Excel, PowerPoint) and text files.', { name: file.name }), 'bad');
    }
  };

  const busyFiles = images.some((i) => i.uploading) || files.some((f) => f.reading) || videos.some((v) => v.busy);
  // The "/" menu: commands and skills that match what has been typed after the slash.
  const typed = /^\/([^\s]*)$/.exec(text)?.[1];
  const options = typed !== undefined && !menuOff ? matchSlash(slash, typed) : [];
  const skillName = (id) => slash.find((i) => i.kind === 'skill' && i.id === id)?.title || id.split(':').pop();
  const turnOnSkill = (item) => {
    if (!skills.includes(item.id)) setSkills([...skills, item.id]);
    toast(t('The skill “{name}” is on in this chat.', { name: item.title || item.name }));
  };
  const pick = (item) => {
    if (item.kind === 'skill') {
      turnOnSkill(item);
      setText('');
    } else setText(`/${item.name} `);
    ta.current?.focus();
  };
  const submit = () => {
    if (busyFiles) return toast(t('Wait a moment, the files are still being read.'));
    if (!text.trim() && !images.length && !files.length && !videos.length) return;
    // While an answer is being written, the message waits and goes out when the answer is finished.
    if (streaming && queued) return toast(t('One message is already waiting. It goes out when this answer is finished.'));
    if (/^\/(compact|сжать)\s*$/i.test(text.trim()) && !images.length && !files.length && !videos.length) {
      setText('');
      return onCompact();
    }
    if (images.length && vision === false) toast(t('This model can’t see images. Pick one with “sees images” in the model menu.'), 'bad');
    else if (videos.length && vision === false) toast(t('This model can’t see images, so it won’t see the video, only read what is said in it. Pick one with “sees images” in the model menu.'), 'bad');
    let body = text.trim();
    let prompt;
    const sl = splitSlash(body);
    const item = sl && (slash.find((i) => i.name === sl.name) || slash.find((i) => i.name.split(':').pop() === sl.name));
    if (item?.kind === 'skill') {
      turnOnSkill(item);
      body = sl.rest;
      if (!body && !images.length && !files.length && !videos.length) return setText('');
    } else if (item?.kind === 'command') prompt = expandCommand(item.prompt, sl.rest);
    onSend({ text: body, prompt, images: images.map(({ url, name }) => ({ url, name })), files: files.map(({ id, reading, ...f }) => f), videos: videos.map(({ id, busy, progress, ...v }) => v), quotes });
    setText('');
    setImages([]);
    setFiles([]);
    setVideos([]);
  };

  const onKey = (e) => {
    if (options.length) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        setSel((i) => (i + (e.key === 'ArrowDown' ? 1 : options.length - 1)) % options.length);
        return;
      }
      if ((e.key === 'Enter' || e.key === 'Tab') && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        pick(options[Math.min(sel, options.length - 1)]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setMenuOff(true);
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      submit();
    }
  };
  const onPaste = (e) => {
    const fl = [...(e.clipboardData?.files || [])];
    if (fl.length) {
      e.preventDefault();
      addFiles(fl);
    }
  };
  const eng = status?.engine;
  const model = eng?.model || status?.settings?.lastModel;
  const hasContent = text.trim() || images.length || files.length || videos.length;
  return html`<div class="composer-wrap">
    <div
      class=${`composer ${drag ? 'drag' : ''}`}
      onDragOver=${(e) => { e.preventDefault(); setDrag(true); }}
      onDragLeave=${() => setDrag(false)}
      onDrop=${(e) => { e.preventDefault(); setDrag(false); addFiles([...e.dataTransfer.files]); }}
    >
      ${options.length > 0 && html`<div class="slash-menu" role="listbox">
        ${options.map((o, i) => html`<button type="button" key=${o.kind + o.name} class=${`slash-item ${i === Math.min(sel, options.length - 1) ? 'on' : ''}`} onMouseEnter=${() => setSel(i)} onMouseDown=${(e) => { e.preventDefault(); pick(o); }}>
          <${Icon} name=${o.kind === 'skill' ? 'sparkles' : 'terminal'} size="sm" />
          <span class="slash-name">/${o.name}</span>
          <span class="slash-desc">${o.kind === 'skill' ? `${t('Skill')} · ` : ''}${o.description}</span>
          ${o.plugin && html`<span class="badge">${o.plugin}</span>`}
        </button>`)}
      </div>`}
      ${skills.length > 0 && html`<div class="skill-chips">${skills.map((id) => html`<span class="skill-chip" key=${id} title=${t('This skill’s instructions go with every message of this chat.')}><${Icon} name="sparkles" size="sm" /> ${skillName(id)}<button title=${t('Turn off in this chat')} onClick=${() => setSkills(skills.filter((x) => x !== id))}><${Icon} name="x" size="sm" /></button></span>`)}</div>`}
      ${quotes.length > 0 && html`<div class="quote-chips">${quotes.map((q, i) => html`<div class="quote-chip" key=${i}><${Icon} name="quote" size="sm" /><span>${q.text}</span><button title=${t('Remove this quote')} onClick=${() => setQuotes(quotes.filter((_, k) => k !== i))}><${Icon} name="x" size="sm" /></button></div>`)}</div>`}
      ${(images.length > 0 || files.length > 0 || videos.length > 0) && html`<div class="attach-row">
        ${images.map((im) => html`<div class="thumb" key=${im.id}><img src=${im.url} alt="" />${im.uploading && html`<div class="loading"><${Icon} name="loader" cls="spin" /></div>`}<button class="x" title=${t('Remove')} onClick=${() => setImages((x) => x.filter((i) => i.id !== im.id))}><${Icon} name="x" /></button></div>`)}
        ${videos.map((v) => html`<div class="video-att" key=${v.id}>
          <div class="va-pic">${v.poster ? html`<img src=${v.poster} alt="" />` : html`<${Icon} name="film" />`}${v.busy && html`<div class="loading"><${Icon} name="loader" cls="spin" /></div>`}</div>
          <div class="va-text">
            <b class="ellipsis">${v.name}</b>
            <span class="faint">${v.busy === 'reading' ? t('Reading…') : v.busy === 'uploading' ? t('Adding… {n}%', { n: Math.round((v.progress || 0) * 100) }) : v.busy === 'listening' ? t('Listening to the speech…') : [clock(v.duration), tn(v.frames?.length || 0, '{n} frame', '{n} frames'), v.transcript ? t('with speech') : ''].filter(Boolean).join(' · ')}</span>
            ${v.busy === 'uploading' && html`<span class="va-bar"><i style=${{ width: `${Math.round((v.progress || 0) * 100)}%` }}></i></span>`}
          </div>
          <button class="x" title=${t('Remove')} onClick=${() => removeVideo(v.id)}><${Icon} name="x" /></button>
        </div>`)}
        ${files.map((f) => html`<div class="file-att" key=${f.id}>
          ${f.reading ? html`<${Icon} name="loader" cls="spin" size="sm" />` : html`<${Icon} name=${f.kind === 'excel' ? 'file-spreadsheet' : 'file-text'} size="sm" />`}
          <b class="ellipsis">${f.name}</b>
          <span class="faint">${f.reading ? t('Reading…') : f.pages ? tn(f.pages, '{n} page', '{n} pages') : fmtBytes(f.size)}${f.truncated ? ` · ${t('part')}` : ''}</span>
          <button class="x" title=${t('Remove')} onClick=${() => setFiles((x) => x.filter((i) => i.id !== f.id))}><${Icon} name="x" /></button>
        </div>`)}
      </div>`}
      <textarea ref=${ta} rows="1" placeholder=${slash.length ? t('Message Hearth… (/ for commands and skills)') : t('Message Hearth…')} value=${text} onInput=${(e) => setText(e.target.value)} onKeyDown=${onKey} onPaste=${onPaste}></textarea>
      <div class="composer-row">
        <button class="icon-btn" title=${t('Add images, videos, documents or text files')} onClick=${() => fileInput.current.click()}><${Icon} name="plus" /></button>
        <input ref=${fileInput} type="file" multiple hidden accept="image/*,video/mp4,video/quicktime,video/webm,.mp4,.m4v,.mov,.webm,text/*,.pdf,.docx,.xlsx,.xlsm,.pptx,.odt,.ods,.odp,.md,.csv,.json,.js,.ts,.py,.html,.css,.xml,.yaml,.yml,.log,.sh,.sql,.rtf" onChange=${(e) => { addFiles([...e.target.files]); e.target.value = ''; }} />
        <${AssistantPicker} value=${assistantId} onChange=${setAssistant} />
        <button class=${`chip-btn ${think ? 'on' : ''}`} title=${t('Let the model think step by step before it answers (slower, often better for hard questions)')} onClick=${() => setThink(!think)}>
          <${Icon} name="lightbulb" size="sm" /><span class="chip-label">${think ? t('Think: On') : t('Think: Off')}</span>
        </button>
        ${toolsAvailable && html`<button class=${`chip-btn ${tools ? 'on' : ''}`} title=${t('Let the model search the web, open pages, read your allowed folders and use connected tools')} onClick=${() => setTools(!tools)}>
          <${Icon} name="wrench" size="sm" /><span class="chip-label">${tools ? t('Tools: On') : t('Tools: Off')}</span>
        </button>`}
        <span class="grow"></span>
        ${canTalk() && html`<button class=${`chip-btn talk ${talking ? 'on' : ''}`} title=${talking ? t('End the conversation by voice') : t('Talk by voice: speak, hear the answer, speak again')} onClick=${onTalk}><${Icon} name="audio-lines" size="sm" /></button>`}
        <${MicButton} disabled=${streaming || talking} onText=${(s) => { setText((x) => (x ? `${x.replace(/\s+$/, '')} ${s}` : s)); ta.current?.focus(); }} />
        ${streaming
          ? html`${hasContent && !queued && html`<button class="send-btn later" onClick=${submit} title=${t('Send after this answer (Enter)')}><${Icon} name="clock" size="sm" /></button>`}<button class="send-btn stop" onClick=${onStop} title=${t('Stop')}><${Icon} name="square" size="sm" /> ${t('Stop')}</button>`
          : html`<button class="send-btn" onClick=${submit} disabled=${!hasContent} title=${t('Send (Enter)')}><${Icon} name="arrow-up" size="sm" /> ${t('Send')}</button>`}
      </div>
    </div>
    <div class="composer-hint">${model ? `${modelLabel(model)}${eng?.ctx ? ` · ${t('{n} context', { n: fmtCtx(eng.ctx) })}` : ''}${use >= 0.5 ? ` · ${t('{n}% full', { n: Math.round(use * 100) })}` : ''} · ${t('runs on this computer')} · ` : ''}<span class="kbd">Enter</span> ${t('to send')}, <span class="kbd">Shift</span>+<span class="kbd">Enter</span> ${t('for a new line')}</div>
  </div>`;
}

// ---------------- Page ----------------
const STARTERS = () => [
  { icon: 'gamepad', title: t('Make a tiny game'), text: t('Make a small HTML snake game I can play in the browser, in one file.') },
  { icon: 'image', title: t('Describe a photo'), text: '', pick: true },
  { icon: 'pen-line', title: t('Write something'), text: t('Write a friendly email inviting customers to a weekend sale. Keep it short.') },
  { icon: 'code', title: t('Help with code'), text: t('Write a Python script that renames all photos in a folder by the date they were taken.') },
];

// An answer that made a page, an app or a picture is kept in Artifacts: one per answer, a new version when it changes.
async function keepArtifact(chat, msgId) {
  const m = chat.messages.find((x) => x.id === msgId);
  if (!chat.id || !m?.content || m.error || m.stopped) return '';
  const p = previewFrom(renderMarkdown(m.content).blocks);
  if (!p || !p.closed || p.code.length < 80) return '';
  try {
    const a = await api('/api/artifacts', { method: 'POST', body: { kind: p.kind, code: p.kind === 'svg' ? p.code : p.doc, chatId: chat.id, messageId: msgId, block: p.index, fallbackTitle: chat.title, source: 'chat' } });
    return a.id;
  } catch {
    return '';
  }
}

// Reads one streamed answer; returns what the model said and the tools it asked for.
export async function readStream(res, onDelta) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const calls = [];
  let finish = '';
  let stats = null;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') continue;
      let j;
      try {
        j = JSON.parse(data);
      } catch {
        continue;
      }
      if (j.error) throw engineFail(j.error.message, t('The model stopped with an error.'));
      const ch = j.choices?.[0];
      const d = ch?.delta;
      if (ch?.finish_reason) finish = ch.finish_reason;
      if (d?.tool_calls) {
        for (const tc of d.tool_calls) {
          const k = tc.index ?? calls.length;
          calls[k] = calls[k] || { id: '', name: '', arguments: '' };
          if (tc.id) calls[k].id = tc.id;
          if (tc.function?.name) calls[k].name += tc.function.name;
          if (tc.function?.arguments) calls[k].arguments += tc.function.arguments;
        }
      }
      if (j.timings || j.usage) {
        const tm = j.timings || {};
        stats = { tokPerSec: tm.predicted_per_second || 0, outputTokens: tm.predicted_n ?? j.usage?.completion_tokens, promptTokens: (tm.prompt_n ?? j.usage?.prompt_tokens ?? 0) + (tm.cache_n || 0) };
      }
      onDelta(d || {});
    }
  }
  return { calls: calls.filter((c) => c && c.name), finish, stats };
}

export function ChatPage({ route }) {
  const { status, newChatTick, newChatAssistant } = useStore();
  const [chat, setChat] = useState({ id: '', title: '', messages: [], assistantId: '' });
  const chatRef = useRef(chat);
  chatRef.current = chat;
  const [streaming, setStreaming] = useState(false);
  const controller = useRef(null);
  const [think, setThinkState] = useState(() => readPref('hearth.think', status?.settings?.chatThinking ?? false));
  const [tools, setToolsState] = useState(() => readPref('hearth.tools', true));
  const [toolList, setToolList] = useState(null);
  const [slash, setSlash] = useState([]);
  const [pv, setPv] = useState(null); // preview pane state
  const [pvWidth, setPvWidth] = useState(() => readPref('hearth.previewWidth', Math.round(window.innerWidth * 0.45)));
  const closedFor = useRef(''); // message id whose auto-preview the user closed
  const [lightbox, setLightbox] = useState('');
  const [focusTick, setFocusTick] = useState(0);
  const [draft, setDraft] = useState(null);
  const [quotes, setQuotes] = useState([]); // pieces of the chat quoted in the next message: { text, msgId, from }
  const [queued, setQueued] = useState(null); // a message written while an answer was still coming
  const queuedRef = useRef(null);
  const [compacting, setCompacting] = useState(null); // { part, total } while older messages are summed up
  const compactCtrl = useRef(null);
  const [pick, setPick] = useState(null); // selected text in a message: where the "Quote" button goes
  const [talk, setTalk] = useState(false); // a conversation by voice is on
  const scroller = useRef(null);
  const stick = useRef(true);
  const starterInput = useRef(null);

  const setThink = (v) => {
    setThinkState(v);
    writePref('hearth.think', v);
  };
  const setTools = (v) => {
    setToolsState(v);
    writePref('hearth.tools', v);
  };
  const toolsOn = status?.settings?.toolsOn !== false;
  useEffect(() => {
    if (!toolsOn) return setToolList([]);
    api('/api/tools').then((r) => setToolList(r.tools)).catch(() => setToolList([]));
  }, [toolsOn, status?.settings?.mcpConfig, status?.settings?.toolFolders?.length, status?.settings?.memoryOn, status?.settings?.toolApproval]);
  useEffect(() => {
    api('/api/extensions/menu').then((r) => setSlash(r.items)).catch(() => {});
  }, []);

  // Open the chat from the address, or start a fresh one.
  useEffect(() => {
    if (route.id && route.id === chatRef.current.id) return;
    queuedRef.current = null; // a waiting message belongs to the chat that is being left
    setQueued(null);
    setQuotes([]);
    setPick(null);
    setTalk(false);
    compactCtrl.current?.abort();
    if (controller.current) controller.current.abort();
    stopSpeaking();
    setPv(null);
    if (!route.id) {
      setChat({ id: '', title: '', messages: [], assistantId: getState().newChatAssistant || '', skills: [] });
      set({ newChatAssistant: '' });
      // Something handed over from another page (a picture to ask about).
      const d = getState().chatDraft;
      if (d) {
        set({ chatDraft: null });
        if (d.send) setTimeout(() => sendRef.current?.({ text: d.text, prompt: d.prompt, images: [], files: [] }), 0);
        else setDraft({ ...d, at: Date.now() });
      }
      setFocusTick((n) => n + 1);
      return;
    }
    api(`/api/chats/${route.id}`)
      .then((c) => {
        setChat({ assistantId: '', skills: [], ...c });
        stick.current = true;
        setFocusTick((n) => n + 1);
      })
      .catch(() => {
        toast(t('That chat no longer exists.'));
        go('#/');
      });
  }, [route.id, newChatTick, newChatAssistant]);

  // Keep the newest text in view unless the user scrolled up to read.
  useEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [chat]);
  const onScroll = () => {
    if (pick) setPick(null);
    const el = scroller.current;
    if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; // none while the page is closing
  };

  const save = async (c) => {
    try {
      await api(`/api/chats/${c.id}`, { method: 'PUT', body: { title: c.title, model: c.model, assistantId: c.assistantId || '', skills: c.skills || [], branchOf: c.branchOf || null, summary: c.summary || null, messages: c.messages } });
      refreshChats();
    } catch (err) {
      toastError(err);
    }
  };

  const updateLast = (fn) => {
    setChat((c) => {
      const msgs = c.messages.slice();
      msgs[msgs.length - 1] = fn(msgs[msgs.length - 1]);
      const next = { ...c, messages: msgs };
      chatRef.current = next;
      return next;
    });
  };

  // Follow the newest HTML/SVG in the answer in the preview pane.
  const autoPreview = (msg) => {
    if (!msg?.content || closedFor.current === msg.id) return;
    const { blocks } = renderMarkdown(msg.content);
    const p = previewFrom(blocks);
    if (!p) return;
    setPv((old) => ({ msgId: msg.id, tab: old?.msgId === msg.id ? old.tab : 'preview', ...p }));
  };

  const stream = async (base) => {
    const st = getState().status;
    const model = st?.engine?.model || st?.settings?.lastModel;
    const asst = { id: uid(), role: 'assistant', content: '', reasoning: '', at: Date.now(), model: model ? modelLabel(model) : '', steps: [] };
    const c = { ...chatRef.current, messages: [...base, asst] };
    setChat(c);
    chatRef.current = c;
    stick.current = true;
    setStreaming(true);
    if (st?.engine?.status !== 'ready') pollEngine();
    const ctrl = new AbortController();
    controller.current = ctrl;
    const t0 = Date.now();
    let thinkStart = 0;
    let thinkEnd = 0;
    let content = '';
    let reasoning = '';
    let steps = [];
    let stats = null;
    let raf = 0;
    const flush = () => {
      raf = 0;
      updateLast((m) => ({ ...m, content, reasoning, steps }));
      autoPreview({ id: asst.id, content });
    };
    const useTools = tools && toolsOn && toolList?.length > 0;
    const turnSkills = chatRef.current.skills || []; // a skill loaded with use_skill during this answer joins from the next one
    // The model that answers may not see pictures: then a video goes as its speech only.
    const seeing = st?.engine?.model ? Boolean(st.engine.vision) : getState().models.find((x) => x.id === st?.settings?.lastModel?.id)?.vision !== false;
    const convo = apiMessages(base, { sees: seeing, summary: chatRef.current.summary });
    // Said in a conversation by voice: the answer is read aloud, so it should be short and come quickly.
    const voice = Boolean(base[base.length - 1]?.voice);
    try {
      for (let round = 0; ; round++) {
        const last = round >= MAX_ROUNDS;
        const res = await fetch('/v1/chat/completions', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-hearth-client': 'chat', 'x-hearth-lang': document.documentElement.lang || 'en' },
          body: JSON.stringify({
            model: 'local',
            stream: true,
            stream_options: { include_usage: true },
            messages: convo,
            chat_template_kwargs: { enable_thinking: think && !voice },
            hearth: { assistantId: chatRef.current.assistantId || '', tools: useTools, skills: turnSkills, voice },
            // Tools without a schema are connector tools reached through find_tool and use_tool (there are many).
            ...(useTools && !last ? { tools: toolList.filter((x) => x.schema).map((x) => x.schema) } : {}),
          }),
          signal: ctrl.signal,
        });
        if (!res.ok) {
          let raw = '';
          try {
            raw = (await res.json()).error?.message || '';
          } catch {}
          throw engineFail(raw, t('The model answered with an error ({status}).', { status: res.status }));
        }
        const sep = content && !content.endsWith('\n') ? '\n\n' : '';
        let roundText = '';
        const r = await readStream(res, (d) => {
          if (d.reasoning_content) {
            if (!thinkStart) thinkStart = Date.now();
            reasoning += d.reasoning_content;
          }
          if (d.content) {
            if (thinkStart && !thinkEnd) thinkEnd = Date.now();
            content += (roundText ? '' : sep) + d.content;
            roundText += d.content;
          }
          if (!raf) raf = requestAnimationFrame(flush);
        });
        if (r.stats) stats = r.stats;
        if (!r.calls.length || last) break;
        // The model asked for tools: run them, show each one, and give it the results.
        const ids = r.calls.map((cl, i) => cl.id || `call_${round}_${i}`);
        convo.push({ role: 'assistant', content: roundText, tool_calls: r.calls.map((cl, i) => ({ id: ids[i], type: 'function', function: { name: cl.name, arguments: cl.arguments || '{}' } })) });
        for (const [i, cl] of r.calls.entries()) {
          let args = {};
          try {
            args = cl.arguments ? JSON.parse(cl.arguments) : {};
          } catch {}
          // use_tool runs a connector tool the model looked up: show that tool, and ask about it.
          const wanted = String(args.name ?? '').trim(); // the server trims the name too
          const inner = cl.name === 'use_tool' ? toolList.find((x) => x.source === 'mcp' && (x.name === wanted || x.tool === wanted || `${x.server}:${x.tool}` === wanted)) : null;
          const def = inner || toolList.find((x) => x.name === cl.name);
          // The connector tool this call would run, as far as the page can tell. The server runs a connector tool only
          // when it is told which one the user allowed, and refuses when that is not the tool it would run.
          const connector = inner || (def?.source === 'mcp' ? def : null);
          const mustAsk = Boolean(def?.ask) || (cl.name === 'use_tool' && getState().status?.settings?.toolApproval !== 'auto');
          let shown = args;
          if (cl.name === 'use_tool') {
            shown = args.arguments || {};
            if (typeof shown === 'string') {
              try {
                shown = JSON.parse(shown);
              } catch {}
            }
          }
          const step = { id: uid(), name: cl.name, title: def?.title || cl.name, icon: def?.icon, args: shown, status: 'running' };
          steps = [...steps, step];
          flush();
          let result = '';
          if (mustAsk) announce('ask', { title: t('Hearth needs your answer'), body: t('Allow the tool “{name}”?', { name: inner ? inner.title : step.title }) });
          if (mustAsk && !(await confirmDialog({ title: t('Allow the tool “{name}”?', { name: inner ? inner.title : cl.name === 'use_tool' ? String(args.name || cl.name) : step.title }), text: `${t('The model wants to run it with:')} ${JSON.stringify(shown).slice(0, 400)}`, ok: t('Allow'), cancel: t('Decline') }))) {
            step.status = 'denied';
            result = 'The user declined this tool call.';
          } else {
            const out = await api('/api/tools/call', { method: 'POST', body: { name: cl.name, arguments: cl.arguments || '{}', ...(mustAsk && connector ? { approved: connector.name } : {}) } }).catch((err) => ({ ok: false, error: err.message }));
            if (out.ok) {
              step.status = 'done';
              step.result = String(out.content).slice(0, 3000);
              result = out.content;
              if (cl.name === 'remember') toast(t('Saved to memory'));
              if (cl.name === 'use_skill') {
                // The skill stays on in this chat, so later answers keep its instructions.
                const it = slash.find((i) => i.kind === 'skill' && [i.id, i.name, i.title, i.id.split(':').pop()].includes(args.name));
                if (it)
                  setChat((c) => {
                    if ((c.skills || []).includes(it.id)) return c;
                    const next = { ...c, skills: [...(c.skills || []), it.id] };
                    chatRef.current = next;
                    return next;
                  });
              }
            } else {
              step.status = 'error';
              step.error = out.error;
              result = `Error: ${out.error}`;
            }
          }
          steps = steps.map((s) => (s.id === step.id ? { ...step } : s));
          flush();
          convo.push({ role: 'tool', tool_call_id: ids[i], content: String(result).slice(0, 60000) });
          if (ctrl.signal.aborted) throw new DOMException('stopped', 'AbortError');
        }
      }
      if (raf) cancelAnimationFrame(raf);
      flush();
      updateLast((m) => ({ ...m, content, reasoning, steps, stats: { ...(stats || {}), ms: Date.now() - t0, thinkMs: thinkStart ? (thinkEnd || Date.now()) - thinkStart : 0 } }));
      if (!content && !reasoning) updateLast((m) => ({ ...m, error: t('The model gave an empty answer. Try again, or try another model.') }));
    } catch (err) {
      if (raf) cancelAnimationFrame(raf);
      if (ctrl.signal.aborted) updateLast((m) => ({ ...m, content, reasoning, steps, stopped: true, stats: { ...(stats || {}), ms: Date.now() - t0 } }));
      else updateLast((m) => ({ ...m, content, reasoning, steps, error: String(err.message || err), ...(err.full ? { full: true } : {}) }));
    } finally {
      controller.current = null;
      setStreaming(false);
      const kept = await keepArtifact(chatRef.current, asst.id);
      if (kept) {
        const next = { ...chatRef.current, messages: chatRef.current.messages.map((m) => (m.id === asst.id ? { ...m, artifact: kept } : m)) };
        chatRef.current = next;
        setChat(next);
      }
      save(chatRef.current);
      if (!ctrl.signal.aborted && !voice) announce('done', { title: t('The answer is ready'), body: chatRef.current.title, took: Date.now() - t0 });
      // A message written meanwhile goes out now ("Send now" stops the answer to get here sooner).
      const q = queuedRef.current;
      if (q && chatRef.current.id === c.id) {
        queuedRef.current = null;
        setQueued(null);
        setTimeout(() => sendRef.current?.(q), 0);
      }
    }
  };

  const ensureReady = () => {
    const st = getState().status;
    if (!st?.engine?.model && !st?.settings?.lastModel) {
      toast(t('Pick a model first. Hearth will remember it.'));
      go('#/models');
      return false;
    }
    if (st?.engine?.status === 'error' && st.engine.error === 'NO_ENGINE') {
      toast(t('Hearth needs its engine first. Download it on the Models page.'), 'bad');
      go('#/models');
      return false;
    }
    // Nothing loaded right now? Load the last model; the answer starts as soon as it's ready.
    if (st?.engine?.status !== 'ready' && st?.engine?.status !== 'starting' && st?.settings?.lastModel) {
      const m = getState().models.find((x) => x.id === st.settings.lastModel.id);
      if (m) loadModel(m);
    }
    return true;
  };

  const sendRef = useRef(null);
  const send = async (msg) => {
    const { text, prompt, images, files, videos = [], quotes: quoted = [], voice = false } = msg;
    if (controller.current) {
      queuedRef.current = msg;
      setQueued(msg);
      setQuotes([]);
      return;
    }
    if (!ensureReady()) return;
    setQuotes([]);
    const st = getState().status;
    const user = { id: uid(), role: 'user', content: text, ...(prompt ? { prompt } : {}), images, files, ...(videos.length ? { videos } : {}), ...(quoted.length ? { quotes: quoted } : {}), ...(voice ? { voice: true } : {}), at: Date.now() };
    let c = chatRef.current;
    if (!c.id) {
      const title = (text || files[0]?.name || videos[0]?.name || (images.length ? t('Image') : t('New chat'))).replace(/\s+/g, ' ').slice(0, 70);
      c = { id: uid(), title, messages: [], model: '', assistantId: c.assistantId || '', skills: c.skills || [] };
    }
    c = { ...c, model: modelLabel(st?.engine?.model || st?.settings?.lastModel), messages: [...c.messages, user] };
    chatRef.current = c;
    setChat(c);
    if (route.id !== c.id) history.replaceState(null, '', `#/chat/${c.id}`), set({ route: { page: 'chat', id: c.id } });
    save(c); // shows up in the sidebar right away
    await stream(c.messages);
  };

  sendRef.current = send;

  const regenerate = () => {
    if (streaming) return;
    const msgs = chatRef.current.messages;
    const base = msgs[msgs.length - 1]?.role === 'assistant' ? msgs.slice(0, -1) : msgs;
    stream(base);
  };

  // Change an earlier question: the answers after it are replaced by a new one.
  const editMessage = (id, text) => {
    if (streaming || !ensureReady()) return;
    const msgs = chatRef.current.messages;
    const i = msgs.findIndex((m) => m.id === id);
    if (i < 0) return;
    const base = [...msgs.slice(0, i), { ...msgs[i], content: text, edited: true }];
    // A summary that covered this question or later ones no longer describes the chat.
    const sum = chatRef.current.summary;
    const keepSum = sum && (!sum.upto || base.slice(0, -1).some((m) => m.id === sum.upto));
    const c = { ...chatRef.current, messages: base, summary: keepSum ? sum : null };
    chatRef.current = c;
    setChat(c);
    stream(base);
  };

  // A new chat with the messages up to here; this one stays as it is.
  const branch = async (id) => {
    const c = chatRef.current;
    const i = c.messages.findIndex((m) => m.id === id);
    if (i < 0 || !c.id) return;
    const part = c.messages.slice(0, i + 1);
    const nb = { id: uid(), title: t('Branch: {title}', { title: c.title }).slice(0, 120), model: c.model, assistantId: c.assistantId || '', skills: c.skills || [], branchOf: { id: c.id, title: c.title }, summary: c.summary && (!c.summary.upto || part.some((m) => m.id === c.summary.upto)) ? c.summary : null, messages: part };
    try {
      await api(`/api/chats/${nb.id}`, { method: 'PUT', body: nb });
      await refreshChats();
      go(`#/chat/${nb.id}`);
      toast(t('Branch made. The original chat is unchanged.'));
    } catch (err) {
      toastError(err);
    }
  };

  const setSkills = (ids) => {
    const c = { ...chatRef.current, skills: ids };
    chatRef.current = c;
    setChat(c);
    if (c.id) save(c);
  };

  const setAssistant = (id) => {
    const c = { ...chatRef.current, assistantId: id };
    chatRef.current = c;
    setChat(c);
    if (c.id) save(c);
    const a = getState().assistants.find((x) => x.id === id);
    if (a && !c.messages.length && a.starter) setDraft({ hint: a.starter });
  };

  // ---- A waiting message ----
  const takeBack = () => {
    const q = queuedRef.current;
    queuedRef.current = null;
    setQueued(null);
    if (!q) return;
    setDraft({ text: q.text, images: q.images, files: q.files, videos: q.videos, at: Date.now() });
    setQuotes(q.quotes || []);
  };

  // ---- Quotes ----
  const addQuote = (q) => {
    const text = q.text.length > 2000 ? `${q.text.slice(0, 2000)}…` : q.text;
    setQuotes((x) => [...x.filter((y) => y.text !== text), { ...q, text }].slice(-3));
    window.getSelection()?.removeAllRanges();
    setPick(null);
    setFocusTick((n) => n + 1);
  };
  // The button under an answer: the selected part of it, or the whole answer.
  const quoteMessage = (m) => {
    const sel = window.getSelection();
    const el = scroller.current?.querySelector(`.msg[data-mid="${m.id}"]`);
    const part = sel && !sel.isCollapsed && el?.contains(sel.anchorNode) && el.contains(sel.focusNode) ? sel.toString().trim() : '';
    addQuote({ text: part || (m.content || '').trim(), msgId: m.id, from: m.role === 'user' ? 'user' : 'assistant' });
  };
  // Text selected inside one message: offer to quote it, right above the selection.
  const onSelect = () => {
    const sel = window.getSelection();
    const text = sel && !sel.isCollapsed ? sel.toString().trim() : '';
    const box = (n) => (n?.nodeType === 1 ? n : n?.parentElement)?.closest?.('.msg[data-mid]');
    const from = text && box(sel.anchorNode);
    if (!from || from !== box(sel.focusNode) || from.querySelector('.edit-box')) return setPick(null);
    const r = sel.getRangeAt(0).getBoundingClientRect();
    setPick({ text, msgId: from.dataset.mid, from: from.classList.contains('user') ? 'user' : 'assistant', x: Math.min(Math.max(r.left + r.width / 2, 70), window.innerWidth - 70), y: Math.max(r.top, 60) });
  };
  const jumpTo = (id) => {
    const el = scroller.current?.querySelector(`.msg[data-mid="${id}"]`);
    if (!el) return toast(t('That message is no longer in this chat.'));
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    el.classList.add('flash');
    setTimeout(() => el.classList.remove('flash'), 1600);
  };

  // ---- Summarize and continue ----
  const askOnce = async (messages, signal) => {
    const res = await fetch('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-hearth-lang': document.documentElement.lang || 'en' },
      body: JSON.stringify({ model: 'local', stream: false, messages, max_tokens: 1200, temperature: 0.2, chat_template_kwargs: { enable_thinking: false } }),
      signal,
    });
    const j = await res.json().catch(() => null);
    if (!res.ok) throw engineFail(j?.error?.message, t('The model answered with an error ({status}).', { status: res.status }));
    return j?.choices?.[0]?.message?.content || '';
  };
  // fresh: put the summary into a new chat instead, and leave this one as it is.
  const compact = async ({ fresh = false } = {}) => {
    if (controller.current || compactCtrl.current) return;
    const c = chatRef.current;
    const ctx = ctxLimit();
    const applied = c.summary?.text && (!c.summary.upto || c.messages.some((m) => m.id === c.summary.upto)) ? c.summary : null;
    const after = applied?.upto ? c.messages.findIndex((m) => m.id === applied.upto) + 1 : 0;
    const plan = fresh ? { older: c.messages.slice(after), upto: '' } : planCompact(c.messages, applied, ctx);
    if (!c.id || !plan?.older.some((m) => m.content || m.files?.length)) return toast(t('This chat is still short: there is nothing to sum up yet.'));
    if (!ensureReady()) return;
    const ctrl = new AbortController();
    compactCtrl.current = ctrl;
    setCompacting({ part: 0, total: 0 });
    try {
      const text = await summarize({ parts: summaryParts(plan.older, ctx), previous: applied?.text || '', ask: (m) => askOnce(m, ctrl.signal), onProgress: (part, total) => setCompacting({ part, total }) });
      if (ctrl.signal.aborted || chatRef.current.id !== c.id) return;
      const summary = { upto: plan.upto, text, at: Date.now() };
      if (fresh) {
        const nb = { id: uid(), title: t('Continued: {title}', { title: c.title }).slice(0, 120), model: c.model, assistantId: c.assistantId || '', skills: c.skills || [], branchOf: { id: c.id, title: c.title }, summary, messages: [] };
        await api(`/api/chats/${nb.id}`, { method: 'PUT', body: nb });
        await refreshChats();
        go(`#/chat/${nb.id}`);
        toast(t('A new chat that knows the summary of this one. The original chat is unchanged.'));
      } else {
        const next = { ...chatRef.current, summary };
        chatRef.current = next;
        setChat(next);
        save(next);
        toast(t('The older messages are summed up. The chat goes on with more room.'));
      }
    } catch (err) {
      if (!ctrl.signal.aborted) toast(t('Could not sum up the chat: {err}', { err: err.message === 'empty' ? t('the model gave an empty answer') : err.message || err }), 'bad');
    } finally {
      compactCtrl.current = null;
      setCompacting(null);
    }
  };

  // Pin to the top of the list, or move to the archive (the sidebar does the same).
  const flag = async (patch) => {
    try {
      const r = await api(`/api/chats/${chatRef.current.id}/flags`, { method: 'POST', body: patch });
      const next = { ...chatRef.current, pinned: r.pinned, archived: r.archived };
      chatRef.current = next;
      setChat(next);
      refreshChats();
      if (patch.archived) toast(t('Moved to the archive. It is at the bottom of the chat list.'));
    } catch (err) {
      toastError(err);
    }
  };

  // What the command palette and the keyboard shortcuts ask of the open chat.
  const { chatCommand } = getState();
  useEffect(() => {
    if (!chatCommand) return;
    if (chatCommand.name === 'stop') controller.current?.abort();
    if (chatCommand.name === 'compact') compact();
    set({ chatCommand: null });
  }, [chatCommand]);

  const openPreview = (msgId, blocks, idx, tab) => {
    closedFor.current = '';
    setPv({ msgId, tab, index: idx, ...buildDoc(blocks, idx) });
  };

  const rename = async () => {
    const tt = await promptDialog({ title: t('Rename chat'), value: chat.title, ok: t('Rename') });
    if (!tt?.trim() || !chat.id) return;
    const c = { ...chatRef.current, title: tt.trim() };
    setChat(c);
    save(c);
  };
  const exportMd = () => {
    const md = `# ${chat.title}\n\n${chat.messages.map((m) => `**${m.role === 'user' ? t('You') : m.model || t('Assistant')}:**\n\n${m.content || ''}`).join('\n\n---\n\n')}\n`;
    saveFile(`${chat.title.replace(/[^\p{L}\p{N}\s-]/gu, '').trim().slice(0, 50) || 'chat'}.md`, md, 'text/markdown');
  };
  const del = async () => {
    if (!(await confirmDialog({ title: t('Delete this chat?'), text: t('“{title}” will be removed for good.', { title: chat.title }), ok: t('Delete'), danger: true }))) return;
    await api(`/api/chats/${chat.id}`, { method: 'DELETE' }).catch(toastError);
    refreshChats();
    go('#/');
  };

  const eng = status?.engine;
  const curModel = eng?.model;
  const vision = curModel ? Boolean(eng.vision) : getState().models.find((m) => m.id === status?.settings?.lastModel?.id)?.vision;
  const msgs = chat.messages;
  const assistant = getState().assistants.find((a) => a.id === chat.assistantId);
  const use = contextUse(msgs, eng?.ctx, chat.summary);
  const sumAt = chat.summary?.upto ? msgs.findIndex((m) => m.id === chat.summary.upto) : -1;
  const lastMsg = msgs[msgs.length - 1];
  const crowded = !streaming && (use >= 0.8 || (lastMsg?.full && !(chat.summary?.at > (lastMsg.at || 0))));

  let banner = null;
  if (eng?.status === 'error')
    banner = html`<div class="notice bad banner"><${Icon} name="alert" /><div class="grow">${eng.error === 'NO_ENGINE' ? t('Hearth needs its engine (llama.cpp) to run models.') : eng.error}</div><button class="btn sm" onClick=${() => go('#/models')}>${t('Open Models')}</button></div>`;
  else if (!curModel && !status?.settings?.lastModel)
    banner = html`<div class="notice accent banner"><${Icon} name="info" /><div class="grow">${t('Pick a model to start. Hearth found the ones already on this computer.')}</div><button class="btn sm primary" onClick=${() => go('#/models')}>${t('Choose model')}</button></div>`;

  // A click on a picture in an answer (or one a tool made) opens it large.
  const zoom = (e) => {
    const im = e.target.closest?.('img[data-zoom]');
    if (im) setLightbox(im.currentSrc || im.src);
  };
  return html`<div class="chat-wrap" onClick=${zoom}>
    <div class="chat-col">
      <header class="chat-head">
        <${SidebarToggle} />
        <div class="chat-title ellipsis">${chat.title || t('New chat')}</div>
        <${ModelPicker} />
        <span class="grow"></span>
        ${chat.branchOf && html`<a class="btn sm ghost hide-narrow" href=${`#/chat/${chat.branchOf.id}`} title=${chat.branchOf.title}><${Icon} name="git-branch" size="sm" /> ${t('Original chat')}</a>`}
        ${chat.id && html`<${Popover} align="right" button=${({ toggle }) => html`<button class="icon-btn" title=${t('More')} onClick=${toggle}><${Icon} name="more" /></button>`}>
          <button class="pop-item" data-close onClick=${rename}><${Icon} name="pencil" size="sm" /> ${t('Rename')}</button>
          <button class="pop-item" data-close onClick=${exportMd}><${Icon} name="download" size="sm" /> ${t('Save as Markdown')}</button>
          <button class="pop-item" data-close onClick=${() => flag({ pinned: !chat.pinned })}><${Icon} name="pin" size="sm" /> ${chat.pinned ? t('Unpin') : t('Pin to the top')}</button>
          <button class="pop-item" data-close onClick=${() => flag({ archived: !chat.archived })}><${Icon} name="archive" size="sm" /> ${chat.archived ? t('Take out of the archive') : t('Move to the archive')}</button>
          <button class="pop-item" data-close disabled=${streaming || Boolean(compacting)} onClick=${() => compact()}><${Icon} name="layers" size="sm" /> ${t('Sum up older messages')}</button>
          <div class="pop-sep"></div>
          <button class="pop-item danger" data-close onClick=${del}><${Icon} name="trash" size="sm" /> ${t('Delete chat')}</button>
        <//>`}
      </header>
      <div class="messages" ref=${scroller} onScroll=${onScroll} onMouseUp=${() => setTimeout(onSelect, 0)} onKeyUp=${() => setTimeout(onSelect, 0)} onTouchEnd=${() => setTimeout(onSelect, 250)}>
        ${!msgs.length
          ? html`<div class="welcome">
              <img src="/logo.svg" alt="" />
              <h1>${assistant ? assistant.name : chat.summary ? chat.title : t('What can I help with?')}</h1>
              <p>${chat.summary ? t('This chat continues an earlier one: the model knows its summary. Write what to do next.') : assistant ? draft?.hint || assistant.starter || assistant.description : t('Everything runs on your computer. Nothing you type leaves it.')}</p>
              ${!assistant && !chat.summary &&
              html`<div class="starters">
                ${STARTERS().map(
                  (s) => html`<button class="starter" onClick=${() => (s.pick ? starterInput.current.click() : send({ text: s.text, images: [], files: [] }))}>
                    <${Icon} name=${s.icon} /><div><b>${s.title}</b><span>${s.pick ? t('Add a photo and ask about it') : s.text}</span></div>
                  </button>`,
                )}
              </div>
              ${getState().assistants.length > 0 &&
              html`<div class="assistant-row">
                <span class="muted">${t('Or start with an assistant:')}</span>
                ${getState().assistants.slice(0, 6).map((a) => html`<button class="chip-btn outline" onClick=${() => setAssistant(a.id)}><${Icon} name=${a.icon} size="sm" /> ${a.name}</button>`)}
              </div>`}`}
              <input ref=${starterInput} type="file" accept="image/*" hidden onChange=${async (e) => {
                const f = e.target.files[0];
                e.target.value = '';
                if (!f) return;
                try {
                  const r = await uploadImage(f);
                  send({ text: t('What is in this picture? Describe it in detail.'), images: [{ url: r.url, name: f.name }], files: [] });
                } catch (err) {
                  toastError(err);
                }
              }} />
            </div>`
          : html`<div class="messages-inner">
              ${chat.summary && !chat.summary.upto && html`<div class="sum-line" key="sum-start" title=${chat.summary.text}><${Icon} name="layers" size="sm" /> ${t('The model knows the summary of the earlier chat')}</div>`}
              ${msgs.map((m, i) => [
                m.role === 'user'
                  ? html`<${UserMessage} key=${m.id} m=${m} onImage=${setLightbox} onEdit=${editMessage} onBranch=${branch} onJump=${jumpTo} busy=${streaming} />`
                  : html`<${AssistantMessage} key=${m.id} m=${m} last=${i === msgs.length - 1} streaming=${streaming} onRegenerate=${regenerate} onPreview=${openPreview} onBranch=${branch} onQuote=${quoteMessage} />`,
                i === sumAt && html`<div class="sum-line" key="sum-line" title=${chat.summary.text}><${Icon} name="layers" size="sm" /> ${t('Above this line the model reads a summary; below it, every word')}</div>`,
              ])}
            </div>`}
      </div>
      ${banner}
      ${compacting
        ? html`<div class="notice accent banner"><${Icon} name="loader" cls="spin" /><div class="grow">${compacting.total > 1 ? t('Summing up the older messages… part {n} of {total}', { n: compacting.part, total: compacting.total }) : t('Summing up the older messages…')}</div><button class="btn sm" onClick=${() => compactCtrl.current?.abort()}>${t('Cancel')}</button></div>`
        : crowded &&
          html`<div class="notice warn banner crowded"><${Icon} name="info" /><div class="grow">${use >= 0.8 ? t('This chat fills {n}% of what the model can keep in mind. Summing up the older messages makes room; everything stays on screen.', { n: Math.round(use * 100) }) : t('This chat no longer fits into what the model can keep in mind. Summing up the older messages makes room; everything stays on screen.')}</div><button class="btn sm primary" onClick=${() => compact()}>${t('Summarize and continue')}</button><button class="btn sm" onClick=${() => compact({ fresh: true })}>${t('Continue in a new chat')}</button></div>`}
      ${talk && html`<${TalkPanel}
        answer=${lastMsg?.role === 'assistant' ? { id: lastMsg.id, text: lastMsg.content || '', streaming } : null}
        onSay=${(said) => send({ text: said, images: [], files: [], voice: true })}
        onStop=${() => controller.current?.abort()}
        onClose=${() => setTalk(false)}
      />`}
      ${queued && html`<div class="queued banner"><${Icon} name="clock" size="sm" /><div class="grow ellipsis">${t('Goes out after this answer:')} <b>${queued.text || t('attached files')}</b></div><button class="btn sm" onClick=${() => controller.current?.abort()} title=${t('Stops the answer and sends this message')}>${t('Send now')}</button><button class="btn sm ghost" onClick=${takeBack}>${t('Take back')}</button></div>`}
      <${Composer}
        streaming=${streaming}
        onSend=${send}
        onStop=${() => controller.current?.abort()}
        vision=${vision}
        think=${think}
        setThink=${setThink}
        tools=${tools}
        setTools=${setTools}
        toolsAvailable=${toolsOn && toolList?.length > 0}
        assistantId=${chat.assistantId || ''}
        setAssistant=${setAssistant}
        focusTick=${focusTick}
        draft=${draft}
        slash=${slash}
        skills=${chat.skills || []}
        setSkills=${setSkills}
        quotes=${quotes}
        setQuotes=${setQuotes}
        queued=${queued}
        onCompact=${() => compact()}
        use=${use}
        talking=${talk}
        onTalk=${() => setTalk(!talk)}
      />
    </div>
    ${pv && html`<${PreviewPane}
      pv=${pv}
      streaming=${streaming && pv.msgId === msgs[msgs.length - 1]?.id}
      width=${pvWidth}
      onWidth=${(w) => { setPvWidth(w); writePref('hearth.previewWidth', w); }}
      onTab=${(tab) => setPv({ ...pv, tab })}
      onClose=${() => { closedFor.current = pv.msgId; setPv(null); }}
      artifact=${msgs.find((x) => x.id === pv.msgId)?.artifact || ''}
    />`}
    ${pick && html`<button class="quote-pick" style=${{ left: `${pick.x}px`, top: `${pick.y}px` }} onMouseDown=${(e) => e.preventDefault()} onClick=${(e) => { e.stopPropagation(); addQuote({ text: pick.text.slice(0, 4000), msgId: pick.msgId, from: pick.from }); }}><${Icon} name="quote" size="sm" /> ${t('Quote')}</button>`}
    ${lightbox && html`<div class="overlay lightbox" onClick=${() => setLightbox('')}><img src=${lightbox} alt="" /></div>`}
  </div>`;
}
