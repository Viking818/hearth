// The search without a key (server/search.mjs): reading the result pages, telling a refusal from results, and the
// manners towards the sites (spacing, memory, backing off). No internet: the page getter is a stand-in.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDdg, ddgBlocked, ddgTarget, parseBrave, braveBlocked, parseBing, bingBlocked, bingTarget, related, createFreeSearch, SearchLimited } from '../server/search.mjs';

const ddgPage = (rows) => `<html><body><div class="results">${rows
  .map((r) => `<div class="result results_links${r.ad ? ' result--ad' : ''}"><h2 class="result__title"><a rel="nofollow" class="result__a" href="${r.href}">${r.title}</a></h2><a class="result__snippet" href="${r.href}">${r.text}</a></div>`)
  .join('')}</div></body></html>`;
const wrap = (url) => `//duckduckgo.com/l/?uddg=${encodeURIComponent(url)}&amp;rut=abc`;
const bingLink = (url) => `https://www.bing.com/ck/a?!&amp;&amp;p=1&amp;u=a1${Buffer.from(url).toString('base64url')}&amp;ntb=1`;
const bingPage = (rows) => `<html><body><ol id="b_results">${rows.map((r) => `<li class="b_algo" data-id><h2><a target="_blank" href="${bingLink(r.url)}">${r.title}</a></h2><div class="b_caption"><p class="b_lineclamp2">${r.text}</p></div></li>`).join('')}<li class="b_pag"></li></ol></body></html>`;
const bravePage = (rows) => `<html><body>${rows.map((r, i) => `<div class="snippet svelte-x" data-pos="${i}" data-type="web"><a href="${r.url}" target="_self" class="svelte-y l1"><cite>site</cite><div class="title search-snippet-title" title="x">${r.title}</div></a><div class="generic-snippet"><div class="content t-primary"><!--[0-->${r.text}<!--]--></div></div></div>`).join('')}</body></html>`;

const WASH = [
  { url: 'https://shirts.example/wash-printed-shirts', title: 'How to <b>wash</b> printed shirts', text: 'Turn the printed shirt inside out &amp; wash cold.' },
  { url: 'https://laundry.example/printed-tees', title: 'Washing printed tees', text: 'Wash printed tees at 30 degrees.' },
  { url: 'https://care.example/guide', title: 'Shirt care guide', text: 'How to wash a printed shirt so the print lasts.' },
];
const JUNK = [
  { url: 'https://news.example/', title: 'The Washington Post', text: 'Breaking news and headlines.' },
  { url: 'https://dict.example/wash', title: 'WASH definition', text: 'The meaning of wash.' },
  { url: 'https://river.example/', title: 'The Wash - an estuary', text: 'A bay in England.' },
];

test('DuckDuckGo’s page: real addresses, no ads, plain titles and text', () => {
  const rows = parseDdg(ddgPage([{ href: wrap(WASH[0].url), title: WASH[0].title, text: WASH[0].text }, { href: wrap('https://ads.example/'), title: 'Buy shirts', text: 'ad', ad: true }, { href: 'https://duckduckgo.com/y.js?ad=1', title: 'Own link', text: '' }, { href: wrap(WASH[0].url), title: 'Twice', text: '' }]));
  assert.deepEqual(rows, [{ title: 'How to wash printed shirts', url: WASH[0].url, snippet: 'Turn the printed shirt inside out & wash cold.' }]);
  assert.equal(ddgTarget('javascript:alert(1)'), null);
  assert.equal(ddgBlocked(202, ''), true, '202 is DuckDuckGo’s “prove you are a person”');
  assert.equal(ddgBlocked(200, '<div class="anomaly-modal"><form id="challenge-form">'), true);
  assert.equal(ddgBlocked(200, ddgPage([{ href: wrap(WASH[0].url), title: 'captcha solver review', text: '' }])), false, 'a page with results is never a refusal');
});

