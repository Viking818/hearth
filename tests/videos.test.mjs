// Tests for making videos (LTX-2.5 through sd-cli). A stand-in sd-cli records its command line, prints progress like
// the real one (8 first-stage steps, then 3) and writes a video file, so this runs without the 40 GB model.
// Run with: npm test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.HEARTH_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-test-'));
const { DIRS } = await import('../server/settings.mjs');
const vids = await import('../server/videos.mjs');

const skip = process.platform === 'win32';
const log = path.join(DIRS.data, 'sd-calls.log');
const engineDir = path.join(DIRS.images, 'engine');
fs.mkdirSync(engineDir, { recursive: true });
fs.writeFileSync(
  path.join(engineDir, 'sd-cli'),
  `#!/bin/bash
printf '%s\\n' "$*" >> "${log}"
if [ "$1" = "--version" ]; then echo "stable-diffusion.cpp version unknown, commit abc1234"; exit 0; fi
if [ "$1" = "--help" ]; then echo "  --audio-vae <string>   path to standalone LTX audio vae model"; echo "  --diffusion-fa   use flash attention in the diffusion model"; exit 0; fi
mode=""; out=""
while [ $# -gt 0 ]; do case "$1" in -M) mode="$2"; shift;; -o) out="$2"; shift;; esac; shift; done
if [ "$mode" = "convert" ]; then dd if=/dev/zero of="$out" bs=1 count=0 seek=1100000000 2>/dev/null; exit 0; fi
for i in 1 2 3 4 5 6 7 8; do echo "  |==========| $i/8 - 0.01s/it"; done
for i in 1 2 3; do echo "  |==========| $i/3 - 0.01s/it"; done
echo "[INFO ] decoding video frames"
printf 'WEBM' > "$out"
`,
  { mode: 0o755 },
);

const models = path.join(DIRS.videos, 'models');
const files = {
  diffusion: path.join(models, 'ltx-2.5-22b-distilled-UD-Q4_K_XL.gguf'),
  llm: path.join(models, 'gemma4-12b-with-proj-ltx-2.5-q8_0.gguf'),
  vae: path.join(models, 'ltx-2.5-video-vae-conv-bf16.safetensors'),
  audio: path.join(models, 'ltx-2.5-audio-vae-bf16.safetensors'),
  upscaler: path.join(models, 'upscalers', 'ltx-2.5-latent-spatial-upscaler-x2-bf16-1.0.safetensors'),
};

test('the command follows Lightricks’ two-stage recipe for the distilled model', () => {
  const args = vids.videoArgs({ files, prompt: 'a cat', size: 'portrait', seconds: 10, seed: 7, image: '/tmp/start.png', out: '/tmp/v.webm', help: '--diffusion-fa' });
  const val = (k) => args[args.indexOf(k) + 1];
  assert.equal(val('-M'), 'vid_gen');
  assert.equal(val('--sigmas'), '1.0,0.99375,0.9875,0.98125,0.975,0.909375,0.725,0.421875,0.0');
  assert.equal(val('--hires-sigmas'), '0.909375,0.725,0.421875,0.0');
  assert.equal(val('--steps'), '8');
  assert.equal(val('--hires-steps'), '3');
  assert.equal(val('--cfg-scale'), '1');
  assert.deepEqual([val('-W'), val('-H')], ['352', '640']); // half of 704×1280
  assert.equal(val('--video-frames'), '241'); // 10 s at 24 fps, 8n+1
  assert.equal(val('--hires-upscalers-dir'), path.dirname(files.upscaler));
  assert.equal(val('--hires-upscaler'), 'ltx-2.5-latent-spatial-upscaler-x2-bf16-1.0');
  assert.equal(val('-i'), '/tmp/start.png');
  assert.ok(args.includes('--diffusion-fa') && args.includes('--offload-to-cpu') && args.includes('--vae-tiling'));
  for (const [s, f] of Object.entries(vids.VIDEO_LENGTHS)) assert.equal((f - 1) % 8, 0, `${s} s: ${f} frames`);
  for (const [w, h] of Object.values(vids.VIDEO_SIZES)) assert.ok(w % 32 === 0 && h % 32 === 0);
});

