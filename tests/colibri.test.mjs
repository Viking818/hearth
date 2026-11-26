// Tests for Colibri, the second engine: downloading its release (checked against its SHA256SUMS), the private Python on
// Windows, linking a model's GGUF, running `coli serve` with Hearth's key, requests put in its dialect, the speed test
// timed from the stream, and stopping it with the engine program it started. A stand-in GitHub and a stand-in `coli`
// (a small Python script) run on this computer: no network, no real model.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

process.env.HEARTH_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-test-'));
const { updateSettings, DIRS } = await import('../server/settings.mjs');
const colibri = await import('../server/colibri.mjs');
const engine = await import('../server/engine.mjs');
const { setModelSettings, getModelSettings } = await import('../server/model-settings.mjs');
const { speedTest } = await import('../server/speedtest.mjs');
const { getDownload } = await import('../server/downloads.mjs');
updateSettings({ language: 'en', autoLoad: false });
const realSys = { ...colibri.sys };
const hasPython = (() => {
  try {
    execFileSync('python3', ['--version']);
    return true;
  } catch {
    return false;
  }
})();
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-colibri-'));
const servers = [];
after(async () => {
  await engine.stopEngine();
  for (const s of servers) s.close();
  Object.assign(colibri.sys, realSys);
});
const until = async (fn, ms = 15000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
};
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// A stand-in for Colibri's launcher: `import` writes the model folder; `serve` answers like coli serve does, starts
// an "engine" program of its own, and writes down every request it gets.
const FAKE_COLI = String.raw`#!/usr/bin/env python3
import sys, os, json, time, argparse, subprocess
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
here = os.path.dirname(os.path.abspath(__file__))
cmd = sys.argv[1]
if cmd == 'import':
    ap = argparse.ArgumentParser(); ap.add_argument('--out'); ap.add_argument('gguf'); a = ap.parse_args(sys.argv[2:])
    if a.gguf.endswith('bad.gguf'):
        print('coli import: unsupported architecture "llama"', file=sys.stderr); sys.exit(2)
    os.makedirs(a.out, exist_ok=True)
    json.dump({'gguf': a.gguf}, open(os.path.join(a.out, 'gguf.json'), 'w'))
    print('imported', a.gguf); sys.exit(0)
ap = argparse.ArgumentParser()
for x in ('--model', '--host', '--port', '--model-id', '--ctx'): ap.add_argument(x)
a = ap.parse_args(sys.argv[2:])
key = os.environ.get('COLI_API_KEY', '')
child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(600)'])
open(os.path.join(here, 'pids.json'), 'w').write(json.dumps({'gateway': os.getpid(), 'engine': child.pid, 'vulkan': os.environ.get('COLI_VULKAN', ''), 'queue_timeout': os.environ.get('COLI_QUEUE_TIMEOUT', '')}))
log = open(os.path.join(here, 'requests.jsonl'), 'a')
class H(BaseHTTPRequestHandler):
    def log_message(self, *x): pass
    def authed(self): return self.headers.get('Authorization') == 'Bearer ' + key
    def send(self, code, obj):
        b = json.dumps(obj).encode(); self.send_response(code); self.send_header('content-type', 'application/json'); self.send_header('content-length', str(len(b))); self.end_headers(); self.wfile.write(b)
    def do_GET(self):
        if not self.authed(): return self.send(401, {'error': {'message': 'Missing or wrong API key'}})
        if self.path == '/health': return self.send(200, {'status': 'ok', 'scheduler': {'active': 0, 'queued': 0}})
        if self.path == '/v1/models': return self.send(200, {'data': [{'id': a.model_id, 'context_length': int(a.ctx or 8192)}]})
        self.send(404, {})
    def do_POST(self):
        if not self.authed(): return self.send(401, {'error': {'message': 'Missing or wrong API key'}})
        body = json.loads(self.rfile.read(int(self.headers['content-length'])))
        log.write(json.dumps(body) + '\n'); log.flush()
        if body.get('model') != a.model_id:
            return self.send(404, {'error': {'message': 'The model "%s" does not exist.' % body.get('model'), 'code': 'model_not_found'}})
        if body.get('frequency_penalty') or body.get('presence_penalty'):
            return self.send(400, {'error': {'message': 'Token penalties are not supported yet.'}})
        words = ['Colibri', ' answers', ' from', ' its', ' experts', '.']
        if body.get('stream'):
            self.send_response(200); self.send_header('content-type', 'text/event-stream'); self.end_headers()
            time.sleep(0.05)
            for w in words:
                self.wfile.write(('data: ' + json.dumps({'choices': [{'index': 0, 'delta': {'content': w}}]}) + '\n\n').encode()); self.wfile.flush(); time.sleep(0.03)
            self.wfile.write(('data: ' + json.dumps({'choices': [], 'usage': {'prompt_tokens': 2000, 'completion_tokens': len(words)}}) + '\n\n').encode())
            self.wfile.write(b'data: [DONE]\n\n'); self.wfile.flush(); return
        self.send(200, {'choices': [{'index': 0, 'message': {'role': 'assistant', 'content': ''.join(words)}}], 'usage': {'prompt_tokens': 2000, 'completion_tokens': len(words)}})
print('[gateway] 8192 tokens of context', flush=True)
ThreadingHTTPServer((a.host, int(a.port)), H).serve_forever()
`;

