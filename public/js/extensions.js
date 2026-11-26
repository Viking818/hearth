// Customize (the Extensions page): connectors (MCP servers), skills, plugins and commands, in Claude's formats.
// Connectors come with a directory of well-known services and their logos, connected in a click; skills and plugins
// come from a GitHub link or a .zip file; skills and commands can also be written here.
import { html, useState, useEffect, useRef } from '../vendor/preact-htm.js';
import { Icon } from './icons.js';
import { t, tn, locale } from './i18n.js';
import { useStore, api, toast, toastError, go, set, getState, refreshAssistants } from './store.js';
import { Toggle, confirmDialog, PageHead } from './ui.js';
import { renderMarkdown } from './md.js';

const isLocal = () => /^(127\.0\.0\.1|localhost|\[::1\])$/.test(location.hostname);
const TABS = () => [
  ['connectors', 'plug', t('Connectors')],
  ['skills', 'sparkles', t('Skills')],
  ['plugins', 'puzzle', t('Plugins')],
  ['commands', 'terminal', t('Commands')],
];

// ---------------- Logos ----------------

// A service's logo on a white tile (logos are made for light backgrounds), or a plain icon when there is none.
function Logo({ src, icon = 'plug', size = '' }) {
  return html`<span class=${`logo-tile ${size}`}>${src ? html`<img src=${`/brands/${src}`} alt="" loading="lazy" />` : html`<${Icon} name=${icon} />`}</span>`;
}

// The directory entry something belongs to: the same address, or a word of its name is the service (slack-by-salesforce).
function dirEntry(dir, { name = '', url = '' } = {}) {
  if (!dir) return null;
  const byUrl = url && dir.items.find((d) => d.url === url);
  if (byUrl) return byUrl;
  const words = String(name).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  return dir.items.find((d) => words.includes(d.id) || words.includes(d.name.toLowerCase())) || null;
}

// Where something came from, in a few words.
function sourceLabel(src) {
  if (!src || src === 'own') return t('Yours');
  if (src.startsWith('github:')) return `GitHub · ${src.slice(7).split('#')[0]}`;
  if (src.startsWith('file:')) return src.slice(5);
  if (src.startsWith('folder:')) return t('Folder on this computer');
  return src;
}

// Split a typed command line like a shell does: "quoted parts" stay together.
const splitLine = (s) => (String(s).match(/"[^"]*"|'[^']*'|\S+/g) || []).map((a) => a.replace(/^["']|["']$/g, ''));

// ---------------- Adding from GitHub or a file ----------------

function AddBar({ onPreview, kind }) {
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const file = useRef(null);
  if (!isLocal()) return html`<div class="notice"><${Icon} name="info" /><div>${t('Skills, plugins and connectors can be added on the computer itself.')}</div></div>`;
  const look = async (body, raw, name) => {
    setBusy(true);
    try {
      const r = raw
        ? await api('/api/extensions/inspect', { method: 'POST', raw, headers: { 'content-type': 'application/zip', 'x-file-name': encodeURIComponent(name) } })
        : await api('/api/extensions/inspect', { method: 'POST', body });
      onPreview(r);
      setUrl('');
    } catch (err) {
      toastError(err);
    }
    setBusy(false);
  };
  return html`<div class="card ext-add">
    <form class="row wrap" onSubmit=${(e) => { e.preventDefault(); if (url.trim()) look({ url: url.trim() }); }}>
      <${Icon} name="link" cls="muted" />
      <input class="input grow" value=${url} onInput=${(e) => setUrl(e.target.value)} placeholder=${kind === 'plugins' ? t('GitHub link to a plugin or a collection, e.g. github.com/anthropics/claude-plugins-official') : t('GitHub link to a skill or a collection, e.g. github.com/anthropics/skills')} disabled=${busy} />
      <button class="btn primary" disabled=${busy || !url.trim()}>${busy ? html`<${Icon} name="loader" cls="spin" size="sm" />` : html`<${Icon} name="search" size="sm" />`} ${busy ? t('Looking inside…') : t('Look inside')}</button>
      <button type="button" class="btn" disabled=${busy} onClick=${() => file.current.click()}><${Icon} name="upload" size="sm" /> ${t('Add a .zip file')}</button>
      <input ref=${file} type="file" hidden accept=".zip,.skill,.plugin" onChange=${(e) => { const f = e.target.files[0]; e.target.value = ''; if (f) look(null, f, f.name); }} />
    </form>
    <div class="faint ext-hint">${t('Works with Claude’s skills (folders with SKILL.md) and Claude Code plugins. Install only from sources you trust: a skill’s instructions go to the model.')}</div>
  </div>`;
}

function Parts({ p }) {
  const bits = [];
  if (p.skills) bits.push(tn(p.skills, '{n} skill', '{n} skills'));
  if (p.commands) bits.push(tn(p.commands, '{n} command', '{n} commands'));
  if (p.agents) bits.push(tn(p.agents, '{n} assistant', '{n} assistants'));
  if (p.connectors) bits.push(tn(p.connectors, '{n} connector', '{n} connectors'));
  return bits.length ? html`<span class="faint">${bits.join(' · ')}</span>` : null;
}

