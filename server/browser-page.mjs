// Pages that build themselves with scripts. Many pages hold nothing but an empty frame until their scripts have run,
// and Hearth's own reader does not run scripts. For those, Hearth asks a browser that is already on the computer
// (Edge on Windows, Chrome, Brave or Chromium anywhere) to open the page without a window and hand over what it shows.
// Nothing is downloaded for this, and the user's own browser profile is not touched: the browser runs with a fresh,
// empty profile in a temporary folder that is deleted afterwards, so it has no sign-ins, cookies or history.
// Everything that browser loads goes through a small gate inside Hearth (a proxy on this computer) that lets only
// public web addresses through: a page cannot make it look at this computer or the home network.
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { IS_WIN, IS_MAC, exists, run } from './util.mjs';
import { isLocalAddress, publicLookup } from './web.mjs';

let found = null; // { at, path }
// A Chromium-family browser on this computer: '' when there is none.
export async function findBrowser() {
  if (process.env.HEARTH_BROWSER !== undefined) return process.env.HEARTH_BROWSER; // tests: a stand-in, or '' for none
  if (found && Date.now() - found.at < 10 * 60e3) return found.path;
  const places = [];
  if (IS_WIN) {
    const roots = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, process.env.LOCALAPPDATA].filter(Boolean);
    for (const rel of ['Microsoft\\Edge\\Application\\msedge.exe', 'Google\\Chrome\\Application\\chrome.exe', 'BraveSoftware\\Brave-Browser\\Application\\brave.exe', 'Chromium\\Application\\chrome.exe']) for (const r of roots) places.push(path.join(r, rel));
  } else if (IS_MAC) {
    for (const app of ['Google Chrome.app/Contents/MacOS/Google Chrome', 'Microsoft Edge.app/Contents/MacOS/Microsoft Edge', 'Brave Browser.app/Contents/MacOS/Brave Browser', 'Chromium.app/Contents/MacOS/Chromium']) for (const r of ['/Applications', path.join(os.homedir(), 'Applications')]) places.push(path.join(r, app));
  } else {
    for (const name of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge', 'brave-browser']) {
      const p = (await run('which', [name])).trim().split('\n')[0];
      if (p) places.push(p);
    }
  }
  found = { at: Date.now(), path: places.find((p) => exists(p)) || '' };
  return found.path;
}

// ---- The gate ----
// A proxy on this computer for the browser alone. allowLocal is for the tests, whose pages live on this computer.
export function startGate({ allowLocal = false } = {}) {
  const lookup = allowLocal ? undefined : publicLookup;
  const allowed = (host) => allowLocal || !(net.isIP(host) && isLocalAddress(host));
  const server = http.createServer((req, res) => {
    // A plain http page: the browser sends the whole address.
    let u;
    try {
      u = new URL(req.url);
    } catch {
      res.writeHead(400).end();
      return;
    }
    const host = u.hostname.replace(/^\[|\]$/g, '');
    if (u.protocol !== 'http:' || !allowed(host)) {
      res.writeHead(403).end();
      return;
    }
    const headers = { ...req.headers };
    delete headers['proxy-connection'];
    delete headers['proxy-authorization'];
    const out = http.request({ host, port: u.port || 80, path: `${u.pathname}${u.search}`, method: req.method, headers, lookup, timeout: 30000 }, (r) => {
      res.writeHead(r.statusCode || 502, r.headers);
      r.pipe(res);
    });
    out.on('timeout', () => out.destroy());
    out.on('error', () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    req.pipe(out);
  });
  // An https page: the browser asks for a tunnel to the site and speaks to it through that.
  server.on('connect', (req, client, head) => {
    const m = /^\[?([^\]]+?)\]?:(\d+)$/.exec(req.url || '');
    client.on('error', () => {});
    if (!m || !allowed(m[1])) {
      client.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
    const site = net.connect({ host: m[1], port: Number(m[2]), lookup, timeout: 30000 });
    site.on('connect', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head?.length) site.write(head);
      site.pipe(client);
      client.pipe(site);
    });
    site.on('timeout', () => site.destroy());
    site.on('error', () => client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'));
    client.on('close', () => site.destroy());
  });
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => resolve({ port: server.address().port, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }) }));
  });
}

let line = Promise.resolve(); // one page at a time: a browser is a heavy thing to start
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * url: a public http(s) address. Returns the page as HTML after its scripts have run, or '' when the browser
 * showed nothing. Fails when there is no browser here (code NO_BROWSER). Never takes longer than `timeout`:
 * a browser that hangs is stopped, with everything it started.
 */