// A release on a stand-in GitHub: the archive for this computer and its SHA256SUMS.
async function fakeGithub({ damaged = false } = {}) {
  const src = path.join(work, `rel-${crypto.randomBytes(3).toString('hex')}`);
  fs.mkdirSync(path.join(src, 'colibri-v9.9.9'), { recursive: true });
  fs.writeFileSync(path.join(src, 'colibri-v9.9.9', 'coli'), FAKE_COLI);
  fs.writeFileSync(path.join(src, 'colibri-v9.9.9', 'qwen38'), '#!/bin/sh\necho engine\n');
  const archive = path.join(src, 'colibri-v9.9.9-macos-arm64.tar.gz');
  execFileSync('tar', ['-czf', archive, '-C', src, 'colibri-v9.9.9']);
  const bytes = fs.readFileSync(archive);
  const sum = crypto.createHash('sha256').update(damaged ? 'something else' : bytes).digest('hex');
  const srv = http.createServer((req, res) => {
    const base = `http://127.0.0.1:${srv.address().port}`;
    if (req.url === '/repos/JustVugg/colibri/releases/latest') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ tag_name: 'v9.9.9', assets: [{ name: 'colibri-v9.9.9-macos-arm64.tar.gz', size: bytes.length, browser_download_url: `${base}/dl/archive` }, { name: 'colibri-v9.9.9-windows-x86_64.zip', size: 10, browser_download_url: `${base}/dl/other` }, { name: 'SHA256SUMS.txt', size: 100, browser_download_url: `${base}/dl/sums` }] }));
    }
    if (req.url === '/dl/archive') {
      res.writeHead(200, { 'content-type': 'application/gzip', 'content-length': bytes.length });
      return res.end(bytes);
    }
    if (req.url === '/dl/sums') return res.end(`${sum}  colibri-v9.9.9-macos-arm64.tar.gz\n0000000000000000000000000000000000000000000000000000000000000000  colibri-v9.9.9-windows-x86_64.zip\n`);
    res.writeHead(404);
    res.end();
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  servers.push(srv);
  return `http://127.0.0.1:${srv.address().port}`;
}

const install = async (api) => {
  Object.assign(colibri.sys, { platform: 'darwin', arch: 'arm64', api });
  const job = await colibri.installColibri({ gpus: [] });
  return until(() => {
    const j = getDownload(job.id);
    return ['done', 'error'].includes(j?.state) && j;
  });
};

test('requests in llama.cpp’s dialect become Colibri’s', () => {
  const b = colibri.adaptBody({ model: 'local', messages: [], chat_template_kwargs: { enable_thinking: false }, cache_prompt: false, frequency_penalty: 0, presence_penalty: 0.4, top_k: 40 }, 'qwen3.8-flash-next-ud-q2_k_xl');
  assert.equal(b.model, 'qwen3.8-flash-next-ud-q2_k_xl', 'Colibri answers only to the name it was started with');
  assert.equal(b.enable_thinking, false, 'Qwen3.8 on Colibri would otherwise think at full depth every time');
  for (const k of ['chat_template_kwargs', 'cache_prompt', 'frequency_penalty', 'presence_penalty', 'top_k']) assert.ok(!(k in b), k);
  assert.equal(colibri.adaptBody({ chat_template_kwargs: { enable_thinking: true }, reasoning_effort: 'low' }).enable_thinking, undefined, 'the app’s own choice wins');
  assert.equal(colibri.adaptBody({ enable_thinking: true, chat_template_kwargs: { enable_thinking: false } }).enable_thinking, true);
});

