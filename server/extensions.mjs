// Extensions: skills, plugins and commands, in the same formats as Claude's, so ready-made ones work here too.
//  · A skill is a folder with a SKILL.md: a name, a description that says when to use it, and instructions
//    (sometimes with more files next to it). The chat's model sees the names and descriptions and reads a skill
//    with the use_skill tool when a task fits; the user can also switch one on in a chat with "/name".
//  · A plugin (Claude Code's format) is a folder that may hold skills/, commands/ (prompts started with "/name"),
//    agents/ (they become assistants) and .mcp.json (connectors: MCP servers). Its connectors stay off until the
//    user turns each one on, because they run programs or send data to a website.
//  · Commands are saved prompts started with "/name" in the chat; "$ARGUMENTS" is what follows the name.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DIRS, ROOT } from './settings.mjs';
import { readJson, writeJson, uid, keepPrivate } from './util.mjs';
import { t } from './i18n.mjs';

export const SKILLS_DIR = path.join(DIRS.extensions, 'skills');
export const PLUGINS_DIR = path.join(DIRS.extensions, 'plugins');
const STATE_FILE = path.join(DIRS.extensions, 'state.json');
keepPrivate(STATE_FILE);
for (const d of [SKILLS_DIR, PLUGINS_DIR]) fs.mkdirSync(d, { recursive: true });

const MAX_TEXT = 24000; // one tool answer
const MAX_SKILL_PROMPT = 20000; // one skill's instructions in the system prompt

const fail = (msg, status = 400) => Object.assign(new Error(msg), { status });

// ---- State: what is switched on, where things came from, and the values connectors need ----

export function readState() {
  const s = readJson(STATE_FILE, {}) || {};
  return {
    skills: s.skills && typeof s.skills === 'object' ? s.skills : {}, // id → { enabled, source, at }
    plugins: s.plugins && typeof s.plugins === 'object' ? s.plugins : {}, // id → { enabled, source, at, values, connectors }
    commands: Array.isArray(s.commands) ? s.commands : [], // the user's own: { id, name, description, prompt }
    commandsOff: Array.isArray(s.commandsOff) ? s.commandsOff : [], // plugin commands the user switched off
  };
}

export function writeState(s) {
  writeJson(STATE_FILE, s, { secret: true }); // it holds the keys typed for plugins' connectors
  forget();
}

// Reading a few hundred skill files takes a moment, and every chat message needs the list: keep it for a few
// seconds, and drop it whenever Hearth changes something (files changed by hand show up a few seconds later).
let cache = null;
export function forget() {
  cache = null;
}
function cached(key, make) {
  if (!cache || Date.now() - cache.at > 3000) cache = { at: Date.now() };
  if (!(key in cache)) cache[key] = make();
  return cache[key];
}

// ---- Small helpers ----

// Names for folders and "/commands": lowercase letters (any alphabet), digits and dashes.
export function slug(s) {
  return String(s || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

const dirsIn = (dir) => {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
};

export const readJsonSafe = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};

// A path inside `root` (after following links), or null.
export function inside(root, rel) {
  try {
    const base = fs.realpathSync(root);
    const full = fs.realpathSync(path.resolve(base, String(rel || '')));
    return full === base || full.startsWith(base + path.sep) ? full : null;
  } catch {
    return null;
  }
}

// Every file under a folder (relative paths), skipping hidden ones; at most `max`.
export function filesIn(dir, max = 300) {
  const out = [];
  const walk = (d, rel, depth) => {
    if (depth > 6 || out.length >= max) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === '__pycache__') continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(d, e.name), r, depth + 1);
      else if (e.isFile()) out.push(r);
      if (out.length >= max) return;
    }
  };
  try {
    walk(dir, '', 0);
  } catch {}
  return out;
}

const SCRIPT = /\.(py|js|mjs|cjs|ts|sh|bash|zsh|rb|pl|ps1|bat|cmd)$/i;

