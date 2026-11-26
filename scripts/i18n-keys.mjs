// Lists every text the code passes to t() and tn(), and which ones a language file is missing.
// Usage: node scripts/i18n-keys.mjs [ru]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const files = [...fs.readdirSync(path.join(root, 'public/js')).filter((f) => f.endsWith('.js')).map((f) => path.join(root, 'public/js', f)), ...fs.readdirSync(path.join(root, 'server')).filter((f) => f.endsWith('.mjs')).map((f) => path.join(root, 'server', f))];

const str = String.raw`'((?:\\.|[^'\\])*)'|"((?:\\.|[^"\\])*)"`;
const reT = new RegExp(String.raw`\bt\(\s*(?:${str})`, 'g');
const reTn = new RegExp(String.raw`\btn\(\s*[^,()]+(?:\([^()]*\))?\s*,\s*(?:${str})\s*,\s*(?:${str})`, 'g');
const unescape = (s) => s.replace(/\\(['"\\])/g, '$1').replace(/\\n/g, '\n');

// Texts the server passes to t() from a variable: built-in assistants, tool titles, catalog entries and so on.
const DYNAMIC = {
  'assistants.mjs': /\b(?:name|description|instructions|starter):\s*'((?:\\.|[^'\\])*)'/g,
  'tools.mjs': /\btitle:\s*'((?:\\.|[^'\\])*)'/g,
  'images.mjs': /\bquality:\s*'((?:\\.|[^'\\])*)'/g,
  'catalog.mjs': /\b(?:about|params):\s*'((?:\\.|[^'\\])*)'/g,
  'models.mjs': /e\.note = e\.hasTemplate \? '' : '((?:\\.|[^'\\])*)'/g,
  'phone.mjs': /'((?:Android|Windows|Device)[\w ]*)'/g,
  'bots.mjs': /\b(?:name|description|instructions|task):\s*'((?:\\.|[^'\\])*)'/g,
  'workfiles.mjs': /\btitle:\s*'((?:\\.|[^'\\])*)'/g,
  'directory.mjs': /(?:\b(?:title|description|note):\s*|^const [A-Z]+ = )'((?:\\.|[^'\\])*)'/gm,
};

export function collectKeys() {
  const keys = new Map(); // key → { plural, files }
  for (const [file, re] of Object.entries(DYNAMIC)) {
    const src = fs.readFileSync(path.join(root, 'server', file), 'utf8');
    for (const m of src.matchAll(re)) {
      const k = unescape(m[1]);
      if (/^\d+B$|^(iPhone|iPad|Mac)$/.test(k)) continue; // the same in every language
      const e = keys.get(k) || { plural: false, files: new Set() };
      e.files.add(file);
      keys.set(k, e);
    }
  }
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    for (const m of src.matchAll(reT)) {
      const k = unescape(m[1] ?? m[2]);
      const e = keys.get(k) || { plural: false, files: new Set() };
      e.files.add(path.basename(f));
      keys.set(k, e);
    }
    for (const m of src.matchAll(reTn)) {
      const k = unescape(m[1] ?? m[2]);
      const e = keys.get(k) || { plural: true, files: new Set() };
      e.plural = true;
      e.files.add(path.basename(f));
      keys.set(k, e);
    }
  }
  return keys;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const keys = collectKeys();
  const lang = process.argv[2];
  if (!lang) {
    for (const [k, e] of keys) console.log(`${e.plural ? '[n] ' : ''}${JSON.stringify(k)}`);
    console.log(`\n${keys.size} texts`);
  } else {
    const dict = (await import(path.join(root, 'public/js/lang', `${lang}.js`))).default;
    const missing = [...keys].filter(([k, e]) => !(k in dict) || (e.plural && !Array.isArray(dict[k])));
    const unused = Object.keys(dict).filter((k) => !keys.has(k));
    for (const [k, e] of missing) console.log(`missing${e.plural ? ' [n]' : ''}: ${JSON.stringify(k)}`);
    for (const k of unused) console.log(`unused: ${JSON.stringify(k)}`);
    console.log(`\n${keys.size} texts, ${missing.length} missing, ${unused.length} unused`);
  }
}
