#!/usr/bin/env node
// Hearth: run AI models on your own computer.
// One local web server: the app's pages and /api for the app, /v1 for other apps (OpenAI + Anthropic API).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ROOT, DIRS, APP_NAME, APP_VERSION, getSettings, updateSettings, publicSettings, newApiKey, modelsDir } from './settings.mjs';
import { detectHardware, BACKEND_LABELS, backendChoices, readEngineDevices, knownEngineDevices, listEngineDevices } from './hardware.mjs';
import { listLocalModels, findLocalModel, SOURCE_LABELS, linkShared } from './models.mjs';
import { catalogFor, searchHf, repoChoices, hfTree, quantsOf } from './catalog.mjs';
import { startDownload, listDownloads, cancelDownload } from './downloads.mjs';
import { listEngines, latestEngine, installEngine, brokenEngines } from './engine-install.mjs';
import { planModel } from './plan.mjs';
import { startEngine, stopEngine, engineState, engineLogs, cleanupOrphan, killEngineSync, modelAlias, setPrimary } from './engine.mjs';
import { getModelSettings, setModelSettings, effectiveOptions, listPresets, savePreset, deletePreset, MODEL_DEFAULTS } from './model-settings.mjs';
import { speedTest } from './speedtest.mjs';
import { draftingChoice } from './speed.mjs';
import { monitorSnapshot } from './monitor.mjs';
import { handleApi } from './api.mjs';
import { listChats, searchChats, getChat, saveChat, deleteChat, flagChat } from './chats.mjs';
import { listAssistants, saveAssistant, deleteAssistant, resetAssistants, listMemory, addMemory, updateMemory, deleteMemory, clearMemory } from './assistants.mjs';
import { listTools, callTool } from './tools.mjs';
import { stopMcp, ensureMcp, mcpServers, ownConnectors, editOwnConnectors, signInConnector, signOutConnector, useConnectorToken, oauthCallback } from './mcp.mjs';
import { listSkills, publicSkill, getSkill, saveOwnSkill, setSkillEnabled, deleteSkill, listPlugins, publicPlugin, updatePlugin, removePlugin, listCommands, saveCommand, setCommandEnabled, deleteCommand, slashMenu } from './extensions.mjs';
import { inspect as inspectExtension, install as installExtension } from './ext-install.mjs';
import { listBatches, getBatch, createBatch, stopBatch, resumeBatch, editBatchCell, deleteBatch, resumeUnfinished } from './batch.mjs';
import { voiceStatus, installVoice, transcribe, stopVoice, videoSpeech } from './voice.mjs';
import { imagesStatus, installImages, generateImages, cancelImages, jobStatus, gallery, imagePath, deleteImage, updateSdEngine } from './images.mjs';
import { videosStatus, installVideos, generateVideo, cancelVideos, videoJob, videoGallery, videoPath, videoPlayPath, deleteVideo } from './videos.mjs';
import { updatesState, checkUpdates, scheduleUpdateChecks } from './updates.mjs';
import { pairedDevice, lanHostOk, lanAddresses, pair, phoneInfo, setPhoneAccess, resetDevices, forgetDevice } from './phone.mjs';
import { runWithLang, t } from './i18n.mjs';
import { teeConsole, readServerLog } from './log.mjs';
import { sendJson, sendError, readBody, saveBody, readJsonBody, isLoopback, uid, portFree, run, IS_MAC, IS_WIN, exists, readJson, sleep } from './util.mjs';
import { holdInstance, askInstance, releaseInstance } from './instance.mjs';
import { listBots, getBot, publicBot, createBot, saveBot, deleteBot, templates, listTasks, getTask, saveTask, deleteTask, workFiles, workFolder } from './bots.mjs';
import { startTask, stopTask, taskView, forgetBot, forgetTask, activity, runScheduleNow, resumeBots } from './agent.mjs';
import { connectTelegram, disconnectTelegram, forgetOwner, syncTelegram, stopTelegram } from './telegram.mjs';
import { forRead } from './workfiles.mjs';
import { directory, connectFromDirectory, fixMovedConnectors } from './directory.mjs';
import { startPower, stopPower, powerState, setStartAtLogin, awakeChanged } from './power.mjs';
import { colibriState, installColibri, colibriSupports } from './colibri.mjs';
import { listArtifacts, getArtifact, saveArtifact, updateArtifact, deleteArtifact, artifactDoc, SANDBOX_HEADERS, getBrand, saveBrand } from './artifacts.mjs';

const argv = process.argv.slice(2);
const OPEN = argv.includes('--open');
const PORT_ARG = Number(argv[argv.indexOf('--port') + 1]) || 0;

const STATIC = path.join(ROOT, 'public');
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.wav': 'audio/wav',
  '.woff2': 'font/woff2',
  '.json': 'application/json',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
};

let port = 0;
let server = null;
// Set at startup: the real GPU memory, read from the engine. Fit labels wait for it so they never use the guess.
let devicesReady = Promise.resolve();

// Videos are played with seeking, which browsers do with Range requests ("bytes=1000-", "bytes=-500").
function serveVideo(req, res, file) {
  let size;
  try {
    size = fs.statSync(file).size;
  } catch {
    return sendError(res, 404, 'Not found');
  }
  const head = { 'content-type': TYPES[path.extname(file).toLowerCase()] || 'video/webm', 'accept-ranges': 'bytes', 'cache-control': 'max-age=31536000', 'x-content-type-options': 'nosniff' };
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (!m || (m[1] === '' && m[2] === '')) {
    res.writeHead(200, { ...head, 'content-length': size });
    return fs.createReadStream(file).pipe(res);
  }
  const start = m[1] === '' ? Math.max(0, size - Number(m[2])) : Number(m[1]);
  const end = m[1] !== '' && m[2] !== '' ? Math.min(size - 1, Number(m[2])) : size - 1;
  if (start >= size || start > end) {
    res.writeHead(416, { 'content-range': `bytes */${size}` });
    return res.end();
  }
  res.writeHead(206, { ...head, 'content-length': end - start + 1, 'content-range': `bytes ${start}-${end}/${size}` });
  fs.createReadStream(file, { start, end }).pipe(res);
}

// What a chat may hold: pictures (shown, and sent to a model that sees) and videos (played; the model gets frames).
const UPLOAD_IMAGE = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif' };
const UPLOAD_VIDEO = { 'video/mp4': '.mp4', 'video/x-m4v': '.m4v', 'video/quicktime': '.mov', 'video/webm': '.webm' };
const UPLOAD_VIDEO_EXT = /\.(mp4|m4v|mov|webm)$/i;
const MAX_VIDEO_UPLOAD = 2 * 1024 ** 3;

async function heicToJpeg(buf, stamp) {
  const src = path.join(DIRS.uploads, `${stamp}.heic`);
  const name = `${stamp}.jpg`;
  const dest = path.join(DIRS.uploads, name);
  try {
    fs.writeFileSync(src, buf);
    await run('/usr/bin/sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '90', src, '--out', dest], { timeout: 30000 });
    // A phone photo is far bigger than a model looks at; a small one is left as it is (-Z would blow it up).
    const side = Math.max(...[...(await run('/usr/bin/sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', dest])).matchAll(/pixel(?:Width|Height): (\d+)/g)].map((x) => Number(x[1])), 0);
    if (side > 2400) await run('/usr/bin/sips', ['-Z', '2400', dest], { timeout: 30000 });
    const size = fs.existsSync(dest) ? fs.statSync(dest).size : 0;
    return size ? { name, size } : null;
  } catch {
    return null;
  } finally {
    fs.rmSync(src, { force: true });
  }
}

function serveFile(res, file, cache = 'no-cache') {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return sendError(res, 404, 'Not found');
    res.writeHead(200, { 'content-type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', 'content-length': st.size, 'cache-control': cache });
    fs.createReadStream(file).pipe(res);
  });
}

function urls() {
  const s = getSettings();
  const base = `http://127.0.0.1:${port}`;
  return { app: base, openai: `${base}/v1`, anthropic: base, lan: s.access === 'lan' ? lanAddresses().map((ip) => `http://${ip}:${port}`) : [] };
}

