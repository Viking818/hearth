// Phones and tablets on the same Wi-Fi can use the whole app once paired: the computer shows a QR code with a
// one-time secret, the phone opens it, and gets its own long-lived cookie. Nothing else on the network gets in.
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { DIRS, getSettings, updateSettings, newPhoneToken } from './settings.mjs';
import { readJson, writeJson, uid, isLoopback } from './util.mjs';

const FILE = path.join(DIRS.data, 'devices.json');
const COOKIE = 'hearth_device';
const MAX_AGE = 180 * 86400;
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

// This computer's addresses on the network, the real Wi-Fi or Ethernet first: VPNs, virtual machines and
// containers add adapters of their own that a phone can't reach.
const VIRTUAL = /^(feth|utun|bridge|vmnet|vboxnet|docker|veth|br-|virbr|tailscale|zt|wg|llw|awdl|anpi|ap\d)|vEthernet|VirtualBox|VMware|Hyper-V|Loopback|Bluetooth/i;
export function lanAddresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) out.push({ name, address: a.address, rank: VIRTUAL.test(name) ? 2 : /^(en|eth|wl|Wi-?Fi|Ethernet|Беспроводная|Подключение)/i.test(name) ? 0 : 1 });
  }
  return out.sort((x, y) => x.rank - y.rank).map((x) => x.address);
}

function devices() {
  return readJson(FILE, { devices: [] }).devices;
}

function cookieOf(req) {
  const m = new RegExp(`(?:^|;\\s*)${COOKIE}=([\\w-]+)`).exec(String(req.headers.cookie || ''));
  return m ? m[1] : '';
}

// Host names a phone may use to reach this computer: its network addresses and its .local name.
export function lanHostOk(host) {
  const h = String(host || '').toLowerCase().replace(/:\d+$/, '');
  if (lanAddresses().includes(h)) return true;
  const local = `${os.hostname().toLowerCase().replace(/\.local$/, '')}.local`;
  return h === local;
}

export function pairedDevice(req) {
  if (!getSettings().phoneAccess || isLoopback(req.socket.remoteAddress)) return null;
  const c = cookieOf(req);
  if (!c) return null;
  const h = sha(c);
  const d = devices().find((x) => x.hash === h);
  if (!d) return null;
  if (Date.now() - (d.lastSeen || 0) > 60e3) {
    const all = devices();
    const me = all.find((x) => x.hash === h);
    if (me) me.lastSeen = Date.now();
    writeJson(FILE, { devices: all }, { secret: true });
  }
  return d;
}

const attempts = new Map(); // ip → [times]
function tooMany(ip) {
  const now = Date.now();
  const list = (attempts.get(ip) || []).filter((x) => now - x < 60e3);
  list.push(now);
  if (attempts.size > 2000) attempts.clear(); // never grows without end
  attempts.set(ip, list);
  return list.length > 10;
}

// The phone sends the secret from the QR code; a right one gets a cookie of its own.
export function pair(req, res, token) {
  const ip = req.socket.remoteAddress || '';
  const s = getSettings();
  if (!s.phoneAccess || !s.phoneToken) return { ok: false, status: 403 };
  if (tooMany(ip)) return { ok: false, status: 429 };
  const a = Buffer.from(sha(token || ''));
  const b = Buffer.from(sha(s.phoneToken));
  if (!crypto.timingSafeEqual(a, b)) return { ok: false, status: 403 };
  const secret = uid(40);
  const ua = String(req.headers['user-agent'] || '');
  const name = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? (/Mobile/.test(ua) ? 'Android phone' : 'Android tablet') : /Macintosh/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows PC' : 'Device';
  const all = devices();
  all.push({ id: uid(8), hash: sha(secret), name, createdAt: Date.now(), lastSeen: Date.now() });
  writeJson(FILE, { devices: all.slice(-20) }, { secret: true });
  // The secret is used up: the next device needs the new code the computer now shows. A link that was copied or a
  // code that was photographed cannot pair a second device.
  newPhoneToken();
  res.setHeader('set-cookie', `${COOKIE}=${secret}; Path=/; Max-Age=${MAX_AGE}; HttpOnly; SameSite=Strict`);
  return { ok: true };
}

export function phoneInfo(port) {
  const s = getSettings();
  const token = s.phoneAccess ? s.phoneToken || newPhoneToken() : '';
  return {
    on: s.phoneAccess,
    urls: s.phoneAccess ? lanAddresses().map((ip) => `http://${ip}:${port}/#pair=${token}`) : [],
    devices: devices().map(({ hash, ...d }) => d),
  };
}

export function setPhoneAccess(on) {
  if (on && !getSettings().phoneToken) newPhoneToken();
  updateSettings({ phoneAccess: Boolean(on) });
}

// A new secret and no paired devices: every phone has to scan the code again.
export function resetDevices() {
  newPhoneToken();
  writeJson(FILE, { devices: [] }, { secret: true });
}

// Disconnects one device. The pairing secret is replaced too, so a link that device kept cannot bring it back.
export function forgetDevice(id) {
  writeJson(FILE, { devices: devices().filter((d) => d.id !== id) }, { secret: true });
  newPhoneToken();
}
