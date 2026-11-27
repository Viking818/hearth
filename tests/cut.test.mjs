// Answers that stop mid-sentence are marked for the model, so it does not copy the habit (public/js/cut.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { looksCut, withCutNote, CUT_NOTE } from '../public/js/cut.js';
import { apiMessages } from '../public/js/media.js';

test('an answer that breaks off is told from a whole one by how it ends', () => {
  // the ends of the answers in the chat where this was found, and of answers a test engine cut
  for (const cut of [
    '12. **rag-builder**\n13. **token-count',
    '[ Share your @ + join our server: https://discord',
    'Here’s the English version of your application:\n\n***\n\n**What',
    "copy-paste ready:\n\n***\n\n**What's one thing",
    'complete and ready to submit:\n\n***\n\n**',
    'auto-tag or summarize key specs (VRAM',
    'Извини, у',
    'It is a framework for local AI chat with support for Ollama, LM',
    'I manage the community and social channels for "N',
    'First this, then that,',
  ]) assert.equal(looksCut(cut), true, cut);
  for (const whole of [
    'Lisbon, Portugal (two days, on foot)',
    'Хорошо, жду ссылку. Пришли — и я запишу детали для будущего использования.',
    'Да',
    'Done',
    '42',
    'Works on:\n- Mac\n- Windows',
    'See https://example.com/page',
    '```js\nlet a = 1\n```',
    'Чем могу быть полезен? 🤔',
    '| a | b |\n| 1 | 2',
    '# A heading of a section that is fairly long and has no full stop at its end',
    'He said “wait”',
    '',
  ]) assert.equal(looksCut(whole), false, whole);
});

test('a cut answer goes back to the model with a note; a whole one goes back as it is', () => {
  assert.equal(withCutNote('All good.'), 'All good.');
  assert.equal(withCutNote('The answer is (VRAM'), `The answer is (VRAM${CUT_NOTE}`);
  // the user pressed Stop, or the token limit ran out: cut whatever the text looks like
  assert.equal(withCutNote('A whole sentence.', { stopped: true }), `A whole sentence.${CUT_NOTE}`);
  assert.equal(withCutNote('A whole sentence.', { finish: 'length' }), `A whole sentence.${CUT_NOTE}`);
  assert.equal(withCutNote(withCutNote('cut (here')), withCutNote('cut (here'), 'the note is not added twice');
  assert.equal(withCutNote(''), '');

  const sent = apiMessages([
    { role: 'user', content: 'Write the form.' },
    { role: 'assistant', content: 'Here it is:\n\n**What' },
    { role: 'user', content: 'Again.' },
    { role: 'assistant', content: 'Here it is, complete.' },
    { role: 'user', content: 'And once more.' },
    { role: 'assistant', content: 'Stopped by the user.', stopped: true },
    { role: 'user', content: 'Go on.' },
  ]);
  assert.deepEqual(
    sent.map((m) => m.content),
    ['Write the form.', `Here it is:\n\n**What${CUT_NOTE}`, 'Again.', 'Here it is, complete.', 'And once more.', `Stopped by the user.${CUT_NOTE}`, 'Go on.'],
  );
});
