// A bot's files. It may list, find, read, write and change files in its own work folder, save tables as Excel and
// download files from the web into it. With "Read my folders" on it may also read (never change) the folders the
// user allowed in Settings → Tools. Every path is checked after resolving links, so nothing outside is touched.
import fs from 'node:fs';
import path from 'node:path';
import { allowedRoots, readResolved, MAX_RESULT } from './tools.mjs';
import { workFolder } from './bots.mjs';
import { fetchPublic } from './web.mjs';
import { IS_WIN } from './util.mjs';
import { t } from './i18n.mjs';

const MAX_WRITE = 5 << 20;
const MAX_DOWNLOAD = 50 << 20;

export const FILE_TOOLS = {
  list_files: {
    title: 'List files',
    icon: 'folder',
    writes: false,
    description: 'List the files and folders in your work folder, or in one of its subfolders (a path relative to the work folder). Folders the user lets you read are listed by their full paths.',
    parameters: { type: 'object', properties: { path: { type: 'string', description: 'A subfolder, or empty for the work folder itself' } } },
  },
  find_files: {
    title: 'Find files',
    icon: 'search',
    writes: false,
    description: 'Find files whose names contain some text, in your work folder and in the folders you may read.',
    parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  },
  read_file: {
    title: 'Read a file',
    icon: 'file-text',
    writes: false,
    description: 'Read a text file or a document (PDF, Word, Excel, PowerPoint): a path relative to your work folder, or a full path inside a folder you may read. Long files come in parts: pass offset to read on.',
    parameters: { type: 'object', properties: { path: { type: 'string' }, offset: { type: 'integer' } }, required: ['path'] },
  },
  write_file: {
    title: 'Write a file',
    icon: 'pencil',
    writes: true,
    description: 'Create or replace a text file in your work folder: notes and reports (.md, .txt), web pages (.html), data (.csv, .json) or code. Give the whole content. Folders in the path are made as needed. For Excel tables use write_table.',
    parameters: { type: 'object', properties: { path: { type: 'string', description: 'File name or path inside the work folder, e.g. "reports/prices.md"' }, content: { type: 'string' } }, required: ['path', 'content'] },
  },
  edit_file: {
    title: 'Change a file',
    icon: 'pencil',
    writes: true,
    description: 'Change part of a text file in your work folder: old_text, copied exactly from the file and found there once, is replaced by new_text.',
    parameters: { type: 'object', properties: { path: { type: 'string' }, old_text: { type: 'string' }, new_text: { type: 'string' } }, required: ['path', 'old_text', 'new_text'] },
  },
  write_table: {
    title: 'Save a table',
    icon: 'file-spreadsheet',
    writes: true,
    description: 'Save a table in your work folder as an Excel file (.xlsx) or as CSV (.csv). rows is a list of rows, each a list of cell texts; the first row is the header.',
    parameters: { type: 'object', properties: { path: { type: 'string', description: 'For example "listings.xlsx"' }, rows: { type: 'array', items: { type: 'array', items: { type: 'string' } } } }, required: ['path', 'rows'] },
  },
  write_document: {
    title: 'Write a document',
    icon: 'file-text',
    writes: true,
    description: 'Save a text as a Word document (.docx) in your work folder: a letter, a form, a contract, or the corrected version of a document you have read (read it with read_file first, then write the whole new text). content is plain text with simple marks: "# " for headings, "- " for list items, "1. " for numbered items, **bold**, *italic*, "| a | b |" for table rows; every line is its own paragraph.',
    parameters: { type: 'object', properties: { path: { type: 'string', description: 'For example "letter.docx"' }, content: { type: 'string' } }, required: ['path', 'content'] },
  },
  download_file: {
    title: 'Download a file',
    icon: 'download',
    writes: true,
    web: true,
    description: 'Download a file from a public web address (a picture, a PDF or another file, up to 50 MB) into your work folder.',
    parameters: { type: 'object', properties: { url: { type: 'string' }, path: { type: 'string', description: 'The name to save it as (optional)' } }, required: ['url'] },
  },
};

const norm = (p) => (IS_WIN ? p.toLowerCase() : p);
const inside = (p, root) => norm(p) === norm(root) || norm(p).startsWith(norm(root) + path.sep);
const rel = (work, p) => path.relative(work, p).split(path.sep).join('/');

function readRoots(bot, folders) {
  const work = workFolder(bot);
  return { work, read: folders ? allowedRoots() : [] };
}

