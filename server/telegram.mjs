// Telegram for bots. The owner makes a bot in Telegram's @BotFather, pastes its key (token) into Hearth, and can then
// write to it from anywhere; Hearth answers through it. Hearth asks Telegram for new messages itself (long polling),
// so nothing on this computer is opened to the internet: no port forwarding and no public address.
// Who may write: the owner, who proves it once by opening a link with a secret code (the code changes after each
// use), or, for a bot that answers customers, anyone. Strangers never get the owner's files, folders, connectors or
// memory (agent.mjs gives them the web at most) and can send a limited number of messages.
import fs from 'node:fs';
import path from 'node:path';
import { DIRS } from './settings.mjs';
import { getBot, updateBot, listBots, getTask, workFolder } from './bots.mjs';
import { startTask, stopTask, taskState, onTaskFinished, onTaskProgress } from './agent.mjs';
import { forWrite } from './workfiles.mjs';
import { readResolved } from './tools.mjs';
import { uid, sleep } from './util.mjs';
import { speechOf } from './voice.mjs';
import { voiceAnswer } from './speak.mjs';
import { t } from './i18n.mjs';

const API = () => process.env.HEARTH_TELEGRAM_API || 'https://api.telegram.org';
const TOKEN_RE = /^\d{5,15}:[\w-]{30,80}$/;
const pollers = new Map(); // botId → { token, controller }

// The token is part of every Telegram address; it never goes into a message or the log.
const hide = (s, token) => (token ? String(s || '').split(token).join('***') : String(s || ''));

