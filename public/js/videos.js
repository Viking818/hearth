// Video page: describe a short video (or start from a picture), and Hearth makes it on this computer with LTX-2.5,
// sound included. Videos are kept in a gallery like pictures.
import { html, useState, useEffect, useRef } from '../vendor/preact-htm.js';
import { Icon } from './icons.js';
import { t, tn } from './i18n.js';
import { useStore, api, toast, toastError, fmtBytes, fmtDuration, saveFile, copyText, loadModel, getState, refreshDownloads, readPref, writePref } from './store.js';
import { confirmDialog, PageHead } from './ui.js';
import { Downloads } from './models.js';

const LENGTHS = () => [
  [3, t('{n} s', { n: 3 })],
  [5, t('{n} s', { n: 5 })],
  [10, t('{n} s', { n: 10 })],
];
const FORMATS = () => [
  ['wide', t('Wide'), '16:9'],
  ['portrait', t('Story'), '9:16'],
  ['square', t('Square'), '1:1'],
];

function Setup({ st, reload }) {
  const { downloads } = useStore();
  const install = async () => {
    try {
      await api('/api/videos/install', { method: 'POST' });
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
    <div class="row" style="gap:12px;align-items:flex-start"><span class="a-icon"><${Icon} name="film" /></span>
      <div class="grow"><b style="font-size:16px">${t('Make videos on this computer')}</b>
        <p class="muted" style="margin:4px 0 0">${t('Hearth uses LTX-2.5 from Lightricks, the newest open video model that runs on a home computer. It makes clips of up to 10 seconds with sound, from a description or from one of your pictures. A 5-second clip takes several minutes on a strong graphics card, and longer on a Mac. Free, no limits, and nothing leaves your computer.')}</p></div></div>
    <div class="muted" style="font-size:13px">${t('Download {size}; about {disk} on disk once ready. It needs about 30 GB of memory while it works.', { size: fmtBytes(st.download), disk: fmtBytes(st.onDisk) })}${st.fits ? '' : ` ${t('This computer may not have enough memory for it.')}`}</div>
    <div class="muted" style="font-size:12.5px">${t('LTX-2.5 is free for people and businesses earning less than $10 million a year (LTX-2 Community License).')}</div>
    <div class="row"><button class="btn primary" disabled=${st.installing} onClick=${install}><${Icon} name=${st.installing ? 'loader' : 'download'} cls=${st.installing ? 'spin' : ''} size="sm" /> ${st.installing ? t('Downloading…') : t('Install')}</button>
      ${!st.engine && html`<span class="muted" style="font-size:13px">${t('The picture engine (stable-diffusion.cpp, about 40 MB) comes with it.')}</span>`}</div>
    <${Downloads} downloads=${downloads} kinds=${['videos', 'images']} />
  </div>`;
}

// The engine writes the sound as plain PCM. Chrome plays that; Safari and the Mac app refuse the whole file. For them
// Hearth serves the picture and the sound apart (/videos/play/…) and the page plays the two together.
const playUrl = (video) => `/videos/play/${encodeURIComponent(video.name)}`;
let wholeFails = false; // this browser refused a video as it was made: the next ones start apart at once

function Player({ video, autoPlay = false }) {
  const [mode, setMode] = useState(wholeFails ? 'apart' : 'whole'); // whole → apart → bad
  useEffect(() => setMode(wholeFails ? 'apart' : 'whole'), [video.url]);
  if (mode === 'bad') return html`<div class="vid-bad col" style="gap:8px"><${Icon} name="film" /><span>${t('This window can’t play this video. Save it and open it with your browser or VLC.')}</span><button class="btn sm" onClick=${() => saveFile(video.name, video.url)}><${Icon} name="download" size="sm" /> ${t('Save')}</button></div>`;
  if (mode === 'apart') return html`<${ApartPlayer} key=${video.url} video=${video} autoPlay=${autoPlay} onBad=${() => setMode('bad')} />`;
  return html`<video key=${video.url} src=${video.url} controls autoplay=${autoPlay} playsinline onError=${() => { wholeFails = true; setMode('apart'); }}></video>`;
}

// The picture leads; the sound follows it: starts, stops, jumps and changes speed with it. The sound is played through
// Web Audio, which starts at an exact position at once (an <audio> element starts late and, in Safari, reports its
// position too coarsely to be kept in step).
function ApartPlayer({ video, autoPlay, onBad }) {
  const pic = useRef(null);
  const snd = useRef({ ctx: null, buf: null, gain: null, src: null });
  const [hasSound, setHasSound] = useState(false);
  const [quiet, setQuiet] = useState(false);
  const stop = () => {
    const s = snd.current;
    if (!s.src) return;
    try {
      s.src.stop();
    } catch {}
    s.src.disconnect();
    s.src = null;
  };
  const start = () => {
    const s = snd.current;
    const v = pic.current;
    stop();
    if (!s.buf || !v || v.paused || v.ended || v.currentTime >= s.buf.duration) return;
    if (s.ctx.state !== 'running') {
      // A new sound output takes a moment to wake; the sound starts when it has, from where the picture is by then.
      s.ctx.resume().then(() => s.ctx.state === 'running' && start(), () => {});
      return;
    }
    const src = s.ctx.createBufferSource();
    src.buffer = s.buf;
    src.playbackRate.value = v.playbackRate || 1;
    src.connect(s.gain);
    src.start(0, v.currentTime);
    s.src = src;
  };
  useEffect(() => {
    let gone = false;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return undefined;
    fetch(`${playUrl(video)}.wav`)
      .then((r) => (r.ok ? r.arrayBuffer() : null))
      .then(async (bytes) => {
        if (!bytes || gone) return;
        const ctx = new Ctx();
        const gain = ctx.createGain();
        gain.connect(ctx.destination);
        const buf = await new Promise((resolve, reject) => {
          const p = ctx.decodeAudioData(bytes, resolve, reject);
          if (p?.then) p.then(resolve, reject);
        });
        if (gone) return ctx.close();
        Object.assign(snd.current, { ctx, buf, gain });
        setHasSound(true);
        start(); // the picture may be playing already
      })
      .catch(() => {}); // no sound in this video, or none this browser can read: the picture still plays
    return () => {
      gone = true;
      stop();
      snd.current.ctx?.close().catch(() => {});
    };
  }, [video.url]);
  // The player's own volume and mute controls (where the browser shows them) work the sound too.
  const loudness = () => {
    const v = pic.current;
    if (!v) return;
    if (snd.current.gain) snd.current.gain.gain.value = v.muted ? 0 : v.volume;
    setQuiet(v.muted || v.volume === 0);
  };
  useEffect(loudness, [hasSound]);
  return html`<div class="vid-apart">
    <video ref=${pic} src=${playUrl(video)} controls autoplay=${autoPlay} playsinline
      onPlaying=${start} onPause=${stop} onWaiting=${stop} onEnded=${stop} onSeeking=${stop} onSeeked=${start} onRateChange=${start}
      onVolumeChange=${loudness} onError=${onBad}></video>
    ${hasSound && html`<button class="vid-sound" title=${quiet ? t('Turn the sound on') : t('Turn the sound off')} onClick=${() => { pic.current.muted = !(pic.current.muted || pic.current.volume === 0); if (!pic.current.muted && pic.current.volume === 0) pic.current.volume = 1; }}><${Icon} name=${quiet ? 'volume-x' : 'volume-2'} size="sm" /></button>`}
  </div>`;
}

// A gallery tile shows a frame of the video; where the video as made won't open, the picture-only copy does.
function Tile({ g, onOpen }) {
  const [apart, setApart] = useState(wholeFails);
  return html`<button class="img-tile vid-tile" onClick=${() => onOpen(g)} title=${g.prompt}>
    <video src=${`${apart ? playUrl(g) : g.url}#t=0.5`} muted preload="metadata" playsinline onError=${() => { if (!apart) { wholeFails = true; setApart(true); } }}></video>
    <span class="vid-badge"><${Icon} name="play" size="sm" /> ${t('{n} s', { n: g.seconds || '?' })}</span>
  </button>`;
}

function Lightbox({ video, onClose, onDelete, onReuse }) {
  return html`<div class="overlay lightbox-pane" onClick=${(e) => e.target === e.currentTarget && onClose()}>
    <div class="lb-card vid">
      <${Player} video=${video} autoPlay=${true} />
      <div class="lb-side col" style="gap:10px">
        <div class="row"><b class="grow">${t('Video')}</b><button class="icon-btn" title=${t('Close')} onClick=${onClose}><${Icon} name="x" /></button></div>
        <p class="lb-prompt">${video.prompt}</p>
        <div class="muted" style="font-size:13px">${video.width}×${video.height} · ${t('{n} s', { n: video.seconds })}${video.refs ? ` · ${tn(video.refs, '{n} reference photo', '{n} reference photos')}` : video.toPicture ? ` · ${t('from a picture to a picture')}` : video.fromPicture ? ` · ${t('from a picture')}` : ''}${video.model ? ` · ${video.model.split(' ')[0]}` : ''} · ${t('seed')} ${video.seed}${video.ms ? ` · ${fmtDuration(video.ms)}` : ''}</div>
        <div class="col" style="gap:6px">
          <button class="btn sm" onClick=${() => saveFile(video.name, video.url)}><${Icon} name="download" size="sm" /> ${t('Save')}</button>
          <button class="btn sm" onClick=${() => onReuse(video)}><${Icon} name="refresh-cw" size="sm" /> ${t('Use these settings')}</button>
          <button class="btn sm" onClick=${() => copyText(video.prompt)}><${Icon} name="copy" size="sm" /> ${t('Copy description')}</button>
          <button class="btn sm danger" onClick=${() => onDelete(video)}><${Icon} name="trash" size="sm" /> ${t('Delete')}</button>
        </div>
      </div>
    </div>
  </div>`;
}

// A photo for the video, made small enough to send: at most 2048 pixels on its long side, as a JPEG (a see-through
// PNG gets a white background). The video is far smaller than that anyway.
async function photoData(file) {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, 2048 / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(bmp.width * scale));
  c.height = Math.max(1, Math.round(bmp.height * scale));
  const g = c.getContext('2d');
  g.fillStyle = '#fff';
  g.fillRect(0, 0, c.width, c.height);
  g.drawImage(bmp, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.92);
}

// The photos of the video: small tiles with what each one is for, and a tile to add more.
function Photos({ photos, setPhotos, use, max, onAdd }) {
  const label = (i) => (use === 'refs' ? t('Photo {n}', { n: i + 1 }) : i === 0 ? t('Start') : t('End'));
  return html`<div class="vid-photos">
    ${photos.map((ph, i) => html`<div class="vid-photo" key=${ph.id} title=${ph.fileName || t('Picture from the gallery')}>
      <img src=${ph.url} alt="" />
      <span class="vp-label">${label(i)}</span>
      <button class="vp-x" title=${t('Remove')} onClick=${() => setPhotos(photos.filter((x) => x.id !== ph.id))}><${Icon} name="x" /></button>
    </div>
    ${use !== 'refs' && i === 0 && photos.length > 1 && html`<button class="icon-btn" title=${t('Swap the start and the end')} onClick=${() => setPhotos([photos[1], photos[0], ...photos.slice(2)])}><${Icon} name="arrow-left-right" size="sm" /></button>`}`)}
    ${photos.length < max && html`<button class="vid-photo add" title=${t('Add photos')} onClick=${onAdd}><${Icon} name="plus" /><span>${photos.length ? t('Add') : t('Add photos')}</span></button>`}
  </div>`;
}

// The second video model (reference photos) is a download of its own, with its own terms.
function RefSetup({ refs, reload }) {
  const { downloads } = useStore();
  useEffect(() => {
    if (!refs.installing) return undefined;
    const timer = setInterval(() => {
      refreshDownloads();
      reload();
    }, 2000);
    return () => clearInterval(timer);
  }, [refs.installing]);
  const install = async () => {
    try {
      await api('/api/videos/install', { method: 'POST', body: { model: 'refs' } });
      refreshDownloads();
      reload();
    } catch (err) {
      toastError(err);
    }
  };
  return html`<div class="notice accent vid-refsetup"><${Icon} name="info" /><div class="grow col" style="gap:8px">
    <div><b>${t('Reference photos need a second video model: MiniMax-H3')}</b><br />${t('It keeps the people, products and places from your photos the same in the video, with sound. Download {size}.', { size: fmtBytes(refs.download || refs.size) })}${refs.fits ? '' : ` ${t('This computer may not have enough memory for it.')}`}</div>
    <div class="muted" style="font-size:12.5px">${t('MiniMax H3 Community License: it does not cover use in the United States, the European Union, the United Kingdom and South Korea; companies earning over $20 million a year need MiniMax’s permission; videos posted in public must be marked as made by AI.')}</div>
    <div class="row"><button class="btn sm primary" disabled=${refs.installing} onClick=${install}><${Icon} name=${refs.installing ? 'loader' : 'download'} cls=${refs.installing ? 'spin' : ''} size="sm" /> ${refs.installing ? t('Downloading…') : t('Install')}</button></div>
    <${Downloads} downloads=${downloads.filter((d) => d.meta?.model === 'refs')} kinds=${['videos']} />
  </div></div>`;
}

const STAGE_TEXT = (job) =>
  job.state === 'loading'
    ? t('Reading the description and loading the video model…')
    : job.state === 'saving'
      ? t('Putting the frames and sound together…')
      : job.stage === 2
        ? t('Sharpening to full size: step {s} of {steps}', { s: job.step, steps: job.steps })
        : t('Making the video: step {s} of {steps}', { s: job.step, steps: job.steps });

export function VideoPage() {
  const { status } = useStore();
  const [st, setSt] = useState(null);
  const [gallery, setGallery] = useState([]);
  const [prompt, setPrompt] = useState(() => readPref('hearth.vidPrompt', ''));
  const [seconds, setSeconds] = useState(() => readPref('hearth.vidSeconds', 5));
  const [format, setFormat] = useState(() => readPref('hearth.vidFormat', 'wide'));
  // The photos of the video, in order: { name } from the Pictures gallery, or { dataUrl, fileName } from this computer.
  // How they are used: 'frames' — the first is the start, the second the end (LTX-2.5); 'refs' — reference photos of
  // people, products and places (MiniMax-H3).
  const cameWith = readPref('hearth.vidFromPicture', '');
  const [photos, setPhotos] = useState(() => (cameWith ? [{ id: 'gallery', name: cameWith, url: `/images/${encodeURIComponent(cameWith)}` }] : []));
  const [use, setUseRaw] = useState(() => (cameWith ? 'frames' : readPref('hearth.vidUse', 'frames')));
  const [drag, setDrag] = useState(false);
  const [more, setMore] = useState(false);
  const [seed, setSeed] = useState('');
  const [negative, setNegative] = useState('');
  const [job, setJob] = useState(null);
  const [open, setOpen] = useState(null);
  const [unloaded, setUnloaded] = useState('');
  const fileRef = useRef(null);
  const load = () => api('/api/videos').then((r) => {
    setSt(r);
    if (r.job) setJob(r.job);
  }).catch(toastError);
  const loadGallery = () => api('/api/videos/gallery').then((r) => setGallery(r.videos)).catch(() => {});
  useEffect(() => {
    load();
    loadGallery();
    writePref('hearth.vidFromPicture', ''); // used once, when "Animate this picture" brought us here
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
      const r = await api('/api/videos/job').catch(() => null);
      if (!r?.job) return;
      setJob(r.job);
      if (r.job.state === 'done') loadGallery();
      if (r.job.state === 'error') toast(r.job.error, 'bad');
    }, 1000);
    return () => clearInterval(timer);
  }, [active]);

  const max = use === 'refs' ? st?.refs?.max || 4 : 2;
  const setUse = (u) => {
    setUseRaw(u);
    writePref('hearth.vidUse', u);
    if (u !== 'refs') setPhotos((x) => x.slice(0, 2));
    // Reference photos need far more memory the longer the video is: start short.
    else setSeconds(3);
  };
  const addPhotos = async (files) => {
    const pics = [...files].filter((f) => f.type.startsWith('image/') || /\.(heic|heif)$/i.test(f.name));
    if (!pics.length) return;
    const room = max - photos.length;
    if (pics.length > room) toast(use === 'refs' ? tn(max, 'A video takes up to {n} reference photo.', 'A video takes up to {n} reference photos.') : t('A video takes two photos here: the start and the end. For more, switch to reference photos.'));
    const added = [];
    for (const f of pics.slice(0, Math.max(0, room))) {
      try {
        const dataUrl = await photoData(f);
        added.push({ id: Math.random().toString(36).slice(2), dataUrl, url: dataUrl, fileName: f.name });
      } catch {
        toast(t('Could not open {name}. Choose a PNG, JPEG or WebP picture.', { name: f.name }), 'bad');
      }
    }
    if (added.length) setPhotos((x) => [...x, ...added].slice(0, max));
  };

  const generate = async (unload = false) => {
    writePref('hearth.vidPrompt', prompt);
    writePref('hearth.vidSeconds', seconds);
    writePref('hearth.vidFormat', format);
    try {
      const body = { prompt: prompt.trim(), seconds, size: format, seed: seed === '' ? undefined : Number(seed), negative, unload, use, photos: photos.slice(0, max).map((ph) => (ph.name ? { picture: ph.name } : { image: ph.dataUrl })) };
      const j = await api('/api/videos/generate', { method: 'POST', body });
      setJob(j);
      if (j.unloaded) setUnloaded(j.unloaded);
    } catch (err) {
      if (err.code === 'NEEDS_MEMORY') {
        if (await confirmDialog({ title: t('Free memory for the video?'), text: t('The chat model ({name}) is using the memory the video needs. Hearth can stop it while the video is made; you can load it again with one click afterwards.', { name: err.data?.error?.model || t('chat model') }), ok: t('Stop it and make the video') })) generate(true);
        return;
      }
      toastError(err);
    }
  };
  const del = async (v) => {
    await api(`/api/videos/${encodeURIComponent(v.name)}`, { method: 'DELETE' }).catch(toastError);
    setOpen(null);
    loadGallery();
  };
  const reuse = (v) => {
    setPrompt(v.prompt);
    setSeed(String(v.seed));
    if (v.seconds) setSeconds(v.seconds);
    if (v.size) setFormat(v.size);
    setOpen(null);
    window.scrollTo?.(0, 0);
  };
  const reloadChat = () => {
    const last = status?.settings?.lastModel;
    const m = getState().models.find((x) => x.id === last?.id);
    if (m) loadModel(m);
    setUnloaded('');
  };
  const fresh = job?.state === 'done' && job.video && gallery.find((g) => g.name === job.video);
  const refsOn = use === 'refs' && Boolean(st?.refs?.ready);
  const canMake = prompt.trim() && (use !== 'refs' || (refsOn && photos.length > 0));
  const progress = job && job.steps ? Math.min(1, (job.step || 0) / job.steps) : 0;

  return html`<div class="page"><div class="page-inner">
    <${PageHead} title=${t('Video')} text=${t('Describe a short video, or bring a picture to life. Hearth makes it on this computer, with sound.')} />
    ${!st
      ? html`<div class="card empty"><${Icon} name="loader" cls="spin" /></div>`
      : !st.ready
        ? html`<${Setup} st=${st} reload=${load} />`
        : html`<div class=${`card pad col ${drag ? 'vid-drag' : ''}`} style="gap:14px"
            onDragOver=${(e) => { if ([...(e.dataTransfer?.types || [])].includes('Files')) { e.preventDefault(); setDrag(true); } }}
            onDragLeave=${() => setDrag(false)}
            onDrop=${(e) => { e.preventDefault(); setDrag(false); addPhotos(e.dataTransfer.files); }}>
            <textarea class="textarea img-prompt" value=${prompt} onInput=${(e) => setPrompt(e.target.value)}
              onPaste=${(e) => { const fl = [...(e.clipboardData?.files || [])]; if (fl.some((f) => f.type.startsWith('image/'))) { e.preventDefault(); addPhotos(fl); } }} placeholder=${t('For example: a folded black t-shirt slowly unfolds on a wooden table, soft daylight, gentle music')} onKeyDown=${(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && canMake && !active) generate(); }}></textarea>
            <div class="col" style="gap:8px">
              <div class="row wrap" style="gap:10px;align-items:center">
                <div class="seg">
                  <button class=${use === 'frames' ? 'on' : ''} title=${t('The video begins on your first photo and, with a second one, ends on it')} onClick=${() => setUse('frames')}>${t('Start and end')}</button>
                  <button class=${use === 'refs' ? 'on' : ''} title=${t('Photos of a person, a product or a place that the video keeps the same')} onClick=${() => setUse('refs')}>${t('Reference photos')}</button>
                </div>
                <span class="muted" style="font-size:12.5px">${refsOn
                  ? `${t('Add up to {n} photos of a person, a product or a place. In the description, call them photo 1, photo 2… For example: the woman from photo 1 wears the T-shirt from photo 2.', { n: max })} ${t('Start with 3 seconds: longer videos with reference photos need much more memory and time.')}`
                  : use === 'refs'
                    ? ''
                    : photos.length > 1
                      ? t('The video starts on the first photo and ends on the second, following your description in between.')
                      : photos.length
                        ? t('The video starts from this photo and follows your description. Add a second photo to say where it ends.')
                        : t('Optional: add a photo to start the video from it (a product photo, a design), and a second one to end on.')}</span>
              </div>
              ${use === 'refs' && !st.refs?.ready
                ? html`<${RefSetup} refs=${st.refs || {}} reload=${load} />`
                : html`<${Photos} photos=${photos} setPhotos=${setPhotos} use=${use} max=${max} onAdd=${() => fileRef.current?.click()} />`}
              <input ref=${fileRef} type="file" multiple accept="image/*" style="display:none" onChange=${(e) => { addPhotos(e.target.files); e.target.value = ''; }} />
            </div>
            <div class="row wrap" style="gap:12px">
              <div class="seg">${LENGTHS().map(([n, l]) => html`<button class=${seconds === n ? 'on' : ''} onClick=${() => setSeconds(n)}>${l}</button>`)}</div>
              <div class="seg">${FORMATS().map(([k, l, r]) => html`<button class=${format === k ? 'on' : ''} title=${r} onClick=${() => setFormat(k)}>${l}</button>`)}</div>
              <button class="btn sm ghost" onClick=${() => setMore(!more)}><${Icon} name=${more ? 'chevron-up' : 'chevron-down'} size="sm" /> ${t('More')}</button>
              <span class="grow"></span>
              ${active
                ? html`<button class="btn" onClick=${() => api('/api/videos/cancel', { method: 'POST' }).then((r) => setJob(r.job))}><${Icon} name="square" size="sm" /> ${t('Stop')}</button>`
                : html`<button class="btn primary lg" disabled=${!canMake} onClick=${() => generate()}><${Icon} name="film" size="sm" /> ${t('Make video')}</button>`}
            </div>
            ${more && html`<div class="grid c2">
              <label class="field"><span>${t('Seed (same seed + same description = same video)')}</span><input class="input" type="number" min="0" value=${seed} placeholder=${t('random')} onInput=${(e) => setSeed(e.target.value)} /></label>
              ${use !== 'refs' && html`<label class="field"><span>${t('Leave out')}</span><input class="input" value=${negative} placeholder=${t('e.g. blurry, distorted, text')} onInput=${(e) => setNegative(e.target.value)} /></label>`}
            </div>`}
            <span class="muted" style="font-size:12.5px">${t('Describe what moves, the camera, the light and the sounds. Longer videos take longer: a 10-second clip takes about twice as long as a 5-second one.')}</span>
            ${active && html`<div class="col" style="gap:6px">
              <div class="progress"><i style=${{ width: `${Math.max(3, progress * 100)}%` }}></i></div>
              <span class="muted" style="font-size:13px">${STAGE_TEXT(job)} · ${fmtDuration(Date.now() - job.startedAt)}</span>
            </div>`}
            ${unloaded && !active && html`<div class="notice accent"><${Icon} name="info" /><div class="grow">${t('The chat model ({name}) was stopped to free memory.', { name: unloaded })}</div><button class="btn sm" onClick=${reloadChat}>${t('Load it again')}</button></div>`}
            ${fresh && html`<div class="vid-fresh"><${Player} video=${fresh} /></div>`}
          </div>`}
    ${gallery.length > 0 && html`<div class="section">
      <h2>${t('Gallery')} <span class="muted" style="font-weight:400;font-size:14px">${tn(gallery.length, '{n} video', '{n} videos')}</span></h2>
      <div class="img-grid">${gallery.map((g) => html`<${Tile} key=${g.name} g=${g} onOpen=${setOpen} />`)}</div>
    </div>`}
    ${open && html`<${Lightbox} video=${open} onClose=${() => setOpen(null)} onDelete=${del} onReuse=${reuse} />`}
  </div></div>`;
}