test('the big text encoder is shrunk once and then removed', { skip }, async () => {
  fs.mkdirSync(models, { recursive: true });
  const full = path.join(models, 'gemma4-12b-with-proj-ltx-2.5-bf16.safetensors');
  fs.writeFileSync(full, 'big');
  await vids.shrinkTextEncoder(full);
  assert.ok(!fs.existsSync(full), 'the full-size file is gone');
  const made = fs.readdirSync(models).filter((f) => /^gemma4-12b-with-proj-ltx-2\.5-(q8_0|q4_K)\.gguf$/.test(f));
  assert.equal(made.length, 1, `shrunk file: ${fs.readdirSync(models)}`);
  assert.match(fs.readFileSync(log, 'utf8'), /-M convert -m .*bf16\.safetensors --type (q8_0|q4_K) -o .*\.tmp\.gguf/);
});

test('a video is made, followed step by step, and kept in the gallery', { skip }, async () => {
  // The shrunk text encoder from the test above stands in for the llm file.
  for (const f of [files.diffusion, files.vae, files.audio, files.upscaler]) {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, 'x');
  }
  assert.equal((await vids.videosStatus()).ready, true);
  const job = await vids.generateVideo({ prompt: 'a t-shirt unfolds', seconds: 3, size: 'square', seed: 42 });
  assert.equal(job.steps, 11);
  let j;
  for (let i = 0; i < 200; i++) {
    j = vids.videoJob();
    if (j.state === 'done' || j.state === 'error') break;
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.equal(j.state, 'done', j.error);
  const g = vids.videoGallery();
  assert.equal(g.length, 1);
  assert.equal(g[0].name, j.video);
  assert.equal(g[0].url, `/videos/${j.video}`);
  assert.deepEqual([g[0].width, g[0].height, g[0].seconds, g[0].seed], [960, 960, 3, 42]);
  assert.match(fs.readFileSync(log, 'utf8'), /--video-frames 73 /);
  assert.ok(vids.videoPath(j.video));
  assert.equal(vids.videoPath('../settings.json'), '');
  assert.ok(vids.deleteVideo(j.video));
  assert.equal(vids.videoGallery().length, 0);
});

test('a picture engine from before LTX-2.5 is not ready for videos', { skip }, async () => {
  const bin = path.join(engineDir, 'sd-cli');
  const real = fs.readFileSync(bin, 'utf8');
  // The status reads the engine's help once; a fresh copy of the module reads it again.
  fs.writeFileSync(bin, real.replace(/echo "  --audio-vae[^\n]*"; /, ''), { mode: 0o755 });
  try {
    const fresh = await import(`../server/videos.mjs?old=${Date.now()}`);
    const st = await fresh.videosStatus();
    assert.equal(st.ready, false);
    assert.equal(st.engine, false, 'counts as missing, so the Install button shows and brings the newest engine');
  } finally {
    fs.writeFileSync(bin, real, { mode: 0o755 });
  }
});