function InstallDialog({ found, onClose, onDone }) {
  const all = found.kind === 'skills' ? found.skills.map((s) => s.name) : found.kind === 'marketplace' ? found.plugins.filter((p) => p.available).map((p) => p.name) : [];
  const [pick, setPick] = useState(found.kind === 'marketplace' && all.length > 1 ? [] : all);
  const [busy, setBusy] = useState(false);
  const [q, setQ] = useState('');
  const flip = (n) => setPick((x) => (x.includes(n) ? x.filter((y) => y !== n) : [...x, n]));
  const go2 = async () => {
    setBusy(true);
    try {
      const r = await api('/api/extensions/install', { method: 'POST', body: { token: found.token, pick } });
      const n = r.installed.skills.length + r.installed.plugins.length;
      toast(r.installed.plugins.length ? tn(n, 'Installed {n} plugin', 'Installed {n} plugins') : tn(n, 'Installed {n} skill', 'Installed {n} skills'));
      refreshAssistants();
      onDone(r, r.installed.plugins.length ? 'plugins' : 'skills');
    } catch (err) {
      toastError(err);
      setBusy(false);
    }
  };
  const p = found.plugin;
  let body;
  let label;
  if (found.kind === 'skills') {
    label = tn(pick.length, 'Install {n} skill', 'Install {n} skills');
    body = html`<div class="ext-pick">${found.skills.map((s) => html`<label class="ext-pick-row" key=${s.name}>
      <input type="checkbox" checked=${pick.includes(s.name)} onChange=${() => flip(s.name)} />
      <div><b>${s.name}</b><div class="muted">${s.description || t('No description')}</div></div>
    </label>`)}</div>`;
  } else if (found.kind === 'plugin') {
    label = t('Install the plugin');
    body = html`<div class="col" style="gap:10px">
      <div><b>${p.name}</b>${p.version && html` <span class="badge">${p.version}</span>`}${p.author && html` <span class="faint">· ${p.author}</span>`}<div class="muted">${p.description}</div></div>
      ${p.skills.length > 0 && html`<div><div class="ext-sub">${t('Skills')}</div>${p.skills.map((s) => html`<div class="ext-li"><${Icon} name="sparkles" size="sm" /> <b>${s.name}</b> <span class="muted">${s.description}</span></div>`)}</div>`}
      ${p.commands.length > 0 && html`<div><div class="ext-sub">${t('Commands')}</div><div class="ext-li">${p.commands.map((c) => html`<code>/${c}</code> `)}</div></div>`}
      ${p.agents.length > 0 && html`<div><div class="ext-sub">${t('Assistants')}</div><div class="ext-li">${p.agents.join(', ')}</div></div>`}
      ${p.connectors.length > 0 && html`<div><div class="ext-sub">${t('Connectors')}</div>
        ${p.connectors.map((c) => html`<div class="conn-line"><${Icon} name=${c.kind === 'http' ? 'globe' : 'terminal'} size="sm" /><b>${c.name}</b><code class="faint" title=${c.what}>${c.what}</code></div>`)}
        <div class="notice warn" style="margin-top:6px"><${Icon} name="shield" /><div>${t('Connectors start programs on this computer or talk to websites. They stay off until you turn each one on in Connectors.')}</div></div>
      </div>`}
      ${p.hooks && html`<div class="faint">${t('This plugin also has hooks (automatic actions for Claude Code). Hearth doesn’t use them.')}</div>`}
      ${!p.skills.length && !p.commands.length && !p.agents.length && !p.connectors.length && html`<div class="muted">${t('This plugin has nothing Hearth can use.')}</div>`}
    </div>`;
  } else {
    label = tn(pick.length, 'Install {n} plugin', 'Install {n} plugins');
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    const shown = found.plugins.filter((x) => pick.includes(x.name) || words.every((w) => `${x.name} ${x.description} ${x.category}`.toLowerCase().includes(w)));
    body = html`<div class="col" style="gap:8px">
      ${(found.name || found.description) && html`<div><b>${found.name}</b><div class="muted">${found.description}</div></div>`}
      ${found.plugins.length > 12 && html`<input class="input" value=${q} onInput=${(e) => setQ(e.target.value)} placeholder=${t('Search {n} plugins…', { n: found.plugins.length })} />`}
      <div class="ext-pick">${shown.map((x) => html`<label class=${`ext-pick-row ${x.available ? '' : 'off'}`} key=${x.name}>
        <input type="checkbox" disabled=${!x.available} checked=${pick.includes(x.name)} onChange=${() => flip(x.name)} />
        <div class="grow"><b>${x.name}</b>${x.category && html` <span class="badge">${x.category}</span>`}
          <div class="muted">${x.description}</div>
          ${x.parts ? html`<${Parts} p=${x.parts} />` : x.remote ? html`<span class="faint">${t('From another GitHub repository')}</span>` : html`<span class="faint">${t('Can’t be downloaded by Hearth')}</span>`}
        </div>
      </label>`)}</div>
    </div>`;
  }
  return html`<div class="overlay" onMouseDown=${(e) => e.target === e.currentTarget && !busy && onClose()}>
    <div class="dialog wide ext-dialog">
      <h3>${found.kind === 'marketplace' ? t('A collection of plugins') : found.kind === 'plugin' ? t('A plugin') : tn(found.skills.length, '{n} skill found', '{n} skills found')}</h3>
      <div class="faint" style="margin:-4px 0 12px">${t('From')}: ${sourceLabel(found.source)}</div>
      <div class="ext-dialog-body">${body}</div>
      <div class="row" style="justify-content:flex-end;margin-top:16px">
        <button class="btn" disabled=${busy} onClick=${onClose}>${t('Cancel')}</button>
        <button class="btn primary" disabled=${busy || (found.kind !== 'plugin' && !pick.length)} onClick=${go2}>${busy ? html`<${Icon} name="loader" cls="spin" size="sm" />` : html`<${Icon} name="download" size="sm" />`} ${label}</button>
      </div>
    </div>
  </div>`;
}

// ---------------- Skills ----------------

function SkillEditor({ skill, onClose, onSaved }) {
  const [v, setV] = useState({ name: skill?.name || '', description: skill?.description || '', instructions: skill?.body || '' });
  const [busy, setBusy] = useState(false);
  const field = (k) => (e) => setV({ ...v, [k]: e.target.value });
  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      const r = skill ? await api(`/api/skills/${encodeURIComponent(skill.id)}`, { method: 'PUT', body: v }) : await api('/api/skills', { method: 'POST', body: v });
      toast(t('Saved'));
      onSaved(r);
    } catch (err) {
      toastError(err);
    }
    setBusy(false);
  };
  return html`<div class="overlay" onMouseDown=${(e) => e.target === e.currentTarget && onClose()}>
    <form class="dialog wide" onSubmit=${save}>
      <h3>${skill ? t('Edit skill') : t('New skill')}</h3>
      <p class="muted" style="margin:0 0 12px">${t('A skill is instructions for one kind of task. The model reads the description to decide when to use it, so say clearly when it fits.')}</p>
      <label class="field"><span>${t('Name')}</span><input class="input" value=${v.name} onInput=${field('name')} placeholder=${t('For example: product-cards')} required /></label>
      <label class="field"><span>${t('When to use it')}</span><input class="input" value=${v.description} onInput=${field('description')} placeholder=${t('For example: Use when writing product cards for the online shop (title, description, tags).')} required /></label>
      <label class="field"><span>${t('Instructions')}</span>
        <textarea class="textarea mono" style="min-height:240px;font-size:13px" value=${v.instructions} onInput=${field('instructions')} placeholder=${t('Steps, rules, the format of the answer, examples… Markdown works.')}></textarea></label>
      <div class="row" style="justify-content:flex-end">
        <button type="button" class="btn" onClick=${onClose}>${t('Cancel')}</button>
        <button class="btn primary" disabled=${busy || !v.name.trim() || !v.description.trim() || !v.instructions.trim()}>${t('Save')}</button>
      </div>
    </form>
  </div>`;
}

