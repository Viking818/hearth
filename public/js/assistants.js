// Assistants (roles with their own instructions, started in one click) and Memory (facts every chat keeps in mind).
import { html, useState, useEffect } from '../vendor/preact-htm.js';
import { Icon } from './icons.js';
import { t, locale } from './i18n.js';
import { useStore, api, toast, toastError, refreshAssistants, set, go, getState } from './store.js';
import { Toggle, confirmDialog, PageHead } from './ui.js';

const ICONS = ['bot', 'mail', 'tag', 'languages', 'megaphone', 'book-open', 'pen-line', 'code', 'image', 'table', 'brain', 'lightbulb', 'user', 'globe', 'sparkle', 'wrench'];

function Editor({ a, onClose }) {
  const [v, setV] = useState({ name: a.name || '', icon: a.icon || 'bot', description: a.description || '', instructions: a.instructions || '', starter: a.starter || '' });
  const [busy, setBusy] = useState(false);
  const field = (k) => (e) => setV({ ...v, [k]: e.target.value });
  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api(`/api/assistants/${a.id || 'new'}`, { method: 'PUT', body: v });
      await refreshAssistants();
      toast(t('Saved'));
      onClose();
    } catch (err) {
      toastError(err);
    }
    setBusy(false);
  };
  return html`<div class="overlay" onMouseDown=${(e) => e.target === e.currentTarget && onClose()}>
    <form class="dialog wide" onSubmit=${save}>
      <h3>${a.id ? t('Edit assistant') : t('New assistant')}</h3>
      <label class="field"><span>${t('Name')}</span><input class="input" value=${v.name} onInput=${field('name')} placeholder=${t('For example: Order status replies')} required /></label>
      <div class="field"><span>${t('Icon')}</span>
        <div class="icon-pick">${ICONS.map((i) => html`<button type="button" class=${v.icon === i ? 'on' : ''} onClick=${() => setV({ ...v, icon: i })}><${Icon} name=${i} /></button>`)}</div>
      </div>
      <label class="field"><span>${t('Short description')}</span><input class="input" value=${v.description} onInput=${field('description')} placeholder=${t('One line, shown in the list')} /></label>
      <label class="field"><span>${t('Instructions')}</span>
        <textarea class="textarea" style="min-height:180px" value=${v.instructions} onInput=${field('instructions')} placeholder=${t('Who the assistant is, what it does, the tone, the format of its answers, what it must never do…')}></textarea></label>
      <label class="field"><span>${t('Hint for a new chat')}</span><input class="input" value=${v.starter} onInput=${field('starter')} placeholder=${t('For example: Paste the customer’s message.')} /></label>
      <div class="row" style="justify-content:flex-end">
        <button type="button" class="btn" onClick=${onClose}>${t('Cancel')}</button>
        <button class="btn primary" disabled=${busy || !v.name.trim()}>${t('Save')}</button>
      </div>
    </form>
  </div>`;
}

function Assistants() {
  const { assistants } = useStore();
  const [edit, setEdit] = useState(null);
  const start = (a) => {
    set({ newChatAssistant: a.id, newChatTick: Date.now() });
    go('#/');
  };
  const del = async (a) => {
    if (!(await confirmDialog({ title: t('Delete “{name}”?', { name: a.name }), text: a.builtin ? t('You can bring the built-in assistants back later.') : t('Its chats stay; they just become plain chats.'), ok: t('Delete'), danger: true }))) return;
    await api(`/api/assistants/${a.id}`, { method: 'DELETE' }).catch(toastError);
    refreshAssistants();
  };
  const reset = async () => {
    if (!(await confirmDialog({ title: t('Bring back the built-in assistants?'), text: t('Your changes to them are undone. Assistants you made yourself stay.'), ok: t('Bring back') }))) return;
    await api('/api/assistants/reset', { method: 'POST' }).catch(toastError);
    refreshAssistants();
  };
  return html`<div>
    <div class="row wrap" style="justify-content:space-between;margin-bottom:14px">
      <p class="muted" style="margin:0;max-width:640px">${t('An assistant is a saved role: its instructions go with every message of its chats. Pick one when you start a chat, or from the button under the message box.')}</p>
      <div class="row"><button class="btn" onClick=${reset}><${Icon} name="rotate-ccw" size="sm" /> ${t('Built-in ones')}</button><button class="btn primary" onClick=${() => setEdit({})}><${Icon} name="plus" size="sm" /> ${t('New assistant')}</button></div>
    </div>
    <div class="grid c3">
      ${assistants.map(
        (a) => html`<div class="card acard" key=${a.id}>
          <div class="row" style="gap:12px;align-items:flex-start">
            <span class="a-icon"><${Icon} name=${a.icon} /></span>
            <div class="grow" style="min-width:0"><h3>${a.name}</h3><p>${a.description}</p></div>
          </div>
          <div class="actions">
            <button class="btn sm primary" onClick=${() => start(a)}><${Icon} name="message-square" size="sm" /> ${t('Start a chat')}</button>
            <span class="grow"></span>
            <button class="icon-btn" title=${t('Edit')} onClick=${() => setEdit(a)}><${Icon} name="pencil" size="sm" /></button>
            <button class="icon-btn" title=${t('Delete')} onClick=${() => del(a)}><${Icon} name="trash" size="sm" /></button>
          </div>
        </div>`,
      )}
    </div>
    ${edit && html`<${Editor} a=${edit} onClose=${() => setEdit(null)} />`}
  </div>`;
}

