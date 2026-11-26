// Voice messages in Telegram are Opus sound in an Ogg file. The voice engine reads neither, and the voices of the
// system write neither. This file goes both ways: it takes a voice message apart into plain WAV (16 kHz, one
// channel) for the voice engine, and it packs speech made by the system's voice into a voice message.
// The Ogg file is read and written here; the Opus sound itself is decoded and encoded by libopus, which is included
// as WebAssembly (server/vendor/opusscript; see the README in server/vendor).
import { createRequire } from 'node:module';

const RATE = 16000; // what the voice engine takes
const SEND_RATE = 24000; // what a spoken answer is sent with: clear speech, small files
const PRE_SKIP = 312; // samples (at 48 kHz) a player drops at the start: the encoder's run-in

let OpusScript = null;
function lib() {
  OpusScript ||= createRequire(import.meta.url)('./vendor/opusscript/index.js');
  return OpusScript;
}

export const isOggOpus = (buf) => buf.length > 47 && buf.toString('latin1', 0, 4) === 'OggS' && buf.subarray(0, 300).includes('OpusHead');

// The packets of an Ogg file, in order. A packet may run over several pages; a page lists its pieces by length, and a
// piece of 255 bytes means "goes on".
export function oggPackets(buf) {
  const out = [];
  let parts = [];
  let at = 0;
  while (at + 27 <= buf.length) {
    if (buf.toString('latin1', at, at + 4) !== 'OggS') throw new Error('not an Ogg file');
    const count = buf[at + 26];
    const sizes = at + 27;
    let data = sizes + count;
    if (data > buf.length) break;
    for (let i = 0; i < count; i++) {
      const len = buf[sizes + i];
      if (data + len > buf.length) return out; // cut off: keep what is whole
      parts.push(buf.subarray(data, data + len));
      data += len;
      if (len < 255) {
        out.push(parts.length === 1 ? parts[0] : Buffer.concat(parts));
        parts = [];
      }
    }
    at = data;
  }
  return out;
}

// What the "OpusHead" packet says about the recording.
export function opusHead(packet) {
  if (!packet || packet.length < 19 || packet.toString('latin1', 0, 8) !== 'OpusHead') throw new Error('not an Opus recording');
  const head = { channels: packet[9], preSkip: packet.readUInt16LE(10), mapping: packet[18] };
  if (head.channels < 1 || head.channels > 2 || head.mapping !== 0) throw new Error('this kind of Opus recording is not supported (more than two channels)');
  return head;
}

// 16-bit samples (an Int16Array, or numbers from -1 to 1) as a WAV file with one channel.
export function wav16(pcm, rate = RATE) {
  const ints = pcm instanceof Int16Array;
  const data = Buffer.alloc(pcm.length * 2);
  for (let i = 0; i < pcm.length; i++) data.writeInt16LE(ints ? pcm[i] : Math.max(-32768, Math.min(32767, Math.round(pcm[i] * 32767))), i * 2);
  const head = Buffer.alloc(44);
  head.write('RIFF', 0, 'latin1');
  head.writeUInt32LE(36 + data.length, 4);
  head.write('WAVEfmt ', 8, 'latin1');
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);
  head.writeUInt16LE(1, 22);
  head.writeUInt32LE(rate, 24);
  head.writeUInt32LE(rate * 2, 28);
  head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34);
  head.write('data', 36, 'latin1');
  head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}

