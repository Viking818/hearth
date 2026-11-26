// The memory plan for one model on this computer: what must sit in memory, what can stay on the SSD,
// and the engine options that make it so. This is how big mixture-of-experts models run on small machines:
//   - lookup tables (per-layer n-gram embeddings) are read from the SSD a few rows per word (--lazy-mode on);
//   - when the GPU's share is too small, llama.cpp's fit step moves the experts of a few layers to the processor.
//     They stay in the model file: macOS keeps them in its file cache when it has room, else reads them from the SSD.
//     Hearth leaves the exact split to llama.cpp (it knows every buffer) but reserves room for the image helper,
//     which the fit step does not count, and uses its own estimate to tell the user what will happen.
//
// Measured (M3 Max 48 GB, Qwen3.8-Flash-Next Q2_0, 32K context, text): everything on the GPU 38.4 tok/s and a 4K
// prompt at 429 tok/s; 5 expert layers on the processor 31.7 / 378; 10 layers 23.7 / 260; llama.cpp's GPU expert
// cache with all experts on the processor (--cpu-moe --moe-cache-mib 24000) 15.6 / 92. So: as much on the GPU as fits.
import { GB } from './util.mjs';
import { t } from './i18n.mjs';

// Context memory. Hybrid models (attention only every Nth layer) are computed exactly; others use a rough rule,
// because sliding-window models (Gemma) keep far less than a naive count suggests.
// Context memory per stored number: full precision (f16), INT8 (q8_0) or INT4 (q4_0), each with its block scales.
export const KV_FACTOR = { f16: 1, q8_0: 8.5 / 16, q4_0: 4.5 / 16 };

export function contextBytes(model, ctx, kv = 'f16') {
  const m = model.meta || {};
  const f = KV_FACTOR[kv] ?? 1;
  if (m.fullAttentionInterval > 0 && m.headKv > 0) {
    const keyLen = m.keyLength || (m.embedding && m.heads ? m.embedding / m.heads : 128);
    const valLen = m.valueLength || keyLen;
    const attnLayers = Math.ceil(m.layers / m.fullAttentionInterval);
    return attnLayers * m.headKv * (keyLen + valLen) * 2 * ctx * f + 0.3 * GB; // + recurrent state
  }
  const weights = model.size || 0;
  return (ctx / 32768) * Math.min(4 * GB, 0.5 * GB + weights * (model.moe ? 0.03 : 0.08)) * f;
}

const MiB = 1024 * 1024;
export const FIT_MARGIN = 1024 * MiB; // what llama.cpp's fit step leaves free on each GPU by default

// Memory in binary GB, the way computers are sold (a "48 GB" Mac).
const gb = (n) => t('{n} GB', { n: Math.max(1, Math.round(n / 1024 ** 3)) });
// Files on disk in decimal GB, the way Finder and Hugging Face count them.
const diskGb = (n) => t('{n} GB', { n: Math.max(1, Math.round(n / 1e9)) });

/**
 * model: { size, moe, mmproj?, mmprojSize?, layout?: { experts, table, dense, expertLayers }, meta? }
 * opts: { ctx, vision, kv: f16|q8_0|q4_0, visionCpu, margin (GPU memory to leave free), lowRam, othersNeed }
 *   othersNeed: GPU memory the models that are already loaded take (several models at once).
 * Returns { level, label, detail, need, ssd, args, mode, cpuMoeLayers }
 *   level: great | ok | ssd | slow | no
 */
