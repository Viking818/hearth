// A small, safe Markdown renderer for model answers (works on half-written text while streaming).
// Everything is HTML-escaped first; only the tags made here reach the page, and links must be http(s)/mailto.
// Pictures and videos: Hearth's own are shown; ones on other sites wait for the user's click.
import { iconHtml } from './icons.js';
import { t, tn } from './i18n.js';

export const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const PREVIEWABLE = new Set(['html', 'htm', 'svg', 'xml-svg']);
export const LANG_FILE = { html: 'index.html', htm: 'index.html', svg: 'drawing.svg', css: 'style.css', js: 'script.js', javascript: 'script.js', python: 'main.py', py: 'main.py' };

// ---- Simple math: models often write LaTeX like $12 \div 3 = 4$; show it as readable text ----
const SYMBOLS = {
  times: '×', div: '÷', cdot: '·', pm: '±', mp: '∓', le: '≤', leq: '≤', ge: '≥', geq: '≥', neq: '≠', ne: '≠', approx: '≈', sim: '∼',
  infty: '∞', pi: 'π', alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', Delta: 'Δ', theta: 'θ', lambda: 'λ', mu: 'μ', sigma: 'σ', Sigma: 'Σ', omega: 'ω',
  to: '→', rightarrow: '→', leftarrow: '←', Rightarrow: '⇒', implies: '⇒', sum: 'Σ', prod: 'Π', int: '∫', partial: '∂', degree: '°', circ: '°', percent: '%',
  ldots: '…', cdots: '⋯', quad: '  ', qquad: '    ',
};
const SUP = { 0: '⁰', 1: '¹', 2: '²', 3: '³', 4: '⁴', 5: '⁵', 6: '⁶', 7: '⁷', 8: '⁸', 9: '⁹', '+': '⁺', '-': '⁻', n: 'ⁿ' };