export function renderPage(url, opts = {}) {
  const job = line.then(() => render(url, opts));
  line = job.catch(() => {});
  return job;
}

async function render(url, { timeout = 40000, allowLocal = false } = {}) {
  const bin = await findBrowser();
  if (!bin) throw Object.assign(new Error('no browser on this computer'), { code: 'NO_BROWSER' });
  const u = new URL(url);
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('only http and https pages');
  sweepOld();
  const deadline = Date.now() + timeout;
  const gate = await startGate({ allowLocal });
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-browser-'));
  try {
    // Anything the page tries to save lands in the temporary profile and is deleted with it.
    fs.mkdirSync(path.join(profile, 'Default'), { recursive: true });
    fs.writeFileSync(path.join(profile, 'Default', 'Preferences'), JSON.stringify({ download: { default_directory: path.join(profile, 'saved'), prompt_for_download: false }, profile: { default_content_setting_values: { automatic_downloads: 2, notifications: 2, geolocation: 2, media_stream: 2 } } }));
    const base = [
      '--headless',
      `--user-data-dir=${profile}`,
      `--proxy-server=http://127.0.0.1:${gate.port}`,
      '--proxy-bypass-list=<-loopback>', // this computer's own addresses go through the gate too (and are refused there)
      '--disable-quic',
      '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-sync',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-gpu',
      '--mute-audio',
      '--hide-scrollbars',
      '--window-size=1280,1600',
    ];
    // The steady way: start the browser, tell it over its own control line to open the page, wait until the page
    // has stopped growing, and ask for what it shows. This does not depend on the browser printing anything or
    // closing by itself (Edge on Windows did neither).
    const led = await drive(bin, base, profile, u.href, Math.min(deadline, Date.now() + 28000));
    if (led.html || !led.why) return led.html;
    console.error(`A browser could not be led to the page (${led.why}); trying its print-out instead.`);
    // The plain way, for a browser that cannot be led: let it print the page and close.
    const once = [...base, '--virtual-time-budget=12000'];
    let html = (await launch(bin, [...once, '--dump-dom', u.href], Math.max(1000, Math.min(12000, deadline - Date.now())))).out;
    if (!/<\w+[\s>]/.test(html) && deadline - Date.now() > 3000) {
      // Nothing printed: then the page is taken as a PDF instead.
      const pdf = path.join(profile, 'page.pdf');
      await launch(bin, [...once, '--no-pdf-header-footer', `--print-to-pdf=${pdf}`, u.href], Math.min(12000, deadline - Date.now()));
      if (!exists(pdf)) return '';
      const { extractDocument } = await import('../public/js/docs.js');
      const { loadPdfjs } = await import('./web.mjs');
      const doc = await extractDocument('page.pdf', new Uint8Array(fs.readFileSync(pdf)), { pdfjs: await loadPdfjs() });
      const text = doc.pages.join('\n\n').trim();
      html = text ? `<html><body><main>${text.split(/\n{2,}/).map((p) => `<p>${p.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\n/g, '<br>')}</p>`).join('')}</main></body></html>` : '';
    }
    return html;
  } finally {
    await gate.close().catch(() => {});
    await sweep(profile);
    // The browser's helper programs may write a last file after it has closed: look once more a little later.
    setTimeout(() => sweep(profile), 5000).unref();
  }
}

// On a Mac and on Linux the browser gets a process group of its own, so it can be stopped with all its helpers.
const OWN_GROUP = IS_WIN ? {} : { detached: true };

