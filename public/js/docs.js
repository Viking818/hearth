// Text out of documents: PDF (with pdf.js), Word, Excel and PowerPoint (they are zip files of XML).
// Works in the page and on the server; neither needs anything installed.

export const DOC_EXT = /\.(pdf|docx|xlsx|xlsm|pptx|odt|ods|odp)$/i;

// ---- Zip ----

function readZip(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('not a zip file');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const entries = new Map();
  const dec = new TextDecoder();
  for (let n = 0; n < count && p + 46 <= bytes.length; n++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true);
    const csize = dv.getUint32(p + 20, true);
    const usize = dv.getUint32(p + 24, true);
    const nlen = dv.getUint16(p + 28, true);
    const xlen = dv.getUint16(p + 30, true);
    const clen = dv.getUint16(p + 32, true);
    const local = dv.getUint32(p + 42, true);
    const name = dec.decode(bytes.subarray(p + 46, p + 46 + nlen));
    entries.set(name, { method, csize, usize, local });
    p += 46 + nlen + xlen + clen;
  }
  return {
    names: [...entries.keys()],
    has: (name) => entries.has(name),
    async text(name) {
      const e = entries.get(name);
      if (!e) return '';
      const l = e.local;
      const start = l + 30 + dv.getUint16(l + 26, true) + dv.getUint16(l + 28, true);
      const raw = bytes.subarray(start, start + e.csize);
      if (e.method === 0) return dec.decode(raw);
      if (e.method !== 8) throw new Error('unsupported zip compression');
      const out = new Response(new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw')));
      return dec.decode(await out.arrayBuffer());
    },
  };
}

// ---- XML bits ----

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
export function unxml(s) {
  return String(s).replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => {
    if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1)));
    return ENT[e] ?? m;
  });
}

const attr = (tag, name) => {
  const m = new RegExp(`\\b${name}="([^"]*)"`).exec(tag);
  return m ? unxml(m[1]) : '';
};

// ---- Word ----

function docxParagraph(p) {
  let text = '';
  for (const m of p.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:tab\/>|<w:br[^>]*\/>|<w:cr\/>/g)) {
    if (m[1] !== undefined) text += unxml(m[1]);
    else text += m[0].startsWith('<w:tab') ? '\t' : '\n';
  }
  const style = /<w:pStyle w:val="([^"]+)"/.exec(p)?.[1] || '';
  const h = /^(?:Heading|Title|Заголовок)\s?(\d)?/i.exec(style);
  if (h && text.trim()) return `${'#'.repeat(Math.min(Number(h[1] || 1), 4))} ${text.trim()}`;
  if (/<w:numPr[\s>/]/.test(p) && text.trim()) return `- ${text.trim()}`;
  return text;
}

