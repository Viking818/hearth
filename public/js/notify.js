// A sound when an answer is ready, and a notification when Hearth is in the background and an answer is ready or
// a tool waits for an OK. Both are off until turned on in Settings → Chat, and both are kept per browser.
import { readPref, writePref } from './store.js';

export const notifyPrefs = () => ({ sound: readPref('hearth.doneSound', false), notify: readPref('hearth.notify', false) });
export const setNotifyPref = (key, on) => writePref(key === 'sound' ? 'hearth.doneSound' : 'hearth.notify', Boolean(on));

// The Mac app's window has no notifications; browsers do.
export const canNotify = () => typeof Notification !== 'undefined';
export const notifyAllowed = () => canNotify() && Notification.permission === 'granted';
export async function askToNotify() {
  if (!canNotify()) return false;
  if (Notification.permission === 'granted') return true;
  if (Notification.permission === 'denied') return false;
  try {
    return (await Notification.requestPermission()) === 'granted';
  } catch {
    return false;
  }
}

const away = () => document.hidden || !document.hasFocus();

let audio = null;
// Two soft notes: rising when an answer is ready, the same note twice when Hearth needs the user.
export function chime(kind = 'done') {
  try {
    audio ||= new (window.AudioContext || window.webkitAudioContext)();
    if (audio.state === 'suspended') audio.resume();
    const notes = kind === 'ask' ? [660, 660] : [587, 880];
    notes.forEach((hz, i) => {
      const at = audio.currentTime + i * 0.16;
      const osc = audio.createOscillator();
      const gain = audio.createGain();
      osc.type = 'sine';
      osc.frequency.value = hz;
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(0.16, at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.34);
      osc.connect(gain).connect(audio.destination);
      osc.start(at);
      osc.stop(at + 0.36);
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * kind 'done': an answer is ready (took: how long it was written, ms). kind 'ask': Hearth waits for the user.
 * The sound plays for a long answer or when the user is elsewhere; the notification only when they are elsewhere.
 */
export function announce(kind, { title, body = '', took = 0 } = {}) {
  const p = notifyPrefs();
  const out = { sound: false, shown: false };
  if (p.sound && (kind === 'ask' || away() || took >= 10000)) out.sound = chime(kind);
  if (p.notify && away() && notifyAllowed()) {
    try {
      const n = new Notification(title || 'Hearth', { body: String(body).slice(0, 180), tag: `hearth-${kind}`, icon: '/logo.svg' });
      n.onclick = () => {
        window.focus();
        n.close();
      };
      out.shown = true;
    } catch {}
  }
  return out;
}