test('weights are copied to ordinary memory on a PC, but not on a Mac with an engine that places them itself', () => {
  const newHelp = '  --sigmas  preset: hyperflow-h3-flash-4, hyperflow-h3-flash-6';
  assert.equal(vids.wantsOffload({ unified: false }, newHelp), true, 'a PC with a graphics card: as before');
  assert.equal(vids.wantsOffload({ unified: true }, '  --audio-vae'), true, 'a Mac with the older engine: as before');
  assert.equal(vids.wantsOffload({ unified: true }, newHelp), false, 'a Mac with the newer engine');
  assert.equal(vids.wantsOffload(null, ''), true);
  assert.ok(vids.videoArgs({ files, prompt: 'x', out: '/tmp/v.webm' }).includes('--offload-to-cpu'));
  assert.ok(!vids.videoArgs({ files, prompt: 'x', out: '/tmp/v.webm', offload: false }).includes('--offload-to-cpu'));
  const ref = { diffusion: 'd', llm: 'l', vae: 'v', audio: 'a' };
  assert.ok(vids.refVideoArgs({ files: ref, prompt: 'x', refs: ['/tmp/r.png'], out: '/tmp/v.webm' }).includes('--offload-to-cpu'));
  const lean = vids.refVideoArgs({ files: ref, prompt: 'x', refs: ['/tmp/r.png'], out: '/tmp/v.webm', offload: false });
  assert.ok(!lean.includes('--offload-to-cpu'));
  assert.equal(lean[lean.indexOf('-r') + 1], '/tmp/r.png');
});

