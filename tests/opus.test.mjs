// Voice messages from Telegram are Opus sound in an Ogg file. These tests take such files apart and decode them with
// the decoder that ships with Hearth (server/vendor), with no other program on the computer. The two recordings in
// tests/fixtures are one second of a steady tone each, made once with ffmpeg.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
process.env.HEARTH_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-test-'));
const { isOggOpus, oggPackets, opusHead, oggOpusToWav, wavToOggOpus, wav16 } = await import('../server/opus.mjs');
const { audioToWav, trimWav } = await import('../server/voice.mjs');

const mono = fs.readFileSync(path.join(HERE, 'fixtures', 'tone-mono.ogg'));
const stereo = fs.readFileSync(path.join(HERE, 'fixtures', 'tone-stereo.ogg'));

// The pitch of a steady tone in a 16-bit mono WAV, from how often the wave crosses zero in its middle part.
function pitch(wav) {
  const n = (wav.length - 44) / 2;
  const at = (i) => wav.readInt16LE(44 + i * 2);
  let crossings = 0;
  const from = Math.floor(n * 0.25);
  const to = Math.floor(n * 0.75);
  for (let i = from + 1; i < to; i++) if (at(i - 1) < 0 !== at(i) < 0) crossings++;
  return crossings / 2 / ((to - from) / wav.readUInt32LE(24));
}

test('an Ogg Opus recording is recognised and taken apart into its packets', () => {
  assert.equal(isOggOpus(mono), true);
  assert.equal(isOggOpus(Buffer.from('OggS' + '\0'.repeat(60) + 'vorbis')), false, 'Ogg with another kind of sound');
  assert.equal(isOggOpus(Buffer.from('RIFF....WAVE')), false);
  const packets = oggPackets(mono);
  assert.equal(packets[0].toString('latin1', 0, 8), 'OpusHead');
  assert.equal(packets[1].toString('latin1', 0, 8), 'OpusTags');
  assert.ok(packets.length >= 40 && packets.length <= 60, `one second in 20 ms frames: ${packets.length} packets`);
  assert.deepEqual(Object.keys(opusHead(packets[0])), ['channels', 'preSkip', 'mapping']);
  assert.equal(opusHead(packets[0]).channels, 1);
  assert.equal(opusHead(oggPackets(stereo)[0]).channels, 2);
  assert.throws(() => oggPackets(Buffer.from('this is not a sound file at all, it is plain text')), /not an Ogg file/);
  assert.throws(() => opusHead(Buffer.from('OpusTags........................')), /not an Opus recording/);
  // A packet longer than 254 bytes is spread over pieces of 255 and one shorter piece.
  const big = Buffer.alloc(600, 7);
  const page = Buffer.concat([Buffer.from('OggS'), Buffer.alloc(22), Buffer.from([3, 255, 255, 90]), big]);
  assert.deepEqual(oggPackets(page).map((p) => p.length), [600]);
});

test('the sound comes out as 16 kHz mono WAV with the same length and the same tone', async () => {
  const wav = await oggOpusToWav(mono);
  assert.equal(wav.toString('latin1', 0, 4), 'RIFF');
  assert.deepEqual([wav.readUInt16LE(22), wav.readUInt32LE(24), wav.readUInt16LE(34)], [1, 16000, 16], 'one channel, 16 kHz, 16 bits');
  const seconds = (wav.length - 44) / 32000;
  assert.ok(seconds > 0.95 && seconds < 1.1, `about one second: ${seconds}`);
  assert.ok(Math.abs(pitch(wav) - 440) < 8, `the 440 Hz tone: ${pitch(wav)}`);
  assert.equal(trimWav(wav).silent, false);

  const two = await oggOpusToWav(stereo);
  assert.equal(two.readUInt16LE(22), 1, 'two channels are mixed into one');
  assert.ok(Math.abs(pitch(two) - 880) < 12, `the 880 Hz tone: ${pitch(two)}`);
});