// buf: an Ogg Opus recording (a Telegram voice message). Returns it as 16 kHz mono WAV.
// maxSeconds: no more than this much sound is decoded, however long the file says or is. The length a sender
// declares proves nothing, and a packet of one byte stands for up to 60 ms of sound, so a small file can hold hours:
// decoding stops at the limit, and the rest of Hearth gets its turn every few hundred packets.
export async function oggOpusToWav(buf, { maxSeconds = 3600 } = {}) {
  const packets = oggPackets(buf);
  const head = opusHead(packets[0]);
  const frames = packets.slice(2).filter((p) => p.length); // after "OpusHead" and "OpusTags"
  if (!frames.length) throw new Error('the recording is empty');
  const dec = new (lib())(RATE, head.channels);
  try {
    const parts = [];
    let total = 0;
    const limit = Math.max(1, Math.ceil(maxSeconds * RATE) + Math.round((head.preSkip * RATE) / 48000));
    let count = 0;
    for (const p of frames) {
      if (total >= limit) break;
      if (++count % 400 === 0) await new Promise((r) => setImmediate(r));
      const pcm = dec.decode(p); // 16-bit samples, left and right in turn when there are two channels
      const n = pcm.length / 2 / head.channels;
      const mono = new Int16Array(n);
      for (let i = 0; i < n; i++) mono[i] = head.channels === 2 ? (pcm.readInt16LE(i * 4) + pcm.readInt16LE(i * 4 + 2)) >> 1 : pcm.readInt16LE(i * 2);
      parts.push(mono);
      total += n;
    }
    const skip = Math.min(total, Math.round((head.preSkip * RATE) / 48000));
    const all = new Int16Array(total - skip);
    let at = -skip;
    for (const m of parts) {
      for (let i = 0; i < m.length; i++, at++) if (at >= 0) all[at] = m[i];
    }
    if (!all.length) throw new Error('the recording could not be decoded');
    return wav16(all, RATE);
  } finally {
    dec.delete();
  }
}

// ---- Writing a voice message ----

// The checksum every Ogg page carries.
const CRC = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let r = i << 24;
    for (let k = 0; k < 8; k++) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1;
    table[i] = r >>> 0;
  }
  return (buf) => {
    let c = 0;
    for (let i = 0; i < buf.length; i++) c = ((c << 8) ^ table[((c >>> 24) ^ buf[i]) & 0xff]) >>> 0;
    return c;
  };
})();

// One Ogg page holding whole packets. flags: 2 for the first page of the file, 4 for the last.
export function oggPage(packets, { serial, seq, granule, flags = 0 }) {
  const sizes = [];
  for (const p of packets) {
    let left = p.length;
    while (left >= 255) {
      sizes.push(255);
      left -= 255;
    }
    sizes.push(left);
  }
  const head = Buffer.alloc(27 + sizes.length);
  head.write('OggS', 0, 'latin1');
  head[5] = flags;
  head.writeBigUInt64LE(BigInt(granule), 6);
  head.writeUInt32LE(serial, 14);
  head.writeUInt32LE(seq, 18);
  head[26] = sizes.length;
  Buffer.from(sizes).copy(head, 27);
  const page = Buffer.concat([head, ...packets]);
  page.writeUInt32LE(CRC(page), 22);
  return page;
}

// Takes out of 16-bit samples what a lower rate cannot carry (everything above a little under half of it). Without
// this, the high part of a 44.1 kHz voice would come back as a hiss when the rate goes down to 24 kHz.
function lowpass(pcm, from, to) {
  const taps = 63;
  const mid = (taps - 1) / 2;
  const fc = (0.46 * to) / from; // the cut-off, as a part of the rate the samples have now
  const h = new Float64Array(taps);
  let sum = 0;
  for (let i = 0; i < taps; i++) {
    const x = i - mid;
    const sinc = x === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * x) / (Math.PI * x);
    h[i] = sinc * (0.42 - 0.5 * Math.cos((2 * Math.PI * i) / (taps - 1)) + 0.08 * Math.cos((4 * Math.PI * i) / (taps - 1)));
    sum += h[i];
  }
  for (let i = 0; i < taps; i++) h[i] /= sum;
  const out = new Int16Array(pcm.length);
  for (let n = 0; n < pcm.length; n++) {
    let acc = 0;
    const lo = Math.max(0, mid - n);
    const hi = Math.min(taps, pcm.length - n + mid);
    for (let k = lo; k < hi; k++) acc += pcm[n + k - mid] * h[k];
    out[n] = Math.max(-32768, Math.min(32767, Math.round(acc)));
  }
  return out;
}

// A different rate for 16-bit samples (straight lines between samples: fine for speech). On the way down the
// sound is filtered first.
export function resample16(pcm, from, to) {
  if (from === to) return pcm;
  if (to < from) pcm = lowpass(pcm, from, to);
  const out = new Int16Array(Math.floor((pcm.length * to) / from));
  const step = from / to;
  for (let i = 0; i < out.length; i++) {
    const x = i * step;
    const a = Math.floor(x);
    const b = Math.min(pcm.length - 1, a + 1);
    out[i] = Math.round(pcm[a] + (pcm[b] - pcm[a]) * (x - a));
  }
  return out;
}

