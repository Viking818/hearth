// Bots: helpers that work on their own on this computer, like the Hermes agent or Grok Bot. Each bot has a job
// (its instructions), a work folder where it may create and change files, a schedule, and can have its own Telegram
// bot, so the owner (or, if allowed, anyone) can write to it from a phone. This file keeps the bots and their tasks;
// agent.mjs does the work and telegram.mjs carries the messages.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DIRS } from './settings.mjs';
import { readJson, writeJson, uid, IS_WIN, run, keepPrivate } from './util.mjs';
import { t } from './i18n.mjs';

const FILE = path.join(DIRS.bots, 'bots.json');
const MAX_TASKS = 200; // per bot: past this the oldest finished tasks go
export const TOOL_KEYS = ['web', 'files', 'folders', 'connectors', 'skills', 'memory'];
const ALL_DAYS = [1, 2, 3, 4, 5, 6, 7]; // Monday … Sunday
export const EVERY_HOURS = [1, 2, 3, 4, 6, 8, 12];

// Ready-made bots. Written in English and turned into the page's language when a bot is made from one.
export const TEMPLATES = [
  {
    id: 'helper',
    emoji: '🤖',
    name: 'Helper',
    description: 'Does tasks from start to finish: searches the web, reads and writes files.',
    instructions:
      'You help the owner of a small business with any task: research, writing, planning, tables and files. Work on your own until the task is done. Save longer results (reports, tables, web pages) as files in your work folder and say their names. Keep the final answer short.',
    tools: { web: true, files: true, skills: true, memory: true },
  },
  {
    id: 'support',
    emoji: '💬',
    name: 'Customer replies',
    description: 'Answers your customers in Telegram, politely and only with the facts you give it.',
    instructions:
      'You answer the customers of our print shop in Telegram: questions about products, prices, orders and delivery. Be warm, short and clear. Use only the facts below. If something is not there, say that a manager will answer soon. Never invent prices, dates or promises.\n\nAbout the shop (fill this in):\n- What we make: [fill in]\n- Prices: [fill in]\n- How to order and pay: [fill in]\n- Delivery and pickup: [fill in]\n- Hours and contacts: [fill in]',
    tools: {},
    telegramMode: 'everyone',
  },
  {
    id: 'digest',
    emoji: '☀️',
    name: 'Morning digest',
    description: 'Every morning looks through the news and sends you a short summary.',
    instructions:
      'Every morning you make a short digest for the owner of a print shop (T-shirts, hoodies, merch): news about printing and merch, trends and ideas for new designs, and anything useful for sales. Give 5–8 points, each in one or two sentences with a link. Write in the owner’s language.',
    tools: { web: true, memory: true },
    schedules: [{ time: '09:00', task: 'Make today’s digest.' }],
  },
  {
    id: 'research',
    emoji: '🔎',
    name: 'Researcher',
    description: 'Studies a question on the web and writes a report with sources.',
    instructions:
      'You research questions on the web: look at several sources, compare them and write a clear report with the main findings, numbers and links. Save the report as a Markdown file in your work folder, and give a short summary in your answer.',
    tools: { web: true, files: true, skills: true },
  },
  {
    id: 'listings',
    emoji: '🏷️',
    name: 'Product listings',
    description: 'Writes titles, descriptions and tags for your products and saves them as an Excel table.',
    instructions:
      'You write product listings for an online shop (printed T-shirts, hoodies, merch). For each product: a title of at most 70 characters, a description of 3–5 sentences and 10–15 tags. Never invent the material or the sizes. Save the listings as an Excel table (columns: Product, Title, Description, Tags) in your work folder.',
    tools: { files: true, memory: true },
  },
  {
    id: 'blank',
    emoji: '✨',
    name: 'New bot',
    description: 'Your own bot: write what it should do.',
    tools: { web: true, files: true },
  },
];

export function templates() {
  return TEMPLATES.map((x) => ({ id: x.id, emoji: x.emoji, name: t(x.name), description: t(x.description), schedules: (x.schedules || []).length, telegram: x.telegramMode === 'everyone' }));
}

// ---- Bots ----

keepPrivate(FILE); // it holds the bots' Telegram tokens
const readAll = () => readJson(FILE, []);
const writeAll = (list) => writeJson(FILE, list, { secret: true });
const safeId = (id) => /^[\w-]{4,40}$/.test(String(id || ''));
const emptyTelegram = () => ({ token: '', username: '', title: '', mode: 'owner', owners: [], code: '', error: '', offset: 0, threads: {} });

