// Reads the header of a GGUF model file: its name, architecture and training context length.
// Only the key/value header is read (a few MB at most); the weights are never touched.
import fs from 'node:fs';

const CHUNK = 1 << 20;
const MAX_HEADER = 128 << 20;

class Reader {
  constructor(fd) {
    this.fd = fd;
    this.buf = Buffer.alloc(0);
    this.start = 0; // file offset of buf[0]
    this.pos = 0; // absolute file offset
  }
  // Note: always call off() before touching this.buf, because off() may swap the buffer.
  need(n) {
    const end = this.pos + n;
    if (end > MAX_HEADER) throw new Error('GGUF header too large');
    const have = this.start + this.buf.length - this.pos;
    if (have >= n) return;
    // Keep what's left, read enough more for this value.
    const keep = have > 0 ? this.buf.subarray(this.pos - this.start) : Buffer.alloc(0);
    const more = Buffer.alloc(Math.max(CHUNK, n - keep.length));
    const got = fs.readSync(this.fd, more, 0, more.length, this.pos + keep.length);
    this.buf = Buffer.concat([keep, more.subarray(0, Math.max(got, 0))]);
    this.start = this.pos;
    if (this.buf.length < n) throw new Error('Unexpected end of file');
  }
  off(n) {
    this.need(n);
    const o = this.pos - this.start;
    this.pos += n;
    return o;
  }
  u8() { const o = this.off(1); return this.buf.readUInt8(o); }
  i8() { const o = this.off(1); return this.buf.readInt8(o); }
  u16() { const o = this.off(2); return this.buf.readUInt16LE(o); }
  i16() { const o = this.off(2); return this.buf.readInt16LE(o); }
  u32() { const o = this.off(4); return this.buf.readUInt32LE(o); }
  i32() { const o = this.off(4); return this.buf.readInt32LE(o); }
  f32() { const o = this.off(4); return this.buf.readFloatLE(o); }
  f64() { const o = this.off(8); return this.buf.readDoubleLE(o); }
  u64() { const o = this.off(8); return Number(this.buf.readBigUInt64LE(o)); }
  i64() { const o = this.off(8); return Number(this.buf.readBigInt64LE(o)); }
  str() {
    const len = this.u64();
    const o = this.off(len);
    return this.buf.toString('utf8', o, o + len);
  }
  skip(n) {
    this.pos += n;
  }
}

const SIZES = { 0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1, 10: 8, 11: 8, 12: 8 };

function value(r, type) {
  switch (type) {
    case 0: return r.u8();
    case 1: return r.i8();
    case 2: return r.u16();
    case 3: return r.i16();
    case 4: return r.u32();
    case 5: return r.i32();
    case 6: return r.f32();
    case 7: return r.u8() !== 0;
    case 8: return r.str();
    case 10: return r.u64();
    case 11: return r.i64();
    case 12: return r.f64();
    case 9: {
      const t = r.u32();
      const n = r.u64();
      // Big arrays (the tokenizer's vocabulary) are skipped; only short ones are kept.
      if (SIZES[t]) {
        if (n > 64) {
          r.skip(n * SIZES[t]);
          return { length: n };
        }
        return Array.from({ length: n }, () => value(r, t));
      }
      if (t === 8) {
        if (n > 64) {
          for (let i = 0; i < n; i++) r.skip(r.u64());
          return { length: n };
        }
        return Array.from({ length: n }, () => r.str());
      }
      throw new Error(`Unsupported array type ${t}`);
    }
    default:
      throw new Error(`Unknown GGUF value type ${type}`);
  }
}

export function isGguf(file) {
  try {
    const fd = fs.openSync(file, 'r');
    const b = Buffer.alloc(4);
    fs.readSync(fd, b, 0, 4, 0);
    fs.closeSync(fd);
    return b.toString('latin1') === 'GGUF';
  } catch {
    return false;
  }
}