function texToText(t) {
  let s = t;
  for (let i = 0; i < 4; i++) {
    s = s
      .replace(/\\(?:text|mathrm|mathbf|textbf|operatorname|mbox)\{([^{}]*)\}/g, '$1')
      .replace(/\\d?frac\{([^{}]*)\}\{([^{}]*)\}/g, (_, a, b) => `${/^\w+$/.test(a) ? a : `(${a})`}/${/^\w+$/.test(b) ? b : `(${b})`}`)
      .replace(/\\sqrt\{([^{}]*)\}/g, (_, a) => `√${/^\w+$/.test(a) ? a : `(${a})`}`)
      .replace(/\^\{([^{}]*)\}/g, (_, a) => ([...a].every((c) => SUP[c]) ? [...a].map((c) => SUP[c]).join('') : `^(${a})`))
      .replace(/_\{([^{}]*)\}/g, '_$1');
  }
  return s
    .replace(/\^([0-9n+-])/g, (_, c) => SUP[c])
    .replace(/\\left|\\right|\\displaystyle/g, '')
    .replace(/\\[,;:! ]/g, ' ')
    .replace(/\\([$%&#_{}])/g, '$1')
    .replace(/\\([A-Za-z]+)/g, (m, name) => SYMBOLS[name] ?? name)
    .replace(/[{}]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// ---- Pictures and videos in an answer ----
// Hearth's own files (chat uploads, the Images and Videos galleries) and pictures written out as data are shown at
// once. A picture or video on another site is fetched only after the user says so: an address the model wrote can
// carry text from the chat to that site, so loading it must never happen by itself.
const IMG_EXT = /\.(png|jpe?g|webp|gif|avif)$/i;
const VID_EXT = /\.(mp4|m4v|mov|webm)$/i;
const LOCAL_MEDIA = /^\/(uploads|images|videos)\/[\w.%-]+$/;
const DATA_IMG = /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/;
const HOSTS_KEY = 'hearth.mediaHosts';
const shownNow = new Set(); // addresses the user chose to show, until the page is closed

function allowedHosts() {
  try {
    const v = JSON.parse(localStorage.getItem(HOSTS_KEY) || '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function mediaTag(url, alt, kind) {
  return kind === 'video'
    ? `<video class="md-video" src="${esc(url)}" controls playsinline preload="metadata"></video>`
    : `<img class="md-img" src="${esc(url)}" alt="${esc(alt)}" loading="lazy" referrerpolicy="no-referrer" data-zoom>`;
}

// The picture or video at an address, or '' when it is neither. `image` says the answer itself calls it a picture
// (the ![…](…) form), which matters for addresses without a file ending.
export function mediaHtml(url, alt = '', image = false) {
  if (LOCAL_MEDIA.test(url)) return mediaTag(url, alt, url.startsWith('/videos/') || VID_EXT.test(url) ? 'video' : 'image');
  if (DATA_IMG.test(url)) return mediaTag(url, alt, 'image');
  let u;
  try {
    u = new URL(url);
  } catch {
    return '';
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return '';
  const kind = VID_EXT.test(u.pathname) ? 'video' : IMG_EXT.test(u.pathname) || image ? 'image' : '';
  if (!kind) return '';
  if (shownNow.has(url) || allowedHosts().includes(u.host)) return mediaTag(url, alt, kind);
  return `<span class="md-ask" data-media="${esc(url)}" data-kind="${kind}" data-alt="${esc(alt)}">${iconHtml(kind === 'video' ? 'film' : 'image')}`
    + `<span class="md-ask-text">${esc(kind === 'video' ? t('Video from {site}', { site: u.host }) : t('Picture from {site}', { site: u.host }))}</span>`
    + `<button type="button" class="btn sm" data-media-act="show">${esc(t('Show'))}</button>`
    + `<button type="button" class="btn sm ghost" data-media-act="always">${esc(t('Always show from this site'))}</button></span>`;
}

// "Show" and "Always show from this site" work wherever an answer is drawn.
if (typeof document !== 'undefined')
  document.addEventListener('click', (e) => {
    const b = e.target.closest?.('[data-media-act]');
    const card = b?.closest('[data-media]');
    if (!card) return;
    const reveal = (el) => {
      shownNow.add(el.dataset.media);
      el.outerHTML = mediaTag(el.dataset.media, el.dataset.alt || '', el.dataset.kind);
    };
    if (b.dataset.mediaAct === 'always') {
      const host = new URL(card.dataset.media).host;
      try {
        localStorage.setItem(HOSTS_KEY, JSON.stringify([...new Set([...allowedHosts(), host])].slice(-200)));
      } catch {}
      for (const el of document.querySelectorAll('[data-media]')) if (new URL(el.dataset.media).host === host) reveal(el);
    } else reveal(card);
  });

// A picture or video that won't load (a wrong address, a site that is down) leaves a short note, not a broken box.
if (typeof document !== 'undefined')
  document.addEventListener(
    'error',
    (e) => {
      const el = e.target;
      if (!el?.matches?.('img.md-img, video.md-video')) return;
      // A video made on the Video page that this browser won't open as it is: its picture-only copy plays.
      const made = /^\/videos\/([\w.-]+\.webm)$/.exec(el.getAttribute('src') || '');
      if (made && el.tagName === 'VIDEO') return el.setAttribute('src', `/videos/play/${made[1]}`);
      const note = document.createElement('span');
      note.className = 'md-ask';
      note.innerHTML = `${iconHtml(el.tagName === 'VIDEO' ? 'film' : 'image')}<span class="md-ask-text">${esc(el.tagName === 'VIDEO' ? t('This video couldn’t be loaded.') : t('This picture couldn’t be loaded.'))}</span>`;
      el.replaceWith(note);
    },
    true,
  );

// ---- Inline: code, math, pictures, links, bold, italic, strike ----
function inline(src) {
  const slots = [];
  const keep = (h) => `\u0000${slots.push(h) - 1}\u0000`;
  // The text of a link may hold code or math that was already set aside: it is put back here, as text between the
  // tags. (Finished pieces are never scanned again, so nothing can travel into an attribute.)
  const label = (text) => text.split(/(\u0000\d+\u0000)/).map((part) => (/^\u0000\d+\u0000$/.test(part) ? slots[Number(part.slice(1, -1))] ?? '' : esc(part))).join('');
  const plain = (text) => text.replace(/\u0000\d+\u0000/g, '');
  let s = src.replace(/\u0000/g, '').replace(/`([^`\n]+)`/g, (_, c) => keep(`<code>${esc(c)}</code>`));
  // Only $…$ with a LaTeX command counts as math, so prices like "$25 and $30" stay as they are.
  const math = (_, inner) => keep(`<span class="math">${esc(texToText(inner))}</span>`);
  s = s.replace(/\$\$(.+?)\$\$/g, math).replace(/\\\[(.+?)\\\]/g, math).replace(/\\\((.+?)\\\)/g, math);
  s = s.replace(/\$((?:\\\$|[^$\n])*?\\[A-Za-z](?:\\\$|[^$\n])*?)\$/g, math);
  s = s.replace(/!\[([^\]\n]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (m, alt, url) => {
    const media = mediaHtml(url, alt, true);
    return media ? keep(media) : m;
  });
  // A link to a picture or a video file also shows it, under the link.
  s = s.replace(/\[([^\]\n]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (m, text, url) =>
    /^(https?:|mailto:)/i.test(url) && !url.includes('\u0000') ? keep(`<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${label(text)}</a>${mediaHtml(url, plain(text))}`) : m,
  );
  s = s.replace(/\bhttps?:\/\/[^\s<>()"']+[^\s<>()"'.,;:!?]/g, (url) => keep(`<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(url)}</a>${mediaHtml(url)}`));
  s = esc(s);
  s = s.replace(/\*\*([^*\n]+?)\*\*/g, '<strong>$1</strong>').replace(/__([^_\n]+?)__/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*\w])\*([^*\n]+?)\*(?!\*)/g, '$1<em>$2</em>').replace(/(^|[^_\w])_([^_\n]+?)_(?!\w)/g, '$1<em>$2</em>');
  s = s.replace(/~~([^~\n]+?)~~/g, '<del>$1</del>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => slots[Number(i)]);
}

// ---- Tiny syntax highlighter (strings, comments, numbers, keywords, tags) ----
const KW = {
  js: 'const let var function return if else for while do switch case break continue new class extends import from export default async await try catch finally throw typeof instanceof in of this null undefined true false yield static get set',
  py: 'def return if elif else for while in not and or import from as class try except finally raise with lambda None True False pass break continue global yield async await is self print',
  sh: 'if then else fi for do done while case esac function in export echo cd sudo',
  css: '',
  generic: 'if else for while return function class def import from const let var new true false null',
};
const LANG_KIND = { js: 'js', javascript: 'js', ts: 'js', typescript: 'js', jsx: 'js', tsx: 'js', json: 'js', py: 'py', python: 'py', sh: 'sh', bash: 'sh', zsh: 'sh', shell: 'sh', powershell: 'sh', ps1: 'sh', css: 'css', html: 'html', htm: 'html', xml: 'html', svg: 'html' };

function highlight(code, lang) {
  const kind = LANG_KIND[lang] || 'generic';
  if (kind === 'html') {
    // Tags and attributes; embedded CSS/JS stay plain.
    return esc(code).replace(/(&lt;\/?)([\w-]+)([^&]*?)(\/?&gt;)/g, (m, open, tag, attrs, close) => {
      const a = attrs.replace(/([\w-:]+)(=)(&quot;.*?&quot;|&#39;.*?&#39;)/g, '<span class="tok-a">$1</span>$2<span class="tok-s">$3</span>');
      return `${open}<span class="tok-t">${tag}</span>${a}${close}`;
    }).replace(/(&lt;!--[\s\S]*?--&gt;)/g, '<span class="tok-c">$1</span>');
  }
  const kw = new Set((KW[kind] || '').split(' ').filter(Boolean));
  const comment = kind === 'py' || kind === 'sh' ? '#[^\\n]*' : kind === 'css' ? '\\/\\*[\\s\\S]*?\\*\\/' : '\\/\\/[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/';
  const re = new RegExp(`(${comment})|("(?:[^"\\\\\\n]|\\\\.)*"|'(?:[^'\\\\\\n]|\\\\.)*'|\`(?:[^\`\\\\]|\\\\.)*\`)|(\\b\\d+(?:\\.\\d+)?\\b)|([A-Za-z_$][\\w$]*)`, 'g');
  let out = '';
  let last = 0;
  for (const m of code.matchAll(re)) {
    out += esc(code.slice(last, m.index));
    if (m[1]) out += `<span class="tok-c">${esc(m[1])}</span>`;
    else if (m[2]) out += `<span class="tok-s">${esc(m[2])}</span>`;
    else if (m[3]) out += `<span class="tok-n">${m[3]}</span>`;
    else if (m[4]) out += kw.has(m[4]) ? `<span class="tok-k">${m[4]}</span>` : esc(m[4]);
    last = m.index + m[0].length;
  }
  return out + esc(code.slice(last));
}

function kb(n) {
  return n >= 1024 ? t('{n} KB', { n: (n / 1024).toFixed(1) }) : t('{n} B', { n });
}

function codeBlock(block, i) {
  const lang = (block.lang || '').toLowerCase();
  const isPreview = PREVIEWABLE.has(lang) || (lang === 'xml' && /^\s*<svg/i.test(block.code));
  const bytes = new Blob([block.code]).size;
  const lines = block.code.split('\n').length;
  if (isPreview && lines >= 8) {
    // A file card, like a file the model wrote; the code is one click away.
    const kind = lang === 'svg' || /^\s*<svg/i.test(block.code) ? 'SVG' : 'HTML';
    return `<div class="filecard"><span class="ft">${kind}</span><div class="grow"><div class="fn">${kind === 'SVG' ? 'drawing.svg' : 'index.html'}</div><div class="fs">${block.closed ? `${kb(bytes)} · ${esc(tn(lines, '{n} line', '{n} lines'))}` : `<span class="writing">${esc(t('Writing…'))} ${esc(tn(lines, '{n} line', '{n} lines'))}</span>`}</div></div>`
      + `<button class="btn sm" data-act="code" data-i="${i}">${iconHtml('code')} ${esc(t('Code'))}</button>`
      + `<button class="btn sm primary" data-act="preview" data-i="${i}">${iconHtml('eye')} ${esc(t('Open'))}</button></div>`;
  }
  return `<div class="codeblock"><div class="code-head"><span class="lang">${esc(lang || 'text')}</span>`
    + (isPreview ? `<button data-act="preview" data-i="${i}">${iconHtml('eye')} ${esc(t('Preview'))}</button>` : '')
    + `<button data-act="copy" data-i="${i}">${iconHtml('copy')} ${esc(t('Copy'))}</button></div>`
    + `<pre><code>${highlight(block.code, lang)}</code></pre></div>`;
}

// ---- Blocks ----
function renderBlocks(lines, blocks, depth = 0) {
  let out = '';
  let i = 0;
  const para = [];
  const flush = () => {
    if (para.length) out += `<p>${para.map(inline).join('<br>')}</p>`;
    para.length = 0;
  };
  while (i < lines.length) {
    const line = lines[i];
    const t = line.trim();
    if (line.startsWith('\u0001CODE')) {
      flush();
      const n = Number(line.slice(5));
      out += codeBlock(blocks[n], n);
      i++;
      continue;
    }
    if (!t) {
      flush();
      i++;
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(t);
    if (h) {
      flush();
      const lvl = Math.min(h[1].length, 4);
      out += `<h${lvl}>${inline(h[2].replace(/\s+#+$/, ''))}</h${lvl}>`;
      i++;
      continue;
    }
    if (/^([-*_])(\s*\1){2,}$/.test(t)) {
      flush();
      out += '<hr>';
      i++;
      continue;
    }
    if (t.startsWith('>')) {
      flush();
      const q = [];
      while (i < lines.length && lines[i].trim().startsWith('>')) q.push(lines[i++].trim().replace(/^>\s?/, ''));
      // Quotes inside quotes are followed a few levels deep; thousands of ">" in a row stay plain text.
      out += `<blockquote>${depth < 12 ? renderBlocks(q, blocks, depth + 1) : `<p>${esc(q.join(' ').replace(/^[>\s]+/, ''))}</p>`}</blockquote>`;
      continue;
    }
    if (/^\|.*\|$/.test(t) && i + 1 < lines.length && /^\|?\s*:?-{2,}/.test(lines[i + 1].trim())) {
      flush();
      const cells = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const head = cells(lines[i]);
      i += 2;
      let rows = '';
      while (i < lines.length && /^\|.*\|?$/.test(lines[i].trim()) && lines[i].trim()) rows += `<tr>${cells(lines[i++]).map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`;
      out += `<table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table>`;
      continue;
    }
    if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
      flush();
      const start = i;
      const isNum = (l) => /^\s*\d+[.)]\s+/.test(l);
      const baseIndent = line.match(/^\s*/)[0].length;
      // A bullet list right after a numbered one (or the reverse) starts a new list.
      const sameKind = (l) => !(/^\s*([-*+]|\d+[.)])\s+/.test(l) && l.match(/^\s*/)[0].length <= baseIndent && isNum(l) !== isNum(line));
      while (i < lines.length && sameKind(lines[i]) && (/^\s*([-*+]|\d+[.)])\s+/.test(lines[i]) || (lines[i].trim() && /^\s{2,}/.test(lines[i])) || (!lines[i].trim() && i + 1 < lines.length && /^\s*([-*+]|\d+[.)])\s+|^\s{2,}\S/.test(lines[i + 1])))) i++;
      out += renderList(lines.slice(start, i), blocks);
      continue;
    }
    para.push(t);
    i++;
  }
  flush();
  return out;
}

function renderList(lines, blocks) {
  const indentOf = (l) => l.match(/^\s*/)[0].replace(/\t/g, '    ').length;
  const base = indentOf(lines.find((l) => l.trim()) || '');
  const first = /^\s*(\d+)[.)]\s+/.exec(lines[0]);
  const tag = first ? 'ol' : 'ul';
  const items = [];
  for (const l of lines) {
    const m = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(l);
    if (m && indentOf(l) <= base + 1) items.push([m[3]]);
    else if (items.length) items[items.length - 1].push(l.length > base ? l.slice(Math.min(base + 2, indentOf(l))) : l);
  }
  const startAttr = first && first[1] !== '1' ? ` start="${Number(first[1])}"` : '';
  return `<${tag}${startAttr}>${items
    .map(([head, ...rest]) => {
      const task = /^\[([ xX])\]\s+/.exec(head);
      const label = task ? `<input type="checkbox" disabled ${task[1] !== ' ' ? 'checked' : ''}> ${inline(head.slice(task[0].length))}` : inline(head);
      const nested = rest.filter((r) => r.trim()).length ? renderBlocks(rest, blocks) : '';
      return `<li>${label}${nested}</li>`;
    })
    .join('')}</${tag}>`;
}

