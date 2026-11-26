// Hearth app shell: sidebar, routing between the pages, the language, and pairing for phones.
import { html, render, useEffect, useState, useRef } from '../vendor/preact-htm.js';
import { Icon } from './icons.js';
import { t, setLang, pickLang, locale } from './i18n.js';
import { useStore, set, go, parseRoute, refreshStatus, refreshModels, refreshChats, refreshAssistants, refreshUpdates, refreshBots, pollEngine, api, toastError, modelLabel, getState } from './store.js';
import { Dialogs, Toasts, confirmDialog, engineDot } from './ui.js';
import { ChatPage } from './chat.js';
import { ModelsPage } from './models.js';
import { MonitorPage } from './monitor.js';
import { ConnectPage } from './connect.js';
import { SettingsPage } from './settings.js';
import { AssistantsPage } from './assistants.js';
import { ExtensionsPage } from './extensions.js';
import { BatchPage } from './batch.js';
import { ImagesPage } from './images.js';
import { VideoPage } from './videos.js';
import { BotsPage } from './bots.js';
import { ArtifactsPage } from './artifacts.js';
import { DesignPage } from './design.js';
import { ModelSettingsDialog } from './model-settings.js';
import { Palette, useShortcuts, isMac } from './palette.js';
import { fmtCombo, activeShortcuts } from './keys.js';
import { readPref } from './store.js';

function dayGroup(ts) {
  const d = new Date(ts);
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (ts >= start) return t('Today');
  if (ts >= start - 86400e3) return t('Yesterday');
  if (ts >= start - 7 * 86400e3) return t('Previous 7 days');
  if (d.getFullYear() === now.getFullYear()) {
    const m = d.toLocaleString(locale(), { month: 'long' });
    return m[0].toUpperCase() + m.slice(1);
  }
  return String(d.getFullYear());
}

function ModelCard() {
  const { status } = useStore();
  const e = status?.engine;
  const last = status?.settings?.lastModel;
  const m = e?.model || last;
  let sub = t('No model loaded');
  if (e?.status === 'ready') sub = `${m?.quant || t('Ready')} · ${status.hardware?.backendLabel || ''}${e.ctx ? ` · ${Math.round(e.ctx / 1024)}K` : ''}`;
  else if (e?.status === 'starting') sub = t('Loading…');
  else if (e?.status === 'error') sub = e.error === 'NO_ENGINE' ? t('Engine needed') : t('Could not load');
  else if (last) sub = t('Stopped · click to load');
  return html`<button class="model-card" onClick=${() => go('#/models')} title=${t('Models')}>
    <span class="mc-icon"><${Icon} name="box" /><span class=${`dot ${engineDot(status)}`}></span></span>
    <span class="grow">
      <div class="mc-name ellipsis">${m ? modelLabel({ name: m.name }) : t('Pick a model')}</div>
      <div class="mc-sub ellipsis">${sub}</div>
    </span>
  </button>`;
}

