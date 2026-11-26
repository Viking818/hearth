// Getting skills and plugins: from a GitHub link, a .zip file (also .skill or .plugin), or a folder on this
// computer. First Hearth looks inside and shows what is there; then it installs what the user picks.
// GitHub collections of plugins ("marketplaces", .claude-plugin/marketplace.json) list plugins to choose from.
import fs from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import { DIRS } from './settings.mjs';
import { uid } from './util.mjs';
import { t } from './i18n.mjs';
import { extract } from './engine-install.mjs';
import { SKILLS_DIR, PLUGINS_DIR, readState, writeState, forget, slug, parseFrontmatter, inside, readJsonSafe, describePluginDir, connectorWhat, connectorNeeds } from './extensions.mjs';

const MAX_DOWNLOAD = 150 << 20;
const MAX_FILES = 4000;
const MAX_BYTES = 200 << 20;
const pending = new Map(); // token → { tmp, root, source, found, at }

const fail = (msg, status = 400) => Object.assign(new Error(msg), { status });

// github.com/owner/repo, …/tree/branch/folder, …/blob/branch/folder/SKILL.md, or just owner/repo.
export function parseGithub(input) {
  const s = String(input || '')
    .trim()
    .replace(/[?#].*$/, '')
    .replace(/\/+$/, '');
  let m = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:\/(tree|blob)\/([^/]+)(?:\/(.+))?)?$/i.exec(s);
  if (m) {
    let sub = m[5] ? decodeURIComponent(m[5]) : '';
    if (m[3] === 'blob') sub = path.posix.dirname(sub) === '.' ? '' : path.posix.dirname(sub); // a link to a file: its folder
    sub = sub.replace(/(^|\/)\.claude-plugin$/, '');
    return { owner: m[1], repo: m[2], ref: m[4] || '', sub };
  }
  m = /^([\w-][\w.-]*)\/([\w-][\w.-]*)$/.exec(s);
  return m ? { owner: m[1], repo: m[2], ref: '', sub: '' } : null;
}

async function download(url, file) {
  let res;
  try {
    res = await fetch(url, { headers: { 'user-agent': 'Hearth' }, redirect: 'follow', signal: AbortSignal.timeout(5 * 60e3) });
  } catch (err) {
    throw fail(t('Could not reach GitHub: {msg}', { msg: err.cause?.code || err.message }), 502);
  }
  if (res.status === 404) throw fail(t('Not found on GitHub. Check the link; private repositories can’t be used.'), 404);
  if (!res.ok) throw fail(t('GitHub answered with an error ({status}).', { status: res.status }), 502);
  if (Number(res.headers.get('content-length') || 0) > MAX_DOWNLOAD) throw fail(t('This repository is too big to install (over 150 MB).'), 413);
  const out = fs.createWriteStream(file);
  let got = 0;
  try {
    for await (const chunk of res.body) {
      got += chunk.length;
      if (got > MAX_DOWNLOAD) throw fail(t('This repository is too big to install (over 150 MB).'), 413);
      if (!out.write(chunk)) await once(out, 'drain');
    }
  } finally {
    await new Promise((resolve) => out.end(resolve));
  }
}

const isRoot = (d) => ['SKILL.md', '.claude-plugin', '.mcp.json'].some((n) => fs.existsSync(path.join(d, n)));

// Unpack, then step into the one folder most archives wrap everything in (GitHub always does).
async function unpack(archive, dest, levels) {
  fs.mkdirSync(dest, { recursive: true });
  try {
    await extract(archive, dest);
  } catch {
    throw fail(t('Could not open this file. Use a .zip file.'), 422);
  }
  let root = dest;
  for (let i = 0; i < levels; i++) {
    if (isRoot(root)) break;
    const entries = fs.readdirSync(root).filter((n) => !n.startsWith('.') && n !== '__MACOSX');
    if (entries.length !== 1 || !fs.statSync(path.join(root, entries[0])).isDirectory()) break;
    root = path.join(root, entries[0]);
  }
  return root;
}

async function fetchGithub(gh, tmp) {
  fs.mkdirSync(tmp, { recursive: true });
  const zip = path.join(tmp, 'repo.zip');
  const ref = gh.ref ? gh.ref.split('/').map(encodeURIComponent).join('/') : 'HEAD';
  await download(`https://github.com/${gh.owner}/${gh.repo}/archive/${ref}.zip`, zip);
  const top = await unpack(zip, path.join(tmp, 'x'), 1);
  fs.rmSync(zip, { force: true });
  if (!gh.sub) return top;
  const sub = inside(top, gh.sub);
  if (!sub || !fs.statSync(sub).isDirectory()) throw fail(t('That folder isn’t in the repository: {path}', { path: gh.sub }), 404);
  return sub;
}

// ---- What is there ----

function skillInfo(dir) {
  const { data } = parseFrontmatter(fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8'));
  return { dir, name: String(data.name || path.basename(dir)).slice(0, 64), description: String(data.description || '').replace(/\s+/g, ' ').slice(0, 400) };
}

function findSkillDirs(root) {
  const out = [];
  const walk = (d, depth) => {
    if (depth > 4 || out.length >= 100) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (!e.isDirectory() || e.name.startsWith('.') || e.name === 'node_modules') continue;
      const full = path.join(d, e.name);
      if (fs.existsSync(path.join(full, 'SKILL.md'))) out.push(full);
      else walk(full, depth + 1);
    }
  };
  walk(root, 0);
  return out.sort();
}

const isPlugin = (d) => fs.existsSync(path.join(d, '.claude-plugin', 'plugin.json')) || ['commands', 'agents', '.mcp.json'].some((x) => fs.existsSync(path.join(d, x)));

function pluginPreview(dir) {
  const d = describePluginDir(dir);
  return {
    name: d.name,
    description: d.description,
    version: d.version,
    author: d.author,
    skills: d.skillDirs.map((s) => {
      try {
        const { dir: _d, ...info } = skillInfo(s);
        return info;
      } catch {
        return { name: path.basename(s), description: '' };
      }
    }),
    commands: d.commandFiles.map((c) => c.prefix + path.basename(c.file, '.md')),
    agents: d.agentFiles.map((a) => path.basename(a.file, '.md')),
    connectors: Object.entries(d.mcp).map(([name, cfg]) => ({ name, kind: cfg.url ? 'http' : 'program', what: connectorWhat(cfg).replaceAll('${CLAUDE_PLUGIN_ROOT}', '…'), needs: connectorNeeds(cfg) })),
    hooks: d.hooks,
  };
}

const listOf = (v) => (Array.isArray(v) ? v : typeof v === 'string' ? [v] : []);

function marketEntry(root, e) {
  if (!e || typeof e !== 'object' || !e.name) return null;
  const src = e.source;
  let local = null;
  let remote = null;
  if (typeof src === 'string') local = inside(root, src);
  else if (src && typeof src === 'object') {
    if (src.source === 'github' && /^[\w.-]+\/[\w.-]+$/.test(src.repo || '')) {
      const [owner, repo] = src.repo.split('/');
      remote = { owner, repo, ref: src.ref || '', sub: src.path || '' };
    } else if (src.url) {
      const gh = parseGithub(src.url);
      if (gh) remote = { ...gh, ref: src.ref || gh.ref, sub: src.path || gh.sub };
    }
  }
  // An entry may name its parts itself ("strict": false), e.g. a few skills from a shared folder.
  const listed = ['skills', 'commands', 'agents'].some((k) => listOf(e[k]).length) || Boolean(e.mcpServers);
  let parts = null;
  if (local && listed) parts = { skills: listOf(e.skills).length, commands: listOf(e.commands).length, agents: listOf(e.agents).length, connectors: e.mcpServers ? Object.keys(e.mcpServers.mcpServers || e.mcpServers).length : 0 };
  else if (local) {
    const p = pluginPreview(local);
    parts = { skills: p.skills.length, commands: p.commands.length, agents: p.agents.length, connectors: p.connectors.length };
  }
  return { name: String(e.name).slice(0, 80), description: String(e.description || '').slice(0, 500), version: String(e.version || ''), category: String(e.category || ''), local, remote, listed, entry: e, parts };
}

function analyze(root) {
  const mk = readJsonSafe(path.join(root, '.claude-plugin', 'marketplace.json'));
  if (mk && Array.isArray(mk.plugins) && mk.plugins.length) {
    return { kind: 'marketplace', name: String(mk.name || ''), description: String(mk.description || mk.metadata?.description || ''), plugins: mk.plugins.slice(0, 1000).map((e) => marketEntry(root, e)).filter(Boolean) };
  }
  if (isPlugin(root)) return { kind: 'plugin', plugin: pluginPreview(root) };
  if (fs.existsSync(path.join(root, 'SKILL.md'))) return { kind: 'skills', skills: [skillInfo(root)] };
  const dirs = findSkillDirs(root);
  if (dirs.length) return { kind: 'skills', skills: dirs.map(skillInfo) };
  throw fail(t('No skills or plugins found there. A skill is a folder with a SKILL.md file; a plugin has a .claude-plugin folder.'), 422);
}

function publicFound(f) {
  if (f.kind === 'skills') return { kind: 'skills', skills: f.skills.map(({ dir, ...s }) => s) };
  if (f.kind === 'plugin') return { kind: 'plugin', plugin: f.plugin };
  return { kind: 'marketplace', name: f.name, description: f.description, plugins: f.plugins.map((e) => ({ name: e.name, description: e.description, version: e.version, category: e.category, available: Boolean(e.local || e.remote), remote: Boolean(e.remote), parts: e.parts })) };
}

function cleanupPending() {
  for (const [k, p] of pending) {
    if (Date.now() - p.at < 60 * 60e3) continue;
    fs.rmSync(p.tmp, { recursive: true, force: true });
    pending.delete(k);
  }
}

export async function inspect({ url, folder, upload, name }) {
  cleanupPending();
  const tmp = path.join(DIRS.cache, `ext-${uid(10)}`);
  fs.mkdirSync(tmp, { recursive: true });
  try {
    let root;
    let source;
    if (upload) {
      const f = path.join(tmp, 'upload.zip');
      fs.writeFileSync(f, upload);
      root = await unpack(f, path.join(tmp, 'x'), 2);
      source = `file:${String(name || 'upload.zip').slice(0, 120)}`;
    } else if (folder) {
      try {
        root = fs.realpathSync(String(folder));
      } catch {
        throw fail(t('Not found: {path}', { path: folder }), 404);
      }
      if (!fs.statSync(root).isDirectory()) throw fail(t('Choose a folder.'));
      source = `folder:${root}`;
    } else {
      const gh = parseGithub(url);
      if (!gh) throw fail(t('Paste a GitHub link (github.com/…), or add a .zip file.'));
      root = await fetchGithub(gh, tmp);
      source = `github:${gh.owner}/${gh.repo}${gh.sub ? `/${gh.sub}` : ''}`;
    }
    const found = analyze(root);
    const token = uid(16);
    pending.set(token, { tmp, root, source, found, at: Date.now() });
    return { token, source, ...publicFound(found) };
  } catch (err) {
    fs.rmSync(tmp, { recursive: true, force: true });
    throw err;
  }
}

// ---- Installing ----

function copyTree(src, dest, budget) {
  const st = fs.lstatSync(src);
  if (st.isSymbolicLink()) return; // links could point anywhere on the computer
  if (st.isDirectory()) {
    const name = path.basename(src);
    if (name === '.git' || name === 'node_modules' || name === '__MACOSX') return;
    fs.mkdirSync(dest, { recursive: true });
    for (const n of fs.readdirSync(src)) copyTree(path.join(src, n), path.join(dest, n), budget);
  } else if (st.isFile()) {
    budget.files++;
    budget.bytes += st.size;
    if (budget.files > MAX_FILES || budget.bytes > MAX_BYTES) throw fail(t('This is too big for a skill or plugin (over {n} files or 200 MB).', { n: MAX_FILES }), 413);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }
}

// Copy into a hidden folder first, then swap it in, so a failed copy never leaves half a skill behind.
function place(stage, dest) {
  fs.rmSync(dest, { recursive: true, force: true });
  fs.renameSync(stage, dest);
  forget();
}

function installSkill(dir, source) {
  const { data } = parseFrontmatter(fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8'));
  const st = readState();
  let id = slug(data.name || path.basename(dir)) || `skill-${uid(4)}`;
  // Never write over a skill the user made; an installed one with the same name is updated.
  while (fs.existsSync(path.join(SKILLS_DIR, id)) && (st.skills[id]?.source || 'own') === 'own') id = `${id}-2`;
  const stage = path.join(SKILLS_DIR, `.${id}-${uid(4)}`);
  try {
    copyTree(dir, stage, { files: 0, bytes: 0 });
    place(stage, path.join(SKILLS_DIR, id));
  } catch (err) {
    fs.rmSync(stage, { recursive: true, force: true });
    throw err;
  }
  st.skills[id] = { ...(st.skills[id] || {}), source, enabled: st.skills[id]?.enabled !== false, at: Date.now() };
  writeState(st);
  return id;
}

function installPlugin(dir, source, entry) {
  const manifest = readJsonSafe(path.join(dir, '.claude-plugin', 'plugin.json')) || {};
  const id = slug(entry?.name || manifest.name || path.basename(dir)) || `plugin-${uid(4)}`;
  const stage = path.join(PLUGINS_DIR, `.${id}-${uid(4)}`);
  const budget = { files: 0, bytes: 0 };
  try {
    const own = entry && (['skills', 'commands', 'agents'].some((k) => listOf(entry[k]).length) || entry.mcpServers);
    if (own) {
      // Made from the collection's list: copy just the parts it names, and write the plugin's description.
      fs.mkdirSync(path.join(stage, '.claude-plugin'), { recursive: true });
      const man = { name: entry.name, description: entry.description || manifest.description || '', version: entry.version || manifest.version || '', author: entry.author || manifest.author || undefined };
      fs.writeFileSync(path.join(stage, '.claude-plugin', 'plugin.json'), JSON.stringify(man, null, 2));
      for (const k of ['skills', 'commands', 'agents']) {
        for (const rel of listOf(entry[k])) {
          const src = inside(dir, rel);
          if (src) copyTree(src, path.join(stage, k, path.basename(src)), budget);
        }
      }
      if (entry.mcpServers && typeof entry.mcpServers === 'object') fs.writeFileSync(path.join(stage, '.mcp.json'), JSON.stringify(entry.mcpServers, null, 2));
    } else copyTree(dir, stage, budget);
    place(stage, path.join(PLUGINS_DIR, id));
  } catch (err) {
    fs.rmSync(stage, { recursive: true, force: true });
    throw err;
  }
  const st = readState();
  st.plugins[id] = { ...(st.plugins[id] || {}), source, enabled: true, at: Date.now() };
  writeState(st);
  return id;
}

export async function install(token, { pick } = {}) {
  const p = pending.get(token);
  if (!p) throw fail(t('This preview has expired. Look again.'), 410);
  pending.delete(token);
  try {
    const out = { skills: [], plugins: [] };
    const picked = Array.isArray(pick) ? pick.map(String) : [];
    if (p.found.kind === 'skills') {
      const want = picked.length ? p.found.skills.filter((s) => picked.includes(s.name)) : p.found.skills;
      for (const s of want) out.skills.push(installSkill(s.dir, p.source));
    } else if (p.found.kind === 'plugin') out.plugins.push(installPlugin(p.root, p.source));
    else {
      for (const name of picked) {
        const e = p.found.plugins.find((x) => x.name === name);
        if (!e) continue;
        let dir = e.local;
        let source = `${p.source}#${e.name}`;
        if (!dir && e.remote) {
          dir = await fetchGithub(e.remote, path.join(p.tmp, `r-${uid(4)}`));
          source = `github:${e.remote.owner}/${e.remote.repo}${e.remote.sub ? `/${e.remote.sub}` : ''}`;
        }
        if (!dir) throw fail(t('“{name}” comes from a place Hearth can’t download from (only GitHub works).', { name: e.name }));
        out.plugins.push(installPlugin(dir, source, e.listed ? e.entry : null));
      }
    }
    if (!out.skills.length && !out.plugins.length) throw fail(t('Pick what to install.'));
    return out;
  } finally {
    fs.rmSync(p.tmp, { recursive: true, force: true });
  }
}