export const cleanTools = (x = {}) => Object.fromEntries(TOOL_KEYS.map((k) => [k, Boolean(x?.[k])]));

// What the page may see: everything but the Telegram key.
export function publicBot(b) {
  if (!b) return null;
  const { telegram: tg = emptyTelegram(), ...rest } = b;
  return {
    ...rest,
    telegram: {
      connected: Boolean(tg.token),
      username: tg.username,
      title: tg.title,
      mode: tg.mode,
      voiceReplies: tg.voiceReplies !== false,
      owners: tg.owners.map(({ id, name, username }) => ({ id, name, username })),
      link: tg.username && tg.code ? `https://t.me/${tg.username}?start=${tg.code}` : '',
      error: tg.error,
    },
  };
}

export function listBots() {
  return readAll();
}

export function getBot(id) {
  return safeId(id) ? readAll().find((b) => b.id === id) || null : null;
}

// Changes one bot in place and saves it, with nothing else running in between (no awaits inside).
export function updateBot(id, fn) {
  const list = readAll();
  const b = list.find((x) => x.id === id);
  if (!b) return null;
  b.telegram = { ...emptyTelegram(), ...(b.telegram || {}) };
  fn(b);
  b.updatedAt = Date.now();
  writeAll(list);
  return b;
}

let documents = '';
// The user's own Documents folder (on Windows it may have been moved, for example into OneDrive).
export async function documentsDir() {
  if (documents) return documents;
  let d = '';
  // UTF-8 out, so a Cyrillic user name in the path survives.
  if (IS_WIN) d = (await run('powershell', ['-NoProfile', '-Command', '[Console]::OutputEncoding = [Text.Encoding]::UTF8; [Environment]::GetFolderPath("MyDocuments")'], { timeout: 15000 })).trim();
  if (!d || !fs.existsSync(d)) d = path.join(os.homedir(), 'Documents');
  documents = d;
  return d;
}