export async function tg(token, method, params = {}, { signal, timeout = 30000 } = {}) {
  const sig = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout);
  let res;
  try {
    res = await fetch(`${API()}/bot${token}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(params), signal: sig });
  } catch (err) {
    throw Object.assign(new Error(hide(err.cause?.message || err.message, token)), { code: 'NET' });
  }
  const j = await res.json().catch(() => ({}));
  if (!j.ok) throw Object.assign(new Error(hide(j.description || `HTTP ${res.status}`, token)), { code: j.error_code || res.status, retryAfter: j.parameters?.retry_after || 0 });
  return j.result;
}

const bad = (msg) => Object.assign(new Error(msg), { status: 400 });

export async function connectTelegram(botId, token) {
  token = String(token || '').trim();
  if (!TOKEN_RE.test(token)) throw bad(t('That does not look like a bot token. @BotFather gives it as numbers, a colon and letters, like 123456789:AAH…'));
  const other = listBots().find((b) => b.id !== botId && b.telegram?.token === token);
  if (other) throw bad(t('This Telegram bot is already connected to “{name}”.', { name: other.name }));
  let me;
  try {
    me = await tg(token, 'getMe', {}, { timeout: 20000 });
  } catch (err) {
    throw bad(err.code === 401 || err.code === 404 ? t('Telegram did not accept this token. Copy it again from @BotFather.') : t('Can’t reach Telegram: {error}', { error: err.message }));
  }
  stopPoller(botId);
  const b = updateBot(botId, (b) => {
    const same = b.telegram.token === token;
    b.telegram = { ...b.telegram, token, username: me.username || '', title: me.first_name || '', code: same && b.telegram.code ? b.telegram.code : uid(12), error: '', offset: same ? b.telegram.offset : 0, owners: same ? b.telegram.owners : [], threads: same ? b.telegram.threads : {} };
  });
  if (!b) throw Object.assign(new Error(t('Not found')), { status: 404 });
  await tg(token, 'setMyCommands', { commands: [{ command: 'new', description: t('Start a new conversation') }, { command: 'stop', description: t('Stop the current task') }] }).catch(() => {});
  startPoller(botId);
  return b;
}

export function disconnectTelegram(botId) {
  stopPoller(botId);
  return updateBot(botId, (b) => {
    b.telegram = { ...b.telegram, token: '', username: '', title: '', code: '', owners: [], threads: {}, offset: 0, error: '' };
  });
}

// The owner forgets one Telegram account; the link gets a new code, so an old copy of it no longer works.
export function forgetOwner(botId, chatId) {
  return updateBot(botId, (b) => {
    b.telegram.owners = b.telegram.owners.filter((o) => String(o.id) !== String(chatId));
    b.telegram.code = uid(12);
    for (const [chat] of Object.entries(b.telegram.threads || {})) if (String(chat) === String(chatId)) delete b.telegram.threads[chat];
  });
}

// ---- Getting messages ----

export function syncTelegram() {
  const bots = listBots();
  for (const b of bots) if (b.telegram?.token && !pollers.has(b.id)) startPoller(b.id);
  for (const [id, p] of pollers) {
    const b = bots.find((x) => x.id === id);
    if (!b || b.telegram?.token !== p.token) stopPoller(id);
  }
}

function startPoller(botId) {
  const b = getBot(botId);
  if (!b?.telegram?.token || pollers.has(botId)) return;
  const p = { token: b.telegram.token, controller: new AbortController() };
  pollers.set(botId, p);
  poll(botId, p)
    .catch((err) => console.error('Telegram:', hide(err.message, p.token)))
    .finally(() => {
      if (pollers.get(botId) === p) pollers.delete(botId);
    });
}

function stopPoller(botId) {
  const p = pollers.get(botId);
  if (!p) return;
  p.controller.abort();
  pollers.delete(botId);
}

export function stopTelegram() {
  for (const id of [...pollers.keys()]) stopPoller(id);
}

const setError = (botId, error) =>
  updateBot(botId, (b) => {
    b.telegram.error = error;
  });

async function poll(botId, p) {
  const { signal } = p.controller;
  let fails = 0;
  while (!signal.aborted) {
    const b = getBot(botId);
    if (!b || b.telegram?.token !== p.token) return;
    let updates;
    try {
      updates = await tg(p.token, 'getUpdates', { offset: b.telegram.offset || 0, timeout: 50, allowed_updates: ['message'] }, { signal, timeout: 70000 });
    } catch (err) {
      if (signal.aborted) return;
      fails++;
      if (err.code === 401 || err.code === 404) {
        setError(botId, t('Telegram no longer accepts this bot’s token. Connect it again with a new token from @BotFather.'));
        return;
      }
      if (err.code === 409) setError(botId, t('Another program is already getting this bot’s messages (Hermes, for example). Turn it off there, or make a new bot in @BotFather.'));
      else if (fails >= 3) setError(botId, t('Can’t reach Telegram: {error}', { error: err.message }));
      await sleep(err.retryAfter ? err.retryAfter * 1000 : Math.min(60000, 1000 * 2 ** Math.min(fails, 6)));
      continue;
    }
    fails = 0;
    if (b.telegram.error) setError(botId, '');
    for (const u of updates || []) {
      updateBot(botId, (x) => {
        x.telegram.offset = Math.max(x.telegram.offset || 0, u.update_id + 1);
      });
      if (u.message) await onMessage(botId, p.token, u.message).catch((err) => console.error('Telegram message:', hide(err.message, p.token)));
    }
  }
}

// ---- One message ----

const guestHits = new Map(); // chat → times of a stranger's recent messages
// Voice messages: how the bot turns a recording into text, and an answer into a voice message (the tests put
// stand-ins here).
export const listen = { speech: speechOf, say: voiceAnswer };
const VOICE_SECONDS = { owner: 600, guest: 120 };

const warned = new Map(); // chat → when it was last told "this is a private bot"
const safeName = (s) => String(s || 'file').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '-').replace(/^[\s.]+/, '').slice(0, 120) || 'file';
const stamp = () => new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');

// A free name in the work folder: "file.pdf", then "file (2).pdf", and so on.
function freeFile(bot, rel) {
  const ext = path.extname(rel);
  const base = rel.slice(0, rel.length - ext.length);
  for (let n = 1; ; n++) {
    const file = forWrite(bot, n === 1 ? rel : `${base} (${n})${ext}`);
    if (!fs.existsSync(file)) return file;
  }
}

async function download(token, fileId) {
  const f = await tg(token, 'getFile', { file_id: fileId });
  let res;
  try {
    res = await fetch(`${API()}/file/bot${token}/${f.file_path}`, { signal: AbortSignal.timeout(120000) });
  } catch (err) {
    throw new Error(hide(err.cause?.message || err.message, token));
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

export async function onMessage(botId, token, msg) {
  if (msg.chat?.type !== 'private') return; // groups and channels are left alone
  const bot = getBot(botId);
  if (!bot) return;
  const tgc = bot.telegram;
  const chatId = msg.chat.id;
  const from = msg.from || {};
  const name = [from.first_name, from.last_name].filter(Boolean).join(' ') || from.username || 'User';
  const owner = (tgc.owners || []).some((o) => String(o.id) === String(chatId));
  let text = String(msg.text ?? msg.caption ?? '').trim();
  const send = (s) => sendText(token, chatId, s);

  const start = /^\/start(?:@\w+)?(?:\s+(\S+))?$/.exec(text);
  if (start) {
    if (start[1] && tgc.code && start[1] === tgc.code) {
      updateBot(botId, (b) => {
        if (!b.telegram.owners.some((o) => String(o.id) === String(chatId))) b.telegram.owners.push({ id: chatId, name, username: from.username || '' });
        b.telegram.code = uid(12);
      });
      return send(t('Hello, {name}! Now I know you: I’m your bot “{bot}”. Write me a task.', { name: from.first_name || name, bot: bot.name }));
    }
    if (owner) return send(t('Hello again! Write me a task.'));
    if (tgc.mode === 'everyone') return send(t('Hello! How can I help you?'));
    return send(t('This is a private bot.'));
  }
  if (!owner && tgc.mode !== 'everyone') {
    if (Date.now() - (warned.get(chatId) || 0) > 3600e3) {
      warned.set(chatId, Date.now());
      await send(t('This is a private bot.'));
    }
    return;
  }
  if (/^\/new(@\w+)?$/.test(text)) {
    updateBot(botId, (b) => {
      delete b.telegram.threads[chatId];
    });
    return send(t('Starting over. What should I do?'));
  }
  if (/^\/stop(@\w+)?$/.test(text)) {
    const id = tgc.threads?.[chatId];
    if (id && taskState(botId, id)) {
      stopTask(botId, id);
      return send(t('Stopped.'));
    }
    return send(t('Nothing is running right now.'));
  }
  if (!owner) {
    const now = Date.now();
    const hits = (guestHits.get(chatId) || []).filter((x) => now - x < 3600e3);
    if (hits.length >= 30) return send(t('Too many messages. Please write again later.'));
    hits.push(now);
    guestHits.set(chatId, hits);
  }
  if (msg.video_note || msg.video) return send(t('I can’t watch videos yet. Please write in text or send a voice message.'));

  const images = [];
  const notes = [];
  // A voice message (or a sound file): listened to on this computer, then handled like a written message.
  const sound = msg.voice || msg.audio;
  if (sound) {
    const limit = owner ? VOICE_SECONDS.owner : VOICE_SECONDS.guest;
    if ((sound.file_size || 0) > 20 << 20) return send(t('The file is too big: Telegram lets bots take files of up to 20 MB.'));
    if ((sound.duration || 0) > limit) return send(t('That recording is too long for me: {n} minutes at most. Please send a shorter one.', { n: limit / 60 }));
    tg(token, 'sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});
    let heard;
    try {
      heard = await listen.speech(await download(token, sound.file_id), { name: sound.file_name || 'voice.ogg', seconds: limit });
    } catch (err) {
      if (err.code === 'NO_VOICE') return send(owner ? t('To listen to voice messages I need voice input. On the computer open Hearth → Settings → Voice and download it. Until then, please write in text.') : t('I can’t listen to voice messages here. Please write in text.'));
      if (err.code === 'NO_DECODER') return send(owner ? t('I can’t open voice recordings on this computer yet: it has no program that reads them. Please write in text.') : t('I can’t listen to voice messages here. Please write in text.'));
      return send(owner ? t('I could not listen to the recording: {error}', { error: hide(err.message, token) }) : t('I could not listen to the recording. Please write in text.'));
    }
    if (!heard?.text) return send(t('I could not make out any words in the recording. Please try again or write in text.'));
    // The owner sees what was understood, so a misheard word is caught before the answer.
    await send(t('I heard: “{text}”', { text: heard.text.length > 700 ? `${heard.text.slice(0, 700)}…` : heard.text }));
    text = text ? `${text}\n\n${heard.text}` : heard.text;
    notes.push(`[This message was spoken${heard.cut ? ' (only its first part was listened to)' : ''}. Hearth turned the speech into text, so a word or a name may be wrong: if something makes no sense, ask.]`);
  }
  const files = owner && bot.tools?.files;
  if (msg.photo?.length) {
    try {
      const buf = await download(token, msg.photo[msg.photo.length - 1].file_id);
      const up = `tg-${uid(10)}.jpg`;
      fs.writeFileSync(path.join(DIRS.uploads, up), buf);
      images.push(`/uploads/${up}`);
      if (files) {
        const file = freeFile(bot, `Telegram/photo-${stamp()}.jpg`);
        fs.writeFileSync(file, buf);
        notes.push(`[The photo is also saved in your work folder as ${path.relative(workFolder(bot), file).split(path.sep).join('/')}.]`);
      }
    } catch (err) {
      return send(t('I could not get the picture: {error}', { error: err.message }));
    }
  }
  if (msg.document) {
    if (!owner) return send(t('I can only read text messages.'));
    if (!files) return send(t('I have no work folder for files. Turn on “Work folder” for me in Hearth.'));
    if ((msg.document.file_size || 0) > 20 << 20) return send(t('The file is too big: Telegram lets bots take files of up to 20 MB.'));
    try {
      const buf = await download(token, msg.document.file_id);
      const file = freeFile(bot, `Telegram/${safeName(msg.document.file_name)}`);
      fs.writeFileSync(file, buf);
      const rel = path.relative(workFolder(bot), file).split(path.sep).join('/');
      // A document or a text file is read at once and handed over with the message, so the bot has its words in
      // front of it and need not find the right tool first (a long file: its beginning, the rest through read_file).
      let words = '';
      try {
        if (buf.length <= 30 << 20) words = (await readResolved(file)).trim();
      } catch {}
      notes.push(words ? `[A file came with this message. It is saved in your work folder as ${rel}. You have already read it; this is its text:]\n${words}\n[End of the file ${rel}.]` : `[A file came with this message. It is saved in your work folder as ${rel}; read it with read_file if the task needs it.]`);
    } catch (err) {
      return send(t('I could not get the file: {error}', { error: err.message }));
    }
  }
  if (!text && !images.length && !notes.length) return;

  // One Telegram chat is one long task, until /new (or until the owner status of the chat changes).
  let taskId = tgc.threads?.[chatId] || '';
  const old = taskId ? getTask(botId, taskId) : null;
  if (!old || Boolean(old.chat?.owner) !== owner) taskId = '';
  const task = startTask(botId, { text, taskId, images, note: notes.join('\n'), spoken: Boolean(sound), source: 'telegram', chat: { id: chatId, name, username: from.username || '', owner }, title: `${name}: ${text || t('picture')}` });
  if (!taskId)
    updateBot(botId, (b) => {
      b.telegram.threads[chatId] = task.id;
    });
  typing(token, botId, chatId, task.id);
}

// "typing…" in Telegram while the bot works (Telegram shows it for five seconds at a time).
const typingNow = new Map();
function typing(token, botId, chatId, taskId) {
  const key = `${botId}/${chatId}`;
  if (typingNow.has(key)) return;
  const beat = () => tg(token, 'sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});
  beat();
  const timer = setInterval(() => {
    if (!taskState(botId, taskId)) return stopTyping(botId, chatId);
    beat();
  }, 4500);
  timer.unref?.();
  typingNow.set(key, timer);
}

function stopTyping(botId, chatId) {
  const key = `${botId}/${chatId}`;
  clearInterval(typingNow.get(key));
  typingNow.delete(key);
}

// ---- Sending ----

// Telegram takes at most 4,096 characters a message: split at line ends, keeping code blocks closed in each part.
export function chunks(text, max = 3800) {
  const out = [];
  let cur = '';
  let inCode = false;
  const flush = () => {
    if (!cur.trim()) return;
    out.push(inCode ? `${cur}\n\`\`\`` : cur);
    cur = inCode ? '```\n' : '';
  };
  for (let line of String(text || '').split('\n')) {
    while (line.length > max) {
      if (cur) flush();
      cur += line.slice(0, max);
      line = line.slice(max);
      flush();
    }
    if (cur.length + line.length + 1 > max) flush();
    cur += (cur && !cur.endsWith('\n') ? '\n' : '') + line;
    if (/^\s*```/.test(line)) inCode = !inCode;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

// The model writes Markdown; Telegram understands a few HTML tags. Tables become monospaced text.
export function toTelegramHtml(md) {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const keep = [];
  const hold = (html) => `\u0000${keep.push(html) - 1}\u0000`;
  let s = String(md || '');
  s = s.replace(/```[^\n]*\n([\s\S]*?)(?:```|$)/g, (m, code) => hold(`<pre>${esc(code.replace(/\n$/, ''))}</pre>`));
  s = s.replace(/(?:^|\n)((?:\s*\|.*\|\s*(?:\n|$)){2,})/g, (m, table) => `\n${hold(`<pre>${esc(table.replace(/^\s*\|?[-:\s|]+\|?\s*$/gm, '').replace(/\n+/g, '\n').trim())}</pre>`)}\n`);
  s = s.replace(/`([^`\n]+)`/g, (m, c) => hold(`<code>${esc(c)}</code>`));
  s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, (m, txt, url) => hold(`<a href="${esc(url).replace(/"/g, '&quot;')}">${esc(txt)}</a>`));
  s = esc(s);
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>').replace(/__([^_\n]+)__/g, '<b>$1</b>');
  s = s.replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,!?:;]|$)/gm, '$1<i>$2</i>');
  s = s.replace(/^#{1,6}\s+(.+)$/gm, '<b>$1</b>');
  s = s.replace(/^(\s*)[-*]\s+/gm, '$1• ');
  s = s.replace(/^\s*(?:-{3,}|\*{3,})\s*$/gm, '');
  return s.replace(/\u0000(\d+)\u0000/g, (m, i) => keep[Number(i)]).replace(/\n{3,}/g, '\n\n').trim();
}

