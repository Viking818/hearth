// The natural voice for spoken answers (0.2.30): numbers written out for it in Russian and English, Hearth's own
// bzip2 unpacker for its archives, the way a text reaches the program on Windows, and the choice between the
// natural voice and the system's. The voice program itself is stood in for by a small script.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-test-'));
process.env.HEARTH_DATA_DIR = tmp;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const { spellNumbers, cardinal, ordinal, plural } = await import('../server/ru-numbers.mjs');
const { spellNumbersEn, cardinalEn } = await import('../server/en-numbers.mjs');
const { bunzipFile } = await import('../server/bunzip.mjs');
const nv = await import('../server/natural-voice.mjs');
const { textToWav, voiceAnswer } = await import('../server/speak.mjs');
const { wav16, isOggOpus } = await import('../server/opus.mjs');
const { updateSettings, getSettings } = await import('../server/settings.mjs');

test('Russian numbers are written out the way a person reads them', () => {
  const says = (a, b) => assert.equal(spellNumbers(a), b);
  says('Рулон стоит около 90 долларов.', 'Рулон стоит около девяноста долларов.');
  says('99 рублей, 1000 рублей, 3200 рублей и 15 000 рублей', 'девяносто девять рублей, тысяча рублей, три тысячи двести рублей и пятнадцать тысяч рублей');
  says('Заказ номер 1500 будет готов 24 ноября 2026 года в 10:30.', 'Заказ номер тысяча пятьсот будет готов двадцать четвёртого ноября две тысячи двадцать шестого года в десять тридцать.');
  says('Цена 3,5 доллара за метр, скидка 15%.', 'Цена три целых пять десятых доллара за метр, скидка пятнадцать процентов.');
  says('Ширина 60 см, 21 шт. и 2 шт. Потом ещё 5 шт.', 'Ширина шестьдесят сантиметров, двадцать одна штука и две штуки. Потом ещё пять штук.');
  says('В 2024 г. было, с 2020 г. работаем, в 2026 году, 2025 год.', 'В две тысячи двадцать четвёртом году было, с две тысячи двадцатого года работаем, в две тысячи двадцать шестом году, две тысячи двадцать пятый год.');
  says('Цена $90, от $1 до $5, €21, 1 000 000 ₽.', 'Цена девяносто долларов, от одного доллара до пяти долларов, двадцать один евро, один миллион рублей.');
  says('Мы работаем с 9:00 до 18:30, встреча в 14:00, обед в 13:05.', 'Мы работаем с девяти до восемнадцати тридцати, встреча в четырнадцать часов, обед в тринадцать ноль пять.');
  says('До 2 метров, более 100 штук, менее 1 минуты, около 1000, 1 минута, 2 недели, 22 штуки, 2 дня.', 'До двух метров, более ста штук, менее одной минуты, около тысячи, одна минута, две недели, двадцать две штуки, два дня.');
  // A phone number and a code go digit by digit; a version part by part; a number inside a name is left alone.
  says('Позвоните 89161234567 или назовите код 0042.', 'Позвоните восемь девять один шесть один два три четыре пять шесть семь или назовите код ноль ноль четыре два.');
  says('Qwen3.8 и версия 0.2.30, дом 5а.', 'Qwen3.8 и версия ноль точка два точка тридцать, дом 5а.');
  assert.equal(cardinal(1001000), 'один миллион одна тысяча');
  assert.equal(cardinal(21000), 'двадцать одна тысяча');
  assert.equal(cardinal(1500, { gen: true }), 'тысячи пятисот');
  assert.equal(ordinal(2000, 'gen'), 'двухтысячного');
  assert.equal(ordinal(3, 'nom'), 'третий');
  assert.equal(ordinal(40, 'nom'), 'сороковой');
  assert.deepEqual([1, 3, 5, 11, 21, 112].map((n) => plural(n, ['рубль', 'рубля', 'рублей'])), ['рубль', 'рубля', 'рублей', 'рублей', 'рубль', 'рублей']);
});

test('English numbers the voice stumbles on are written out; the ones it reads well stay', () => {
  const says = (a, b) => assert.equal(spellNumbersEn(a), b);
  says('That is 1,250 shirts and 3200 prints.', 'That is one thousand two hundred fifty shirts and three thousand two hundred prints.');
  says('It costs $90, or 3.5 dollars per meter, with a 15% discount.', 'It costs $90, or 3 point 5 dollars per meter, with a 15% discount.');
  says('Version 0.2.30 came out in 2026.', 'Version 0 point 2 point 30 came out in 2026.');
  says('Call 555-0142 before 6:30 PM.', 'Call five five five, zero one four two before 6:30 PM.');
  says('The total is $1,499.50 for 15000 units.', 'The total is one thousand four hundred ninety-nine dollars and fifty cents for fifteen thousand units.');
  says('Code 0042, 25 pieces, 0.25 inches.', 'Code zero zero four two, 25 pieces, 0 point 25 inches.');
  assert.equal(cardinalEn(1000001), 'one million one');
  assert.equal(cardinalEn(0), 'zero');
});

