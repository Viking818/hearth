// The web for the chat's tools: a search, and reading one page as plain text.
// Pages are fetched only from public addresses, so a page (or a model tricked by one) can never make Hearth
// reach this computer, the router, a NAS or anything else on the home network.
import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import net from 'node:net';
import zlib from 'node:zlib';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { getSettings, ROOT } from './settings.mjs';
import { t, getLang } from './i18n.mjs';
import { createFreeSearch, related, SearchLimited } from './search.mjs';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36 Hearth';

function privateV4(a, b, c) {
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0 && c === 0) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
}

// An IPv6 address as its 16 bytes, however it is written ("::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "fe80::1%en0").
function v6Bytes(ip) {
  let s = String(ip).toLowerCase().replace(/%.*$/, '');
  const tail = /(^|:)(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(s); // the last four bytes written as an IPv4 address
  if (tail) {
    const n = tail.slice(2).map(Number);
    s = `${s.slice(0, tail.index)}${tail[1]}${((n[0] << 8) | n[1]).toString(16)}:${((n[2] << 8) | n[3]).toString(16)}`;
  }
  const [head, rest] = s.split('::');
  const left = head ? head.split(':') : [];
  const right = rest ? rest.split(':') : [];
  const groups = rest === undefined ? left : [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right];
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  return groups.flatMap((g) => [parseInt(g, 16) >> 8, parseInt(g, 16) & 255]);
}

// Addresses that are not the public internet: this computer, the home network, and every IPv6 way of writing an
// IPv4 address (an IPv6 address may carry an IPv4 one inside, and the system then connects to that one).
export function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b, c] = ip.split('.').map(Number);
    return privateV4(a, b, c);
  }
  const x = v6Bytes(ip);
  if (!x) return true; // not an address Hearth understands: never open it
  const zero = (from, to) => x.slice(from, to).every((v) => v === 0);
  const inside = (i) => privateV4(x[i], x[i + 1], x[i + 2]);
  if (zero(0, 10) && ((x[10] === 255 && x[11] === 255) || (x[10] === 0 && x[11] === 0))) return inside(12); // ::ffff:a.b.c.d, ::a.b.c.d (also :: and ::1)
  if (zero(0, 8) && x[8] === 255 && x[9] === 255 && x[10] === 0 && x[11] === 0) return inside(12); // ::ffff:0:a.b.c.d
  if (x[0] === 0 && x[1] === 0x64 && x[2] === 0xff && x[3] === 0x9b) return !zero(4, 12) || inside(12); // 64:ff9b::/96 (NAT64); its local range is private
  if (x[0] === 0x20 && x[1] === 0x02) return inside(2); // 2002:a.b.c.d:: (6to4)
  if (x[0] === 0x20 && x[1] === 0x01 && x[2] === 0 && x[3] === 0) return true; // 2001::/32 (Teredo tunnels)
  return (x[0] & 0xfe) === 0xfc || (x[0] === 0xfe && (x[1] & 0x80) === 0x80) || x[0] === 0xff; // fc00::/7, fe80::/10 and fec0::/10, ff00::/8
}

// Checked when the connection is made (not just before), so a DNS answer can't change in between.
export function publicLookup(hostname, opts, cb) {
  dns.lookup(hostname, { ...opts, all: true }, (err, list) => {
    if (err) return cb(err);
    const ok = list.filter((a) => !isPrivateIp(a.address));
    if (!ok.length || ok.length !== list.length) return cb(Object.assign(new Error(t('Hearth only opens public web addresses.')), { code: 'EPRIVATE' }));
    if (opts.all) return cb(null, ok);
    cb(null, ok[0].address, ok[0].family);
  });
}