// Other devices may reach Hearth when the API is shared on the network or phones are allowed.
const listenHost = () => (getSettings().access === 'lan' || getSettings().phoneAccess ? '0.0.0.0' : '127.0.0.1');
async function status() {
  const hw = await detectHardware();
  return {
    app: { name: APP_NAME, version: APP_VERSION, node: process.version, platform: process.platform },
    engine: engineState(),
    settings: publicSettings(),
    hardware: { ...hw, backendLabel: BACKEND_LABELS[hw.backend] },
    urls: urls(),
    alias: engineState().model ? modelAlias(engineState().model) : getSettings().lastModel ? modelAlias(getSettings().lastModel) : '',
    bots: botsSummary(),
  };
}

// For the sidebar: is a bot working, and how many finished tasks nobody has looked at yet.
function botsSummary() {
  let unread = 0;
  for (const b of listBots()) unread += listTasks(b.id).filter((k) => k.unread).length;
  return { working: Boolean(activity().running), unread };
}

function botCard(b, act) {
  const tasks = listTasks(b.id);
  return { ...publicBot(b), working: act.running?.botId === b.id, tasks: tasks.length, unread: tasks.filter((k) => k.unread).length, last: tasks[0] || null };
}

// Opening a bot's file with its usual program: only kinds that are documents, never ones that would run.
const SAFE_OPEN = /\.(txt|md|markdown|csv|tsv|json|xlsx|xls|docx|doc|pptx|odt|ods|pdf|html?|png|jpe?g|webp|gif|svg|mp3|mp4|webm|wav)$/i;
function openPath(p) {
  if (IS_MAC) spawn('open', [p], { detached: true, stdio: 'ignore' }).unref();
  else if (IS_WIN) spawn('explorer', [p], { detached: true, stdio: 'ignore' }).unref();
  else spawn('xdg-open', [p], { detached: true, stdio: 'ignore' }).unref();
}

// The engines on this computer for the Models page: which type is chosen, the newest build of it, the downloads that
// don't start (and why), and for each engine whether it sees the graphics card (gpu: true, false or null = not known).
async function enginesInfo(asked) {
  const hw = await detectHardware();
  const backend = asked || getSettings().engineBackend || hw.backend;
  let latest = null;
  let latestError = '';
  try {
    latest = await latestEngine(hw, backend);
  } catch (err) {
    latestError = String(err.message || err);
  }
  const engines = (await listEngines()).map((e) => {
    const seen = knownEngineDevices(e.path);
    // Not checked yet: ask the chosen type in the background, the page asks again in a moment.
    if (!seen && e.backend === backend && !hw.unified) listEngineDevices(e.path).catch(() => {});
    return { ...e, gpu: seen ? seen.devices.length > 0 : null, gpuNote: seen?.note || '' };
  });
  return { engines, broken: brokenEngines(), latest, latestError, backend, recommended: hw.backend, choices: backendChoices(hw), labels: BACKEND_LABELS };
}

// The memory plan for one model with its own settings (or settings the page is trying out).
function planFor(hw, model, settings) {
  const o = effectiveOptions(model, hw, settings || getModelSettings(model.id));
  const base = { ctx: o.ctx, vision: o.vision, kv: o.kv, visionCpu: o.visionCpu, margin: o.margin, lowRam: o.lowRam };
  const draftFits = Boolean(o.draft) && planModel(hw, model, { ...base, draftBytes: o.draft.size }).mode === 'gpu';
  const drafting = draftingChoice(o.drafting, o.draft, draftFits);
  return { plan: planModel(hw, model, { ...base, draftBytes: drafting === 'mtp' ? o.draft.size : 0 }), options: { ...o, draftingUses: drafting } };
}

async function localModelsWithFit() {
  await devicesReady;
  const hw = await detectHardware();
  return listLocalModels(true).map(({ meta, ...m }) => ({
    ...m,
    sourceLabel: m.source === 'folder' ? t('Your folder') : m.source === 'huggingface' ? t('Hugging Face cache') : SOURCE_LABELS[m.source] || m.source,
    vision: Boolean(m.mmproj),
    fit: planFor(hw, { ...m, meta }).plan,
  }));
}

function hfUrl(repo, file) {
  return `https://huggingface.co/${repo}/resolve/main/${file.split('/').map(encodeURIComponent).join('/')}`;
}

async function downloadModel({ repo, quant, vision = true }) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo || '')) throw Object.assign(new Error(t('Bad repo name')), { status: 400 });
  const { quants, mmproj } = quantsOf(await hfTree(repo));
  const q = quants.find((x) => x.quant === quant);
  if (!q) throw Object.assign(new Error(t('{quant} not found in {repo}', { quant, repo })), { status: 404 });
  const tree = await hfTree(repo);
  const sizeOf = (p) => tree.find((f) => f.path === p)?.size || 0;
  const [owner, name] = repo.split('/');
  const root = path.join(modelsDir(), owner, name);
  const token = getSettings().hfToken;
  const headers = token ? { authorization: `Bearer ${token}` } : {};
  const files = q.files.map((f) => ({ url: hfUrl(repo, f), dest: path.join(root, ...f.split('/')), size: sizeOf(f), headers }));
  // A file every size shares (DeepSeek-V4.1's Engram tables) is downloaded once and skipped when it is already here.
  if (q.shared) files.push({ url: hfUrl(repo, q.shared.from), dest: path.join(root, ...q.shared.from.split('/')), size: q.shared.size, headers });
  if (vision && mmproj) files.push({ url: hfUrl(repo, mmproj.path), dest: path.join(root, ...mmproj.path.split('/')), size: mmproj.size, headers });
  return startDownload({
    kind: 'model',
    label: `${name.replace(/-GGUF$/i, '')} ${quant}`,
    meta: { repo, quant },
    files,
    onDone: async () => {
      if (q.shared) linkShared(path.join(root, ...q.shared.from.split('/')), path.join(root, ...q.shared.as.split('/')));
      listLocalModels(true);
    },
  });
}

function deleteModel(id) {
  const m = findLocalModel(id);
  if (!m) throw Object.assign(new Error(t('Model not found')), { status: 404 });
  if (m.source !== 'hearth') throw Object.assign(new Error(t('This model belongs to {app}. Delete it there.', { app: SOURCE_LABELS[m.source] })), { status: 400 });
  if (engineState().loaded.some((r) => r.model?.id === id)) throw Object.assign(new Error(t('Stop the model before deleting it.')), { status: 409 });
  const split = /-(\d{5})-of-(\d{5})\.gguf$/i.exec(m.path);
  const parts = split
    ? Array.from({ length: Number(split[2]) }, (_, i) => m.path.replace(/-\d{5}-of-(\d{5})\.gguf$/i, `-${String(i + 1).padStart(5, '0')}-of-$1.gguf`))
    : [m.path];
  for (const p of parts) fs.rmSync(p, { force: true });
  // Remove the image helper and empty folders once no model of that repo is left.
  const repoDir = m.repo ? path.join(modelsDir(), ...m.repo.split('/')) : path.dirname(m.path);
  const left = listLocalModels(true).filter((x) => x.path.startsWith(repoDir + path.sep));
  if (!left.length && repoDir.startsWith(modelsDir() + path.sep)) fs.rmSync(repoDir, { recursive: true, force: true });
  listLocalModels(true);
}

async function pickFolder(prompt = t('Choose a folder the model may read')) {
  if (IS_MAC) return (await run('osascript', ['-e', `POSIX path of (choose folder with prompt ${JSON.stringify(prompt)})`], { timeout: 300000 })).trim().replace(/\/$/, '');
  if (IS_WIN) {
    const ps = `Add-Type -AssemblyName System.Windows.Forms; $f = New-Object System.Windows.Forms.FolderBrowserDialog; $f.Description = ${JSON.stringify(prompt)}; if ($f.ShowDialog() -eq 'OK') { $f.SelectedPath }`;
    return (await run('powershell', ['-NoProfile', '-STA', '-Command', ps], { timeout: 300000 })).trim();
  }
  return (await run('zenity', ['--file-selection', '--directory', `--title=${prompt}`], { timeout: 300000 })).trim();
}