/**
 * Returns { html, blocks } where blocks = [{ lang, code, closed }] for copy/preview buttons.
 */
export function renderMarkdown(src = '') {
  const blocks = [];
  const lines = [];
  const all = String(src).replace(/\r\n?/g, '\n').split('\n');
  for (let i = 0; i < all.length; i++) {
    const m = /^(\s*)(`{3,}|~{3,})\s*([\w+#.-]*)[^\n]*$/.exec(all[i]);
    if (!m) {
      lines.push(all[i]);
      continue;
    }
    const fence = m[2];
    const indent = m[1].length;
    const body = [];
    let closed = false;
    i++;
    for (; i < all.length; i++) {
      if (new RegExp(`^\\s*${fence[0] === '`' ? '`' : '~'}{${fence.length},}\\s*$`).test(all[i])) {
        closed = true;
        break;
      }
      body.push(indent ? all[i].replace(new RegExp(`^ {0,${indent}}`), '') : all[i]);
    }
    blocks.push({ lang: m[3] || '', code: body.join('\n'), closed });
    lines.push(`\u0001CODE${blocks.length - 1}`);
  }
  return { html: renderBlocks(lines, blocks), blocks };
}

// The page to show in the preview pane: the last HTML/SVG block, with the answer's CSS/JS blocks folded in.
export function previewFrom(blocks) {
  let idx = -1;
  for (let i = blocks.length - 1; i >= 0; i--) {
    const l = blocks[i].lang.toLowerCase();
    if (PREVIEWABLE.has(l) || (l === 'xml' && /^\s*<svg/i.test(blocks[i].code))) {
      idx = i;
      break;
    }
  }
  if (idx < 0) return null;
  return { index: idx, ...buildDoc(blocks, idx) };
}

export function buildDoc(blocks, idx) {
  const b = blocks[idx];
  const lang = b.lang.toLowerCase();
  if (lang === 'svg' || /^\s*<svg/i.test(b.code)) return { kind: 'svg', name: 'drawing.svg', code: b.code, doc: `<!doctype html><html><body style="margin:0;display:grid;place-items:center;min-height:100vh;background:#fff">${b.code}</body></html>`, closed: b.closed };
  let doc = b.code;
  const css = blocks.filter((x) => x.lang.toLowerCase() === 'css').map((x) => x.code).join('\n');
  const js = blocks.filter((x) => /^(js|javascript)$/i.test(x.lang)).map((x) => x.code).join('\n');
  if (css && !/<style[\s>]/i.test(doc)) doc = /<\/head>/i.test(doc) ? doc.replace(/<\/head>/i, `<style>\n${css}\n</style></head>`) : `<style>\n${css}\n</style>\n${doc}`;
  if (js && !/<script[\s>]/i.test(doc)) doc = /<\/body>/i.test(doc) ? doc.replace(/<\/body>/i, `<script>\n${js}\n</script></body>`) : `${doc}\n<script>\n${js}\n</script>`;
  return { kind: 'html', name: 'index.html', code: b.code, doc, closed: b.closed };
}
