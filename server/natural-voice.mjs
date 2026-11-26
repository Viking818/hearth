// A natural voice for spoken answers: Supertonic 3, a small neural voice that runs on the processor of this
// computer (about a minute of speech in ten seconds), in Russian, English and 29 other languages, with ten voices.
// It is an optional download of about 150 MB: the voice files, and the free program that runs them
// (sherpa-onnx, Apache-2.0; the voice itself is by Supertone, under the OpenRAIL-M license).
// Both come from the sherpa-onnx project's releases on GitHub, at one fixed version, and are checked against the
// checksums written here before anything is unpacked or run. Nothing is sent anywhere when it speaks.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { DIRS, getSettings } from './settings.mjs';
import { IS_WIN, run } from './util.mjs';
import { startDownload, listDownloads } from './downloads.mjs';
import { extract, findProgram } from './engine-install.mjs';
import { bunzipFile } from './bunzip.mjs';
import { spellNumbers } from './ru-numbers.mjs';
import { spellNumbersEn } from './en-numbers.mjs';
import { t } from './i18n.mjs';

// HEARTH_NATURAL_VOICE_FROM: another place with the same files (the tests use a folder served on this computer).
// The checksums below hold for any source.
const FROM = (process.env.HEARTH_NATURAL_VOICE_FROM || 'https://github.com/k2-fsa/sherpa-onnx/releases/download').replace(/\/+$/, '');
const TAG = 'v2.0.3';
const ENGINES = {
  'darwin-arm64': { name: `sherpa-onnx-${TAG}-osx-arm64-shared.tar.bz2`, size: 21914267, sha256: '14afb4ed15dc4f376c69be5a795039824e47f5ffcfc2488556f796ecaf420d07' },
  'darwin-x64': { name: `sherpa-onnx-${TAG}-osx-x64-shared.tar.bz2`, size: 24628586, sha256: '8fdd4f2c4dcda061437f68b292ebee9f3be1f3ab0f533cbbd20be9730dae68f0' },
  'win32-x64': { name: `sherpa-onnx-${TAG}-win-x64-shared-MT-Release.tar.bz2`, size: 32180449, sha256: '1d2414ac8921f718ba3188782f80475f525a3d82eeb59cef75ceb9360fbf8182' },
  'win32-arm64': { name: `sherpa-onnx-${TAG}-win-arm64-shared-MT-Release.tar.bz2`, size: 29664719, sha256: '9a5cf7347efb3850eaeb678706bce867a5442d27be02170b60013c9d1afe7240' },
  'linux-x64': { name: `sherpa-onnx-${TAG}-linux-x64-shared.tar.bz2`, size: 29936514, sha256: '615b1bf0140bf09051c15fde6579e48543696352ebd477217d2e69b49d9aec13' },
  'linux-arm64': { name: `sherpa-onnx-${TAG}-linux-aarch64-shared-cpu.tar.bz2`, size: 29516176, sha256: 'c42748225180235bdd4ba10f8c4575b54beb8d5b26a5303bb3051026a0fe4e53' },
};
const MODEL = { label: 'Supertonic 3', name: 'sherpa-onnx-supertonic-3-tts-int8-2026-05-11.tar.bz2', size: 128774318, sha256: '82fa96f91c4ef8abaae3a14a3f4153facf88bed821d1f7331cec2700f432c427' };
const MODEL_FILES = ['duration_predictor.int8.onnx', 'text_encoder.int8.onnx', 'vector_estimator.int8.onnx', 'vocoder.int8.onnx', 'tts.json', 'unicode_indexer.bin', 'voice.bin'];
const LANGS = new Set('en ko ja ar bg cs da de el es et fi fr hi hr hu id it lt lv nl pl pt ro ru sk sl sv tr uk vi'.split(' '));
export const NATURAL_VOICES = 10;
const DEFAULT_VOICE = 4;

