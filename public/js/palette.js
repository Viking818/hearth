// The command palette (find a page, an action or a chat by typing) and the keyboard shortcuts.
import { html, useState, useEffect, useRef } from '../vendor/preact-htm.js';
import { Icon } from './icons.js';
import { t } from './i18n.js';
import { useStore, getState, set, go, api, readPref, writePref, toast } from './store.js';
import { SHORTCUTS, comboOf, fmtCombo, usable, activeShortcuts, filterItems } from './keys.js';

export const isMac = () => /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent || '');
const savedKeys = () => readPref('hearth.keys', {});

const NAMES = () => ({
  palette: t('Open the command palette'),
  newChat: t('New chat'),
  searchChats: t('Search chats'),
  sidebar: t('Show or hide the sidebar'),
  stop: t('Stop the answer'),
  models: t('Open Models'),
  settings: t('Open Settings'),
});

export function runAction(id) {
  const s = getState();
  if (id === 'palette') set({ palette: !s.palette });
  else if (id === 'newChat') {
    go('#/');
    set({ newChatTick: Date.now() });
  } else if (id === 'searchChats') {
    set({ sidebarOpen: true });
    setTimeout(() => document.querySelector('.sb-search input')?.focus(), 60);
  } else if (id === 'sidebar') set({ sidebarOpen: !s.sidebarOpen });
  else if (id === 'stop') set({ chatCommand: { name: 'stop', at: Date.now() } });
  else if (id === 'compact') set({ chatCommand: { name: 'compact', at: Date.now() } });
  else if (id === 'models') go('#/models');
  else if (id === 'settings') go('#/settings');
  else if (id === 'theme') {
    const dark = document.documentElement.dataset.theme === 'dark' || (!document.documentElement.dataset.theme && matchMedia('(prefers-color-scheme: dark)').matches);
    api('/api/settings', { method: 'PUT', body: { theme: dark ? 'light' : 'dark' } })
      .then((next) => set({ status: { ...getState().status, settings: next } }))
      .catch(() => {});
  }
}