// ---- The YAML header of SKILL.md and of command and agent files ----
// Simple "key: value" lines, quoted values, "|" and ">" blocks, short lists. Anything fancier is kept as text.

const unquote = (s) => {
  if (/^"[\s\S]*"$/.test(s)) {
    try {
      return JSON.parse(s);
    } catch {
      return s.slice(1, -1);
    }
  }
  if (/^'[\s\S]*'$/.test(s)) return s.slice(1, -1).replace(/''/g, "'");
  return s;
};

export function parseFrontmatter(text) {
  const src = String(text || '').replace(/^﻿/, '');
  const m = /^---[ \t]*\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*(?:\r?\n|$)/.exec(src);
  if (!m) return { data: {}, body: src };
  const data = {};
  const lines = (m[1] || '').split(/\r?\n/);
  const indented = (l) => l !== undefined && (/^\s+\S/.test(l) || l.trim() === '');
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z0-9_-]+)[ \t]*:(?:[ \t]+(.*)|[ \t]*)$/.exec(lines[i]);
    if (!kv) continue;
    let val = (kv[2] || '').trim();
    if (/^[|>][+-]?\d*$/.test(val)) {
      const folded = val[0] === '>';
      const block = [];
      while (i + 1 < lines.length && indented(lines[i + 1])) block.push(lines[++i]);
      const ind = Math.min(...block.filter((l) => l.trim()).map((l) => /^\s*/.exec(l)[0].length));
      const parts = block.map((l) => l.slice(Number.isFinite(ind) ? ind : 0));
      val = folded ? parts.join(' ').replace(/\s+/g, ' ').trim() : parts.join('\n').trim();
    } else if (val === '') {
      const block = [];
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) block.push(lines[++i].trim());
      val = block.length && block.every((l) => l.startsWith('- ')) ? block.map((l) => unquote(l.slice(2).trim())) : block.join('\n');
    } else if (/^\[.*\]$/.test(val)) {
      val = val
        .slice(1, -1)
        .split(',')
        .map((x) => unquote(x.trim()))
        .filter(Boolean);
    } else {
      // A plain value may go on over indented lines.
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1]) && !/^["']/.test(val)) val += ` ${lines[++i].trim()}`;
      val = unquote(val);
    }
    data[kv[1]] = val;
  }
  return { data, body: src.slice(m[0].length) };
}

// ---- Skills ----

function readSkillDir(dir) {
  const raw = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8');
  const { data, body } = parseFrontmatter(raw);
  const files = filesIn(dir).filter((f) => f !== 'SKILL.md');
  return {
    name: String(data.name || path.basename(dir)).trim().slice(0, 64),
    description: String(data.description || '').trim().slice(0, 1024),
    license: typeof data.license === 'string' ? data.license.slice(0, 200) : '',
    body,
    dir,
    files,
    scripts: files.filter((f) => SCRIPT.test(f)).length,
  };
}

// Every skill: the user's own and installed ones, then those inside plugins.
export function listSkills() {
  return cached('skills', readSkills);
}

function readSkills() {
  const st = readState();
  const out = [];
  for (const id of dirsIn(SKILLS_DIR)) {
    try {
      const meta = st.skills[id] || {};
      out.push({ id, ...readSkillDir(path.join(SKILLS_DIR, id)), source: meta.source || 'own', at: meta.at || 0, enabled: meta.enabled !== false, plugin: '' });
    } catch {}
  }
  for (const p of listPlugins()) {
    for (const dir of p.skillDirs) {
      try {
        const s = readSkillDir(dir);
        const id = `${p.id}:${slug(path.basename(dir)) || 'skill'}`;
        out.push({ id, ...s, source: 'plugin', at: p.installedAt, enabled: p.enabled && st.skills[id]?.enabled !== false, plugin: p.id, pluginName: p.name });
      } catch {}
    }
  }
  return out;
}

