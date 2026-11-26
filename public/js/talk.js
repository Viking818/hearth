// A conversation by voice: Hearth listens, notices when you have finished speaking, sends what it heard to the
// chat, reads the answer aloud while it is being written, and then listens again. Everything said and answered is in
// the chat as usual. Speech is turned into text on this computer (the same voice engine as the microphone button);
// the answers are read by the voices the system already has.
import { html, useState, useEffect, useRef } from '../vendor/preact-htm.js';
import { Icon } from './icons.js';
import { t, getLang } from './i18n.js';
import { api, getState, toast } from './store.js';
import { confirmDialog } from './ui.js';
import { canRecord, canSpeak, voicesFor, resample, encodeWav } from './voice.js';
import { createVad, spokenSentences } from './vad.js';

export const canTalk = () => canRecord();

// The microphone, left open for the whole conversation. onFrame gets each short piece of sound and its loudness.
async function openMic(onFrame) {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  const Ctx = window.AudioContext || window.webkitAudioContext;
  const ctx = new Ctx();
  if (ctx.state === 'suspended') await ctx.resume().catch(() => {});
  const src = ctx.createMediaStreamSource(stream);
  const node = ctx.createScriptProcessor(2048, 1, 1);
  node.onaudioprocess = (e) => {
    const data = e.inputBuffer.getChannelData(0);
    let sum = 0;
    for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
    onFrame(new Float32Array(data), Math.sqrt(sum / data.length), (data.length / ctx.sampleRate) * 1000);
  };
  src.connect(node);
  node.connect(ctx.destination);
  return {
    rate: ctx.sampleRate,
    close() {
      node.onaudioprocess = null;
      node.disconnect();
      src.disconnect();
      stream.getTracks().forEach((tr) => tr.stop());
      ctx.close().catch(() => {});
    },
  };
}

// Reads sentences aloud one after another. onIdle is called each time it has nothing left to read.
function createSpeaker(onIdle) {
  const synth = canSpeak() ? window.speechSynthesis : null;
  let queue = [];
  let now = null; // { timer }
  let stopped = false;
  const pickVoice = (text) => {
    const lang = /[а-яё]/i.test(text) ? 'ru' : getLang() === 'ru' && !/[a-z]{4}/i.test(text) ? 'ru' : 'en';
    const wanted = getState().status?.settings?.ttsVoice;
    const voice = (synth.getVoices() || []).find((v) => v.name === wanted && v.lang.toLowerCase().startsWith(lang)) || voicesFor(lang).find((v) => v.default) || voicesFor(lang)[0] || null;
    return { voice, lang: voice?.lang || (lang === 'ru' ? 'ru-RU' : 'en-US') };
  };
  const next = () => {
    if (stopped || now) return;
    const text = queue.shift();
    if (text === undefined) return onIdle();
    if (!synth) return next(); // nothing can read aloud here: the answer stays on screen
    const u = new SpeechSynthesisUtterance(text);
    const v = pickVoice(text);
    if (v.voice) u.voice = v.voice;
    u.lang = v.lang;
    const done = () => {
      if (now?.u !== u) return;
      clearTimeout(now.timer);
      now = null;
      next();
    };
    u.onend = done;
    u.onerror = done;
    // Some browsers never say that a sentence has ended: go on after the time it should take, plus a margin.
    now = { u, timer: setTimeout(done, 4000 + text.length * 110) };
    synth.speak(u);
  };
  return {
    busy: () => Boolean(now) || queue.length > 0,
    say(text) {
      if (stopped) return;
      queue.push(text);
      next();
    },
    // The first words must start from the click that opened the conversation, or some browsers stay silent later.
    unlock() {
      try {
        synth?.speak(new SpeechSynthesisUtterance(' '));
      } catch {}
    },
    hush() {
      queue = [];
      if (now) clearTimeout(now.timer);
      now = null;
      synth?.cancel();
    },
    close() {
      stopped = true;
      this.hush();
    },
  };
}

/**
 * answer: { id, text, streaming } — the newest answer in the chat. onSay(text) sends what was heard; onStop() stops
 * an answer that is being written.
 */
