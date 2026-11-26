// Reading a text aloud into a sound file. Two kinds of voice: the natural one, when it has been downloaded
// (natural-voice.mjs), and the voices the system already has: `say` on a Mac, the Windows voices through a small
// PowerShell script (say.ps1). The system's voice is also what speaks when the natural one fails.
// Nothing leaves the computer. Used for the spoken answers a bot sends in Telegram.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { IS_WIN, IS_MAC, exists } from './util.mjs';
import { spokenSentences } from '../public/js/vad.js';
import { wavToOggOpus } from './opus.mjs';
import { naturalStatus, naturalWav, naturalName } from './natural-voice.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const failed = (code, message) => Object.assign(new Error(message), { code });

// The language a text should be read in: Russian when it has Cyrillic letters, otherwise English.
export const langOf = (text) => (/[а-яё]/i.test(text) ? 'ru' : 'en');

// A written answer as words to read aloud: no code, tables, link addresses or Markdown marks. '' when the answer is
// not fit for reading aloud (nothing left, or far too long to listen to).
export function speakable(markdown, maxChars = 1200) {
  const text = spokenSentences(markdown, true).join(' ').replace(/\p{Extended_Pictographic}/gu, '').replace(/\s+/g, ' ').replace(/\s+([.,!?…:;])/g, '$1').trim();
  return text.length > maxChars || text.replace(/[^\p{L}\p{N}]/gu, '').length < 2 ? '' : text;
}

function runFile(cmd, args, timeout = 120e3) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, windowsHide: true, maxBuffer: 1 << 20 }, (err, stdout, stderr) => resolve({ ok: !err, out: String(stdout || '').trim(), err: String(stderr || err?.message || '').trim() }));
  });
}

let macVoices = null;
// The Mac's voice for a language: the first one `say` lists for it (Milena for Russian, Samantha for English…).
async function macVoice(lang) {
  if (!macVoices) {
    const r = await runFile('/usr/bin/say', ['-v', '?'], 10e3);
    macVoices = r.out.split('\n').map((line) => /^(.+?)\s+([a-z]{2})_[A-Z]{2}\s+#/.exec(line)).filter(Boolean).map((m) => ({ name: m[1].trim(), lang: m[2] }));
  }
  // The everyday voices first: the list also holds novelty voices (bells, whispers) that come first by the alphabet.
  const mine = macVoices.filter((v) => v.lang === lang);
  const liked = { en: ['Samantha', 'Alex', 'Daniel', 'Karen', 'Moira', 'Tessa'], ru: ['Milena', 'Yuri'] }[lang] || [];
  for (const name of liked) {
    const hit = mine.find((v) => v.name === name || v.name.startsWith(`${name} (`));
    if (hit) return hit.name;
  }
  return mine[0]?.name || '';
}

/**
 * text: plain words. Returns { wav, voice, natural } — the speech as a WAV file, the name of the voice that read it,
 * and whether that was the natural voice.
 * voice: 'auto' (the natural voice when it is installed and switched on, else the system's; also the system's when
 * the natural one fails), 'natural' or 'system' (that one only). style: which natural voice, 1 to 10.
 * Fails with code NO_VOICE (the system has no voice for this language), NO_TTS (this computer cannot read aloud),
 * NO_NATURAL or NATURAL_FAILED (asked for the natural voice only, and it is not there or could not speak).
 */
export async function textToWav(text, lang = langOf(text), { voice = 'auto', style } = {}) {
  if (voice !== 'system') {
    const st = naturalStatus();
    if (voice === 'natural' || (st.ready && st.on)) {
      try {
        return { wav: await naturalWav(text, lang, { voice: style }), voice: naturalName(style ?? st.voice), natural: true };
      } catch (err) {
        if (voice === 'natural') throw err;
        console.error('The natural voice could not speak, the system voice takes over:', String(err.message || err));
      }
    }
  }
  return { ...(await systemWav(text, lang)), natural: false };
}

// The same with a voice of the system.
async function systemWav(text, lang) {
  const base = path.join(os.tmpdir(), `hearth-say-${process.pid}-${Date.now().toString(36)}`);
  const out = `${base}.wav`;
  const src = `${base}.txt`;
  try {
    fs.writeFileSync(src, text, 'utf8');
    let voice = '';
    if (IS_MAC && exists('/usr/bin/say')) {
      voice = await macVoice(lang);
      if (!voice) throw failed('NO_VOICE', `no ${lang} voice`);
      const r = await runFile('/usr/bin/say', ['-v', voice, '--file-format=WAVE', '--data-format=LEI16@24000', '-o', out, '-f', src]);
      if (!r.ok) throw failed('NO_TTS', r.err || 'say failed');
    } else if (IS_WIN) {
      const r = await runFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(HERE, 'say.ps1'), '-TextFile', src, '-Out', out, '-Lang', lang]);
      const line = r.out.split(/\r?\n/).filter(Boolean).pop() || '';
      if (line.startsWith('NO_VOICE')) throw failed('NO_VOICE', line.slice(9).trim());
      if (!line.startsWith('OK')) throw failed('NO_TTS', (line.replace(/^ERROR\s*/, '') || r.err || 'the Windows voice did not answer').slice(0, 300));
      voice = line.slice(3).trim();
    } else throw failed('NO_TTS', 'reading aloud is set up for Mac and Windows only');
    if (!fs.existsSync(out) || fs.statSync(out).size < 200) throw failed('NO_TTS', 'the voice made no sound');
    return { wav: fs.readFileSync(out), voice };
  } finally {
    fs.rmSync(src, { force: true });
    fs.rmSync(out, { force: true });
  }
}

// ---- A spoken answer as a file Telegram shows as a voice message ----
// Telegram shows voice as a voice message only when it is Opus sound in an Ogg file. The system's voice gives WAV,
// so the speech is packed by Hearth itself (opus.mjs), the same way on every system.
export async function packVoice(wav) {
  try {
    const { ogg, seconds } = await wavToOggOpus(wav);
    return { data: ogg, name: 'answer.ogg', mime: 'audio/ogg', seconds: Math.max(1, Math.round(seconds)) };
  } catch (err) {
    throw failed('NO_ENCODER', String(err.message || err));
  }
}

// markdown: a written answer. Returns { data, name, mime, seconds, voice, natural, text } — it as a voice message —
// or null when the answer is not fit for reading aloud. opts: { voice, style } as for textToWav.
export async function voiceAnswer(markdown, opts = {}) {
  const text = speakable(markdown);
  if (!text) return null;
  const { wav, voice, natural } = await textToWav(text, langOf(text), opts);
  return { ...(await packVoice(wav)), voice, natural, text };
}