export const publicSkill = ({ body, dir, ...s }) => ({ ...s, editable: s.source === 'own' });

// A skill by its id or its name, among the ones switched on.
export function findSkill(name, { any = false } = {}) {
  const q = String(name || '').trim().replace(/^\//, '');
  if (!q) return null;
  const all = listSkills().filter((s) => any || s.enabled);
  return all.find((s) => s.id === q) || all.find((s) => s.name === q) || all.find((s) => s.id.toLowerCase() === q.toLowerCase() || s.name.toLowerCase() === q.toLowerCase()) || all.find((s) => s.id.split(':').pop() === slug(q)) || null;
}

export function getSkill(id) {
  const s = findSkill(id, { any: true });
  if (!s) throw fail(t('Skill not found.'), 404);
  return { ...publicSkill(s), body: s.body };
}

// The user's own skill: written in Hearth. Renaming moves its folder.
export function saveOwnSkill(id, { name, description, instructions }) {
  const nm = slug(name);
  if (!nm) throw fail(t('Give the skill a name.'));
  const desc = String(description || '').replace(/\s+/g, ' ').trim().slice(0, 1024);
  if (!desc) throw fail(t('Say when the skill should be used: the model picks skills by this description.'));
  const body = String(instructions || '').trim();
  if (!body) throw fail(t('Write the skill’s instructions.'));
  const st = readState();
  const old = id && id !== 'new' ? String(id) : '';
  if (old && (st.skills[old]?.source || 'own') !== 'own') throw fail(t('Only your own skills can be edited here.'));
  // The id becomes a folder name below: only a skill's own kind of name, never a path that leads out of the folder.
  if (old && (slug(old) !== old || !inside(SKILLS_DIR, old))) throw fail(t('Skill not found.'), 404);
  const dir = path.join(SKILLS_DIR, nm);
  if (nm !== old && fs.existsSync(dir)) throw fail(t('A skill named “{name}” already exists.', { name: nm }), 409);
  if (old && nm !== old && fs.existsSync(path.join(SKILLS_DIR, old))) fs.renameSync(path.join(SKILLS_DIR, old), dir);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${nm}\ndescription: ${JSON.stringify(desc)}\n---\n\n${body}\n`);
  forget();
  const meta = st.skills[old] || {};
  if (old && old !== nm) delete st.skills[old];
  st.skills[nm] = { ...meta, source: 'own', enabled: meta.enabled !== false, at: meta.at || Date.now() };
  writeState(st);
  return getSkill(nm);
}

export function setSkillEnabled(id, on) {
  const s = findSkill(id, { any: true });
  if (!s) throw fail(t('Skill not found.'), 404);
  const st = readState();
  st.skills[s.id] = { ...(st.skills[s.id] || {}), enabled: Boolean(on) };
  writeState(st);
}

export function deleteSkill(id) {
  const s = findSkill(id, { any: true });
  if (!s) throw fail(t('Skill not found.'), 404);
  if (s.plugin) throw fail(t('This skill comes with the plugin “{name}”. Turn it off, or remove the plugin.', { name: s.pluginName }));
  fs.rmSync(path.join(SKILLS_DIR, s.id), { recursive: true, force: true });
  forget();
  const st = readState();
  delete st.skills[s.id];
  writeState(st);
}

// For the use_skill tool: the instructions, and the other files the model may read.
export function useSkill(name) {
  const s = findSkill(name);
  if (!s) {
    const have = listSkills().filter((x) => x.enabled).map((x) => x.id);
    throw new Error(have.length ? t('No skill named “{name}”. The skills here: {list}.', { name, list: have.join(', ') }) : t('No skills are switched on.'));
  }
  let out = `# ${s.name}\n\n${s.body.trim()}`;
  if (s.files.length) out += `\n\n${t('Other files of this skill (read one with read_skill_file when the instructions point to it):')}\n${s.files.slice(0, 120).map((f) => `- ${f}`).join('\n')}`;
  if (s.scripts) out += `\n\n${t('Hearth cannot run this skill’s scripts. Do those steps another way, or tell the user what to run.')}`;
  return out.slice(0, MAX_TEXT * 2);
}

export function readSkillFile(name, rel, offset = 0) {
  const s = findSkill(name);
  if (!s) throw new Error(t('No skill named “{name}”.', { name }));
  const file = inside(s.dir, rel);
  if (!file || !fs.statSync(file).isFile()) throw new Error(t('No file “{path}” in this skill.', { path: rel }));
  const buf = fs.readFileSync(file);
  if (buf.subarray(0, 8000).includes(0)) throw new Error(t('This is not a text file or a document Hearth can read.'));
  const text = buf.toString('utf8');
  const part = text.slice(offset, offset + MAX_TEXT);
  const more = offset + MAX_TEXT < text.length;
  return `${part}${more ? `\n\n[${t('More follows: call read_skill_file again with offset {n}.', { n: offset + MAX_TEXT })}]` : ''}`;
}

const oneLine = (s, n) => {
  const x = String(s || '').replace(/\s+/g, ' ').trim();
  return x.length > n ? `${x.slice(0, n - 1).replace(/\s+\S*$/, '')}…` : x;
};

// Up to this many skills (and this much text), the system prompt lists each with its description. With more, it lists
// only their names and the model looks skills up with find_skill: a local model reads every word of the prompt, and
// a list of a hundred descriptions would hold up each answer.
const FULL_LIST_MAX = 25;
const FULL_LIST_CHARS = 7000;

export function skillsMode() {
  const all = listSkills().filter((s) => s.enabled);
  if (!all.length) return 'none';
  const chars = all.reduce((n, s) => n + s.id.length + Math.min(s.description.length, 250) + 4, 0);
  return all.length <= FULL_LIST_MAX && chars <= FULL_LIST_CHARS ? 'full' : 'names';
}

// The skills the model can load, for the system prompt (with tools on).
export function skillsList() {
  const all = listSkills().filter((s) => s.enabled);
  if (!all.length) return '';
  if (skillsMode() === 'full') return `${t('Skills: instructions for special tasks. When a task fits one, call use_skill with its name first, then follow it.')}\n${all.map((s) => `- ${s.id}: ${oneLine(s.description, 250)}`).join('\n')}`;
  const groups = new Map();
  for (const s of all) {
    const k = s.plugin || '';
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(s.id.split(':').pop());
  }
  const lines = [...groups].map(([k, names]) => `- ${k ? `${k}: ` : ''}${names.join(', ')}`);
  return `${t('Skills ({n}): instructions for special tasks. When a task might fit one, call find_skill with a few words about the task to see what the matching skills do, then call use_skill with the right one and follow it.', { n: all.length })}\n${lines.join('\n')}`;
}

// The skills switched on in this chat, in full.
export function activeSkillsPrompt(activeIds = []) {
  const all = listSkills().filter((s) => s.enabled);
  const active = [...new Set(activeIds.map(String))].map((id) => all.find((s) => s.id === id)).filter(Boolean);
  return active.map((s) => `${t('The skill “{name}” is switched on in this chat. Follow its instructions:', { name: s.name })}\n\n${s.body.trim().slice(0, MAX_SKILL_PROMPT)}`).join('\n\n');
}

// For the find_skill tool: the skills that share the most telling words with the query. A word found in only a
// few skills counts for more than one found in most of them ("for", "file"), and a word in the name counts most.
const STOP = new Set('a an and are as at be by can do for from have how i in into is it its me my of on or our so that the their them then this to up use used uses using we what when which with you your и в во на с со по для из от до о об а но или как что это то же ли не все мне мой моя наш'.split(' '));
export function findSkills(query, max = 8) {
  const words = [
    ...new Set(
      String(query || '')
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .filter((w) => w.length > 1 && !STOP.has(w)),
    ),
  ];
  const skills = listSkills().filter((s) => s.enabled);
  const docs = skills.map((s) => ({ s, id: s.id.toLowerCase(), text: `${s.id} ${s.name} ${s.description} ${s.pluginName || ''}`.toLowerCase() }));
  const weight = new Map(words.map((w) => [w, Math.log(1 + docs.length / Math.max(1, docs.filter((d) => d.text.includes(w)).length))]));
  const scored = docs
    .map((d) => ({ s: d.s, score: words.reduce((n, w) => n + ((d.id.includes(w) ? 2 : 0) + (d.text.includes(w) ? 1 : 0)) * weight.get(w), 0) }))
    .filter((x) => x.score >= 1.5)
    .sort((a, b) => b.score - a.score)
    .slice(0, max);
  if (!scored.length) return t('No skill matches “{query}”. Try other words, or answer without a skill.', { query });
  return scored.map(({ s }) => `- ${s.id}: ${oneLine(s.description, 300)}`).join('\n');
}

export function hasSkills() {
  return listSkills().some((s) => s.enabled);
}

// ---- Plugins ----

// The folders a plugin keeps a kind of part in: its manifest may name them, otherwise the usual folder.
function partPaths(dir, manifest, key, fallback) {
  const v = manifest?.[key];
  const list = (Array.isArray(v) ? v : typeof v === 'string' ? [v] : []).map((x) => inside(dir, x)).filter(Boolean);
  const def = inside(dir, fallback);
  return [...new Set([...(def ? [def] : []), ...list])];
}

const mdFilesIn = (p) => {
  try {
    if (fs.statSync(p).isFile()) return /\.md$/i.test(p) ? [{ file: p, prefix: '' }] : [];
    const out = [];
    for (const e of fs.readdirSync(p, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.name.startsWith('.')) continue;
      if (e.isFile() && /\.md$/i.test(e.name) && !/^readme\.md$/i.test(e.name)) out.push({ file: path.join(p, e.name), prefix: '' });
      else if (e.isDirectory()) for (const f of fs.readdirSync(path.join(p, e.name)).sort()) if (/\.md$/i.test(f)) out.push({ file: path.join(p, e.name, f), prefix: `${e.name}:` });
    }
    return out;
  } catch {
    return [];
  }
};

// Skill folders in a plugin: skills/<name>/SKILL.md, or folders the manifest lists.
function pluginSkillDirs(dir, manifest) {
  const out = [];
  for (const p of partPaths(dir, manifest, 'skills', 'skills')) {
    if (fs.existsSync(path.join(p, 'SKILL.md'))) out.push(p);
    else for (const d of dirsIn(p)) if (fs.existsSync(path.join(p, d, 'SKILL.md'))) out.push(path.join(p, d));
  }
  return [...new Set(out)];
}

// The connectors (MCP servers) a plugin brings: from its manifest or .mcp.json, in either shape.
export function pluginMcp(dir, manifest) {
  let raw = manifest?.mcpServers;
  if (typeof raw === 'string') raw = readJsonSafe(inside(dir, raw) || '');
  if (!raw || typeof raw !== 'object') raw = readJsonSafe(path.join(dir, '.mcp.json'));
  if (!raw || typeof raw !== 'object') return {};
  const list = raw.mcpServers && typeof raw.mcpServers === 'object' ? raw.mcpServers : raw;
  const out = {};
  for (const [name, cfg] of Object.entries(list)) if (cfg && typeof cfg === 'object' && (cfg.command || cfg.url)) out[name] = cfg;
  return out;
}

// "${NAME}" in a connector's settings: the plugin's folder, a value the user typed, or the computer's setting.
const VAR = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;
export function connectorNeeds(cfg) {
  const names = new Set();
  JSON.stringify(cfg).replace(VAR, (_, n, def) => (n !== 'CLAUDE_PLUGIN_ROOT' && def === undefined && names.add(n), ''));
  return [...names];
}

export function fillConnector(cfg, values) {
  const missing = new Set();
  const fill = (v) => {
    if (typeof v === 'string')
      return v.replace(VAR, (_, n, def) => {
        const got = values[n] ?? process.env[n];
        if (got != null && got !== '') return got;
        if (def !== undefined) return def;
        missing.add(n);
        return '';
      });
    if (Array.isArray(v)) return v.map(fill);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x)]));
    return v;
  };
  return { cfg: fill(cfg), missing: [...missing] };
}