export function planModel(hw, model, { ctx = 32768, vision = true, kv = 'f16', visionCpu = false, margin = FIT_MARGIN, lowRam = false, othersNeed = 0, draftBytes = 0 } = {}) {
  const layout = model.layout || { experts: model.moe ? model.size * 0.9 : 0, table: 0, dense: model.moe ? model.size * 0.1 : model.size, expertLayers: model.layers || 0 };
  // Big lookup tables (4 GiB and up) are read from the SSD by default in new engines; we ask for it explicitly.
  const lazyTable = layout.table >= 1 * GB ? layout.table : 0;
  const tableInMemory = layout.table - lazyTable;
  // The image helper sits on the GPU unless it was moved to the processor.
  const mmprojBytes = vision && !visionCpu ? model.mmprojSize || 0 : 0;
  // An MTP draft sits on the GPU next to the model, with a small context of its own.
  const overhead = contextBytes(model, ctx, kv) + 1.0 * GB + mmprojBytes + (draftBytes ? draftBytes + 0.3 * GB : 0);
  const need = layout.dense + tableInMemory + layout.experts + overhead;
  const args = lazyTable ? ['--lazy-mode', 'on'] : [];
  if (kv !== 'f16' && KV_FACTOR[kv]) args.push('-ctk', kv, '-ctv', kv);
  if (vision && visionCpu) args.push('--no-mmproj-offload');
  // llama.cpp's fit step keeps 1 GiB free on the GPU but doesn't count the image helper or other models that are
  // running: keep room for them, and for the user's own work when they asked for it.
  const reserve = margin + mmprojBytes + othersNeed + (draftBytes ? draftBytes + 0.3 * GB : 0);
  if (reserve !== FIT_MARGIN) args.push('--fit-target', String(Math.ceil(reserve / MiB)));
  const fromSsd = lazyTable ? t(' · {size} lookup table read from SSD', { size: diskGb(lazyTable) }) : '';
  const base = { need, ssd: lazyTable, args, mode: 'gpu', cpuMoeLayers: 0 };

  // Low-memory mode: every expert stays in the model file; the GPU keeps a small cache of the busy ones.
  if (lowRam && layout.experts > 0) {
    const cache = Math.min(layout.experts, Math.max(2 * GB, (hw.gpuBudget || hw.ram * 0.5) * 0.15));
    args.push('--cpu-moe', '--moe-cache-mib', String(Math.round(cache / MiB)));
    const gpuNeed = layout.dense + tableInMemory + overhead + cache;
    return {
      ...base,
      need: gpuNeed,
      ssd: lazyTable + layout.experts,
      mode: 'ssd-experts',
      cpuMoeLayers: layout.expertLayers,
      level: 'ssd',
      label: t('Least memory: experts from the SSD'),
      detail: t('GPU holds about {size}, with {cache} for the busiest experts · the rest are read from the SSD when needed (slower)', { size: gb(gpuNeed), cache: gb(cache) }) + fromSsd,
    };
  }

  if (hw.unified) {
    const budget = (hw.gpuBudget || hw.ram * 0.66) - othersNeed;
    const gpuLimit = budget - margin;
    if (need <= budget * 0.8) return { ...base, level: 'great', label: t('Runs well'), detail: t('Uses about {size}', { size: gb(need) }) + fromSsd };
    if (need <= gpuLimit) return { ...base, level: 'ok', label: t('Fits, close other apps'), detail: t('Uses about {size} of the {budget} the GPU may use', { size: gb(need), budget: gb(budget) }) + fromSsd };
    if (layout.experts > 0 && layout.expertLayers > 0) {
      // About how many expert layers llama.cpp will move to the processor so the rest fits the GPU's share.
      const perLayer = layout.experts / layout.expertLayers;
      const n = Math.min(layout.expertLayers, Math.ceil((need - gpuLimit) / perLayer));
      const resident = need - n * perLayer;
      if (resident > gpuLimit) return { ...base, level: 'no', label: t('Too big (needs ~{size} even with SSD)', { size: gb(resident) }), detail: '' };
      const moved = n * perLayer;
      // The moved experts live in macOS's file cache when there is room (fast), else they come from the SSD.
      // A little SSD reading per word is fine (Strata streams up to ~12 GB this way); much more and answers crawl.
      const reserve = Math.max(6 * GB, hw.ram * 0.12);
      const cacheRoom = Math.max(0, hw.ram - resident - reserve);
      if (moved > cacheRoom + 12 * GB) return { ...base, level: 'no', label: t('Too slow here (needs ~{size})', { size: gb(need) }), detail: t('{size} of experts would be read from the SSD for every answer', { size: diskGb(moved - cacheRoom) }) };
      const fromDisk = moved > cacheRoom;
      return {
        ...base,
        need: resident,
        ssd: lazyTable + (fromDisk ? moved - cacheRoom : 0),
        mode: 'split',
        cpuMoeLayers: n,
        level: fromDisk ? 'ssd' : 'ok',
        label: fromDisk ? t('Runs, part from SSD') : t('Fits, part on the processor'),
        detail:
          t('GPU holds about {size}', { size: gb(resident) }) +
          (fromDisk
            ? t(' · about {n} of {total} expert layers run on the processor, partly read from the SSD', { n, total: layout.expertLayers })
            : t(' · about {n} of {total} expert layers run on the processor from RAM', { n, total: layout.expertLayers })) +
          fromSsd,
      };
    }
    return { ...base, level: 'no', label: t('Too big (needs ~{size})', { size: gb(need) }), detail: '' };
  }

  // PC with a graphics card (or none). Room for other models and the user's own work comes off the top.
  const vram = Math.max(0, (hw.gpuBudget || 0) - othersNeed - Math.max(0, margin - FIT_MARGIN));
  if (vram && need <= vram * 0.95) return { ...base, level: 'great', label: t('Runs fully on graphics card'), detail: t('Uses about {size} of {vram} graphics memory', { size: gb(need), vram: gb(vram) }) + fromSsd };
  const ramForModel = hw.ram * 0.8;
  if (layout.experts > 0) {
    // llama.cpp's fit step puts the experts that don't fit in graphics memory on the processor by itself.
    const inRam = Math.max(0, need - vram);
    // Reading a prompt copies the experts kept on the processor to the graphics card once per batch of tokens. On the
    // user's PC (RX 7900 XTX, an 80 GB model) batches of 2048 instead of llama.cpp's 512 read 3-4 times faster and
    // wrote 20% faster too; 4096 was slower again (a bigger work area on the card leaves less room for experts).
    if (vram >= 16 * GB) base.args = [...args, '-ub', '2048'];
    // A big lookup table read from the SSD fills the RAM bit by bit during a long session (llama.cpp reads it through
    // the file cache), and then Windows pushes the experts out of memory too: on the user's PC an agent's answers fell
    // from 17 to 6 tok/s after 45 minutes. Locking the experts in RAM leaves only table pages to drop (Strata reads
    // that table around the cache altogether). With the lock the PC still wrote 10 tok/s 19 hours later, at 180K context.
    if (lazyTable > 0 && vram > 0 && inRam <= hw.ram - 14 * GB) base.args = [...base.args, '--load-mode', 'mmap+mlock'];
    if (inRam <= ramForModel)
      return { ...base, mode: 'moe-cpu', level: vram ? 'ok' : 'slow', label: vram ? t('Runs, experts on the processor') : t('Runs on the processor (slow)'), detail: t('{vram} graphics memory + {ram} RAM', { vram: gb(Math.min(need, vram)), ram: gb(inRam) }) + fromSsd };
    if (inRam <= hw.ram * 1.6)
      return { ...base, mode: 'moe-cpu', ssd: lazyTable + inRam - ramForModel, level: 'ssd', label: t('Runs, part from SSD (slow)'), detail: t('About {size} of experts read from SSD', { size: gb(inRam - ramForModel) }) + fromSsd };
    return { ...base, level: 'no', label: t('Too big (needs ~{size})', { size: gb(need) }), detail: '' };
  }
  if (need <= vram + ramForModel) return { ...base, mode: 'cpu', level: 'slow', label: vram ? t('Runs slowly, part on the processor') : t('Runs on the processor (slow)'), detail: t('Uses about {size}', { size: gb(need) }) };
  return { ...base, level: 'no', label: t('Too big (needs ~{size})', { size: gb(need) }), detail: '' };
}

