// Tests for bots: the schedule, the work folder, a bot's steps with a stand-in model, keeping the conversation short,
// and Telegram with a stand-in Telegram server. Run with: npm test. No GPU, model or network needed.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-bots-'));
process.env.HEARTH_DATA_DIR = path.join(tmp, 'data');
process.env.HEARTH_BOTS_DIR = path.join(tmp, 'Hearth Bots');
const { updateSettings } = await import('../server/settings.mjs');
const bots = await import('../server/bots.mjs');
const { callFileTool } = await import('../server/workfiles.mjs');
const agent = await import('../server/agent.mjs');
const telegram = await import('../server/telegram.mjs');
updateSettings({ language: 'en' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 5000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out');
    await sleep(20);
  }
}
const finished = (botId, id) => until(() => {
  const k = bots.getTask(botId, id);
  return k && ['done', 'error', 'stopped'].includes(k.status) && !agent.taskState(botId, id) ? k : null;
});

// A stand-in model: each call takes the next scripted answer (text, or tool calls) and streams it like llama-server.
const calls = [];
let script = [];
function sse(objs) {
  return { ok: true, status: 200, text: async () => '', body: (async function* () {
    for (const o of objs) yield `data: ${JSON.stringify(o)}\n\n`;
    yield 'data: [DONE]\n\n';
  })() };
}
agent.setModelCall(async (body) => {
  calls.push(body);
  const next = script.shift() ?? { text: 'OK.' };
  if (typeof next === 'function') return next(body);
  if (next.tools) return sse([...next.tools.map((tc, i) => ({ choices: [{ delta: { tool_calls: [{ index: i, id: `c${calls.length}_${i}`, function: { name: tc.name, arguments: JSON.stringify(tc.args) } }] } }] })), { choices: [{ delta: {}, finish_reason: 'tool_calls' }], timings: { prompt_n: 100, predicted_n: 10, predicted_per_second: 15 } }]);
  return sse([{ choices: [{ delta: { content: next.text } }] }, { choices: [{ delta: {}, finish_reason: 'stop' }], timings: { prompt_n: 100, predicted_n: 5, predicted_per_second: 15 } }]);
});

after(() => {
  telegram.stopTelegram();
});

test('schedule: days and a time, or every few hours on the hour; a late one runs once, a very late one waits', () => {
  const at = (s) => new Date(s).getTime();
  const daily = { time: '09:00', days: [1, 2, 3, 4, 5, 6, 7] };
  assert.equal(bots.nextRunOf(daily, at('2026-11-09T08:00:00')), at('2026-11-09T09:00:00'));
  assert.equal(bots.nextRunOf(daily, at('2026-11-09T09:00:00')), at('2026-11-10T09:00:00'));
  // Mondays only: from Tuesday the next one is six days later.
  assert.equal(bots.nextRunOf({ time: '10:30', days: [1] }, at('2026-11-10T12:00:00')), at('2026-11-16T10:30:00'));
  assert.equal(bots.nextRunOf({ every: 3 }, at('2026-11-09T10:15:00')), at('2026-11-09T12:00:00'));
  assert.equal(bots.nextRunOf({ every: 12 }, at('2026-11-09T13:00:00')), at('2026-11-10T00:00:00'));
  const clean = bots.cleanSchedule({ task: ' Check prices ', time: '7:5', days: [9, 3, 3], every: 5 });
  assert.deepEqual([clean.task, clean.time, clean.days, clean.every, clean.on], ['Check prices', '09:00', [3], 0, true]);
});

test('work folder: write, change, read and tables inside it; nothing outside', async () => {
  const bot = await bots.createBot({ template: 'helper' });
  assert.ok(bot.folder.startsWith(process.env.HEARTH_BOTS_DIR));
  // A name given at creation names the folder too; a second bot of that name gets its own folder.
  const named = await bots.createBot({ template: 'blank', name: 'Посты: соцсети' });
  assert.equal(named.name, 'Посты: соцсети');
  assert.equal(path.basename(named.folder), 'Посты- соцсети');
  assert.equal(path.basename((await bots.createBot({ template: 'blank', name: 'Посты: соцсети' })).folder), 'Посты- соцсети 2');
  const w = await callFileTool(bot, 'write_file', { path: 'notes/plan.md', content: '# Plan\nSell 10 shirts' });
  assert.equal(w.file, 'notes/plan.md');
  await callFileTool(bot, 'edit_file', { path: 'notes/plan.md', old_text: '10 shirts', new_text: '20 hoodies' });
  assert.match((await callFileTool(bot, 'read_file', { path: 'notes/plan.md' })).text, /20 hoodies/);
  await assert.rejects(callFileTool(bot, 'edit_file', { path: 'notes/plan.md', old_text: 'nope', new_text: 'x' }), /not found/);
  const tbl = await callFileTool(bot, 'write_table', { path: 'listings', rows: [['Product', 'Title'], ['Tee', 'Кот в космосе']] });
  assert.equal(tbl.file, 'listings.xlsx');
  assert.match((await callFileTool(bot, 'read_file', { path: 'listings.xlsx' })).text, /Кот в космосе/);
  assert.match((await callFileTool(bot, 'list_files', {})).text, /listings\.xlsx/);
  assert.match((await callFileTool(bot, 'find_files', { query: 'plan' })).text, /notes\/plan\.md/);
  for (const p of ['../escape.txt', path.join(tmp, 'outside.txt'), '']) await assert.rejects(callFileTool(bot, 'write_file', { path: p, content: 'x' }));
  await assert.rejects(callFileTool(bot, 'read_file', { path: '../../data/settings.json' }), /outside|Not found/);
  // A link inside the folder that leads out is refused too.
  fs.symlinkSync(tmp, path.join(bot.folder, 'link'));
  await assert.rejects(callFileTool(bot, 'write_file', { path: 'link/x.txt', content: 'x' }), /inside your work folder/);
  assert.ok(!fs.existsSync(path.join(tmp, 'x.txt')));
});

