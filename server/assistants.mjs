// Assistants (saved roles with their own instructions) and Memory (facts the chat keeps in mind).
// Built-in assistants are written in English and shown in the page's language; once edited, they keep the user's words.
import path from 'node:path';
import { DIRS, getSettings } from './settings.mjs';
import { readJson, writeJson, uid } from './util.mjs';
import { t } from './i18n.mjs';
import { pluginAgents } from './extensions.mjs';

const A_FILE = path.join(DIRS.data, 'assistants.json');
const M_FILE = path.join(DIRS.data, 'memory.json');

export const BUILTIN = [
  {
    id: 'reply',
    icon: 'mail',
    name: 'Customer replies',
    description: 'Polite, clear answers to customer messages.',
    instructions:
      'You help a small business owner answer customer messages (email, chat, marketplace questions). Write in the language of the customer’s message. Be warm, short and clear: thank them, answer exactly what was asked, and give the next step. Never invent prices, dates or policies; where something is missing, write [fill in: …] instead. If the right tone is unclear, give two versions: a short one and a fuller one.',
    starter: 'Paste a customer’s message and I’ll draft the reply.',
  },
  {
    id: 'product',
    icon: 'tag',
    name: 'Product descriptions',
    description: 'Titles, descriptions and tags for an online shop.',
    instructions:
      'You write product listings for an online shop (for example printed T-shirts, hoodies and merch). For each product give: a title (at most 70 characters), a description of 3–5 short sentences (what it is, the design, material and fit if known, care), and 10–15 search tags separated by commas. Write in the language of the request. Do not invent facts such as material or sizes; leave a [placeholder] or ask. If a photo is attached, describe the design you see.',
    starter: 'Send a photo or a few words about the product.',
  },
  {
    id: 'translate',
    icon: 'languages',
    name: 'Translator',
    description: 'Translates text and keeps its tone and formatting.',
    instructions:
      'You are a translator. Translate the text the user sends. If they name a language, translate into it. If they do not, translate into English, or ask which language they want when the text is already English. Keep the meaning, tone and formatting. Reply with the translation only, without comments.',
    starter: 'Paste the text to translate.',
  },
  {
    id: 'social',
    icon: 'megaphone',
    name: 'Social media posts',
    description: 'Posts and captions for Instagram, Telegram, Pinterest and more.',
    instructions:
      'You write social media posts for a small business. Give 3 options of different lengths. Start each with a hook in the first line, end with a clear call to action, and add 5–10 fitting hashtags. Match the platform the user names (Instagram, Telegram, Pinterest, TikTok…). Use emojis sparingly. Write in the language of the request.',
    starter: 'What is the post about?',
  },
  {
    id: 'explain',
    icon: 'book-open',
    name: 'Explain simply',
    description: 'Explains anything step by step, in plain words.',
    instructions:
      'Explain things simply, as to a smart friend who is not an expert. Start with the short answer in one or two sentences, then explain step by step with an everyday example. Avoid jargon; when a technical word is needed, explain it in brackets. Write in the language of the question.',
    starter: 'What should I explain?',
  },
];

function readA() {
  return readJson(A_FILE, { custom: [], overrides: {}, hidden: [] });
}

const clean = (a) => ({
  name: String(a.name || '').trim().slice(0, 80),
  icon: /^[a-z-]{2,30}$/.test(a.icon || '') ? a.icon : 'bot',
  description: String(a.description || '').trim().slice(0, 200),
  instructions: String(a.instructions || '').slice(0, 20000),
  starter: String(a.starter || '').trim().slice(0, 200),
});

export function listAssistants() {
  const d = readA();
  const builtin = BUILTIN.filter((b) => !d.hidden.includes(b.id)).map((b) => {
    const o = d.overrides[b.id];
    if (o) return { ...clean(o), id: b.id, builtin: true, edited: true };
    return { id: b.id, icon: b.icon, name: t(b.name), description: t(b.description), instructions: t(b.instructions), starter: t(b.starter), builtin: true, edited: false };
  });
  let fromPlugins = [];
  try {
    fromPlugins = pluginAgents();
  } catch {}
  return [...builtin, ...d.custom.map((c) => ({ ...c, builtin: false })), ...fromPlugins];
}

export function getAssistant(id) {
  return listAssistants().find((a) => a.id === id) || null;
}

export function saveAssistant(id, data) {
  if (/^p-[0-9a-f]{12}$/.test(id || '')) throw Object.assign(new Error(t('This assistant comes from a plugin. Turn the plugin off in Extensions to hide it.')), { status: 400 });
  const d = readA();
  const a = clean(data);
  if (!a.name) throw Object.assign(new Error(t('Give the assistant a name.')), { status: 400 });
  if (BUILTIN.some((b) => b.id === id)) {
    d.overrides[id] = a;
    d.hidden = d.hidden.filter((h) => h !== id);
  } else {
    const newId = id && id !== 'new' ? id : `a-${uid(8)}`;
    if (!/^[\w-]{2,40}$/.test(newId)) throw Object.assign(new Error('Bad id'), { status: 400 });
    const i = d.custom.findIndex((c) => c.id === newId);
    const rec = { ...a, id: newId };
    if (i >= 0) d.custom[i] = rec;
    else d.custom.push(rec);
    id = newId;
  }
  writeJson(A_FILE, d);
  return getAssistant(id);
}

export function deleteAssistant(id) {
  if (/^p-[0-9a-f]{12}$/.test(id || '')) throw Object.assign(new Error(t('This assistant comes from a plugin. Turn the plugin off in Extensions to hide it.')), { status: 400 });
  const d = readA();
  if (BUILTIN.some((b) => b.id === id)) {
    delete d.overrides[id];
    if (!d.hidden.includes(id)) d.hidden.push(id);
  } else d.custom = d.custom.filter((c) => c.id !== id);
  writeJson(A_FILE, d);
}

// Brings back the built-in assistants as they came (custom ones stay).
export function resetAssistants() {
  const d = readA();
  writeJson(A_FILE, { ...d, overrides: {}, hidden: [] });
}

// ---- Memory ----

export function listMemory() {
  return readJson(M_FILE, { facts: [] }).facts;
}

export function addMemory(text) {
  const s = String(text || '').trim().slice(0, 1000);
  if (!s) throw Object.assign(new Error(t('Write the fact to remember.')), { status: 400 });
  const facts = listMemory();
  if (facts.some((f) => f.text.toLowerCase() === s.toLowerCase())) return facts.find((f) => f.text.toLowerCase() === s.toLowerCase());
  const f = { id: uid(10), text: s, at: Date.now() };
  facts.push(f);
  writeJson(M_FILE, { facts: facts.slice(-200) });
  return f;
}

export function updateMemory(id, text) {
  const facts = listMemory();
  const f = facts.find((x) => x.id === id);
  if (!f) throw Object.assign(new Error(t('Not found')), { status: 404 });
  f.text = String(text || '').trim().slice(0, 1000) || f.text;
  writeJson(M_FILE, { facts });
  return f;
}

export function deleteMemory(id) {
  writeJson(M_FILE, { facts: listMemory().filter((f) => f.id !== id) });
}

export function clearMemory() {
  writeJson(M_FILE, { facts: [] });
}

// The block added to the chat's instructions: what Hearth remembers about the user.
export function memoryPrompt() {
  if (!getSettings().memoryOn) return '';
  const facts = listMemory();
  if (!facts.length) return '';
  return `${t('What you know about the user (from earlier chats). Use it when it helps; don’t repeat it back unasked:')}\n${facts.map((f) => `- ${f.text}`).join('\n')}`;
}