function reveal(p) {
  if (!p || !exists(p)) return;
  if (IS_MAC) spawn('open', ['-R', p], { detached: true, stdio: 'ignore' }).unref();
  else if (IS_WIN) spawn('explorer', [`/select,${p}`], { detached: true, stdio: 'ignore' }).unref();
  else spawn('xdg-open', [fs.statSync(p).isDirectory() ? p : path.dirname(p)], { detached: true, stdio: 'ignore' }).unref();
}

// Sends one plain prompt and one tool call through Hearth's own API, like a coding tool would.
async function connectCheck(api) {
  const base = `http://127.0.0.1:${port}`;
  const steps = [];
  const headers = { 'content-type': 'application/json', 'x-hearth-client': 'Connect check', 'x-api-key': getSettings().apiKey, authorization: `Bearer ${getSettings().apiKey}` };
  const time = async (name, fn) => {
    const t = Date.now();
    try {
      const detail = await fn();
      steps.push({ name, ok: true, ms: Date.now() - t, detail });
    } catch (err) {
      steps.push({ name, ok: false, ms: Date.now() - t, detail: String(err.message || err) });
    }
  };
  const weatherTool = { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] };
  const ask = 'What is the weather in Paris right now? Use the get_weather tool.';
  if (api === 'anthropic') {
    const post = async (body) => {
      const r = await fetch(`${base}/v1/messages`, { method: 'POST', headers: { ...headers, 'anthropic-version': '2023-06-01' }, body: JSON.stringify({ model: 'local', max_tokens: 400, ...body }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error?.message || `HTTP ${r.status}`);
      return j;
    };
    await time(t('Reply to a message'), async () => {
      const j = await post({ messages: [{ role: 'user', content: 'Reply with just the word: ready' }] });
      const text = (j.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('').trim();
      if (!text) throw new Error(t('Empty answer'));
      return text.slice(0, 80);
    });
    await time(t('Call a tool'), async () => {
      const j = await post({ tools: [{ name: 'get_weather', description: 'Current weather for a city', input_schema: weatherTool }], messages: [{ role: 'user', content: ask }] });
      const call = (j.content || []).find((c) => c.type === 'tool_use');
      if (!call) throw new Error(t('The model answered without calling the tool'));
      return `${call.name}(${JSON.stringify(call.input)})`;
    });
  } else {
    const post = async (body) => {
      const r = await fetch(`${base}/v1/chat/completions`, { method: 'POST', headers, body: JSON.stringify({ model: 'local', max_tokens: 400, ...body }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error?.message || `HTTP ${r.status}`);
      return j;
    };
    await time(t('Reply to a message'), async () => {
      const j = await post({ messages: [{ role: 'user', content: 'Reply with just the word: ready' }] });
      const text = (j.choices?.[0]?.message?.content || '').trim();
      if (!text) throw new Error(t('Empty answer'));
      return text.slice(0, 80);
    });
    await time(t('Call a tool'), async () => {
      const j = await post({ tools: [{ type: 'function', function: { name: 'get_weather', description: 'Current weather for a city', parameters: weatherTool } }], messages: [{ role: 'user', content: ask }] });
      const call = j.choices?.[0]?.message?.tool_calls?.[0];
      if (!call) throw new Error(t('The model answered without calling the tool'));
      return `${call.function.name}(${call.function.arguments})`;
    });
  }
  return { ok: steps.every((s) => s.ok), steps };
}

// This computer may drive the app; so may phones and tablets the user paired (Settings → Phone access).
// Everything else on the network only gets /v1 with the API key.
function appAllowed(req) {
  const host = String(req.headers.host || '').toLowerCase();
  const local = isLoopback(req.socket.remoteAddress) && /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host); // blocks DNS-rebinding tricks
  const device = !local && lanHostOk(host) && pairedDevice(req);
  if (!local && !device) return false;
  if (req.method !== 'GET' && req.headers.origin) {
    try {
      const o = new URL(req.headers.origin);
      // Another website posting here, or a page of another program on this computer (same name, another port).
      if (o.host.toLowerCase() !== host) return false;
    } catch {
      return false;
    }
  }
  return true;
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  try {
    if (p.startsWith('/v1/')) return await handleApi(req, res, url);
    if (p === '/api/ping') return sendJson(res, 200, { app: 'hearth', version: APP_VERSION });
    // A phone opening the pairing link from the QR code.
    if (p === '/api/pair' && req.method === 'POST') {
      if (!getSettings().phoneAccess || !lanHostOk(req.headers.host)) return sendError(res, 403, t('Phone access is off on the computer.'));
      const { token } = await readJsonBody(req);
      const r = pair(req, res, String(token || ''));
      return r.ok ? sendJson(res, 200, { ok: true }) : sendError(res, r.status, r.status === 429 ? t('Too many tries. Wait a minute.') : t('This pairing code is not valid any more. Scan the code on the computer again.'));
    }
    // The browser coming back from a connector's sign-in page (the address Hearth registered with the service).
    if (p === '/oauth/callback' && req.method === 'GET') return await oauthCallback(req, res, url);
    if (p.startsWith('/api/') || p.startsWith('/uploads/') || p.startsWith('/images/') || p.startsWith('/videos/')) {
      if (!appAllowed(req)) {
        const phone = getSettings().phoneAccess && lanHostOk(req.headers.host);
        return sendError(res, phone ? 401 : 403, phone ? t('Pair this device first: scan the QR code in Hearth → Settings on the computer.') : t('Hearth can only be controlled from this computer.'), phone ? { code: 'PAIR' } : {});
      }
      return await handleAppApi(req, res, url);
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendError(res, 405, 'Method not allowed');
    const local = isLoopback(req.socket.remoteAddress);
    if (!local && !(getSettings().phoneAccess && lanHostOk(req.headers.host))) return sendError(res, 403, t('Open Hearth on the computer it runs on. Other devices can use the API at /v1.'));
    const file = p === '/' ? 'index.html' : decodeURIComponent(p).replace(/^\/+/, '');
    const full = path.normalize(path.join(STATIC, file));
    if (!full.startsWith(STATIC + path.sep)) return sendError(res, 403, 'Forbidden');
    if (!exists(full) && !path.extname(full)) return serveFile(res, path.join(STATIC, 'index.html'));
    return serveFile(res, full, /\.(woff2|png|svg)$/.test(full) || full.includes(`${path.sep}vendor${path.sep}`) ? 'max-age=86400' : 'no-cache');
  } catch (err) {
    if (!err.status) console.error(`${req.method} ${p}:`, err); // unexpected: keep it in the log
    if (!res.headersSent) sendError(res, err.status || 500, err.message || String(err), err.code ? { code: err.code, model: err.model } : {});
    else res.end();
  }
}

async function handleAppApi(req, res, url) {
  const p = url.pathname;
  const m = req.method;
  const seg = p.split('/').filter(Boolean); // ['api', 'chats', id]

  if (m === 'GET' && p.startsWith('/uploads/')) {
    const f = path.join(DIRS.uploads, path.basename(p));
    return UPLOAD_VIDEO_EXT.test(f) ? serveVideo(req, res, f) : serveFile(res, f, 'max-age=31536000');
  }
  if (m === 'GET' && p.startsWith('/images/')) {
    const f = imagePath(decodeURIComponent(p.slice(8)));
    return f ? serveFile(res, f, 'max-age=31536000') : sendError(res, 404, t('Not found'));
  }
  if (m === 'GET' && p.startsWith('/videos/')) {
    // /videos/play/…: the picture and the sound apart, for browsers that can't play the video as it was made.
    const rel = decodeURIComponent(p.slice(8));
    const f = rel.startsWith('play/') ? videoPlayPath(rel.slice(5)) : videoPath(rel);
    return f ? serveVideo(req, res, f) : sendError(res, 404, t('Not found'));
  }

  if (m === 'GET' && p === '/api/status') return sendJson(res, 200, await status());
  if (m === 'GET' && p === '/api/hardware') return sendJson(res, 200, await detectHardware(url.searchParams.has('refresh')));

  // Models on this computer and from Hugging Face
  if (m === 'GET' && p === '/api/models') return sendJson(res, 200, { models: await localModelsWithFit(), modelsDir: modelsDir() });
  if (m === 'GET' && p === '/api/catalog') {
    await devicesReady;
    const hw = await detectHardware();
    return sendJson(res, 200, { catalog: await catalogFor(hw, listLocalModels()) });
  }
  if (m === 'GET' && p === '/api/hf/search') return sendJson(res, 200, { results: await searchHf(url.searchParams.get('q') || '') });
  if (m === 'GET' && p === '/api/hf/repo') return sendJson(res, 200, await repoChoices(url.searchParams.get('repo') || '', await detectHardware()));
  if (m === 'POST' && p === '/api/models/download') return sendJson(res, 200, await downloadModel(await readJsonBody(req)));
  if (m === 'DELETE' && seg[1] === 'models' && seg[2]) {
    deleteModel(seg[2]);
    return sendJson(res, 200, { ok: true });
  }
  if (m === 'POST' && p === '/api/reveal') {
    const { id, what } = await readJsonBody(req);
    if (what === 'models') reveal(modelsDir());
    else if (what === 'data') reveal(DIRS.data);
    else {
      const model = findLocalModel(id);
      if (model) reveal(model.path);
    }
    return sendJson(res, 200, { ok: true });
  }

  // Engine
  if (m === 'POST' && p === '/api/engine/start') {
    const { id } = await readJsonBody(req);
    const model = findLocalModel(id);
    if (!model) return sendError(res, 404, 'Model not found');
    startEngine(model).catch(() => {});
    return sendJson(res, 200, engineState());
  }
  if (m === 'POST' && p === '/api/engine/stop') {
    const { id } = await readJsonBody(req);
    await stopEngine(id || undefined);
    return sendJson(res, 200, engineState());
  }
  if (m === 'POST' && p === '/api/engine/primary') return sendJson(res, 200, setPrimary((await readJsonBody(req)).id));

  // One model's own settings, a preview of its memory plan with other settings, and a speed test
  if (seg[1] === 'models' && seg[2] && ['settings', 'plan', 'speedtest'].includes(seg[3])) {
    const model = findLocalModel(seg[2]);
    if (!model) return sendError(res, 404, t('Model not found'));
    await devicesReady;
    const hw = await detectHardware();
    if (seg[3] === 'settings' && m === 'GET') {
      const settings = getModelSettings(model.id);
      const { plan, options } = planFor(hw, model);
      const colibri = { supported: colibriSupports(model), ...(await colibriState(hw)) };
      return sendJson(res, 200, { settings, defaults: MODEL_DEFAULTS, plan, options, general: { contextSize: getSettings().contextSize, vision: getSettings().vision, speculative: getSettings().speculative, multiModel: getSettings().multiModel }, presets: listPresets(), colibri });
    }
    if (seg[3] === 'settings' && m === 'PUT') {
      const body = await readJsonBody(req);
      // Extra engine options start the engine with anything (another address, a file to write): like the ones in
      // Settings, they are changed on the computer itself, never from a paired phone.
      if (!isLoopback(req.socket.remoteAddress)) delete body.args;
      const settings = setModelSettings(model.id, body);
      return sendJson(res, 200, { settings, ...planFor(hw, model) });
    }
    if (seg[3] === 'plan' && m === 'POST') {
      const body = await readJsonBody(req);
      return sendJson(res, 200, planFor(hw, model, { ...getModelSettings(model.id), ...body }));
    }
    if (seg[3] === 'speedtest' && m === 'POST') return sendJson(res, 200, await speedTest(model));
  }

  // Saved settings
  if (m === 'GET' && p === '/api/presets') return sendJson(res, 200, { presets: listPresets() });
  if (m === 'POST' && p === '/api/presets') {
    const { name, settings } = await readJsonBody(req);
    if (settings && typeof settings === 'object' && !isLoopback(req.socket.remoteAddress)) delete settings.args; // as above
    return sendJson(res, 200, savePreset(name, settings));
  }
  if (m === 'DELETE' && seg[1] === 'presets' && seg[2]) {
    deletePreset(seg[2]);
    return sendJson(res, 200, { presets: listPresets() });
  }
  if (m === 'GET' && p === '/api/engine') return sendJson(res, 200, engineState());
  // Colibri, the second engine (colibri.mjs): whether it is here, and downloading it (only on the computer itself).
  if (m === 'GET' && p === '/api/colibri') return sendJson(res, 200, await colibriState(await detectHardware()));
  if (m === 'POST' && p === '/api/colibri/install') {
    if (!isLoopback(req.socket.remoteAddress)) return sendError(res, 403, t('Change this on the computer itself.'));
    await devicesReady;
    return sendJson(res, 200, await installColibri(await detectHardware()));
  }
  if (m === 'GET' && p === '/api/engine/logs') return sendJson(res, 200, { logs: engineLogs(Number(url.searchParams.get('n')) || 400) });
  if (m === 'GET' && p === '/api/logs/hearth') return sendJson(res, 200, { lines: readServerLog(Number(url.searchParams.get('n')) || 300) });
  if (m === 'GET' && p === '/api/engines') return sendJson(res, 200, await enginesInfo(url.searchParams.get('backend')));
  // The engine type picked on the Models page counts at once (the next load uses it), not only after a download.
  if (m === 'POST' && p === '/api/engines/backend') {
    const { backend } = await readJsonBody(req);
    const hw = await detectHardware();
    if (!backendChoices(hw).includes(backend)) return sendError(res, 400, t('This engine type does not fit this computer.'));
    updateSettings({ engineBackend: backend === hw.backend ? '' : backend });
    return sendJson(res, 200, await enginesInfo(backend));
  }
  if (m === 'POST' && p === '/api/engines/install') {
    const { backend } = await readJsonBody(req);
    const hw = await detectHardware();
    if (backend) updateSettings({ engineBackend: backend === hw.backend ? '' : backend });
    return sendJson(res, 200, await installEngine(hw, backend || getSettings().engineBackend || hw.backend));
  }

  // Downloads
  if (m === 'GET' && p === '/api/downloads') return sendJson(res, 200, { downloads: listDownloads() });
  if (m === 'DELETE' && seg[1] === 'downloads' && seg[2]) return sendJson(res, 200, { ok: cancelDownload(seg[2]) });

  // Monitor
  if (m === 'GET' && p === '/api/monitor') return sendJson(res, 200, await monitorSnapshot());

  // Chats
  if (m === 'GET' && p === '/api/chats') {
    const q = url.searchParams.get('q');
    return sendJson(res, 200, q ? { results: searchChats(q) } : { chats: listChats() });
  }
  if (seg[1] === 'chats' && seg[2] && seg[3] === 'flags' && m === 'POST') {
    const c = flagChat(seg[2], await readJsonBody(req));
    return c ? sendJson(res, 200, c) : sendError(res, 404, 'Chat not found');
  }
  if (seg[1] === 'chats' && seg[2] && !seg[3]) {
    if (m === 'GET') {
      const c = getChat(seg[2]);
      return c ? sendJson(res, 200, c) : sendError(res, 404, 'Chat not found');
    }
    if (m === 'PUT') return sendJson(res, 200, saveChat(seg[2], await readJsonBody(req, 128 << 20)));
    if (m === 'DELETE') return sendJson(res, 200, { ok: deleteChat(seg[2]) });
  }

  // Assistants and Memory
  if (m === 'GET' && p === '/api/assistants') return sendJson(res, 200, { assistants: listAssistants() });
  if (m === 'POST' && p === '/api/assistants/reset') {
    resetAssistants();
    return sendJson(res, 200, { assistants: listAssistants() });
  }
  if (seg[1] === 'assistants' && seg[2]) {
    if (m === 'PUT') return sendJson(res, 200, saveAssistant(seg[2], await readJsonBody(req)));
    if (m === 'DELETE') {
      deleteAssistant(seg[2]);
      return sendJson(res, 200, { ok: true });
    }
  }
  if (m === 'GET' && p === '/api/memory') return sendJson(res, 200, { facts: listMemory(), on: getSettings().memoryOn });
  if (m === 'POST' && p === '/api/memory') return sendJson(res, 200, addMemory((await readJsonBody(req)).text));
  if (m === 'DELETE' && p === '/api/memory') {
    clearMemory();
    return sendJson(res, 200, { ok: true });
  }
  if (seg[1] === 'memory' && seg[2]) {
    if (m === 'PUT') return sendJson(res, 200, updateMemory(seg[2], (await readJsonBody(req)).text));
    if (m === 'DELETE') {
      deleteMemory(seg[2]);
      return sendJson(res, 200, { ok: true });
    }
  }

  // Extensions: skills, plugins, commands and connectors. Adding them, and anything that runs programs, only on
  // the computer itself (a paired phone may use them and switch skills and commands on or off).
  const onComputer = () => {
    if (!isLoopback(req.socket.remoteAddress)) throw Object.assign(new Error(t('Skills, plugins and connectors can be added on the computer itself.')), { status: 403 });
  };
  const id2 = seg[2] ? decodeURIComponent(seg[2]) : '';
  if (m === 'GET' && p === '/api/extensions') {
    ensureMcp().catch(() => {}); // start the connectors that are on, for their status
    return sendJson(res, 200, extensionsState());
  }
  if (m === 'GET' && p === '/api/extensions/menu') return sendJson(res, 200, { items: slashMenu() });
  if (m === 'POST' && p === '/api/extensions/inspect') {
    onComputer();
    if (String(req.headers['content-type'] || '').includes('application/json')) {
      const { url: link, folder } = await readJsonBody(req);
      return sendJson(res, 200, await inspectExtension({ url: link, folder }));
    }
    const buf = await readBody(req, 150 << 20);
    return sendJson(res, 200, await inspectExtension({ upload: buf, name: decodeURIComponent(String(req.headers['x-file-name'] || 'upload.zip')) }));
  }
  if (m === 'POST' && p === '/api/extensions/install') {
    onComputer();
    const { token, pick } = await readJsonBody(req);
    const done = await installExtension(String(token || ''), { pick });
    ensureMcp().catch(() => {});
    return sendJson(res, 200, { installed: done, ...extensionsState() });
  }
  if (seg[1] === 'skills') {
    if (m === 'POST' && !seg[2]) return sendJson(res, 200, saveOwnSkill('new', await readJsonBody(req)));
    if (m === 'GET' && id2) return sendJson(res, 200, getSkill(id2));
    if (m === 'PUT' && id2) {
      const b = await readJsonBody(req);
      if (typeof b.enabled === 'boolean' && b.name === undefined) setSkillEnabled(id2, b.enabled);
      else saveOwnSkill(id2, b);
      return sendJson(res, 200, extensionsState());
    }
    if (m === 'DELETE' && id2) {
      deleteSkill(id2);
      return sendJson(res, 200, extensionsState());
    }
  }
  if (seg[1] === 'plugins' && id2) {
    onComputer();
    if (m === 'PUT') {
      updatePlugin(id2, await readJsonBody(req));
      ensureMcp().catch(() => {});
      return sendJson(res, 200, extensionsState());
    }
    if (m === 'DELETE') {
      removePlugin(id2);
      ensureMcp().catch(() => {});
      return sendJson(res, 200, extensionsState());
    }
  }
  if (seg[1] === 'commands') {
    if (m === 'POST' && !seg[2]) {
      saveCommand('new', await readJsonBody(req));
      return sendJson(res, 200, extensionsState());
    }
    if (m === 'PUT' && id2) {
      const b = await readJsonBody(req);
      if (typeof b.enabled === 'boolean' && b.name === undefined) setCommandEnabled(id2, b.enabled);
      else saveCommand(id2, b);
      return sendJson(res, 200, extensionsState());
    }
    if (m === 'DELETE' && id2) {
      deleteCommand(id2);
      return sendJson(res, 200, extensionsState());
    }
  }
  // The connector directory (Customize → Connectors): the list, and connecting one in a click.
  if (m === 'GET' && p === '/api/directory') return sendJson(res, 200, directory());
  if (m === 'POST' && seg[1] === 'directory' && id2 && seg[3] === 'connect') {
    onComputer();
    const r = await connectFromDirectory(id2, { redirectUri: `http://127.0.0.1:${port}/oauth/callback` });
    return sendJson(res, 200, { ...r, ...extensionsState() });
  }
  if (seg[1] === 'connectors') {
    onComputer();
    // Sign in to a connector that is a web service (its own page opens in the browser), or sign out of it.
    if (m === 'POST' && id2 && seg[3] === 'signin') {
      const r = await signInConnector(id2, { redirectUri: `http://127.0.0.1:${port}/oauth/callback` });
      return sendJson(res, 200, { url: r.url, ...extensionsState() });
    }
    if (m === 'POST' && id2 && seg[3] === 'signout') {
      await signOutConnector(id2);
      return sendJson(res, 200, extensionsState());
    }
    const b = m === 'DELETE' ? {} : await readJsonBody(req);
    // A token pasted for a service that doesn't let Hearth sign in (it stays on the server, like sign-ins).
    if (m === 'POST' && id2 && seg[3] === 'token') {
      useConnectorToken(id2, b.token);
      return sendJson(res, 200, extensionsState());
    }
    if (m === 'POST' && !seg[2]) {
      const name = String(b.name || '').trim().slice(0, 40);
      if (!/^[\w.-]+$/.test(name)) return sendError(res, 400, t('Give the connector a short name: letters, digits, dots and dashes.'));
      const cfg = b.url ? { type: 'http', url: String(b.url).trim(), ...(b.headers && typeof b.headers === 'object' ? { headers: b.headers } : {}) } : { command: String(b.command || '').trim(), args: Array.isArray(b.args) ? b.args.map(String) : [], ...(b.env && typeof b.env === 'object' ? { env: b.env } : {}) };
      if (!cfg.url && !cfg.command) return sendError(res, 400, t('Give the program to start, or the address of the server.'));
      editOwnConnectors((list) => {
        list[name] = cfg;
      });
      return sendJson(res, 200, extensionsState());
    }
    if (m === 'PUT' && id2) {
      editOwnConnectors((list) => {
        if (list[id2]) {
          if (b.enabled === false) list[id2].disabled = true;
          else delete list[id2].disabled;
        }
      });
      return sendJson(res, 200, extensionsState());
    }
    if (m === 'DELETE' && id2) {
      editOwnConnectors((list) => {
        delete list[id2];
      });
      return sendJson(res, 200, extensionsState());
    }
  }

  // Tools for the chat
  if (m === 'GET' && p === '/api/tools') return sendJson(res, 200, await listTools());
  if (m === 'POST' && p === '/api/tools/call') {
    const { name, arguments: args } = await readJsonBody(req);
    let parsed = args;
    if (typeof args === 'string') {
      try {
        parsed = args.trim() ? JSON.parse(args) : {};
      } catch {
        return sendJson(res, 200, { ok: false, error: t('The model sent tool arguments that are not valid JSON.') });
      }
    }
    try {
      return sendJson(res, 200, { ok: true, content: await callTool(String(name || ''), parsed) });
    } catch (err) {
      return sendJson(res, 200, { ok: false, error: String(err.message || err) });
    }
  }

  // Batch jobs
  if (m === 'GET' && p === '/api/batches') return sendJson(res, 200, { batches: listBatches() });
  if (m === 'POST' && p === '/api/batches') return sendJson(res, 200, createBatch(await readJsonBody(req, 64 << 20)));
  if (seg[1] === 'batches' && seg[2]) {
    const id = seg[2];
    if (m === 'GET' && !seg[3]) {
      const b = getBatch(id);
      return b ? sendJson(res, 200, b) : sendError(res, 404, t('Not found'));
    }
    if (m === 'POST' && seg[3] === 'stop') return sendJson(res, 200, stopBatch(id));
    if (m === 'POST' && seg[3] === 'resume') return sendJson(res, 200, resumeBatch(id, { failedOnly: url.searchParams.has('failed') }));
    if (m === 'PUT' && seg[3] === 'items' && seg[4]) {
      const { field, value } = await readJsonBody(req);
      return sendJson(res, 200, editBatchCell(id, seg[4], String(field || ''), value));
    }
    if (m === 'DELETE' && !seg[3]) {
      deleteBatch(id);
      return sendJson(res, 200, { ok: true });
    }
  }

  // Artifacts (pages, apps and pictures from chats; designs) and the brand kit
  if (m === 'GET' && p === '/api/artifacts') return sendJson(res, 200, { artifacts: listArtifacts({ q: url.searchParams.get('q') || '', kind: url.searchParams.get('kind') || '' }) });
  if (m === 'POST' && p === '/api/artifacts') return sendJson(res, 200, saveArtifact(await readJsonBody(req, 8 << 20)));
  if (m === 'GET' && p === '/api/brand') return sendJson(res, 200, getBrand());
  if (m === 'PUT' && p === '/api/brand') return sendJson(res, 200, saveBrand(await readJsonBody(req)));
  if (seg[1] === 'artifacts' && seg[2]) {
    const id = seg[2];
    const a = m === 'GET' ? getArtifact(id, url.searchParams.get('v')) : null;
    if (m === 'GET' && !a) return sendError(res, 404, t('Not found'));
    if (m === 'GET' && !seg[3]) return sendJson(res, 200, a);
    if (m === 'PUT' && !seg[3]) {
      const b = await readJsonBody(req, 8 << 20);
      return sendJson(res, 200, 'code' in b ? saveArtifact({ ...b, id }) : updateArtifact(id, b));
    }
    if (m === 'DELETE' && !seg[3]) return sendJson(res, 200, { ok: deleteArtifact(id) });
    // The artifact as a page of its own: sandboxed by the server too, so even opened in a tab it can't reach Hearth.
    if (m === 'GET' && seg[3] === 'view') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...SANDBOX_HEADERS });
      return res.end(artifactDoc(a));
    }
    // The page as text, pictures inside (the Design page draws it and saves it as PNG).
    if (m === 'GET' && seg[3] === 'doc') return sendJson(res, 200, { doc: artifactDoc(a) });
    if (m === 'GET' && seg[3] === 'download') {
      const name = `${(a.title || 'artifact').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '-').slice(0, 80)}.${a.kind === 'svg' ? 'svg' : 'html'}`;
      const body = a.kind === 'svg' ? a.code : artifactDoc(a);
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`, 'x-content-type-options': 'nosniff' });
      return res.end(body);
    }
  }

  // Bots
  if (m === 'GET' && p === '/api/bots') {
    const act = activity();
    return sendJson(res, 200, { bots: listBots().map((b) => botCard(b, act)), templates: templates(), activity: act });
  }
  if (m === 'GET' && p === '/api/bots/summary') return sendJson(res, 200, botsSummary());
  if (m === 'POST' && p === '/api/bots') return sendJson(res, 200, publicBot(await createBot(await readJsonBody(req))));
  if (seg[1] === 'bots' && seg[2] && seg[2] !== 'summary') {
    const id = seg[2];
    const bot = getBot(id);
    if (!bot) return sendError(res, 404, t('Not found'));
    const local = isLoopback(req.socket.remoteAddress);
    if (m === 'GET' && !seg[3]) return sendJson(res, 200, { bot: publicBot(bot), tasks: listTasks(id), files: workFiles(bot), activity: activity(), onComputer: local, search: getSettings().searchProvider || 'wikipedia', folders: getSettings().toolFolders.length });
    if (m === 'PUT' && !seg[3]) {
      const body = await readJsonBody(req);
      if ('folder' in body && !local) return sendError(res, 403, t('The work folder can be changed on the computer itself.'));
      return sendJson(res, 200, publicBot(saveBot(id, body)));
    }
    if (m === 'DELETE' && !seg[3]) {
      forgetBot(id);
      disconnectTelegram(id);
      deleteBot(id);
      return sendJson(res, 200, { ok: true });
    }
    if (m === 'POST' && seg[3] === 'tasks' && !seg[4]) {
      const body = await readJsonBody(req);
      const task = startTask(id, { text: String(body.text || ''), taskId: String(body.taskId || '') });
      return sendJson(res, 200, taskView(id, task.id));
    }
    if (seg[3] === 'tasks' && seg[4]) {
      const tid = seg[4];
      if (m === 'GET' && !seg[5]) {
        const v = taskView(id, tid);
        if (!v) return sendError(res, 404, t('Not found'));
        // Seen: no longer counted as new (a running task keeps its own copy, so only finished ones are marked here).
        if (v.unread && url.searchParams.has('seen') && !v.live && !v.queuePos) {
          const k = getTask(id, tid);
          k.unread = false;
          saveTask(k);
          v.unread = false;
        }
        return sendJson(res, 200, v);
      }
      if (m === 'POST' && seg[5] === 'stop') {
        stopTask(id, tid);
        return sendJson(res, 200, taskView(id, tid));
      }
      if (m === 'DELETE' && !seg[5]) {
        forgetTask(id, tid);
        deleteTask(id, tid);
        return sendJson(res, 200, { ok: true });
      }
    }
    if (m === 'POST' && seg[3] === 'schedules' && seg[4] && seg[5] === 'run') return sendJson(res, 200, taskView(id, runScheduleNow(id, seg[4]).id));
    if (seg[3] === 'telegram') {
      if (m === 'POST' && !seg[4]) return sendJson(res, 200, publicBot(await connectTelegram(id, (await readJsonBody(req)).token)));
      if (m === 'DELETE' && !seg[4]) return sendJson(res, 200, publicBot(disconnectTelegram(id)));
      if (m === 'DELETE' && seg[4] === 'owners' && seg[5]) return sendJson(res, 200, publicBot(forgetOwner(id, decodeURIComponent(seg[5]))));
    }
    // A file the bot made: always as a download, never shown as a page here (it could run scripts in Hearth's page).
    if (m === 'GET' && seg[3] === 'file') {
      let file;
      try {
        file = forRead(bot, url.searchParams.get('path') || '');
      } catch (err) {
        return sendError(res, 404, err.message);
      }
      const st = fs.statSync(file);
      if (!st.isFile()) return sendError(res, 404, t('Not found'));
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': st.size, 'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(file))}`, 'x-content-type-options': 'nosniff', 'content-security-policy': 'sandbox' });
      return fs.createReadStream(file).pipe(res);
    }
    // Open the work folder, or one of its files with its usual program (on the computer itself).
    if (m === 'POST' && seg[3] === 'open') {
      if (!local) return sendError(res, 403, t('Files open on the computer itself.'));
      const rel = String((await readJsonBody(req)).path || '');
      const file = rel ? forRead(bot, rel) : workFolder(bot);
      if (!rel || fs.statSync(file).isDirectory() || SAFE_OPEN.test(file)) openPath(file);
      else reveal(file);
      return sendJson(res, 200, { ok: true });
    }
  }

  // Voice
  if (m === 'GET' && p === '/api/voice') return sendJson(res, 200, await voiceStatus());
  if (m === 'POST' && p === '/api/voice/install') return sendJson(res, 200, await installVoice());
  if (m === 'POST' && p === '/api/voice/transcribe') {
    const audio = await readBody(req, 64 << 20);
    // A video's speech can be many minutes long: it gets more time than a spoken message.
    return sendJson(res, 200, { text: await transcribe(audio, { language: url.searchParams.get('lang') || 'auto', timeout: url.searchParams.get('long') ? 600e3 : 120e3 }) });
  }

  // The natural voice for spoken answers: what is installed, downloading it, taking it off again.
  if (p === '/api/voice/natural' || p === '/api/voice/natural/install') {
    const nv = await import('./natural-voice.mjs');
    if (m === 'GET' && p === '/api/voice/natural') return sendJson(res, 200, nv.naturalStatus());
    if (m === 'POST' && p === '/api/voice/natural/install') return sendJson(res, 200, await nv.installNatural());
    if (m === 'DELETE' && p === '/api/voice/natural') return sendJson(res, 200, nv.removeNatural());
  }

  // What a spoken answer sounds like on this computer: the text read aloud, as a voice message.
  // voice: 'natural' or 'system' to hear that one only (left out: the one answers are read with); style: 1 to 10.
  if (m === 'POST' && p === '/api/voice/say') {
    const { voiceAnswer } = await import('./speak.mjs');
    const body = await readJsonBody(req);
    const text = String(body.text || '').slice(0, 1500);
    const only = body.voice === 'natural' || body.voice === 'system' ? body.voice : 'auto';
    try {
      const file = await voiceAnswer(text, { voice: only, style: Number(body.style) || undefined });
      if (!file) return sendError(res, 400, t('There is nothing to read aloud in this text.'));
      res.writeHead(200, { 'content-type': file.mime, 'content-length': file.data.length, 'x-hearth-voice': encodeURIComponent(file.voice || ''), 'x-hearth-natural': file.natural ? '1' : '0', 'cache-control': 'no-store' });
      return res.end(file.data);
    } catch (err) {
      const why =
        err.code === 'NO_VOICE'
          ? t('This computer has no voice for this language. Add one in the system’s speech settings.')
          : err.code === 'NO_NATURAL'
            ? t('The natural voice is not downloaded yet.')
            : err.code === 'NATURAL_FAILED'
              ? t('The natural voice could not read the text: {error}', { error: String(err.message || err).slice(0, 300) })
              : t('This computer could not read the text aloud: {error}', { error: String(err.message || err).slice(0, 300) });
      return sendError(res, 409, why, { code: err.code || '' });
    }
  }
  if (m === 'POST' && p === '/api/voice/video') {
    // The speech of a video already added to a chat, for browsers that can't read its sound themselves.
    const name = /^\/uploads\/([\w-]+\.(?:mp4|m4v|mov))$/.exec(String((await readJsonBody(req)).url || ''))?.[1];
    const file = name ? path.join(DIRS.uploads, name) : '';
    if (!file || !fs.existsSync(file)) return sendError(res, 404, t('Not found'));
    return sendJson(res, 200, await videoSpeech(file));
  }

  // Pictures
  if (m === 'GET' && p === '/api/images') return sendJson(res, 200, await imagesStatus());
  if (m === 'GET' && p === '/api/images/job') return sendJson(res, 200, { job: jobStatus() });
  if (m === 'GET' && p === '/api/images/gallery') return sendJson(res, 200, { images: gallery() });
  if (m === 'POST' && p === '/api/images/install') return sendJson(res, 200, await installImages((await readJsonBody(req)).set));
  if (m === 'POST' && p === '/api/images/generate') return sendJson(res, 200, await generateImages(await readJsonBody(req)));
  if (m === 'POST' && p === '/api/images/cancel') return sendJson(res, 200, { job: cancelImages() });
  if (m === 'DELETE' && seg[1] === 'images' && seg[2]) return sendJson(res, 200, { ok: deleteImage(decodeURIComponent(seg[2])) });
  if (m === 'GET' && p === '/api/videos') return sendJson(res, 200, await videosStatus());
  if (m === 'GET' && p === '/api/videos/job') return sendJson(res, 200, { job: videoJob() });
  if (m === 'GET' && p === '/api/videos/gallery') return sendJson(res, 200, { videos: videoGallery() });
  if (m === 'POST' && p === '/api/videos/install') return sendJson(res, 200, await installVideos(await readJsonBody(req)));
  // A start picture comes along as a data URL (up to 30 MB of picture).
  if (m === 'POST' && p === '/api/videos/generate') return sendJson(res, 200, await generateVideo(await readJsonBody(req, 96 << 20)));
  if (m === 'POST' && p === '/api/videos/cancel') return sendJson(res, 200, { job: cancelVideos() });
  if (m === 'DELETE' && seg[1] === 'videos' && seg[2]) return sendJson(res, 200, { ok: deleteVideo(decodeURIComponent(seg[2])) });

  // Updates
  if (m === 'GET' && p === '/api/updates') return sendJson(res, 200, updatesState());
  if (m === 'POST' && p === '/api/updates/check') return sendJson(res, 200, await checkUpdates());
  if (m === 'POST' && p === '/api/updates/images-engine') return sendJson(res, 200, { job: await updateSdEngine() });
  if (m === 'POST' && p === '/api/updates/model') {
    const { id } = await readJsonBody(req);
    const model = findLocalModel(id);
    if (!model?.repo) return sendError(res, 404, t('Model not found'));
    if (engineState().loaded.some((r) => r.model?.id === id)) await stopEngine(id);
    const job = await downloadModel({ repo: model.repo, quant: model.quant, vision: Boolean(model.mmproj) });
    return sendJson(res, 200, job);
  }

  // A native "choose folder" window, for the tools' allowed folders (only on this computer).
  if (m === 'POST' && p === '/api/pick-folder') {
    if (!isLoopback(req.socket.remoteAddress)) return sendError(res, 403, t('Folders can be added on the computer itself.'));
    return sendJson(res, 200, { path: await pickFolder(url.searchParams.get('for') === 'bot' ? t('Choose the bot’s work folder') : undefined) });
  }

  // Phones and tablets (only this computer may change who gets in)
  if (p === '/api/phone' || p.startsWith('/api/phone/')) {
    if (!isLoopback(req.socket.remoteAddress)) return sendError(res, 403, t('Change phone access on the computer itself.'));
    if (m === 'GET' && p === '/api/phone') return sendJson(res, 200, phoneInfo(port));
    if (m === 'POST' && p === '/api/phone') {
      const before = listenHost();
      setPhoneAccess(Boolean((await readJsonBody(req)).on));
      sendJson(res, 200, phoneInfo(port));
      if (listenHost() !== before) relisten();
      return;
    }
    if (m === 'POST' && p === '/api/phone/reset') {
      resetDevices();
      return sendJson(res, 200, phoneInfo(port));
    }
    if (m === 'DELETE' && seg[2] === 'devices' && seg[3]) {
      forgetDevice(seg[3]);
      return sendJson(res, 200, phoneInfo(port));
    }
  }

  // Images and videos added to a chat
  if (m === 'POST' && p === '/api/uploads') {
    const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    const stamp = `${Date.now().toString(36)}-${uid(8)}`;
    if (UPLOAD_VIDEO[type]) {
      // A video goes straight to the disk; the page plays it from there and sends the model a few frames of it.
      const name = `${stamp}${UPLOAD_VIDEO[type]}`;
      const size = await saveBody(req, path.join(DIRS.uploads, name), MAX_VIDEO_UPLOAD);
      return sendJson(res, 200, { url: `/uploads/${name}`, size });
    }
    if (type === 'image/heic' || type === 'image/heif') {
      // iPhone photos. Browsers other than Safari can't open them; macOS can turn them into JPEG.
      const buf = await readBody(req, 40 << 20);
      const jpg = IS_MAC ? await heicToJpeg(buf, stamp) : null;
      if (!jpg) return sendError(res, 415, t('This is an iPhone photo in the HEIC format, which can’t be opened here. Save it as JPEG and add it again.'));
      return sendJson(res, 200, { url: `/uploads/${jpg.name}`, size: jpg.size });
    }
    const ext = UPLOAD_IMAGE[type];
    if (!ext) return sendError(res, 415, t('Only PNG, JPEG, WebP and GIF images and MP4, MOV and WebM videos can be added.'));
    const buf = await readBody(req, 40 << 20);
    const name = `${stamp}${ext}`;
    fs.writeFileSync(path.join(DIRS.uploads, name), buf);
    return sendJson(res, 200, { url: `/uploads/${name}`, size: buf.length });
  }

  // Settings
  if (m === 'GET' && p === '/api/settings') return sendJson(res, 200, publicSettings());
  if (m === 'PUT' && p === '/api/settings') {
    const before = listenHost();
    const patch = await readJsonBody(req);
    if (!isLoopback(req.socket.remoteAddress)) {
      // A paired phone may change everyday settings, but not who can reach this computer.
      for (const k of ['access', 'port', 'phoneAccess', 'toolFolders', 'mcpConfig', 'toolApproval', 'enginePath', 'engineArgs', 'modelsDir', 'extraModelDirs', 'keepAwake']) delete patch[k];
    }
    updateSettings(patch);
    if ('keepAwake' in patch) awakeChanged();
    sendJson(res, 200, publicSettings());
    if (listenHost() !== before) relisten(); // switch between this-computer-only and network
    return;
  }
  if (m === 'POST' && p === '/api/settings/new-key') return sendJson(res, 200, { apiKey: newApiKey() });
  // This computer: starting with Windows, and staying awake for bots and apps (power.mjs).
  if (m === 'GET' && p === '/api/power') return sendJson(res, 200, await powerState());
  if (m === 'POST' && p === '/api/power') {
    if (!isLoopback(req.socket.remoteAddress)) return sendError(res, 403, t('Change this on the computer itself.'));
    const body = await readJsonBody(req);
    if ('startAtLogin' in body) await setStartAtLogin(Boolean(body.startAtLogin));
    return sendJson(res, 200, await powerState());
  }

  if (m === 'POST' && p === '/api/connect/check') {
    const { api } = await readJsonBody(req);
    return sendJson(res, 200, await connectCheck(api === 'anthropic' ? 'anthropic' : 'openai'));
  }

  if (m === 'POST' && p === '/api/shutdown') {
    sendJson(res, 200, { ok: true });
    setTimeout(() => shutdown(0), 100);
    return;
  }
  return sendError(res, 404, `${t('Unknown')}: ${m} ${p}`);
}