// The samples of a WAV file as one channel of 16-bit numbers, and its rate. Takes the plain kinds (8 or 16 bits).
export function wavSamples(buf) {
  if (buf.length < 44 || buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WAVE') throw new Error('not a WAV file');
  let at = 12;
  let fmt = null;
  while (at + 8 <= buf.length) {
    const id = buf.toString('latin1', at, at + 4);
    const size = buf.readUInt32LE(at + 4);
    if (id === 'fmt ') fmt = { kind: buf.readUInt16LE(at + 8), channels: buf.readUInt16LE(at + 10), rate: buf.readUInt32LE(at + 12), bits: buf.readUInt16LE(at + 22) };
    if (id === 'data') {
      if (!fmt || (fmt.kind !== 1 && fmt.kind !== 0xfffe) || ![8, 16].includes(fmt.bits) || fmt.channels < 1) throw new Error('this kind of WAV file is not supported');
      // Some programs write a size of zero or of four gigabytes when they stream: then the sound runs to the end.
      const end = size && at + 8 + size <= buf.length ? at + 8 + size : buf.length;
      const width = (fmt.bits / 8) * fmt.channels;
      const n = Math.floor((end - at - 8) / width);
      const pcm = new Int16Array(n);
      for (let i = 0; i < n; i++) {
        let sum = 0;
        for (let c = 0; c < fmt.channels; c++) {
          const p = at + 8 + i * width + c * (fmt.bits / 8);
          sum += fmt.bits === 16 ? buf.readInt16LE(p) : (buf[p] - 128) << 8;
        }
        pcm[i] = Math.round(sum / fmt.channels);
      }
      return { pcm, rate: fmt.rate };
    }
    at += 8 + size + (size % 2);
  }
  throw new Error('the WAV file has no sound in it');
}

// wav: speech as a WAV file. Returns { ogg, seconds }: a Telegram voice message.
export async function wavToOggOpus(wav) {
  const src = wavSamples(wav);
  const pcm = resample16(src.pcm, src.rate, SEND_RATE);
  if (pcm.length < SEND_RATE / 10) throw new Error('the speech is too short');
  const frame = SEND_RATE / 50; // 20 ms
  const Opus = lib();
  const enc = new Opus(SEND_RATE, 1, Opus.Application.VOIP);
  try {
    enc.setBitrate(28000);
    const serial = (Math.random() * 0xffffffff) >>> 0;
    const head = Buffer.alloc(19);
    head.write('OpusHead', 0, 'latin1');
    head[8] = 1;
    head[9] = 1;
    head.writeUInt16LE(PRE_SKIP, 10);
    head.writeUInt32LE(SEND_RATE, 12);
    const tags = Buffer.concat([Buffer.from('OpusTags'), Buffer.from([6, 0, 0, 0]), Buffer.from('Hearth'), Buffer.alloc(4)]);
    const pages = [oggPage([head], { serial, seq: 0, granule: 0, flags: 2 }), oggPage([tags], { serial, seq: 1, granule: 0 })];
    const count = Math.ceil(pcm.length / frame);
    let batch = [];
    let seq = 2;
    for (let i = 0; i < count; i++) {
      const piece = Buffer.alloc(frame * 2); // the last piece is filled up with silence
      for (let k = 0; k < frame && i * frame + k < pcm.length; k++) piece.writeInt16LE(pcm[i * frame + k], k * 2);
      batch.push(enc.encode(piece, frame));
      const last = i === count - 1;
      if (batch.length === 50 || last) {
        // Where the sound stands after this page, counted at 48 kHz; the last page says where it really ends.
        const granule = last ? PRE_SKIP + Math.round((pcm.length * 48000) / SEND_RATE) : (i + 1) * 960;
        pages.push(oggPage(batch, { serial, seq: seq++, granule, flags: last ? 4 : 0 }));
        batch = [];
      }
    }
    return { ogg: Buffer.concat(pages), seconds: pcm.length / SEND_RATE };
  } finally {
    enc.delete();
  }
}