// Listens for the shortcuts everywhere in the app. Call once, from the app shell.
export function useShortcuts() {
  useEffect(() => {
    const onKey = (e) => {
      if (getState().recordingKey || e.isComposing) return;
      const combo = comboOf(e, isMac());
      if (!combo || !usable(combo)) return;
      const hit = activeShortcuts(savedKeys()).find((s) => s.combo === combo);
      if (!hit) return;
      if (getState().dialog && hit.id !== 'palette') return; // a question on screen comes first
      e.preventDefault();
      e.stopPropagation();
      runAction(hit.id);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);
}

function paletteItems() {
  const s = getState();
  const keys = Object.fromEntries(activeShortcuts(savedKeys()).map((k) => [k.id, k.combo]));
  const act = (id, icon, label) => ({ key: `a-${id}`, icon, label, combo: keys[id] || '', run: () => runAction(id) });
  const page = (hash, icon, label) => ({ key: `p-${hash}`, icon, label, hint: t('Page'), run: () => go(hash) });
  const onChat = s.route.page === 'chat' && s.route.id;
  return [
    act('newChat', 'plus', t('New chat')),
    act('searchChats', 'search', t('Search chats')),
    ...(onChat ? [act('compact', 'layers', t('Sum up older messages')), act('stop', 'square', t('Stop the answer'))] : []),
    page('#/bots', 'bot', t('Bots')),
    page('#/artifacts', 'layout-grid', t('Artifacts')),
    page('#/design', 'palette', t('Design')),
    page('#/assistants', 'user', t('Assistants & memory')),
    page('#/extensions', 'puzzle', t('Customize')),
    page('#/batch', 'table', t('Batch')),
    page('#/images', 'wand', t('Pictures')),
    page('#/video', 'film', t('Video')),
    page('#/models', 'box', t('Models')),
    page('#/monitor', 'activity', t('Monitor')),
    page('#/connect', 'plug', t('Connect apps')),
    page('#/settings', 'sliders', t('Settings')),
    page('#/settings/keys', 'keyboard', t('Keyboard shortcuts')),
    act('sidebar', 'panel-left', t('Show or hide the sidebar')),
    act('theme', 'moon', t('Switch between the light and the dark look')),
    ...s.chats.map((c) => ({ key: `c-${c.id}`, icon: c.pinned ? 'pin' : c.archived ? 'archive' : 'message-square', label: c.title, hint: c.archived ? t('Chat in the archive') : t('Chat'), run: () => go(`#/chat/${c.id}`) })),
  ];
}

export function Palette() {
  const { palette } = useStore();
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const input = useRef(null);
  const list = useRef(null);
  useEffect(() => {
    if (!palette) return;
    setQ('');
    setSel(0);
    setTimeout(() => input.current?.focus(), 20);
  }, [palette]);
  useEffect(() => {
    list.current?.querySelector('.on')?.scrollIntoView({ block: 'nearest' });
  }, [sel]);
  if (!palette) return null;
  const items = filterItems(paletteItems(), q, q ? 14 : 12);
  const at = Math.min(sel, Math.max(0, items.length - 1));
  const close = () => set({ palette: false });
  const run = (it) => {
    close();
    it?.run();
  };
  const onKey = (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (items.length) setSel((at + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length);
    } else if (e.key === 'Enter' && !e.isComposing) {
      e.preventDefault();
      run(items[at]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  };
  return html`<div class="overlay palette-wrap" onMouseDown=${(e) => e.target === e.currentTarget && close()}>
    <div class="palette" role="dialog" aria-label=${t('Command palette')}>
      <div class="palette-in"><${Icon} name="search" /><input ref=${input} placeholder=${t('Find a chat, a page or an action…')} value=${q} onInput=${(e) => { setQ(e.target.value); setSel(0); }} onKeyDown=${onKey} /></div>
      <div class="palette-list" ref=${list} role="listbox">
        ${items.map((it, i) => html`<button key=${it.key} class=${`palette-item ${i === at ? 'on' : ''}`} onMouseEnter=${() => setSel(i)} onClick=${() => run(it)}>
          <${Icon} name=${it.icon} size="sm" /><span class="grow ellipsis">${it.label}</span>${it.hint && html`<span class="faint">${it.hint}</span>`}${it.combo && html`<span class="kbd">${fmtCombo(it.combo, isMac())}</span>`}
        </button>`)}
        ${!items.length && html`<div class="palette-empty">${t('Nothing found')}</div>`}
      </div>
    </div>
  </div>`;
}

// Settings → Keyboard shortcuts: see them, change one by pressing the new keys, turn one off, or put all back.
export function ShortcutSettings() {
  const [saved, setSaved] = useState(savedKeys);
  const [rec, setRec] = useState('');
  const names = NAMES();
  const mac = isMac();
  const keep = (next) => {
    setSaved(next);
    writePref('hearth.keys', next);
  };
  useEffect(() => {
    set({ recordingKey: Boolean(rec) });
    if (!rec) return;
    const onKey = (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') return setRec('');
      const combo = comboOf(e, mac);
      if (!combo) return; // only a modifier so far
      if (!usable(combo)) return toast(t('Use {mod} or Alt together with a key, so the shortcut doesn’t fire while you type.', { mod: mac ? '⌘' : 'Ctrl' }), 'bad');
      const taken = activeShortcuts(saved).find((s) => s.combo === combo && s.id !== rec);
      if (taken) return toast(t('{keys} is already used for “{name}”.', { keys: fmtCombo(combo, mac), name: names[taken.id] }), 'bad');
      keep({ ...saved, [rec]: combo });
      setRec('');
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      set({ recordingKey: false });
    };
  }, [rec, saved]);
  const list = activeShortcuts(saved);
  const changed = list.some((s) => s.combo !== s.standard);
  return html`<div class="section" id="keys"><h2>${t('Keyboard shortcuts')}</h2>
    <p class="sub">${t('They work on every page and with any keyboard layout. They are kept in this browser.')}</p>
    <div class="card">
      ${list.map((s) => html`<div class="set-row" key=${s.id}>
        <div class="lbl"><b>${names[s.id]}</b></div>
        <div class="ctl fit row">
          ${rec === s.id ? html`<span class="kbd rec">${t('Press the keys…')}</span>` : s.combo ? html`<span class="kbd">${fmtCombo(s.combo, mac)}</span>` : html`<span class="faint">${t('Off')}</span>`}
          <button class="btn sm" onClick=${() => setRec(rec === s.id ? '' : s.id)}>${rec === s.id ? t('Cancel') : t('Change')}</button>
          ${s.combo && rec !== s.id && html`<button class="btn sm ghost" title=${t('Turn this shortcut off')} onClick=${() => keep({ ...saved, [s.id]: '' })}><${Icon} name="x" size="sm" /></button>`}
        </div>
      </div>`)}
      ${changed && html`<div class="set-row"><div class="lbl"><span>${t('Some shortcuts were changed.')}</span></div><div class="ctl fit"><button class="btn sm" onClick=${() => keep({})}>${t('Put all back')}</button></div></div>`}
    </div>
  </div>`;
}