// Re-open the port on the new address after the answer has gone out (re-listening drops open connections).
function relisten() {
  setTimeout(() => listen(port).catch((err) => console.error(err)), 150);
}

// Where this Hearth runs, for its launchers and for Stop-Hearth.vbs (the setup uses it to close Hearth before an
// update). The port can differ from the one in Settings when that one is taken: on Windows, Hyper-V, WSL and Docker
// reserve ranges of ports, so 7420 may not be free even when nothing seems to use it.
const RUN_FILE = path.join(DIRS.data, 'run.json');

function writeRunFile() {
  try {
    fs.writeFileSync(RUN_FILE, JSON.stringify({ pid: process.pid, port, version: APP_VERSION, at: Date.now() }));
  } catch {}
}

function removeRunFile() {
  try {
    if (readJson(RUN_FILE, {}).pid === process.pid) fs.rmSync(RUN_FILE, { force: true });
  } catch {}
}

function listen(p) {
  return new Promise((resolve, reject) => {
    const host = listenHost();
    const start = () => {
      server = http.createServer((req, res) => runWithLang(req, () => handle(req, res)));
      server.requestTimeout = 0; // long answers and big uploads must not be cut off
      server.headersTimeout = 60000;
      server.once('error', reject);
      server.listen(p, host, () => {
        port = p;
        writeRunFile();
        resolve();
      });
    };
    if (server) {
      server.close();
      server.closeAllConnections?.();
      setTimeout(start, 50);
    } else start();
  });
}