const EXE = IS_WIN ? 'sherpa-onnx-offline-tts.exe' : 'sherpa-onnx-offline-tts';
const HOME = path.join(DIRS.voice, 'natural');
const ENGINE_DIR = path.join(HOME, 'engine');
const MODEL_DIR = path.join(HOME, 'model');
const failed = (code, message) => Object.assign(new Error(message), { code });

let lastError = '';

const enginePath = () => findProgram(ENGINE_DIR, EXE, 4);
// The folder with the voice files, when every one of them is there.
function modelPath() {
  const json = findProgram(MODEL_DIR, 'tts.json', 3);
  const dir = json && path.dirname(json);
  return dir && MODEL_FILES.every((f) => fs.existsSync(path.join(dir, f))) ? dir : '';
}

// The voice a number from the settings stands for: 1 to 10.
export const voiceNumber = (n) => (Number.isInteger(Number(n)) && Number(n) >= 1 && Number(n) <= NATURAL_VOICES ? Number(n) : DEFAULT_VOICE);
export const naturalName = (n) => `${MODEL.label} · ${voiceNumber(n)}`;

export function naturalStatus() {
  const asset = ENGINES[`${process.platform}-${os.arch()}`];
  const engine = Boolean(enginePath());
  const model = Boolean(modelPath());
  const s = getSettings();
  return {
    supported: Boolean(asset),
    ready: engine && model,
    engine,
    model,
    installing: listDownloads().some((d) => d.kind === 'speech' && (d.state === 'downloading' || d.state === 'queued' || d.state === 'finishing')),
    size: (engine || !asset ? 0 : asset.size) + (model ? 0 : MODEL.size), // what is still to download
    name: MODEL.label,
    voices: NATURAL_VOICES,
    on: s.naturalVoice !== false,
    voice: voiceNumber(s.naturalVoiceStyle),
    error: lastError,
  };
}

// An archive that has arrived: off with the bzip2 layer, unpack into a fresh folder, check, then swap it in.
async function unpack(archive, into, check) {
  const tar = archive.replace(/\.bz2$/, '');
  const fresh = `${into}.new`;
  try {
    await bunzipFile(archive, tar);
    fs.rmSync(fresh, { recursive: true, force: true });
    fs.mkdirSync(fresh, { recursive: true });
    await extract(tar, fresh);
    check(fresh);
    fs.rmSync(into, { recursive: true, force: true });
    fs.renameSync(fresh, into);
    fs.rmSync(archive, { force: true });
  } finally {
    fs.rmSync(tar, { force: true });
    fs.rmSync(fresh, { recursive: true, force: true });
  }
}

// Downloads what is missing: the program that runs the voice, and the voice.
export async function installNatural() {
  const asset = ENGINES[`${process.platform}-${os.arch()}`];
  if (!asset) throw new Error(t('The natural voice is not available for this kind of computer.'));
  const st = naturalStatus();
  const tmp = path.join(HOME, '.download');
  const jobs = [];
  if (!st.engine) {
    jobs.push(
      startDownload({
        kind: 'speech',
        label: t('Natural voice: the program that speaks'),
        files: [{ url: `${FROM}/${TAG}/${asset.name}`, dest: path.join(tmp, asset.name), size: asset.size, sha256: asset.sha256 }],
        onDone: () =>
          unpack(path.join(tmp, asset.name), ENGINE_DIR, (dir) => {
            const bin = findProgram(dir, EXE, 4);
            if (!bin) throw new Error(t('The download did not contain {name}.', { name: EXE }));
            if (!IS_WIN) fs.chmodSync(bin, 0o755);
            // The archive holds thirty more programs (speech recognition, microphones…): only the one that speaks stays.
            for (const f of fs.readdirSync(path.dirname(bin))) if (f !== EXE && /^sherpa-onnx[\w-]*(\.exe)?$/.test(f)) fs.rmSync(path.join(path.dirname(bin), f), { force: true });
            fs.rmSync(path.join(path.dirname(bin), '..', 'include'), { recursive: true, force: true });
            // Windows looks for a program's libraries next to the program first, then in its own System32 (which has
            // an old onnxruntime.dll of its own), and only then anywhere else. So the libraries must lie beside it.
            const lib = path.join(path.dirname(bin), '..', 'lib');
            if (IS_WIN && fs.existsSync(lib)) for (const f of fs.readdirSync(lib)) if (/\.dll$/i.test(f) && !fs.existsSync(path.join(path.dirname(bin), f))) fs.copyFileSync(path.join(lib, f), path.join(path.dirname(bin), f));
          }),
      }),
    );
  }
  if (!st.model) {
    jobs.push(
      startDownload({
        kind: 'speech',
        label: t('Natural voice: {name}', { name: MODEL.label }),
        files: [{ url: `${FROM}/tts-models/${MODEL.name}`, dest: path.join(tmp, MODEL.name), size: MODEL.size, sha256: MODEL.sha256 }],
        onDone: () =>
          unpack(path.join(tmp, MODEL.name), MODEL_DIR, (dir) => {
            const json = findProgram(dir, 'tts.json', 3);
            const missing = MODEL_FILES.filter((f) => !json || !fs.existsSync(path.join(path.dirname(json), f)));
            if (missing.length) throw new Error(t('The download did not contain {name}.', { name: missing[0] }));
          }),
      }),
    );
  }
  lastError = '';
  return { jobs, status: naturalStatus() };
}

