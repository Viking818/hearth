// "Summarize and continue": when a chat has grown close to what the model can keep in mind, its older messages are
// summed up by the model itself. The chat on screen stays whole; the model then reads the summary and the newest
// messages. No page or browser needed here, so the tests can run it.
import { estimateTokens } from './docs.js';

const fileNote = (f) => `[file "${f.name}"${f.text ? `: ${String(f.text).slice(0, 4000)}${f.text.length > 4000 ? ' …' : ''}` : ''}]`;

// One message as plain words, the way the summary request shows it to the model.
export function plainMessage(m) {
  if (m.role === 'assistant') return m.content ? `Assistant: ${m.content}` : '';
  const parts = [m.prompt || m.content || ''];
  for (const q of m.quotes || []) parts.unshift(`(quoting: "${String(q.text).slice(0, 300)}")`);
  for (const f of m.files || []) parts.push(fileNote(f));
  if (m.images?.length) parts.push(`[${m.images.length} picture(s)]`);
  for (const v of m.videos || []) parts.push(`[video "${v.name}"${v.transcript ? `, what is said in it: "${String(v.transcript).slice(0, 1500)}"` : ''}]`);
  return `User: ${parts.filter(Boolean).join('\n')}`;
}

const tokensOf = (list) => list.reduce((n, m) => n + estimateTokens(plainMessage(m)) + (m.images?.length || 0) * 600 + (m.videos || []).reduce((k, v) => k + (v.frames?.length || 0) * 600, 0), 0);

// How full the model's memory is, 0..1, by the numbers the engine gave with the newest answer. 0 when it is not
// known: no answer yet, or the chat was summed up after that answer.
export function contextUse(messages, ctx, summary) {
  if (!ctx) return 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'assistant' || !m.stats?.promptTokens) continue;
    if (summary?.at && summary.at > (m.at || 0)) return 0;
    return Math.min(1, (m.stats.promptTokens + (m.stats.outputTokens || 0)) / ctx);
  }
  return 0;
}

// Which messages to sum up: everything after the last summary except the newest two questions with their answers
// (one, when two are long). null when there is nothing worth summing up.
export function planCompact(messages, summary, ctx) {
  const done = summary?.upto ? messages.findIndex((m) => m.id === summary.upto) : -1;
  const start = done + 1;
  const users = [];
  messages.forEach((m, i) => i >= start && m.role === 'user' && users.push(i));
  if (users.length < 2) return null;
  let keepFrom = users[Math.max(0, users.length - 2)];
  if (users.length < 3 || tokensOf(messages.slice(keepFrom)) > ctx * 0.3) keepFrom = users[users.length - 1];
  if (keepFrom <= start) return null;
  return { older: messages.slice(start, keepFrom), upto: messages[keepFrom - 1].id, keepFrom };
}

// The older messages as pieces of text, each small enough to be read in one request with room to spare.
export function summaryParts(older, ctx) {
  const budget = Math.max(1500, Math.floor(ctx * 0.4));
  const room = budget * 3; // characters: a cautious three per token, also right for Russian
  const parts = [];
  let cur = '';
  const push = () => {
    if (cur) parts.push(cur);
    cur = '';
  };
  for (const m of older) {
    let text = plainMessage(m);
    if (!text) continue;
    while (text.length > room) {
      push();
      parts.push(text.slice(0, room));
      text = `(continued) ${text.slice(room)}`;
    }
    if (cur.length + text.length + 2 > room) push();
    cur += (cur ? '\n\n' : '') + text;
  }
  push();
  return parts;
}

const HOW = [
  'You shorten a long conversation between a user and an AI assistant so that it can go on after the older messages are dropped.',
  'Write a compact summary that keeps: what the user wants and why, decisions made, facts, names, numbers, prices, dates, links and file names, the current state of any work (for code or a page: what it does and what was changed last), and what was agreed to do next.',
  'Leave out greetings and small talk. Do not add anything that was not said.',
  'Write in the language the user writes in. At most about 400 words. Start with the summary itself, no introduction.',
].join(' ');

// ask(messages) → the model's text. Sums the parts up one after another, carrying the summary along.
export async function summarize({ parts, previous = '', ask, onProgress }) {
  let sum = previous;
  for (const [i, part] of parts.entries()) {
    onProgress?.(i + 1, parts.length);
    const text = await ask([
      { role: 'system', content: HOW },
      { role: 'user', content: `${sum ? `Summary of the conversation so far:\n${sum}\n\n` : ''}${sum ? 'The next part of the conversation' : 'The conversation'}:\n\n${part}\n\nWrite the ${sum ? 'updated ' : ''}summary now.` },
    ]);
    const clean = String(text || '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
    if (!clean) throw new Error('empty');
    sum = clean;
  }
  return sum;
}
