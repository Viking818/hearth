// Tools the chat's model may use: search the web, open a page, read the folders the user allowed (never write),
// remember a fact, read skills, and any tools from MCP servers (connectors). The page runs the loop; each call comes here.
// Connectors can bring many tools with long instructions (Notion: 77 tools, about 78,000 tokens), and a local model
// reads all of them before every answer. Past a limit, the chat gets their names only, plus find_tool (a tool's
// instructions and arguments, when needed) and use_tool (runs it), the same way it handles a long list of skills.
import fs from 'node:fs';
import path from 'node:path';
import { getSettings } from './settings.mjs';
import { webSearch, openPage, loadPdfjs } from './web.mjs';
import { addMemory } from './assistants.mjs';
import { ensureMcp, mcpTools, mcpServers, callMcp } from './mcp.mjs';
import { hasSkills, skillsMode, useSkill, readSkillFile, findSkills } from './extensions.mjs';
import { t } from './i18n.mjs';

export const MAX_RESULT = 24000;

const BUILTIN = [
  {
    name: 'web_search',
    title: 'Search the web',
    icon: 'search',
    needs: 'web',
    description: 'Search the internet. Returns titles, links and short snippets. Use it for current facts, prices, news, or anything you are not sure about, then open_page to read the best results.',
    parameters: { type: 'object', properties: { query: { type: 'string', description: 'What to search for, in the most useful language' } }, required: ['query'] },
  },
  {
    name: 'open_page',
    title: 'Open a web page',
    icon: 'globe',
    needs: 'web',
    description: 'Read the text of a public web page or PDF (http or https). Use it for links the user gives and for search results. Pages built by scripts are opened with a browser of this computer; pages behind a sign-in cannot be read. Long pages come in parts: pass offset to read on.',
    parameters: { type: 'object', properties: { url: { type: 'string' }, offset: { type: 'integer', description: 'Character offset to continue a long page' } }, required: ['url'] },
  },
  {
    name: 'list_folder',
    title: 'List files',
    icon: 'folder',
    needs: 'files',
    description: 'List the files and folders inside one of the folders the user allowed. Without a path it lists the allowed folders themselves.',
    parameters: { type: 'object', properties: { path: { type: 'string', description: 'A folder path from an earlier answer; leave empty for the allowed folders' } } },
  },
  {
    name: 'find_files',
    title: 'Find files',
    icon: 'search',
    needs: 'files',
    description: 'Find files whose names contain some text, inside the allowed folders.',
    parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  },
  {
    name: 'read_file',
    title: 'Read a file',
    icon: 'file-text',
    needs: 'files',
    description: 'Read a text file or a document (PDF, Word, Excel, PowerPoint) from the allowed folders. Long files come in parts: pass offset to read on.',
    parameters: { type: 'object', properties: { path: { type: 'string' }, offset: { type: 'integer' } }, required: ['path'] },
  },
  {
    name: 'remember',
    title: 'Remember',
    icon: 'brain',
    needs: 'memory',
    description: 'Save one short fact about the user or their business for future chats. Use it when the user asks you to remember something or states a lasting preference. Do not save secrets like passwords.',
    parameters: { type: 'object', properties: { fact: { type: 'string', description: 'The fact, in one sentence, in the user’s language' } }, required: ['fact'] },
  },
  {
    name: 'find_tool',
    title: 'Find a connector tool',
    icon: 'search',
    needs: 'many-tools',
    description: 'Look up the tools of the connectors (other programs and services) by a few words about what you need, or by a tool’s name from the list in the system prompt. Returns the matching tools with what each does and its arguments; then run one with use_tool.',
    parameters: { type: 'object', properties: { query: { type: 'string', description: 'A few words about the task, or a tool’s name' } }, required: ['query'] },
  },
  {
    name: 'use_tool',
    title: 'Use a connector tool',
    icon: 'plug',
    needs: 'many-tools',
    description: 'Run one of the connector tools that find_tool showed, with the arguments it described.',
    parameters: { type: 'object', properties: { name: { type: 'string', description: 'The tool’s name, as find_tool gave it' }, arguments: { type: 'object', description: 'The tool’s arguments' } }, required: ['name'] },
  },
  {
    name: 'find_skill',
    title: 'Find a skill',
    icon: 'search',
    needs: 'many-skills',
    description: 'Search the skills by a few words about the task (English words work best). Returns the matching skills and what each is for; then load the right one with use_skill.',
    parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  },
  {
    name: 'use_skill',
    title: 'Use a skill',
    icon: 'puzzle',
    needs: 'skills',
    description: 'Load the instructions of one of the skills listed in the system prompt. Call it before starting a task that a skill fits, then follow the instructions.',
    parameters: { type: 'object', properties: { name: { type: 'string', description: 'The skill’s name as listed' } }, required: ['name'] },
  },
  {
    name: 'read_skill_file',
    title: 'Read a skill’s file',
    icon: 'file-text',
    needs: 'skills',
    description: 'Read another file of a skill (a reference, an example or a template) when its instructions point to it. Long files come in parts: pass offset to read on.',
    parameters: { type: 'object', properties: { skill: { type: 'string' }, path: { type: 'string', description: 'The file’s path inside the skill, as use_skill listed it' }, offset: { type: 'integer' } }, required: ['skill', 'path'] },
  },
];

