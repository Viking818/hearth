// Connect page: addresses, API key, network access, a live check, and copy-paste setup for popular apps.
import { html, useState } from '../vendor/preact-htm.js';
import { Icon } from './icons.js';
import { useStore, api, toast, toastError, refreshStatus, set, getState, loadModel } from './store.js';
import { CopyField, Snippet, PageHead, confirmDialog } from './ui.js';
import { t } from './i18n.js';

const TOOLS = () => [
  ['claude', 'Claude Code'],
  ['codex', 'Codex'],
  ['opencode', 'OpenCode'],
  ['other', t('Other apps')],
  ['python', 'Python'],
  ['curl', 'curl'],
];

function snippets({ base, key, model, win, ctx }) {
  const v1 = `${base}/v1`;
  const env = (pairs) => pairs.map(([k, v]) => (win ? `$env:${k}="${v}"` : `export ${k}="${v}"`)).join('\n');
  return {
    claude: {
      note: win ? t('Paste into PowerShell, then start Claude Code in the same window.') : t('Paste into Terminal, then start Claude Code in the same window.'),
      code: `${env([
        ['ANTHROPIC_BASE_URL', base],
        ['ANTHROPIC_AUTH_TOKEN', key],
        ['ANTHROPIC_MODEL', model],
        ['ANTHROPIC_DEFAULT_HAIKU_MODEL', model],
        // Tells Claude Code the real window, so it compacts the conversation before the local model runs out.
        ['CLAUDE_CODE_MAX_CONTEXT_TOKENS', String(ctx)],
        ['CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', '1'],
      ])}\nclaude`,
    },
    codex: {
      note: t('Add this to {file}, then run codex.', { file: win ? '%USERPROFILE%\\.codex\\config.toml' : '~/.codex/config.toml' }),
      code: `model = "${model}"\nmodel_provider = "hearth"\n\n[model_providers.hearth]\nname = "Hearth (local)"\nbase_url = "${v1}"\nwire_api = "responses"`,
    },
    opencode: {
      note: t('Save as opencode.json in your project (or {file}), then pick “Hearth” with /models.', { file: win ? '%USERPROFILE%\\.config\\opencode\\opencode.json' : '~/.config/opencode/opencode.json' }),
      code: JSON.stringify(
        {
          $schema: 'https://opencode.ai/config.json',
          provider: { hearth: { npm: '@ai-sdk/openai-compatible', name: 'Hearth', options: { baseURL: v1, apiKey: key }, models: { [model]: { name: model } } } },
        },
        null,
        2,
      ),
    },
    other: {
      note: t('Any app with an “OpenAI-compatible” or “custom provider” option (Cursor, Continue, Cline, Open WebUI, Jan, LibreChat…) works with these three values.'),
      code: `Base URL:  ${v1}\nAPI key:   ${key}\nModel:     ${model}`,
    },
    python: {
      note: t('With the official openai or anthropic package (pip install openai anthropic).'),
      code: `from openai import OpenAI\n\nclient = OpenAI(base_url="${v1}", api_key="${key}")\nreply = client.chat.completions.create(\n    model="${model}",\n    messages=[{"role": "user", "content": "Hello!"}],\n)\nprint(reply.choices[0].message.content)\n\n# Or the Anthropic API:\nimport anthropic\n\nclaude = anthropic.Anthropic(base_url="${base}", api_key="${key}")\nmsg = claude.messages.create(\n    model="${model}", max_tokens=1024,\n    messages=[{"role": "user", "content": "Hello!"}],\n)\nprint(msg.content[0].text)`,
    },
    curl: {
      note: win ? t('In PowerShell use curl.exe, and keep the quotes as shown.') : t('Quick test from a terminal.'),
      code: win
        ? `curl.exe ${v1}/chat/completions -H "Content-Type: application/json" -H "Authorization: Bearer ${key}" -d '{\\"model\\":\\"${model}\\",\\"messages\\":[{\\"role\\":\\"user\\",\\"content\\":\\"Hello!\\"}]}'`
        : `curl ${v1}/chat/completions \\\n  -H "Content-Type: application/json" \\\n  -H "Authorization: Bearer ${key}" \\\n  -d '{"model":"${model}","messages":[{"role":"user","content":"Hello!"}]}'`,
    },
  };
}

