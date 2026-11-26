// Unpacks bzip2 (.bz2) files. The natural voice and its engine come as .tar.bz2 archives, and the `tar` that Windows
// has built in opens that kind only in its newest versions. So Hearth takes the bzip2 layer off itself, the same way
// on every system, and hands the plain .tar underneath to `tar`.
// The format: blocks of up to 900 kB, each one Huffman codes → runs → move-to-front → Burrows-Wheeler → runs again,
// with a checksum for every block and one for the whole file. Both are checked here.
import fs from 'node:fs';

const CRC = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let r = i << 24;
    for (let k = 0; k < 8; k++) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1;
    table[i] = r >>> 0;
  }
  return table;
})();

const bad = (what) => new Error(`not a valid bzip2 file (${what})`);

// Reads the file bit by bit, the highest bit of every byte first.
class Bits {
  constructor(buf, pos = 0) {
    this.buf = buf;
    this.pos = pos;
    this.hold = 0;
    this.count = 0;
  }
  // n: 1 to 24
  read(n) {
    while (this.count < n) {
      if (this.pos >= this.buf.length) throw bad('it ends too early');
      this.hold = (this.hold << 8) | this.buf[this.pos++];
      this.count += 8;
    }
    this.count -= n;
    const v = (this.hold >>> this.count) & ((1 << n) - 1);
    this.hold &= (1 << this.count) - 1;
    return v;
  }
  bit() {
    if (this.count === 0) {
      if (this.pos >= this.buf.length) throw bad('it ends too early');
      this.hold = this.buf[this.pos++];
      this.count = 8;
    }
    this.count--;
    const v = (this.hold >>> this.count) & 1;
    this.hold &= (1 << this.count) - 1;
    return v;
  }
  // The rest of a started byte is padding.
  align() {
    this.hold = 0;
    this.count = 0;
  }
}

// One block: fills `tt` with the block's bytes in Burrows-Wheeler order. Returns { n, origPtr, counts }.
function readBlock(bits, tt, max) {
  if (bits.bit()) throw bad('a very old "randomised" block; not supported');
  const origPtr = bits.read(24);
  // Which byte values the block uses
  const used = bits.read(16);
  const mtf = [];
  for (let i = 0; i < 16; i++) {
    if (!(used & (0x8000 >> i))) continue;
    const row = bits.read(16);
    for (let j = 0; j < 16; j++) if (row & (0x8000 >> j)) mtf.push(i * 16 + j);
  }
  const inUse = mtf.length;
  if (!inUse) throw bad('a block that uses no bytes');
  const alpha = inUse + 2;
  const groups = bits.read(3);
  const nSel = bits.read(15);
  if (groups < 2 || groups > 6 || nSel < 1) throw bad('the code tables');
  // Which code table goes with each run of 50 symbols
  const selectors = new Uint8Array(nSel);
  const order = [0, 1, 2, 3, 4, 5];
  for (let i = 0; i < nSel; i++) {
    let j = 0;
    while (bits.bit()) if (++j >= groups) throw bad('the code tables');
    const v = order[j];
    for (; j > 0; j--) order[j] = order[j - 1];
    order[0] = v;
    selectors[i] = v;
  }
  // The code tables themselves: a length for every symbol, then the tables to decode by length
  const tables = [];
  for (let g = 0; g < groups; g++) {
    const len = new Uint8Array(alpha);
    let cur = bits.read(5);
    for (let i = 0; i < alpha; i++) {
      for (;;) {
        if (cur < 1 || cur > 20) throw bad('the code lengths');
        if (!bits.bit()) break;
        cur += bits.bit() ? -1 : 1;
      }
      len[i] = cur;
    }
    let minLen = 32;
    let maxLen = 0;
    for (let i = 0; i < alpha; i++) {
      if (len[i] > maxLen) maxLen = len[i];
      if (len[i] < minLen) minLen = len[i];
    }
    const perm = new Uint16Array(alpha);
    let pp = 0;
    for (let l = minLen; l <= maxLen; l++) for (let i = 0; i < alpha; i++) if (len[i] === l) perm[pp++] = i;
    const base = new Int32Array(23);
    const limit = new Int32Array(23);
    for (let i = 0; i < alpha; i++) base[len[i] + 1]++;
    for (let i = 1; i < 23; i++) base[i] += base[i - 1];
    let vec = 0;
    for (let l = minLen; l <= maxLen; l++) {
      vec += base[l + 1] - base[l];
      limit[l] = vec - 1;
      vec <<= 1;
    }
    for (let l = minLen + 1; l <= maxLen; l++) base[l] = ((limit[l - 1] + 1) << 1) - base[l];
    tables.push({ minLen, maxLen, perm, base, limit });
  }
  // The symbols: runs of the front byte (RUNA/RUNB), "this far back in the list" for the rest, and the end mark
  const counts = new Int32Array(256);
  const end = inUse + 1;
  let n = 0;
  let group = -1;
  let left = 0;
  let table = null;
  let run = 0;
  let runBit = 1;
  for (;;) {
    if (left === 0) {
      if (++group >= nSel) throw bad('the symbols');
      left = 50;
      table = tables[selectors[group]];
    }
    left--;
    let l = table.minLen;
    let code = bits.read(l);
    while (code > table.limit[l]) {
      if (++l > table.maxLen) throw bad('the symbols');
      code = (code << 1) | bits.bit();
    }
    const at = code - table.base[l];
    if (at < 0 || at >= alpha) throw bad('the symbols');
    const sym = table.perm[at];
    if (sym < 2) {
      run += runBit << sym; // RUNA adds the bit's worth once, RUNB twice
      runBit <<= 1;
      if (run > max) throw bad('a run that is too long');
      continue;
    }
    if (run) {
      const b = mtf[0];
      if (n + run > max) throw bad('a block that is too big');
      counts[b] += run;
      tt.fill(b, n, n + run);
      n += run;
      run = 0;
      runBit = 1;
    }
    if (sym === end) break;
    if (n >= max) throw bad('a block that is too big');
    const back = sym - 1;
    const b = mtf[back];
    for (let j = back; j > 0; j--) mtf[j] = mtf[j - 1];
    mtf[0] = b;
    counts[b]++;
    tt[n++] = b;
  }
  if (origPtr >= n) throw bad('the block start');
  return { n, origPtr, counts };
}