test('two photos: the video starts on the first and ends on the second', { skip }, async () => {
  const args = vids.videoArgs({ files, prompt: 'a cat', image: '/tmp/a.png', end: '/tmp/b.png', out: '/tmp/v.webm', help: '' });
  assert.equal(args[args.indexOf('-i') + 1], '/tmp/a.png');
  assert.equal(args[args.indexOf('--end-img') + 1], '/tmp/b.png');
  // An end without a start means nothing to this model: it is left out.
  assert.ok(!vids.videoArgs({ files, prompt: 'a cat', end: '/tmp/b.png', out: '/tmp/v.webm' }).includes('--end-img'));

  const png = `data:image/png;base64,${Buffer.from('not really a png').toString('base64')}`;
  const jpg = `data:image/jpeg;base64,${Buffer.from('not really a jpeg').toString('base64')}`;
  fs.writeFileSync(log, '');
  const job = await vids.generateVideo({ prompt: 'the shirt turns around', seconds: 3, size: 'wide', seed: 1, use: 'frames', photos: [{ image: png }, { image: jpg }, { image: png }] });
  assert.deepEqual([job.fromPicture, job.toPicture, job.refs], [true, true, 0]);
  let j;
  for (let i = 0; i < 200; i++) {
    j = vids.videoJob();
    if (j.state === 'done' || j.state === 'error') break;
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.equal(j.state, 'done', j.error);
  const call = fs.readFileSync(log, 'utf8');
  assert.match(call, /-i \S+start-1\.png --end-img \S+end-2\.jpg/, 'the first is the start, the second the end, a third is ignored');
  assert.ok(!call.includes(' -r '));
  const g = vids.videoGallery()[0];
  assert.deepEqual([g.fromPicture, g.toPicture, g.width, g.height], [true, true, 1280, 704]);
  vids.deleteVideo(g.name);

  // The old way of sending one start picture still works; a bad picture is refused before anything starts.
  const one = await vids.generateVideo({ prompt: 'x', image: png });
  assert.deepEqual([one.fromPicture, one.toPicture], [true, false]);
  for (let i = 0; i < 200 && !['done', 'error'].includes(vids.videoJob().state); i++) await new Promise((r) => setTimeout(r, 25));
  vids.deleteVideo(vids.videoJob().video);
  await assert.rejects(() => vids.generateVideo({ prompt: 'x', photos: [{ image: 'data:text/html;base64,AAAA' }] }), /PNG, JPEG or WebP/);
  await assert.rejects(() => vids.generateVideo({ prompt: 'x', use: 'refs', photos: [{ image: png }] }), /reference photos first/, 'the second model is not installed');
});

test('reference photos: named in the description the way the model knows them', () => {
  const p = vids.refPrompt;
  assert.equal(p('The woman from photo 1 wears the T-shirt from Photo 2.', 2), 'The woman from <Picture 1> wears the T-shirt from <Picture 2>.');
  assert.equal(p('@1 walks into the shop of @2', 2), '<Picture 1> walks into the shop of <Picture 2>');
  assert.equal(p('Женщина с фото 1 в футболке с фото №2', 2), 'Женщина с <Picture 1> в футболке с <Picture 2>');
  assert.equal(p('the cat from <Picture 1> surfs', 1), 'the cat from <Picture 1> surfs', 'already in the model’s own words');
  assert.equal(p('image 1 and picture 2 and pic 3', 3), '<Picture 1> and <Picture 2> and <Picture 3>');
  // A photo that was not added is left as the words it was; so are numbers that are not photos.
  assert.equal(p('photo 1 and photo 3, 2 people, a photo of 1 cat', 2), '<Picture 1> and photo 3, 2 people, a photo of 1 cat');
  // No photo named: all of them are handed to the model up front.
  assert.equal(p('She smiles and winks.', 2), 'Keep the people, objects and places of <Picture 1> and <Picture 2> exactly as they look. She smiles and winks.');
  assert.equal(p('She smiles.', 1), 'Keep the people, objects and places of <Picture 1> exactly as they look. She smiles.');
  assert.equal(p('She smiles.', 0), 'She smiles.');
});

test('reference photos: the second model is found when whole, and makes a video from the photos', { skip }, async () => {
  const bin = path.join(engineDir, 'sd-cli');
  const real = fs.readFileSync(bin, 'utf8');
  const refDir = path.join(models, 'minimax-h3');
  try {
    // Before the model is there (and with an engine that doesn't know it): not ready, and it says what to download.
    const st0 = await vids.videosStatus();
    assert.equal(st0.refs.ready, false);
    assert.equal(st0.refs.max, 4);
    assert.equal(st0.refs.download, vids.REF_FILES.reduce((a, f) => a + f.size, 0));
    assert.ok(st0.refs.download > 35e9 && st0.refs.download < 36e9);

    // The files, at their real sizes (empty space, so nothing is written), and an engine that knows the model.
    fs.mkdirSync(refDir, { recursive: true });
    for (const f of vids.REF_FILES) fs.closeSync(fs.openSync(path.join(refDir, path.basename(f.path)), 'w'));
    for (const f of vids.REF_FILES) fs.truncateSync(path.join(refDir, path.basename(f.path)), f.size);
    fs.writeFileSync(bin, real.replace('echo "  --audio-vae', 'echo "  -r, --ref-image   reference image for Flux Kontext or MiniMax-H3 Ref2VA"; echo "  --audio-vae'), { mode: 0o755 });
    const fresh = await import(`../server/videos.mjs?refs=${Date.now()}`);
    const st = await fresh.videosStatus();
    assert.equal(st.refs.ready, true);
    assert.equal(st.refs.download, 0);
    assert.equal(st.ready, true, 'the first model is still there');

    // A file cut short does not count.
    const one = path.join(refDir, path.basename(vids.REF_FILES[3].path));
    fs.truncateSync(one, vids.REF_FILES[3].size - 1);
    assert.equal((await fresh.videosStatus()).refs.ready, false);
    assert.equal((await fresh.videosStatus()).refs.download, vids.REF_FILES[3].size);
    fs.truncateSync(one, vids.REF_FILES[3].size);

    const png = `data:image/png;base64,${Buffer.from('not really a png').toString('base64')}`;
    await assert.rejects(() => fresh.generateVideo({ prompt: 'she winks', use: 'refs', photos: [] }), /at least one reference photo/);
    fs.writeFileSync(log, '');
    const job = await fresh.generateVideo({ prompt: 'The woman from photo 1 winks in the car from photo 2', seconds: 5, size: 'portrait', seed: 9, use: 'refs', photos: [{ image: png }, { image: png }, { image: png }, { image: png }, { image: png }] });
    assert.deepEqual([job.refs, job.fromPicture, job.steps, job.width, job.height], [4, false, 8, 480, 864], 'four photos at most, one stage of 8 steps');
    let j;
    for (let i = 0; i < 200; i++) {
      j = fresh.videoJob();
      if (j.state === 'done' || j.state === 'error') break;
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.equal(j.state, 'done', j.error);
    const call = fs.readFileSync(log, 'utf8').trim().split('\n').pop();
    assert.match(call, /--diffusion-model \S*minimax-h3\/minimax_h3_ref2va_pruned-Q4_K\.gguf /);
    assert.match(call, /--llm \S*qwen3vl_32b_minimax_h3-Q4_K_M\.gguf /);
    assert.match(call, /-p The woman from <Picture 1> winks in the car from <Picture 2> --cfg-scale 1 --steps 8 -W 480 -H 864 --video-frames 124 --fps 24 /);
    assert.equal(call.match(/ -r \S+ref-\d\.png/g).length, 4);
    assert.ok(!/ -i |--end-img|--hires/.test(call), 'no start frame and no second stage with this model');
    assert.ok(!/flash-attn|diffusion-fa/.test(call), 'no flash attention: it breaks long clips with this model');
    const g = fresh.videoGallery()[0];
    assert.deepEqual([g.refs, g.width, g.height, g.seconds], [4, 480, 864, 5]);
    assert.match(g.model, /^MiniMax-H3/);
    fresh.deleteVideo(g.name);
  } finally {
    fs.writeFileSync(bin, real, { mode: 0o755 });
    fs.rmSync(refDir, { recursive: true, force: true });
  }
});

test('the picture and video engine: which build is here, and when a newer one is worth offering', { skip }, async () => {
  const images = await import('../server/images.mjs');
  const rel = (n, commit) => ({
    tag_name: `master-${n}-${commit}`,
    assets: [
      { name: `sd-master-${commit}-bin-Darwin-macOS-26.7.2-arm64.zip`, size: 100 + n, browser_download_url: `https://example/mac-${n}`, digest: `sha256:${'a'.repeat(64)}` },
      { name: `sd-master-${commit}-bin-win-vulkan-x64.zip`, size: 200 + n, browser_download_url: `https://example/win-${n}` },
      { name: `sd-master-${commit}-bin-win-cpu-x64.zip`, size: 300 + n, browser_download_url: `https://example/cpu-${n}` },
      { name: `cudart-sd-bin-win-cu12-x64.zip`, size: 9, browser_download_url: 'https://example/cudart' },
    ],
  });
  const releases = Array.from({ length: 30 }, (_, i) => rel(1100 - i, i === 12 ? 'abc1234' : `c${String(i).padStart(6, '0')}`));
  // The file for each kind of computer.
  const mac = images.pickEngineAssets(releases, {}, { mac: true, win: false, arm: true });
  assert.equal(mac.length, 30);
  assert.deepEqual([mac[0].tag, mac[0].url, mac[0].size, mac[0].sha256], ['master-1100-c000000', 'https://example/mac-1100', 1200, 'a'.repeat(64)]);
  assert.equal(images.pickEngineAssets(releases, { gpus: [{}] }, { mac: false, win: true })[0].url, 'https://example/win-1100', 'a graphics card: the Vulkan build');
  assert.equal(images.pickEngineAssets(releases, { gpus: [] }, { mac: false, win: true })[0].url, 'https://example/cpu-1100');
  assert.deepEqual(images.pickEngineAssets('nothing', {}), []);

  // The stand-in engine says "commit abc1234": it is release 12 from the top.
  assert.deepEqual(await images.sdEngineBuild(), { tag: '', commit: 'abc1234' });
  const u = await images.sdEngineUpdate({}, { releases: mac });
  assert.deepEqual([u.current, u.latest, u.behind, u.size], ['abc1234', 'master-1100-c000000', 12, 1200]);
  // Only a few builds old: left in peace (new builds come several times a day).
  assert.equal(await images.sdEngineUpdate({}, { releases: mac.slice(5) }), null);
  assert.equal(await images.sdEngineUpdate({}, { releases: mac.slice(12) }), null, 'it is the newest');
  // Not among the releases at all: older than every one of them.
  assert.equal((await images.sdEngineUpdate({}, { releases: mac.slice(0, 11) })).behind, 11);
  assert.equal(await images.sdEngineUpdate({}, { releases: [] }), null);
});

test('updating the engine: the new one takes its place only if it starts; otherwise the old one comes back', { skip }, async () => {
  const images = await import('../server/images.mjs');
  const http = await import('node:http');
  const { execFileSync } = await import('node:child_process');
  const { listDownloads } = await import('../server/downloads.mjs');
  const work = fs.mkdtempSync(path.join(DIRS.data, 'newengine-'));
  // Two downloads: an engine that works (it says it is commit fresh01) and one that does not start.
  const zip = (name, script) => {
    const dir = path.join(work, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'sd-cli'), script, { mode: 0o755 });
    execFileSync('zip', ['-q', '-j', path.join(work, `${name}.zip`), path.join(dir, 'sd-cli')]);
    return fs.readFileSync(path.join(work, `${name}.zip`));
  };
  const good = zip('good', '#!/bin/bash\nif [ "$1" = "--version" ]; then echo "stable-diffusion.cpp version unknown, commit fresh01"; exit 0; fi\necho "  --diffusion-model <string>"; echo "  --audio-vae <string>"\n');
  const bad = zip('bad', '#!/bin/bash\nexit 1\n');
  const srv = http.createServer((req, res) => res.end(req.url === '/good.zip' ? good : bad)).listen(0, '127.0.0.1');
  await new Promise((r) => srv.once('listening', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const finish = async (job) => {
    for (let i = 0; i < 400; i++) {
      const d = listDownloads().find((x) => x.id === job.id);
      if (d.state === 'done' || d.state === 'error') return d;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error('the download did not finish');
  };
  const bin = path.join(engineDir, 'sd-cli');
  const before = fs.readFileSync(bin, 'utf8');
  let told = 0;
  images.onSdEngineChange(() => told++);
  try {
    // The one that does not start: the old engine is back, untouched, and the error says so.
    const failed = await finish(await images.updateSdEngine({ release: { tag: 'master-2000-broken0', name: 'bad.zip', url: `${base}/bad.zip`, size: bad.length, sha256: '' } }));
    assert.equal(failed.state, 'error');
    assert.match(failed.error, /does not start/);
    assert.equal(fs.readFileSync(bin, 'utf8'), before);
    assert.deepEqual(await images.sdEngineBuild(), { tag: '', commit: 'abc1234' });
    assert.equal(told, 0);
    assert.ok(!fs.existsSync(`${engineDir}.old`), 'nothing left lying around');

    // The one that works: it is in place, Hearth knows its name, and the video module is told.
    const done = await finish(await images.updateSdEngine({ release: { tag: 'master-2001-fresh01', name: 'good.zip', url: `${base}/good.zip`, size: good.length, sha256: '' } }));
    assert.equal(done.state, 'done', done.error);
    assert.match(fs.readFileSync(bin, 'utf8'), /fresh01/);
    assert.deepEqual(await images.sdEngineBuild(), { tag: 'master-2001-fresh01', commit: 'fresh01' });
    assert.equal(told, 1);
    assert.ok(!fs.existsSync(`${engineDir}.old`));
    // It is now the newest: nothing to offer.
    assert.equal(await images.sdEngineUpdate({}, { releases: [{ tag: 'master-2001-fresh01', size: 1 }, ...Array.from({ length: 20 }, (_, i) => ({ tag: `master-${1990 - i}-x${i}`, size: 1 }))] }), null);
  } finally {
    srv.close();
    fs.rmSync(path.join(engineDir, 'hearth-engine.json'), { force: true });
    fs.writeFileSync(bin, before, { mode: 0o755 });
  }
});