function SkillViewer({ id, onClose, onEdit }) {
  const [s, setS] = useState(null);
  useEffect(() => {
    api(`/api/skills/${encodeURIComponent(id)}`).then(setS).catch((err) => (toastError(err), onClose()));
  }, [id]);
  return html`<div class="overlay" onMouseDown=${(e) => e.target === e.currentTarget && onClose()}>
    <div class="dialog wide ext-dialog">
      ${!s
        ? html`<div class="empty"><${Icon} name="loader" cls="spin" /></div>`
        : html`<h3><${Icon} name="sparkles" size="sm" /> ${s.name}</h3>
          <div class="muted" style="margin-bottom:8px">${s.description}</div>
          <div class="row wrap" style="gap:6px;margin-bottom:12px">
            <span class="badge">${s.plugin ? t('Plugin: {name}', { name: s.pluginName }) : sourceLabel(s.source)}</span>
            ${s.files.length > 0 && html`<span class="badge">${tn(s.files.length, '{n} more file', '{n} more files')}</span>`}
            ${s.license && html`<span class="badge">${s.license.length > 40 ? t('License inside') : s.license}</span>`}
          </div>
          ${s.scripts > 0 && html`<div class="notice" style="margin-bottom:12px"><${Icon} name="info" /><div>${t('This skill has scripts. Hearth shows them to the model but never runs them, so steps that need them may not work.')}</div></div>`}
          <div class="ext-dialog-body"><div class="md" dangerouslySetInnerHTML=${{ __html: renderMarkdown(s.body).html }}></div>
            ${s.files.length > 0 && html`<details style="margin-top:12px"><summary class="muted">${t('Files')}</summary><div class="mono faint" style="font-size:12.5px;white-space:pre-wrap">${s.files.join('\n')}</div></details>`}
          </div>
          <div class="row" style="justify-content:flex-end;margin-top:14px">
            ${s.editable && html`<button class="btn" onClick=${() => onEdit(s)}><${Icon} name="pencil" size="sm" /> ${t('Edit')}</button>`}
            <button class="btn primary" onClick=${onClose}>${t('Close')}</button>
          </div>`}
    </div>
  </div>`;
}

function Skills({ data, reload, setData, onPreview }) {
  const [q, setQ] = useState('');
  const [view, setView] = useState('');
  const [edit, setEdit] = useState(null); // null, {} for new, or the skill
  const toggle = async (s, on) => setData(await api(`/api/skills/${encodeURIComponent(s.id)}`, { method: 'PUT', body: { enabled: on } }).catch(toastError));
  const del = async (s) => {
    if (!(await confirmDialog({ title: t('Delete the skill “{name}”?', { name: s.name }), text: s.source === 'own' ? t('Its instructions are deleted from this computer.') : t('You can install it again later.'), ok: t('Delete'), danger: true }))) return;
    setData(await api(`/api/skills/${encodeURIComponent(s.id)}`, { method: 'DELETE' }).catch(toastError));
  };
  const openEdit = async (s) => {
    setView('');
    setEdit(s.body !== undefined ? s : await api(`/api/skills/${encodeURIComponent(s.id)}`).catch(toastError));
  };
  return html`<div class="col" style="gap:14px">
    <${AddBar} kind="skills" onPreview=${onPreview} />
    <div class="row wrap" style="justify-content:space-between">
      <p class="muted" style="margin:0;max-width:640px">${t('With tools on, the model sees each skill’s name and description and reads the skill when a task fits. You can also switch a skill on in a chat: type / and its name.')}</p>
      <button class="btn primary" onClick=${() => setEdit({})}><${Icon} name="plus" size="sm" /> ${t('New skill')}</button>
    </div>
    ${data.skills.length > 12 && html`<label class="search-box"><${Icon} name="search" size="sm" /><input placeholder=${t('Search skills')} value=${q} onInput=${(e) => setQ(e.target.value)} /></label>`}
    ${data.skills.length
      ? html`<div class="grid c3">${data.skills.filter((s) => !q || `${s.name} ${s.description} ${s.pluginName || ''}`.toLowerCase().includes(q.toLowerCase())).map(
          (s) => html`<div class=${`card acard ${s.enabled ? '' : 'dim'}`} key=${s.id}>
            <div class="row" style="gap:12px;align-items:flex-start">
              <span class="a-icon"><${Icon} name="sparkles" /></span>
              <div class="grow" style="min-width:0"><h3 class="ellipsis">${s.name}</h3><p class="clamp3">${s.description || t('No description')}</p></div>
            </div>
            <div class="row wrap" style="gap:6px">
              <span class="badge">${s.plugin ? t('Plugin: {name}', { name: s.pluginName }) : sourceLabel(s.source)}</span>
              ${s.scripts > 0 && html`<span class="badge warn" title=${t('Hearth never runs a skill’s scripts.')}>${t('has scripts')}</span>`}
            </div>
            <div class="actions">
              <${Toggle} on=${s.enabled} onChange=${(v) => toggle(s, v)} />
              <span class="grow"></span>
              <button class="icon-btn" title=${t('Open')} onClick=${() => setView(s.id)}><${Icon} name="eye" size="sm" /></button>
              ${s.editable && html`<button class="icon-btn" title=${t('Edit')} onClick=${() => openEdit(s)}><${Icon} name="pencil" size="sm" /></button>`}
              ${!s.plugin && html`<button class="icon-btn" title=${t('Delete')} onClick=${() => del(s)}><${Icon} name="trash" size="sm" /></button>`}
            </div>
          </div>`,
        )}</div>`
      : html`<div class="card empty">${t('No skills yet. Write your own, or add ready-made ones from GitHub: for example github.com/anthropics/skills.')}</div>`}
    ${view && html`<${SkillViewer} id=${view} onClose=${() => setView('')} onEdit=${openEdit} />`}
    ${edit && html`<${SkillEditor} skill=${edit.id ? edit : null} onClose=${() => setEdit(null)} onSaved=${() => (setEdit(null), reload())} />`}
  </div>`;
}

// ---------------- Plugins ----------------

