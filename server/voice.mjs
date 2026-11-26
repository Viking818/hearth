// Speech to text with whisper.cpp: its small server starts when the microphone is first used and stops when idle.
// The engine: a ready-made build on Windows and Linux; on a Mac, Homebrew's whisper-cpp (one Terminal command).
// The model: Whisper large-v3 turbo, which understands Russian, English and ~100 other languages well.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { DIRS } from './settings.mjs';
import { run, exists, findFreePort, sleep, IS_WIN, IS_MAC } from './util.mjs';
import { startDownload, listDownloads, shaOf } from './downloads.mjs';
import { extract, findProgram } from './engine-install.mjs';
import { t } from './i18n.mjs';
import { isOggOpus, oggOpusToWav } from './opus.mjs';

const EXE = IS_WIN ? 'whisper-server.exe' : 'whisper-server';
export const VOICE_MODEL = {
  name: 'Whisper large-v3 turbo',
  file: 'ggml-large-v3-turbo-q5_0.bin',
  url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin',
  size: 574041195,
};
const ENGINE_DIR = path.join(DIRS.voice, 'engine');
const MODEL_PATH = path.join(DIRS.voice, VOICE_MODEL.file);
const IDLE_MS = 5 * 60e3;

let server = null; // { proc, port, ready }
let lastUse = 0;
let idleTimer = null;

async function findEngine() {
  const local = findProgram(ENGINE_DIR, EXE, 4);
  if (local) return { path: local, source: 'downloaded' };
  // Apps started from the Dock don't see Homebrew's folder in PATH, so look there by name first.
  for (const p of IS_MAC ? ['/opt/homebrew/bin/whisper-server', '/usr/local/bin/whisper-server'] : []) if (exists(p)) return { path: p, source: 'homebrew' };
  const which = (await run(IS_WIN ? 'where' : 'which', [EXE])).trim().split(/\r?\n/)[0];
  if (which && exists(which)) return { path: which, source: 'system' };
  return null;
}

export async function voiceStatus() {
  const engine = await findEngine();
  const model = fs.existsSync(MODEL_PATH) && fs.statSync(MODEL_PATH).size === VOICE_MODEL.size;
  const jobs = listDownloads().filter((d) => d.kind === 'voice' && (d.state === 'downloading' || d.state === 'queued' || d.state === 'finishing'));
  return {
    ready: Boolean(engine && model),
    engine,
    model: model ? { name: VOICE_MODEL.name, size: VOICE_MODEL.size } : null,
    modelSize: VOICE_MODEL.size,
    installing: jobs.length > 0,
    // On a Mac the engine comes from Homebrew; Hearth can't download a ready-made one there.
    needsHomebrew: IS_MAC && !engine,
    brewCommand: 'brew install whisper.cpp',
    running: Boolean(server?.ready),
  };
}

