// The "Get models" list: hand-picked models from Hugging Face, with live file sizes,
// plus a plain-words answer to "will this run on my computer?".
import path from 'node:path';
import { DIRS, getSettings } from './settings.mjs';
import { readJson, writeJson, GB } from './util.mjs';
import { quantOf } from './models.mjs';
import { planModel } from './plan.mjs';
import { t } from './i18n.mjs';

// Picked for being popular, well made and runnable with llama.cpp. Sizes come from Hugging Face at run time.
// group: where the Models page lists it (small: any computer, medium: 16 GB and up, big: big-model mode).
export const CATALOG = [
  { repo: 'unsloth/gemma-4-E2B-it-GGUF', group: 'small', name: 'Gemma 4 E2B', maker: 'Google', params: '5B (2B active)', tags: ['vision', 'fast'], about: 'Tiny and quick. Good for simple questions and slower computers.' },
  { repo: 'unsloth/Qwen3.5-4B-GGUF', group: 'small', name: 'Qwen3.5 4B', maker: 'Qwen', params: '4B', tags: ['vision', 'fast'], about: 'Small all-rounder that also reads images.' },
  { repo: 'unsloth/gemma-4-E4B-it-GGUF', group: 'small', name: 'Gemma 4 E4B', maker: 'Google', params: '8B (4B active)', tags: ['vision', 'fast'], about: 'Small, friendly writer with image input. Runs on most laptops.' },
  { repo: 'unsloth/NVIDIA-Nemotron-3.5-Bolt-E4B-GGUF', group: 'small', name: 'Nemotron 3.5 Bolt E4B', maker: 'NVIDIA', params: '8B (4B active)', tags: ['vision', 'fast'], about: 'NVIDIA’s small, fast model with image input.' },
  { repo: 'unsloth/Qwen3.5-9B-GGUF', group: 'small', name: 'Qwen3.5 9B', maker: 'Qwen', params: '9B', tags: ['vision'], about: 'Strong for its size: chat, writing, light coding and images.' },
  { repo: 'unsloth/Ornith-1.0-9B-GGUF', group: 'small', name: 'Ornith 1.0 9B', maker: 'Ornith', params: '9B', tags: ['vision'], about: 'Popular 9B chat model with image input.' },
  { repo: 'unsloth/gemma-4-12b-it-GGUF', group: 'medium', name: 'Gemma 4 12B', maker: 'Google', params: '12B', tags: ['vision'], about: 'Great writer and image reader. A good first model for 16 GB+.' },
  { repo: 'unsloth/gpt-oss-20b-GGUF', group: 'medium', name: 'gpt-oss 20B', maker: 'OpenAI', params: '21B (3.6B active)', tags: ['moe', 'code', 'fast'], prefer: ['F16', 'UD-Q4_K_XL'], about: 'OpenAI’s open model. Fast, good at reasoning and tool use. Text only.' },
  { repo: 'unsloth/gemma-4-26B-A4B-it-GGUF', group: 'medium', name: 'Gemma 4 26B A4B', maker: 'Google', params: '26B (4B active)', tags: ['vision', 'moe', 'fast'], about: 'Big-model quality at small-model speed.' },
  { repo: 'unsloth/Qwen3.8-27B-GGUF', group: 'medium', name: 'Qwen3.8 27B', maker: 'Qwen', params: '27B', tags: ['vision', 'code'], about: 'One of the strongest models that fits on one computer. Coding, writing, images.' },
  { repo: 'bartowski/orcarouter_Qwen3.8-27B-Uncensored-GGUF', group: 'medium', name: 'Qwen3.8 27B Uncensored', maker: 'Qwen · orcarouter', params: '27B', tags: ['vision', 'code', 'uncensored'], about: 'Qwen3.8 27B with its built-in refusals taken out. It answers what the ordinary model declines, so what you ask it is up to you.' },
  { repo: 'unsloth/gemma-4-31B-it-GGUF', group: 'medium', name: 'Gemma 4 31B', maker: 'Google', params: '31B', tags: ['vision'], about: 'Google’s largest Gemma 4. Excellent writing and image understanding.' },
  { repo: 'unsloth/Qwen3.6-35B-A3B-GGUF', group: 'medium', name: 'Qwen3.6 35B A3B', maker: 'Qwen', params: '35B (3B active)', tags: ['vision', 'moe', 'code', 'fast'], about: 'Fast mixture-of-experts model, great with coding tools like Claude Code.' },
  { repo: 'ISTA-DASLab/Qwen3.8-Flash-Next-GSQ-RCO-GGUF', group: 'big', name: 'Qwen3.8 Flash Next', maker: 'Qwen · ISTA-DASLab', params: '~180B MoE (10 of 512 experts)', tags: ['vision', 'moe', 'code', 'big'], prefer: ['IQ3_S', 'IQ3_XXS', 'Q2_0'], about: 'The big model Strata is built for. Its 29 GB lookup table and spare experts are read from the SSD, so it runs on a 48 GB Mac.' },
  { repo: 'unsloth/Qwen3.8-Flash-Next-GGUF', group: 'big', name: 'Qwen3.8 Flash Next (Unsloth)', maker: 'Qwen · Unsloth', params: '~180B MoE (10 of 512 experts)', tags: ['vision', 'moe', 'code', 'big'], prefer: ['UD-IQ1_M', 'UD-IQ1_S'], about: 'Unsloth’s sizes of the same big model. Larger files than the GSQ-RCO ones above.' },
  // Uncensored ("abliterated") editions of the same big model: the same files with the refusal direction removed,
  // so sizes, memory needs and speed match the two entries above.
  { repo: 'SC117/Qwen3.8-Flash-Next-GSQ-RCO-abliterated-GGUF', group: 'big', name: 'Qwen3.8 Flash Next Uncensored', maker: 'Qwen · SC117', params: '~180B MoE (10 of 512 experts)', tags: ['vision', 'moe', 'code', 'big', 'uncensored'], prefer: ['IQ3_S', 'IQ3_XXS', 'Q2_0'], about: 'The big Qwen3.8 Flash Next with its built-in refusals taken out. Same sizes and speed as the ordinary one. It answers what the ordinary model declines, so what you ask it is up to you.' },
  { repo: 'SC117/Qwen3.8-Flash-Next-abliterated-UD-GGUF', group: 'big', name: 'Qwen3.8 Flash Next Uncensored (Unsloth)', maker: 'Qwen · SC117', params: '~180B MoE (10 of 512 experts)', tags: ['vision', 'moe', 'code', 'big', 'uncensored'], prefer: ['UD-IQ3_XXS', 'UD-IQ2_XS', 'UD-IQ1_S'], about: 'The same uncensored big model in Unsloth’s sizes.' },
  { repo: 'ISTA-DASLab/DeepSeek-V4.1-Flash-1017-GSQ-RCO-GGUF', group: 'big', name: 'DeepSeek V4.1 Flash', maker: 'DeepSeek · ISTA-DASLab', params: '763B MoE (6 of 384 experts)', tags: ['vision', 'moe', 'code', 'big'], prefer: ['IQ2_XXS', 'IQ1_M', 'IQ2_XS'], about: 'DeepSeek’s big open model (October update) with a 1M-token context, images and tools. Its 111 GB Engram table stays on the SSD; the rest needs 120 GB or more of graphics memory and RAM together.' },
];

