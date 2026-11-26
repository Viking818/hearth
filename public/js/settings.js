// Settings page. Every change saves right away.
import { html, useState, useEffect, useRef } from '../vendor/preact-htm.js';
import { Icon } from './icons.js';
import { t, LANGS, getLang, locale } from './i18n.js';
import { useStore, api, toast, toastError, refreshModels, set, getState, loadModel, fmtBytes, refreshDownloads, copyText, go } from './store.js';
import { Toggle, confirmDialog, PageHead, CopyField } from './ui.js';
import { ShortcutSettings } from './palette.js';
import { notifyPrefs, setNotifyPref, canNotify, askToNotify, chime } from './notify.js';
import { canSpeak, voicesFor, speak, stopSpeaking } from './voice.js';
import { Downloads } from './models.js';

const CTX = [8192, 16384, 32768, 65536, 131072, 262144];

function Row({ title, text, children, fit = false }) {
  return html`<div class="set-row"><div class="lbl"><b>${title}</b>${text && html`<span>${text}</span>`}</div><div class=${`ctl ${fit ? 'fit' : ''}`}>${children}</div></div>`;
}

// This computer: starting with Windows (the Mac app's own menu does it there), and not falling asleep while bots or
// the model work. Only the computer itself changes these.
function ComputerSection({ s, save, isLocal }) {
  const [p, setP] = useState(null);
  const [busy, setBusy] = useState(false);
  const load = () => api('/api/power').then(setP).catch(() => {});
  useEffect(() => {
    load();
    const id = setInterval(load, 15000);
    return () => clearInterval(id);
  }, []);
  if (!p || (!p.login.available && !p.login.mac && !p.awake.available)) return null;
  const setLogin = async (on) => {
    setBusy(true);
    try {
      setP(await api('/api/power', { method: 'POST', body: { startAtLogin: on } }));
    } catch (err) {
      toastError(err);
      load();
    }
    setBusy(false);
  };
  const setAwake = async (v) => {
    await save({ keepAwake: v });
    setTimeout(load, 3000);
  };
  const why = { telegram: t('a bot answers in Telegram'), schedule: t('a bot has a schedule'), work: t('the model is working'), always: t('Hearth is running') }[p.awake.reason] || '';
  const now = p.awake.error
    ? html`<span class="bad-text">${p.awake.error}</span>`
    : p.awake.on
      ? t('Now: keeping the computer awake ({why}).', { why })
      : p.awake.starting
        ? t('Turning on…')
        : s.keepAwake === 'off'
          ? ''
          : t('Now: nothing needs it, so the computer may sleep.');
  return html`<div class="section" id="computer"><h2>${t('This computer')}</h2>
    <div class="card">
      ${p.login.available && html`<${Row} fit title=${t('Start with Windows')} text=${t('Hearth starts without a window when you sign in to Windows, so after a restart bots answer in Telegram and run on schedule again. The Hearth icon opens the window.')}>
        <${Toggle} on=${p.login.on} disabled=${!isLocal || busy} onChange=${setLogin} />
      <//>`}
      ${p.login.mac && html`<${Row} fit title=${t('Start with the Mac')} text=${t('In Hearth’s menu at the top of the screen: Open at login.')} />`}
      ${p.awake.available && html`<${Row} title=${t('Keep the computer awake')} text=${html`${t('Asleep, the computer answers nobody: bots miss Telegram messages and their schedule, and answers to apps stop halfway. The screen can still turn off.')}${now && html`<br /><b class="set-note">${now}</b>`}`}>
        <select class="select" disabled=${!isLocal} value=${s.keepAwake} onChange=${(e) => setAwake(e.target.value)}>
          <option value="auto">${t('While bots or the model work')}</option>
          <option value="always">${t('Always while Hearth runs')}</option>
          <option value="off">${t('Never (the system decides)')}</option>
        </select>
      <//>`}
    </div>
  </div>`;
}

function Block({ title, text, children }) {
  return html`<div class="set-row block"><div class="lbl"><b>${title}</b>${text && html`<span>${text}</span>`}</div>${children}</div>`;
}

function ToolsSection({ s, save, isLocal }) {
  const [key, setKey] = useState('');
  const [url, setUrl] = useState(null);
  const [dir, setDir] = useState('');
  const pick = async () => {
    try {
      const r = await api('/api/pick-folder', { method: 'POST' });
      if (r.path) save({ toolFolders: [...s.toolFolders, r.path] });
    } catch (err) {
      toastError(err);
    }
  };
  const providers = [
    ['free', t('DuckDuckGo, Brave and Bing (no key needed)')],
    ['wikipedia', t('Wikipedia only (no key needed)')],
    ['brave', t('Brave Search (free key)')],
    ['tavily', t('Tavily (free key)')],
    ['searxng', t('SearXNG (your own server)')],
  ];
  return html`<div class="section" id="tools"><h2>${t('Tools')}</h2>
    <p class="sub">${t('With tools on, the chat’s model can look things up and read files you allow. Each step shows in the chat.')}</p>
    <div class="card">
      <${Row} title=${t('Tools in the chat')} text=${t('Search, open web pages, read allowed folders, remember facts, use skills and connectors.')}>
        <${Toggle} on=${s.toolsOn} onChange=${(v) => save({ toolsOn: v })} />
      <//>
      <${Row} title=${t('Open pages that need scripts')} text=${t('Many pages show nothing until their scripts have run. For those, Hearth asks a browser of this computer (Edge, Chrome or Brave) to open the page without a window, with an empty profile: no sign-ins, cookies or history of yours. Only public web addresses are let through.')}>
        <${Toggle} on=${s.renderPages !== false} onChange=${(v) => save({ renderPages: v })} />
      <//>
      <${Row} title=${t('Web search')} text=${t('Without a key Hearth asks DuckDuckGo, then Brave, then Bing, slowly and one question at a time. These sites sometimes refuse a program; then the answer says that the search was limited. A free search key is steadier.')}>
        <select class="select" value=${s.searchProvider} onChange=${(e) => save({ searchProvider: e.target.value })}>${providers.map(([k, l]) => html`<option value=${k}>${l}</option>`)}</select>
      <//>
      ${(s.searchProvider === 'brave' || s.searchProvider === 'tavily') && html`<${Block} title=${t('Search key')} text=${s.searchProvider === 'brave' ? t('Get a free key at api-dashboard.search.brave.com.') : t('Get a free key at app.tavily.com.')}>
        <form class="row" onSubmit=${(e) => { e.preventDefault(); save({ searchKey: key.trim() }); setKey(''); }}>
          <input class="input" type="password" placeholder=${s.searchKey ? `•••••••• (${t('saved')})` : t('Paste the key')} value=${key} onInput=${(e) => setKey(e.target.value)} />
          <button class="btn">${t('Save')}</button>
          ${s.searchKey && html`<button type="button" class="btn danger" onClick=${() => save({ searchKey: '' })}>${t('Remove')}</button>`}
        </form>
      <//>`}
      ${s.searchProvider === 'searxng' && html`<${Block} title=${t('SearXNG address')} text=${t('For example a SearXNG running on your NAS. Its JSON output must be turned on.')}>
        <div class="row"><input class="input" placeholder="http://192.168.1.20:8080" value=${url ?? s.searchUrl} onInput=${(e) => setUrl(e.target.value)} /><button class="btn" onClick=${() => url != null && save({ searchUrl: url.trim() })}>${t('Save')}</button></div>
      <//>`}
      <${Block} title=${t('Folders the model may read')} text=${t('Only these folders and what is inside them. Hearth never lets the model change or delete files.')}>
        ${s.toolFolders.map((d) => html`<div class="row"><code class="grow ellipsis mono" style="font-size:13px">${d}</code><button class="btn sm" onClick=${() => save({ toolFolders: s.toolFolders.filter((x) => x !== d) })}>${t('Remove')}</button></div>`)}
        ${isLocal
          ? html`<form class="row" onSubmit=${(e) => { e.preventDefault(); if (dir.trim()) { save({ toolFolders: [...s.toolFolders, dir.trim()] }); setDir(''); } }}>
              <input class="input" placeholder=${getState().status?.app?.platform === 'win32' ? 'C:\\Users\\me\\Documents' : '/Users/me/Documents'} value=${dir} onInput=${(e) => setDir(e.target.value)} />
              <button type="button" class="btn" onClick=${pick}><${Icon} name="folder" size="sm" /> ${t('Choose…')}</button>
              <button class="btn">${t('Add')}</button>
            </form>`
          : html`<span class="muted">${t('Folders can be added on the computer itself.')}</span>`}
      <//>
      <${Row} title=${t('Skills, plugins and connectors')} text=${t('Connectors (MCP servers), skills, plugins and commands are on the Extensions page.')}>
        <button class="btn" onClick=${() => go('#/extensions/connectors')}><${Icon} name="puzzle" size="sm" /> ${t('Open Customize')}</button>
      <//>
    </div>
  </div>`;
}

function VoiceSection({ s, save }) {
  const { downloads } = useStore();
  const [st, setSt] = useState(null);
  const [voices, setVoices] = useState([]);
  const [nat, setNat] = useState(null); // the natural voice for spoken answers: what is installed
  const [playing, setPlaying] = useState(false);
  const loadNat = () => api('/api/voice/natural').then(setNat).catch(() => {});
  const load = () => {
    api('/api/voice').then(setSt).catch(() => {});
    loadNat();
    // While something for the voice is downloading, its progress below is kept moving.
    if ((getState().downloads || []).some((d) => (d.kind === 'voice' || d.kind === 'speech') && (d.state === 'downloading' || d.state === 'queued' || d.state === 'finishing'))) refreshDownloads();
  };
  useEffect(() => {
    refreshDownloads();
    load();
    const timer = setInterval(load, 3000);
    const v = () => setVoices(voicesFor(getLang()));
    v();
    window.speechSynthesis?.addEventListener?.('voiceschanged', v);
    return () => {
      clearInterval(timer);
      window.speechSynthesis?.removeEventListener?.('voiceschanged', v);
    };
  }, []);
  const install = async () => {
    try {
      await api('/api/voice/install', { method: 'POST' });
      refreshDownloads();
      load();
    } catch (err) {
      toastError(err);
    }
  };
  const installNat = async () => {
    try {
      await api('/api/voice/natural/install', { method: 'POST' });
      refreshDownloads();
      loadNat();
    } catch (err) {
      toastError(err);
    }
  };
  const removeNat = async () => {
    if (!(await confirmDialog({ title: t('Remove the natural voice?'), text: t('Spoken answers go back to the voice of the system. You can download it again at any time.'), ok: t('Remove'), danger: true }))) return;
    try {
      setNat(await api('/api/voice/natural', { method: 'DELETE' }));
    } catch (err) {
      toastError(err);
    }
  };
  // The chosen voice reads a short line, the way it will read answers.
  const hearNat = async () => {
    setPlaying(true);
    try {
      const res = await fetch('/api/voice/say', { method: 'POST', headers: { 'content-type': 'application/json', 'x-hearth-lang': document.documentElement.lang || 'en' }, body: JSON.stringify({ text: t('Hello! This is how I will answer you by voice.'), voice: 'natural', style: s.naturalVoiceStyle || 4 }) });
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.error?.message || t('Request failed ({status})', { status: res.status }));
      const audio = new Audio(URL.createObjectURL(await res.blob()));
      audio.onended = () => URL.revokeObjectURL(audio.src);
      await audio.play();
    } catch (err) {
      toastError(err);
    }
    setPlaying(false);
  };
  return html`<div class="section" id="voice"><h2>${t('Voice')}</h2>
    <div class="card">
      <${Block} title=${t('Speak instead of typing')} text=${t('The microphone button in the chat turns speech into text on this computer, with Whisper. Russian, English and about 100 other languages.')}>
        ${!st
          ? html`<span class="muted">${t('Checking…')}</span>`
          : st.ready
            ? html`<div class="row"><span class="badge ok"><${Icon} name="check" /> ${t('Ready')}</span><span class="muted">${st.model?.name} · ${st.engine?.source === 'homebrew' ? 'Homebrew' : st.engine?.source === 'system' ? t('installed on this computer') : t('downloaded')}</span></div>`
            : html`<div class="col" style="gap:10px">
                ${st.needsHomebrew &&
                html`<div class="notice"><${Icon} name="terminal" /><div class="grow col" style="gap:8px">
                  <span>${t('On a Mac the speech engine comes from Homebrew. Paste this into Terminal once:')}</span>
                  <${CopyField} value=${st.brewCommand} />
                  <span class="muted" style="font-size:13px">${t('No Homebrew yet? It installs from brew.sh in a few minutes. Hearth finds the engine by itself afterwards.')}</span>
                </div></div>`}
                ${!st.model && html`<div class="row"><button class="btn primary" disabled=${st.installing} onClick=${install}><${Icon} name=${st.installing ? 'loader' : 'download'} cls=${st.installing ? 'spin' : ''} size="sm" /> ${st.needsHomebrew ? t('Download the speech model ({size})', { size: fmtBytes(st.modelSize) }) : t('Download voice input ({size})', { size: fmtBytes(st.modelSize) })}</button></div>`}
                ${st.model && !st.engine && !st.needsHomebrew && html`<div class="row"><button class="btn primary" disabled=${st.installing} onClick=${install}><${Icon} name="download" size="sm" /> ${t('Download the speech engine')}</button></div>`}
              </div>`}
        <${Downloads} downloads=${downloads} kinds=${['voice']} />
      <//>
      <${Block} title=${t('A natural voice for spoken answers')} text=${t('When a bot answers a voice message in Telegram, it speaks with this voice instead of the system’s robotic one. It speaks on this computer; nothing is sent anywhere. Russian, English and 29 other languages.')}>
        ${!nat
          ? html`<span class="muted">${t('Checking…')}</span>`
          : !nat.supported
            ? html`<span class="muted">${t('The natural voice is not available for this kind of computer.')}</span>`
            : nat.ready
              ? html`<div class="col" style="gap:10px">
                  <div class="row wrap"><span class="badge ok"><${Icon} name="check" /> ${t('Ready')}</span><span class="muted">${nat.name}</span><span class="grow"></span><span class="muted">${t('Use it for spoken answers')}</span><${Toggle} on=${s.naturalVoice !== false} onChange=${(v) => save({ naturalVoice: v }, true)} /></div>
                  <div class="row">
                    <select class="select" style="width:auto;min-width:150px" value=${String(s.naturalVoiceStyle || 4)} onChange=${(e) => save({ naturalVoiceStyle: Number(e.target.value) }, true)}>
                      ${Array.from({ length: nat.voices }, (_, i) => html`<option value=${String(i + 1)}>${t('Voice {n}', { n: i + 1 })}</option>`)}
                    </select>
                    <button class="btn sm" disabled=${playing} onClick=${hearNat}><${Icon} name=${playing ? 'loader' : 'volume-2'} cls=${playing ? 'spin' : ''} size="sm" /> ${t('Listen')}</button>
                    <span class="grow"></span>
                    <button class="btn sm" onClick=${removeNat}>${t('Remove')}</button>
                  </div>
                  ${nat.error && html`<div class="notice bad"><${Icon} name="alert" /><div>${t('Last time the natural voice could not speak, and the system’s voice answered instead: {error}', { error: nat.error })}</div></div>`}
                </div>`
              : html`<div class="row"><button class="btn primary" disabled=${nat.installing} onClick=${installNat}><${Icon} name=${nat.installing ? 'loader' : 'download'} cls=${nat.installing ? 'spin' : ''} size="sm" /> ${t('Download the natural voice ({size})', { size: fmtBytes(nat.size) })}</button></div>`}
        <${Downloads} downloads=${downloads} kinds=${['speech']} />
      <//>
      ${canSpeak() && html`<${Row} title=${t('Voice for reading answers aloud')} text=${t('Uses the voices already on this computer. More voices: System Settings → Accessibility → Spoken Content.')}>
        <div class="row">
          <select class="select" value=${s.ttsVoice} onChange=${(e) => save({ ttsVoice: e.target.value }, true)}>
            <option value="">${t('Default voice')}</option>
            ${voices.map((v) => html`<option value=${v.name}>${v.name}${v.localService ? '' : ` (${t('online')})`}</option>`)}
          </select>
          <button class="btn sm" onClick=${() => { stopSpeaking(); speak('test', t('Hello! This is how I will read answers aloud.')); }}><${Icon} name="volume-2" size="sm" /> ${t('Try')}</button>
        </div>
      <//>`}
    </div>
  </div>`;
}

export function QrCode({ text }) {
  const [src, setSrc] = useState('');
  useEffect(() => {
    let alive = true;
    import('/vendor/qrcode/qrcode.mjs').then(({ default: qrcode }) => {
      const qr = qrcode(0, 'M');
      qr.addData(text);
      qr.make();
      if (alive) setSrc(qr.createDataURL(6, 2));
    });
    return () => {
      alive = false;
    };
  }, [text]);
  return src ? html`<img class="qr" src=${src} alt=${t('QR code')} />` : null;
}

function PhoneSection({ isLocal }) {
  const [info, setInfo] = useState(null);
  const load = () => api('/api/phone').then(setInfo).catch(() => {});
  useEffect(() => {
    if (isLocal) load();
  }, []);
  if (!isLocal) return null;
  const toggle = async (on) => {
    try {
      setInfo(await api('/api/phone', { method: 'POST', body: { on } }));
    } catch (err) {
      toastError(err);
    }
  };
  const reset = async () => {
    if (!(await confirmDialog({ title: t('Disconnect all phones and tablets?'), text: t('They will have to scan a new QR code to use Hearth again.'), ok: t('Disconnect all'), danger: true }))) return;
    setInfo(await api('/api/phone/reset', { method: 'POST' }));
  };
  const forget = async (id) => setInfo(await api(`/api/phone/devices/${id}`, { method: 'DELETE' }));
  const url = info?.urls?.[0];
  return html`<div class="section" id="phone"><h2>${t('Phone and tablet')}</h2>
    <div class="card">
      <${Row} title=${t('Use Hearth from a phone or tablet')} text=${t('On the same Wi-Fi. Each device scans the code once; other devices on the network can’t get in.')}>
        <${Toggle} on=${Boolean(info?.on)} onChange=${toggle} />
      <//>
      ${info?.on &&
      html`<${Block} title=${t('Scan with the phone’s camera')} text=${url ? t('Or open this address on the phone:') : t('This computer is not connected to a network right now.')}>
        ${url && html`<div class="phone-pair"><${QrCode} text=${url} /><div class="col grow" style="gap:8px;min-width:0">
          <code class="mono ellipsis" style="font-size:12.5px">${url.split('#')[0]}</code>
          ${info.urls.length > 1 && html`<span class="muted" style="font-size:13px">${t('If it doesn’t open, the phone may be on another network of this computer:')} ${info.urls.slice(1).map((u) => html`<button class="btn sm ghost mono" onClick=${() => copyText(u)}>${u.split('#')[0]}</button>`)}</span>`}
          <span class="muted" style="font-size:13px">${t('Voice input needs a secure connection, so on phones it is off; everything else works. The connection inside your Wi-Fi is not encrypted, so use it at home or at work, not on public Wi-Fi.')}</span>
          <div class="row"><button class="btn sm" onClick=${() => copyText(url)}><${Icon} name="copy" size="sm" /> ${t('Copy link')}</button></div>
        </div></div>`}
      <//>`}
      ${info?.devices?.length > 0 &&
      html`<${Block} title=${t('Connected devices')}>
        ${info.devices.map((d) => html`<div class="row"><${Icon} name="smartphone" size="sm" /><span class="grow">${t(d.name)}</span><span class="muted" style="font-size:13px">${new Date(d.lastSeen || d.createdAt).toLocaleString(locale())}</span><button class="btn sm" onClick=${() => forget(d.id)}>${t('Disconnect')}</button></div>`)}
        <div class="row"><button class="btn sm danger" onClick=${reset}>${t('Disconnect all')}</button></div>
      <//>`}
    </div>
  </div>`;
}

export function SettingsPage({ route }) {
  const { status } = useStore();
  const [engines, setEngines] = useState([]);
  const [system, setSystem] = useState(null);
  const [args, setArgs] = useState(null);
  const [token, setToken] = useState('');
  const [newDir, setNewDir] = useState('');
  const [np, setNp] = useState(notifyPrefs);
  const top = useRef(null);
  useEffect(() => {
    api('/api/engines').then((r) => setEngines(r.engines)).catch(() => {});
  }, []);
  // #/settings/voice opens the page at that section (once the page has drawn).
  useEffect(() => {
    if (!route?.id || !status) return;
    const timer = setTimeout(() => document.getElementById(route.id)?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 120);
    return () => clearTimeout(timer);
  }, [route?.id, Boolean(status)]);
  if (!status) return null;
  const s = status.settings;
  const isLocal = /^(127\.0\.0\.1|localhost|\[::1\])$/.test(location.hostname);
  const loaded = status.engine?.status === 'ready' || status.engine?.status === 'starting';
  const needsReload = (patch) => loaded && ['contextSize', 'parallel', 'vision', 'engineArgs', 'enginePath', 'speculative'].some((k) => k in patch);

  const save = async (patch, quiet) => {
    try {
      const next = await api('/api/settings', { method: 'PUT', body: patch });
      set({ status: { ...getState().status, settings: next } });
      if ('scanLmStudio' in patch || 'scanOllama' in patch || 'scanHfCache' in patch || 'extraModelDirs' in patch || 'modelsDir' in patch) refreshModels();
      if ('language' in patch) {
        location.reload();
        return;
      }
      if (needsReload(patch)) {
        toast(t('Saved. Reload the model to use it.'));
        return;
      }
      if (!quiet) toast(t('Saved'));
    } catch (err) {
      toastError(err);
    }
  };
  const reload = () => {
    const m = getState().models.find((x) => x.id === status.engine?.model?.id);
    if (m) loadModel(m);
  };
  const quit = async () => {
    if (!(await confirmDialog({ title: t('Quit Hearth?'), text: t('The model stops and apps can no longer reach it. Start Hearth again from its launcher.'), ok: t('Quit'), danger: true }))) return;
    await api('/api/shutdown', { method: 'POST' }).catch(() => {});
    document.body.textContent = '';
    const msg = document.createElement('div');
    msg.style.cssText = 'display:grid;place-items:center;height:100vh;font:16px Inter,system-ui;color:#78716c';
    msg.textContent = t('Hearth has stopped. You can close this window.');
    document.body.appendChild(msg);
  };

  return html`<div class="page" ref=${top}><div class="page-inner">
    <${PageHead} title=${t('Settings')} text=${t('Changes save right away.')}>
      ${loaded && html`<button class="btn" onClick=${reload}><${Icon} name="rotate-ccw" size="sm" /> ${t('Reload model')}</button>`}
    <//>
    <div class="settings-nav">
      ${[['look', t('Language')], ['models', t('Models')], ['chat', t('Chat')], ['keys', t('Shortcuts')], ['tools', t('Tools')], ['voice', t('Voice')], ['phone', t('Phone')], ['computer', t('Computer')], ['apps', t('Apps')], ['about', t('About')]].map(([id, l]) => html`<a href=${`#/settings/${id}`}>${l}</a>`)}
    </div>

    <div class="section" id="look"><h2>${t('Language and look')}</h2>
      <div class="card">
        <${Row} title=${t('Language')} text=${t('Hearth’s own words. Models answer in the language you write in.')}>
          <select class="select" value=${s.language} onChange=${(e) => save({ language: e.target.value })}>
            <option value="auto">${t('Automatic ({lang})', { lang: LANGS.find(([k]) => k === getLang())?.[1] || 'English' })}</option>
            ${LANGS.map(([k, l]) => html`<option value=${k}>${l}</option>`)}
          </select>
        <//>
        <${Row} title=${t('Theme')}>
          <div class="seg">
            ${[['system', t('Automatic')], ['light', t('Light')], ['dark', t('Dark')]].map(([k, l]) => html`<button class=${s.theme === k ? 'on' : ''} onClick=${() => save({ theme: k }, true)}>${l}</button>`)}
          </div>
        <//>
      </div>
    </div>

    <div class="section" id="models"><h2>${t('Running models')}</h2>
      <div class="card">
        <${Row} title=${t('Context size')} text=${t('How much text the model keeps in mind at once. Longer uses more memory. Coding tools and long documents want 64K.')}>
          <select class="select" value=${s.contextSize} onChange=${(e) => save({ contextSize: Number(e.target.value) })}>
            ${CTX.map((c) => html`<option value=${c}>${t('{n}K tokens', { n: c / 1024 })}${c === 32768 ? ` (${t('default')})` : ''}</option>`)}
          </select>
        <//>
        <${Row} title=${t('Images')} text=${t('Load the image helper for models that can see pictures.')}>
          <${Toggle} on=${s.vision} onChange=${(v) => save({ vision: v })} />
        <//>
        <${Row} title=${t('Guess-and-check speed-up')} text=${t('Cheap guesses for the next words, checked by the model in one go. Same answers, often faster for code and repeated text. Hearth turns it on only where it helps.')}>
          <${Toggle} on=${s.speculative !== 'off'} onChange=${(v) => save({ speculative: v ? 'auto' : 'off' })} />
        <//>
        <${Row} title=${t('Run several models')} text=${t('Loading another model keeps the ones already loaded. Apps choose a model by its name; the chat uses the last one loaded. Each model’s own settings are on the Models page.')}>
          <${Toggle} on=${s.multiModel} onChange=${(v) => save({ multiModel: v })} />
        <//>
        <${Row} title=${t('Parallel slots')} text=${t('2 lets coding tools run side tasks without forgetting the main conversation, which keeps their turns fast. The slots share one context.')}>
          <select class="select" value=${s.parallel} onChange=${(e) => save({ parallel: Number(e.target.value) })}>${[1, 2, 3, 4].map((n) => html`<option value=${n}>${n}</option>`)}</select>
        <//>
        <${Row} title=${t('Load the last model automatically')} text=${t('When Hearth starts, and when an app calls the API.')}>
          <${Toggle} on=${s.autoLoad} onChange=${(v) => save({ autoLoad: v })} />
        <//>
        <${Row} title=${t('Check for updates')} text=${t('Once a day Hearth looks for a newer engine and for changed model files, and shows them on the Models page. Nothing installs by itself.')}>
          <${Toggle} on=${s.checkUpdates} onChange=${(v) => save({ checkUpdates: v })} />
        <//>
      </div>
    </div>

    <div class="section" id="chat"><h2>${t('Chat')}</h2>
      <div class="card">
        <${Row} title=${t('Think by default')} text=${t('New chats start with the Think switch on.')}>
          <${Toggle} on=${s.chatThinking} onChange=${(v) => { save({ chatThinking: v }); try { localStorage.setItem('hearth.think', JSON.stringify(v)); } catch {} }} />
        <//>
        <${Row} title=${t('Memory')} text=${t('The chat keeps in mind the facts on the Memory page (your name, your business, how you like answers).')}>
          <div class="row"><a class="btn sm" href="#/assistants/memory">${t('Open Memory')}</a><${Toggle} on=${s.memoryOn} onChange=${(v) => save({ memoryOn: v })} /></div>
        <//>
        <${Row} title=${t('Sound when an answer is ready')} text=${t('A short sound after a long answer, or when Hearth is in the background. In this browser only.')}>
          <${Toggle} on=${np.sound} onChange=${(v) => { setNotifyPref('sound', v); setNp(notifyPrefs()); if (v) chime('done'); }} />
        <//>
        ${canNotify() && html`<${Row} title=${t('Notify me when Hearth is in the background')} text=${t('A notification when an answer is ready or a tool waits for your OK while you are in another window. In this browser only.')}>
          <${Toggle} on=${np.notify} onChange=${async (v) => {
            if (v && !(await askToNotify())) return toast(t('Notifications are blocked for this page. Allow them in the browser’s site settings and try again.'), 'bad');
            setNotifyPref('notify', v);
            setNp(notifyPrefs());
          }} />
        <//>`}
        <${Block} title=${t('Instructions for every chat')} text=${t('For example: “Answer in Russian” or “Keep answers short.”')}>
          <textarea class="textarea" placeholder=${t('Optional')} value=${system ?? s.systemPrompt} onInput=${(e) => setSystem(e.target.value)} onBlur=${() => system != null && system !== s.systemPrompt && save({ systemPrompt: system })}></textarea>
        <//>
      </div>
    </div>

    <${ShortcutSettings} />
    <${ToolsSection} s=${s} save=${save} isLocal=${isLocal} />
    <${VoiceSection} s=${s} save=${save} />
    <${PhoneSection} isLocal=${isLocal} />
    <${ComputerSection} s=${s} save=${save} isLocal=${isLocal} />

    <div class="section" id="apps"><h2>${t('Apps')}</h2>
      <div class="card">
        <${Row} title=${t('Thinking for apps')} text=${t('Coding tools answer much faster with thinking off.')}>
          <select class="select" value=${s.apiThinking} onChange=${(e) => save({ apiThinking: e.target.value })}>
            <option value="default">${t('Model decides')}</option>
            <option value="off">${t('Off (faster)')}</option>
          </select>
        <//>
        ${isLocal && html`<${Row} title=${t('Port')} text=${t('Hearth’s address is http://127.0.0.1:{port}. A new port applies after restarting Hearth.', { port: status.urls.app.split(':').pop() })}>
          <input class="input" type="number" min="1024" max="65535" value=${s.port} onChange=${(e) => save({ port: Number(e.target.value) })} style="width:120px" />
        <//>`}
      </div>
    </div>

    ${isLocal && html`<div class="section"><h2>${t('Where models come from')}</h2>
      <div class="card">
        <${Row} title=${t('Hearth’s models folder')} text=${s.modelsDir || s.defaultModelsDir}>
          <button class="btn sm" onClick=${() => api('/api/reveal', { method: 'POST', body: { what: 'models' } })}><${Icon} name="folder" size="sm" /> ${t('Open')}</button>
        <//>
        <${Row} title=${t('Use LM Studio models')} text="~/.lmstudio/models"><${Toggle} on=${s.scanLmStudio} onChange=${(v) => save({ scanLmStudio: v })} /><//>
        <${Row} title=${t('Use Ollama models')} text=${t('Only the ones stored as GGUF files')}><${Toggle} on=${s.scanOllama} onChange=${(v) => save({ scanOllama: v })} /><//>
        <${Row} title=${t('Use the Hugging Face cache')} text="~/.cache/huggingface/hub"><${Toggle} on=${s.scanHfCache} onChange=${(v) => save({ scanHfCache: v })} /><//>
        <${Block} title=${t('More folders')} text=${t('Folders with .gguf files, e.g. an external drive.')}>
          ${s.extraModelDirs.map((d) => html`<div class="row"><code class="grow ellipsis mono" style="font-size:13px">${d}</code><button class="btn sm" onClick=${() => save({ extraModelDirs: s.extraModelDirs.filter((x) => x !== d) })}>${t('Remove')}</button></div>`)}
          <form class="row" onSubmit=${(e) => { e.preventDefault(); if (newDir.trim()) { save({ extraModelDirs: [...s.extraModelDirs, newDir.trim()] }); setNewDir(''); } }}>
            <input class="input" placeholder=${status.app.platform === 'win32' ? 'D:\\Models' : '/Volumes/Drive/Models'} value=${newDir} onInput=${(e) => setNewDir(e.target.value)} />
            <button class="btn">${t('Add')}</button>
          </form>
        <//>
        <${Block} title=${t('Hugging Face token')} text=${`${t('Only needed for models that require a login.')} ${s.hfToken ? t('A token is saved.') : ''}`}>
          <form class="row" onSubmit=${(e) => { e.preventDefault(); save({ hfToken: token.trim() }); setToken(''); }}>
            <input class="input" type="password" placeholder=${s.hfToken ? `•••••••• (${t('saved')})` : 'hf_…'} value=${token} onInput=${(e) => setToken(e.target.value)} />
            <button class="btn">${t('Save')}</button>
            ${s.hfToken && html`<button type="button" class="btn danger" onClick=${() => save({ hfToken: '' })}>${t('Remove')}</button>`}
          </form>
        <//>
      </div>
    </div>

    <div class="section"><h2>${t('Engine')}</h2>
      <div class="card">
        <${Row} title=${t('Engine to use')} text=${t('Automatic picks the best llama.cpp build on this computer.')}>
          <select class="select" value=${s.enginePath} onChange=${(e) => save({ enginePath: e.target.value })}>
            <option value="">${t('Automatic')}</option>
            ${engines.map((en) => html`<option value=${en.path}>b${en.build} · ${en.source}${en.backend ? ` · ${en.backend}` : ''}</option>`)}
          </select>
        <//>
        <${Block} title=${t('Extra engine options')} text=${html`${t('For experts: added to the llama-server command, e.g.')} <code>--n-cpu-moe 20</code> ${t('or')} <code>-ctk q8_0 -ctv q8_0</code>.`}>
          <div class="row">
            <input class="input mono" value=${args ?? s.engineArgs} onInput=${(e) => setArgs(e.target.value)} placeholder=${t('Optional')} />
            <button class="btn" onClick=${() => args != null && save({ engineArgs: args })}>${t('Save')}</button>
          </div>
        <//>
      </div>
    </div>`}

    <div class="section" id="about"><h2>${t('About')}</h2>
      <div class="card">
        <${Row} title=${`Hearth ${status.app.version}`} text=${t('Node {node} · {os} · data in {dir}', { node: status.app.node, os: status.hardware.osName, dir: s.dataDir })}>
          ${isLocal && html`<button class="btn sm" onClick=${() => api('/api/reveal', { method: 'POST', body: { what: 'data' } })}><${Icon} name="folder" size="sm" /> ${t('Data folder')}</button>`}
        <//>
        ${isLocal && html`<${Row} title=${t('Quit Hearth')} text=${t('Stops the model and the app.')}>
          <button class="btn sm danger" onClick=${quit}><${Icon} name="power" size="sm" /> ${t('Quit')}</button>
        <//>`}
      </div>
    </div>
  </div></div>`;
}