// What a connector does, in a few words: the program it starts or the address it talks to.
export function connectorWhat(cfg) {
  if (cfg.url) return String(cfg.url).replace(/\?.*$/, '');
  return [cfg.command, ...(Array.isArray(cfg.args) ? cfg.args : [])].join(' ').slice(0, 200);
}

export function describePluginDir(dir) {
  const manifest = readJsonSafe(path.join(dir, '.claude-plugin', 'plugin.json')) || {};
  const author = typeof manifest.author === 'string' ? manifest.author : manifest.author?.name || '';
  const commands = partPaths(dir, manifest, 'commands', 'commands').flatMap(mdFilesIn);
  const agents = partPaths(dir, manifest, 'agents', 'agents').flatMap(mdFilesIn);
  return {
    manifest,
    name: String(manifest.name || path.basename(dir)).slice(0, 80),
    description: String(manifest.description || '').slice(0, 500),
    version: String(manifest.version || '').slice(0, 30),
    author: String(author).slice(0, 80),
    homepage: String(manifest.homepage || manifest.repository || '').slice(0, 200),
    skillDirs: pluginSkillDirs(dir, manifest),
    commandFiles: commands,
    agentFiles: agents,
    mcp: pluginMcp(dir, manifest),
    hooks: Boolean(manifest.hooks) || fs.existsSync(path.join(dir, 'hooks', 'hooks.json')),
  };
}