function getOnce(url, { headers = {}, method = 'GET', body, maxBytes, timeout }) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return reject(new Error(t('Only http and https links can be opened.')));
    if (net.isIP(u.hostname.replace(/^\[|\]$/g, '')) && isPrivateIp(u.hostname.replace(/^\[|\]$/g, ''))) return reject(new Error(t('Hearth only opens public web addresses.')));
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(u, { method, lookup: publicLookup, headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml,application/json,application/pdf;q=0.9,*/*;q=0.8', 'accept-encoding': 'gzip, deflate, br', 'accept-language': 'en,ru;q=0.8,*;q=0.5', ...headers }, timeout }, (res) => {
      const enc = String(res.headers['content-encoding'] || '');
      let stream = res;
      if (enc.includes('br')) stream = res.pipe(zlib.createBrotliDecompress());
      else if (enc.includes('gzip')) stream = res.pipe(zlib.createGunzip());
      else if (enc.includes('deflate')) stream = res.pipe(zlib.createInflate());
      const chunks = [];
      let size = 0;
      stream.on('data', (c) => {
        size += c.length;
        if (size > maxBytes) {
          req.destroy();
          resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks), cut: true });
          return;
        }
        chunks.push(c);
      });
      stream.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks), cut: false }));
      stream.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error(t('The page took too long to answer.'))));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

export async function fetchPublic(url, { maxBytes = 4 << 20, timeout = 20000, headers, method, body } = {}) {
  let cur = url;
  for (let hop = 0; hop < 6; hop++) {
    const r = await getOnce(cur, { headers, method, body, maxBytes, timeout });
    if (r.status >= 300 && r.status < 400 && r.headers.location) {
      cur = new URL(r.headers.location, cur).toString();
      method = 'GET';
      body = undefined;
      continue;
    }
    return { ...r, url: cur };
  }
  throw new Error(t('Too many redirects.'));
}

function decodeBody(r) {
  const type = String(r.headers['content-type'] || '');
  let charset = /charset=([\w-]+)/i.exec(type)?.[1];
  if (!charset && /html/i.test(type)) charset = /<meta[^>]+charset=["']?([\w-]+)/i.exec(r.body.subarray(0, 4096).toString('latin1'))?.[1];
  try {
    return new TextDecoder(charset || 'utf-8').decode(r.body);
  } catch {
    return r.body.toString('utf8');
  }
}

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', laquo: '«', raquo: '»', hellip: '…', copy: '©', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“' };
export function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => {
    try {
      if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1)));
    } catch {
      return m;
    }
    return ENT[e.toLowerCase()] ?? m;
  });
}

// Readable text from HTML: the main part when the page marks one, headings as "#", lists as "-".
export function htmlToText(html) {
  let s = html.replace(/<!--[\s\S]*?-->/g, ' ');
  const title = decodeEntities((/<title[^>]*>([\s\S]*?)<\/title>/i.exec(s)?.[1] || '').replace(/\s+/g, ' ').trim());
  s = s.replace(/<(script|style|noscript|svg|template|iframe|canvas|form|select|button)\b[\s\S]*?<\/\1>/gi, ' ');
  const main = /<main\b[\s\S]*?<\/main>/i.exec(s)?.[0] || /<article\b[\s\S]*?<\/article>/i.exec(s)?.[0];
  if (main && main.length > 500) s = main;
  else s = s.replace(/<(nav|footer|header|aside)\b[\s\S]*?<\/\1>/gi, ' ');
  s = s
    .replace(/<h([1-6])[^>]*>/gi, (m, l) => `\n\n${'#'.repeat(Math.min(Number(l), 4))} `)
    .replace(/<\/h[1-6]>/gi, '\n\n')
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<(br|hr)\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|section|tr|table|ul|ol|blockquote|pre|dd|dt|figure|article|main)>/gi, '\n\n')
    .replace(/<\/t[dh]>/gi, ' | ')
    .replace(/<[^>]+>/g, ' ');
  s = decodeEntities(s)
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { title, text: s };
}

// A file of Hearth's own as an address `import` takes on every system.
export const moduleUrl = (...parts) => pathToFileURL(path.join(ROOT, ...parts)).href;

let pdfjsP = null;
export function loadPdfjs() {
  if (!pdfjsP) {
    pdfjsP = (async () => {
      // pdf.js warns about drawing support it doesn't need for reading text; keep the console quiet.
      const warn = console.warn;
      const log = console.log;
      console.warn = () => {};
      console.log = () => {};
      try {
        // As file: addresses, not plain paths: on Windows a path like C:\… is not something `import` takes
        // (before 0.2.31 no PDF could be read on a Windows computer because of this).
        const m = await import(moduleUrl('public', 'vendor', 'pdfjs', 'pdf.min.mjs'));
        m.GlobalWorkerOptions.workerSrc = moduleUrl('public', 'vendor', 'pdfjs', 'pdf.worker.min.mjs');
        return m;
      } finally {
        console.warn = warn;
        console.log = log;
      }
    })();
  }
  return pdfjsP;
}

const THIN = 300; // fewer letters than this on a web page: it shows next to nothing without its scripts

// allowLocal, get: for the tests, whose pages live on this computer.
export async function openPage(url, { maxChars = 24000, offset = 0, allowLocal = false, get = fetchPublic } = {}) {
  const r = await get(url);
  let rendered = false; // read through a browser of this computer
  let thin = false; // even so, next to nothing to read
  let scanned = false; // a PDF whose pages are pictures
  if (r.status >= 400) throw new Error(t('The page answered with an error ({status}).', { status: r.status }));
  const type = String(r.headers['content-type'] || '');
  let title = '';
  let text = '';
  if (/pdf/i.test(type) || /\.pdf($|\?)/i.test(r.url)) {
    const { extractDocument } = await import('../public/js/docs.js');
    const doc = await extractDocument('page.pdf', new Uint8Array(r.body), { pdfjs: await loadPdfjs() });
    text = doc.text;
    scanned = Boolean(doc.scanned);
  } else if (/json|text\/plain|xml|csv/i.test(type) && !/html/i.test(type)) {
    text = decodeBody(r);
  } else {
    ({ title, text } = htmlToText(decodeBody(r)));
    // Almost nothing to read: the page is built by its scripts. A browser of this computer opens it without a
    // window (browser-page.mjs) and hands over what it shows.
    if (text.length < THIN && getSettings().renderPages !== false) {
      try {
        const { renderPage } = await import('./browser-page.mjs');
        // The browser has its own time limits; this one on top makes sure a page can never hold up an answer.
        const html = await Promise.race([renderPage(r.url, { allowLocal }), new Promise((resolve) => setTimeout(() => resolve(''), 50000).unref())]);
        const shown = htmlToText(html);
        if (shown.text.length > text.length) {
          ({ title, text } = shown);
          rendered = true;
        }
      } catch (err) {
        if (err.code !== 'NO_BROWSER') console.error('A browser could not open the page:', String(err.message || err));
      }
      thin = text.length < THIN;
    }
  }
  const part = text.slice(offset, offset + maxChars);
  const more = offset + maxChars < text.length;
  return { url: r.url, title, text: part, more, nextOffset: more ? offset + maxChars : 0, length: text.length, rendered, thin, scanned };
}

// ---- Search ----

export async function webSearch(query, { count = 8 } = {}) {
  const s = getSettings();
  const q = String(query || '').trim().slice(0, 300);
  if (!q) throw new Error(t('Empty search.'));
  if (s.searchProvider === 'brave') {
    if (!s.searchKey) throw new Error(t('Add a Brave Search key in Settings → Tools, or pick another search.'));
    const r = await fetchJson(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(q)}&count=${count}`, { 'x-subscription-token': s.searchKey, accept: 'application/json' });
    return (r.web?.results || []).slice(0, count).map((x) => ({ title: x.title, url: x.url, snippet: htmlToText(x.description || '').text }));
  }
  if (s.searchProvider === 'searxng') {
    if (!s.searchUrl) throw new Error(t('Add your SearXNG address in Settings → Tools.'));
    // The user's own SearXNG often lives on the home network, so this one address may be private.
    const base = s.searchUrl.replace(/\/+$/, '');
    const res = await fetch(`${base}/search?q=${encodeURIComponent(q)}&format=json`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error(t('Search answered with an error ({status}).', { status: res.status }));
    const j = await res.json();
    return (j.results || []).slice(0, count).map((x) => ({ title: x.title, url: x.url, snippet: x.content || '' }));
  }
  if (s.searchProvider === 'tavily') {
    if (!s.searchKey) throw new Error(t('Add a Tavily key in Settings → Tools, or pick another search.'));
    const r = await fetchPublic('https://api.tavily.com/search', { method: 'POST', body: JSON.stringify({ query: q, max_results: count }), headers: { 'content-type': 'application/json', authorization: `Bearer ${s.searchKey}` } });
    if (r.status >= 400) throw new Error(t('Search answered with an error ({status}).', { status: r.status }));
    const j = JSON.parse(decodeBody(r));
    return (j.results || []).slice(0, count).map((x) => ({ title: x.title, url: x.url, snippet: x.content || '' }));
  }
  if (s.searchProvider === 'wikipedia') return wikipedia(q, count);
  // No key: DuckDuckGo's result page, Bing's when it refuses (search.mjs), and Wikipedia when both refuse.
  const lang = /[а-яё]/i.test(q) ? 'ru' : 'en';
  try {
    return (await freeSearch().search(q, { count, lang })).results;
  } catch (err) {
    if (!(err instanceof SearchLimited)) throw err;
    const results = await wikipedia(q, count).catch(() => []);
    if (!results.length || !related(q, results)) throw new Error(t('Web search is limited right now. Do not search again now: go on with what you know, and tell the user that the search was limited and that a search key in Settings → Tools makes it steadier.'));
    results.note = t('Web search is limited right now, so these results are from Wikipedia only. Do not search again now; open well-known websites with open_page if you need more.');
    return results;
  }
}

let free = null;
function freeSearch() {
  free ||= createFreeSearch({
    plain: (html) => decodeEntities(String(html).replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim(),
    get: async (url, opts) => {
      const r = await fetchPublic(url, { ...opts, maxBytes: 2 << 20, timeout: 15000 });
      return { status: r.status, headers: r.headers, html: decodeBody(r) };
    },
  });
  return free;
}

// Wikipedia: no key needed. Russian questions go to the Russian Wikipedia, others to the English one.
async function wikipedia(q, count) {
  const langs = /[а-яё]/i.test(q) || getLang() === 'ru' ? ['ru', 'en'] : ['en'];
  for (const lang of langs) {
    const j = await fetchJson(`https://${lang}.wikipedia.org/w/api.php?action=query&list=search&format=json&utf8=1&srlimit=${count}&srsearch=${encodeURIComponent(q)}`, { 'user-agent': 'Hearth/0.2 (personal assistant on a home computer)' });
    const hits = j.query?.search || [];
    if (hits.length) return hits.map((x) => ({ title: x.title, url: `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(x.title.replace(/ /g, '_'))}`, snippet: htmlToText(x.snippet || '').text }));
  }
  return [];
}

async function fetchJson(url, headers) {
  const r = await fetchPublic(url, { headers });
  if (r.status >= 400) throw new Error(t('Search answered with an error ({status}).', { status: r.status }));
  return JSON.parse(decodeBody(r));
}