// Takes the natural voice off this computer again (it can be downloaded once more at any time).
export function removeNatural() {
  if (busy) throw Object.assign(new Error(t('The voice is speaking right now. Try again in a moment.')), { status: 409 });
  fs.rmSync(HOME, { recursive: true, force: true });
  lastError = '';
  return naturalStatus();
}

// ---- Text for a Windows program ----
// The program takes the text as an argument and expects UTF-8. Windows hands an old-style program its arguments in
// the system's own 8-bit code page (1251 on a Russian Windows, 1252 on an English one), not in UTF-8. So Hearth
// passes the text's UTF-8 bytes dressed up as characters of that code page: Windows turns them back into the very
// same bytes, and the program reads its UTF-8. (When Windows is set to UTF-8 itself, the text goes as it is.)
const CP1252_80 = '€\u0081‚ƒ„…†‡ˆ‰Š‹Œ\u008dŽ\u008f\u0090‘’“”•–—˜™š›œ\u009džŸ';
export function ansiArgument(text, codePage) {
  if (codePage === 65001) return text;
  const bytes = Buffer.from(text, 'utf8');
  if (codePage === 1252) {
    let out = '';
    for (const b of bytes) out += b >= 0x80 && b < 0xa0 ? CP1252_80[b - 0x80] : String.fromCharCode(b);
    return out;
  }
  if (![874, 1250, 1251, 1253, 1254, 1255, 1256, 1257, 1258].includes(codePage)) return null; // two-byte code pages (Chinese, Japanese, Korean) can't carry it
  try {
    const out = new TextDecoder(`windows-${codePage}`).decode(bytes);
    return out.length === bytes.length && !out.includes('�') ? out : null;
  } catch {
    return null;
  }
}