async function latestRelease() {
  const res = await fetch('https://api.github.com/repos/ggml-org/whisper.cpp/releases?per_page=8', { headers: { accept: 'application/vnd.github+json', 'user-agent': 'Hearth' }, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(t('GitHub said {status}', { status: res.status }));
  const arm = os.arch() === 'arm64';
  const want = IS_WIN ? [arm ? /^whisper-bin-win-cpu-arm64\.zip$/ : /^whisper-blas-bin-x64\.zip$/, /^whisper-bin-x64\.zip$/] : [arm ? /^whisper-bin-ubuntu-arm64\.tar\.gz$/ : /^whisper-bin-ubuntu-x64\.tar\.gz$/];
  for (const rel of await res.json()) {
    for (const re of want) {
      const a = rel.assets?.find((x) => re.test(x.name));
      if (a) return { tag: rel.tag_name, name: a.name, url: a.browser_download_url, size: a.size, sha256: shaOf(a) };
    }
  }
  return null;
}

// Downloads what is missing: the model always, the engine where a ready-made one exists.
export async function installVoice() {
  const st = await voiceStatus();
  const jobs = [];
  if (!st.model) {
    jobs.push(
      startDownload({
        kind: 'voice',
        label: t('Voice model ({name})', { name: VOICE_MODEL.name }),
        files: [{ url: VOICE_MODEL.url, dest: MODEL_PATH, size: VOICE_MODEL.size }],
      }),
    );
  }
  if (!st.engine && !IS_MAC) {
    const rel = await latestRelease();
    if (!rel) throw new Error(t('No ready-made voice engine for this system.'));
    const tmp = path.join(DIRS.voice, '.download');
    jobs.push(
      startDownload({
        kind: 'voice',
        label: t('Voice engine (whisper.cpp {tag})', { tag: rel.tag }),
        files: [{ url: rel.url, size: rel.size, sha256: rel.sha256, dest: path.join(tmp, rel.name) }],
        onDone: async () => {
          fs.rmSync(ENGINE_DIR, { recursive: true, force: true });
          fs.mkdirSync(ENGINE_DIR, { recursive: true });
          await extract(path.join(tmp, rel.name), ENGINE_DIR);
          const bin = findProgram(ENGINE_DIR, EXE, 4);
          if (!bin) throw new Error(t('The download did not contain {name}.', { name: EXE }));
          if (!IS_WIN) fs.chmodSync(bin, 0o755);
          fs.rmSync(path.join(tmp, rel.name), { force: true });
        },
      }),
    );
  }
  return { jobs, status: await voiceStatus() };
}

async function ensureServer() {
  if (server?.ready && server.proc.exitCode == null) return server;
  if (server?.starting) return server.starting;
  const engine = await findEngine();
  if (!engine) throw Object.assign(new Error(t('The voice engine is not installed yet.')), { status: 409 });
  if (!fs.existsSync(MODEL_PATH)) throw Object.assign(new Error(t('The voice model is not downloaded yet.')), { status: 409 });
  const port = await findFreePort(7470);
  const threads = String(Math.max(2, Math.min(8, os.cpus().length - 2)));
  const proc = spawn(engine.path, ['-m', MODEL_PATH, '--host', '127.0.0.1', '--port', String(port), '-t', threads, '-l', 'auto'], { cwd: path.dirname(engine.path), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  proc.stdout.on('data', (d) => (log = (log + d).slice(-4000)));
  proc.stderr.on('data', (d) => (log = (log + d).slice(-4000)));
  const rec = { proc, port, ready: false };
  server = rec;
  rec.starting = (async () => {
    const deadline = Date.now() + 90e3;
    while (Date.now() < deadline) {
      if (proc.exitCode != null) break;
      try {
        const r = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1500) });
        if (r.status < 500) {
          rec.ready = true;
          return rec;
        }
      } catch {}
      await sleep(300);
    }
    proc.kill();
    server = null;
    throw new Error(t('The voice engine did not start. {detail}', { detail: log.trim().split('\n').slice(-2).join(' ') }));
  })();
  proc.on('exit', () => {
    if (server === rec) server = null;
  });
  try {
    return await rec.starting;
  } finally {
    rec.starting = null;
  }
}

function scheduleIdleStop() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (Date.now() - lastUse >= IDLE_MS) stopVoice();
  }, IDLE_MS + 1000);
}

export function stopVoice() {
  if (server?.proc) server.proc.kill();
  server = null;
}

// audio: a WAV file (16 kHz mono from the page). Returns the text.
export async function transcribe(audio, { language = 'auto', timeout = 120e3 } = {}) {
  lastUse = Date.now();
  const s = await ensureServer();
  const form = new FormData();
  form.append('file', new Blob([audio], { type: 'audio/wav' }), 'speech.wav');
  form.append('response_format', 'json');
  form.append('temperature', '0.0');
  form.append('language', /^[a-z]{2}$|^auto$/.test(language) ? language : 'auto');
  const res = await fetch(`http://127.0.0.1:${s.port}/inference`, { method: 'POST', body: form, signal: AbortSignal.timeout(timeout) });
  lastUse = Date.now();
  scheduleIdleStop();
  if (!res.ok) throw new Error(t('The voice engine answered with an error ({status}).', { status: res.status }));
  const j = await res.json().catch(() => ({}));
  return String(j.text || '').replace(/\s+/g, ' ').replace(/\[(BLANK_AUDIO|MUSIC|Music|музыка)\]/g, '').trim();
}

// ---- Speech in a video ----
// The page reads a video's sound itself where the browser can. Safari can't for MOV files (every iPhone video), so on
// a Mac Hearth does it with the converter macOS has built in.
const SPEECH_SECONDS = 600;