const folderName = (name) =>
  String(name || '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '-')
    .replace(/^[\s.]+|[\s.]+$/g, '')
    .slice(0, 60) || 'Bot';

async function newFolder(name, others) {
  const base = process.env.HEARTH_BOTS_DIR || path.join(await documentsDir(), 'Hearth Bots');
  const used = new Set(others.map((b) => path.resolve(b.folder || '').toLowerCase()));
  let dir = path.join(base, folderName(name));
  for (let n = 2; used.has(path.resolve(dir).toLowerCase()); n++) dir = path.join(base, `${folderName(name)} ${n}`);
  return dir;
}

// A new bot from a template. A name given here also names its work folder (renaming a bot later keeps the folder).
export async function createBot({ template = 'blank', name: wanted = '' } = {}) {
  const tpl = TEMPLATES.find((x) => x.id === template) || TEMPLATES.find((x) => x.id === 'blank');
  const list = readAll();
  const name = String(wanted || '').trim().slice(0, 60) || t(tpl.name);
  const bot = {
    id: uid(10),
    template: tpl.id,
    emoji: tpl.emoji,
    name,
    description: t(tpl.description),
    instructions: tpl.instructions ? t(tpl.instructions) : '',
    tools: cleanTools(tpl.tools),
    thinking: false,
    folder: await newFolder(name, list),
    schedules: (tpl.schedules || []).map((s) => cleanSchedule({ ...s, task: t(s.task) })),
    telegram: { ...emptyTelegram(), mode: tpl.telegramMode === 'everyone' ? 'everyone' : 'owner' },
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  writeAll([...readAll(), bot]);
  return bot;
}

const bad = (msg) => Object.assign(new Error(msg), { status: 400 });

// The page saves a bot: its words, tools, schedule and who may write to it in Telegram.
export function saveBot(id, body = {}) {
  const b = updateBot(id, (b) => {
    if ('name' in body) b.name = String(body.name || '').trim().slice(0, 60) || b.name;
    if ('emoji' in body) b.emoji = String(body.emoji || '').trim().slice(0, 8) || '🤖';
    if ('description' in body) b.description = String(body.description || '').trim().slice(0, 300);
    if ('instructions' in body) b.instructions = String(body.instructions || '').slice(0, 20000);
    if ('tools' in body) b.tools = cleanTools(body.tools);
    if ('thinking' in body) b.thinking = Boolean(body.thinking);
    if ('schedules' in body) {
      if (!Array.isArray(body.schedules) || body.schedules.length > 20) throw bad(t('A bot can have at most 20 schedule entries.'));
      b.schedules = body.schedules.map((s) => cleanSchedule(s, (b.schedules || []).find((o) => o.id === s.id)));
      if (b.schedules.some((s) => !s.task)) throw bad(t('Write what the bot should do at that time.'));
    }
    if ('telegramMode' in body) b.telegram.mode = body.telegramMode === 'everyone' ? 'everyone' : 'owner';
    if ('voiceReplies' in body) b.telegram.voiceReplies = Boolean(body.voiceReplies);
    if ('folder' in body) {
      const f = String(body.folder || '').trim();
      if (!f || !path.isAbsolute(f)) throw bad(t('Choose a folder for the bot’s files.'));
      b.folder = path.resolve(f);
    }
  });
  if (!b) throw Object.assign(new Error(t('Not found')), { status: 404 });
  return b;
}

export function deleteBot(id) {
  if (!safeId(id)) return;
  writeAll(readAll().filter((b) => b.id !== id));
  fs.rmSync(path.join(DIRS.bots, id), { recursive: true, force: true });
  index.delete(id);
}

// ---- Work folder ----

// The bot's folder, made if needed. Returned with links resolved, so checks compare real paths.
export function workFolder(bot) {
  if (!bot?.folder) throw new Error(t('This bot has no work folder.'));
  fs.mkdirSync(bot.folder, { recursive: true });
  return fs.realpathSync(bot.folder);
}

// The newest files in the work folder (for the page), at most three folders deep.
export function workFiles(bot, max = 200) {
  let root;
  try {
    root = fs.realpathSync(bot.folder);
  } catch {
    return [];
  }
  const out = [];
  const walk = (dir, depth) => {
    let names = [];
    try {
      names = fs.readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (name.startsWith('.') || out.length > 2000) continue;
      const full = path.join(dir, name);
      let st;
      try {
        st = fs.lstatSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (depth < 3) walk(full, depth + 1);
      } else if (st.isFile()) out.push({ path: path.relative(root, full).split(path.sep).join('/'), size: st.size, modified: st.mtimeMs });
    }
  };
  walk(root, 0);
  return out.sort((a, b) => b.modified - a.modified).slice(0, max);
}

// ---- Schedule ----

// An entry runs on some days at a time ("every day at 09:00", "Mondays at 10:30"), or every few hours on the hour.
export function cleanSchedule(s = {}, old = {}) {
  const every = EVERY_HOURS.includes(Number(s.every)) ? Number(s.every) : 0;
  const days = [...new Set((Array.isArray(s.days) ? s.days : ALL_DAYS).map(Number).filter((d) => d >= 1 && d <= 7))].sort((a, b) => a - b);
  const out = {
    id: safeId(s.id) ? s.id : uid(8),
    on: s.on !== false,
    task: String(s.task || '').trim().slice(0, 4000),
    every,
    time: /^([01]\d|2[0-3]):[0-5]\d$/.test(String(s.time || '')) ? s.time : '09:00',
    days: days.length ? days : ALL_DAYS,
    telegram: s.telegram !== false,
    lastRun: Number(old?.lastRun || s.lastRun) || 0,
  };
  out.nextRun = nextRunOf(out, Date.now());
  return out;
}

// The first time after `from` that the entry is due, in this computer's local time.
export function nextRunOf(s, from = Date.now()) {
  const day0 = new Date(from);
  day0.setHours(0, 0, 0, 0);
  if (s.every) {
    for (let h = 0; h <= 48; h += s.every) {
      const x = new Date(day0);
      x.setHours(h);
      if (x.getTime() > from) return x.getTime();
    }
    return 0;
  }
  const [hh, mm] = String(s.time || '09:00').split(':').map(Number);
  for (let i = 0; i < 8; i++) {
    const x = new Date(day0);
    x.setDate(x.getDate() + i);
    x.setHours(hh, mm, 0, 0);
    if ((s.days || ALL_DAYS).includes(x.getDay() || 7) && x.getTime() > from) return x.getTime();
  }
  return 0;
}

// Entries that are due now. Each is moved on to its next time at once, so it never runs twice. One missed while
// the computer was off runs late if it is less than six hours late; older ones wait for their next time.
export function takeDueSchedules(now = Date.now()) {
  const due = [];
  const list = readAll();
  let changed = false;
  for (const b of list) {
    for (const s of b.schedules || []) {
      if (!s.on || !s.task) continue;
      if (!s.nextRun) {
        s.nextRun = nextRunOf(s, now);
        changed = true;
        continue;
      }
      if (now < s.nextRun) continue;
      if (now - s.nextRun < 6 * 3600e3) {
        due.push({ botId: b.id, schedule: { ...s } });
        s.lastRun = now;
      }
      s.nextRun = nextRunOf(s, now);
      changed = true;
    }
  }
  if (changed) writeAll(list);
  return due;
}

// ---- Tasks ----
// A task is one job for a bot: what was asked, the bot's steps and answers, and the conversation the model sees
// (kept short, see agent.mjs). A Telegram chat is one long task; asking again in the page continues a task too.

const tasksDir = (botId) => path.join(DIRS.bots, botId, 'tasks');
const taskFile = (botId, id) => path.join(tasksDir(botId), `${id}.json`);
const index = new Map(); // botId → Map(taskId → summary), read from disk once

const summary = (k) => ({
  id: k.id,
  title: k.title,
  status: k.status,
  source: k.source,
  chat: k.chat ? { name: k.chat.name, owner: k.chat.owner } : null,
  createdAt: k.createdAt,
  updatedAt: k.updatedAt,
  files: (k.files || []).length,
  unread: Boolean(k.unread),
});

function indexOf(botId) {
  if (!index.has(botId)) {
    const m = new Map();
    let names = [];
    try {
      names = fs.readdirSync(tasksDir(botId));
    } catch {}
    for (const f of names) {
      if (!f.endsWith('.json')) continue;
      const k = readJson(path.join(tasksDir(botId), f), null);
      if (k?.id) m.set(k.id, summary(k));
    }
    index.set(botId, m);
  }
  return index.get(botId);
}

export function listTasks(botId) {
  if (!safeId(botId)) return [];
  return [...indexOf(botId).values()].sort((a, b) => b.updatedAt - a.updatedAt);
}

export function getTask(botId, id) {
  return safeId(botId) && safeId(id) ? readJson(taskFile(botId, id), null) : null;
}

export function saveTask(k) {
  k.updatedAt = Date.now();
  fs.mkdirSync(tasksDir(k.botId), { recursive: true });
  writeJson(taskFile(k.botId, k.id), k);
  indexOf(k.botId).set(k.id, summary(k));
  return k;
}

export function deleteTask(botId, id) {
  if (!safeId(botId) || !safeId(id)) return;
  fs.rmSync(taskFile(botId, id), { force: true });
  indexOf(botId).delete(id);
  updateBot(botId, (b) => {
    for (const [chat, tid] of Object.entries(b.telegram.threads || {})) if (tid === id) delete b.telegram.threads[chat];
  });
}

export function newTask(bot, { title = '', source = 'app', chat = null, scheduleId = '' } = {}) {
  const k = { id: uid(10), botId: bot.id, title: String(title).replace(/\s+/g, ' ').trim().slice(0, 120) || t('Task'), source, status: 'new', chat, scheduleId, messages: [], convo: [], files: [], error: '', createdAt: Date.now(), updatedAt: Date.now() };
  saveTask(k);
  trim(bot.id);
  return k;
}

// The user's words wait in the task (`sent: false`) until the bot's next turn picks them up.
export function addUserMessage(k, text, { images = [], note = '', spoken = false } = {}) {
  const content = String(text || '').slice(0, 100000);
  k.messages.push({ id: uid(8), role: 'user', content, images: images.slice(0, 4), note, ...(spoken ? { spoken: true } : {}), at: Date.now(), sent: false });
  k.unread = false;
  return saveTask(k);
}

function trim(botId) {
  const list = listTasks(botId);
  if (list.length <= MAX_TASKS) return;
  const keep = new Set(Object.values(getBot(botId)?.telegram?.threads || {}));
  for (const k of list.slice(MAX_TASKS).reverse()) {
    if (keep.has(k.id) || k.status === 'running' || k.status === 'queued') continue;
    deleteTask(botId, k.id);
  }
}