function PluginCard({ p, setData, server, dir }) {
  const [open, setOpen] = useState(false);
  const [vals, setVals] = useState({});
  const upd = async (body) => setData(await api(`/api/plugins/${encodeURIComponent(p.id)}`, { method: 'PUT', body }).catch(toastError));
  const remove = async () => {
    if (!(await confirmDialog({ title: t('Remove the plugin “{name}”?', { name: p.name }), text: t('Its skills, commands, assistants and connectors go too. You can install it again later.'), ok: t('Remove'), danger: true }))) return;
    setData(await api(`/api/plugins/${encodeURIComponent(p.id)}`, { method: 'DELETE' }).catch(toastError));
    refreshAssistants();
  };
  const needs = [...new Set(p.connectors.flatMap((c) => c.needs))];
  const saveVals = async () => {
    await upd({ values: vals });
    setVals({});
    toast(t('Saved'));
  };
  const brand = dirEntry(dir, { name: p.name });
  return html`<div class=${`card ext-plugin ${p.enabled ? '' : 'dim'}`}>
    <div class="row" style="gap:12px;align-items:flex-start">
      ${brand ? html`<${Logo} src=${brand.logo} />` : html`<span class="a-icon"><${Icon} name="puzzle" /></span>`}
      <div class="grow" style="min-width:0">
        <h3 style="margin:0;font-size:15.5px">${p.name} ${p.version && html`<span class="badge">${p.version}</span>`}</h3>
        <p class="muted" style="margin:3px 0 0;font-size:13.5px">${p.description}</p>
        <div class="row wrap faint" style="gap:10px;margin-top:6px;font-size:12.5px">
          <span>${sourceLabel(p.source)}</span>${p.author && html`<span>${p.author}</span>`}
          <${Parts} p=${{ skills: p.skills.length, commands: p.commands.length, agents: p.agents.length, connectors: p.connectors.length }} />
        </div>
      </div>
      <${Toggle} on=${p.enabled} onChange=${(v) => upd({ enabled: v }).then(refreshAssistants)} />
    </div>
    <div class="row" style="gap:6px">
      <button class="btn sm" onClick=${() => setOpen(!open)}><${Icon} name=${open ? 'chevron-up' : 'chevron-down'} size="sm" /> ${open ? t('Hide') : t('What’s inside')}</button>
      <span class="grow"></span>
      ${isLocal() && html`<button class="btn sm danger" onClick=${remove}><${Icon} name="trash" size="sm" /> ${t('Remove')}</button>`}
    </div>
    ${open && html`<div class="col" style="gap:10px">
      ${p.skills.length > 0 && html`<div><div class="ext-sub">${t('Skills')}</div><div class="ext-li">${p.skills.join(', ')}</div></div>`}
      ${p.commands.length > 0 && html`<div><div class="ext-sub">${t('Commands')}</div><div class="ext-li">${p.commands.map((c) => html`<code>/${c}</code> `)}</div></div>`}
      ${p.agents.length > 0 && html`<div><div class="ext-sub">${t('Assistants')}</div><div class="ext-li">${p.agents.join(', ')}</div></div>`}
      ${p.connectors.length > 0 && html`<div><div class="ext-sub">${t('Connectors')}</div>
        ${p.connectors.map((c) => {
          const missing = c.needs.filter((n) => !p.values[n]);
          const st = server(`${p.id}:${c.name}`);
          return html`<div class="ext-conn" key=${c.name}>
            <${Icon} name=${c.kind === 'http' ? 'globe' : 'terminal'} size="sm" />
            <div class="grow" style="min-width:0"><div class="conn-line"><b>${c.name}</b><code class="faint" title=${c.what}>${c.what}</code></div>
              <${ConnStatus} name=${`${p.id}:${c.name}`} on=${c.on && p.enabled} st=${st} missing=${missing} setData=${setData} />
            </div>
            <${Toggle} on=${c.on} disabled=${!isLocal()} onChange=${(v) => upd({ connector: c.name, connectorOn: v })} />
          </div>`;
        })}
        ${needs.length > 0 && isLocal() && html`<div class="col" style="gap:6px;margin-top:8px">
          <div class="faint">${t('Values the connectors need (keys and tokens stay on this computer):')}</div>
          ${needs.map((n) => html`<div class="row"><code style="min-width:200px">${n}</code><input class="input" type="password" placeholder=${p.values[n] ? `•••••••• (${t('saved')})` : t('Paste the value')} value=${vals[n] || ''} onInput=${(e) => setVals({ ...vals, [n]: e.target.value })} /></div>`)}
          <div><button class="btn sm primary" disabled=${!Object.values(vals).some(Boolean)} onClick=${saveVals}>${t('Save')}</button></div>
        </div>`}
      </div>`}
      ${p.hooks && html`<div class="faint">${t('This plugin also has hooks (automatic actions for Claude Code). Hearth doesn’t use them.')}</div>`}
    </div>`}
  </div>`;
}

function ConnStatus({ name, on, st, missing = [], setData }) {
  if (missing.length) return html`<div class="conn-st warn">${t('Needs {names}', { names: missing.join(', ') })}</div>`;
  if (!on) return html`<div class="conn-st faint">${t('Off')}</div>`;
  if (!st || st.status === 'starting' || st.status === 'stopped') return html`<div class="conn-st muted"><${Icon} name="loader" cls="spin" size="sm" /> ${t('Connecting…')}</div>`;
  if (st.status === 'signin') return html`<${SignIn} name=${name} st=${st} setData=${setData} />`;
  const signedIn = st.auth?.signedIn && html`<${SignedIn} name=${name} st=${st} setData=${setData} />`;
  if (st.status === 'error') return html`<div class="conn-st bad">${st.error}</div>${signedIn}`;
  return html`<div class="conn-st ok">${st.tools.length ? tn(st.tools.length, '{n} tool', '{n} tools') + `: ${st.tools.slice(0, 8).join(', ')}${st.tools.length > 8 ? '…' : ''}` : t('no tools')}</div>${signedIn}`;
}

// A connector that is a web service the user signs in to (Notion, Linear…): its own sign-in page opens in the
// browser, and the row updates when the browser comes back. Only on the computer itself.
const reloadInto = (setData) => api('/api/extensions').then(setData).catch(() => {});

function SignIn({ name, st, setData }) {
  const [busy, setBusy] = useState(false);
  const [link, setLink] = useState('');
  const a = st.auth || {};
  if (!isLocal()) return html`<div class="conn-st warn">${t('Sign in on the computer Hearth runs on.')}</div>`;
  const start = async () => {
    setBusy(true);
    try {
      const r = await api(`/api/connectors/${encodeURIComponent(name)}/signin`, { method: 'POST' });
      setLink(r.url);
      setData(r);
    } catch (err) {
      toastError(err);
      reloadInto(setData);
    }
    setBusy(false);
  };
  if (a.pending)
    return html`<div class="conn-st muted"><${Icon} name="loader" cls="spin" size="sm" /> ${t('Finish signing in in your browser…')}
      ${link ? html`<a href=${link} target="_blank" rel="noopener">${t('Open the page again')}</a>` : html`<button class="link-btn" onClick=${start}>${t('Open the page again')}</button>`}</div>`;
  return html`<div class=${`conn-st ${a.error ? 'bad' : 'warn'}`}><span>${a.error || t('Sign in to use this connector.')}</span>
    ${a.canSignIn !== false && html`<button class="btn sm primary" disabled=${busy} onClick=${start}><${Icon} name=${busy ? 'loader' : 'key'} cls=${busy ? 'spin' : ''} size="sm" /> ${t('Sign in')}</button>`}</div>
    ${a.canSignIn === false && html`<${TokenBox} name=${name} st=${st} setData=${setData} />`}`;
}

// Where to get a token, for services known to take one in place of a sign-in.
const TOKEN_PAGES = { 'github.com': 'https://github.com/settings/personal-access-tokens/new' };

// For a service Hearth can't sign in to: paste an access token from it instead. It goes to the server and stays there.
function TokenBox({ name, st, setData }) {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const page = TOKEN_PAGES[st.auth.service];
  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      setData(await api(`/api/connectors/${encodeURIComponent(name)}/token`, { method: 'POST', body: { token: value } }));
      setValue('');
      toast(t('Saved'));
    } catch (err) {
      toastError(err);
    }
    setBusy(false);
  };
  return html`<form class="conn-token" onSubmit=${save}>
    <div class="faint">${t('If the service gives you an access token, paste it here instead.')}${page && html` <a href=${page} target="_blank" rel="noopener">${t('Create a token')}</a>`}</div>
    <div class="row"><input class="input" type="password" autocomplete="off" spellcheck="false" value=${value} onInput=${(e) => setValue(e.target.value)} placeholder=${t('Paste the token')} />
      <button class="btn sm primary" disabled=${busy || !value.trim()}>${t('Save')}</button></div>
  </form>`;
}

