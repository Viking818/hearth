// Takes apart the WebM videos the video engine writes. Their sound is plain uncompressed PCM, which Chrome plays but
// Safari and the Mac app refuse (and with it the whole file). So Hearth keeps two more files for playing: the picture
// alone as a WebM, and the sound as a WAV. The page plays them together. Nothing is re-encoded: the video frames and
// the sound samples are copied as they are. No dependencies.

const ID = {
  EBML: 0x1a45dfa3,
  Segment: 0x18538067,
  Info: 0x1549a966,
  Tracks: 0x1654ae6b,
  TrackEntry: 0xae,
  TrackNumber: 0xd7,
  TrackType: 0x83,
  CodecID: 0x86,
  Audio: 0xe1,
  SamplingFrequency: 0xb5,
  Channels: 0x9f,
  BitDepth: 0x6264,
  Cluster: 0x1f43b675,
  Timecode: 0xe7,
  SimpleBlock: 0xa3,
  BlockGroup: 0xa0,
  Block: 0xa1,
  Cues: 0x1c53bb6b,
  CuePoint: 0xbb,
  CueTime: 0xb3,
  CueTrackPositions: 0xb7,
  CueTrack: 0xf7,
  CueClusterPosition: 0xf1,
};
// What may sit inside a cluster: a cluster of unknown size ends at the first thing that is not one of these.
const IN_CLUSTER = new Set([ID.Timecode, ID.SimpleBlock, ID.BlockGroup, 0xa7, 0xab, 0xec, 0xbf]);
// What may sit directly in the segment: a segment or cluster of unknown size is read up to the next one of these.
const TOP = new Set([ID.Info, ID.Tracks, ID.Cluster, ID.Cues, 0x114d9b74, 0x1254c367, 0x1043a770, 0x1941a469, 0xec, 0xbf]);

class Bad extends Error {}

// An element's header at `at`: its id (with the length bits kept, as in the table above), where its data starts and
// how long it is (-1: unknown, it runs until something of the level above starts).
function header(buf, at) {
  if (at >= buf.length) throw new Bad('end');
  let len = 1;
  while (len <= 4 && !(buf[at] & (0x80 >> (len - 1)))) len++;
  if (len > 4 || at + len > buf.length) throw new Bad('id');
  let id = 0;
  for (let i = 0; i < len; i++) id = id * 256 + buf[at + i];
  const s = at + len;
  if (s >= buf.length) throw new Bad('size');
  let n = 1;
  while (n <= 8 && !(buf[s] & (0x80 >> (n - 1)))) n++;
  if (n > 8 || s + n > buf.length) throw new Bad('size');
  let size = buf[s] & (0xff >> n);
  let ones = size === 0xff >> n;
  for (let i = 1; i < n; i++) {
    ones = ones && buf[s + i] === 0xff;
    size = size * 256 + buf[s + i];
  }
  return { id, data: s + n, size: ones ? -1 : size };
}

// The elements between `from` and `to`, one level deep.
function* children(buf, from, to, stopAt) {
  let at = from;
  while (at < to) {
    const h = header(buf, at);
    if (stopAt && !stopAt.has(h.id)) return;
    let end = h.size < 0 ? to : h.data + h.size;
    if (h.size < 0 && h.id === ID.Cluster) {
      // Unknown size: the cluster ends where its own kind of element stops.
      end = h.data;
      for (const c of children(buf, h.data, to, IN_CLUSTER)) end = c.end;
    }
    if (end > to) throw new Bad('overrun');
    yield { id: h.id, start: at, data: h.data, end };
    at = end;
  }
}

const uint = (buf, a, b) => {
  let v = 0;
  for (let i = a; i < b; i++) v = v * 256 + buf[i];
  return v;
};

function idBytes(id) {
  const out = [];
  for (let v = id; v > 0; v = Math.floor(v / 256)) out.unshift(v % 256);
  return Buffer.from(out);
}

// Sizes are always written in 8 bytes: simple, and every element's length is known before its content is.
function sizeBytes(n) {
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(BigInt(n));
  b[0] = 0x01;
  return b;
}

const el = (id, ...parts) => {
  const body = Buffer.concat(parts);
  return Buffer.concat([idBytes(id), sizeBytes(body.length), body]);
};
const u64 = (n) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(BigInt(n));
  return b;
};

// A block's track number and where its frame data starts.
function blockHead(buf, at, end) {
  let n = 1;
  while (n <= 8 && !(buf[at] & (0x80 >> (n - 1)))) n++;
  if (n > 4 || at + n + 3 > end) throw new Bad('block');
  let track = buf[at] & (0xff >> n);
  for (let i = 1; i < n; i++) track = track * 256 + buf[at + i];
  return { track, flags: buf[at + n + 2], body: at + n + 3 };
}

/**
 * buf: a WebM file. Returns { video, wav } — the picture alone as a WebM (with an index, so jumping around works) and
 * the sound as a WAV (null when there is none, or it is not plain PCM) — or null when the file can't be taken apart.
 */