test('a bot works step by step: a tool call, its result, then the answer; the files it made are listed', async () => {
  const bot = await bots.createBot({ template: 'helper' });
  calls.length = 0;
  script = [{ tools: [{ name: 'write_file', args: { path: 'report.md', content: '# Report\nAll good' } }] }, { text: 'Done: I wrote report.md.' }];
  const k = agent.startTask(bot.id, { text: 'Write a short report' });
  const done = await finished(bot.id, k.id);
  assert.equal(done.status, 'done');
  const reply = done.messages.at(-1);
  assert.equal(reply.content, 'Done: I wrote report.md.');
  assert.deepEqual(reply.files, ['report.md']);
  assert.equal(reply.steps[0].name, 'write_file');
  assert.equal(reply.steps[0].status, 'done');
  assert.equal(fs.readFileSync(path.join(bot.folder, 'report.md'), 'utf8'), '# Report\nAll good');
  // The model saw its tools, its instructions with the work folder, and then the tool's result.
  assert.ok(calls[0].tools.some((x) => x.function.name === 'write_file'));
  assert.match(calls[0].messages[0].content, /work folder/);
  assert.match(calls[0].messages[1].content, /^\[\w{3}, \w{3} \d+, \d\d:\d\d (AM|PM)\] Write a short report$/); // the time goes with the message
  assert.doesNotMatch(calls[0].messages[0].content, /\d\d:\d\d/); // not in the instructions, so the engine's cache holds
  assert.equal(calls[1].messages.at(-1).role, 'tool');
  assert.match(calls[1].messages.at(-1).content, /Saved report\.md/);
  assert.equal(done.unread, true);
  // The page never gets the model's conversation.
  assert.equal(agent.taskView(bot.id, k.id).convo, undefined);
});

test('words sent while the bot works are kept and answered in the next turn', async () => {
  const bot = await bots.createBot({ template: 'blank' });
  let release;
  const gate = new Promise((r) => (release = r));
  script = [async () => {
    await gate;
    return sse([{ choices: [{ delta: { content: 'First answer.' } }] }]);
  }, { text: 'Second answer.' }];
  const k = agent.startTask(bot.id, { text: 'First' });
  await until(() => agent.taskState(bot.id, k.id) === 'running' && bots.getTask(bot.id, k.id).messages.length >= 2);
  agent.startTask(bot.id, { text: 'Also this', taskId: k.id });
  release();
  await until(() => bots.getTask(bot.id, k.id)?.messages.filter((m) => m.role === 'assistant').length === 2 && !agent.taskState(bot.id, k.id));
  const done = bots.getTask(bot.id, k.id);
  assert.deepEqual(done.messages.map((m) => m.content), ['First', 'First answer.', 'Also this', 'Second answer.']);
  assert.equal(done.status, 'done');
});

