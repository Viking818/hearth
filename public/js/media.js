// Pictures and videos in a chat message: which files count as videos, and what the model is given for them.
// No page or browser needed here, so the tests can run it.
import { t } from './i18n.js';
import { withCutNote } from './cut.js';

const VIDEO_TYPE = { mp4: 'video/mp4', m4v: 'video/x-m4v', mov: 'video/quicktime', webm: 'video/webm' };
export const clock = (s) => `${Math.floor((s || 0) / 60)}:${String(Math.floor((s || 0) % 60)).padStart(2, '0')}`;
// The kind Hearth can keep and play, by the file's ending first (browsers often leave the type empty); '' if none.
export const videoType = (file) => VIDEO_TYPE[(/\.(\w+)$/.exec(file.name || '')?.[1] || '').toLowerCase()] || (Object.values(VIDEO_TYPE).includes(file.type) ? file.type : '');
export const isVideo = (file) => String(file.type || '').startsWith('video/') || /\.(mp4|m4v|mov|webm|mkv|avi|wmv|flv|3gp|mpe?g)$/i.test(file.name || '');

// What the model is told about a video: which of the pictures are its frames, and what is said in it.
export function videoNote(v, first, sees) {
  const n = v.frames?.length || 0;
  let s = `[Video "${v.name}", ${clock(v.duration)} long.`;
  if (n && sees) s += n === 1 ? ` Picture ${first} below is a frame from it.` : ` Pictures ${first} to ${first + n - 1} below are ${n} frames from it, in order, taken at ${v.frames.map((f) => clock(f.at)).join(', ')}.`;
  else s += ' Its frames are not included: the loaded model can’t see pictures.';
  s += v.transcript ? ` What is said in it${v.speechCut ? ' (the first 10 minutes)' : ''}: "${v.transcript}"` : ' Its sound is not included.';
  return `${s}]`;
}

// What the model reads before the user's words when they quoted a piece of the chat.
export function quoteText(quotes = []) {
  return quotes
    .filter((q) => q?.text)
    .map((q) => `${q.from === 'user' ? 'The user quotes their own earlier message' : 'The user quotes this part of your earlier answer'}:\n${String(q.text).split('\n').map((l) => `> ${l}`).join('\n')}`)
    .join('\n\n');
}

// summary: { upto, text } — the messages up to and including the one with the id `upto` were summed up ("Summarize
// and continue"); the model gets the summary instead of them. upto '' means the summary of an earlier chat.
// A summary whose message is no longer in the list (the user edited an earlier question) is ignored.
export function apiMessages(messages, { sees = true, summary = null } = {}) {
  const out = [];
  let note = '';
  if (summary?.text) {
    const i = summary.upto ? messages.findIndex((m) => m.id === summary.upto) : -1;
    if (!summary.upto || i >= 0) {
      messages = messages.slice(i + 1);
      note = `[Summary of the earlier part of this conversation. Those messages are no longer included word for word:\n${summary.text}]`;
    }
  }
  for (const m of messages) {
    if (m.role === 'assistant') {
      // An answer that broke off is marked as such, or the model copies the habit (see cut.js).
      if (m.content) out.push({ role: 'assistant', content: withCutNote(m.content, { stopped: m.stopped, finish: m.finish }) });
      continue;
    }
    let text = m.prompt || m.content || '';
    if (!text && m.videos?.length) text = t('Watch this video and tell me what happens in it.');
    if (m.quotes?.length) text = `${quoteText(m.quotes)}\n\n${text}`;
    // The summary rides in front of the first message that is still sent: models that insist on turns taking
    // turns refuse two user messages in a row.
    if (note) {
      text = `${note}\n\n${text}`;
      note = '';
    }
    for (const f of m.files || []) text += `\n\n<file name="${f.name}">\n${f.text}\n</file>`;
    // Pictures first, then each video's frames; the note says which pictures belong to which video.
    // A model that can't see gets words only (the engine refuses pictures it has no eyes for).
    const pictures = sees ? (m.images || []).map((im) => im.url) : [];
    if (!sees && m.images?.length) text += `\n\n[${m.images.length} picture(s) came with this message, but the loaded model can’t see pictures.]`;
    for (const v of m.videos || []) {
      text += `\n\n${videoNote(v, pictures.length + 1, sees)}`;
      if (sees) pictures.push(...(v.frames || []).map((f) => f.url));
    }
    if (pictures.length) {
      out.push({ role: 'user', content: [{ type: 'text', text: text || t('Look at this image.') }, ...pictures.map((url) => ({ type: 'image_url', image_url: { url } }))] });
    } else out.push({ role: 'user', content: text });
  }
  if (note) out.unshift({ role: 'user', content: note });
  return out;
}