// The same text the fixture was made from (tests/fixtures/sample.bz2: `bzip2 -1`, so it has several blocks).
function sampleText() {
  const parts = [];
  let x = 12345;
  for (let i = 0; i < 20000; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    parts.push(['плёнка', 'рулон', 'DTF', 'print', '60 см', 'shirt', 'голос'][x % 7]);
    if (i % 97 === 0) parts.push('='.repeat(300 + (x % 500)));
  }
  return Buffer.from(parts.join(' '), 'utf8');
}

test('Hearth unpacks bzip2 itself: several blocks, long runs, two files in one, and damage is noticed', async () => {
  const src = path.join(HERE, 'fixtures', 'sample.bz2');
  const out = path.join(tmp, 'sample.out');
  const want = sampleText();
  let steps = 0;
  await bunzipFile(src, out, () => steps++);
  assert.ok(fs.readFileSync(out).equals(want), 'the text comes back byte for byte');
  assert.ok(steps >= 2, 'more than one block');
  // Two bzip2 files one after the other are one file's worth of each.
  const twice = path.join(tmp, 'twice.bz2');
  fs.writeFileSync(twice, Buffer.concat([fs.readFileSync(src), fs.readFileSync(src)]));
  await bunzipFile(twice, out);
  assert.ok(fs.readFileSync(out).equals(Buffer.concat([want, want])));
  // One changed byte in the middle: a checksum (or the format itself) gives it away.
  const hurt = Buffer.from(fs.readFileSync(src));
  hurt[Math.floor(hurt.length / 2)] ^= 0x10;
  const broken = path.join(tmp, 'broken.bz2');
  fs.writeFileSync(broken, hurt);
  await assert.rejects(bunzipFile(broken, out), /not a valid bzip2 file/);
  fs.writeFileSync(broken, 'just some words, no archive');
  await assert.rejects(bunzipFile(broken, out), /not a valid bzip2 file/);
});

test('on Windows the text reaches the voice program as the same UTF-8 bytes, whatever the code page', () => {
  const text = 'Привет, Игорь! Это я — «голос». Ёж, сэр: 90 % and "quotes".';
  // What Windows does with an argument: every character back into one byte of the code page.
  const back = (arg, table) => Buffer.from([...arg].map((ch) => table.get(ch)));
  for (const cp of [1251, 1252]) {
    const table = new Map();
    for (let b = 0; b < 256; b++) table.set(nv.ansiArgument(String.fromCharCode(0x41), cp) && (cp === 1252 ? cp1252(b) : new TextDecoder('windows-1251').decode(Buffer.from([b]))), b);
    const arg = nv.ansiArgument(text, cp);
    assert.equal(arg.length, Buffer.byteLength(text), `one character for every byte (${cp})`);
    assert.equal(back(arg, table).toString('utf8'), text, `the bytes come back as the text (${cp})`);
  }
  assert.equal(nv.ansiArgument(text, 65001), text, 'a Windows set to UTF-8 gets the text as it is');
  assert.equal(nv.ansiArgument(text, 932), null, 'a two-byte code page cannot carry it: the system voice answers');
});
// The Windows-1252 table, written out here on its own (bytes 80 to 9F; the rest equals Unicode).
function cp1252(b) {
  const hi = [0x20ac, 0x81, 0x201a, 0x192, 0x201e, 0x2026, 0x2020, 0x2021, 0x2c6, 0x2030, 0x160, 0x2039, 0x152, 0x8d, 0x17d, 0x8f, 0x90, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x2dc, 0x2122, 0x161, 0x203a, 0x153, 0x9d, 0x17e, 0x178];
  return String.fromCharCode(b >= 0x80 && b < 0xa0 ? hi[b - 0x80] : b);
}

test('the words the voice gets: numbers written out, signs it does not know made plain', () => {
  assert.equal(nv.wordsFor('Заказ №15 — «рулон» за 90 $.', 'ru'), 'Заказ номер пятнадцать — "рулон" за девяносто долларов.');
  assert.equal(nv.wordsFor('It’s 3200 prints.', 'en'), "It's three thousand two hundred prints.");
  assert.equal(nv.voiceNumber(7), 7);
  assert.equal(nv.voiceNumber(0), 4, 'anything else is the usual voice');
  assert.equal(nv.voiceNumber('x'), 4);
  assert.equal(nv.naturalName(7), 'Supertonic 3 · 7');
});

test('not downloaded: the natural voice says so, and nothing pretends to be it', async () => {
  const st = nv.naturalStatus();
  assert.equal(st.ready, false);
  assert.equal(st.installing, false);
  assert.equal(st.voices, 10);
  assert.equal(st.voice, 4);
  if (st.supported) assert.ok(st.size > 140e6 && st.size < 170e6, 'the size of the download is known before it starts');
  await assert.rejects(textToWav('Привет', 'ru', { voice: 'natural' }), (err) => err.code === 'NO_NATURAL');
});