// One built-in tool as the model sees it (bots pick their own set).
export function builtinSchema(name) {
  const x = BUILTIN.find((b) => b.name === name);
  return x ? { name: x.name, title: x.title, icon: x.icon, schema: { type: 'function', function: { name: x.name, description: x.description, parameters: x.parameters } } } : null;
}

function available(tool, s) {
  if (tool.needs === 'web') return true;
  if (tool.needs === 'files') return s.toolFolders.length > 0;
  if (tool.needs === 'memory') return s.memoryOn;
  if (tool.needs === 'skills') return hasSkills();
  if (tool.needs === 'many-skills') return skillsMode() === 'names';
  if (tool.needs === 'many-tools') return connectorToolsMode() === 'lookup';
  return true;
}

// ---- Connector tools: all at once while they are few and short, otherwise names only and find_tool ----

const TOOLS_FULL_MAX = 20;
const TOOLS_FULL_CHARS = 24000; // about 6,000 tokens of instructions and arguments

const toolChars = (m) => m.name.length + Math.min(m.description.length, 2000) + JSON.stringify(m.parameters || {}).length;

export function connectorToolsMode() {
  const all = mcpTools();
  if (!all.length) return 'none';
  return all.length <= TOOLS_FULL_MAX && all.reduce((n, m) => n + toolChars(m), 0) <= TOOLS_FULL_CHARS ? 'full' : 'lookup';
}

// For the system prompt, in lookup mode: every connector's tool names (the same connector in several plugins once).
export function connectorToolsList() {
  const groups = new Map();
  for (const m of mcpTools()) {
    const k = m.url || m.server;
    if (!groups.has(k)) groups.set(k, { server: m.server, names: [] });
    if (groups.get(k).server === m.server) groups.get(k).names.push(m.tool);
  }
  if (!groups.size) return '';
  const lines = [...groups.values()].map((g) => `- ${g.server}: ${g.names.join(', ')}`);
  const n = [...groups.values()].reduce((x, g) => x + g.names.length, 0);
  return `${t('Connector tools ({n}), from other programs and services. Their instructions are left out to keep messages short: call find_tool with a few words about what you need (or a tool’s name) to see the matching tools and their arguments, then run one with use_tool.', { n })}\n${lines.join('\n')}`;
}

