// Where Hearth keeps its files, and the user's settings.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJson, writeJson, uid, keepPrivate } from './util.mjs';

export const APP_NAME = 'Hearth';
export const APP_VERSION = '0.2.34';
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Big files (models, engines) must never land in an iCloud/OneDrive-synced folder like the Desktop,
// so data goes to the usual per-user app folder of each system.
function defaultDataDir() {
  if (process.env.HEARTH_DATA_DIR) return path.resolve(process.env.HEARTH_DATA_DIR);
  const home = os.homedir();
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', APP_NAME);
  if (process.platform === 'win32') return path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), APP_NAME);
  return path.join(process.env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'hearth');
}

export const DATA = defaultDataDir();
export const DIRS = {
  data: DATA,
  models: path.join(DATA, 'models'),
  engines: path.join(DATA, 'engines'),
  chats: path.join(DATA, 'chats'),
  uploads: path.join(DATA, 'uploads'),
  cache: path.join(DATA, 'cache'),
  logs: path.join(DATA, 'logs'),
  batches: path.join(DATA, 'batches'),
  images: path.join(DATA, 'images'),
  videos: path.join(DATA, 'videos'),
  voice: path.join(DATA, 'voice'),
  extensions: path.join(DATA, 'extensions'),
  bots: path.join(DATA, 'bots'),
  artifacts: path.join(DATA, 'artifacts'),
};
for (const d of Object.values(DIRS)) fs.mkdirSync(d, { recursive: true });

const FILE = path.join(DATA, 'settings.json');

const DEFAULTS = {
  port: 7420,
  access: 'local', // 'local' = this computer only, 'lan' = other devices on the network (needs the API key)
  apiKey: '',
  contextSize: 32768,
  parallel: 2, // two slots: coding tools run side requests without wiping the main conversation's cache
  vision: true, // load the image helper (mmproj) when a model has one
  chatThinking: false, // the chat's "Think" switch starts in this position
  apiThinking: 'default', // 'default' = the model decides, 'off' = faster answers for coding tools
  systemPrompt: '',
  modelsDir: '', // empty = DIRS.models
  extraModelDirs: [],
  scanLmStudio: true,
  scanOllama: true,
  scanHfCache: true,
  enginePath: '', // empty = pick automatically
  engineBackend: '', // empty = the best build for this computer; or metal | cuda | rocm | vulkan | cpu
  engineArgs: '', // extra llama-server arguments for experts
  autoLoad: true, // load the last model when Hearth starts or when an app calls the API
  lastModel: null, // { id, path, mmproj, name }
  hfToken: '',
  theme: 'system',
  language: 'auto', // 'auto' follows the browser; or 'en' | 'ru'
  memoryOn: true, // the chat remembers the facts on the Memory page
  toolsOn: true, // the chat may search the web, open pages and read allowed folders
  searchProvider: 'free', // free (DuckDuckGo, then Bing; no key) | wikipedia (no key) | brave or tavily (free key) | searxng (your own address)
  freeSearchOffered: true, // set once an older install was moved from Wikipedia-only to the keyless web search
  searchKey: '',
  searchUrl: '',
  renderPages: true, // pages built by scripts are opened with a browser of this computer, without a window (browser-page.mjs)
  toolFolders: [], // folders the model may read (never write)
  mcpConfig: '', // MCP servers, in the same JSON shape as Claude Desktop's mcpServers
  toolApproval: 'ask', // 'ask' before MCP tools run, or 'auto'
  speculative: 'auto', // guess-and-check decoding: 'auto' picks what helps this model, 'off' never
  ttsVoice: '', // the browser voice that reads answers aloud ('' = the system's default for the language)
  naturalVoice: true, // spoken answers use the natural voice once it is downloaded (natural-voice.mjs); off = the system's voice
  naturalVoiceStyle: 4, // which of its ten voices: 1 to 10
  imageModel: '', // the picture model set Hearth installed ('' = none yet)
  checkUpdates: true,
  multiModel: false, // loading another model keeps the ones already loaded
  phoneAccess: false, // the app (not just the API) is reachable from paired phones and tablets on the network
  keepAwake: 'auto', // the computer doesn't sleep: 'auto' while bots or the model work, 'always' while Hearth runs, 'off' (power.mjs)
  phoneToken: '',
};