test('a recording cut off in the middle gives what was whole; rubbish is refused', async () => {
  const half = await oggOpusToWav(mono.subarray(0, Math.floor(mono.length * 0.6)));
  const seconds = (half.length - 44) / 32000;
  assert.ok(seconds > 0.3 && seconds < 0.8, `part of the second: ${seconds}`);
  await assert.rejects(oggOpusToWav(Buffer.from('OggS not really')), /Opus|Ogg/);
  await assert.rejects(oggOpusToWav(mono.subarray(0, 80)), /empty|Opus/);
});

test('the voice engine’s front door takes a Telegram voice message without any other program', async () => {
  const keep = process.env.PATH;
  process.env.PATH = '';
  try {
    const wav = await audioToWav(mono, 'voice.ogg');
    assert.deepEqual([wav.readUInt16LE(22), wav.readUInt32LE(24)], [1, 16000]);
    assert.equal(await audioToWav(wav, 'x.wav'), wav, 'sound that is already in the right form is passed through');
    await assert.rejects(audioToWav(Buffer.concat([Buffer.from('OggS'), Buffer.alloc(40), Buffer.from('OpusHead'), Buffer.alloc(8)]), 'voice.ogg'), (e) => e.code === 'BAD_SOUND');
  } finally {
    process.env.PATH = keep;
  }
  assert.equal(wav16(new Float32Array([0, 1, -1, 2])).readInt16LE(44 + 6), 32767, 'too loud a sample is held at the top');
});

// 0.2.29: the other way round, for the bot's spoken answers.
test('speech is packed into a voice message that reads back as the same sound', async () => {
  // Two seconds of a 300 Hz tone, as a system voice would hand it over: 22.05 kHz WAV.
  const tone = new Float32Array(44100).map((_, i) => Math.sin((2 * Math.PI * 300 * i) / 22050) * 0.5);
  const { ogg, seconds } = await wavToOggOpus(wav16(tone, 22050));
  assert.equal(isOggOpus(ogg), true);
  assert.ok(Math.abs(seconds - 2) < 0.01, `two seconds: ${seconds}`);
  assert.ok(ogg.length < 20000, `far smaller than the 88 KB it came from: ${ogg.length}`);
  const packets = oggPackets(ogg);
  assert.deepEqual(opusHead(packets[0]), { channels: 1, preSkip: 312, mapping: 0 });
  assert.equal(packets[1].toString('latin1', 0, 8), 'OpusTags');
  assert.equal(packets.length, 2 + 100, 'a hundred pieces of 20 ms');
  // The first page starts the file, the last one ends it, and the pages are numbered in order.
  const pages = [];
  for (let at = 0; at < ogg.length; ) {
    const count = ogg[at + 26];
    let size = 27 + count;
    for (let i = 0; i < count; i++) size += ogg[at + 27 + i];
    pages.push({ flags: ogg[at + 5], seq: ogg.readUInt32LE(at + 18), granule: Number(ogg.readBigUInt64LE(at + 6)) });
    at += size;
  }
  assert.deepEqual(pages.map((p) => p.seq), pages.map((_, i) => i));
  assert.equal(pages[0].flags, 2);
  assert.equal(pages.at(-1).flags, 4);
  assert.equal(pages.at(-1).granule, 312 + 96000, 'the last page says where the sound really ends');
  // Hearth's own reader gets the tone back.
  const back = await oggOpusToWav(ogg);
  const length = (back.length - 44) / 32000;
  assert.ok(Math.abs(length - 2) < 0.05, `two seconds again: ${length}`);
  assert.ok(Math.abs(pitch(back) - 300) < 6, `the 300 Hz tone: ${pitch(back)}`);
  await assert.rejects(wavToOggOpus(wav16(new Float32Array(100), 16000)), /too short/);
  await assert.rejects(wavToOggOpus(Buffer.from('not a wav file, only a few words to fill the space')), /not a WAV/);
});

