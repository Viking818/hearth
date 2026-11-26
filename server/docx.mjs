// Writing a Word document (.docx): a zip of a few small XML files. The text comes with simple marks, the way a
// model writes anyway: "# " headings, "- " list items, "1. " numbered items, **bold**, *italic*, "| a | b |" table
// rows. Every line is a paragraph of its own, so a form keeps its lines.
import { zipStore } from '../public/js/xlsx.js';

const xml = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');

// One stretch of text, bold or italic or plain.
const runXml = (text, { b = false, i = false } = {}) => (text ? `<w:r>${b || i ? `<w:rPr>${b ? '<w:b/>' : ''}${i ? '<w:i/>' : ''}</w:rPr>` : ''}<w:t xml:space="preserve">${xml(text)}</w:t></w:r>` : '');

// **bold**, *italic* and ***both*** inside a line.
function runs(text, base = {}) {
  let out = '';
  let at = 0;
  // Underscores are left alone: a form is full of lines like "Signature: ________".
  for (const m of String(text).matchAll(/(\*\*\*|\*\*|\*)(\S(?:.*?\S)?)\1/g)) {
    out += runXml(text.slice(at, m.index), base);
    out += runXml(m[2], { b: base.b || m[1] !== '*', i: base.i || m[1] === '*' || m[1] === '***' });
    at = m.index + m[0].length;
  }
  return out + runXml(text.slice(at), base);
}

const para = (inner, props = '') => `<w:p>${props ? `<w:pPr>${props}</w:pPr>` : ''}${inner}</w:p>`;
const cells = (line) => line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());

function tableXml(rows) {
  const width = Math.max(...rows.map((r) => r.length));
  const col = Math.floor(9000 / width);
  const border = ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map((s) => `<w:${s} w:val="single" w:sz="4" w:space="0" w:color="999999"/>`).join('');
  const body = rows
    .map((r, n) => `<w:tr>${Array.from({ length: width }, (_, i) => `<w:tc><w:tcPr><w:tcW w:w="${col}" w:type="dxa"/></w:tcPr>${para(runs(r[i] || '', { b: n === 0 }))}</w:tc>`).join('')}</w:tr>`)
    .join('');
  return `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/><w:tblBorders>${border}</w:tblBorders></w:tblPr><w:tblGrid>${`<w:gridCol w:w="${col}"/>`.repeat(width)}</w:tblGrid>${body}</w:tbl>${para('')}`;
}

// The body of the document from the marked text.
export function docxBodyXml(content) {
  const lines = String(content ?? '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n];
    const s = line.trim();
    if (!s) {
      // One empty line only separates paragraphs; more of them are kept as room on the page.
      if (n > 0 && !lines[n - 1].trim()) out.push(para(''));
      continue;
    }
    if (/^\|.*\|$/.test(s)) {
      const rows = [];
      for (; n < lines.length && /^\|.*\|$/.test(lines[n].trim()); n++) if (!/^\|[\s:|-]+\|$/.test(lines[n].trim())) rows.push(cells(lines[n]));
      n--;
      if (rows.length) out.push(tableXml(rows));
      continue;
    }
    const head = /^(#{1,4})\s+(.*)$/.exec(s);
    if (head) out.push(para(runs(head[2].replace(/\*\*/g, '')), `<w:pStyle w:val="Heading${Math.min(head[1].length, 3)}"/>`));
    else if (/^(-{3,}|\*{3,}|_{3,})$/.test(s)) out.push(para('', '<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="999999"/></w:pBdr>'));
    else if (/^[-*•]\s+/.test(s)) out.push(para(runXml('•\t') + runs(s.replace(/^[-*•]\s+/, '')), '<w:tabs><w:tab w:val="left" w:pos="720"/></w:tabs><w:ind w:left="720" w:hanging="360"/>'));
    else if (/^\d+[.)]\s+/.test(s)) out.push(para(runXml(`${/^\d+[.)]/.exec(s)[0]}\t`) + runs(s.replace(/^\d+[.)]\s+/, '')), '<w:tabs><w:tab w:val="left" w:pos="720"/></w:tabs><w:ind w:left="720" w:hanging="360"/>'));
    else out.push(para(runs(s)));
  }
  return out.join('');
}

const NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const heading = (id, name, size, before) => `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${name}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="${before}" w:after="120"/></w:pPr><w:rPr><w:b/><w:sz w:val="${size}"/><w:szCs w:val="${size}"/></w:rPr></w:style>`;
const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles ${NS}><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/><w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="140" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>${heading('Heading1', 'heading 1', 36, 360)}${heading('Heading2', 'heading 2', 28, 280)}${heading('Heading3', 'heading 3', 24, 220)}</w:styles>`;

// content: the text with its simple marks. Returns the .docx file as bytes.
export async function docxBytes(content) {
  const doc = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${NS}><w:body>${docxBodyXml(content)}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>`;
  const blob = zipStore([
    ['[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>'],
    ['_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'],
    ['word/_rels/document.xml.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>'],
    ['word/document.xml', doc],
    ['word/styles.xml', STYLES],
  ]);
  return new Uint8Array(await blob.arrayBuffer());
}