function Check() {
  const [res, setRes] = useState({});
  const [busy, setBusy] = useState('');
  const run = async (kind) => {
    setBusy(kind);
    setRes((r) => ({ ...r, [kind]: null }));
    try {
      const r = await api('/api/connect/check', { method: 'POST', body: { api: kind } });
      setRes((x) => ({ ...x, [kind]: r }));
    } catch (err) {
      setRes((x) => ({ ...x, [kind]: { ok: false, steps: [{ name: t('Connection'), ok: false, detail: err.message }] } }));
    }
    setBusy('');
  };
  const box = (kind, title) => html`<div class="card pad col" style="gap:10px">
    <div class="row"><b class="grow">${title}</b>
      <button class="btn sm" disabled=${!!busy} onClick=${() => run(kind)}>${busy === kind ? html`<${Icon} name="loader" cls="spin" size="sm" /> ${t('Checking…')}` : html`<${Icon} name="play" size="sm" /> ${t('Run check')}`}</button></div>
    ${res[kind]
      ? res[kind].steps.map((s) => html`<div class="check-step"><${Icon} name=${s.ok ? 'check-circle' : 'x-circle'} cls=${s.ok ? 'fit-great' : 'fit-no'} /><span class="grow">${s.name} <span class="muted">${s.detail}</span></span><span class="faint">${s.ms ? `${(s.ms / 1000).toFixed(1)} s` : ''}</span></div>`)
      : html`<span class="muted" style="font-size:14px">${t('Sends one message and one tool call, the way coding tools do.')}</span>`}
  </div>`;
  return html`<div class="grid c2">${box('anthropic', t('Anthropic API (Claude Code)'))}${box('openai', t('OpenAI API (Codex, OpenCode, most apps)'))}</div>`;
}