async function sendPart(token, chatId, part) {
  try {
    await tg(token, 'sendMessage', { chat_id: chatId, text: toTelegramHtml(part), parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
  } catch (err) {
    if (err.code !== 400) throw err;
    await tg(token, 'sendMessage', { chat_id: chatId, text: part, link_preview_options: { is_disabled: true } }); // markup Telegram didn't take
  }
}

export async function sendText(token, chatId, text) {
  for (const part of chunks(text)) await sendPart(token, chatId, part);
}

async function sendFile(token, chatId, file) {
  const form = new FormData();
  form.append('chat_id', String(chatId));
  form.append('document', new Blob([fs.readFileSync(file)]), path.basename(file));
  let res;
  try {
    res = await fetch(`${API()}/bot${token}/sendDocument`, { method: 'POST', body: form, signal: AbortSignal.timeout(180000) });
  } catch (err) {
    throw new Error(hide(err.cause?.message || err.message, token));
  }
  const j = await res.json().catch(() => ({}));
  if (!j.ok) throw new Error(hide(j.description || `HTTP ${res.status}`, token));
}

// The files a turn made go along with the answer (to the owner only): five at most, each under 45 MB.
async function sendFiles(bot, token, chatId, files) {
  let root;
  try {
    root = workFolder(bot);
  } catch {
    return;
  }
  const left = [];
  let sent = 0;
  for (const rel of files) {
    const file = path.join(root, rel);
    let size = 0;
    try {
      size = fs.statSync(file).size;
    } catch {
      continue;
    }
    if (sent >= 5 || size > 45 << 20) {
      left.push(rel);
      continue;
    }
    try {
      await sendFile(token, chatId, file);
      sent++;
    } catch (err) {
      left.push(`${rel} (${err.message})`);
    }
  }
  if (left.length) await sendText(token, chatId, `${t('These files are in the bot’s work folder on the computer:')}\n${left.map((x) => `• ${x}`).join('\n')}`);
}

// ---- The answer as it is written ----
// A chat feels alive when something shows up at once. So a turn that came from Telegram keeps one message up to date
// while it runs: the step it is on ("searching the web: …"), then the answer as the model writes it. When the turn
// ends, that same message becomes the finished answer. Telegram allows about one change a second per chat; Hearth
// makes one every two seconds at most.
export const live = { gap: 2000, minText: 30 };
const liveMsgs = new Map(); // "botId/chatId" → { id, shown, at, want, timer, busy, done }
const STEP_SIGN = { web_search: '🔎', open_page: '🌐', read_file: '📄', list_files: '📂', find_files: '📂', write_file: '📝', write_table: '📝', write_document: '📝', edit_file: '📝', remember: '🧠', use_skill: '✨', find_tool: '🧩', use_tool: '🧩' };

async function pushLive(token, chatId, st) {
  if (st.busy || st.done) return;
  clearTimeout(st.timer);
  st.timer = null;
  const want = st.want;
  if (!want || want === st.shown) return;
  const wait = st.at + live.gap - Date.now();
  if (st.id && wait > 0) {
    st.timer = setTimeout(() => pushLive(token, chatId, st), wait);
    st.timer.unref?.();
    return;
  }
  st.busy = true;
  try {
    if (!st.id) {
      st.id = (await tg(token, 'sendMessage', { chat_id: chatId, text: want, link_preview_options: { is_disabled: true } }))?.message_id || 0;
      if (!st.id) st.done = true; // no message to keep up to date: the finished answer will come as usual
    } else await tg(token, 'editMessageText', { chat_id: chatId, message_id: st.id, text: want, link_preview_options: { is_disabled: true } });
    st.shown = want;
    st.at = Date.now();
  } catch (err) {
    st.at = Date.now() + (err.retryAfter || 0) * 1000; // Telegram asked to slow down, or the text was the same
  } finally {
    st.busy = false;
  }
  if (st.want !== st.shown && !st.done) pushLive(token, chatId, st);
}

onTaskProgress((bot, task, ev) => {
  const token = bot?.telegram?.token;
  if (!token || task.source !== 'telegram' || !task.chat) return;
  const key = `${bot.id}/${task.chat.id}`;
  let st = liveMsgs.get(key);
  if (!st) liveMsgs.set(key, (st = { id: 0, shown: '', at: 0, want: '', timer: null, busy: false, done: false }));
  if (ev.type === 'step') {
    if (!task.chat.owner) return; // a customer sees the answer being written, not what the bot does inside
    st.want = `${STEP_SIGN[ev.name] || '🔧'} ${ev.title}${ev.arg ? `: ${ev.arg}` : ''}…`;
  } else if (ev.type === 'text') {
    const text = String(ev.text || '').trim();
    if (text.length < live.minText && !st.id) return; // too little to show yet
    st.want = `${text.length > 3800 ? `${text.slice(0, 3800)}` : text} …`;
  }
  pushLive(token, task.chat.id, st);
});

// Ends the live message of a chat and says which message it was (0: none), once its last change has gone through.
async function endLive(botId, chatId) {
  const key = `${botId}/${chatId}`;
  const st = liveMsgs.get(key);
  if (!st) return 0;
  liveMsgs.delete(key);
  st.done = true;
  clearTimeout(st.timer);
  for (let i = 0; st.busy && i < 100; i++) await sleep(50);
  return st.id || 0;
}

// The finished answer: it takes the place of the live message when there is one (a long answer goes on in new
// messages), otherwise it is sent as usual.
async function sendAnswer(token, chatId, text, liveId) {
  if (!liveId) return sendText(token, chatId, text);
  const [first, ...rest] = chunks(text);
  const put = (body) => tg(token, 'editMessageText', { chat_id: chatId, message_id: liveId, link_preview_options: { is_disabled: true }, ...body });
  try {
    await put({ text: toTelegramHtml(first), parse_mode: 'HTML' });
  } catch (err) {
    if (!/not modified/i.test(err.message)) {
      try {
        await put({ text: first }); // markup Telegram didn't take
      } catch (err2) {
        if (!/not modified/i.test(err2.message)) return sendText(token, chatId, text); // the message is gone: send anew
      }
    }
  }
  for (const part of rest) await sendPart(token, chatId, part);
}

// ---- A spoken answer ----
// Someone who spoke to the bot gets the answer as a voice message too, after the written one: read by a voice of
// this computer. Long answers, and answers that are mostly code or tables, stay written only.
const toldAt = new Map(); // "botId/reason" → when the owner was last told why there is no voice

async function sendVoice(token, chatId, file) {
  const form = new FormData();
  form.append('chat_id', String(chatId));
  form.append('duration', String(file.seconds || 0));
  form.append('voice', new Blob([file.data], { type: file.mime }), file.name);
  let res;
  try {
    res = await fetch(`${API()}/bot${token}/sendVoice`, { method: 'POST', body: form, signal: AbortSignal.timeout(120000) });
  } catch (err) {
    throw new Error(hide(err.cause?.message || err.message, token));
  }
  const j = await res.json().catch(() => ({}));
  if (!j.ok) throw new Error(hide(j.description || `HTTP ${res.status}`, token));
}

// Was the question this reply answers spoken? (The user's messages since the answer before it.)
function askedByVoice(task, reply) {
  const i = task.messages.indexOf(reply);
  for (let k = (i < 0 ? task.messages.length : i) - 1; k >= 0 && task.messages[k].role === 'user'; k--) if (task.messages[k].spoken) return true;
  return false;
}

async function answerByVoice(bot, token, to, text) {
  tg(token, 'sendChatAction', { chat_id: to.id, action: 'record_voice' }).catch(() => {});
  try {
    const file = await listen.say(text);
    if (file) await sendVoice(token, to.id, file);
  } catch (err) {
    console.error('Telegram: no spoken answer:', hide(err.message, token));
    if (!to.owner) return;
    // The owner hears why, once a day at most for each reason.
    const key = `${bot.id}/${err.code || 'other'}`;
    if (Date.now() - (toldAt.get(key) || 0) < 24 * 3600e3) return;
    toldAt.set(key, Date.now());
    const why = err.code === 'NO_VOICE'
      ? t('I can’t answer by voice: this computer has no voice for this language. Add one in the system’s speech settings (Windows: Settings → Time & language → Speech → Add voices).')
      : t('I can’t answer by voice on this computer yet ({error}). The written answer is above.', { error: hide(err.message, token).slice(0, 200) });
    await sendText(token, to.id, why).catch(() => {});
  }
}

// After each turn: answer the chat it came from, and send a scheduled result to the owner.
onTaskFinished(async (bot, task, reply) => {
  const tgc = bot?.telegram;
  if (!tgc?.token || !reply) return;
  let targets = [];
  if (task.source === 'telegram' && task.chat) targets = [{ id: task.chat.id, owner: Boolean(task.chat.owner) }];
  else if (task.source === 'schedule') {
    const s = (bot.schedules || []).find((x) => x.id === task.scheduleId);
    if (s?.telegram !== false) targets = (tgc.owners || []).map((o) => ({ id: o.id, owner: true }));
  }
  for (const to of targets) {
    stopTyping(bot.id, to.id);
    let text = reply.content || '';
    if (!text && task.status === 'stopped') text = t('Stopped.');
    // What went wrong is for the owner (and is in Hearth's page): a customer only hears that there is no answer now.
    if (reply.error) text = to.owner ? `${text ? `${text}\n\n` : ''}⚠️ ${reply.error}` : text || t('Sorry, I can’t answer right now. Please write again a little later.');
    try {
      const liveId = task.source === 'telegram' ? await endLive(bot.id, to.id) : 0;
      if (text) await sendAnswer(tgc.token, to.id, text, liveId);
      else if (liveId) await tg(tgc.token, 'deleteMessage', { chat_id: to.id, message_id: liveId }).catch(() => {});
      if (to.owner && reply.files?.length) await sendFiles(bot, tgc.token, to.id, reply.files);
      if (reply.content && !reply.error && task.source === 'telegram' && tgc.voiceReplies !== false && askedByVoice(task, reply)) await answerByVoice(bot, tgc.token, to, reply.content);
    } catch (err) {
      console.error('Telegram: could not send the answer:', hide(err.message, tgc.token));
    }
  }
});