test('Bing’s page: the address is unpacked from its redirect link', () => {
  const rows = parseBing(bingPage([{ ...WASH[0], text: 'Oct 30, 2026&nbsp;&#0183;&#32;Turn it inside out.' }, WASH[1]]));
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { title: 'How to wash printed shirts', url: WASH[0].url, snippet: 'Turn it inside out.' });
  assert.equal(bingTarget('https://www.bing.com/images/search?q=x'), null, 'Bing’s own pages are not results');
  assert.equal(bingTarget(`https://www.bing.com/ck/a?u=a1${Buffer.from('file:///etc/passwd').toString('base64url')}`), null, 'only web addresses');
  assert.equal(bingBlocked(200, '<div>Please solve the CAPTCHA</div>'), true);
  assert.equal(bingBlocked(200, bingPage(WASH)), false);
  assert.equal(bingBlocked(429, bingPage(WASH)), true);
});

test('Brave’s page: results with hidden addresses count as a refusal', () => {
  const rows = parseBrave(bravePage(WASH));
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[1], { title: 'Washing printed tees', url: WASH[1].url, snippet: 'Wash printed tees at 30 degrees.' });
  const hidden = bravePage(WASH.map((r) => ({ ...r, url: '/go/v1/AdXFKYpngIRA' })));
  assert.equal(parseBrave(hidden).length, 0);
  assert.equal(braveBlocked(200, hidden), true);
  assert.equal(braveBlocked(200, bravePage(WASH)), false);
  assert.equal(braveBlocked(429, ''), true);
});

test('results that do not match the question are told apart', () => {
  const rows = (list) => list.map((r) => ({ title: r.title, url: r.url, snippet: r.text }));
  assert.equal(related('how to wash a printed t-shirt', rows(WASH)), true);
  assert.equal(related('how to wash a printed t-shirt', rows(JUNK)), false, 'an answer about one word of the question');
  assert.equal(related('как стирать футболку с принтом', [{ title: 'Стирка футболок с принтом', url: 'https://a.example/', snippet: '' }, { title: 'Уход за принтом', url: 'https://b.example/', snippet: 'Футболку стирают наизнанку.' }]), true, 'word endings do not matter');
  assert.equal(related('как стирать футболку с принтом', [{ title: 'Немцы, серия 8', url: 'https://a.example/', snippet: 'Смотреть онлайн' }, { title: 'Прямая трансляция', url: 'https://b.example/', snippet: '' }]), false);
  assert.equal(related('weather in Los Angeles tomorrow', [{ title: 'San Francisco weather', url: 'https://w.example/sf', snippet: 'Close to the bay.' }, { title: 'San Francisco hourly weather', url: 'https://w.example/sf2', snippet: '' }]), false, '“los” inside “close” is not a match');
  assert.equal(related('wikipedia', [{ title: 'Wikipedia', url: 'https://wikipedia.org/', snippet: '' }]), true, 'a one-word question needs one word');
  assert.equal(related('', rows(JUNK)), true);
});

// A stand-in for the three sites and a clock that only moves when the search sleeps.
function world(answers) {
  let clock = 1_000_000;
  const asked = [];
  const get = async (url, opts = {}) => {
    const site = url.includes('duckduckgo') ? 'ddg' : url.includes('brave') ? 'brave' : url.endsWith('bing.com/') ? 'bing-home' : 'bing';
    asked.push({ site, at: clock, cookie: opts.headers?.cookie || '', q: opts.body ? new URLSearchParams(opts.body).get('q') : new URL(url).searchParams.get('q') });
    const a = answers[site];
    const r = typeof a === 'function' ? a(asked.filter((x) => x.site === site).length) : a;
    if (r instanceof Error) throw r;
    return { status: 200, headers: {}, html: '', ...r };
  };
  const free = createFreeSearch({ get, now: () => clock, sleep: async (ms) => void (clock += ms), random: () => 0.5 });
  return { free, asked, tick: (ms) => (clock += ms), sites: () => asked.map((a) => a.site) };
}
const okDdg = { html: ddgPage(WASH.map((r) => ({ href: wrap(r.url), title: r.title, text: r.text }))) };
const Q = 'how to wash a printed t-shirt';

test('the first site that answers is used, and the same question is remembered', async () => {
  const w = world({ ddg: okDdg });
  const r = await w.free.search(Q, { count: 2 });
  assert.equal(r.source, 'duckduckgo');
  assert.equal(r.results.length, 2);
  assert.equal(w.asked[0].q, Q);
  const again = await w.free.search(`  ${Q.toUpperCase()} `);
  assert.equal(again.cached, true);
  assert.equal(again.results.length, 3, 'the memory keeps the whole list');
  assert.deepEqual(w.sites(), ['ddg'], 'no second request');
  w.tick(31 * 60e3);
  await w.free.search(Q);
  assert.deepEqual(w.sites(), ['ddg', 'ddg'], 'after half an hour it asks again');
});