// Stops a browser and every helper program it started. On Windows the helpers outlive their parent otherwise, and
// keep its output open, so a wait for it would never end.
function killTree(p) {
  if (!p?.pid) return;
  try {
    if (IS_WIN) spawn('taskkill', ['/PID', String(p.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => {});
    else {
      // The browser was started as the head of its own group (see OWN_GROUP): the whole group goes at once.
      try {
        process.kill(-p.pid, 'SIGKILL');
      } catch {
        p.kill('SIGKILL');
      }
    }
    p.stdout?.destroy();
  } catch {}
}

// Leads the browser over the DevTools line it opens on this computer. Returns { html }, or { html: '', why } when
// the browser could not be led at all (then the caller tries the plain way).
async function drive(bin, base, profile, url, deadline) {
  const left = () => deadline - Date.now();
  const p = spawn(bin, [...base, '--remote-debugging-port=0', 'about:blank'], { windowsHide: true, stdio: 'ignore', ...OWN_GROUP });
  let gone = false;
  p.on('exit', () => (gone = true));
  p.on('error', () => (gone = true));
  let ws = null;
  try {
    // The browser writes where it listens into its profile folder.
    const portFile = path.join(profile, 'DevToolsActivePort');
    let at = null;
    while (left() > 0 && !gone && !at) {
      try {
        const [port, wsPath] = fs.readFileSync(portFile, 'utf8').trim().split(/\r?\n/);
        if (Number(port) && wsPath) at = `ws://127.0.0.1:${Number(port)}${wsPath}`;
      } catch {}
      if (!at) await sleep(100);
    }
    if (!at) return { html: '', why: gone ? 'it closed at once' : 'it did not start in time' };
    ws = new WebSocket(at);
    const waiting = new Map();
    const events = [];
    let nextId = 1;
    ws.addEventListener('message', (e) => {
      let m;
      try {
        m = JSON.parse(String(e.data));
      } catch {
        return;
      }
      if (m.id && waiting.has(m.id)) {
        const w = waiting.get(m.id);
        waiting.delete(m.id);
        if (m.error) w.reject(new Error(m.error.message || 'the browser refused'));
        else w.resolve(m.result || {});
      } else if (m.method) events.push(m.method);
    });
    const within = (promise, ms, what) => Promise.race([promise, sleep(Math.max(0, ms)).then(() => Promise.reject(new Error(`${what} took too long`)))]);
    await within(new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve);
      ws.addEventListener('error', () => reject(new Error('its control line did not open')));
    }), Math.min(left(), 8000), 'opening its control line');
    const send = (method, params = {}, sessionId) =>
      within(new Promise((resolve, reject) => {
        const id = nextId++;
        waiting.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      }), Math.min(left(), 15000), method);
    await send('Browser.setDownloadBehavior', { behavior: 'deny' }).catch(() => {});
    const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    await send('Page.enable', {}, sessionId);
    await send('Page.navigate', { url }, sessionId);
    // Wait for the page to load, then until what it shows has stopped growing (its scripts have done their work).
    const loadBy = Date.now() + Math.min(left() - 3000, 15000);
    while (Date.now() < loadBy && !events.includes('Page.loadEventFired')) await sleep(100);
    const size = async () => Number((await send('Runtime.evaluate', { expression: 'document.body ? document.body.innerText.length : 0', returnByValue: true }, sessionId).catch(() => ({}))).result?.value) || 0;
    const settleBy = Date.now() + Math.min(left() - 2000, 8000);
    let last = -1;
    let same = 0;
    while (Date.now() < settleBy) {
      const n = await size();
      same = n === last && n > 0 ? same + 1 : 0;
      if (same >= 3) break;
      last = n;
      await sleep(400);
    }
    // No more of the page than Hearth's own reader would take: a page that keeps growing cannot hand over gigabytes.
    const shown = await send('Runtime.evaluate', { expression: 'document.documentElement ? document.documentElement.outerHTML.slice(0, 4194304) : ""', returnByValue: true }, sessionId);
    send('Browser.close').catch(() => {});
    return { html: String(shown.result?.value || '') };
  } catch (err) {
    return { html: '', why: String(err.message || err) };
  } finally {
    try {
      ws?.close();
    } catch {}
    killTree(p);
  }
}

const sweep = (dir) => fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }).catch(() => {});

// Profiles left behind by a Hearth that was stopped in the middle of a page.
function sweepOld() {
  try {
    for (const name of fs.readdirSync(os.tmpdir())) {
      if (!name.startsWith('hearth-browser-')) continue;
      const dir = path.join(os.tmpdir(), name);
      if (Date.now() - fs.statSync(dir).mtimeMs > 3600e3) sweep(dir);
    }
  } catch {}
}

// Runs the browser once and collects what it prints. Ends when the browser does, or after `timeout` at the latest.
function launch(bin, args, timeout) {
  return new Promise((resolve) => {
    let p;
    try {
      p = spawn(bin, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], ...OWN_GROUP });
    } catch {
      return resolve({ out: '' });
    }
    const chunks = [];
    let size = 0;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      killTree(p);
      resolve({ out: Buffer.concat(chunks).toString('utf8') });
    };
    p.stdout.on('data', (d) => {
      size += d.length;
      if (size <= 8 << 20) chunks.push(d);
    });
    const timer = setTimeout(finish, timeout);
    p.on('error', finish);
    p.on('exit', () => setTimeout(finish, 200)); // a moment for the last of its output
    p.stdout.on('close', finish);
  });
}
