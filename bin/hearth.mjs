#!/usr/bin/env node
// The `hearth` terminal command:
//   hearth start      start Hearth and open its window (the same as the launcher)
//   hearth serve      start without opening a window (for servers and scripts)
//   hearth status     what is running, and where
//   hearth connect    setup lines for Claude Code (and the addresses for other apps)
//   hearth stop       stop Hearth and its model
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [cmd = 'start', ...rest] = process.argv.slice(2);

async function settings() {
  const { getSettings } = await import('../server/settings.mjs');
  return getSettings();
}

async function call(p, opts) {
  const s = await settings();
  try {
    const r = await fetch(`http://127.0.0.1:${s.port}${p}`, { ...opts, signal: AbortSignal.timeout(5000) });
    return await r.json();
  } catch {
    return null;
  }
}

function serve(open) {
  const p = spawn(process.execPath, [path.join(ROOT, 'server', 'index.mjs'), ...(open ? ['--open'] : []), ...rest], { stdio: 'inherit' });
  p.on('exit', (code) => process.exit(code ?? 0));
}

if (cmd === 'start') serve(true);
else if (cmd === 'serve') serve(false);
else if (cmd === 'status') {
  const st = await call('/api/status');
  if (!st) {
    console.log('Hearth is not running. Start it with: hearth start');
    process.exit(1);
  }
  const e = st.engine;
  console.log(`Hearth ${st.app.version} at ${st.urls.app}`);
  console.log(`Model:  ${e.model ? `${e.model.name} ${e.model.quant || ''} (${e.status}${e.ctx ? `, ${Math.round(e.ctx / 1024)}K context` : ''})` : 'none loaded'}`);
  console.log(`Engine: ${e.engine ? `llama.cpp b${e.engine.build}` : '–'} · ${st.hardware.backendLabel}`);
  console.log(`OpenAI API:    ${st.urls.openai}`);
  console.log(`Anthropic API: ${st.urls.anthropic}`);
} else if (cmd === 'connect') {
  const st = await call('/api/status');
  const s = await settings();
  const base = st?.urls.anthropic || `http://127.0.0.1:${s.port}`;
  const model = st?.alias || 'local-model';
  const ctx = st?.engine?.ctx || s.contextSize;
  const win = process.platform === 'win32';
  const env = (k, v) => (win ? `$env:${k}="${v}"` : `export ${k}="${v}"`);
  console.log(win ? '# Claude Code (PowerShell):' : '# Claude Code:');
  for (const [k, v] of [
    ['ANTHROPIC_BASE_URL', base],
    ['ANTHROPIC_AUTH_TOKEN', s.apiKey],
    ['ANTHROPIC_MODEL', model],
    ['ANTHROPIC_DEFAULT_HAIKU_MODEL', model],
    ['CLAUDE_CODE_MAX_CONTEXT_TOKENS', String(ctx)],
    ['CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', '1'],
  ])
    console.log(env(k, v));
  console.log('claude\n');
  console.log('# Any OpenAI-compatible app:');
  console.log(`Base URL: ${base}/v1\nAPI key:  ${s.apiKey}\nModel:    ${model}`);
  console.log('\nMore apps (Codex, OpenCode, Python…): open Hearth → Connect apps.');
} else if (cmd === 'stop') {
  const r = await call('/api/shutdown', { method: 'POST' });
  console.log(r ? 'Hearth stopped.' : 'Hearth was not running.');
} else {
  console.log('Usage: hearth [start | serve | status | connect | stop]');
  process.exit(1);
}
