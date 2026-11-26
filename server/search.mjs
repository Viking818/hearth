// Web search without a key or an account: the result page of DuckDuckGo, then Brave's, then Bing's when the one
// before refuses. They are asked the way a browser asks, and politely, because they refuse a program that asks fast:
//   - one question at a time per site, 2.5 to 4 seconds apart, at most 8 a minute;
//   - the same question within half an hour is answered from memory;
//   - a site that refuses (a "prove you are a person" page, or 202 / 403 / 429) is left alone for a minute, then two,
//     four … up to ten, instead of being asked again, which only makes the refusal last longer;
//   - a timeout or a server error gets one more try, then the next site;
//   - results that have nothing to do with the question count as a refusal: a site that takes the asker for a
//     program sometimes answers with a page about one word of the question, or about something else entirely
//     (seen with Bing, 2026-11-15), and wrong results are worse for the model than none.
// Nothing here knows about Hearth's settings or network code: the page getter is passed in, so tests need no internet.

const DDG_URL = 'https://html.duckduckgo.com/html/';
const BRAVE_URL = 'https://search.brave.com/search';
const BING_HOME = 'https://www.bing.com/';
const BING_URL = 'https://www.bing.com/search';
// An ordinary browser's name. The sites answer "Hearth" or "node" with a refusal at once.
const BROWSER = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

const CACHE_MS = 30 * 60e3;
const CACHE_MAX = 120;
const GAP_MS = 2500;
const JITTER_MS = 1500;
const PER_MINUTE = 8;
const COOL_MS = 60e3;
const COOL_MAX_MS = 10 * 60e3;
const RETRY_MS = 1500;

const BASIC = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const basicPlain = (html) =>
  String(html)
    .replace(/<[^>]*>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => {
      if (e[0] !== '#') return BASIC[e.toLowerCase()] ?? m;
      const code = /^#x/i.test(e) ? parseInt(e.slice(2), 16) : Number(e.slice(1));
      return code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    })
    .replace(/\s+/g, ' ')
    .trim();

const attr = (tag, name) => new RegExp(`\\b${name}=["']([^"']*)["']`, 'i').exec(tag)?.[1];
const unamp = (s) => String(s).replace(/&amp;/g, '&');
const web = (u) => (/^https?:$/.test(u.protocol) ? u.href : null);

function unique(rows) {
  const seen = new Set();
  return rows.filter((r) => !seen.has(r.url) && seen.add(r.url));
}

// DuckDuckGo wraps each result link in its own redirect; the real address is in "uddg".
export function ddgTarget(href) {
  let v = unamp(href).trim();
  if (v.startsWith('//')) v = `https:${v}`;
  try {
    const u = new URL(v, 'https://duckduckgo.com/');
    const real = u.searchParams.get('uddg');
    if (real) return web(new URL(real));
    if (/(^|\.)duckduckgo\.com$/i.test(u.hostname)) return null; // its own page or an ad
    return web(u);
  } catch {
    return null;
  }
}

export function parseDdg(html, plain = basicPlain) {
  const page = String(html);
  const links = [...page.matchAll(/<a\b[^>]*class="[^"]*\bresult__a\b[^"]*"[^>]*>/gi)];
  const out = [];
  links.forEach((open, i) => {
    const from = open.index + open[0].length;
    const chunk = page.slice(from, links[i + 1]?.index ?? page.length);
    const end = chunk.indexOf('</a>');
    const url = ddgTarget(attr(open[0], 'href') || '');
    const title = end < 0 ? '' : plain(chunk.slice(0, end));
    if (!url || !title) return;
    // Ads are result blocks marked as such.
    const block = page.lastIndexOf('<div class="result', open.index);
    if (block >= 0 && /result--ad|result__ad/.test(page.slice(block, page.indexOf('>', block) + 1))) return;
    const sn = /<(a|td|div)\b[^>]*class="[^"]*\bresult__snippet\b[^"]*"[^>]*>([\s\S]*?)<\/\1>/i.exec(chunk);
    out.push({ title, url, snippet: sn ? plain(sn[2]) : '' });
  });
  return unique(out);
}

export function ddgBlocked(status, html) {
  if ([202, 403, 418, 429].includes(status)) return true;
  const page = String(html).slice(0, 60000);
  return !/\bresult__a\b/.test(page) && /anomaly-modal|anomaly\.js|challenge-form|unusual traffic|captcha/i.test(page);
}

// Brave's page. Sometimes it hides every result's address behind its own /go/ link; then there is nothing to give
// the model, and that counts as a refusal (braveBlocked).
export function parseBrave(html, plain = basicPlain) {
  const out = [];
  for (const part of String(html).split(/<div\b[^>]*class="snippet\b[^"]*"[^>]*data-type="web"[^>]*>/i).slice(1)) {
    const href = /<a\b[^>]*\bhref="([^"]*)"/i.exec(part)?.[1] || '';
    const title = /class="title\b[^"]*"[^>]*>([\s\S]*?)<\/div>/i.exec(part);
    const text = /class="content\b[^"]*"[^>]*>([\s\S]*?)<\/div>/i.exec(part);
    let url = null;
    try {
      const u = new URL(unamp(href));
      if (!/(^|\.)brave\.com$/i.test(u.hostname)) url = web(u);
    } catch {
      /* its own /go/ link, or nothing */
    }
    if (url && title && plain(title[1])) out.push({ title: plain(title[1]), url, snippet: text ? plain(text[1]) : '' });
  }
  return unique(out);
}