test('which models and computers Colibri takes', () => {
  assert.ok(colibri.colibriSupports({ arch: 'qwen4exp', path: 'D:\\models\\Qwen3.8-Flash-Next-UD-Q2_K_XL.gguf' }));
  assert.ok(colibri.colibriSupports({ arch: 'glm-dsa', path: '/m/GLM-5.2-UD-IQ1_S-00001-of-00006.gguf' }));
  assert.ok(!colibri.colibriSupports({ arch: 'llama', path: '/m/llama.gguf' }));
  Object.assign(colibri.sys, { platform: 'win32', arch: 'x64' });
  assert.ok(colibri.assetName({ gpus: [{ vendor: 'amd', vram: 24 * 1024 ** 3 }] }).test('colibri-v2.1.0-windows-x86_64.zip'), 'AMD: CPU + Vulkan build');
  assert.ok(!colibri.assetName({ gpus: [{ vendor: 'amd', vram: 24 * 1024 ** 3 }] }).test('colibri-v2.1.0-windows-x86_64-cuda.zip'));
  assert.ok(colibri.assetName({ gpus: [{ vendor: 'nvidia', vram: 16 * 1024 ** 3 }] }).test('colibri-v2.1.0-windows-x86_64-cuda.zip'));
  Object.assign(colibri.sys, { platform: 'win32', arch: 'arm64' });
  assert.equal(colibri.assetName({}), null);
  Object.assign(colibri.sys, realSys);
});

test('a damaged download is refused, and nothing is installed', async () => {
  const j = await install(await fakeGithub({ damaged: true }));
  assert.equal(j.state, 'error');
  assert.match(j.error, /damaged \(its checksum doesn’t match\)/);
  assert.equal(colibri.installed(), null);
});

test('Windows: the private Python is pointed at Colibri’s folder', async () => {
  const home = path.join(work, 'win-colibri');
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, 'coli'), '# launcher');
  const pyZip = path.join(work, 'python-embed.zip');
  const pyDir = path.join(work, 'py-src');
  fs.mkdirSync(pyDir, { recursive: true });
  fs.writeFileSync(path.join(pyDir, 'python.exe'), 'MZ');
  fs.writeFileSync(path.join(pyDir, 'python313._pth'), 'python313.zip\n.\n\n# Uncomment to run site.main() automatically\n#import site\n');
  execFileSync('zip', ['-qj', pyZip, path.join(pyDir, 'python.exe'), path.join(pyDir, 'python313._pth')]);
  const arc = path.join(work, 'colibri-win.tar.gz');
  execFileSync('tar', ['-czf', arc, '-C', home, 'coli']);
  const sum = crypto.createHash('sha256').update(fs.readFileSync(arc)).digest('hex');
  const realPy = colibri.PYTHON.sha256;
  colibri.PYTHON.sha256 = crypto.createHash('sha256').update(fs.readFileSync(pyZip)).digest('hex');
  Object.assign(colibri.sys, { platform: 'win32', arch: 'x64' });
  try {
    await colibri.setUp({ tag: 'v8.0.0', asset: 'colibri-v8.0.0-windows-x86_64.zip', expected: sum, archive: arc, python: pyZip });
    const ins = colibri.installed();
    assert.equal(ins.tag, 'v8.0.0');
    assert.equal(colibri.pythonCommand(), path.join(DIRS.data, 'colibri', 'python', 'python.exe'));
    const pth = fs.readFileSync(path.join(DIRS.data, 'colibri', 'python', 'python313._pth'), 'utf8').split('\r\n');
    assert.deepEqual(pth.slice(0, 4), ['python313.zip', '.', ins.dir, path.join(ins.dir, 'tools')], 'its own search path: Colibri’s modules and tools');
  } finally {
    colibri.PYTHON.sha256 = realPy;
    Object.assign(colibri.sys, realSys);
    fs.rmSync(path.join(DIRS.data, 'colibri'), { recursive: true, force: true });
  }
});