test('a long conversation is summed up: the task and the newest messages stay, the middle becomes notes', async () => {
  const bot = await bots.createBot({ template: 'blank' });
  const k = bots.newTask(bot, { title: 'Long' });
  const big = 'x'.repeat(12000);
  k.convo = [{ role: 'user', content: 'Find the best T-shirt printers' }];
  for (let i = 0; i < 12; i++) {
    k.convo.push({ role: 'assistant', content: `thinking ${'y'.repeat(9000)}`, tool_calls: [{ id: `t${i}`, type: 'function', function: { name: 'open_page', arguments: '{"url":"https://example.com"}' } }] });
    k.convo.push({ role: 'tool', tool_call_id: `t${i}`, content: `page ${i} ${big}` });
  }
  k.convo.push({ role: 'assistant', content: 'Almost done' });
  k.convo.push({ role: 'user', content: 'Go on' });
  script = [{ text: 'NOTES: read 12 pages, best is Example Print.' }];
  const before = agent.estimateTokens('', k.convo);
  const notes = await agent.squeeze(bot, k, 'system', {});
  assert.match(notes, /Example Print/);
  assert.ok(agent.estimateTokens('', k.convo) < before / 3);
  assert.match(k.convo[0].content, /^Find the best T-shirt printers\n\n\[Notes on the work so far/);
  assert.notEqual(k.convo[1].role, 'tool'); // the kept part starts with a question or an answer
  assert.equal(k.convo.at(-1).content, 'Go on');
  // Summed up again later: the task stays once, with the newest notes only.
  for (let i = 0; i < 12; i++) k.convo.push({ role: 'tool', tool_call_id: 'z', content: big }, { role: 'assistant', content: big });
  k.convo.push({ role: 'user', content: 'Next' });
  script = [{ text: 'NEWER NOTES' }];
  await agent.squeeze(bot, k, 'system', {});
  assert.equal(k.convo[0].content.match(/Find the best/g).length, 1);
  assert.match(k.convo[0].content, /NEWER NOTES$/);
});

test('a long task is cut well under the limit, and never at its start again (the engine reuses what it read)', async () => {
  const bot = await bots.createBot({ template: 'blank' });
  const k = bots.newTask(bot, { title: 'Pages' });
  const page = (i) => `page ${i} ${'p'.repeat(24000)}`; // a whole web page, as open_page gives it
  k.convo = [{ role: 'user', content: 'Make the morning summary' }];
  const step = (i) => {
    k.convo.push({ role: 'assistant', content: '', tool_calls: [{ id: `c${i}`, type: 'function', function: { name: 'open_page', arguments: `{"url":"https://example.com/${i}"}` } }] });
    k.convo.push({ role: 'tool', tool_call_id: `c${i}`, content: page(i) });
  };
  for (let i = 0; i < 4; i++) step(i);
  assert.ok(agent.estimateTokens('system', k.convo) > agent.SOFT_LIMIT);
  assert.equal(await agent.squeeze(bot, k, 'system', {}), '', 'cutting old pages was enough: no notes');
  assert.ok(agent.estimateTokens('system', k.convo) <= agent.SOFT_LIMIT * 0.6);
  assert.equal(k.convo.at(-1).content, page(3), 'the page the model hasn’t read yet stays whole');
  assert.match(k.convo[2].content, /^page 0 p+\n\[shortened/);
  // Page after page: only the newest messages ever change, so the engine reads little more than the new page each
  // time (it reuses everything before the first change), and never the task from its start again.
  for (let i = 4; i < 20; i++) {
    const before = k.convo.map((m) => JSON.stringify(m));
    step(i);
    assert.equal(await agent.squeeze(bot, k, 'system', {}), '');
    const changed = before.findIndex((m, j) => JSON.stringify(k.convo[j]) !== m);
    const reread = agent.estimateTokens('', k.convo.slice(changed === -1 ? before.length : changed));
    const added = agent.estimateTokens('', k.convo.slice(before.length));
    assert.ok(reread <= added * 1.5, `step ${i}: from message ${changed} of ${before.length}, ${reread} tokens to read again for ${added} new`);
    assert.ok(agent.estimateTokens('system', k.convo) <= agent.SOFT_LIMIT);
  }
});

test('strangers in Telegram get the web at most; the page never sees the Telegram key', async () => {
  const bot = bots.saveBot((await bots.createBot({ template: 'helper' })).id, { tools: { web: true, files: true, memory: true, connectors: true } });
  const own = (await agent.toolsFor(bot, false)).map((x) => x.name);
  const guest = (await agent.toolsFor(bot, true)).map((x) => x.name);
  assert.ok(own.includes('write_file') && own.includes('remember'));
  assert.deepEqual(guest, ['web_search', 'open_page']);
  bots.updateBot(bot.id, (b) => {
    b.telegram.token = '123456:SECRET-SECRET-SECRET-SECRET-SECRET-SECRET';
  });
  assert.ok(!JSON.stringify(bots.publicBot(bots.getBot(bot.id))).includes('SECRET'));
});

test('Telegram text: Markdown becomes the HTML Telegram takes, long answers are split', () => {
  const html = telegram.toTelegramHtml('# Title\n**bold** and `a<b>` and [link](https://x.io/a_b)\n- item\n\n| a | b |\n|---|---|\n| 1 | 2 |');
  assert.match(html, /<b>Title<\/b>/);
  assert.match(html, /<b>bold<\/b>/);
  assert.match(html, /<code>a&lt;b&gt;<\/code>/);
  assert.match(html, /<a href="https:\/\/x\.io\/a_b">link<\/a>/);
  assert.match(html, /• item/);
  assert.match(html, /<pre>\| a \| b \|\n\| 1 \| 2 \|<\/pre>/);
  const parts = telegram.chunks(`${'line\n'.repeat(2000)}`, 1000);
  assert.ok(parts.length > 5 && parts.every((p) => p.length <= 1000));
  const code = telegram.chunks(`\`\`\`\n${'code\n'.repeat(400)}\`\`\``, 500);
  assert.ok(code.every((p) => (p.match(/```/g) || []).length % 2 === 0)); // every part has its code block closed
});

test('Telegram: the owner link, a private bot for strangers, and an answer sent back', async () => {
  const sent = [];
  const srv = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const method = req.url.split('/').pop();
      const body = raw && raw.startsWith('{') ? JSON.parse(raw) : {};
      const reply = (result) => res.end(JSON.stringify({ ok: true, result }));
      if (method === 'getMe') return reply({ username: 'shop_helper_bot', first_name: 'Shop helper' });
      if (method === 'getUpdates') return setTimeout(() => reply([]), 100);
      if (method === 'sendMessage') sent.push(body);
      reply(true);
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  process.env.HEARTH_TELEGRAM_API = `http://127.0.0.1:${srv.address().port}`;
  try {
    const bot = await bots.createBot({ template: 'helper' });
    const token = '123456789:AAHfakefakefakefakefakefakefakefake';
    await assert.rejects(telegram.connectTelegram(bot.id, 'not a token'), /does not look like/);
    await telegram.connectTelegram(bot.id, token);
    const pub = bots.publicBot(bots.getBot(bot.id));
    assert.equal(pub.telegram.username, 'shop_helper_bot');
    const code = new URL(pub.telegram.link).searchParams.get('start');
    const msg = (id, text) => ({ chat: { id, type: 'private' }, from: { id, first_name: id === 1 ? 'Alex' : 'Stranger' }, text });
    await telegram.onMessage(bot.id, token, msg(2, 'hello'));
    assert.match(sent.at(-1).text, /private bot/);
    await telegram.onMessage(bot.id, token, msg(1, `/start ${code}`));
    assert.equal(bots.getBot(bot.id).telegram.owners[0].id, 1);
    assert.notEqual(bots.getBot(bot.id).telegram.code, code); // the link works once
    await telegram.onMessage(bot.id, token, msg(2, `/start ${code}`));
    assert.match(sent.at(-1).text, /private bot/);
    script = [{ text: 'Here is **your** plan.' }];
    await telegram.onMessage(bot.id, token, msg(1, 'Make a plan'));
    const taskId = bots.getBot(bot.id).telegram.threads[1];
    await finished(bot.id, taskId);
    await until(() => sent.some((m) => m.chat_id === 1 && /plan/.test(m.text)));
    const answer = sent.find((m) => m.chat_id === 1 && /plan/.test(m.text));
    assert.equal(answer.parse_mode, 'HTML');
    assert.match(answer.text, /<b>your<\/b>/);
    // The next message goes on in the same task (one chat = one conversation), /new starts over.
    script = [{ text: 'Sure.' }];
    await telegram.onMessage(bot.id, token, msg(1, 'Shorter please'));
    assert.equal(bots.getBot(bot.id).telegram.threads[1], taskId);
    await until(() => sent.some((m) => m.text === 'Sure.'));
    await telegram.onMessage(bot.id, token, msg(1, '/new'));
    assert.equal(bots.getBot(bot.id).telegram.threads[1], undefined);
    telegram.disconnectTelegram(bot.id);
    assert.equal(bots.getBot(bot.id).telegram.token, '');
  } finally {
    telegram.stopTelegram();
    srv.close();
  }
});

// Found in the 0.2.19 review: a customer was sent Hearth's own error ("No model is loaded. Open Hearth…").
test('Telegram: a customer never sees what went wrong inside, the owner does', async () => {
  const sent = [];
  const srv = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const method = req.url.split('/').pop();
      const body = raw && raw.startsWith('{') ? JSON.parse(raw) : {};
      const reply = (result) => res.end(JSON.stringify({ ok: true, result }));
      if (method === 'getMe') return reply({ username: 'shop_replies_bot', first_name: 'Shop' });
      if (method === 'getUpdates') return setTimeout(() => reply([]), 100);
      if (method === 'sendMessage') sent.push(body);
      reply(true);
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  process.env.HEARTH_TELEGRAM_API = `http://127.0.0.1:${srv.address().port}`;
  try {
    const bot = await bots.createBot({ template: 'support' }); // answers anyone
    const token = '987654321:AAHfakefakefakefakefakefakefakefake';
    await telegram.connectTelegram(bot.id, token);
    const code = new URL(bots.publicBot(bots.getBot(bot.id)).telegram.link).searchParams.get('start');
    const msg = (id, text) => ({ chat: { id, type: 'private' }, from: { id, first_name: id === 1 ? 'Alex' : 'Customer' }, text });
    const broken = () => {
      throw new Error('No model is loaded. Open Hearth and pick a model.');
    };
    script = [broken];
    await telegram.onMessage(bot.id, token, msg(7, 'How much is a hoodie?'));
    await finished(bot.id, bots.getBot(bot.id).telegram.threads[7]);
    const toCustomer = await until(() => sent.find((m) => m.chat_id === 7));
    assert.match(toCustomer.text, /can’t answer right now/);
    assert.ok(!sent.some((m) => m.chat_id === 7 && /model|Hearth/i.test(m.text)), 'nothing about the inside reaches a customer');
    await telegram.onMessage(bot.id, token, msg(1, `/start ${code}`));
    script = [broken];
    await telegram.onMessage(bot.id, token, msg(1, 'Make a plan'));
    await finished(bot.id, bots.getBot(bot.id).telegram.threads[1]);
    assert.ok(await until(() => sent.find((m) => m.chat_id === 1 && /No model is loaded/.test(m.text))), 'the owner is told what went wrong');
  } finally {
    telegram.stopTelegram();
    srv.close();
  }
});

// 0.2.27: a voice message is listened to on the computer and then handled like a written one.
test('Telegram: a voice message becomes text, the owner sees what was heard, and problems are said plainly', async () => {
  const sent = [];
  const srv = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      if (req.url.includes('/file/bot')) return res.end(Buffer.from(`OggS-sound:${req.url.split('/').pop()}`)); // the recording itself
      const method = req.url.split('/').pop();
      const body = raw && raw.startsWith('{') ? JSON.parse(raw) : {};
      const reply = (result) => res.end(JSON.stringify({ ok: true, result }));
      if (method === 'getMe') return reply({ username: 'voice_bot', first_name: 'Voice' });
      if (method === 'getUpdates') return setTimeout(() => reply([]), 100);
      if (method === 'getFile') return reply({ file_path: `voice/${body.file_id}.oga` });
      if (method === 'sendMessage') sent.push(body);
      reply(true);
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  process.env.HEARTH_TELEGRAM_API = `http://127.0.0.1:${srv.address().port}`;
  const real = telegram.listen.speech;
  const heard = [];
  try {
    const bot = await bots.createBot({ template: 'helper' });
    const token = '555555555:AAHfakefakefakefakefakefakefakefake';
    await telegram.connectTelegram(bot.id, token);
    const code = new URL(bots.publicBot(bots.getBot(bot.id)).telegram.link).searchParams.get('start');
    const from = (id) => ({ chat: { id, type: 'private' }, from: { id, first_name: id === 1 ? 'Alex' : 'Stranger' } });
    await telegram.onMessage(bot.id, token, { ...from(1), text: `/start ${code}` });

    telegram.listen.speech = async (buf, opts) => {
      heard.push({ sound: buf.toString(), ...opts });
      return { text: 'Find the price of DTF film', cut: false };
    };
    script = [{ text: 'It costs about 90 dollars.' }];
    const before = calls.length;
    await telegram.onMessage(bot.id, token, { ...from(1), voice: { file_id: 'v1', duration: 6, file_size: 23000 } });
    assert.deepEqual(heard, [{ sound: 'OggS-sound:v1.oga', name: 'voice.ogg', seconds: 600 }], 'the recording is downloaded and listened to');
    assert.ok(sent.some((m) => m.chat_id === 1 && /I heard: “Find the price of DTF film”/.test(m.text)), 'the owner sees what was understood');
    await finished(bot.id, bots.getBot(bot.id).telegram.threads[1]);
    await until(() => sent.some((m) => /90 dollars/.test(m.text)));
    const asked = JSON.stringify(calls[before].messages);
    assert.match(asked, /Find the price of DTF film/, 'the model gets the words');
    assert.match(asked, /This message was spoken/, 'and is told they came from speech');

    // A caption typed with a sound file stays in front of what was said.
    script = [{ text: 'Done.' }];
    const n = calls.length;
    await telegram.onMessage(bot.id, token, { ...from(1), caption: 'For the shop:', audio: { file_id: 'a2', duration: 30, file_name: 'memo.m4a' } });
    assert.equal(heard.at(-1).name, 'memo.m4a');
    await until(() => calls.length > n);
    assert.match(JSON.stringify(calls[n].messages), /For the shop:\\n\\nFind the price of DTF film/);

    // Too long, nothing audible, no voice input, no way to read the file: each gets a plain answer and no task.
    const tasksBefore = bots.listTasks(bot.id).length;
    await telegram.onMessage(bot.id, token, { ...from(1), voice: { file_id: 'v3', duration: 601 } });
    assert.match(sent.at(-1).text, /too long for me: 10 minutes at most/);
    telegram.listen.speech = async () => ({ text: '', cut: false });
    await telegram.onMessage(bot.id, token, { ...from(1), voice: { file_id: 'v4', duration: 3 } });
    assert.match(sent.at(-1).text, /could not make out any words/);
    telegram.listen.speech = async () => {
      throw Object.assign(new Error('x'), { code: 'NO_VOICE' });
    };
    await telegram.onMessage(bot.id, token, { ...from(1), voice: { file_id: 'v5', duration: 3 } });
    assert.match(sent.at(-1).text, /Settings → Voice/);
    telegram.listen.speech = async () => {
      throw Object.assign(new Error('x'), { code: 'NO_DECODER' });
    };
    await telegram.onMessage(bot.id, token, { ...from(1), voice: { file_id: 'v6', duration: 3 } });
    assert.match(sent.at(-1).text, /can’t open voice recordings on this computer yet/);
    telegram.listen.speech = async () => {
      throw new Error(`failed for ${token}`);
    };
    await telegram.onMessage(bot.id, token, { ...from(1), voice: { file_id: 'v7', duration: 3 } });
    assert.match(sent.at(-1).text, /could not listen to the recording: failed for \*\*\*/, 'the key never reaches a message');
    await telegram.onMessage(bot.id, token, { ...from(1), video_note: { file_id: 'n8', duration: 3 } });
    assert.match(sent.at(-1).text, /can’t watch videos yet/);
    assert.equal(bots.listTasks(bot.id).length, tasksBefore, 'none of these started a task');
    // A private bot does not listen to strangers at all.
    const listened = heard.length;
    telegram.listen.speech = async (buf, opts) => (heard.push(opts), { text: 'hi', cut: false });
    await telegram.onMessage(bot.id, token, { ...from(2), voice: { file_id: 'v9', duration: 3 } });
    assert.equal(heard.length, listened);
  } finally {
    telegram.listen.speech = real;
    telegram.stopTelegram();
    srv.close();
  }
});

// 0.2.28: something shows up in the chat at once, and the same message becomes the finished answer.
test('Telegram: one message follows the work (the step, then the answer as it is written) and ends as the answer', async () => {
  const log = [];
  const srv = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const method = req.url.split('/').pop();
      const body = raw && raw.startsWith('{') ? JSON.parse(raw) : {};
      const reply = (result) => res.end(JSON.stringify({ ok: true, result }));
      if (method === 'getMe') return reply({ username: 'live_bot', first_name: 'Live' });
      if (method === 'getUpdates') return setTimeout(() => reply([]), 100);
      if (method === 'sendMessage' || method === 'editMessageText' || method === 'deleteMessage') log.push({ method, ...body });
      if (method === 'sendMessage') return reply({ message_id: 500 + log.length });
      reply(true);
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  process.env.HEARTH_TELEGRAM_API = `http://127.0.0.1:${srv.address().port}`;
  const gap = telegram.live.gap;
  telegram.live.gap = 0;
  try {
    const bot = await bots.createBot({ template: 'helper' });
    const token = '424242424:AAHfakefakefakefakefakefakefakefake';
    await telegram.connectTelegram(bot.id, token);
    const code = new URL(bots.publicBot(bots.getBot(bot.id)).telegram.link).searchParams.get('start');
    const msg = (text) => ({ chat: { id: 1, type: 'private' }, from: { id: 1, first_name: 'Alex' }, text });
    await telegram.onMessage(bot.id, token, msg(`/start ${code}`));
    log.length = 0;

    const answer = 'Done: I wrote **report.md** with the three shops and their prices.';
    // The model takes a moment before it writes, as a real one does: the step message is out by then.
    const slowly = async () => {
      await sleep(200);
      return sse([{ choices: [{ delta: { content: answer } }] }, { choices: [{ delta: {}, finish_reason: 'stop' }], timings: { prompt_n: 100, predicted_n: 5, predicted_per_second: 15 } }]);
    };
    script = [{ tools: [{ name: 'write_file', args: { path: 'report.md', content: '# Shops' } }] }, slowly];
    await telegram.onMessage(bot.id, token, msg('Compare three shops and save a report'));
    await finished(bot.id, bots.getBot(bot.id).telegram.threads[1]);
    const last = await until(() => log.find((m) => m.method === 'editMessageText' && m.parse_mode === 'HTML'));
    const first = log[0];
    assert.equal(first.method, 'sendMessage', 'the chat hears from the bot as soon as it starts a step');
    assert.match(first.text, /^📝 .*: report\.md…$/, `the step it is on: ${first.text}`);
    assert.equal(first.parse_mode, undefined, 'unfinished text goes out as plain text');
    assert.ok(log.some((m) => m.method === 'editMessageText' && m.text === `${answer} …`), 'the answer shows while it is written');
    assert.equal(last.message_id, first.message_id ?? last.message_id);
    assert.match(last.text, /Done: I wrote <b>report\.md<\/b>/, 'the same message ends as the finished answer');
    assert.equal(log.filter((m) => m.method === 'sendMessage').length, 1, 'the answer is not sent a second time');

    // A short answer is not worth a message that changes: it comes once, finished.
    log.length = 0;
    script = [{ text: 'Hello!' }];
    await telegram.onMessage(bot.id, token, msg('Hi'));
    await until(() => log.some((m) => m.text === 'Hello!'));
    assert.deepEqual(log.map((m) => m.method), ['sendMessage']);

    // A long answer: the live message takes the first part, the rest follows in new messages.
    log.length = 0;
    const long = `${'A line of the long answer that goes on and on.\n'.repeat(120)}The end.`;
    script = [{ text: long }];
    await telegram.onMessage(bot.id, token, msg('Tell me everything'));
    await until(() => log.some((m) => m.method === 'sendMessage' && /The end\./.test(m.text)));
    assert.equal(log[0].method, 'sendMessage');
    assert.ok(log[0].text.length <= 3803, 'the live message stays within what Telegram takes');
    assert.ok(log.some((m) => m.method === 'editMessageText' && m.parse_mode === 'HTML' && /^A line of the long answer/.test(m.text)));
    assert.ok(log.filter((m) => m.method === 'sendMessage').length >= 2);
  } finally {
    telegram.live.gap = gap;
    telegram.stopTelegram();
    srv.close();
  }
});

test('a bot in Telegram is told to answer simple things at once and keep tools for real work', () => {
  const bot = { name: 'Helper', folder: '/tmp/x', tools: {} };
  const owner = agent.systemPrompt(bot, { source: 'telegram', chat: { name: 'Alex', owner: true } }, [], false);
  assert.match(owner, /simple question gets a direct answer at once, without tools/);
  assert.doesNotMatch(agent.systemPrompt(bot, { source: 'app' }, [], false), /direct answer at once/);
});

// 0.2.32: a document sent to the bot is read at once, and its words go to the model with the message. Before, the
// model had to think of read_file itself, and after one failure it kept saying it could not read PDFs.
test('Telegram: a document sent to the bot reaches the model as text, and stays in the work folder', async () => {
  const { docxBytes } = await import('../server/docx.mjs');
  const files = { d1: Buffer.from(await docxBytes('# Retainer agreement\n\nThe client agrees to the terms. Signature: ________')), t2: Buffer.from('Price list\nHoodie: 45 dollars'), z3: Buffer.from([0x50, 0x4b, 3, 4, 0, 0, 0, 0, 1, 2, 3]) };
  const srv = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      if (req.url.includes('/file/bot')) return res.end(files[req.url.split('/').pop()]);
      const method = req.url.split('/').pop();
      const body = raw && raw.startsWith('{') ? JSON.parse(raw) : {};
      const reply = (result) => res.end(JSON.stringify({ ok: true, result }));
      if (method === 'getMe') return reply({ username: 'doc_bot', first_name: 'Docs' });
      if (method === 'getUpdates') return setTimeout(() => reply([]), 100);
      if (method === 'getFile') return reply({ file_path: `documents/${body.file_id}` });
      reply(true);
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  process.env.HEARTH_TELEGRAM_API = `http://127.0.0.1:${srv.address().port}`;
  try {
    const bot = await bots.createBot({ template: 'helper' });
    const token = '777777777:AAHfakefakefakefakefakefakefakefake';
    await telegram.connectTelegram(bot.id, token);
    const code = new URL(bots.publicBot(bots.getBot(bot.id)).telegram.link).searchParams.get('start');
    const from = { chat: { id: 1, type: 'private' }, from: { id: 1, first_name: 'Alex' } };
    await telegram.onMessage(bot.id, token, { ...from, text: `/start ${code}` });
    const ask = async (msg) => {
      script = [{ text: 'Checked.' }];
      const n = calls.length;
      await telegram.onMessage(bot.id, token, { ...from, ...msg });
      await until(() => calls.length > n);
      await finished(bot.id, bots.getBot(bot.id).telegram.threads[1]);
      return JSON.stringify(calls[n].messages);
    };
    const word = await ask({ caption: 'Check this form', document: { file_id: 'd1', file_name: 'Retainer (2).docx', file_size: files.d1.length } });
    assert.match(word, /Check this form/);
    assert.match(word, /saved in your work folder as Telegram\/Retainer \(2\)\.docx\. You have already read it; this is its text:/);
    assert.match(word, /# Retainer agreement\\nThe client agrees to the terms\. Signature: ________/, 'the words of the document are in the message');
    assert.ok(fs.existsSync(path.join(bots.workFolder(bots.getBot(bot.id)), 'Telegram', 'Retainer (2).docx')));
    assert.match(await ask({ document: { file_id: 't2', file_name: 'prices.txt', file_size: files.t2.length } }), /Hoodie: 45 dollars/);
    // Something that is not a text or a document is only named, as before.
    const other = await ask({ document: { file_id: 'z3', file_name: 'photos.zip', file_size: files.z3.length } });
    assert.match(other, /saved in your work folder as Telegram\/photos\.zip; read it with read_file if the task needs it/);
  } finally {
    telegram.stopTelegram();
    srv.close();
  }
});

// 0.2.29: someone who spoke to the bot gets the answer as a voice message too.
test('Telegram: a spoken question gets a written answer and a voice message; a written one gets text only', async () => {
  const log = [];
  const srv = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      if (req.url.includes('/file/bot')) return res.end(Buffer.from('OggS-sound'));
      const method = req.url.split('/').pop();
      const text = raw.toString('latin1');
      const body = text.startsWith('{') ? JSON.parse(raw.toString('utf8')) : {};
      const reply = (result) => res.end(JSON.stringify({ ok: true, result }));
      if (method === 'getMe') return reply({ username: 'talk_bot', first_name: 'Talk' });
      if (method === 'getUpdates') return setTimeout(() => reply([]), 100);
      if (method === 'getFile') return reply({ file_path: 'voice/x.oga' });
      if (method === 'sendVoice') log.push({ method, type: req.headers['content-type'], hasSound: text.includes('SPOKEN-ANSWER-BYTES'), name: /filename="([^"]+)"/.exec(text)?.[1], duration: /name="duration"\r\n\r\n(\d+)/.exec(text)?.[1], chat: /name="chat_id"\r\n\r\n(\d+)/.exec(text)?.[1] });
      else if (['sendMessage', 'editMessageText', 'sendChatAction'].includes(method)) log.push({ method, ...body });
      if (method === 'sendMessage') return reply({ message_id: 900 + log.length });
      reply(true);
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  process.env.HEARTH_TELEGRAM_API = `http://127.0.0.1:${srv.address().port}`;
  const real = { ...telegram.listen };
  const read = [];
  try {
    const bot = await bots.createBot({ template: 'helper' });
    const token = '888888888:AAHfakefakefakefakefakefakefakefake';
    await telegram.connectTelegram(bot.id, token);
    assert.equal(bots.publicBot(bots.getBot(bot.id)).telegram.voiceReplies, true, 'on unless turned off');
    const code = new URL(bots.publicBot(bots.getBot(bot.id)).telegram.link).searchParams.get('start');
    const from = { chat: { id: 1, type: 'private' }, from: { id: 1, first_name: 'Alex' } };
    await telegram.onMessage(bot.id, token, { ...from, text: `/start ${code}` });
    telegram.listen.speech = async () => ({ text: 'How much is the film?', cut: false });
    telegram.listen.say = async (text) => {
      read.push(text);
      return { data: Buffer.from('SPOKEN-ANSWER-BYTES'), name: 'answer.ogg', mime: 'audio/ogg', seconds: 4 };
    };
    const turn = async (msg, answer) => {
      log.length = 0;
      script = [{ text: answer }];
      await telegram.onMessage(bot.id, token, { ...from, ...msg });
      await finished(bot.id, bots.getBot(bot.id).telegram.threads[1]);
      await until(() => log.some((m) => (m.method === 'sendMessage' || m.method === 'editMessageText') && m.text?.startsWith(answer.split(' ')[0])));
      await sleep(150); // the voice message follows the text
      return log.slice();
    };

    let out = await turn({ voice: { file_id: 'v1', duration: 3 } }, 'About **90 dollars** a roll.');
    const voice = out.find((m) => m.method === 'sendVoice');
    assert.ok(voice, 'a voice message is sent');
    assert.deepEqual([voice.hasSound, voice.name, voice.duration, voice.chat], [true, 'answer.ogg', '4', '1']);
    assert.match(voice.type, /^multipart\/form-data/);
    assert.deepEqual(read, ['About **90 dollars** a roll.'], 'the answer itself is what gets read');
    assert.ok(out.findIndex((m) => m.method === 'sendVoice') > out.findIndex((m) => /90 dollars/.test(m.text || '')), 'the written answer comes first');
    assert.ok(out.some((m) => m.method === 'sendChatAction' && m.action === 'record_voice'), 'the chat shows "recording voice" meanwhile');
    assert.equal(bots.getTask(bot.id, bots.getBot(bot.id).telegram.threads[1]).messages.find((m) => m.role === 'user').spoken, true);

    // A typed question: text only.
    out = await turn({ text: 'And two rolls?' }, 'About 180 dollars.');
    assert.equal(out.some((m) => m.method === 'sendVoice'), false);

    // Nothing fit to read aloud (the stand-in returns null, as for a long answer or code): text only, no fuss.
    telegram.listen.say = async () => null;
    out = await turn({ voice: { file_id: 'v2', duration: 3 } }, 'Here is the long table you asked for.');
    assert.equal(out.some((m) => m.method === 'sendVoice'), false);

    // The computer has no voice for the language: the owner is told why, once, and still has the text.
    telegram.listen.say = async () => {
      throw Object.assign(new Error('en-US'), { code: 'NO_VOICE' });
    };
    out = await turn({ voice: { file_id: 'v3', duration: 3 } }, 'It is in stock today.');
    assert.ok(out.some((m) => /no voice for this language/.test(m.text || '')));
    out = await turn({ voice: { file_id: 'v4', duration: 3 } }, 'Yes, still in stock.');
    assert.equal(out.some((m) => /no voice for this language/.test(m.text || '')), false, 'not said again the same day');

    // Turned off for this bot.
    bots.saveBot(bot.id, { voiceReplies: false });
    telegram.listen.say = async () => ({ data: Buffer.from('SPOKEN-ANSWER-BYTES'), name: 'answer.ogg', mime: 'audio/ogg', seconds: 2 });
    out = await turn({ voice: { file_id: 'v5', duration: 3 } }, 'Tomorrow at nine.');
    assert.equal(out.some((m) => m.method === 'sendVoice'), false);
  } finally {
    Object.assign(telegram.listen, real);
    telegram.stopTelegram();
    srv.close();
  }
});