function openWindow(url) {
  // An app-style window (no tabs or address bar) when Chrome or Edge is installed, else the normal browser.
  const appMode = (bin, extra = []) => spawn(bin, [...extra, `--app=${url}`, '--window-size=1440,920'], { detached: true, stdio: 'ignore' }).unref();
  try {
    if (IS_MAC) {
      if (exists('/Applications/Google Chrome.app')) return spawn('open', ['-na', 'Google Chrome', '--args', `--app=${url}`, '--window-size=1440,920'], { detached: true, stdio: 'ignore' }).unref();
      return spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    }
    if (IS_WIN) {
      const edge = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles].filter(Boolean).map((d) => path.join(d, 'Microsoft', 'Edge', 'Application', 'msedge.exe')).find(exists);
      if (edge) return appMode(edge);
      return spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    }
    for (const b of ['google-chrome', 'chromium', 'chromium-browser', 'microsoft-edge']) {
      const full = ['/usr/bin', '/usr/local/bin', '/snap/bin'].map((d) => path.join(d, b)).find(exists);
      if (full) return appMode(full);
    }
    spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
  } catch {}
}

function extensionsState() {
  return {
    skills: listSkills().map(publicSkill),
    plugins: listPlugins().map(publicPlugin),
    commands: listCommands(),
    connectors: ownConnectors().map(({ cfg, ...c }) => c),
    servers: mcpServers(),
    toolsOn: getSettings().toolsOn,
  };
}

