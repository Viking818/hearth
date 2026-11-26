// A conversation by voice (0.2.28): when the person has started and finished speaking, which sentences of a growing
// answer may be read aloud, and what the model is told about being read aloud. No microphone or model needed.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.HEARTH_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-test-'));
const { createVad, spokenSentences } = await import('../public/js/vad.js');
const { addChatContext } = await import('../server/api.mjs');

// Feeds pieces of sound of 90 ms each and collects what the detector says.
function hear(vad, script) {
  const events = [];
  for (const [level, pieces] of script) for (let i = 0; i < pieces; i++) {
    const e = vad.push(level, 90);
    if (e) events.push(e);
  }
  return events;
}

test('speech starts after a moment of sound and ends after about a second of quiet', () => {
  const vad = createVad();
  assert.deepEqual(hear(vad, [[0.003, 20]]), [], 'a quiet room is not speech');
  assert.ok(vad.floor() < 0.005, 'the first half second measured the room');
  assert.deepEqual(hear(vad, [[0.2, 1]]), [], 'one short piece of sound is not yet speech');
  assert.deepEqual(hear(vad, [[0.2, 1]]), ['start']);
  assert.equal(vad.speaking(), true);
  assert.deepEqual(hear(vad, [[0.2, 10], [0.003, 5], [0.2, 10]]), [], 'a short pause between words does not end it');
  assert.deepEqual(hear(vad, [[0.003, 12]]), [], 'not yet a second of quiet');
  assert.deepEqual(hear(vad, [[0.003, 1]]), ['end']);
  assert.equal(vad.speaking(), false);
});

test('a click or a cough is dropped, and a steady noise is not taken for a voice', () => {
  const vad = createVad();
  assert.deepEqual(hear(vad, [[0.003, 20], [0.3, 2], [0.003, 14]]), ['start', 'drop'], 'too short to be words');
  // A fan that runs from the start: the first half second measures it, and only something clearly louder counts.
  const fan = createVad();
  assert.deepEqual(hear(fan, [[0.02, 100]]), [], 'steady noise is never taken for speech');
  assert.ok(fan.floor() > 0.015, `the room's level was learnt: ${fan.floor()}`);
  assert.deepEqual(hear(fan, [[0.03, 30]]), [], 'a little louder than the fan is still the fan');
  assert.deepEqual(hear(fan, [[0.3, 12], [0.02, 13]]), ['start', 'end']);
  // A fan that turns on later: taken for speech at first, dropped after a few level seconds, then ignored.
  const later = createVad();
  assert.deepEqual(hear(later, [[0.003, 20], [0.05, 80]]), ['start', 'drop']);
  assert.deepEqual(hear(later, [[0.05, 80]]), []);
  assert.deepEqual(hear(later, [[0.4, 12], [0.05, 13]]), ['start', 'end'], 'a voice over the fan is still heard');
  // Real speech rises and falls, so a long sentence is not mistaken for a fan.
  const talk = createVad();
  const waves = [];
  for (let i = 0; i < 40; i++) waves.push([0.25, 3], [0.03, 1], [0.12, 2]);
  assert.deepEqual(hear(talk, [[0.003, 10], ...waves, [0.003, 13]]), ['start', 'end']);
  // Someone who never stops is cut off after a while.
  const long = createVad({ maxMs: 5000 });
  const on = [];
  for (let i = 0; i < 30; i++) on.push([0.3, 2], [0.05, 1]);
  assert.deepEqual(hear(long, [[0.003, 10], ...on]).slice(0, 2), ['start', 'end']);
});

test('an answer is read sentence by sentence as it is written, never an unfinished one', () => {
  const grow = ['Обычно', 'Обычно рулон стоит 3.5 доллара.', 'Обычно рулон стоит 3.5 доллара. В трёх магазинах', 'Обычно рулон стоит 3.5 доллара. В трёх магазинах цена одна. Хотите ссылки?'];
  assert.deepEqual(spokenSentences(grow[0]), []);
  assert.deepEqual(spokenSentences(grow[1]), [], 'the full stop may still be followed by more of the number or the word');
  assert.deepEqual(spokenSentences(grow[2]), ['Обычно рулон стоит 3.5 доллара.']);
  assert.deepEqual(spokenSentences(grow[3]), ['Обычно рулон стоит 3.5 доллара.', 'В трёх магазинах цена одна.']);
  assert.deepEqual(spokenSentences(grow[3], true), ['Обычно рулон стоит 3.5 доллара.', 'В трёх магазинах цена одна.', 'Хотите ссылки?']);
  // The list only grows: what was read stays read.
  let before = [];
  for (let i = 1; i <= grow[3].length; i++) {
    const now = spokenSentences(grow[3].slice(0, i));
    assert.deepEqual(now.slice(0, before.length), before);
    before = now;
  }
});

test('code, link addresses and Markdown marks are not read aloud', () => {
  assert.deepEqual(spokenSentences('Вот код:\n```js\nlet a = 1.\nlet b = 2.\n', false), ['Вот код:'], 'an open block of code holds everything after it back');
  assert.deepEqual(spokenSentences('Вот код:\n```js\nlet a = 1.\n```\nГотово. **Жирный** [сайт](https://x.io/a.b).', true), ['Вот код:', 'Готово.', 'Жирный сайт.']);
  assert.deepEqual(spokenSentences('# Заголовок\n- первый пункт\n- второй пункт\n\n| a | b |\n|---|---|\nИтог', true), ['Заголовок', 'первый пункт', 'второй пункт', 'Итог']);
  assert.deepEqual(spokenSentences('Really?! Yes... Go to https://example.com/page.html now.', true), ['Really?!', 'Yes...', 'Go to now.']);
  assert.deepEqual(spokenSentences('...', true), []);
  assert.deepEqual(spokenSentences('', true), []);
});

test('in a conversation by voice the model is told that its answer is read aloud', () => {
  const body = { messages: [{ role: 'user', content: 'hi' }] };
  addChatContext(body, { voice: true, memory: false });
  assert.match(body.messages[0].content, /read aloud/);
  assert.match(body.messages[0].content, /short sentences/);
  const plain = { messages: [{ role: 'user', content: 'hi' }] };
  addChatContext(plain, { memory: false });
  assert.doesNotMatch(plain.messages[0].content, /read aloud/);
});