function SignedIn({ name, st, setData }) {
  const { service, token } = st.auth;
  const out = async () => {
    const ask = token
      ? { title: t('Remove the token for {service}?', { service }), text: t('Hearth forgets the token. Connectors to this service stop working until you add one again. The token itself stays valid until you delete it on the service’s site.'), ok: t('Remove') }
      : { title: t('Sign out of {service}?', { service }), text: t('Hearth forgets this sign-in. Connectors to this service stop working until you sign in again.'), ok: t('Sign out') };
    if (!(await confirmDialog(ask))) return;
    try {
      setData(await api(`/api/connectors/${encodeURIComponent(name)}/signout`, { method: 'POST' }));
      toast(token ? t('Token removed') : t('Signed out'));
    } catch (err) {
      toastError(err);
    }
  };
  return html`<div class="conn-st faint"><${Icon} name="check" size="sm" /> ${token ? t('Using your token for {service}', { service }) : t('Signed in to {service}', { service })}${isLocal() && html` · <button class="link-btn" onClick=${out}>${token ? t('Remove') : t('Sign out')}</button>`}</div>`;
}

function Plugins({ data, setData, onPreview, dir }) {
  const server = (name) => data.servers.find((x) => x.name === name);
  return html`<div class="col" style="gap:14px">
    <${AddBar} kind="plugins" onPreview=${onPreview} />
    <p class="muted" style="margin:0;max-width:680px">${t('A plugin bundles skills, commands, assistants and connectors. Hearth reads Claude Code plugins; parts made only for programming in Claude Code may not be useful here.')}</p>
    ${data.plugins.length
      ? data.plugins.map((p) => html`<${PluginCard} key=${p.id} p=${p} setData=${setData} server=${server} dir=${dir} />`)
      : html`<div class="card empty">${t('No plugins yet. Paste a GitHub link above: for example github.com/anthropics/skills (a collection) or a plugin’s own repository.')}</div>`}
  </div>`;
}

// ---------------- Commands ----------------

function CommandEditor({ c, onClose, setData }) {
  const [v, setV] = useState({ name: c?.name || '', description: c?.description || '', prompt: c?.prompt || '' });
  const [busy, setBusy] = useState(false);
  const field = (k) => (e) => setV({ ...v, [k]: e.target.value });
  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      setData(c ? await api(`/api/commands/${encodeURIComponent(c.id)}`, { method: 'PUT', body: v }) : await api('/api/commands', { method: 'POST', body: v }));
      toast(t('Saved'));
      onClose();
    } catch (err) {
      toastError(err);
    }
    setBusy(false);
  };
  return html`<div class="overlay" onMouseDown=${(e) => e.target === e.currentTarget && onClose()}>
    <form class="dialog wide" onSubmit=${save}>
      <h3>${c ? t('Edit command') : t('New command')}</h3>
      <label class="field"><span>${t('Name (you type it after /)')}</span><div class="row"><b style="font-size:18px">/</b><input class="input" value=${v.name} onInput=${field('name')} placeholder=${t('for example: card')} required /></div></label>
      <label class="field"><span>${t('Short description')}</span><input class="input" value=${v.description} onInput=${field('description')} placeholder=${t('Shown in the / menu')} /></label>
      <label class="field"><span>${t('What to ask the model')}</span>
        <textarea class="textarea" style="min-height:180px" value=${v.prompt} onInput=${field('prompt')} placeholder=${t('For example: Write a product card for $ARGUMENTS: a title, 3 sentences and 10 tags.')}></textarea></label>
      <p class="faint" style="margin:0 0 14px">${t('$ARGUMENTS is replaced by what you type after the name; without it, that text is added at the end.')}</p>
      <div class="row" style="justify-content:flex-end">
        <button type="button" class="btn" onClick=${onClose}>${t('Cancel')}</button>
        <button class="btn primary" disabled=${busy || !v.name.trim() || !v.prompt.trim()}>${t('Save')}</button>
      </div>
    </form>
  </div>`;
}

function Commands({ data, setData }) {
  const [edit, setEdit] = useState(null);
  const toggle = async (c, on) => setData(await api(`/api/commands/${encodeURIComponent(c.id)}`, { method: 'PUT', body: { enabled: on } }).catch(toastError));
  const del = async (c) => {
    if (!(await confirmDialog({ title: t('Delete the command “/{name}”?', { name: c.name }), ok: t('Delete'), danger: true }))) return;
    setData(await api(`/api/commands/${encodeURIComponent(c.id)}`, { method: 'DELETE' }).catch(toastError));
  };
  return html`<div class="col" style="gap:14px">
    <div class="row wrap" style="justify-content:space-between">
      <p class="muted" style="margin:0;max-width:640px">${t('A command is a saved request. Type / in the chat, pick it and add the details: “/card black hoodie with a fox”.')}</p>
      <button class="btn primary" onClick=${() => setEdit({})}><${Icon} name="plus" size="sm" /> ${t('New command')}</button>
    </div>
    <div class="card list">
      ${data.commands.length
        ? data.commands.map((c) => html`<div class=${`list-row ${c.enabled ? '' : 'dim'}`} key=${c.id}>
            <code class="cmd-name">/${c.name}</code>
            <div class="grow" style="min-width:0"><div class="ellipsis">${c.description || html`<span class="faint">${c.prompt.slice(0, 120)}</span>`}</div>
              <div class="meta"><span>${c.source === 'own' ? t('Yours') : t('Plugin: {name}', { name: c.pluginName })}</span>${c.hint && html`<span>${c.hint}</span>`}</div></div>
            <${Toggle} on=${c.enabled} onChange=${(v) => toggle(c, v)} />
            ${c.source === 'own' && html`<button class="icon-btn" title=${t('Edit')} onClick=${() => setEdit(c)}><${Icon} name="pencil" size="sm" /></button>
              <button class="icon-btn" title=${t('Delete')} onClick=${() => del(c)}><${Icon} name="trash" size="sm" /></button>`}
          </div>`)
        : html`<div class="empty">${t('No commands yet. Make one for a request you send often.')}</div>`}
    </div>
    ${edit && html`<${CommandEditor} c=${edit.id ? edit : null} onClose=${() => setEdit(null)} setData=${setData} />`}
  </div>`;
}

// ---------------- Connectors ----------------