export function ConnectPage() {
  const { status } = useStore();
  const [tool, setTool] = useState('claude');
  const [win, setWin] = useState(status?.app?.platform === 'win32');
  const [useLan, setUseLan] = useState(false);
  if (!status) return null;
  const s = status.settings;
  const lanBase = status.urls.lan?.[0];
  const base = useLan && lanBase ? lanBase : status.urls.anthropic;
  const model = status.alias || 'local-model';
  const ctx = status.engine?.ctx || s.contextSize;
  const sn = snippets({ base, key: s.apiKey, model, win, ctx })[tool];
  const loaded = status.engine?.status === 'ready';

  const save = async (patch) => {
    try {
      const next = await api('/api/settings', { method: 'PUT', body: patch });
      set({ status: { ...getState().status, settings: next } });
      await refreshStatus();
      toast(t('Saved'));
    } catch (err) {
      toastError(err);
    }
  };
  const newKey = async () => {
    if (!(await confirmDialog({ title: t('Make a new API key?'), text: t('Apps using the old key from other devices will stop working until you give them the new one.'), ok: t('New key') }))) return;
    await api('/api/settings/new-key', { method: 'POST' });
    refreshStatus();
  };
  const reloadModel = () => {
    const m = getState().models.find((x) => x.id === status.engine?.model?.id);
    if (m) loadModel(m);
  };

  return html`<div class="page"><div class="page-inner">
    <${PageHead} title=${t('Connect apps')} text=${t('Use your local model in Claude Code, Codex and other apps. They talk to Hearth like they would to a cloud service, but nothing leaves your computer.')} />

    <div class="grid c2">
      <div class="card pad col" style="gap:12px">
        <b>${t('Addresses')}</b>
        <div class="kv"><span class="k">${t('OpenAI-compatible')}</span><${CopyField} value=${`${status.urls.openai}`} /></div>
        <div class="kv"><span class="k">${t('Anthropic-compatible')}</span><${CopyField} value=${status.urls.anthropic} /></div>
        <div class="kv"><span class="k">${t('Model name')}</span><${CopyField} value=${model} /></div>
        <span class="muted" style="font-size:13px">${loaded ? t('Any model name works: Hearth always answers with the model that is loaded.') : t('Any model name works: Hearth always answers with the model that is loaded (or loads the last one).')}</span>
      </div>
      <div class="card pad col" style="gap:12px">
        <b>${t('Access')}</b>
        <div class="seg" style="align-self:flex-start">
          <button class=${s.access === 'local' ? 'on' : ''} onClick=${() => save({ access: 'local' })}><${Icon} name="laptop" size="sm" /> ${t('This computer only')}</button>
          <button class=${s.access === 'lan' ? 'on' : ''} onClick=${() => save({ access: 'lan' })}><${Icon} name="globe" size="sm" /> ${t('My network too')}</button>
        </div>
        <span class="muted" style="font-size:13.5px">${s.access === 'lan'
          ? html`${t('Other devices on your Wi-Fi can use the API at')} ${status.urls.lan.map((u) => html`<code class="mono">${u}/v1</code> `)} ${t('with the key below. The app itself is shared only with phones you pair in Settings.')}`
          : t('Only apps on this computer can use the model. They don’t need the key, but some apps insist on one, so use this.')}</span>
        <div class="kv"><span class="k">${t('API key')}</span><${CopyField} value=${s.apiKey} mask /></div>
        <button class="btn sm" style="align-self:flex-start" onClick=${newKey}><${Icon} name="key" size="sm" /> ${t('New key')}</button>
      </div>
    </div>

    <div class="section">
      <h2>${t('Check the connection')}</h2>
      <p class="sub">${loaded ? t('Tests the loaded model through the same doors your apps use.') : t('No model is loaded, so the check will load the last one first.')}</p>
      <${Check} />
    </div>

    <div class="section">
      <h2>${t('Set up an app')}</h2>
      ${(s.contextSize < 65536 || s.apiThinking !== 'off') && html`<div class="notice accent" style="margin-bottom:14px">
        <${Icon} name="lightbulb" />
        <div class="grow">${t('Coding tools send long instructions. They work best with a 64K context and thinking off for apps (much faster answers).')}
          <div class="row wrap" style="margin-top:10px">
            ${s.contextSize < 65536 && html`<button class="btn sm" onClick=${async () => { await save({ contextSize: 65536 }); if (loaded) reloadModel(); }}>${loaded ? t('Use 64K context and reload') : t('Use 64K context')}</button>`}
            ${s.apiThinking !== 'off' && html`<button class="btn sm" onClick=${() => save({ apiThinking: 'off' })}>${t('Turn thinking off for apps')}</button>`}
          </div>
        </div>
      </div>`}
      <div class="notice" style="margin-bottom:14px">
        <${Icon} name="info" />
        <div>${t('Coding tools need a model that is good at using tools. Small models (under ~20B) sometimes say they did something without doing it. For Claude Code, Codex and OpenCode, try Qwen3.6 35B A3B or Qwen3.8 27B from the Models page.')}</div>
      </div>
      <div class="row wrap" style="justify-content:space-between;margin-bottom:4px">
        <div class="tabs" style="margin-bottom:0;border-bottom:0">${TOOLS().map(([k, l]) => html`<button class=${tool === k ? 'on' : ''} onClick=${() => setTool(k)}>${l}</button>`)}</div>
        <div class="row">
          ${lanBase && html`<div class="seg"><button class=${!useLan ? 'on' : ''} onClick=${() => setUseLan(false)}>${t('This computer')}</button><button class=${useLan ? 'on' : ''} onClick=${() => setUseLan(true)}>${t('Other device')}</button></div>`}
          <div class="seg"><button class=${!win ? 'on' : ''} onClick=${() => setWin(false)}>Mac / Linux</button><button class=${win ? 'on' : ''} onClick=${() => setWin(true)}>Windows</button></div>
        </div>
      </div>
      <div class="card pad col" style="gap:12px">
        <span class="muted">${sn.note}</span>
        <${Snippet} code=${sn.code} />
      </div>
    </div>
  </div></div>`;
}
