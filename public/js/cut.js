// Answers that stop in the middle of a sentence.
//
// A model learns from the conversation it is shown. When an earlier answer in it breaks off mid-sentence (the user
// pressed Stop, the token limit ran out, or the model simply ended early), the model takes that for how answers end
// here, and ends the next ones early too. One cut answer then breeds more: in a real chat (November 2026) the answers
// shrank to "**What" and "Извини, у" within a few turns. Replayed on a test engine, 6 of 8 new answers broke off with
// the cut answers left as they were, and none of 8 once each was marked for the model as cut.
// So a cut answer is sent back to the model with a note that says so. The user's own copy of the chat is not changed.

export const CUT_NOTE = '…\n\n[This answer was cut off here; it is not how answers should end.]';

// Does the text break off mid-sentence? A guess from how it ends: finished answers end with a full stop, a closing
// bracket, a code block and the like. A wrong "yes" only adds the note to one message; a wrong "no" leaves a cut
// answer as an example to follow, so the test leans towards "yes" for long last lines.
export function looksCut(text) {
  const s = String(text ?? '').trimEnd();
  if (!s) return false;
  if (/```$/.test(s)) return false; // a closed code block
  const last = s.slice(s.lastIndexOf('\n') + 1);
  if (/[,(\[{«“‘]$/.test(s)) return true; // ends with a comma or something just opened
  if (/(^|\s)(\*{1,3}|_{1,2}|~~|`)$/.test(last)) return true; // markup that was only started
  const odd = (re) => (last.match(re) || []).length % 2 === 1;
  if (odd(/\*\*/g) || odd(/`/g)) return true; // bold or code that was never closed on the last line
  const more = (a, b) => last.split(a).length > last.split(b).length;
  if (more('(', ')') || more('[', ']')) return true; // a bracket that was never closed
  if (!/[\p{L}\p{N}]$/u.test(s)) return false; // ends with punctuation, an emoji, a closing bracket…
  if (/\s\p{L}$/u.test(s)) return true; // ends with a one-letter word: "Sorry, I", «Извини, у»
  // Ends with a letter or a digit. Short last lines often end so and are whole ("Done", a name, a list item, a
  // heading, a table row, an address); a long line of running text hardly ever does.
  if (/^\s*([-*+•]|\d+[.)]|#{1,6}\s|\|)/.test(last) || /https?:\/\/\S+$/.test(last)) return false;
  return last.trim().length >= 40;
}

/**
 * An earlier answer as the model should see it: unchanged when it is whole, with the note when it was cut.
 * stopped: the user stopped it. finish: the engine's reason for ending ('length' = the token limit ran out).
 */
export function withCutNote(content, { stopped = false, finish = '' } = {}) {
  const text = String(content ?? '');
  if (!text.trim() || text.endsWith(CUT_NOTE)) return text;
  return stopped || finish === 'length' || looksCut(text) ? text.trimEnd() + CUT_NOTE : text;
}