// Reads the key/value header, and with { tensors: true } also the list of tensors and where their data starts.
export function parseHeader(fd, { tensors: wantTensors = false } = {}) {
  const r = new Reader(fd);
  const magic = Buffer.from([r.u8(), r.u8(), r.u8(), r.u8()]).toString('latin1');
  if (magic !== 'GGUF') throw new Error('Not a GGUF file');
  const version = r.u32();
  const tensorCount = r.u64();
  const kvCount = r.u64();
  const kv = {};
  for (let i = 0; i < kvCount; i++) {
    const key = r.str();
    const type = r.u32();
    kv[key] = value(r, type);
  }
  if (!wantTensors) return { version, tensorCount, kv };
  const tensors = [];
  for (let i = 0; i < tensorCount; i++) {
    const name = r.str();
    const nd = r.u32();
    for (let d = 0; d < nd; d++) r.u64();
    const type = r.u32();
    const offset = r.u64();
    tensors.push({ name, type, offset });
  }
  const align = kv['general.alignment'] || 32;
  return { version, tensorCount, kv, tensors, dataStart: Math.ceil(r.pos / align) * align };
}

export function readGgufMeta(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const { version, tensorCount, kv } = parseHeader(fd);
    const arch = kv['general.architecture'] || '';
    const g = (k) => kv[`${arch}.${k}`];
    const num = (v) => (Array.isArray(v) ? Math.max(...v) : v || 0);
    return {
      version,
      tensors: tensorCount,
      arch,
      name: kv['general.name'] || '',
      sizeLabel: kv['general.size_label'] || '',
      ctxTrain: g('context_length') || 0,
      layers: g('block_count') || 0,
      experts: g('expert_count') || 0,
      expertsUsed: g('expert_used_count') || 0,
      headKv: num(g('attention.head_count_kv')),
      heads: num(g('attention.head_count')),
      keyLength: g('attention.key_length') || 0,
      valueLength: g('attention.value_length') || 0,
      fullAttentionInterval: g('full_attention_interval') || 0,
      slidingWindow: g('attention.sliding_window') || 0,
      embedding: g('embedding_length') || 0,
      // MTP drafts: one "next words" layer that guesses ahead for the main model (guess-and-check decoding).
      nextn: g('nextn_predict_layers') || 0,
      nextnShared: Boolean(g('nextn_shared_target_tensors')),
      isProjector: arch === 'clip' || Boolean(kv['clip.has_vision_encoder']),
      // A later part of a split model (DeepSeek-V4.1's shared Engram file is part 6 of every size): not a model alone.
      splitNo: Number(kv['split.no']) || 0,
      hasChatTemplate: typeof kv['tokenizer.chat_template'] === 'string',
    };
  } finally {
    fs.closeSync(fd);
  }
}

// All parts of a split model ("-00001-of-00003.gguf" and its siblings), or just the file itself.
export function modelParts(file) {
  const m = /-(\d{5})-of-(\d{5})\.gguf$/i.exec(file);
  if (!m) return [file];
  return Array.from({ length: Number(m[2]) }, (_, i) => file.replace(/-\d{5}-of-(\d{5})\.gguf$/i, `-${String(i + 1).padStart(5, '0')}-of-$1.gguf`));
}

// Splits a model into what has to be in memory and what can stay on the SSD:
//   experts: the routed expert weights of a mixture-of-experts model (only ~10 of hundreds are used per word),
//   table:   per-layer lookup tables (like Qwen3.8-Flash-Next's 28.8 GB n-gram table), read a few rows per word,
//   dense:   everything else, needed for every word.
export function readGgufLayout(file) {
  let experts = 0;
  let table = 0;
  let total = 0;
  const expertLayers = new Set();
  for (const part of modelParts(file)) {
    const size = fs.statSync(part).size;
    const fd = fs.openSync(part, 'r');
    let h;
    try {
      h = parseHeader(fd, { tensors: true });
    } finally {
      fs.closeSync(fd);
    }
    const ts = h.tensors.sort((a, b) => a.offset - b.offset);
    ts.forEach((t, i) => {
      const end = i + 1 < ts.length ? ts[i + 1].offset : size - h.dataStart;
      const bytes = Math.max(0, end - t.offset);
      total += bytes;
      if (/ffn_(gate|up|down|gate_up)_exps/.test(t.name)) {
        experts += bytes;
        const l = /blk\.(\d+)\./.exec(t.name)?.[1];
        if (l != null) expertLayers.add(l);
      } else if (/per_layer_token_embd/.test(t.name)) table += bytes;
    });
  }
  return { total, experts, table, dense: total - experts - table, expertLayers: expertLayers.size };
}
