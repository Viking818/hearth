// Guess-and-check decoding ("speculative decoding"): cheap guesses for the next words, checked by the model in one
// pass. The answer is exactly the same; only the speed changes.
//
// Hearth uses n-gram guesses: when the answer repeats text that is already in the conversation (editing code or a
// document, quoting, filling a template), the next words are taken from there. No extra model, no extra memory.
// Measured on an M3 Max 48 GB with Qwen3.8 27B (dense), greedy, 700 tokens:
//   rewrite a 70-line file with one change   17.2 tok/s → ngram-simple 93.6 (5.4×), ngram-mod 73.1
//   a new story (English / Russian)           18.5 / 19.0 → ngram-simple 18.3 / 18.5 (no guesses fit: about the same)
// and with Qwen3.8-Flash-Next Q2_0 (mixture of experts, big model mode):
//   rewrite a 70-line file                    32.0 tok/s → 55.2 (1.7×); new text 34.0 / 34.9 → 34.4 / 34.6
// MTP drafts (a model's own "next words" layer as a small extra file) help when there is room for them. On the same
// Mac with Flash Next, warm cache, the 2.8 GB draft pushed more experts to the processor and made new text slower:
//   no drafting 32-35 tok/s · MTP (3 ahead) edit 36, story 25, Russian 29 · MTP + text guesses 30 / 28 / 30
// So "automatic" uses an MTP draft only when the model and the draft both fit on the GPU, and text guesses otherwise.
import { run } from './util.mjs';

const helpCache = new Map();
export async function engineHelp(bin) {
  if (!helpCache.has(bin)) helpCache.set(bin, await run(bin, ['--help'], { timeout: 15000, withStderr: true }));
  return helpCache.get(bin);
}

// What "automatic" picks: the MTP draft when it fits on the GPU with the model, else guesses from the text.
export function draftingChoice(mode, draft, draftFits) {
  if (mode === 'off') return 'off';
  if (mode === 'mtp') return draft ? 'mtp' : 'ngram';
  if (mode === 'ngram') return 'ngram';
  return draft && draftFits ? 'mtp' : 'ngram';
}

// mode: auto | mtp | ngram | off. Returns { args, mode, draftBytes } (draftBytes: GPU memory the draft needs).
export async function speculativeArgs(model, engine, mode = 'auto', draft = null, draftFits = false) {
  const none = { args: [], mode: '', draftBytes: 0 };
  if (!engine?.path) return none;
  const want = draftingChoice(mode, draft, draftFits);
  if (want === 'off') return none;
  const help = await engineHelp(engine.path);
  const ngram = /ngram-simple/.test(help);
  if (want === 'mtp' && /draft-mtp/.test(help) && /--spec-draft-model/.test(help)) {
    return { args: ['--spec-draft-model', draft.path, '--spec-type', 'draft-mtp', '--spec-draft-n-max', '3'], mode: 'mtp', draftBytes: draft.size };
  }
  return ngram ? { args: ['--spec-type', 'ngram-simple'], mode: 'ngram', draftBytes: 0 } : none;
}