export function listPlugins() {
  return cached('plugins', readPlugins);
}

function readPlugins() {
  const st = readState();
  return dirsIn(PLUGINS_DIR).map((id) => {
    const dir = path.join(PLUGINS_DIR, id);
    const meta = st.plugins[id] || {};
    return { id, dir, ...describePluginDir(dir), source: meta.source || '', enabled: meta.enabled !== false, installedAt: meta.at || 0, values: meta.values || {}, connectorsOn: meta.connectors || {} };
  });
}

export function publicPlugin(p) {
  return {
    id: p.id,
    name: p.name,
    description: p.description,
    version: p.version,
    author: p.author,
    homepage: p.homepage,
    source: p.source,
    enabled: p.enabled,
    installedAt: p.installedAt,
    skills: p.skillDirs.map((d) => path.basename(d)),
    commands: p.commandFiles.map((c) => c.prefix + path.basename(c.file, '.md')),
    agents: p.agentFiles.map((a) => parseFrontmatter(fs.readFileSync(a.file, 'utf8')).data.name || path.basename(a.file, '.md')),
    hooks: p.hooks,
    connectors: Object.entries(p.mcp).map(([name, cfg]) => ({
      name,
      on: Boolean(p.connectorsOn[name]),
      kind: cfg.url ? 'http' : 'program',
      what: connectorWhat(cfg).replaceAll('${CLAUDE_PLUGIN_ROOT}', '…'),
      needs: connectorNeeds(cfg),
    })),
    values: Object.fromEntries(Object.keys(p.values).map((k) => [k, true])), // which values are set; never the values
  };
}