export function braveBlocked(status, html) {
  if ([403, 429, 503].includes(status)) return true;
  const page = String(html);
  const shown = (page.match(/class="snippet\b[^"]*"[^>]*data-type="web"/gi) || []).length;
  if (shown) return !parseBrave(page).length; // results, but every address hidden
  return /captcha|challenge|unusual traffic|are you a robot/i.test(page.slice(0, 80000));
}

// Bing wraps each result link too: /ck/a?…&u=a1<the real address in base64url>.
export function bingTarget(href) {
  try {
    const u = new URL(unamp(href).trim(), BING_HOME);
    if (!/(^|\.)bing\.com$/i.test(u.hostname)) return web(u);
    const packed = u.searchParams.get('u');
    if (!packed || !packed.startsWith('a1')) return null; // Bing's own page (pictures, maps, "more")
    return web(new URL(Buffer.from(packed.slice(2), 'base64url').toString('utf8')));
  } catch {
    return null;
  }
}

export function parseBing(html, plain = basicPlain) {
  const out = [];
  for (const part of String(html).split(/<li\b[^>]*\bclass="[^"]*\bb_algo\b[^"]*"/i).slice(1)) {
    const stop = part.search(/<li\b[^>]*\bclass="[^"]*\bb_(?:algo|ans|ad|pag)\b/i);
    const body = stop > 0 ? part.slice(0, stop) : part;
    const h2 = /<h2\b[^>]*>\s*<a\b([^>]*)>([\s\S]*?)<\/a>/i.exec(body);
    if (!h2) continue;
    const url = bingTarget(attr(h2[1], 'href') || '');
    const title = plain(h2[2]);
    if (!url || !title) continue;
    const sn = /<p\b[^>]*class="[^"]*\bb_lineclamp\d*\b[^"]*"[^>]*>([\s\S]*?)<\/p>/i.exec(body) || /class="[^"]*\bb_caption\b[^"]*"[^>]*>[\s\S]*?<p\b[^>]*>([\s\S]*?)<\/p>/i.exec(body);
    // Bing starts many snippets with a date and a dot: keep the words.
    out.push({ title, url, snippet: sn ? plain(sn[1]).replace(/^[^·]{0,24}·\s*/, '') : '' });
  }
  return unique(out);
}

export function bingBlocked(status, html) {
  if ([403, 429, 503].includes(status)) return true;
  const page = String(html).slice(0, 80000);
  return !/\bb_algo\b/.test(page) && /captcha|unusual traffic|are you a robot|verify you are (a )?human|challenge-platform/i.test(page);
}

const SMALL = new Set('the and for how what when where which who why with from are was were you your can does not this that than into about как что для это или при про где его она они так уже ещё если чем чтобы тоже есть был была были'.split(' '));
const stems = (text) => [...new Set((String(text).toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || []).filter((w) => !SMALL.has(w)).map((w) => (w.length > 4 ? w.slice(0, 4) : w)))];

// Do these results answer this question? At least two of them must share two of its words (one, for a one-word
// question). Word endings are ignored, so «стирать» finds «стирка».
export function related(query, results) {
  const want = stems(query);
  if (!want.length || !results.length) return true;
  const need = Math.min(2, want.length);
  const hits = results.slice(0, 8).filter((r) => {
    const words = `${r.title} ${r.snippet} ${decodeURIComponentSafe(r.url)}`.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || [];
    return want.filter((w) => words.some((x) => x.startsWith(w))).length >= need;
  }).length;
  return hits >= Math.min(2, results.length);
}

function decodeURIComponentSafe(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return String(s);
  }
}

// What the search tool tells the model when no site answers: one plain sentence, and not to try again.
export class SearchLimited extends Error {}

/**
 * get(url, { method, headers, body }) → { status, headers, html }. now, sleep and random can be swapped in tests.
 * Returns { search(query, { count, lang }), state() }.
 */