// A path to read: inside the work folder, or inside a folder the bot may read.
export function forRead(bot, p, folders = false) {
  const { work, read } = readRoots(bot, folders);
  const raw = String(p ?? '').trim();
  const abs = !raw ? work : path.isAbsolute(raw) ? raw : path.join(work, raw);
  let real;
  try {
    real = fs.realpathSync(abs);
  } catch {
    throw new Error(t('Not found: {path}', { path: raw }));
  }
  if (![work, ...read].some((r) => inside(real, r))) throw new Error(t('That path is outside your work folder.'));
  return real;
}

// A path to write: only inside the work folder. Missing folders are made; a link that leads out is refused.
export function forWrite(bot, p) {
  const work = workFolder(bot);
  const raw = String(p ?? '').trim();
  if (!raw) throw new Error(t('Give a file name.'));
  const abs = path.resolve(path.isAbsolute(raw) ? raw : path.join(work, raw));
  if (!inside(abs, work) || norm(abs) === norm(work)) throw new Error(t('Files can only be written inside your work folder.'));
  let dir = path.dirname(abs);
  while (!fs.existsSync(dir)) dir = path.dirname(dir);
  if (!inside(fs.realpathSync(dir), work)) throw new Error(t('Files can only be written inside your work folder.'));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  if (fs.existsSync(abs)) {
    const st = fs.lstatSync(abs);
    if (st.isDirectory()) throw new Error(t('That is a folder, not a file.'));
    if (st.isSymbolicLink() && !inside(fs.realpathSync(abs), work)) throw new Error(t('Files can only be written inside your work folder.'));
  }
  return abs;
}

const when = (ms) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
const kb = (n) => (n < 1024 ? `${n} B` : n < 1 << 20 ? `${(n / 1024).toFixed(1)} KB` : `${(n / (1 << 20)).toFixed(1)} MB`);

function listFiles(bot, p, folders) {
  const { work, read } = readRoots(bot, folders);
  const dir = forRead(bot, p, folders);
  if (!fs.statSync(dir).isDirectory()) throw new Error(t('That is a file, not a folder.'));
  const lines = [];
  for (const name of fs.readdirSync(dir).sort()) {
    if (name.startsWith('.')) continue;
    try {
      const st = fs.statSync(path.join(dir, name));
      lines.push(st.isDirectory() ? `${name}/` : `${name} — ${kb(st.size)}, ${when(st.mtimeMs)}`);
    } catch {}
    if (lines.length >= 300) break;
  }
  const where = norm(dir) === norm(work) ? t('Your work folder') : inside(dir, work) ? rel(work, dir) : dir;
  let out = `${where}:\n${lines.length ? lines.join('\n') : t('(empty)')}`;
  if (norm(dir) === norm(work) && read.length) out += `\n\n${t('Folders you may read:')}\n${read.join('\n')}`;
  return out;
}

function findFiles(bot, query, folders) {
  const q = String(query || '').toLowerCase().trim();
  if (!q) throw new Error(t('Say what to look for.'));
  const { work, read } = readRoots(bot, folders);
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
      if (name.toLowerCase().includes(q)) out.push(`${inside(full, work) ? rel(work, full) : full}${st.isDirectory() ? '/' : ''}`);
      if (st.isDirectory() && !st.isSymbolicLink()) walk(full, depth + 1);
      if (out.length >= 60) return;
    }
  };
  for (const r of [work, ...read]) walk(r, 0);
  return out.length ? out.join('\n') : t('Nothing found.');
}

function writeText(file, content) {
  const data = Buffer.from(String(content ?? ''), 'utf8');
  if (data.length > MAX_WRITE) throw new Error(t('That is too much for one file (at most 5 MB).'));
  fs.writeFileSync(file, data);
  return data.length;
}

function editFile(file, oldText, newText) {
  if (!fs.existsSync(file)) throw new Error(t('Not found: {path}', { path: path.basename(file) }));
  const text = fs.readFileSync(file, 'utf8');
  const o = String(oldText ?? '');
  if (!o) throw new Error(t('Give the exact text to replace (old_text).'));
  const first = text.indexOf(o);
  if (first < 0) throw new Error(t('old_text was not found in the file. Read the file and copy the text exactly.'));
  if (text.indexOf(o, first + 1) >= 0) throw new Error(t('old_text appears more than once. Give a longer piece so it is found only once.'));
  return writeText(file, text.slice(0, first) + String(newText ?? '') + text.slice(first + o.length));
}