const findPlugin = (id) => {
  const p = listPlugins().find((x) => x.id === id);
  if (!p) throw fail(t('Plugin not found.'), 404);
  return p;
};

// Switch a plugin on or off, switch one of its connectors, or store values its connectors need (a key, say).
export function updatePlugin(id, { enabled, connector, connectorOn, values } = {}) {
  const p = findPlugin(id);
  const st = readState();
  const meta = { ...(st.plugins[id] || {}) };
  if (typeof enabled === 'boolean') meta.enabled = enabled;
  if (connector) {
    if (!p.mcp[connector]) throw fail(t('No connector named {name}.', { name: connector }), 404);
    meta.connectors = { ...(meta.connectors || {}), [connector]: Boolean(connectorOn) };
  }
  if (values && typeof values === 'object') {
    const next = { ...(meta.values || {}) };
    for (const [k, v] of Object.entries(values)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(k)) continue;
      if (v == null || v === '') delete next[k];
      else next[k] = String(v).slice(0, 2000);
    }
    meta.values = next;
  }
  st.plugins[id] = meta;
  writeState(st);
  return publicPlugin(findPlugin(id));
}

export function removePlugin(id) {
  const p = findPlugin(id);
  fs.rmSync(p.dir, { recursive: true, force: true });
  forget();
  const st = readState();
  delete st.plugins[id];
  for (const k of Object.keys(st.skills)) if (k.startsWith(`${id}:`)) delete st.skills[k];
  st.commandsOff = st.commandsOff.filter((c) => !c.startsWith(`${id}:`));
  writeState(st);
}