test('Colibri runs a model: linked once, served with Hearth’s key, requests in its dialect, stopped with its engine', { skip: !hasPython && 'needs python3' }, async () => {
  const j = await install(await fakeGithub());
  assert.equal(j.state, 'done', j.error);
  const ins = colibri.installed();
  assert.equal(ins.tag, 'v9.9.9');
  assert.ok(fs.existsSync(path.join(ins.dir, 'coli')));

  const gguf = path.join(work, 'Qwen3.8-Flash-Next-UD-Q2_K_XL.gguf');
  fs.writeFileSync(gguf, 'GGUF');
  const model = { id: 'qwen38test', name: 'Qwen3.8-Flash-Next', quant: 'UD-Q2_K_XL', path: gguf, arch: 'qwen4exp', size: 4, moe: true, ctxTrain: 262144 };
  setModelSettings(model.id, { engine: 'colibri', ctx: 65536 });
  const st = await engine.startEngine(model);
  assert.equal(st.status, 'ready', st.error);
  assert.equal(st.engine.kind, 'colibri');
  assert.equal(st.engine.tag, 'v9.9.9');
  assert.equal(st.ctx, 65536, 'the context it serves, read back from /v1/models');
  const linked = JSON.parse(fs.readFileSync(path.join(DIRS.data, 'colibri', 'models', model.id, 'gguf.json'), 'utf8'));
  assert.equal(linked.gguf, gguf, 'the GGUF is linked where it is, not copied');

  // Without Hearth's key it answers nobody (a web page in the browser can't use it).
  const plain = await fetch(`http://127.0.0.1:${st.port}/v1/models`);
  assert.equal(plain.status, 401);

  const target = await engine.resolveEngine('');
  assert.equal(target.kind, 'colibri');
  const res = await fetch(`${target.url}/v1/chat/completions`, { method: 'POST', headers: target.headers({ 'content-type': 'application/json' }), body: JSON.stringify(target.adapt({ model: 'local', messages: [{ role: 'user', content: 'hi' }], chat_template_kwargs: { enable_thinking: false }, presence_penalty: 0.5 })) });
  assert.equal(res.status, 200);
  const sent = fs.readFileSync(path.join(ins.dir, 'requests.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(sent.at(-1).enable_thinking, false);
  assert.ok(!('chat_template_kwargs' in sent.at(-1)));

  // The speed test times Colibri's stream (it gives counts, not timings).
  const r = await speedTest(model);
  assert.equal(r.engine, 'colibri');
  assert.equal(r.promptTokens, 2000);
  assert.equal(r.outputTokens, 6);
  assert.ok(r.write > 5 && r.read > 100, JSON.stringify(r));
  assert.equal(getModelSettings(model.id).tests.colibri.write, r.write, 'kept per engine, to compare with llama.cpp');

  // A second load with the same file doesn't link it again.
  const before = fs.statSync(path.join(DIRS.data, 'colibri', 'models', model.id, 'hearth.json')).mtimeMs;
  await engine.stopEngine();
  const pids = JSON.parse(fs.readFileSync(path.join(ins.dir, 'pids.json'), 'utf8'));
  assert.equal(pids.queue_timeout, '3600', 'a request behind an agent’s long turn waits instead of failing');
  await until(() => !alive(pids.gateway) && !alive(pids.engine));
  await engine.startEngine(model);
  assert.equal(fs.statSync(path.join(DIRS.data, 'colibri', 'models', model.id, 'hearth.json')).mtimeMs, before);
  const pids2 = JSON.parse(fs.readFileSync(path.join(ins.dir, 'pids.json'), 'utf8'));
  await engine.stopEngine();
  await until(() => !alive(pids2.gateway) && !alive(pids2.engine)); // the engine program it started goes too
});

test('a model Colibri can’t read says why', { skip: !hasPython && 'needs python3' }, async () => {
  if (!colibri.installed()) {
    const j = await install(await fakeGithub());
    assert.equal(j.state, 'done', j.error);
  }
  const gguf = path.join(work, 'bad.gguf');
  fs.writeFileSync(gguf, 'GGUF');
  const model = { id: 'badmodel1', name: 'Bad', quant: 'Q4_K_M', path: gguf, arch: 'qwen4exp', size: 4 };
  setModelSettings(model.id, { engine: 'colibri' });
  const st = await engine.startEngine(model);
  assert.equal(st.status, 'error');
  assert.match(st.error, /Colibri couldn’t read this model: .*unsupported architecture "llama"/);
});