export function TalkPanel({ answer, onSay, onStop, onClose }) {
  const [state, setState] = useState('starting'); // starting | listening | hearing | recognising | answering | speaking | muted
  const [level, setLevel] = useState(0);
  const [heard, setHeard] = useState('');
  const [muted, setMuted] = useState(false);
  const live = useRef({ state: 'starting', mic: null, vad: createVad(), frames: [], pre: [], speaker: null, said: 0, answerId: '', waitingFor: '', muted: false, closed: false });
  const L = live.current;
  const go = (s) => {
    L.state = s;
    setState(s);
  };
  const listen = () => {
    if (L.closed) return;
    L.vad.reset();
    L.frames = [];
    go(L.muted ? 'muted' : 'listening');
  };

  // What the microphone hears, piece by piece.
  const onFrame = (data, rms, ms) => {
    if (L.closed) return;
    if (L.state !== 'listening' && L.state !== 'hearing') return; // not while Hearth itself is speaking or thinking
    setLevel((v) => v * 0.6 + Math.min(1, rms * 9) * 0.4);
    const ev = L.vad.push(rms, ms);
    if (L.state === 'listening') {
      L.pre.push(data);
      if (L.pre.length > 6) L.pre.shift(); // a moment of sound from before the first word, so it is not clipped
      if (ev === 'start') {
        L.frames = L.pre.slice();
        L.pre = [];
        go('hearing');
      }
      return;
    }
    L.frames.push(data);
    if (ev === 'drop') return listen();
    if (ev === 'end') recognise();
  };

  const recognise = async () => {
    const frames = L.frames;
    L.frames = [];
    go('recognising');
    try {
      const all = new Float32Array(frames.reduce((n, f) => n + f.length, 0));
      let at = 0;
      for (const f of frames) {
        all.set(f, at);
        at += f.length;
      }
      const wav = encodeWav(resample(all, L.mic.rate, 16000), 16000);
      const { text } = await api('/api/voice/transcribe?lang=auto', { method: 'POST', raw: wav, headers: { 'content-type': 'audio/wav' } });
      if (L.closed) return;
      const said = String(text || '').trim();
      if (said.replace(/[^\p{L}\p{N}]/gu, '').length < 2) return listen(); // a noise, not words
      setHeard(said);
      L.waitingFor = L.answerId; // the answer that follows is the one after this
      L.said = 0;
      go('answering');
      onSay(said);
    } catch (err) {
      if (L.closed) return;
      toast(String(err.message || err), 'bad');
      listen();
    }
  };

  // Open the microphone once; close everything when the conversation ends.
  useEffect(() => {
    let off = false;
    L.speaker = createSpeaker(() => {
      if (L.state === 'speaking' && L.answerDone) listen();
    });
    L.speaker.unlock();
    (async () => {
      try {
        const st = await api('/api/voice');
        if (!st.ready) {
          if (await confirmDialog({ title: t('Voice input needs a one-time setup'), text: t('A conversation by voice uses the same voice input as the microphone button. Download it in Settings → Voice, then start the conversation again.'), ok: t('Open Settings') })) location.hash = '#/settings/voice';
          return onClose();
        }
        const mic = await openMic(onFrame);
        if (off) return mic.close();
        L.mic = mic;
        listen();
      } catch (err) {
        toast(err?.name === 'NotAllowedError' ? t('Hearth may not use the microphone. Allow it in the browser or in System Settings → Privacy → Microphone.') : String(err.message || err), 'bad');
        onClose();
      }
    })();
    return () => {
      off = true;
      L.closed = true;
      L.mic?.close();
      L.speaker?.close();
    };
  }, []);

  // The answer as it grows: read each sentence as soon as it is whole; when all is read, listen again.
  useEffect(() => {
    L.answerId = answer?.id || '';
    if (L.state !== 'answering' && L.state !== 'speaking') return;
    if (!answer?.id || answer.id === L.waitingFor) return; // still the answer from before
    const done = !answer.streaming;
    const list = spokenSentences(answer.text, done);
    for (const s of list.slice(L.said)) L.speaker.say(s);
    if (list.length > L.said && L.state === 'answering') go('speaking');
    L.said = Math.max(L.said, list.length);
    L.answerDone = done;
    if (done && !L.speaker.busy()) listen();
  }, [answer?.id, answer?.text, answer?.streaming]);

  const interrupt = () => {
    L.speaker.hush();
    if (answer?.streaming) onStop();
    L.answerDone = true;
    listen();
  };
  const mute = () => {
    L.muted = !L.muted;
    setMuted(L.muted);
    if (L.state === 'listening' || L.state === 'hearing' || L.state === 'muted') listen();
  };

  const label = {
    starting: t('Getting the microphone ready…'),
    listening: t('Listening… just speak'),
    hearing: t('I hear you…'),
    recognising: t('Turning speech into text…'),
    answering: t('Thinking…'),
    speaking: t('Answering…'),
    muted: t('The microphone is off'),
  }[state];
  const size = state === 'hearing' || state === 'listening' ? 1 + level * 0.55 : 1;
  const busy = state === 'answering' || state === 'speaking';
  return html`<div class=${`talk-bar ${state}`} role="status">
    <div class="talk-orb" style=${{ transform: `scale(${size.toFixed(3)})` }}><${Icon} name=${state === 'muted' ? 'mic-off' : busy ? 'audio-lines' : 'mic'} /></div>
    <div class="talk-text">
      <b>${label}</b>
      <span class="ellipsis">${heard ? `${t('You said:')} ${heard}` : t('Speak as you would to a person. Hearth answers aloud and then listens again.')}</span>
    </div>
    ${busy && html`<button class="btn sm" onClick=${interrupt} title=${t('Stops this answer and listens to you again')}><${Icon} name="square" size="sm" /> ${t('Interrupt')}</button>`}
    <button class=${`icon-btn ${muted ? 'on' : ''}`} onClick=${mute} title=${muted ? t('Turn the microphone on') : t('Turn the microphone off for a moment')}><${Icon} name=${muted ? 'mic-off' : 'mic'} size="sm" /></button>
    <button class="btn sm primary" onClick=${onClose}>${t('End conversation')}</button>
  </div>`;
}