export function splitWebm(buf) {
  try {
    const top = [...children(buf, 0, buf.length)];
    const ebml = top.find((e) => e.id === ID.EBML);
    const seg = top.find((e) => e.id === ID.Segment);
    if (!ebml || !seg) return null;
    const parts = [...children(buf, seg.data, seg.end, TOP)];
    const info = parts.find((e) => e.id === ID.Info);
    const tracks = parts.find((e) => e.id === ID.Tracks);
    if (!info || !tracks) return null;

    let video = null;
    let audio = null;
    for (const te of children(buf, tracks.data, tracks.end)) {
      if (te.id !== ID.TrackEntry) continue;
      const tr = { raw: buf.subarray(te.start, te.end), number: 0, type: 0, codec: '', rate: 0, channels: 1, bits: 16 };
      for (const f of children(buf, te.data, te.end)) {
        if (f.id === ID.TrackNumber) tr.number = uint(buf, f.data, f.end);
        else if (f.id === ID.TrackType) tr.type = uint(buf, f.data, f.end);
        else if (f.id === ID.CodecID) tr.codec = buf.toString('latin1', f.data, f.end).replace(/\0+$/, '');
        else if (f.id === ID.Audio) {
          for (const a of children(buf, f.data, f.end)) {
            if (a.id === ID.SamplingFrequency) tr.rate = a.end - a.data === 4 ? buf.readFloatBE(a.data) : buf.readDoubleBE(a.data);
            else if (a.id === ID.Channels) tr.channels = uint(buf, a.data, a.end);
            else if (a.id === ID.BitDepth) tr.bits = uint(buf, a.data, a.end);
          }
        }
      }
      if (tr.type === 1 && !video) video = tr;
      else if (tr.type === 2 && !audio) audio = tr;
    }
    if (!video) return null;
    const pcm = audio && audio.codec === 'A_PCM/INT/LIT' && audio.rate > 0 && audio.channels > 0 && [8, 16, 24, 32].includes(audio.bits);

    const clusters = []; // { time, key, body: Buffer[] }
    const sound = [];
    for (const c of parts) {
      if (c.id !== ID.Cluster) continue;
      const mine = { time: 0, key: false, body: [] };
      for (const b of children(buf, c.data, c.end, IN_CLUSTER)) {
        if (b.id === ID.Timecode) mine.time = uint(buf, b.data, b.end);
        else if (b.id === ID.SimpleBlock) {
          const h = blockHead(buf, b.data, b.end);
          if (h.track === video.number) {
            if (!mine.body.length) mine.key = Boolean(h.flags & 0x80);
            mine.body.push(buf.subarray(b.start, b.end));
          } else if (pcm && h.track === audio.number) {
            if (h.flags & 0x06) throw new Bad('laced sound');
            sound.push(buf.subarray(h.body, b.end));
          }
        } else if (b.id === ID.BlockGroup) {
          const block = [...children(buf, b.data, b.end)].find((x) => x.id === ID.Block);
          if (!block) continue;
          const h = blockHead(buf, block.data, block.end);
          if (h.track === video.number) mine.body.push(buf.subarray(b.start, b.end));
          else if (pcm && h.track === audio.number) {
            if (h.flags & 0x06) throw new Bad('laced sound');
            sound.push(buf.subarray(h.body, block.end));
          }
        }
      }
      if (mine.body.length) clusters.push(mine);
    }
    if (!clusters.length) return null;

    // The new file: header, then a segment with the same info, the video track alone, an index, and the clusters.
    const infoRaw = buf.subarray(info.start, info.end);
    const tracksNew = el(ID.Tracks, video.raw);
    const built = clusters.map((c) => el(ID.Cluster, el(ID.Timecode, u64(c.time)), ...c.body));
    // One index entry per cluster that starts with a whole picture (at least the first one, so there is an index).
    const cued = clusters.map((c, i) => i).filter((i) => i === 0 || clusters[i].key);
    const cuePoint = (time, pos) => el(ID.CuePoint, el(ID.CueTime, u64(time)), el(ID.CueTrackPositions, el(ID.CueTrack, u64(video.number)), el(ID.CueClusterPosition, u64(pos))));
    const cuesSize = el(ID.Cues, ...cued.map(() => cuePoint(0, 0))).length;
    const starts = [];
    let pos = infoRaw.length + tracksNew.length + cuesSize; // counted from the start of the segment's content
    for (const b of built) {
      starts.push(pos);
      pos += b.length;
    }
    const cues = el(ID.Cues, ...cued.map((i) => cuePoint(clusters[i].time, starts[i])));
    const out = Buffer.concat([buf.subarray(ebml.start, ebml.end), el(ID.Segment, infoRaw, tracksNew, cues, ...built)]);

    let wav = null;
    if (pcm && sound.length) {
      const data = Buffer.concat(sound);
      const bytes = audio.bits / 8;
      const head = Buffer.alloc(44);
      head.write('RIFF', 0, 'latin1');
      head.writeUInt32LE(36 + data.length, 4);
      head.write('WAVEfmt ', 8, 'latin1');
      head.writeUInt32LE(16, 16);
      head.writeUInt16LE(1, 20);
      head.writeUInt16LE(audio.channels, 22);
      head.writeUInt32LE(Math.round(audio.rate), 24);
      head.writeUInt32LE(Math.round(audio.rate) * audio.channels * bytes, 28);
      head.writeUInt16LE(audio.channels * bytes, 32);
      head.writeUInt16LE(audio.bits, 34);
      head.write('data', 36, 'latin1');
      head.writeUInt32LE(data.length, 40);
      wav = Buffer.concat([head, data]);
    }
    return { video: out, wav, codec: video.codec, sound: audio ? audio.codec : '' };
  } catch (err) {
    if (err instanceof Bad || err instanceof RangeError) return null;
    throw err;
  }
}

// A video whose sound is nothing but full-volume noise: what the engine writes when its numbers went wrong on the way
// (the picture is then black). wav: 16-bit PCM as splitWebm returns it.
export function soundIsBroken(wav) {
  if (!wav || wav.length < 44 + 2000 || wav.readUInt16LE(34) !== 16) return false;
  let loud = 0;
  let n = 0;
  for (let i = 44; i + 1 < wav.length; i += 14) {
    if (Math.abs(wav.readInt16LE(i)) >= 32000) loud++;
    n++;
  }
  return loud / n > 0.6;
}

