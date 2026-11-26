// Chat history: one JSON file per chat in the data folder.
import fs from 'node:fs';
import path from 'node:path';
import { DIRS } from './settings.mjs';
import { readJson, writeJson } from './util.mjs';
import { t } from './i18n.mjs';

const safeId = (id) => /^[\w-]{4,40}$/.test(String(id || ''));
const fileOf = (id) => path.join(DIRS.chats, `${id}.json`);

function allChats() {
  const out = [];
  for (const f of fs.readdirSync(DIRS.chats)) {
    if (!f.endsWith('.json')) continue;
    const c = readJson(path.join(DIRS.chats, f), null);
    if (c?.id) out.push(c);
  }
  return out;
}

const summary = (c) => ({
  id: c.id,
  title: c.title || t('New chat'),
  updatedAt: c.updatedAt || 0,
  createdAt: c.createdAt || 0,
  model: c.model || '',
  assistantId: c.assistantId || '',
  count: c.messages?.length || 0,
  pinned: Boolean(c.pinned),
  archived: Boolean(c.archived),
});

export function listChats() {
  return allChats().map(summary).sort((a, b) => b.updatedAt - a.updatedAt);
}

// Finds chats whose title or messages contain every word of the query, with a short piece of text around the match.
export function searchChats(query) {
  const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8);
  if (!words.length) return [];
  const out = [];
  for (const c of allChats()) {
    const texts = [c.title || '', ...(c.messages || []).map((m) => m.content || '')];
    const all = texts.join('\n').toLowerCase();
    if (!words.every((w) => all.includes(w))) continue;
    let snippet = '';
    for (const text of texts.slice(1)) {
      const i = text.toLowerCase().indexOf(words[0]);
      if (i < 0) continue;
      const start = Math.max(0, i - 40);
      snippet = `${start > 0 ? '…' : ''}${text.slice(start, i + 80).replace(/\s+/g, ' ').trim()}${i + 80 < text.length ? '…' : ''}`;
      break;
    }
    out.push({ ...summary(c), snippet });
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 50);
}

export function getChat(id) {
  if (!safeId(id)) return null;
  return readJson(fileOf(id), null);
}

export function saveChat(id, data) {
  if (!safeId(id)) throw Object.assign(new Error(t('Bad chat id')), { status: 400 });
  const old = getChat(id);
  const chat = {
    id,
    title: String(data.title || old?.title || t('New chat')).slice(0, 200),
    model: String(data.model || old?.model || ''),
    assistantId: String(data.assistantId ?? old?.assistantId ?? '').slice(0, 40),
    branchOf: data.branchOf && typeof data.branchOf === 'object' ? { id: String(data.branchOf.id || ''), title: String(data.branchOf.title || '').slice(0, 200) } : old?.branchOf || null,
    skills: Array.isArray(data.skills) ? [...new Set(data.skills.map((x) => String(x).slice(0, 120)))].slice(0, 20) : old?.skills || [],
    createdAt: old?.createdAt || Date.now(),
    updatedAt: Date.now(),
    messages: Array.isArray(data.messages) ? data.messages : old?.messages || [],
    // Pinned and archived are changed from the sidebar (flagChat); saving the chat's text keeps them.
    pinned: Boolean(old?.pinned),
    archived: Boolean(old?.archived),
  };
  // "Summarize and continue": the model reads this instead of the messages up to `upto`. null takes it away.
  const sum = data.summary === undefined ? old?.summary : data.summary;
  if (sum && typeof sum === 'object' && typeof sum.text === 'string' && sum.text.trim()) chat.summary = { upto: String(sum.upto || '').slice(0, 40), text: sum.text.slice(0, 20000), at: Number(sum.at) || Date.now() };
  writeJson(fileOf(id), chat);
  return chat;
}

// A chat's videos can be gigabytes, so they go with the chat: each video file and the frames made from it, unless
// another chat (a branch) still shows them. Pictures stay: other pages may be using them.
function videoFiles(chat) {
  const names = new Set();
  for (const m of chat?.messages || []) {
    for (const v of Array.isArray(m.videos) ? m.videos : []) {
      for (const u of [v?.url, v?.poster, ...(Array.isArray(v?.frames) ? v.frames.map((f) => f?.url) : [])]) {
        const n = /^\/uploads\/([\w-]+\.(?:mp4|m4v|mov|webm|jpg))$/.exec(String(u || ''))?.[1];
        if (n) names.add(n);
      }
    }
  }
  return names;
}

export function deleteChat(id) {
  if (!safeId(id)) return false;
  const mine = videoFiles(getChat(id));
  fs.rmSync(fileOf(id), { force: true });
  if (mine.size) {
    const others = fs.readdirSync(DIRS.chats).filter((f) => f.endsWith('.json')).map((f) => {
      try {
        return fs.readFileSync(path.join(DIRS.chats, f), 'utf8');
      } catch {
        return '';
      }
    });
    for (const n of mine) if (!others.some((text) => text.includes(n))) fs.rmSync(path.join(DIRS.uploads, n), { force: true });
  }
  return true;
}

// Pin a chat to the top of the list or move it to the archive. The chat's date stays, so it keeps its place.
export function flagChat(id, { pinned, archived } = {}) {
  const chat = getChat(id);
  if (!chat) return null;
  if (typeof pinned === 'boolean') chat.pinned = pinned;
  if (typeof archived === 'boolean') chat.archived = archived;
  if (chat.archived) chat.pinned = false; // an archived chat is out of sight
  writeJson(fileOf(id), chat);
  return summary(chat);
}
