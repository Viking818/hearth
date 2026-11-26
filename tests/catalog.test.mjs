// Tests for the model catalog: a repo whose sizes share one file (DeepSeek-V4.1-Flash's Engram tables are part 6 of
// every size) lists each size with that file counted in, and the download links it into place. Run with: npm test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.HEARTH_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-test-'));
const { quantsOf, CATALOG } = await import('../server/catalog.mjs');
const { linkShared } = await import('../server/models.mjs');

const GB = 1e9;
const tree = [];
for (const [id, backbone] of [['IQ1_M', 120.72], ['IQ2_XXS', 138.24], ['IQ2_XS', 155.23]]) {
  for (let i = 1; i <= 5; i++) tree.push({ path: `DeepSeek-V4.1-Flash-1017-GSQ-RCO-${id}-0000${i}-of-00006.gguf`, size: i === 1 ? 0.01 * GB : ((backbone - 0.01) / 4) * GB });
}
tree.push({ path: 'DeepSeek-V4.1-Flash-Engram-IQ4_NL.gguf', size: 110.6 * GB });
tree.push({ path: 'mmproj-DeepSeek-V4.1-Flash-1017-BF16.gguf', size: 0.97 * GB });

test('sizes that share one file list it as their last part, and it is not a size of its own', () => {
  const { quants, mmproj } = quantsOf(tree);
  assert.deepEqual(quants.map((q) => q.quant), ['IQ1_M', 'IQ2_XXS', 'IQ2_XS']);
  const q = quants.find((x) => x.quant === 'IQ2_XXS');
  assert.equal(q.files.length, 5);
  assert.deepEqual(q.shared, { from: 'DeepSeek-V4.1-Flash-Engram-IQ4_NL.gguf', as: 'DeepSeek-V4.1-Flash-1017-GSQ-RCO-IQ2_XXS-00006-of-00006.gguf', size: 110.6 * GB });
  assert.ok(Math.abs(q.size / GB - 248.84) < 0.01, `download size ${q.size / GB}`);
  assert.equal(mmproj.path, 'mmproj-DeepSeek-V4.1-Flash-1017-BF16.gguf');
  assert.ok(CATALOG.some((e) => e.repo === 'ISTA-DASLab/DeepSeek-V4.1-Flash-1017-GSQ-RCO-GGUF' && e.group === 'big'));
  assert.ok(CATALOG.every((e) => ['small', 'medium', 'big'].includes(e.group)), 'every catalog entry has a group');
  // The uncensored Qwen3.8 models sit right after the ordinary ones and are marked, so the page can say so.
  const open = CATALOG.filter((e) => e.tags.includes('uncensored'));
  assert.deepEqual(open.map((e) => e.repo), ['bartowski/orcarouter_Qwen3.8-27B-Uncensored-GGUF', 'SC117/Qwen3.8-Flash-Next-GSQ-RCO-abliterated-GGUF', 'SC117/Qwen3.8-Flash-Next-abliterated-UD-GGUF']);
  assert.ok(open.every((e) => /uncensored/i.test(e.name) && /refusals|uncensored/i.test(e.about)), 'the name and the text say what it is');
  assert.equal(new Set(CATALOG.map((e) => e.repo)).size, CATALOG.length, 'no repo twice');
});

test('the shared file is linked in place once, without a copy', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-link-'));
  const from = path.join(dir, 'DeepSeek-V4.1-Flash-Engram-IQ4_NL.gguf');
  const as = path.join(dir, 'DeepSeek-V4.1-Flash-1017-GSQ-RCO-IQ2_XXS-00006-of-00006.gguf');
  fs.writeFileSync(from, 'engram');
  assert.equal(linkShared(from, as), 'link');
  assert.equal(fs.readFileSync(as, 'utf8'), 'engram');
  assert.equal(fs.statSync(as).ino, fs.statSync(from).ino); // one file, two names
  assert.equal(linkShared(from, as), 'there');
});