test('questions to one site are spaced out, and held to eight a minute', async () => {
  const w = world({ ddg: okDdg });
  for (let i = 0; i < 10; i++) await w.free.search(`${Q} ${i}`);
  const gaps = w.asked.slice(1).map((a, i) => a.at - w.asked[i].at);
  assert.ok(gaps.slice(0, 7).every((g) => g === 3250), `2.5 s plus the random part: ${gaps}`);
  assert.ok(w.asked[8].at - w.asked[0].at >= 60e3, 'the ninth waits for the minute to pass');
});

test('a refusal moves on to the next site and leaves the refusing one alone, longer each time', async () => {
  const w = world({ ddg: { status: 202, html: '<div class="anomaly-modal">' }, brave: { html: bravePage(WASH) } });
  assert.equal((await w.free.search(Q)).source, 'brave');
  await w.free.search(`${Q} 2`);
  assert.deepEqual(w.sites(), ['ddg', 'brave', 'brave'], 'DuckDuckGo is not asked again during its minute');
  w.tick(61e3);
  await w.free.search(`${Q} 3`);
  assert.equal(w.sites().filter((s) => s === 'ddg').length, 2);
  assert.equal(w.free.state()[0].strikes, 2);
  w.tick(61e3);
  await w.free.search(`${Q} 4`);
  assert.equal(w.sites().filter((s) => s === 'ddg').length, 2, 'the second refusal costs two minutes');
  w.tick(61e3);
  await w.free.search(`${Q} 5`);
  assert.equal(w.sites().filter((s) => s === 'ddg').length, 3);
});

test('Bing gets the cookie of its front page, and results about something else are not passed on', async () => {
  const blocked = { status: 202 };
  const w = world({ ddg: blocked, brave: { status: 429 }, 'bing-home': { headers: { 'set-cookie': ['MUID=abc; path=/; secure', 'SRCHD=AF=NOFORM; path=/'] } }, bing: { html: bingPage(WASH) } });
  const r = await w.free.search(Q);
  assert.equal(r.source, 'bing');
  assert.equal(w.asked.find((a) => a.site === 'bing').cookie, 'MUID=abc; SRCHD=AF=NOFORM');
  await w.free.search(`${Q} again`);
  assert.equal(w.sites().filter((s) => s === 'bing-home').length, 1, 'the front page is opened once');

  const junk = world({ ddg: blocked, brave: { status: 403 }, bing: { html: bingPage(JUNK) } });
  await assert.rejects(junk.free.search(Q), SearchLimited);
  assert.equal(junk.free.state()[2].strikes, 1, 'wrong results count as a refusal');
  await assert.rejects(junk.free.search(`${Q} 2`), SearchLimited);
  assert.equal(junk.asked.length, 4, 'while every site is left alone, nothing is asked');
});

test('a site that does not answer gets one more try; an empty page is “nothing found”, not a refusal', async () => {
  const w = world({ ddg: (n) => (n === 1 ? new Error('timeout') : okDdg) });
  assert.equal((await w.free.search(Q)).source, 'duckduckgo');
  assert.deepEqual(w.sites(), ['ddg', 'ddg']);

  const down = world({ ddg: { status: 500 }, brave: new Error('no connection'), 'bing-home': {}, bing: { html: bingPage(WASH) } });
  assert.equal((await down.free.search(Q)).source, 'bing');
  assert.equal(down.free.state()[0].strikes, 0, 'a server error is not a refusal');

  const empty = world({ ddg: { html: '<html><body>No results.</body></html>' }, brave: { html: '<html></html>' }, 'bing-home': {}, bing: { html: '<ol id="b_results"></ol>' } });
  assert.deepEqual((await empty.free.search('zzzqqq xxyyzz')).results, []);

  // An empty page while the other sites refuse is more likely a quiet refusal than "nothing on the whole web".
  const quiet = world({ ddg: { status: 202 }, brave: { status: 429 }, 'bing-home': {}, bing: { html: '<ol id="b_results"></ol>' } });
  await assert.rejects(quiet.free.search(Q), SearchLimited);
});