function Memory() {
  const { status } = useStore();
  const [facts, setFacts] = useState(null);
  const [text, setText] = useState('');
  const [editing, setEditing] = useState(null); // {id, text}
  const load = () => api('/api/memory').then((r) => setFacts(r.facts)).catch(toastError);
  useEffect(() => {
    load();
  }, []);
  const on = status?.settings?.memoryOn !== false;
  const toggle = async (v) => {
    const next = await api('/api/settings', { method: 'PUT', body: { memoryOn: v } });
    set({ status: { ...getState().status, settings: next } });
  };
  const add = async (e) => {
    e.preventDefault();
    if (!text.trim()) return;
    try {
      await api('/api/memory', { method: 'POST', body: { text } });
      setText('');
      load();
    } catch (err) {
      toastError(err);
    }
  };
  const saveEdit = async () => {
    await api(`/api/memory/${editing.id}`, { method: 'PUT', body: { text: editing.text } }).catch(toastError);
    setEditing(null);
    load();
  };
  const del = async (f) => {
    await api(`/api/memory/${f.id}`, { method: 'DELETE' }).catch(toastError);
    load();
  };
  const clear = async () => {
    if (!(await confirmDialog({ title: t('Forget everything?'), text: t('All facts are removed from Memory.'), ok: t('Forget all'), danger: true }))) return;
    await api('/api/memory', { method: 'DELETE' }).catch(toastError);
    load();
  };
  return html`<div class="col" style="gap:14px">
    <div class="card">
      <div class="set-row"><div class="lbl"><b>${t('Use Memory in chats')}</b><span>${t('Every chat sees these facts. With tools on, say “remember that…” in a chat and the model adds the fact itself.')}</span></div><div class="ctl fit"><${Toggle} on=${on} onChange=${toggle} /></div></div>
    </div>
    <form class="row" onSubmit=${add}>
      <input class="input" value=${text} onInput=${(e) => setText(e.target.value)} placeholder=${t('For example: My shop is called “Print Lab”; I sell printed T-shirts and hoodies.')} />
      <button class="btn primary" disabled=${!text.trim()}><${Icon} name="plus" size="sm" /> ${t('Add')}</button>
    </form>
    <div class="card list">
      ${facts == null
        ? html`<div class="empty"><${Icon} name="loader" cls="spin" /></div>`
        : !facts.length
          ? html`<div class="empty">${t('Nothing remembered yet.')}</div>`
          : facts.map((f) =>
              editing?.id === f.id
                ? html`<div class="list-row" key=${f.id}><input class="input grow" value=${editing.text} onInput=${(e) => setEditing({ ...editing, text: e.target.value })} /><button class="btn sm primary" onClick=${saveEdit}>${t('Save')}</button><button class="btn sm" onClick=${() => setEditing(null)}>${t('Cancel')}</button></div>`
                : html`<div class="list-row" key=${f.id}>
                    <${Icon} name="brain" size="sm" cls="muted" />
                    <span class="grow">${f.text}</span>
                    <span class="faint" style="font-size:12.5px">${new Date(f.at).toLocaleDateString(locale())}</span>
                    <button class="icon-btn" title=${t('Edit')} onClick=${() => setEditing({ id: f.id, text: f.text })}><${Icon} name="pencil" size="sm" /></button>
                    <button class="icon-btn" title=${t('Forget')} onClick=${() => del(f)}><${Icon} name="trash" size="sm" /></button>
                  </div>`,
            )}
    </div>
    ${facts?.length > 0 && html`<div><button class="btn sm danger" onClick=${clear}>${t('Forget all')}</button></div>`}
  </div>`;
}

export function AssistantsPage({ route }) {
  const tab = route?.id === 'memory' ? 'memory' : 'assistants';
  useEffect(() => {
    refreshAssistants();
  }, []);
  return html`<div class="page"><div class="page-inner">
    <${PageHead} title=${t('Assistants & memory')} text=${t('Ready-made roles for everyday work, and what Hearth remembers about you.')} />
    <div class="tabs">
      <button class=${tab === 'assistants' ? 'on' : ''} onClick=${() => go('#/assistants')}><${Icon} name="bot" size="sm" /> ${t('Assistants')}</button>
      <button class=${tab === 'memory' ? 'on' : ''} onClick=${() => go('#/assistants/memory')}><${Icon} name="brain" size="sm" /> ${t('Memory')}</button>
    </div>
    ${tab === 'memory' ? html`<${Memory} />` : html`<${Assistants} />`}
  </div></div>`;
}