// A tool's arguments, shortened until they fit: long explanations inside go first, the shape stays.
export function compactSchema(schema, budget) {
  const full = JSON.stringify(schema || {});
  if (full.length <= budget) return full;
  const DROP = new Set(['examples', 'example', 'default', '$schema', 'title', '$comment', 'additionalProperties']);
  const shrink = (v, keep, depth = 0) => {
    if (Array.isArray(v)) return v.slice(0, 40).map((x) => shrink(x, keep, depth + 1));
    if (!v || typeof v !== 'object') return v;
    const out = {};
    for (const [k, x] of Object.entries(v)) {
      if (DROP.has(k)) continue;
      if (k === 'description') {
        if (typeof x === 'string' && depth <= keep) out[k] = x.length > 160 ? `${x.slice(0, 159)}…` : x;
        continue;
      }
      out[k] = shrink(x, keep, depth + 1);
    }
    return out;
  };
  for (const keep of [99, 3, -1]) {
    const s = JSON.stringify(shrink(schema, keep));
    if (s.length <= budget) return s;
  }
  return `${JSON.stringify(shrink(schema, -1)).slice(0, budget)}… [${t('cut short: call find_tool with this tool’s exact name to see all of it')}]`;
}

const toolEntry = (m, descMax, argsMax) => {
  const d = m.description.replace(/\s+\n/g, '\n').trim();
  return `### ${m.name} (${m.server})\n${d.length > descMax ? `${d.slice(0, descMax - 1)}…` : d || m.title}\n${t('Arguments')}: ${compactSchema(m.parameters, argsMax)}`;
};