// A stand-in for the voice program: it notes its arguments, repeats the text like the real one, and "speaks" a tone.
function installStandIn() {
  const home = path.join(tmp, 'voice', 'natural');
  const bin = path.join(home, 'engine', 'pack', 'bin');
  const model = path.join(home, 'model', 'supertonic');
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(model, { recursive: true });
  for (const f of ['duration_predictor.int8.onnx', 'text_encoder.int8.onnx', 'vector_estimator.int8.onnx', 'vocoder.int8.onnx', 'tts.json', 'unicode_indexer.bin', 'voice.bin']) fs.writeFileSync(path.join(model, f), 'x');
  fs.writeFileSync(path.join(home, 'tone.wav'), wav16(new Int16Array(22050).map((_, i) => Math.round(Math.sin(i / 12) * 9000)), 44100));
  fs.writeFileSync(
    path.join(bin, 'sherpa-onnx-offline-tts'),
    `#!/bin/sh
out=""
for a in "$@"; do
  case "$a" in --output-filename=*) out="\${a#--output-filename=}";; esac
  last="$a"
done
printf '%s\\n' "$@" > args.txt
if [ -f fail ]; then echo "boom: the voice files are damaged" >&2; exit 1; fi
cp tone.wav "$out"
echo "The text is: $last. Speaker ID: 0" >&2
`,
    { mode: 0o755 },
  );
  return home;
}

test('downloaded: answers are read by the natural voice, with the chosen voice and the right language', { skip: process.platform === 'win32' }, async () => {
  const home = installStandIn();
  const args = () => fs.readFileSync(path.join(home, 'args.txt'), 'utf8').trim().split('\n');
  assert.equal(nv.naturalStatus().ready, true);
  const r = await textToWav('Рулон стоит около 90 долларов.', 'ru');
  assert.equal(r.natural, true);
  assert.equal(r.voice, 'Supertonic 3 · 4');
  assert.ok(r.wav.length > 40000, 'the speech is what the program wrote');
  let a = args();
  assert.ok(a.includes('--sid=3') && a.includes('--lang=ru'), 'voice 4 is the fourth of ten; Russian');
  assert.equal(a.at(-1), 'Рулон стоит около девяноста долларов.', 'the number goes to the voice in words');
  assert.ok(a.every((x, i) => i === a.length - 1 || /^[\x20-\x7e]+$/.test(x)), 'nothing but the text has other than plain letters');
  assert.equal(fs.readdirSync(home).filter((f) => f.startsWith('say-')).length, 0, 'the sound file is cleaned up');
  // Another voice for one reading (the "Listen" button), English for an English text.
  const en = await textToWav('It costs 3200 dollars.', 'en', { voice: 'natural', style: 7 });
  assert.equal(en.voice, 'Supertonic 3 · 7');
  a = args();
  assert.ok(a.includes('--sid=6') && a.includes('--lang=en'));
  assert.equal(a.at(-1), 'It costs three thousand two hundred dollars.');
  // The voice from the settings; a number out of range is pulled back in.
  updateSettings({ naturalVoiceStyle: 99 });
  assert.equal(getSettings().naturalVoiceStyle, 10);
  await textToWav('Привет', 'ru');
  assert.ok(args().includes('--sid=9'));
  updateSettings({ naturalVoiceStyle: 4 });
  // A whole spoken answer: a voice message, and it says which voice read it.
  const v = await voiceAnswer('**Привет!** Заказ готов.');
  assert.ok(isOggOpus(v.data));
  assert.equal(v.natural, true);
  assert.equal(v.text, 'Привет! Заказ готов.');
});

test('the system voice stays the fallback: when the natural one is switched off or fails', { skip: process.platform === 'win32' }, async () => {
  const home = installStandIn();
  const argsFile = path.join(home, 'args.txt');
  // A reading by the system either works (a Mac, a Windows with voices) or fails as the system's voice, never as the natural one.
  const system = async (opts) => {
    try {
      return (await textToWav('Привет', 'ru', opts)).natural;
    } catch (err) {
      assert.ok(['NO_VOICE', 'NO_TTS'].includes(err.code), `the system voice was asked (${err.code})`);
      return false;
    }
  };
  // Switched off in the settings: the program is not even started.
  updateSettings({ naturalVoice: false });
  fs.rmSync(argsFile, { force: true });
  assert.equal(await system(), false);
  assert.equal(fs.existsSync(argsFile), false);
  assert.equal(nv.naturalStatus().on, false);
  updateSettings({ naturalVoice: true });
  // The program fails: the system's voice takes over, and the reason is kept for the settings page.
  fs.writeFileSync(path.join(home, 'fail'), '');
  assert.equal(await system(), false);
  assert.match(nv.naturalStatus().error, /the voice files are damaged/);
  // Asked for the natural voice only (the "Listen" button): the failure is told, not hidden.
  await assert.rejects(textToWav('Привет', 'ru', { voice: 'natural' }), (err) => err.code === 'NATURAL_FAILED' && /damaged/.test(err.message));
  fs.rmSync(path.join(home, 'fail'));
  assert.equal((await textToWav('Привет', 'ru')).natural, true);
  assert.equal(nv.naturalStatus().error, '', 'a good reading clears the note');
  // Taking the voice off the computer again.
  assert.equal(nv.removeNatural().ready, false);
  assert.equal(fs.existsSync(home), false);
});