function ConnectorEditor({ onClose, setData }) {
  const [v, setV] = useState({ name: '', kind: 'program', line: '', url: '', token: '' });
  const [busy, setBusy] = useState(false);
  const field = (k) => (e) => setV({ ...v, [k]: e.target.value });
  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      const parts = splitLine(v.line);
      const body = v.kind === 'http' ? { name: v.name.trim(), url: v.url.trim(), ...(v.token.trim() ? { headers: { Authorization: /^bearer\s/i.test(v.token.trim()) ? v.token.trim() : `Bearer ${v.token.trim()}` } } : {}) } : { name: v.name.trim(), command: parts[0] || '', args: parts.slice(1) };
      setData(await api('/api/connectors', { method: 'POST', body }));
      toast(t('Saved'));
      onClose();
    } catch (err) {
      toastError(err);
    }
    setBusy(false);
  };
  return html`<div class="overlay" onMouseDown=${(e) => e.target === e.currentTarget && onClose()}>
    <form class="dialog wide" onSubmit=${save}>
      <h3>${t('Add a connector')}</h3>
      <p class="muted" style="margin:0 0 12px">${t('A connector (an MCP server) gives the chat’s model more tools: files, a shop, a calendar… Its instructions usually give the command or the address.')}</p>
      <label class="field"><span>${t('Name')}</span><input class="input" value=${v.name} onInput=${field('name')} placeholder=${t('for example: files')} required /></label>
      <div class="seg" style="margin-bottom:12px"><button type="button" class=${v.kind === 'program' ? 'on' : ''} onClick=${() => setV({ ...v, kind: 'program' })}>${t('A program on this computer')}</button><button type="button" class=${v.kind === 'http' ? 'on' : ''} onClick=${() => setV({ ...v, kind: 'http' })}>${t('An address on the internet')}</button></div>
      ${v.kind === 'program'
        ? html`<label class="field"><span>${t('Command')}</span><input class="input mono" value=${v.line} onInput=${field('line')} placeholder="npx -y @modelcontextprotocol/server-filesystem /Users/me/Documents" required /></label>
          <p class="faint" style="margin:0 0 14px">${t('Program connectors need Node.js (npx) or Python (uvx) installed.')}</p>`
        : html`<label class="field"><span>${t('Address')}</span><input class="input mono" value=${v.url} onInput=${field('url')} placeholder="https://example.com/mcp" required /></label>
          <label class="field"><span>${t('Key or token (if the service gives one)')}</span><input class="input" type="password" value=${v.token} onInput=${field('token')} /></label>`}
      <div class="row" style="justify-content:flex-end">
        <button type="button" class="btn" onClick=${onClose}>${t('Cancel')}</button>
        <button class="btn primary" disabled=${busy || !v.name.trim() || (v.kind === 'http' ? !v.url.trim() : !v.line.trim())}>${t('Add')}</button>
      </div>
    </form>
  </div>`;
}

function JsonEditor({ onClose, reload }) {
  const { status } = useStore();
  const [text, setText] = useState(status?.settings?.mcpConfig || '');
  const save = async () => {
    if (text.trim()) {
      try {
        JSON.parse(text);
      } catch (err) {
        return toast(t('The MCP settings are not valid JSON: {msg}', { msg: err.message }), 'bad');
      }
    }
    try {
      const next = await api('/api/settings', { method: 'PUT', body: { mcpConfig: text.trim() } });
      set({ status: { ...getState().status, settings: next } });
      reload();
      onClose();
    } catch (err) {
      toastError(err);
    }
  };
  return html`<div class="overlay" onMouseDown=${(e) => e.target === e.currentTarget && onClose()}>
    <div class="dialog wide">
      <h3>${t('Connectors as JSON')}</h3>
      <p class="muted" style="margin:0 0 10px">${t('The same JSON as Claude Desktop’s “mcpServers”. Connectors from plugins are not in it.')}</p>
      <textarea class="textarea mono" style="min-height:260px;font-size:12.5px" value=${text} onInput=${(e) => setText(e.target.value)} placeholder='{ "mcpServers": { "files": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/Users/me/Documents"] } } }'></textarea>
      <div class="row" style="justify-content:flex-end;margin-top:12px">
        <button class="btn" onClick=${onClose}>${t('Cancel')}</button>
        <button class="btn primary" onClick=${save}>${t('Save and connect')}</button>
      </div>
    </div>
  </div>`;
}

// What a directory entry is right now: not added, connecting, waiting for a sign-in, connected, off or failed.
function entryState(d, data) {
  const own = data.connectors.find((c) => c.name === d.id || c.what === d.url);
  const plug = !own && data.plugins.flatMap((p) => p.connectors.map((c) => ({ ...c, id: `${p.id}:${c.name}`, pluginOn: p.enabled }))).find((c) => c.what === d.url && c.on && c.pluginOn);
  if (!own && !plug) return { kind: '' };
  const name = own ? own.name : plug.id;
  const st = data.servers.find((x) => x.name === name);
  if (own && !own.on) return { kind: 'off', name, own };
  if (!st || st.status === 'starting' || st.status === 'stopped') return { kind: 'connecting', name, own, st };
  return { kind: st.status === 'signin' ? 'signin' : st.status === 'error' ? 'error' : 'ready', name, own, st, plugin: !own };
}

function DirCard({ d, state, busy, onConnect, onOpen }) {
  const k = state.kind;
  return html`<div class=${`dir-card ${d.auth === 'approved' ? 'na' : ''}`} role="button" tabindex="0" onClick=${onOpen} onKeyDown=${(e) => e.key === 'Enter' && onOpen()}>
    <${Logo} src=${d.logo} />
    <div class="grow" style="min-width:0">
      <div class="dir-name">${d.name}</div>
      <div class="dir-desc">${d.description}</div>
    </div>
    <div class="dir-act" onClick=${(e) => e.stopPropagation()}>
      ${k === 'ready'
        ? html`<span class="badge ok"><${Icon} name="check" /> ${t('Connected')}</span>`
        : k === 'signin'
          ? html`<button class="btn sm primary" onClick=${onOpen}>${t('Sign in')}</button>`
          : k === 'connecting'
            ? html`<span class="badge"><${Icon} name="loader" cls="spin" /></span>`
            : k === 'error'
              ? html`<button class="badge bad" onClick=${onOpen}>${t('Error')}</button>`
              : k === 'off'
                ? html`<span class="badge">${t('Off')}</span>`
                : d.auth === 'approved'
                  ? html`<span class="badge" title=${d.note}>${t('Not available')}</span>`
                  : html`<button class="btn sm" disabled=${busy} onClick=${() => onConnect(d)}>${busy ? html`<${Icon} name="loader" cls="spin" size="sm" />` : html`<${Icon} name="plus" size="sm" />`} ${t('Connect')}</button>`}
    </div>
  </div>`;
}