// The quality ladder we try, best first; the first one that fits comfortably is suggested.
const LADDER = ['UD-Q4_K_XL', 'Q4_K_M', 'UD-Q4_K_M', 'Q4_K_S', 'UD-Q4_K_S', 'IQ4_XS', 'UD-IQ4_XS', 'UD-Q3_K_XL', 'Q3_K_M', 'UD-IQ3_XXS', 'UD-Q2_K_XL', 'UD-IQ2_M', 'UD-IQ2_XXS', 'UD-IQ1_M', 'UD-IQ1_S'];
const HIGHER = ['UD-Q6_K_XL', 'Q6_K', 'UD-Q5_K_XL', 'Q5_K_M'];

const treeCache = new Map();
const CACHE_FILE = path.join(DIRS.cache, 'hf-trees.json');
const disk = readJson(CACHE_FILE, {});

function hfHeaders() {
  const t = getSettings().hfToken;
  return t ? { authorization: `Bearer ${t}` } : {};
}

// File list of a Hugging Face repo (cached for a day, so the page opens instantly next time).
export async function hfTree(repo, force = false) {
  const hit = treeCache.get(repo) || disk[repo];
  if (hit && !force && Date.now() - hit.at < 24 * 3600e3) return hit.files;
  try {
    const res = await fetch(`https://huggingface.co/api/models/${repo}/tree/main?recursive=true`, { headers: hfHeaders(), signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error(t('Hugging Face said {status}', { status: res.status }));
    const json = await res.json();
    const files = json.filter((x) => x.type === 'file').map((x) => ({ path: x.path, size: x.lfs?.size ?? x.size ?? 0 }));
    const rec = { at: Date.now(), files };
    treeCache.set(repo, rec);
    disk[repo] = rec;
    try {
      writeJson(CACHE_FILE, disk);
    } catch {}
    return files;
  } catch (err) {
    if (hit) return hit.files; // offline: use what we saw last time
    throw err;
  }
}

// Groups a repo's files into choices like "Q4_K_M · 7.1 GB" (split files count as one).
// A shared lookup file stored once for every size (DeepSeek-V4.1's Engram tables: each size has parts 1-5 of 6 in
// the repo, the Engram file is part 6 of all of them) is added to each size as { shared: { from, as, size } }:
// download it once, then link it into place under the last part's name.
export function quantsOf(files) {
  const groups = new Map();
  const projectors = [];
  const drafts = [];
  const shared = [];
  for (const f of files) {
    if (!/\.gguf$/i.test(f.path)) continue;
    if (/mmproj|projector/i.test(path.basename(f.path))) {
      projectors.push(f);
      continue;
    }
    if (/(^|[-_])engram([-_.]|$)/i.test(path.basename(f.path))) {
      shared.push(f);
      continue;
    }
    // MTP drafts (e.g. MTP/mtp-…-Q4_K_M.gguf) only help a main model; they are not a size of it.
    if (/(^|\/)mtp[-_]|(^|\/)MTP\//i.test(f.path)) {
      drafts.push(f);
      continue;
    }
    const q = quantOf(f.path);
    if (!q || /imatrix/i.test(f.path)) continue;
    const g = groups.get(q) || { quant: q, files: [], fileSizes: [], size: 0 };
    g.files.push(f.path);
    g.size += f.size;
    groups.set(q, g);
  }
  for (const g of groups.values()) {
    const sizeOf = new Map(files.filter((f) => g.files.includes(f.path)).map((f) => [f.path, f.size]));
    g.files.sort();
    g.fileSizes = g.files.map((p) => sizeOf.get(p) || 0);
    // Parts 1 to N-1 here and one shared file: that file is part N of this size.
    const split = /-(\d{5})-of-(\d{5})\.gguf$/i.exec(g.files[0] || '');
    if (split && shared.length === 1 && g.files.length === Number(split[2]) - 1) {
      const as = g.files[0].replace(/-\d{5}-of-(\d{5})\.gguf$/i, `-${split[2]}-of-$1.gguf`);
      if (!g.files.includes(as)) {
        g.shared = { from: shared[0].path, as, size: shared[0].size };
        g.size += shared[0].size;
        g.fileSizes.push(shared[0].size);
      }
    }
  }
  const rank = (p) => (/f16/i.test(p) && !/bf16/i.test(p) ? 0 : /bf16/i.test(p) ? 1 : /q8/i.test(p) ? 2 : 3);
  const mmproj = projectors.sort((a, b) => rank(a.path) - rank(b.path))[0] || null;
  return { quants: [...groups.values()].sort((a, b) => a.size - b.size), mmproj, drafts };
}

// Guesses a download's layout before it is on disk. A shard that is byte-for-byte the same size in several sizes of
// one repo is a shared lookup table (Qwen3.8-Flash-Next's n-gram table): it stays on the SSD.
function estimateLayouts(quants, moe) {
  const lastSizes = new Map();
  for (const q of quants) if (q.files.length > 1) {
    const last = q.fileSizes?.[q.fileSizes.length - 1];
    if (last) lastSizes.set(last, (lastSizes.get(last) || 0) + 1);
  }
  for (const q of quants) {
    const last = q.fileSizes?.[q.fileSizes.length - 1];
    const table = q.files.length > 1 && lastSizes.get(last) > 1 ? last : 0;
    const rest = q.size - table;
    q.layout = { table, experts: moe ? rest * 0.9 : 0, dense: moe ? rest * 0.1 : rest, expertLayers: moe ? 48 : 0, total: q.size };
  }
}

// A plain-words verdict for one size of a model on this computer (the same plan the engine will use).
export function fitFor(hw, size, { ctx = 32768, moe = false, mmproj = 0, layout } = {}) {
  return planModel(hw, { size, moe, mmprojSize: mmproj, layout }, { ctx, vision: Boolean(mmproj) });
}

// Best quality that runs comfortably; if none does, the one that leans least on the SSD.
function suggest(entry, quants) {
  const by = new Map(quants.map((q) => [q.quant, q]));
  const order = [...(entry.prefer || []), ...LADDER].filter((n) => by.has(n));
  const great = order.find((n) => by.get(n).fit.level === 'great');
  if (great) {
    if ((entry.prefer || []).includes(great)) return great; // the maker's own pick (e.g. gpt-oss F16) wins
    // Plenty of room left over? Offer a sharper size of a small model.
    for (const hi of HIGHER) {
      const h = by.get(hi);
      if (h && h.fit.level === 'great' && h.size < 12e9 && h.fit.need < by.get(great).fit.need * 1.6) return hi;
    }
    return great;
  }
  const ok = order.find((n) => by.get(n).fit.level === 'ok');
  if (ok) return ok;
  const ssd = quants.filter((q) => q.fit.level === 'ssd').sort((a, b) => a.fit.ssd - b.fit.ssd)[0];
  if (ssd) return ssd.quant;
  return order.find((n) => by.get(n).fit.level !== 'no') || order[0] || quants[0]?.quant || '';
}

export async function catalogFor(hw, installed = []) {
  const ctx = getSettings().contextSize;
  const results = await Promise.all(
    CATALOG.map(async (entry) => {
      try {
        const { quants, mmproj } = quantsOf(await hfTree(entry.repo));
        const moe = entry.tags.includes('moe');
        estimateLayouts(quants, moe);
        const opts = { ctx, moe, mmproj: mmproj?.size || 0 };
        const choices = quants
          .filter((q) => !/^(BF16|F32)$/.test(q.quant) && q.size > 0.3e9)
          .map(({ layout, fileSizes, ...q }) => ({ ...q, fit: fitFor(hw, q.size, { ...opts, layout }), installed: installed.some((m) => m.repo === entry.repo && m.quant === q.quant) }));
        return { ...entry, about: t(entry.about), params: t(entry.params), choices, mmproj, suggested: suggest(entry, choices) };
      } catch (err) {
        return { ...entry, about: t(entry.about), params: t(entry.params), choices: [], error: String(err.message || err) };
      }
    }),
  );
  return results;
}

// Search all of Hugging Face for GGUF repos.
export async function searchHf(query) {
  const url = `https://huggingface.co/api/models?filter=gguf&sort=downloads&direction=-1&limit=24&search=${encodeURIComponent(query)}`;
  const res = await fetch(url, { headers: hfHeaders(), signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(t('Hugging Face said {status}', { status: res.status }));
  const list = await res.json();
  return list.map((m) => ({ repo: m.id, downloads: m.downloads, likes: m.likes, updated: m.lastModified || m.createdAt }));
}

export async function repoChoices(repo, hw) {
  const ctx = getSettings().contextSize;
  const { quants, mmproj } = quantsOf(await hfTree(repo, true));
  const moe = /a\d+b|moe|mixtral|-e\d+b|flash-next|gpt-oss/i.test(repo);
  estimateLayouts(quants, moe);
  return {
    repo,
    mmproj,
    choices: quants.map(({ layout, fileSizes, ...q }) => ({ ...q, fit: fitFor(hw, q.size, { ctx, moe, mmproj: mmproj?.size || 0, layout }) })),
  };
}

// Where a file of a model repository goes: inside the model's own folder, whatever the listing calls the file.
// A name with a backslash, a drive letter or a ".." part is refused (on Windows a backslash is a separator too).
export function modelFileDest(root, file, join = path.join, sep = path.sep) {
  const parts = String(file || '').split('/');
  if (!parts.length || parts.some((x) => !x || x === '.' || x === '..' || /[\\:\0]/.test(x))) throw Object.assign(new Error(t('This model has a file with a name Hearth does not accept: {name}', { name: String(file).slice(0, 120) })), { status: 400 });
  const dest = join(root, ...parts);
  if (!dest.startsWith(root + sep)) throw Object.assign(new Error(t('This model has a file with a name Hearth does not accept: {name}', { name: String(file).slice(0, 120) })), { status: 400 });
  return dest;
}
