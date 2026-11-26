// Small helpers shared by the server modules. No dependencies.
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// n random letters and digits (about 6 bits each). Enough bytes are drawn for any n: before 0.2.33 the result was
// never longer than 22 characters, whatever was asked for.
export function uid(n = 12) {
  let s = '';
  while (s.length < n) s += crypto.randomBytes(Math.max(16, n)).toString('base64url').replace(/[-_]/g, '');
  return s.slice(0, n);
}

export const hash = (s) => crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 12);

export const IS_WIN = process.platform === 'win32';
export const IS_MAC = process.platform === 'darwin';

// Runs a program and resolves with its stdout ('' on any failure). Never throws.
// withStderr: some programs (llama-server --version) print to stderr.
export function run(cmd, args = [], { timeout = 8000, maxBuffer = 16 << 20, withStderr = false } = {}) {
  return new Promise((resolve) => {
    try {
      execFile(cmd, args, { timeout, maxBuffer, windowsHide: true }, (err, stdout, stderr) => {
        const out = String(stdout || '') + (withStderr ? String(stderr || '') : '');
        resolve(err && !out ? '' : out);
      });
    } catch {
      resolve('');
    }
  });
}

export function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

// Write to a temp file first so a crash never leaves half a JSON file behind.
// secret: the file holds keys or tokens, so only this user may read it (other accounts on the computer may not).
export function writeJson(file, data, { secret = false } = {}) {
  const tmp = `${file}.${process.pid}.${uid(6)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), secret ? { mode: 0o600 } : undefined);
  fs.renameSync(tmp, file);
}

// A file written before Hearth kept such files to this user: close it now (Windows keeps its own per-user rules).
export function keepPrivate(file) {
  try {
    if (process.platform !== 'win32' && fs.statSync(file).mode & 0o077) fs.chmodSync(file, 0o600);
  } catch {}
}

export function fileSize(p) {
  try {
    return fs.statSync(p).size;
  } catch {
    return 0;
  }
}

export function exists(p) {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

export const GB = 1024 ** 3;

export function fmtBytes(n) {
  if (!n && n !== 0) return '';
  if (n >= 1e9) return `${(n / 1e9).toFixed(n >= 1e11 ? 0 : 1)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(0)} MB`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)} KB`;
  return `${n} B`;
}

// ---- HTTP helpers ----

export function sendJson(res, status, data, headers = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(body);
}

export function sendError(res, status, message, extra = {}) {
  sendJson(res, status, { error: { message, ...extra } });
}

export function readBody(req, limit = 64 << 20) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let over = false;
    req.on('data', (c) => {
      if (over) return; // nothing more is kept
      size += c.length;
      if (size > limit) {
        // Let the handler answer 413 first and close the connection a moment later: closing it at once would cut
        // the answer off, and the page would show a network error instead of the reason.
        over = true;
        chunks.length = 0;
        reject(Object.assign(new Error('Request is too large'), { status: 413 }));
        setTimeout(() => req.destroy(), 1500).unref();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!over) resolve(Buffer.concat(chunks));
    });
    req.on('error', reject);
  });
}

// Writes a big request body straight to a file: a video is too big to hold in memory. Resolves with its size.
// The file appears under its name only when all of it has arrived.
export function saveBody(req, file, limit) {
  return new Promise((resolve, reject) => {
    const tooBig = () => Object.assign(new Error('Request is too large'), { status: 413 });
    if (Number(req.headers['content-length']) > limit) return reject(tooBig());
    const part = `${file}.part`;
    const out = fs.createWriteStream(part);
    let size = 0;
    let done = false;
    const fail = (err) => {
      if (done) return;
      done = true;
      out.destroy();
      fs.rm(part, { force: true }, () => {});
      reject(err);
    };
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        fail(tooBig());
        req.destroy();
      }
    });
    const cut = () => fail(Object.assign(new Error('The upload was interrupted'), { status: 400 }));
    req.on('error', cut);
    req.on('close', () => !req.complete && cut());
    out.on('error', fail);
    out.on('finish', () => {
      if (done) return;
      done = true;
      try {
        fs.renameSync(part, file);
        resolve(size);
      } catch (err) {
        reject(err);
      }
    });
    req.pipe(out);
  });
}

export async function readJsonBody(req, limit) {
  const buf = await readBody(req, limit);
  if (!buf.length) return {};
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    throw Object.assign(new Error('Body is not valid JSON'), { status: 400 });
  }
}

// Like fetch(), for the engine on this computer, but with no time limit. A request that waits its turn behind a long
// one (a big document, or many tools) may get its first byte only after many minutes, and fetch() gives up after five
// ("fetch failed"). Stopping still works through `signal`. The answer has status, ok, headers.get, text() and body.
// Each request gets its own connection: the engine closes a connection after a streamed answer, and a request sent
// right after one (a bot's or an agent's next step) could otherwise go out on that closed connection and fail with
// "socket hang up". If that still happens before anything came back, the request is sent once more.
const longAgent = new http.Agent({ keepAlive: false });
export async function fetchLong(url, opts = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fetchLongOnce(url, opts);
    } catch (err) {
      if (attempt === 0 && !opts.signal?.aborted && (err.code === 'ECONNRESET' || /socket hang up/i.test(err.message))) continue;
      throw err;
    }
  }
}

function fetchLongOnce(url, { method = 'GET', headers = {}, body, signal } = {}) {
  return new Promise((resolve, reject) => {
    const data = body == null ? null : Buffer.from(body);
    const req = http.request(url, { method, headers: { ...headers, ...(data ? { 'content-length': data.length } : {}) }, agent: longAgent, signal }, (res) => {
      resolve({
        status: res.statusCode,
        ok: res.statusCode >= 200 && res.statusCode < 300,
        headers: {
          get: (k) => {
            const v = res.headers[String(k).toLowerCase()];
            return v == null ? null : Array.isArray(v) ? v.join(', ') : String(v);
          },
        },
        body: res, // chunks as they come
        text: async () => {
          const parts = [];
          for await (const c of res) parts.push(c);
          return Buffer.concat(parts).toString('utf8');
        },
      });
    });
    req.on('error', reject);
    req.end(data || undefined);
  });
}

export function isLoopback(addr = '') {
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1' || addr.startsWith('127.');
}

export function portFree(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.listen(port, host, () => srv.close(() => resolve(true)));
  });
}

export async function findFreePort(start, host) {
  for (let p = start; p < start + 50; p++) if (await portFree(p, host)) return p;
  throw new Error(`No free port near ${start}`);
}

// The command that opens an address with the system's default program (the browser), as [program, arguments].
// Never through a command line that a shell reads: on Windows `cmd /c start "<address>"` fills in %NAME% from the
// environment even inside quotes, and the address of a sign-in page comes from the service being signed in to.
export function openCommand(url, platform = process.platform) {
  if (platform === 'darwin') return ['open', [url]];
  if (platform === 'win32') return ['rundll32.exe', ['url.dll,FileProtocolHandler', url]];
  return ['xdg-open', [url]];
}

// \\host\share\… (also written //host/share/…): a path on another computer. Windows contacts that computer, and
// offers it the account's sign-in, as soon as a program asks anything about such a path, so file tools refuse it
// before they touch it.
export const isNetworkPath = (p) => /^[\\/]{2}/.test(String(p ?? '').trim());