async function writeTable(file, rows) {
  if (!Array.isArray(rows) || !rows.length) throw new Error(t('Give the table as rows of cells.'));
  const clean = rows.slice(0, 20000).map((r) => (Array.isArray(r) ? r : [r]).slice(0, 200).map((c) => (c == null ? '' : typeof c === 'object' ? JSON.stringify(c) : String(c))));
  const { xlsxBlob, csvText } = await import('../public/js/xlsx.js');
  if (/\.csv$/i.test(file)) return writeText(file, csvText(clean));
  const widths = clean[0].map((_, i) => Math.min(60, Math.max(10, ...clean.slice(0, 200).map((r) => String(r[i] || '').length))));
  const bytes = Buffer.from(await xlsxBlob(clean, { sheet: path.basename(file, path.extname(file)).slice(0, 31) || 'Sheet1', widths }).arrayBuffer());
  fs.writeFileSync(file, bytes);
  return bytes.length;
}

const EXT_OF = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif', 'image/svg+xml': '.svg', 'application/pdf': '.pdf', 'text/html': '.html', 'text/plain': '.txt', 'text/csv': '.csv', 'application/json': '.json', 'application/zip': '.zip' };

async function download(bot, url, name) {
  const r = await fetchPublic(String(url || ''), { maxBytes: MAX_DOWNLOAD, timeout: 120000, headers: { accept: '*/*' } });
  if (r.status >= 400) throw new Error(t('The page answered with an error ({status}).', { status: r.status }));
  if (r.cut) throw new Error(t('The file is bigger than 50 MB.'));
  const type = String(r.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  let base = String(name || '').trim();
  if (!base) {
    const disp = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(String(r.headers['content-disposition'] || ''))?.[1];
    base = decodeURIComponent(disp || path.basename(new URL(r.url).pathname) || '') || 'download';
  }
  base = base.replace(/[\\:*?"<>|\u0000-\u001f]+/g, '-');
  if (!path.extname(base) && EXT_OF[type]) base += EXT_OF[type];
  const file = forWrite(bot, base);
  fs.writeFileSync(file, r.body);
  return { file, size: r.body.length };
}

// Runs one file tool. Returns { text } for the model, and { file } when a file was made or changed.
export async function callFileTool(bot, name, a = {}, { folders = false } = {}) {
  const work = workFolder(bot);
  switch (name) {
    case 'list_files':
      return { text: listFiles(bot, a.path, folders) };
    case 'find_files':
      return { text: findFiles(bot, a.query, folders) };
    case 'read_file': {
      const file = forRead(bot, a.path, folders);
      if (fs.statSync(file).isDirectory()) return { text: listFiles(bot, a.path, folders) };
      return { text: await readResolved(file, Number(a.offset) || 0) };
    }
    case 'write_file': {
      const file = forWrite(bot, a.path);
      const n = writeText(file, a.content);
      return { text: t('Saved {path} ({size}).', { path: rel(work, file), size: kb(n) }), file: rel(work, file) };
    }
    case 'edit_file': {
      const file = forWrite(bot, a.path);
      editFile(file, a.old_text, a.new_text);
      return { text: t('Changed {path}.', { path: rel(work, file) }), file: rel(work, file) };
    }
    case 'write_table': {
      let p = String(a.path || '').trim() || 'table.xlsx';
      if (!/\.(xlsx|csv)$/i.test(p)) p += '.xlsx';
      const file = forWrite(bot, p);
      const n = await writeTable(file, a.rows);
      return { text: t('Saved {path} ({size}).', { path: rel(work, file), size: kb(n) }), file: rel(work, file) };
    }
    case 'write_document': {
      let p = String(a.path || '').trim() || 'document.docx';
      if (!/\.docx$/i.test(p)) p = `${p.replace(/\.(doc|pdf|txt|md|rtf|odt)$/i, '')}.docx`;
      const text = String(a.content ?? '');
      if (!text.trim()) throw new Error(t('Give the text of the document.'));
      if (Buffer.byteLength(text) > MAX_WRITE) throw new Error(t('The document is too long.'));
      const file = forWrite(bot, p);
      const { docxBytes } = await import('./docx.mjs');
      const bytes = await docxBytes(text);
      fs.writeFileSync(file, bytes);
      return { text: t('Saved {path} ({size}).', { path: rel(work, file), size: kb(bytes.length) }), file: rel(work, file) };
    }
    case 'download_file': {
      const { file, size } = await download(bot, a.url, a.path);
      return { text: t('Saved {path} ({size}).', { path: rel(work, file), size: kb(size) }), file: rel(work, file) };
    }
    default:
      throw new Error(t('Unknown tool: {name}', { name }));
  }
}

export { MAX_RESULT };