const saved = readJson(FILE, {});
let current = { ...DEFAULTS, ...saved };
keepPrivate(FILE); // it holds the API key and the keys for other services
// Before 0.2.25 the search without a key was Wikipedia only. An install from then moves to the web search once;
// choosing Wikipedia afterwards stays.
if (saved.searchProvider === 'wikipedia' && !saved.freeSearchOffered) {
  current.searchProvider = 'free';
  save();
}
if (!current.apiKey) {
  current.apiKey = `hearth-${uid(32)}`;
  save();
}

function save() {
  writeJson(FILE, current, { secret: true });
}

export function getSettings() {
  return current;
}

export function modelsDir() {
  return current.modelsDir || DIRS.models;
}

const CHOICES = {
  access: ['local', 'lan'],
  apiThinking: ['default', 'off'],
  theme: ['system', 'light', 'dark'],
  engineBackend: ['', 'metal', 'cuda', 'rocm', 'vulkan', 'cpu'],
  language: ['auto', 'en', 'ru'],
  searchProvider: ['free', 'wikipedia', 'brave', 'tavily', 'searxng'],
  toolApproval: ['ask', 'auto'],
  speculative: ['auto', 'off'],
  keepAwake: ['auto', 'always', 'off'],
};

// Only known keys with the right type are accepted.
export function updateSettings(patch = {}) {
  const next = { ...current };
  for (const [k, v] of Object.entries(patch)) {
    if (!(k in DEFAULTS) || k === 'apiKey' || k === 'phoneToken' || k === 'freeSearchOffered') continue;
    if ((k === 'hfToken' || k === 'searchKey') && v === 'set') continue; // the masked value the page shows
    const def = DEFAULTS[k];
    if (CHOICES[k] && !CHOICES[k].includes(v)) continue;
    if (k === 'lastModel') next[k] = v && typeof v === 'object' ? v : null;
    else if (Array.isArray(def)) next[k] = Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim()) : def;
    else if (typeof def === 'number') {
      const n = Number(v);
      if (Number.isFinite(n) && n > 0) next[k] = Math.round(n);
    } else if (typeof def === 'boolean') next[k] = Boolean(v);
    else if (typeof v === 'string') next[k] = v.trim();
  }
  next.contextSize = Math.min(Math.max(next.contextSize, 2048), 1048576);
  next.parallel = Math.min(Math.max(next.parallel, 1), 8);
  next.port = Math.min(Math.max(next.port, 1024), 65535);
  next.naturalVoiceStyle = Math.min(Math.max(next.naturalVoiceStyle, 1), 10);
  current = next;
  save();
  return current;
}

// The secret in the pairing QR code. A new one forgets every paired phone.
export function newPhoneToken() {
  current.phoneToken = uid(32);
  save();
  return current.phoneToken;
}

export function newApiKey() {
  current.apiKey = `hearth-${uid(32)}`;
  save();
  return current.apiKey;
}

// What the browser may see (tokens and keys for other services stay on the server).
// local: the caller is the computer's own page. A paired phone or tablet (local: false) also gets no API key and
// no connector settings: the key would outlive its pairing, and connector settings hold other services' keys.
export function publicSettings({ local = true } = {}) {
  const { hfToken, searchKey, phoneToken, ...rest } = current;
  const out = { ...rest, hfToken: hfToken ? 'set' : '', searchKey: searchKey ? 'set' : '', defaultModelsDir: DIRS.models, dataDir: DATA };
  if (!local) {
    out.apiKey = '';
    out.mcpConfig = '';
  }
  return out;
}

// The everyday settings a paired phone or tablet may change. Everything else is the computer's own business: who can
// reach it, which folders and programs it uses, and where it sends its own requests (the search address and keys).
// A setting added later is computer-only until it is listed here.
export const PHONE_MAY_SET = new Set(['theme', 'language', 'contextSize', 'parallel', 'vision', 'speculative', 'multiModel', 'autoLoad', 'checkUpdates', 'chatThinking', 'apiThinking', 'memoryOn', 'toolsOn', 'systemPrompt', 'ttsVoice', 'naturalVoice', 'naturalVoiceStyle', 'lastModel']);