// One service, opened from its card: what it does, how it connects, and its status.
function DirDetail({ d, dir, data, setData, busy, onConnect, onClose }) {
  const state = entryState(d, data);
  const local = isLocal();
  const cat = dir.categories.find((c) => c.id === d.category)?.name || '';
  const how = d.auth === 'oauth' ? t('Hearth opens the sign-in page of {name} in your browser. Once you allow access, its tools are in the chat. The sign-in stays on this computer.', { name: d.name }) : d.auth === 'open' && !d.note ? t('Works without an account.') : '';
  const remove = async () => {
    if (!(await confirmDialog({ title: t('Remove the connector “{name}”?', { name: d.name }), ok: t('Remove'), danger: true }))) return;
    setData(await api(`/api/connectors/${encodeURIComponent(state.own.name)}`, { method: 'DELETE' }).catch(toastError));
    onClose();
  };
  const turnOn = async () => setData(await api(`/api/connectors/${encodeURIComponent(state.own.name)}`, { method: 'PUT', body: { enabled: true } }).catch(toastError));
  return html`<div class="overlay" onMouseDown=${(e) => e.target === e.currentTarget && onClose()}>
    <div class="dialog wide dir-detail">
      <div class="row" style="gap:14px">
        <${Logo} src=${d.logo} size="lg" />
        <div class="grow" style="min-width:0"><h3 style="margin:0">${d.name}</h3><div class="muted" style="font-size:13px">${cat} · ${d.site}</div></div>
        <button class="icon-btn" title=${t('Close')} onClick=${onClose}><${Icon} name="x" /></button>
      </div>
      <p style="margin:0">${d.description}</p>
      ${how && html`<div class="notice"><${Icon} name="info" /><div>${how}</div></div>`}
      ${d.note && html`<div class=${`notice ${d.auth === 'approved' ? 'warn' : ''}`}><${Icon} name=${d.auth === 'approved' ? 'alert' : 'info'} /><div>${d.note}</div></div>`}
      ${state.kind && state.kind !== 'off' && html`<div class="dir-status">${state.plugin ? html`<div class="faint" style="font-size:12.5px">${t('Connected through a plugin')}</div>` : ''}<${ConnStatus} name=${state.name} on=${true} st=${state.st} setData=${setData} /></div>`}
      <code class="faint dir-url">${d.url}</code>
      <div class="row" style="justify-content:flex-end;gap:8px">
        ${state.own && local && html`<button class="btn danger" onClick=${remove}><${Icon} name="trash" size="sm" /> ${t('Remove')}</button>`}
        <span class="grow"></span>
        ${state.kind === 'off' && local && html`<button class="btn primary" onClick=${turnOn}>${t('Turn on')}</button>`}
        ${state.kind === 'error' && state.own && d.auth !== 'approved' && local && html`<button class="btn primary" disabled=${busy} onClick=${() => onConnect(d)}>${busy ? html`<${Icon} name="loader" cls="spin" size="sm" />` : html`<${Icon} name="rotate-ccw" size="sm" />`} ${t('Try again')}</button>`}
        ${!state.kind && d.auth !== 'approved' && html`<button class="btn primary" disabled=${busy} onClick=${() => onConnect(d)}>${busy ? html`<${Icon} name="loader" cls="spin" size="sm" />` : html`<${Icon} name="plus" size="sm" />`} ${t('Connect')}</button>`}
        <button class="btn" onClick=${onClose}>${t('Close')}</button>
      </div>
    </div>
  </div>`;
}

// A connector the user added: its logo, its status (sign in, tools, errors), on/off and remove.
function OwnCard({ c, d, st, setData, onOpen }) {
  const local = isLocal();
  const toggle = async (on) => setData(await api(`/api/connectors/${encodeURIComponent(c.name)}`, { method: 'PUT', body: { enabled: on } }).catch(toastError));
  const del = async () => {
    if (!(await confirmDialog({ title: t('Remove the connector “{name}”?', { name: d?.name || c.name }), ok: t('Remove'), danger: true }))) return;
    setData(await api(`/api/connectors/${encodeURIComponent(c.name)}`, { method: 'DELETE' }).catch(toastError));
  };
  return html`<div class=${`dir-card own ${c.on ? '' : 'dim'}`}>
    <${Logo} src=${d?.logo} icon=${c.kind === 'http' ? 'globe' : 'terminal'} />
    <div class="grow" style="min-width:0">
      <div class="dir-name">${d ? html`<button class="link-btn plain" onClick=${onOpen}>${d.name}</button>` : c.name}</div>
      ${!d && html`<code class="faint ellipsis" style="display:block;font-size:12px" title=${c.what}>${c.what}</code>`}
      <${ConnStatus} name=${c.name} on=${c.on} st=${st} setData=${setData} />
    </div>
    <div class="dir-act col" style="gap:6px;align-items:flex-end">
      <${Toggle} on=${c.on} disabled=${!local} onChange=${toggle} />
      ${local && html`<button class="icon-btn" title=${t('Remove')} onClick=${del}><${Icon} name="trash" size="sm" /></button>`}
    </div>
  </div>`;
}