// For the find_tool tool: a tool asked for by name in full, or the tools that share the most telling words with the query.
export function findConnectorTools(query, max = 5) {
  const q = String(query || '').trim();
  const all = mcpTools();
  if (!all.length) return t('No connector tools are ready.');
  const exact = all.filter((m) => m.name === q || m.tool === q || `${m.server}:${m.tool}` === q);
  if (exact.length) return exact.slice(0, 2).map((m) => toolEntry(m, 6000, 12000)).join('\n\n');
  const words = [...new Set(q.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 1))];
  const docs = all.map((m) => ({ m, name: `${m.tool} ${m.title}`.toLowerCase(), text: `${m.tool} ${m.title} ${m.server} ${m.description}`.toLowerCase() }));
  const weight = new Map(words.map((w) => [w, Math.log(1 + docs.length / Math.max(1, docs.filter((d) => d.text.includes(w)).length))]));
  const seen = new Set();
  const found = docs
    .map((d) => ({ m: d.m, score: words.reduce((n, w) => n + ((d.name.includes(w) ? 2 : 0) + (d.text.includes(w) ? 1 : 0)) * weight.get(w), 0) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .filter((x) => {
      const k = `${x.m.url || x.m.server}|${x.m.tool}`; // the same tool from the same service once
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .slice(0, max);
  if (!found.length) return t('No connector tool matches “{query}”. Try other words, or pick a name from the list.', { query: q });
  let out = '';
  for (const { m } of found) {
    const entry = toolEntry(m, 700, 3500);
    if (out && out.length + entry.length > MAX_RESULT) break;
    out += `${out ? '\n\n' : ''}${entry}`;
  }
  return out;
}

// The connector tool use_tool names: its full name, or its own name when that is clear.
function connectorTool(name) {
  const n = String(name || '').trim();
  const all = mcpTools();
  const exact = all.find((m) => m.name === n || `${m.server}:${m.tool}` === n);
  if (exact) return exact;
  const same = all.filter((m) => m.tool === n);
  if (same.length && new Set(same.map((m) => m.url || m.server)).size === 1) return same[0];
  if (same.length) throw new Error(t('Several connectors have a tool named “{name}”: {list}. Use one of these names.', { name: n, list: same.map((m) => m.name).join(', ') }));
  throw new Error(t('No connector tool named “{name}”. Call find_tool to see the tools.', { name: n }));
}

// What the chat offers the model. In lookup mode the connector tools come without `schema`: the page doesn't send them,
// but still knows their titles, and asks before use_tool runs one.
export async function listTools() {
  const s = getSettings();
  if (!s.toolsOn) return { tools: [], servers: [], lookup: false };
  await ensureMcp().catch(() => {});
  const lookup = connectorToolsMode() === 'lookup';
  const tools = BUILTIN.filter((x) => available(x, s)).map((x) => ({
    name: x.name,
    title: t(x.title),
    icon: x.icon,
    source: 'builtin',
    ask: x.name === 'use_tool' && s.toolApproval !== 'auto',
    schema: { type: 'function', function: { name: x.name, description: x.description, parameters: x.parameters } },
  }));
  for (const m of mcpTools()) {
    if (tools.some((x) => x.name === m.name)) continue;
    tools.push({
      name: m.name,
      title: m.title,
      icon: 'plug',
      source: 'mcp',
      server: m.server,
      tool: m.tool,
      ask: s.toolApproval !== 'auto',
      ...(lookup ? {} : { schema: { type: 'function', function: { name: m.name, description: `${m.description}`.slice(0, 2000) || m.title, parameters: m.parameters } } }),
    });
  }
  return { tools, servers: mcpServers(), lookup };
}

// ---- Files: only inside the allowed folders, after resolving links ----

export function allowedRoots() {
  return getSettings()
    .toolFolders.map((d) => {
      try {
        return fs.realpathSync(d);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function insideAllowed(p) {
  if (!p) throw new Error(t('Give a path.'));
  const rs = allowedRoots();
  let target;
  try {
    target = fs.realpathSync(path.isAbsolute(p) || !rs[0] ? p : path.join(rs[0], p));
  } catch {
    throw new Error(t('Not found: {path}', { path: p }));
  }
  if (!rs.some((r) => target === r || target.startsWith(r + path.sep))) throw new Error(t('That path is outside the folders you allowed in Settings → Tools.'));
  return target;
}

function listFolder(p) {
  if (!p) return { folders: allowedRoots() };
  const dir = insideAllowed(p);
  const items = [];
  for (const name of fs.readdirSync(dir).sort()) {
    if (name.startsWith('.')) continue;
    try {
      const st = fs.statSync(path.join(dir, name));
      items.push(st.isDirectory() ? { name: `${name}/`, path: path.join(dir, name) } : { name, path: path.join(dir, name), size: st.size, modified: new Date(st.mtimeMs).toISOString().slice(0, 16).replace('T', ' ') });
    } catch {}
    if (items.length >= 300) break;
  }
  return { folder: dir, items };
}

function findFiles(query) {
  const q = String(query || '').toLowerCase().trim();
  if (!q) throw new Error(t('Say what to look for.'));
  const out = [];
  let seen = 0;
  const walk = (dir, depth) => {
    if (depth > 8 || out.length >= 60 || seen > 20000) return;
    let names = [];
    try {
      names = fs.readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (name.startsWith('.') || name === 'node_modules') continue;
      seen++;
      const full = path.join(dir, name);
      let st;
      try {
        st = fs.lstatSync(full);
      } catch {
        continue;
      }
      if (name.toLowerCase().includes(q)) out.push(st.isDirectory() ? `${full}/` : full);
      if (st.isDirectory() && !st.isSymbolicLink()) walk(full, depth + 1);
      if (out.length >= 60) return;
    }
  };
  for (const r of allowedRoots()) walk(r, 0);
  return out;
}

const TEXT_EXT = /\.(txt|md|markdown|csv|tsv|json|jsonl|js|mjs|cjs|ts|tsx|jsx|py|rb|go|rs|java|kt|swift|c|h|cpp|hpp|cs|php|html|htm|css|scss|xml|svg|yaml|yml|toml|ini|cfg|conf|log|sh|bat|ps1|sql|r|lua|vue|svelte|rtf|srt|vtt|tex)$/i;

async function readFileTool(p, offset = 0) {
  const file = insideAllowed(p);
  if (fs.statSync(file).isDirectory()) return listFolder(file);
  return readResolved(file, offset);
}

// Reads a file whose path was already checked: text as is, documents (PDF, Word, Excel, PowerPoint) as their text.
export async function readResolved(file, offset = 0, tool = 'read_file') {
  const st = fs.statSync(file);
  let text;
  const { DOC_EXT, extractDocument } = await import('../public/js/docs.js');
  if (DOC_EXT.test(file)) {
    if (st.size > 200 << 20) throw new Error(t('This file is too big to read.'));
    const bytes = new Uint8Array(fs.readFileSync(file));
    const doc = await extractDocument(path.basename(file), bytes, { pdfjs: /\.pdf$/i.test(file) ? await loadPdfjs() : null });
    text = doc.text;
    if (doc.scanned) text += `\n\n[${t('This PDF has no text in it: its pages are pictures (a scan or a photo). Its words cannot be read this way. Say so to the user.')}]`;
  } else if (TEXT_EXT.test(file) || st.size < 2e6) {
    const buf = fs.readFileSync(file);
    if (buf.subarray(0, 8000).includes(0)) throw new Error(t('This is not a text file or a document Hearth can read.'));
    text = buf.toString('utf8');
  } else throw new Error(t('This is not a text file or a document Hearth can read.'));
  const part = text.slice(offset, offset + MAX_RESULT);
  const more = offset + MAX_RESULT < text.length;
  return `${part}${more ? `\n\n[${t('More follows: call {tool} again with offset {n}.', { tool, n: offset + MAX_RESULT })}]` : ''}`;
}

// ---- One call ----

// anyway: a bot's own tool switches apply instead of the chat's Tools switch in Settings.
export async function callTool(name, args = {}, { anyway = false } = {}) {
  const s = getSettings();
  if (!s.toolsOn && !anyway) throw new Error(t('Tools are turned off in Settings.'));
  const a = args && typeof args === 'object' ? args : {};
  switch (name) {
    case 'web_search': {
      const results = await webSearch(a.query);
      if (!results.length) return t('Nothing found.');
      return (results.note ? `${results.note}\n\n` : '') + results.map((r, i) => `${i + 1}. ${r.title}\n${r.url}\n${r.snippet}`).join('\n\n');
    }
    case 'open_page': {
      const p = await openPage(a.url, { offset: Number(a.offset) || 0 });
      const note = p.scanned
        ? t('This PDF has no text in it: its pages are pictures (a scan or a photo). Its words cannot be read this way. Say so to the user.')
        : p.thin
          ? t('This page shows almost nothing to a visitor who is not signed in (or it could not be opened fully). Do not guess what it holds: tell the user, and ask for the file or the text if you need it.')
          : '';
      return `${p.title ? `# ${p.title}\n` : ''}${p.url}\n\n${p.text}${note ? `\n\n[${note}]` : ''}${p.more ? `\n\n[${t('More follows: call open_page again with offset {n}.', { n: p.nextOffset })}]` : ''}`;
    }
    case 'list_folder':
      return JSON.stringify(listFolder(a.path), null, 1).slice(0, MAX_RESULT);
    case 'find_files': {
      const found = findFiles(a.query);
      return found.length ? found.join('\n') : t('Nothing found.');
    }
    case 'read_file':
      return readFileTool(a.path, Number(a.offset) || 0);
    case 'find_tool':
      return findConnectorTools(a.query);
    case 'use_tool': {
      const m = connectorTool(a.name);
      let args2 = a.arguments ?? {};
      if (typeof args2 === 'string') {
        try {
          args2 = args2.trim() ? JSON.parse(args2) : {};
        } catch {
          throw new Error(t('The arguments for use_tool must be a JSON object.'));
        }
      }
      const r = await callMcp(m.server, m.tool, args2 && typeof args2 === 'object' && !Array.isArray(args2) ? args2 : {});
      if (r.isError) throw new Error(r.text || t('The tool reported an error.'));
      return r.text.slice(0, MAX_RESULT * 2) || t('(the tool returned nothing)');
    }
    case 'find_skill':
      return findSkills(a.query);
    case 'use_skill':
      return useSkill(a.name);
    case 'read_skill_file':
      return readSkillFile(a.skill || a.name, a.path, Number(a.offset) || 0);
    case 'remember': {
      if (!s.memoryOn) throw new Error(t('Memory is turned off in Settings.'));
      const f = addMemory(a.fact);
      return t('Saved to memory: {fact}', { fact: f.text });
    }
    default: {
      const m = mcpTools().find((x) => x.name === name);
      if (!m) throw new Error(t('Unknown tool: {name}', { name }));
      const r = await callMcp(m.server, m.tool, a);
      if (r.isError) throw new Error(r.text || t('The tool reported an error.'));
      return r.text.slice(0, MAX_RESULT * 2) || t('(the tool returned nothing)');
    }
  }
}