let closing = false;
async function shutdown(code = 0) {
  if (closing) return;
  closing = true;
  cancelImages();
  cancelVideos();
  stopVoice();
  stopMcp();
  stopTelegram();
  stopPower();
  await stopEngine().catch(() => {});
  process.exit(code);
}

// Another Hearth runs with this data folder: open its window instead of starting a second one. It may be busy for a
// while (a big model loading on a computer short of memory can stall it), so wait up to a minute for its port.
async function openRunning(info, want) {
  const end = Date.now() + 60000;
  let p = info?.port || 0;
  while (!p && Date.now() < end) {
    await sleep(1000);
    p = (await askInstance(5000))?.info?.port || 0;
  }
  p ||= readJson(RUN_FILE, {}).port || want;
  const url = `http://127.0.0.1:${p}`;
  console.log(`Hearth is already running at ${url}`);
  console.log(`  App:            ${url}`); // the Mac app follows this line
  if (OPEN) openWindow(url);
  // Stay until it answers, so a launcher that watches this process (the Mac app) keeps waiting for it as well.
  while (Date.now() < end) {
    try {
      if ((await (await fetch(`${url}/api/ping`, { signal: AbortSignal.timeout(3000) })).json()).app === 'hearth') return;
    } catch {}
    await sleep(500);
  }
}