function docxBody(xml) {
  const out = [];
  // Tables become Markdown tables; everything else is paragraphs in order.
  const re = /<w:tbl>[\s\S]*?<\/w:tbl>|<w:p[ >][\s\S]*?<\/w:p>|<w:p\/>/g;
  for (const m of xml.matchAll(re)) {
    const block = m[0];
    if (block.startsWith('<w:tbl>')) {
      const rows = [...block.matchAll(/<w:tr[ >][\s\S]*?<\/w:tr>/g)].map((r) =>
        [...r[0].matchAll(/<w:tc>[\s\S]*?<\/w:tc>/g)].map((c) => [...c[0].matchAll(/<w:p[ >][\s\S]*?<\/w:p>/g)].map((p) => docxParagraph(p[0])).join(' ').replace(/\|/g, '/').trim()),
      );
      if (rows.length) {
        const w = Math.max(...rows.map((r) => r.length));
        const line = (r) => `| ${Array.from({ length: w }, (_, i) => r[i] || '').join(' | ')} |`;
        out.push([line(rows[0]), `|${' --- |'.repeat(w)}`, ...rows.slice(1).map(line)].join('\n'));
      }
    } else out.push(docxParagraph(block));
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

// ---- Excel ----

const DATE_FMT_IDS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);
function excelDate(serial, withTime) {
  const ms = Math.round((serial - 25569) * 86400e3);
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return String(serial);
  const iso = d.toISOString();
  return withTime && serial % 1 ? `${iso.slice(0, 10)} ${iso.slice(11, 16)}` : iso.slice(0, 10);
}

function colIndex(ref) {
  const letters = /^[A-Z]+/.exec(ref || '')?.[0] || 'A';
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

async function xlsxText(zip, { maxRows = 2000 } = {}) {
  const shared = [];
  const ss = await zip.text('xl/sharedStrings.xml');
  for (const si of ss.matchAll(/<si>([\s\S]*?)<\/si>/g)) shared.push([...si[1].matchAll(/<t(?:\s[^>]*)?>([^<]*)<\/t>/g)].map((t) => unxml(t[1])).join(''));
  // Which cell styles are dates.
  const styles = await zip.text('xl/styles.xml');
  const customDate = new Set();
  for (const f of styles.matchAll(/<numFmt [^>]*\/>/g)) {
    const code = attr(f[0], 'formatCode').replace(/"[^"]*"|\[[^\]]*\]/g, '');
    if (/[dmyhs]/i.test(code) && !/^[#0.,%\s]*$/.test(code)) customDate.add(Number(attr(f[0], 'numFmtId')));
  }
  const xfs = /<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/.exec(styles)?.[1] || '';
  const dateStyle = [...xfs.matchAll(/<xf [^>]*?(?:\/>|>)/g)].map((x) => {
    const id = Number(attr(x[0], 'numFmtId'));
    return DATE_FMT_IDS.has(id) || customDate.has(id);
  });
  // Sheets in workbook order.
  const wb = await zip.text('xl/workbook.xml');
  const rels = await zip.text('xl/_rels/workbook.xml.rels');
  const target = new Map([...rels.matchAll(/<Relationship [^>]*\/>/g)].map((r) => [attr(r[0], 'Id'), attr(r[0], 'Target')]));
  const parts = [];
  let truncated = false;
  for (const s of wb.matchAll(/<sheet [^>]*\/>/g)) {
    const name = attr(s[0], 'name');
    let file = target.get(attr(s[0], 'r:id')) || '';
    file = file.startsWith('/') ? file.slice(1) : `xl/${file.replace(/^\.\//, '')}`;
    const xml = await zip.text(file);
    const rows = [];
    for (const r of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
      if (rows.length >= maxRows) {
        truncated = true;
        break;
      }
      const row = [];
      for (const c of r[1].matchAll(/<c ([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const a = c[1];
        const body = c[2] || '';
        const type = /\bt="([^"]+)"/.exec(a)?.[1] || 'n';
        const v = /<v>([^<]*)<\/v>/.exec(body)?.[1];
        let val = '';
        if (type === 's') val = shared[Number(v)] ?? '';
        else if (type === 'inlineStr') val = [...body.matchAll(/<t(?:\s[^>]*)?>([^<]*)<\/t>/g)].map((t) => unxml(t[1])).join('');
        else if (type === 'b') val = v === '1' ? 'TRUE' : 'FALSE';
        else if (v !== undefined) {
          const style = Number(/\bs="(\d+)"/.exec(a)?.[1] || 0);
          val = dateStyle[style] && Number.isFinite(Number(v)) ? excelDate(Number(v), true) : unxml(v);
        }
        row[colIndex(/\br="([A-Z]+)/.exec(a)?.[1])] = val.replace(/\s*\n\s*/g, ' ').replace(/\|/g, '/');
      }
      if (row.some((x) => x)) rows.push(Array.from(row, (x) => x ?? ''));
    }
    if (!rows.length) continue;
    const w = Math.max(...rows.map((r) => r.length));
    const line = (r) => `| ${Array.from({ length: w }, (_, i) => r[i] || '').join(' | ')} |`;
    parts.push(`## ${name}\n\n${[line(rows[0]), `|${' --- |'.repeat(w)}`, ...rows.slice(1).map(line)].join('\n')}`);
  }
  return { text: parts.join('\n\n'), truncated };
}

// ---- PowerPoint ----

async function pptxText(zip) {
  const slides = zip.names
    .map((n) => /^ppt\/slides\/slide(\d+)\.xml$/.exec(n))
    .filter(Boolean)
    .sort((a, b) => Number(a[1]) - Number(b[1]));
  const out = [];
  for (const [file, n] of slides) {
    const xml = await zip.text(file);
    const paras = [...xml.matchAll(/<a:p>([\s\S]*?)<\/a:p>/g)].map((p) => [...p[1].matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((t) => unxml(t[1])).join('')).filter((s) => s.trim());
    out.push(`## Slide ${n}\n\n${paras.join('\n')}`);
  }
  return out.join('\n\n');
}

// ---- OpenDocument (LibreOffice) ----

async function odfText(zip) {
  const xml = await zip.text('content.xml');
  return unxml(
    xml
      .replace(/<text:tab\/>/g, '\t')
      .replace(/<text:line-break\/>/g, '\n')
      .replace(/<\/(text:p|text:h|table:table-row)>/g, '\n')
      .replace(/<\/table:table-cell>/g, ' | ')
      .replace(/<[^>]+>/g, ''),
  )
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ---- PDF ----

async function pdfText(bytes, pdfjs, { maxPages = 500 } = {}) {
  const doc = await pdfjs.getDocument({ data: bytes, isEvalSupported: false, useSystemFonts: false, disableFontFace: true, verbosity: 0 }).promise;
  const pages = [];
  const n = Math.min(doc.numPages, maxPages);
  for (let i = 1; i <= n; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    let s = '';
    for (const item of content.items) {
      if (!('str' in item)) continue;
      s += item.str;
      s += item.hasEOL ? '\n' : item.str && !/\s$/.test(item.str) ? ' ' : '';
    }
    pages.push(s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim());
    page.cleanup?.();
  }
  const total = doc.numPages;
  await doc.destroy?.();
  const chars = pages.join('').replace(/\s/g, '').length;
  return { pages, total, scanned: total > 0 && chars < 40 * Math.min(total, n) };
}

/**
 * name: file name; bytes: Uint8Array. opts.pdfjs: the pdf.js module (needed for PDF).
 * Returns { kind, text, pages?, totalPages?, scanned?, truncated }.
 */
export async function extractDocument(name, bytes, { pdfjs, maxChars = 400000 } = {}) {
  const ext = (/\.(\w+)$/.exec(name)?.[1] || '').toLowerCase();
  let r;
  if (ext === 'pdf') {
    if (!pdfjs) throw new Error('PDF reader not loaded');
    const p = await pdfText(bytes, pdfjs);
    r = { kind: 'pdf', text: p.pages.map((s, i) => `--- Page ${i + 1} ---\n${s}`).join('\n\n'), pages: p.pages, totalPages: p.total, scanned: p.scanned, truncated: p.pages.length < p.total };
  } else {
    const zip = readZip(bytes);
    if (ext === 'docx') r = { kind: 'word', text: docxBody(await zip.text('word/document.xml')) };
    else if (ext === 'xlsx' || ext === 'xlsm') r = { kind: 'excel', ...(await xlsxText(zip)) };
    else if (ext === 'pptx') r = { kind: 'powerpoint', text: await pptxText(zip) };
    else if (ext === 'odt' || ext === 'ods' || ext === 'odp') r = { kind: 'opendocument', text: await odfText(zip) };
    else throw new Error('unknown document type');
  }
  if (r.text.length > maxChars) {
    r.text = `${r.text.slice(0, maxChars)}\n…`;
    r.truncated = true;
  }
  return r;
}

// Rough token count, for "will this fit in the model's memory?": Cyrillic and CJK need more tokens per letter.
export function estimateTokens(text) {
  const s = String(text || '');
  const wide = (s.match(/[Ѐ-ӿ぀-鿿]/g) || []).length;
  return Math.ceil(wide / 2.6 + (s.length - wide) / 3.8);
}