// Search: titles at once, and the text of every chat on the server after a short pause.
function useChatSearch(q) {
  const [results, setResults] = useState(null);
  useEffect(() => {
    if (q.trim().length < 2) {
      setResults(null);
      return;
    }
    let alive = true;
    const timer = setTimeout(() => {
      api(`/api/chats?q=${encodeURIComponent(q.trim())}`)
        .then((r) => alive && setResults(r.results))
        .catch(() => {});
    }, 220);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [q]);
  return results;
}

function Sidebar() {
  const { chats, route, updates, bots } = useStore();
  const [q, setQ] = useState('');
  const [showArchive, setShowArchive] = useState(false);
  const results = useChatSearch(q);
  const shown = q ? results || chats.filter((c) => c.title.toLowerCase().includes(q.toLowerCase())) : chats;
  // Pinned chats on top, then by day; archived ones behind the "Archive" row. A search looks everywhere.
  const groups = [];
  const add = (g, c) => {
    if (!groups.length || groups[groups.length - 1].name !== g) groups.push({ name: g, items: [] });
    groups[groups.length - 1].items.push(c);
  };
  const archived = q ? [] : shown.filter((c) => c.archived);
  if (!q) for (const c of shown) if (c.pinned && !c.archived) add(t('Pinned'), c);
  for (const c of shown) {
    if (!q && (c.pinned || c.archived)) continue;
    add(q ? t('Found') : dayGroup(c.updatedAt), c);
  }
  const flag = async (c, patch) => {
    try {
      await api(`/api/chats/${c.id}/flags`, { method: 'POST', body: patch });
      await refreshChats();
    } catch (err) {
      toastError(err);
    }
  };
  // The row's menu is drawn over everything, at the button (or at the pointer for a right click), so the list's
  // own scrolling can't cut it off.
  const [menu, setMenu] = useState(null);
  const openMenu = (e, c) => {
    e.preventDefault();
    e.stopPropagation();
    const r = e.type === 'contextmenu' ? { right: e.clientX + 110, top: e.clientY, bottom: e.clientY } : e.currentTarget.getBoundingClientRect();
    const up = r.bottom > window.innerHeight - 170;
    setMenu({ c, left: Math.max(8, Math.min(r.right - 220, window.innerWidth - 232)), ...(up ? { bottom: window.innerHeight - r.top + 4 } : { top: r.bottom + 4 }) });
  };
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (e) => e.key === 'Escape' && close();
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', close);
    };
  }, [menu]);
  const chatRow = (c) => html`<a key=${c.id} class=${`sb-chat ${route.page === 'chat' && route.id === c.id ? 'active' : ''} ${c.snippet ? 'with-snippet' : ''} ${menu?.c.id === c.id ? 'menu-open' : ''}`} href=${`#/chat/${c.id}`} onClick=${closeOnMobile} onContextMenu=${(e) => openMenu(e, c)}>
    <span class="grow" style="min-width:0">
      <span class="ellipsis" style="display:block">${c.pinned && !c.archived && html`<${Icon} name="pin" size="sm" cls="sb-pin" />`}${c.title}</span>
      ${c.snippet && html`<span class="sb-snippet">${c.archived ? `${t('In the archive')} · ` : ''}${c.snippet}</span>`}
    </span>
    <button class="del more" title=${t('More')} onClick=${(e) => openMenu(e, c)}><${Icon} name="more" size="sm" /></button>
  </a>`;
  const paletteKeys = activeShortcuts(readPref('hearth.keys', {})).find((k) => k.id === 'palette')?.combo;
  const del = async (e, c) => {
    e?.stopPropagation?.();
    if (!(await confirmDialog({ title: t('Delete this chat?'), text: t('“{title}” will be removed for good.', { title: c.title }), ok: t('Delete'), danger: true }))) return;
    try {
      await api(`/api/chats/${c.id}`, { method: 'DELETE' });
      await refreshChats();
      if (route.page === 'chat' && route.id === c.id) go('#/');
    } catch (err) {
      toastError(err);
    }
  };
  const hasUpdates = Boolean(updates?.engine || updates?.models?.length);
  const nav = (page, icon, label, dot, extra = null, dotTitle = t('Updates available')) =>
    html`<a class=${`nav-item ${route.page === page ? 'active' : ''}`} href=${`#/${page}`} onClick=${closeOnMobile}><${Icon} name=${icon} /> <span class="grow">${label}</span>${extra}${dot && html`<span class="nav-dot" title=${dotTitle}></span>`}</a>`;
  return html`<aside class="sidebar">
    <div class="sb-top">
      <a class="brand" href="#/" onClick=${closeOnMobile}><img src="/logo.svg" alt="" />hearth</a>
      <button class="icon-btn" title=${t('Hide sidebar')} onClick=${() => set({ sidebarOpen: false })}><${Icon} name="panel-left" /></button>
    </div>
    <button class="new-chat" onClick=${() => { go('#/'); set({ newChatTick: Date.now() }); closeOnMobile(); }}><${Icon} name="plus" /> ${t('New chat')}</button>
    <div class="sb-search"><${Icon} name="search" size="sm" /><input placeholder=${t('Search chats')} value=${q} onInput=${(e) => setQ(e.target.value)} />${q ? html`<button class="icon-btn" style="width:22px;height:22px" title=${t('Clear')} onClick=${() => setQ('')}><${Icon} name="x" size="sm" /></button>` : paletteKeys && html`<button class="sb-cmd" title=${t('Find a chat, a page or an action…')} onClick=${() => set({ palette: true })}>${fmtCombo(paletteKeys, isMac())}</button>`}</div>
    <div class="sb-list">
      ${!chats.length && !q && html`<div class="sb-empty">${t('No chats yet')}</div>`}
      ${q && results && !shown.length && html`<div class="sb-empty">${t('Nothing found')}</div>`}
      ${groups.map(
        (g) => html`<div key=${g.name}>
          <div class="sb-group">${g.name}</div>
          ${g.items.map(chatRow)}
        </div>`,
      )}
      ${archived.length > 0 && html`<div key="archive">
        <button class="sb-group sb-archive" onClick=${() => setShowArchive(!showArchive)}><${Icon} name="archive" size="sm" /> ${t('Archive')} · ${archived.length} <${Icon} name=${showArchive ? 'chevron-up' : 'chevron-down'} size="sm" /></button>
        ${showArchive && archived.map(chatRow)}
      </div>`}
    </div>
    ${menu && html`<div class="pop sb-menu" style=${{ left: `${menu.left}px`, ...(menu.top != null ? { top: `${menu.top}px` } : { bottom: `${menu.bottom}px` }) }} onMouseDown=${(e) => e.stopPropagation()} onClick=${() => setMenu(null)}>
      ${!menu.c.archived && html`<button class="pop-item" onClick=${() => flag(menu.c, { pinned: !menu.c.pinned })}><${Icon} name="pin" size="sm" /> ${menu.c.pinned ? t('Unpin') : t('Pin to the top')}</button>`}
      <button class="pop-item" onClick=${() => flag(menu.c, { archived: !menu.c.archived })}><${Icon} name="archive" size="sm" /> ${menu.c.archived ? t('Take out of the archive') : t('Move to the archive')}</button>
      <div class="pop-sep"></div>
      <button class="pop-item danger" onClick=${(e) => del(e, menu.c)}><${Icon} name="trash" size="sm" /> ${t('Delete chat')}</button>
    </div>`}
    <div class="sb-bottom">
      <${ModelCard} />
      ${nav('bots', 'bot', t('Bots'), bots?.unread > 0, bots?.working ? html`<${Icon} name="loader" cls="spin" size="sm" />` : null, t('New results from bots'))}
      ${nav('artifacts', 'layout-grid', t('Artifacts'))}
      ${nav('design', 'palette', t('Design'))}
      ${nav('assistants', 'user', t('Assistants & memory'))}
      ${nav('extensions', 'puzzle', t('Customize'))}
      ${nav('batch', 'table', t('Batch'))}
      ${nav('images', 'wand', t('Pictures'))}
      ${nav('video', 'film', t('Video'))}
      ${nav('models', 'box', t('Models'), hasUpdates)}
      ${nav('monitor', 'activity', t('Monitor'))}
      ${nav('connect', 'plug', t('Connect apps'))}
      ${nav('settings', 'sliders', t('Settings'))}
    </div>
  </aside>`;
}

function closeOnMobile() {
  if (window.innerWidth <= 900) set({ sidebarOpen: false });
}

function App() {
  const { route, sidebarOpen, status, modelSettings } = useStore();
  useShortcuts();
  useEffect(() => {
    const onHash = () => set({ route: parseRoute() });
    window.addEventListener('hashchange', onHash);
    onHash();
    refreshChats();
    refreshModels();
    refreshAssistants();
    refreshUpdates();
    refreshBots();
    pollEngine();
    if (window.innerWidth <= 900) set({ sidebarOpen: false });
    const upd = setInterval(refreshUpdates, 10 * 60e3);
    const bot = setInterval(refreshBots, 10e3); // a bot may finish a task (or get one from Telegram) at any time
    return () => {
      window.removeEventListener('hashchange', onHash);
      clearInterval(upd);
      clearInterval(bot);
    };
  }, []);
  // Theme from settings (system / light / dark).
  useEffect(() => {
    const th = status?.settings?.theme;
    if (!th) return;
    if (th === 'system') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = th;
    try {
      localStorage.setItem('hearth.theme', th);
    } catch {}
  }, [status?.settings?.theme]);
  const narrow = window.innerWidth <= 900;
  const cls = `app ${sidebarOpen ? (narrow ? 'sb-open' : '') : 'sb-collapsed'}`;
  const Page = { chat: ChatPage, models: ModelsPage, monitor: MonitorPage, connect: ConnectPage, settings: SettingsPage, assistants: AssistantsPage, extensions: ExtensionsPage, batch: BatchPage, images: ImagesPage, video: VideoPage, bots: BotsPage, artifacts: ArtifactsPage, design: DesignPage }[route.page] || ChatPage;
  return html`<div class=${cls}>
    <${Sidebar} />
    <main class="main">
      ${narrow && sidebarOpen && html`<div class="overlay" style="z-index:59;background:rgba(0,0,0,.3)" onClick=${() => set({ sidebarOpen: false })}></div>`}
      <${Page} route=${route} />
    </main>
    ${modelSettings && html`<${ModelSettingsDialog} model=${modelSettings} onClose=${() => set({ modelSettings: null })} />`}
    <${Palette} />
    <${Dialogs} />
    <${Toasts} />
  </div>`;
}

// A phone or tablet that has not been paired yet: use the secret from the QR code, or explain how to get one.
function PairScreen({ error }) {
  return html`<div class="pair-screen">
    <img src="/logo.svg" alt="" />
    <h1>${t('Connect this device to Hearth')}</h1>
    <p>${error || t('On the computer, open Hearth → Settings → Phone and tablet, turn it on and scan the QR code with this device’s camera.')}</p>
  </div>`;
}

async function start() {
  const root = document.getElementById('app');
  setLang(pickLang('auto', navigator.languages || [navigator.language]));
  // Opened from the pairing QR code: trade the secret for this device's own cookie, then forget it.
  const pairToken = /^#pair=([\w-]+)/.exec(location.hash)?.[1];
  if (pairToken) {
    history.replaceState(null, '', location.pathname);
    try {
      await api('/api/pair', { method: 'POST', body: { token: pairToken } });
    } catch (err) {
      render(html`<${PairScreen} error=${err.message} />`, root);
      return;
    }
  }
  await refreshStatus();
  const st = getState().status;
  if (!st) {
    if (getState().needsPairing) render(html`<${PairScreen} />`, root);
    else render(html`<div class="pair-screen"><h1>${t('Hearth is not running. Start it again from the Hearth launcher.')}</h1></div>`, root);
    return;
  }
  const lang = pickLang(st.settings.language, navigator.languages || [navigator.language]);
  setLang(lang);
  document.documentElement.lang = lang;
  document.title = 'Hearth';
  render(html`<${App} />`, root);
}

start();