function Connectors({ data, setData, reload, dir }) {
  const { status } = useStore();
  const [q, setQ] = useState('');
  const [cat, setCat] = useState('all');
  const [open, setOpen] = useState(null);
  const [busy, setBusy] = useState('');
  const [adding, setAdding] = useState(false);
  const [json, setJson] = useState(false);
  const local = isLocal();
  const server = (name) => data.servers.find((x) => x.name === name);
  const connect = async (d) => {
    if (!local) return toast(t('Skills, plugins and connectors can be added on the computer itself.'));
    setBusy(d.id);
    try {
      const r = await api(`/api/directory/${encodeURIComponent(d.id)}/connect`, { method: 'POST' });
      setData(r);
      toast(r.url ? t('The sign-in page of {name} is open in your browser.', { name: d.name }) : t('{name} is connected.', { name: d.name }));
    } catch (err) {
      toastError(err);
      reloadInto(setData);
    }
    setBusy('');
  };
  const setApproval = async (v) => {
    const next = await api('/api/settings', { method: 'PUT', body: { toolApproval: v ? 'ask' : 'auto' } }).catch(toastError);
    if (next) set({ status: { ...getState().status, settings: next } });
  };
  const fromPlugins = data.plugins.flatMap((p) => p.connectors.map((c) => ({ ...c, plugin: p })));
  const all = dir?.items || [];
  const match = (d) => (cat === 'all' || d.category === cat) && (!q || `${d.name} ${d.description} ${d.site}`.toLowerCase().includes(q.trim().toLowerCase()));
  const showFeatured = cat === 'all' && !q.trim();
  const featured = showFeatured ? all.filter((d) => d.featured) : [];
  const rest = all.filter((d) => match(d) && !(showFeatured && d.featured));
  const card = (d) => html`<${DirCard} key=${d.id} d=${d} state=${entryState(d, data)} busy=${busy === d.id} onConnect=${connect} onOpen=${() => setOpen(d.id)} />`;
  const opened = open && all.find((d) => d.id === open);
  return html`<div class="col" style="gap:22px">
    ${!data.toolsOn && html`<div class="notice warn"><${Icon} name="alert" /><div class="grow">${t('Tools are off, so the chat doesn’t use connectors. Turn tools on in Settings.')}</div><button class="btn sm" onClick=${() => go('#/settings')}>${t('Settings')}</button></div>`}
    ${data.connectors.length > 0 && html`<section>
      <div class="cust-h"><h2>${t('Your connectors')}</h2><span class="faint">${data.connectors.length}</span></div>
      <div class="dir-grid">${data.connectors.map((c) => html`<${OwnCard} key=${c.name} c=${c} d=${dirEntry(dir, { name: c.name, url: c.what })} st=${server(c.name)} setData=${setData} onOpen=${() => setOpen(dirEntry(dir, { name: c.name, url: c.what })?.id || null)} />`)}</div>
    </section>`}
    <section>
      <div class="cust-h wrap">
        <h2>${t('Browse connectors')}</h2>
        <span class="grow"></span>
        ${local && html`<button class="btn sm" onClick=${() => setJson(true)}><${Icon} name="code" size="sm" /> JSON</button><button class="btn sm" onClick=${() => setAdding(true)}><${Icon} name="plus" size="sm" /> ${t('Add your own')}</button>`}
      </div>
      <p class="muted" style="margin:-4px 0 12px;font-size:13.5px">${t('Connectors give the chat (and bots) tools from your services: designs, files, your shop, posts. Sign-ins stay on this computer.')}</p>
      <label class="search-box"><${Icon} name="search" size="sm" /><input placeholder=${t('Search connectors')} value=${q} onInput=${(e) => setQ(e.target.value)} />${q && html`<button class="icon-btn" style="width:24px;height:24px" title=${t('Clear')} onClick=${() => setQ('')}><${Icon} name="x" size="sm" /></button>`}</label>
      <div class="chips">
        <button class=${`chip-btn outline filter ${cat === 'all' ? 'on' : ''}`} onClick=${() => setCat('all')}>${t('All')}</button>
        ${(dir?.categories || []).map((c) => html`<button class=${`chip-btn outline filter ${cat === c.id ? 'on' : ''}`} onClick=${() => setCat(c.id)}>${c.name}</button>`)}
      </div>
      ${!dir
        ? html`<div class="empty"><${Icon} name="loader" cls="spin" /></div>`
        : html`${featured.length > 0 && html`<div class="ext-sub" style="margin:4px 0 8px">${t('Popular for your business')}</div><div class="dir-grid">${featured.map(card)}</div><div class="ext-sub" style="margin:18px 0 8px">${t('All connectors')}</div>`}
          ${rest.length ? html`<div class="dir-grid">${rest.map(card)}</div>` : html`<div class="card empty">${t('Nothing found. You can add any connector by its address: “Add your own”.')}</div>`}`}
    </section>
    ${fromPlugins.length > 0 && html`<details class="card plug-conns">
      <summary><${Icon} name="puzzle" size="sm" /> ${t('Connectors from plugins')} <span class="faint">${fromPlugins.length}</span></summary>
      <div class="list">${fromPlugins.map((c) => {
        const brand = dirEntry(dir, { name: c.name, url: c.what });
        return html`<div class="list-row" key=${`${c.plugin.id}:${c.name}`}>
          <${Logo} src=${brand?.logo} icon="puzzle" />
          <div class="grow" style="min-width:0"><div class="conn-line"><b>${brand?.name || c.name}</b><span class="badge">${t('Plugin: {name}', { name: c.plugin.name })}</span></div>
            <${ConnStatus} name=${`${c.plugin.id}:${c.name}`} on=${c.on && c.plugin.enabled} st=${server(`${c.plugin.id}:${c.name}`)} missing=${c.needs.filter((n) => !c.plugin.values[n])} setData=${setData} /></div>
          <${Toggle} on=${c.on} disabled=${!local} onChange=${async (v) => setData(await api(`/api/plugins/${encodeURIComponent(c.plugin.id)}`, { method: 'PUT', body: { connector: c.name, connectorOn: v } }).catch(toastError))} />
        </div>`;
      })}</div>
    </details>`}
    <div class="card">
      <div class="set-row"><div class="lbl"><b>${t('Ask before a connector’s tool runs')}</b><span>${t('Connector tools can do anything their program or service allows, so Hearth asks each time unless you turn this off.')}</span></div><div class="ctl fit"><${Toggle} on=${status?.settings?.toolApproval === 'ask'} onChange=${setApproval} /></div></div>
    </div>
    ${opened && html`<${DirDetail} d=${opened} dir=${dir} data=${data} setData=${setData} busy=${busy === opened.id} onConnect=${connect} onClose=${() => setOpen(null)} />`}
    ${adding && html`<${ConnectorEditor} onClose=${() => setAdding(false)} setData=${setData} />`}
    ${json && html`<${JsonEditor} onClose=${() => setJson(false)} reload=${reload} />`}
  </div>`;
}

// ---------------- Page ----------------

export function ExtensionsPage({ route }) {
  const tab = ['skills', 'plugins', 'commands'].includes(route?.id) ? route.id : 'connectors';
  const [data, setDataRaw] = useState(null);
  const [dir, setDir] = useState(null);
  const [found, setFound] = useState(null);
  const setData = (d) => d && d.skills && setDataRaw(d);
  const reload = () => api('/api/extensions').then(setData).catch(toastError);
  useEffect(() => {
    reload();
    api('/api/directory').then(setDir).catch(() => setDir({ categories: [], items: [] }));
  }, []);
  // While connectors are starting, or a sign-in is open in the browser, check again shortly.
  const starting = data?.servers?.some((s) => s.status === 'starting' || s.status === 'stopped' || s.auth?.pending);
  useEffect(() => {
    if (!starting) return;
    const tm = setTimeout(reload, 1500);
    return () => clearTimeout(tm);
  }, [data]);
  const count = { skills: data?.skills.length, plugins: data?.plugins.length, commands: data?.commands.length, connectors: data?.connectors.length };
  const goTab = (k) => go(k === 'connectors' ? '#/extensions' : `#/extensions/${k}`);
  return html`<div class="page"><div class="page-inner">
    <${PageHead} title=${t('Customize')} text=${t('Connect Hearth to your services, and teach it new tasks with skills, plugins and commands. Ready-made ones for Claude work here too.')} />
    <div class="cust-layout">
      <nav class="cust-nav">
        ${TABS().map(([k, icon, label]) => html`<button class=${tab === k ? 'on' : ''} onClick=${() => goTab(k)}><${Icon} name=${icon} size="sm" /> <span class="grow">${label}</span>${count[k] ? html`<span class="count">${count[k]}</span>` : ''}</button>`)}
      </nav>
      <div style="min-width:0">
        ${!data
          ? html`<div class="empty"><${Icon} name="loader" cls="spin" /></div>`
          : tab === 'plugins'
            ? html`<${Plugins} data=${data} setData=${setData} onPreview=${setFound} dir=${dir} />`
            : tab === 'commands'
              ? html`<${Commands} data=${data} setData=${setData} />`
              : tab === 'skills'
                ? html`<${Skills} data=${data} reload=${reload} setData=${setData} onPreview=${setFound} />`
                : html`<${Connectors} data=${data} setData=${setData} reload=${reload} dir=${dir} />`}
      </div>
    </div>
    ${found && html`<${InstallDialog} found=${found} onClose=${() => { if (found?.token) api(`/api/extensions/inspect/${found.token}`, { method: 'DELETE' }).catch(() => {}); setFound(null); }} onDone=${(r, where) => { setFound(null); setData(r); if (where !== tab) goTab(where); }} />`}
  </div></div>`;
}