// For the MCP client: the connectors of plugins that are on, which the user switched on, with values filled in.
export function pluginConnectors() {
  const out = {};
  for (const p of listPlugins()) {
    if (!p.enabled) continue;
    for (const [name, cfg] of Object.entries(p.mcp)) {
      if (!p.connectorsOn[name]) continue;
      const { cfg: filled, missing } = fillConnector(cfg, { ...p.values, CLAUDE_PLUGIN_ROOT: p.dir });
      if (missing.length) continue;
      out[`${p.id}:${name}`] = { ...filled, cwd: filled.cwd || p.dir };
    }
  }
  return out;
}

// Assistants from plugins' agents/ files (read-only; ids are short so chats can keep them).
export function pluginAgents() {
  const out = [];
  for (const p of listPlugins()) {
    if (!p.enabled) continue;
    for (const a of p.agentFiles) {
      try {
        const { data, body } = parseFrontmatter(fs.readFileSync(a.file, 'utf8'));
        const name = String(data.name || path.basename(a.file, '.md')).slice(0, 80);
        out.push({
          id: `p-${crypto.createHash('sha1').update(`${p.id}/${a.prefix}${name}`).digest('hex').slice(0, 12)}`,
          icon: 'puzzle',
          name,
          description: String(data.description || '').replace(/\s+/g, ' ').slice(0, 200),
          instructions: body.trim().slice(0, 20000),
          starter: '',
          builtin: false,
          plugin: p.name,
          readonly: true,
        });
      } catch {}
    }
  }
  return out;
}

// ---- Commands ----

const CMD_NAME = /^[\p{L}\p{N}_:-]{1,48}$/u;