/**
 * src: a .bz2 file. Writes what it holds to dest. onProgress(done 0…1) is called now and then.
 * Fails when the file is damaged: every block and the whole file carry checksums.
 */
export async function bunzipFile(src, dest, onProgress) {
  const buf = fs.readFileSync(src);
  const out = fs.openSync(dest, 'w');
  const chunk = Buffer.allocUnsafe(1 << 20);
  let fill = 0;
  const flush = () => {
    if (fill) fs.writeSync(out, chunk, 0, fill);
    fill = 0;
  };
  try {
    let at = 0;
    let streams = 0;
    while (at + 4 <= buf.length && buf[at] === 0x42 && buf[at + 1] === 0x5a && buf[at + 2] === 0x68) {
      // "BZh" and the block size, 1 to 9 hundred thousand bytes
      const level = buf[at + 3] - 0x30;
      if (level < 1 || level > 9) throw bad('the block size');
      const max = level * 100000;
      const tt = new Uint32Array(max);
      const bits = new Bits(buf, at + 4);
      let whole = 0;
      for (;;) {
        const hi = bits.read(24);
        const lo = bits.read(24);
        if (hi === 0x177245 && lo === 0x385090) break; // the end of this stream
        if (hi !== 0x314159 || lo !== 0x265359) throw bad('a block mark');
        const wanted = ((bits.read(16) << 16) | bits.read(16)) >>> 0;
        const { n, origPtr, counts } = readBlock(bits, tt, max);
        // Burrows-Wheeler backwards: for every byte, where the byte before it in the text stands
        const start = new Int32Array(257);
        for (let i = 1; i <= 256; i++) start[i] = start[i - 1] + counts[i - 1];
        for (let i = 0; i < n; i++) tt[start[tt[i] & 0xff]++] |= i << 8;
        let pos = tt[origPtr] >>> 8;
        let crc = 0xffffffff;
        let prev = -1;
        let same = 0;
        for (let i = 0; i < n; i++) {
          const e = tt[pos];
          const b = e & 0xff;
          pos = e >>> 8;
          if (same === 4) {
            // After four equal bytes comes a count of how many more follow
            for (let k = 0; k < b; k++) {
              crc = (crc << 8) ^ CRC[((crc >>> 24) ^ prev) & 0xff];
              chunk[fill++] = prev;
              if (fill === chunk.length) flush();
            }
            same = 0;
            continue;
          }
          crc = (crc << 8) ^ CRC[((crc >>> 24) ^ b) & 0xff];
          chunk[fill++] = b;
          if (fill === chunk.length) flush();
          if (b === prev) same++;
          else {
            prev = b;
            same = 1;
          }
        }
        crc = ~crc >>> 0;
        if (crc !== wanted) throw bad('a block does not match its checksum');
        whole = (((whole << 1) | (whole >>> 31)) ^ crc) >>> 0;
        onProgress?.(Math.min(1, bits.pos / buf.length));
        await new Promise((r) => setImmediate(r)); // let the rest of Hearth breathe between blocks
      }
      const wantedWhole = ((bits.read(16) << 16) | bits.read(16)) >>> 0;
      if (wantedWhole !== whole) throw bad('the file does not match its checksum');
      bits.align();
      at = bits.pos;
      streams++;
    }
    if (!streams) throw bad('it does not start like one');
    flush();
  } finally {
    fs.closeSync(out);
  }
}