// The first `seconds` of a 16 kHz mono 16-bit WAV as a plain WAV file, and whether anything can be heard in it.
export function trimWav(buf, seconds = SPEECH_SECONDS) {
  if (buf.length < 44 || buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WAVE') return null;
  let at = 12;
  while (at + 8 <= buf.length && buf.toString('latin1', at, at + 4) !== 'data') at += 8 + buf.readUInt32LE(at + 4) + (buf.readUInt32LE(at + 4) % 2);
  if (at + 8 > buf.length) return null;
  const all = Math.min(buf.readUInt32LE(at + 4), buf.length - at - 8);
  const size = Math.min(all, seconds * 32000) & ~1;
  const data = buf.subarray(at + 8, at + 8 + size);
  let peak = 0;
  for (let i = 0; i + 1 < data.length; i += 32) peak = Math.max(peak, Math.abs(data.readInt16LE(i)));
  const head = Buffer.alloc(44);
  head.write('RIFF', 0, 'latin1');
  head.writeUInt32LE(36 + size, 4);
  head.write('WAVEfmt ', 8, 'latin1');
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);
  head.writeUInt16LE(1, 22);
  head.writeUInt32LE(16000, 24);
  head.writeUInt32LE(32000, 28);
  head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34);
  head.write('data', 36, 'latin1');
  head.writeUInt32LE(size, 40);
  return { wav: Buffer.concat([head, data]), cut: all > size, silent: peak < 330 };
}

// file: a video in Hearth's uploads. Returns { text, cut }; no text when it has no sound, no speech, or this
// computer has no way to read it.
export async function videoSpeech(file) {
  if (!IS_MAC || !exists('/usr/bin/afconvert') || !(await voiceStatus()).ready) return { text: '', cut: false };
  const out = path.join(os.tmpdir(), `hearth-speech-${process.pid}-${Date.now().toString(36)}.wav`);
  try {
    await run('/usr/bin/afconvert', ['-f', 'WAVE', '-d', 'LEI16@16000', '-c', '1', file, out], { timeout: 180e3 });
    const w = fs.existsSync(out) ? trimWav(fs.readFileSync(out)) : null;
    if (!w || w.silent) return { text: '', cut: false };
    return { text: await transcribe(w.wav, { timeout: 600e3 }), cut: w.cut };
  } finally {
    fs.rmSync(out, { force: true });
  }
}