export function createFreeSearch({ get, plain = basicPlain, now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), random = Math.random }) {
  const cache = new Map(); // key → { at, results, source }
  let bingCookie = '';

  const lang = (l) => (l === 'ru' ? 'ru-RU,ru;q=0.9,en;q=0.6' : 'en-US,en;q=0.9');
  const sites = [
    {
      id: 'duckduckgo',
      async ask(q, l) {
        const body = new URLSearchParams({ q, b: '', kl: l === 'ru' ? 'ru-ru' : '' }).toString();
        const r = await get(DDG_URL, { method: 'POST', body, headers: { 'user-agent': BROWSER, 'accept-language': lang(l), 'content-type': 'application/x-www-form-urlencoded', origin: 'https://html.duckduckgo.com', referer: 'https://html.duckduckgo.com/' } });
        return { ...r, blocked: ddgBlocked(r.status, r.html), results: parseDdg(r.html, plain) };
      },
    },
    {
      id: 'brave',
      async ask(q, l) {
        const r = await get(`${BRAVE_URL}?${new URLSearchParams({ q, source: 'web' })}`, { headers: { 'user-agent': BROWSER, 'accept-language': lang(l) } });
        return { ...r, blocked: braveBlocked(r.status, r.html), results: parseBrave(r.html, plain) };
      },
    },
    {
      id: 'bing',
      async ask(q, l) {
        const headers = { 'user-agent': BROWSER, 'accept-language': lang(l) };
        // Without the cookie its front page hands out, Bing answers a long question as if it were its first word.
        if (!bingCookie) {
          const home = await get(BING_HOME, { headers });
          bingCookie = cookies(home.headers);
        }
        const r = await get(`${BING_URL}?${new URLSearchParams({ q, form: 'QBLH', setlang: l === 'ru' ? 'ru' : 'en' })}`, { headers: { ...headers, referer: BING_HOME, ...(bingCookie ? { cookie: bingCookie } : {}) } });
        const blocked = bingBlocked(r.status, r.html);
        if (blocked) bingCookie = '';
        return { ...r, blocked, results: parseBing(r.html, plain) };
      },
    },
  ].map((s) => ({ ...s, queue: Promise.resolve(), starts: [], strikes: 0, until: 0 }));

  // The site's turn: after the request before it, spaced out, and never more than PER_MINUTE a minute.
  function turn(site, work) {
    const run = site.queue.then(async () => {
      const gap = GAP_MS + Math.floor(random() * JITTER_MS);
      const last = site.starts[site.starts.length - 1] || 0;
      let wait = last ? last + gap - now() : 0;
      site.starts = site.starts.filter((at) => now() - at < 60e3);
      if (site.starts.length >= PER_MINUTE) wait = Math.max(wait, site.starts[0] + 60e3 - now());
      if (wait > 0) await sleep(wait);
      site.starts.push(now());
      return work();
    });
    site.queue = run.catch(() => {});
    return run;
  }

  function refuse(site, headers) {
    site.strikes++;
    const asked = Number(headers?.['retry-after']) * 1000;
    const cool = Math.min(COOL_MS * 2 ** (site.strikes - 1), COOL_MAX_MS);
    site.until = now() + Math.min(Math.max(cool, asked > 0 ? asked : 0), COOL_MAX_MS);
  }

  async function askSite(site, q, l) {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (now() < site.until) return null; // refused while this one waited its turn
      let r;
      try {
        r = await turn(site, () => (now() < site.until ? null : site.ask(q, l)));
      } catch {
        r = { status: 0, results: [] }; // no answer in time, or no connection
      }
      if (!r) return null;
      if (r.blocked || (r.status >= 200 && r.status < 300 && !related(q, r.results))) {
        refuse(site, r.headers);
        return null;
      }
      if (r.status >= 200 && r.status < 300) {
        site.strikes = 0;
        return r.results;
      }
      if (attempt === 0) await sleep(RETRY_MS);
    }
    return null;
  }

  async function search(query, { count = 8, lang: l = 'en' } = {}) {
    const q = String(query || '').trim();
    const key = `${l}\n${q.toLowerCase()}`;
    const hit = cache.get(key);
    if (hit && now() - hit.at < CACHE_MS) return { results: hit.results.slice(0, count), source: hit.source, cached: true };
    let nothing = '';
    let refused = 0;
    for (const site of sites) {
      if (now() < site.until) {
        refused++;
        continue;
      }
      const results = await askSite(site, q, l);
      if (!results) {
        refused++;
        continue;
      }
      if (!results.length) {
        nothing ||= site.id; // an empty page: the next site may know more
        continue;
      }
      cache.set(key, { at: now(), results, source: site.id });
      if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
      return { results: results.slice(0, count), source: site.id, cached: false };
    }
    // "Nothing found" only when no site refused: an empty page next to refusals is more likely a quiet refusal too
    // (seen with Bing, 2026-11-15).
    if (nothing && !refused) return { results: [], source: nothing, cached: false };
    throw new SearchLimited('limited');
  }

  return { search, state: () => sites.map((s) => ({ id: s.id, strikes: s.strikes, until: s.until })) };
}

// "name=value" pairs from Set-Cookie headers, for the Cookie header of the next request.
function cookies(headers) {
  const list = headers?.['set-cookie'];
  return (Array.isArray(list) ? list : list ? [list] : [])
    .map((c) => String(c).split(';')[0].trim())
    .filter((c) => /^[\w.-]+=/.test(c))
    .join('; ');
}