async function main() {
  teeConsole();
  console.log(`Hearth ${APP_VERSION} starting · Node ${process.version} · ${process.platform} ${process.arch} · ${process.env.HEARTH_APP || 'terminal'}`);
  const want = PORT_ARG || getSettings().port;
  // Only one Hearth per data folder: a second one would load the model again and take part of the graphics card.
  const lock = await holdInstance(() => ({ app: 'hearth', pid: process.pid, port, version: APP_VERSION }));
  if (!lock.ok) {
    await openRunning(lock.info, want);
    return process.exit(0);
  }
  if (lock.unlocked) console.log(`Could not make sure only one Hearth runs: ${lock.unlocked}`);
  // A Hearth from before the lock may still run (on the port in Settings, or on the one it found free): open it.
  for (const p of [...new Set([want, readJson(RUN_FILE, {}).port].filter(Boolean))]) {
    if (await portFree(p)) continue;
    try {
      const r = await fetch(`http://127.0.0.1:${p}/api/ping`, { signal: AbortSignal.timeout(5000) });
      if ((await r.json()).app === 'hearth') {
        console.log(`Hearth is already running at http://127.0.0.1:${p}`);
        if (OPEN) openWindow(`http://127.0.0.1:${p}`);
        return;
      }
    } catch {}
  }
  let p = want;
  while (!(await portFree(p, listenHost()))) p++;
  await cleanupOrphan();
  await listen(p);
  const base = `http://127.0.0.1:${port}`;
  console.log(`\n  ${APP_NAME} ${APP_VERSION} is running\n`);
  console.log(`  App:            ${base}`);
  console.log(`  OpenAI API:     ${base}/v1`);
  console.log(`  Anthropic API:  ${base}`);
  console.log(`  Data folder:    ${DIRS.data}\n`);
  console.log('  Keep this window open while you use Hearth. Close it (or press Ctrl+C) to stop.\n');
  if (OPEN) openWindow(base);
  // Learn the real GPU memory from the engine, so the Models page shows honest numbers from the start.
  devicesReady = detectHardware()
    .then(() => listEngines())
    .then((l) => readEngineDevices(l[0]?.path, 30000))
    .catch(() => {});
  // Bring back the model from last time, and any batch job that was still running.
  const s = getSettings();
  if (s.autoLoad && s.lastModel) {
    const model = listLocalModels(true).find((m) => m.id === s.lastModel.id || m.path === s.lastModel.path);
    if (model) startEngine(model).catch(() => {});
  }
  setTimeout(resumeUnfinished, 3000);
  // A connector added at a directory address that has since moved goes to the new address.
  try {
    fixMovedConnectors();
  } catch {}
  // Bots: tasks that were waiting go on, the schedule starts, and Telegram bots start listening.
  setTimeout(() => {
    resumeBots();
    syncTelegram();
    startPower(); // after the bots: whether to keep the computer awake depends on them
  }, 3000);
  scheduleUpdateChecks();
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
process.on('exit', () => {
  removeRunFile();
  releaseInstance();
  killEngineSync();
  stopVoice();
  stopMcp();
  cancelImages();
  cancelVideos();
});
process.on('uncaughtException', (err) => {
  console.error(err);
});

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