// ---- Speech in a sound file (a Telegram voice message) ----
// Telegram records voice as Opus in an Ogg file, which the voice engine can't read: it takes WAV. Hearth decodes
// that kind itself (opus.mjs). Other sound files (an .m4a voice memo, say) go through the free program ffmpeg when
// the computer has it: a copy put next to the voice engine, or the one installed on the computer.
let ffmpeg = { at: 0, path: '' };
export async function findFfmpeg() {
  if (Date.now() - ffmpeg.at < 5 * 60e3) return ffmpeg.path;
  const places = [path.join(DIRS.voice, IS_WIN ? 'ffmpeg.exe' : 'ffmpeg'), 'ffmpeg', ...(IS_WIN ? [] : ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg'])];
  let found = '';
  for (const p of places) {
    if (path.isAbsolute(p) && !exists(p)) continue;
    if (/ffmpeg version/i.test(await run(p, ['-version'], { timeout: 6000 }))) {
      found = p;
      break;
    }
  }
  ffmpeg = { at: Date.now(), path: found };
  return found;
}

// What kind of sound file this is, by its first bytes: never by the name its sender gave it. Each kind has the
// extension its temporary file gets and the one reader ffmpeg is told to use, so ffmpeg never picks a reader by
// itself (a "sound file" that is really a playlist or a script would make it open other files of this computer).
const SOUND_KINDS = {
  ogg: { ext: '.ogg', ffmpeg: 'ogg' },
  wav: { ext: '.wav', ffmpeg: 'wav' },
  flac: { ext: '.flac', ffmpeg: 'flac' },
  mp3: { ext: '.mp3', ffmpeg: 'mp3' },
  aac: { ext: '.aac', ffmpeg: 'aac' },
  mp4: { ext: '.m4a', ffmpeg: 'mov' },
  webm: { ext: '.webm', ffmpeg: 'matroska' },
  caf: { ext: '.caf', ffmpeg: 'caf' },
  aiff: { ext: '.aiff', ffmpeg: 'aiff' },
  amr: { ext: '.amr', ffmpeg: 'amr' },
};
export function soundKind(buf) {
  if (!buf || buf.length < 12) return '';
  const at = (i, n) => buf.toString('latin1', i, i + n);
  if (at(0, 4) === 'OggS') return 'ogg';
  if (at(0, 4) === 'RIFF' && at(8, 4) === 'WAVE') return 'wav';
  if (at(0, 4) === 'fLaC') return 'flac';
  if (at(4, 4) === 'ftyp') return 'mp4';
  if (buf.readUInt32BE(0) === 0x1a45dfa3) return 'webm';
  if (at(0, 4) === 'caff') return 'caf';
  if (at(0, 4) === 'FORM' && (at(8, 4) === 'AIFF' || at(8, 4) === 'AIFC')) return 'aiff';
  if (at(0, 5) === '#!AMR') return 'amr';
  if (at(0, 3) === 'ID3') return 'mp3';
  if (buf[0] === 0xff && (buf[1] & 0xf6) === 0xf0) return 'aac'; // ADTS
  if (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0 && (buf[1] & 0x06) !== 0) return 'mp3';
  return '';
}

// buf: a sound file of any usual kind. Returns it as 16 kHz mono WAV, the form the voice engine takes.
// seconds: no more sound than this is decoded (0 = no limit of its own).
export async function audioToWav(buf, name = 'sound', { seconds = 0 } = {}) {
  if (trimWav(buf) && buf.readUInt16LE(22) === 1 && buf.readUInt32LE(24) === 16000 && buf.readUInt16LE(34) === 16) return buf;
  if (isOggOpus(buf)) {
    try {
      return await oggOpusToWav(buf, seconds ? { maxSeconds: seconds + 1 } : {});
    } catch (err) {
      throw Object.assign(new Error(err.message), { code: 'BAD_SOUND' });
    }
  }
  const kind = SOUND_KINDS[soundKind(buf)];
  if (!kind) throw Object.assign(new Error('this is not a sound file Hearth knows'), { code: 'BAD_SOUND' });
  const tool = await findFfmpeg();
  const mac = !tool && IS_MAC && exists('/usr/bin/afconvert') && kind.ext !== '.ogg' && kind.ext !== '.webm';
  if (!tool && !mac) throw Object.assign(new Error('no way to read this sound here'), { code: 'NO_DECODER' });
  const base = path.join(os.tmpdir(), `hearth-sound-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
  const src = `${base}${kind.ext}`;
  const out = `${base}.out.wav`;
  try {
    fs.writeFileSync(src, buf, { mode: 0o600 });
    if (tool) await run(tool, ['-nostdin', '-loglevel', 'error', '-y', '-f', kind.ffmpeg, '-i', src, ...(seconds ? ['-t', String(seconds + 1)] : []), '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-f', 'wav', out], { timeout: 120e3 });
    else await run('/usr/bin/afconvert', ['-f', 'WAVE', '-d', 'LEI16@16000', '-c', '1', src, out], { timeout: 120e3 });
    if (!fs.existsSync(out) || fs.statSync(out).size < 100) throw Object.assign(new Error('the sound could not be read'), { code: 'BAD_SOUND' });
    return fs.readFileSync(out);
  } finally {
    fs.rmSync(src, { force: true });
    fs.rmSync(out, { force: true });
  }
}

// What is said in a sound file: { text, cut }. cut: only the first `seconds` were listened to.
export async function speechOf(buf, { name = 'voice.ogg', seconds = SPEECH_SECONDS } = {}) {
  if (!(await voiceStatus()).ready) throw Object.assign(new Error(t('The voice engine is not installed yet.')), { code: 'NO_VOICE' });
  let wav;
  try {
    wav = await audioToWav(buf, name, { seconds });
  } catch (err) {
    // No converter here, but the voice engine reads MP3 and FLAC by itself: hand the file over as it is.
    const kind = buf.toString('latin1', 0, 4);
    if (err.code !== 'NO_DECODER' || !(kind === 'fLaC' || kind.startsWith('ID3') || (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0))) throw err;
    return { text: await transcribe(buf, { timeout: 600e3 }), cut: false };
  }
  const w = trimWav(wav, seconds);
  if (!w || w.silent) return { text: '', cut: false };
  return { text: await transcribe(w.wav, { timeout: 600e3 }), cut: w.cut };
}

