// Looks for a newer engine and for changed model files on Hugging Face: soon after start, then once a day.
// Nothing is installed by itself; the Models page offers the update.
import fs from 'node:fs';
import path from 'node:path';
import { getSettings, modelsDir } from './settings.mjs';
import { detectHardware } from './hardware.mjs';
import { listEngines, latestEngine } from './engine-install.mjs';
import { listLocalModels } from './models.mjs';
import { modelParts } from './gguf.mjs';
import { hfTree } from './catalog.mjs';
import { sdEngineUpdate } from './images.mjs';

let state = { checkedAt: 0, checking: false, engine: null, images: null, models: [], error: '' };
let timer = null;

export function updatesState() {
  return state;
}

export async function checkUpdates() {
  if (state.checking) return state;
  state = { ...state, checking: true };
  const next = { checkedAt: Date.now(), checking: false, engine: null, images: null, models: [], error: '' };
  try {
    const hw = await detectHardware();
    const engines = await listEngines(true);
    const cur = engines.find((e) => e.source === 'downloaded') || engines[0];
    const latest = await latestEngine(hw, getSettings().engineBackend || hw.backend).catch((err) => {
      next.error = String(err.message || err);
      return null;
    });
    if (latest && (!cur || latest.build > cur.build)) next.engine = { current: cur?.build || 0, latest: latest.build, size: latest.size, variant: latest.variant };
  } catch (err) {
    next.error = String(err.message || err);
  }
  // The picture and video engine (stable-diffusion.cpp), when Hearth installed one.
  try {
    const u = await sdEngineUpdate(await detectHardware());
    if (u) next.images = { current: u.current, latest: u.latest, size: u.size, behind: u.behind };
  } catch {}
  // Models Hearth downloaded live in models/<owner>/<repo>/…, so we know where they came from.
  const root = modelsDir();
  for (const m of listLocalModels(true).filter((x) => x.source === 'hearth' && x.repo)) {
    try {
      const tree = await hfTree(m.repo, true);
      const repoDir = path.join(root, ...m.repo.split('/'));
      const changed = [];
      for (const part of [...modelParts(m.path), ...(m.mmproj ? [m.mmproj] : [])]) {
        const rel = path.relative(repoDir, part).split(path.sep).join('/');
        const remote = tree.find((f) => f.path === rel);
        if (remote && remote.size && remote.size !== fs.statSync(part).size) changed.push(rel);
      }
      if (changed.length) next.models.push({ id: m.id, name: m.name, quant: m.quant, repo: m.repo, files: changed });
    } catch {}
  }
  state = next;
  return state;
}

export function scheduleUpdateChecks() {
  clearTimeout(timer);
  const tick = async () => {
    if (getSettings().checkUpdates) await checkUpdates().catch(() => {});
    timer = setTimeout(tick, 24 * 3600e3);
    timer.unref?.();
  };
  timer = setTimeout(tick, 45e3);
  timer.unref?.();
}
