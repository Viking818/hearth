// The two small decisions of a voice conversation, kept apart from the page so the tests can run them:
// when has the person started and finished speaking, and which sentences of a growing answer can be read aloud.

// Tells speech from silence by loudness. Feed it the loudness of each short piece of sound (0..1) and how long the
// piece is; it answers 'start' when speech begins, 'end' when the person has stopped, and 'drop' when what it took
// for speech was only a click, a cough, or a steady noise.
// The quiet level of the room is measured in the first half second and followed while nobody speaks. Speech rises
// and falls all the time; a fan or a hum that starts later does not, so sound that stays level for several seconds
// is taken as the room's new quiet.
export function createVad({ startMs = 150, endMs = 1100, minMs = 450, maxMs = 60000, settleMs = 500, steadyMs = 6000 } = {}) {
  let floor = 0.004; // how loud the room is when nobody speaks
  let settled = 0; // time spent measuring the room at the start
  let settleSum = 0;
  let settleN = 0;
  let speaking = false;
  let loudMs = 0; // loud time in a row before speech counts as started
  let quietMs = 0; // quiet time in a row since the last loud piece
  let spokenMs = 0; // loud time inside the current utterance
  let totalMs = 0;
  let low = 1; // the quietest and the average loudness of the current utterance
  let sum = 0;
  let n = 0;
  const start = () => Math.max(0.014, floor * 3.5);
  const stop = () => Math.max(0.009, floor * 2);
  const clear = () => {
    speaking = false;
    loudMs = quietMs = spokenMs = totalMs = sum = n = 0;
    low = 1;
  };
  return {
    speaking: () => speaking,
    floor: () => floor,
    reset: clear,
    push(level, ms) {
      if (settled < settleMs) {
        settled += ms;
        settleSum += level;
        settleN++;
        floor = Math.max(0.002, Math.min(0.02, settleSum / settleN)); // capped: someone may already be speaking
        return null;
      }
      if (!speaking) {
        if (level > start()) {
          loudMs += ms;
          if (loudMs >= startMs) {
            speaking = true;
            spokenMs = totalMs = loudMs;
            quietMs = 0;
            low = level;
            sum = level;
            n = 1;
            return 'start';
          }
        } else {
          loudMs = 0;
          floor = Math.max(0.002, floor * 0.95 + level * 0.05);
        }
        return null;
      }
      totalMs += ms;
      low = Math.min(low, level);
      sum += level;
      n++;
      if (level > stop()) {
        quietMs = 0;
        spokenMs += ms;
      } else quietMs += ms;
      // Level sound for a long while: not a voice. It becomes the room's quiet from now on.
      if (totalMs >= steadyMs && low > (sum / n) * 0.6) {
        floor = Math.min(0.08, sum / n);
        clear();
        return 'drop';
      }
      if (quietMs >= endMs || totalMs >= maxMs) {
        const real = spokenMs >= minMs;
        clear();
        return real ? 'end' : 'drop';
      }
      return null;
    },
  };
}

const plain = (md) =>
  String(md || '')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, '')
    .replace(/^\s*\|.*\|\s*$/gm, ' ')
    .replace(/[*_~>#|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

// The sentences of an answer that are safe to read aloud now. While the answer is still being written (done false)
// its last, unfinished sentence is held back, and so is everything from an unclosed block of code on. The list only
// grows as the text grows, so the reader keeps count of how many it has read.
export function spokenSentences(text, done = false) {
  let s = String(text || '');
  const fences = s.split('```').length - 1;
  if (fences % 2 === 1) s = done ? `${s}\n\`\`\`` : s.slice(0, s.lastIndexOf('```'));
  s = s.replace(/```[\s\S]*?```/g, '\n');
  const out = [];
  let from = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    const after = s[i + 1];
    const stop = c === '\n' || (/[.!?…]/.test(c) && (after === undefined ? done : /\s/.test(after)) && !/[.!?…]/.test(after || ''));
    if (!stop) continue;
    if (c !== '\n' && after === undefined && !done) break;
    out.push(s.slice(from, i + 1));
    from = i + 1;
  }
  if (done && from < s.length) out.push(s.slice(from));
  return out.map(plain).filter((x) => /[\p{L}\p{N}]/u.test(x));
}