let codePage = null;
async function windowsCodePage() {
  if (codePage == null) codePage = Number(/ACP\s+REG_SZ\s+(\d+)/i.exec(await run('reg', ['query', 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Nls\\CodePage', '/v', 'ACP']))?.[1]) || 1252;
  return codePage;
}

// ---- Speaking ----
// The words as the voice should get them: numbers written out where it misreads digits (ru-numbers.mjs,
// en-numbers.mjs), and signs it does not know replaced by plain ones.
export function wordsFor(text, lang) {
  let s = String(text || '');
  if (lang === 'ru') s = spellNumbers(s.replace(/№\s*/g, 'номер '));
  else if (lang === 'en') s = spellNumbersEn(s);
  return s.replace(/[«»„“”]/g, '"').replace(/[‘’]/g, "'").replace(/\s*[—–]\s*/g, ' — ').replace(/\s+/g, ' ').trim();
}

let busy = false;
let line = Promise.resolve(); // one text at a time: the voice uses several processor cores

/**
 * text: plain words. Returns the speech as a WAV file (44.1 kHz, one channel).
 * voice: 1 to 10 (the one from the settings when left out). Fails with code NO_NATURAL when the voice is not
 * installed, NATURAL_FAILED when it could not speak.
 */
export function naturalWav(text, lang = 'en', { voice } = {}) {
  const job = line.then(() => speak(text, lang, voice));
  line = job.catch(() => {});
  return job;
}

async function speak(text, lang, voice) {
  const bin = enginePath();
  const model = modelPath();
  if (!bin || !model) throw failed('NO_NATURAL', 'the natural voice is not installed');
  const words = wordsFor(text, lang);
  let arg = words;
  if (IS_WIN) {
    arg = ansiArgument(words, await windowsCodePage());
    if (arg == null) throw failed('NATURAL_FAILED', `the language setting of this Windows (code page ${codePage}) cannot pass the text to the voice`);
  }
  // Every file is named from the voice's own folder, so no argument but the text has anything but plain letters.
  const rel = (f) => path.join(path.relative(HOME, model), f);
  const outName = `say-${process.pid}-${Date.now().toString(36)}.wav`;
  const out = path.join(HOME, outName);
  const args = [
    `--supertonic-duration-predictor=${rel('duration_predictor.int8.onnx')}`,
    `--supertonic-text-encoder=${rel('text_encoder.int8.onnx')}`,
    `--supertonic-vector-estimator=${rel('vector_estimator.int8.onnx')}`,
    `--supertonic-vocoder=${rel('vocoder.int8.onnx')}`,
    `--supertonic-tts-json=${rel('tts.json')}`,
    `--supertonic-unicode-indexer=${rel('unicode_indexer.bin')}`,
    `--supertonic-voice-style=${rel('voice.bin')}`,
    `--lang=${LANGS.has(lang) ? lang : 'en'}`,
    '--num-steps=8',
    `--sid=${voiceNumber(voice ?? getSettings().naturalVoiceStyle) - 1}`,
    `--num-threads=${Math.max(1, Math.min(4, os.cpus().length - 2))}`,
    `--output-filename=${outName}`,
    arg,
  ];
  const env = { ...process.env };
  if (IS_WIN) {
    // The program's libraries lie next to it or in the folder beside.
    const key = Object.keys(env).find((k) => k.toLowerCase() === 'path') || 'Path';
    env[key] = [path.dirname(bin), path.join(path.dirname(bin), '..', 'lib'), env[key] || ''].join(path.delimiter);
  }
  busy = true;
  try {
    const r = await new Promise((resolve) => {
      execFile(bin, args, { cwd: HOME, env, timeout: 240e3, windowsHide: true, maxBuffer: 16 << 20, encoding: 'buffer' }, (err, stdout, stderr) => resolve({ err, log: Buffer.concat([stdout || Buffer.alloc(0), stderr || Buffer.alloc(0)]) }));
    });
    const tail = r.log.toString('utf8').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !/^sample=/.test(l)).slice(-2).join(' ').slice(-300);
    if (r.err || !fs.existsSync(out) || fs.statSync(out).size < 200) throw failed('NATURAL_FAILED', (r.err?.killed ? 'it took too long' : tail || r.err?.message || 'the voice made no sound').slice(0, 300));
    // The program repeats the text it was given. If that is not our text, the text was damaged on its way in
    // (the Windows code page): better no natural voice than a wrong one.
    if (IS_WIN && !r.log.includes(Buffer.from(words, 'utf8'))) throw failed('NATURAL_FAILED', 'Windows changed the text on its way to the voice');
    lastError = '';
    return fs.readFileSync(out);
  } catch (err) {
    lastError = String(err.message || err);
    throw err;
  } finally {
    busy = false;
    fs.rmSync(out, { force: true });
  }
}
