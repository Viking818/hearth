// Voice in the page: record the microphone as a small WAV file for the speech engine, and read answers aloud
// with the voices the system already has (no download, works offline on Mac and Windows).
import { getLang } from './i18n.js';
import { getState } from './store.js';

export const canRecord = () => Boolean(window.isSecureContext && navigator.mediaDevices?.getUserMedia && (window.AudioContext || window.webkitAudioContext));

// Returns { stop(): Promise<Blob>, cancel(), level(): 0..1, seconds() }.
export async function startRecording() {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  const Ctx = window.AudioContext || window.webkitAudioContext;
  const ctx = new Ctx();
  const src = ctx.createMediaStreamSource(stream);
  const node = ctx.createScriptProcessor(4096, 1, 1);
  const chunks = [];
  let level = 0;
  const started = Date.now();
  node.onaudioprocess = (e) => {
    const data = e.inputBuffer.getChannelData(0);
    chunks.push(new Float32Array(data));
    let peak = 0;
    for (let i = 0; i < data.length; i += 16) peak = Math.max(peak, Math.abs(data[i]));
    level = level * 0.6 + peak * 0.4;
  };
  src.connect(node);
  node.connect(ctx.destination);
  const close = () => {
    node.disconnect();
    src.disconnect();
    stream.getTracks().forEach((tr) => tr.stop());
    ctx.close().catch(() => {});
  };
  return {
    level: () => Math.min(1, level * 2.5),
    seconds: () => (Date.now() - started) / 1000,
    cancel: close,
    async stop() {
      close();
      const length = chunks.reduce((a, c) => a + c.length, 0);
      const all = new Float32Array(length);
      let off = 0;
      for (const c of chunks) {
        all.set(c, off);
        off += c.length;
      }
      return encodeWav(resample(all, ctx.sampleRate, 16000), 16000);
    },
  };
}

export function resample(data, from, to) {
  if (from === to) return data;
  const ratio = from / to;
  const out = new Float32Array(Math.floor(data.length / ratio));
  for (let i = 0; i < out.length; i++) {
    // Average the samples that fall into each new one (a simple low-pass that avoids hiss).
    const a = Math.floor(i * ratio);
    const b = Math.min(data.length, Math.floor((i + 1) * ratio));
    let s = 0;
    for (let j = a; j < b; j++) s += data[j];
    out[i] = b > a ? s / (b - a) : data[a] || 0;
  }
  return out;
}

export function encodeWav(samples, rate) {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const str = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF');
  v.setUint32(4, 36 + samples.length * 2, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, 'data');
  v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, samples[i])) * 0x7fff, true);
  return new Blob([buf], { type: 'audio/wav' });
}

// ---- Reading aloud ----

export const canSpeak = () => 'speechSynthesis' in window;

export function voicesFor(lang) {
  const all = window.speechSynthesis?.getVoices() || [];
  return all.filter((v) => v.lang.toLowerCase().startsWith(lang));
}

// Plain sentences from Markdown: no code, no link addresses, no symbols read out loud.
export function speakableText(md) {
  return String(md || '')
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\|.*\|\s*$/gm, ' ')
    .replace(/[*_~>#|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

let speakingId = '';
export function speakingNow() {
  return speakingId;
}

export function stopSpeaking() {
  speakingId = '';
  window.speechSynthesis?.cancel();
}

// Long answers are read sentence by sentence: some browsers stop a single long utterance after a while.
export function speak(id, markdown, onEnd) {
  stopSpeaking();
  const text = speakableText(markdown);
  if (!text) return;
  const lang = /[а-яё]/i.test(text) ? 'ru' : getLang() === 'ru' && !/[a-z]{4}/i.test(text) ? 'ru' : 'en';
  const wanted = getState().status?.settings?.ttsVoice;
  const all = window.speechSynthesis.getVoices();
  const voice = all.find((v) => v.name === wanted && v.lang.toLowerCase().startsWith(lang)) || voicesFor(lang).find((v) => v.default) || voicesFor(lang)[0] || null;
  const parts = text.match(/[^.!?…]+[.!?…]*\s*/g) || [text];
  speakingId = id;
  parts.forEach((p, i) => {
    const u = new SpeechSynthesisUtterance(p.trim());
    if (voice) u.voice = voice;
    u.lang = voice?.lang || (lang === 'ru' ? 'ru-RU' : 'en-US');
    if (i === parts.length - 1)
      u.onend = () => {
        if (speakingId === id) speakingId = '';
        onEnd?.();
      };
    window.speechSynthesis.speak(u);
  });
}