// Every command: the user's own, then those from plugins that are on. Plugin commands keep their short name
// unless another command already has it; then they are "plugin:name".
export function listCommands() {
  const st = readState();
  const out = st.commands.map((c) => ({ ...c, source: 'own', enabled: c.enabled !== false, plugin: '' }));
  const taken = new Set(out.map((c) => c.name));
  for (const p of listPlugins()) {
    for (const { file, prefix } of p.commandFiles) {
      try {
        const { data, body } = parseFrontmatter(fs.readFileSync(file, 'utf8'));
        const base = `${prefix}${slug(path.basename(file, '.md'))}`;
        const id = `${p.id}:${base}`;
        const name = taken.has(base) ? id : base;
        taken.add(name);
        out.push({
          id,
          name,
          description: String(data.description || body.trim().split('\n')[0] || '').replace(/^#+\s*/, '').slice(0, 200),
          // "argument-hint: [order]" reads as a YAML list; show it the way it was written.
          hint: (Array.isArray(data['argument-hint']) ? `[${data['argument-hint'].join(', ')}]` : String(data['argument-hint'] || '')).slice(0, 120),
          prompt: body.trim(),
          source: 'plugin',
          plugin: p.id,
          pluginName: p.name,
          enabled: p.enabled && !st.commandsOff.includes(id),
        });
      } catch {}
    }
  }
  return out;
}

export function saveCommand(id, { name, description, prompt }) {
  const nm = slug(name).replace(/:/g, '-');
  if (!nm || !CMD_NAME.test(nm)) throw fail(t('Give the command a short name: letters, digits and dashes.'));
  const text = String(prompt || '').trim();
  if (!text) throw fail(t('Write what the command should ask the model.'));
  const st = readState();
  const others = listCommands().filter((c) => c.id !== id && c.source === 'own');
  if (others.some((c) => c.name === nm)) throw fail(t('A command named “/{name}” already exists.', { name: nm }), 409);
  const rec = { id: id && id !== 'new' ? id : `c-${uid(8)}`, name: nm, description: String(description || '').trim().slice(0, 200), prompt: text.slice(0, 20000) };
  const i = st.commands.findIndex((c) => c.id === rec.id);
  if (i >= 0) st.commands[i] = { ...st.commands[i], ...rec };
  else st.commands.push({ ...rec, enabled: true });
  writeState(st);
  return rec;
}

export function setCommandEnabled(id, on) {
  const st = readState();
  const own = st.commands.find((c) => c.id === id);
  if (own) own.enabled = Boolean(on);
  else {
    if (!listCommands().some((c) => c.id === id)) throw fail(t('Command not found.'), 404);
    st.commandsOff = on ? st.commandsOff.filter((c) => c !== id) : [...new Set([...st.commandsOff, id])];
  }
  writeState(st);
}

export function deleteCommand(id) {
  const st = readState();
  const before = st.commands.length;
  st.commands = st.commands.filter((c) => c.id !== id);
  if (st.commands.length === before) throw fail(t('Only your own commands can be deleted. Turn a plugin’s command off instead.'));
  writeState(st);
}

// What the chat's "/" menu offers: commands, then skills (a skill switched on with "/name" stays on in that chat).
export function slashMenu() {
  const items = listCommands()
    .filter((c) => c.enabled)
    .map((c) => ({ kind: 'command', name: c.name, description: c.description, hint: c.hint || '', prompt: c.prompt, plugin: c.pluginName || '' }));
  const taken = new Set(items.map((i) => i.name));
  for (const s of listSkills().filter((x) => x.enabled)) {
    // A plugin's skill is typed by its short name unless something else already has it.
    const short = s.id.split(':').pop();
    const name = taken.has(short) ? s.id : short;
    if (taken.has(name)) continue;
    taken.add(name);
    items.push({ kind: 'skill', name, id: s.id, title: s.name, description: s.description.replace(/\s+/g, ' ').slice(0, 200), plugin: s.pluginName || '' });
  }
  return items;
}

// A Hearth package can bring extensions along: the Windows package can carry the ones from the user's Mac (see
// windows/package.sh --with-extensions). They are copied in on the first start, when this computer has none yet,
// and never again, so updating the app later never undoes what the user changed. Keys and sign-ins never travel.
export function seedExtensions(from = process.env.HEARTH_SEED_DIR || path.join(ROOT, 'seed', 'extensions')) {
  try {
    if (!fs.existsSync(path.join(from, 'state.json'))) return false;
    if (fs.existsSync(STATE_FILE) || dirsIn(SKILLS_DIR).length || dirsIn(PLUGINS_DIR).length) return false;
    fs.cpSync(from, DIRS.extensions, { recursive: true });
    forget();
    return true;
  } catch {
    return false;
  }
}
seedExtensions();
