// Reading an answer aloud (0.2.29): which words of a written answer are read, in which language, and when an answer
// is left unread. The voices themselves belong to the system and are not tested here.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.HEARTH_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-test-'));
const { speakable, langOf } = await import('../server/speak.mjs');
const { wavSamples, resample16, oggPage, oggPackets, wav16 } = await import('../server/opus.mjs');

test('a written answer becomes plain words: no marks, code, link addresses or emoji', () => {
  assert.equal(speakable('Привет! 😊 Рулон **шириной 60 см** стоит около 90 долларов. Подробнее: [сайт](https://x.io/a).'), 'Привет! Рулон шириной 60 см стоит около 90 долларов. Подробнее: сайт.');
  assert.equal(speakable('Here you go:\n```js\nlet a = 1;\n```\nDone.'), 'Here you go: Done.');
  assert.equal(speakable('```\nonly code\n```'), '', 'nothing to read');
  assert.equal(speakable('👍'), '');
  assert.equal(speakable('word '.repeat(400)), '', 'too long to listen to: stays written');
  assert.notEqual(speakable('word '.repeat(100)), '');
  assert.equal(langOf('Привет, how are you'), 'ru');
  assert.equal(langOf('Hello'), 'en');
});

test('a WAV file of any plain kind is read as one channel of samples', () => {
  const tone = new Int16Array(800).map((_, i) => Math.round(Math.sin(i / 8) * 8000));
  const wav = wav16(tone, 22050);
  const back = wavSamples(wav);
  assert.equal(back.rate, 22050);
  assert.deepEqual([...back.pcm.slice(0, 20)], [...tone.slice(0, 20)]);
  // Two channels are mixed into one; 8-bit sound is widened.
  const stereo = Buffer.from(wav);
  stereo.writeUInt16LE(2, 22);
  stereo.writeUInt16LE(4, 32);
  assert.equal(wavSamples(stereo).pcm.length, 400);
  assert.equal(resample16(tone, 22050, 24000).length, Math.floor((800 * 24000) / 22050));
  assert.equal(resample16(tone, 16000, 16000), tone);
  assert.throws(() => wavSamples(Buffer.from('not a wav file at all, just some words here to fill')), /not a WAV/);
});

test('an Ogg page written by Hearth is read back as the same packets', () => {
  const small = Buffer.alloc(40, 1);
  const big = Buffer.alloc(600, 2); // longer than one piece of 255
  const exact = Buffer.alloc(255, 3); // exactly one full piece: needs an empty piece after it
  const page = oggPage([small, big, exact], { serial: 7, seq: 2, granule: 960 });
  assert.equal(page.toString('latin1', 0, 4), 'OggS');
  assert.deepEqual(oggPackets(page).map((p) => p.length), [40, 600, 255]);
  assert.equal(page.readUInt32LE(14), 7);
  assert.notEqual(page.readUInt32LE(22), 0, 'the checksum is filled in');
  const changed = Buffer.from(page);
  changed[60] ^= 1;
  assert.notEqual(oggPage([small, big, exact], { serial: 7, seq: 2, granule: 961 }).readUInt32LE(22), page.readUInt32LE(22), 'another page, another checksum');
});
