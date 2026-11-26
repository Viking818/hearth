// The chat's conveniences of 0.2.25: quotes, "Summarize and continue", pin and archive, keyboard shortcuts and the
// command palette's search, and the move of older installs to the search without a key. No model or network needed.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.HEARTH_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-test-'));
const { apiMessages, quoteText } = await import('../public/js/media.js');
const { contextUse, planCompact, summaryParts, summarize, plainMessage } = await import('../public/js/compact.js');
const { comboOf, fmtCombo, usable, activeShortcuts, filterItems, SHORTCUTS } = await import('../public/js/keys.js');
const { saveChat, getChat, listChats, flagChat } = await import('../server/chats.mjs');
const { getSettings, updateSettings } = await import('../server/settings.mjs');

const u = (id, content, more = {}) => ({ id, role: 'user', content, ...more });
const a = (id, content, more = {}) => ({ id, role: 'assistant', content, ...more });
const textOf = (m) => (typeof m.content === 'string' ? m.content : m.content[0].text);

test('a quote goes to the model in front of the user’s words', () => {
  const q = [{ text: 'wash cold\ninside out', from: 'assistant', msgId: 'a1' }, { text: 'my own words', from: 'user', msgId: 'u1' }];
  assert.equal(quoteText(q), 'The user quotes this part of your earlier answer:\n> wash cold\n> inside out\n\nThe user quotes their own earlier message:\n> my own words');
  const out = apiMessages([u('u1', 'Hi'), a('a1', 'wash cold\ninside out'), u('u2', 'Why cold?', { quotes: [q[0]] })]);
  assert.equal(out.length, 3);
  assert.equal(out[2].content, 'The user quotes this part of your earlier answer:\n> wash cold\n> inside out\n\nWhy cold?');
  assert.equal(apiMessages([u('u1', 'Hi', { quotes: [] })])[0].content, 'Hi');
});

test('after “Summarize and continue” the model gets the summary and only the newer messages', () => {
  const msgs = [u('u1', 'First'), a('a1', 'One'), u('u2', 'Second'), a('a2', 'Two'), u('u3', 'Third')];
  const out = apiMessages(msgs, { summary: { upto: 'a1', text: 'They talked about one.' } });
  assert.deepEqual(out.map((m) => m.role), ['user', 'assistant', 'user'], 'turns still take turns');
  assert.match(out[0].content, /^\[Summary of the earlier part of this conversation[\s\S]*They talked about one\.\]\n\nSecond$/);
  assert.equal(out[2].content, 'Third');
  // The summarized question was edited away: the summary no longer describes this chat.
  assert.equal(apiMessages(msgs, { summary: { upto: 'gone', text: 'Old.' } }).length, 5);
  // A chat that continues another one: the summary rides with the first message, also one with a picture.
  const fresh = apiMessages([u('u1', 'Go on', { images: [{ url: '/uploads/a.png' }] })], { summary: { upto: '', text: 'Earlier chat.' } });
  assert.equal(fresh.length, 1);
  assert.match(fresh[0].content[0].text, /Earlier chat\.\]\n\nGo on$/);
  assert.equal(fresh[0].content[1].image_url.url, '/uploads/a.png');
});

test('how full the model’s memory is comes from the newest answer’s numbers', () => {
  const msgs = [u('u1', 'Hi'), a('a1', 'Hello', { at: 100, stats: { promptTokens: 3000, outputTokens: 400 } })];
  assert.equal(contextUse(msgs, 4000), 0.85);
  assert.equal(contextUse(msgs, 0), 0);
  assert.equal(contextUse([u('u1', 'Hi')], 4000), 0);
  assert.equal(contextUse(msgs, 4000, { at: 200, text: 's' }), 0, 'summed up after that answer: not known until the next one');
  assert.equal(contextUse(msgs, 4000, { at: 50, text: 's' }), 0.85);
  assert.equal(contextUse(msgs, 2000), 1);
});

test('summing up keeps the newest two questions word for word, or one when they are long', () => {
  const msgs = [u('u1', 'First'), a('a1', 'One'), u('u2', 'Second'), a('a2', 'Two'), u('u3', 'Third'), a('a3', 'Three'), u('u4', 'Fourth')];
  const plan = planCompact(msgs, null, 32768);
  assert.deepEqual(plan.older.map((m) => m.id), ['u1', 'a1', 'u2', 'a2']);
  assert.equal(plan.upto, 'a2');
  // The newest two exchanges are long: only the last question stays.
  const long = msgs.map((m) => (m.id === 'a3' ? { ...m, content: 'word '.repeat(4000) } : m));
  assert.equal(planCompact(long, null, 8192).upto, 'a3');
  // After one summary the next one starts behind it.
  const next = planCompact([...msgs, a('a4', 'Four'), u('u5', 'Fifth'), a('a5', 'Five'), u('u6', 'Sixth')], { upto: 'a2', text: 's' }, 32768);
  assert.deepEqual(next.older.map((m) => m.id), ['u3', 'a3', 'u4', 'a4']);
  assert.equal(planCompact([u('u1', 'Only')], null, 32768), null);
  assert.equal(planCompact([u('u1', 'One'), a('a1', '1'), u('u2', 'Two')], null, 32768).upto, 'a1', 'with two questions the first exchange is summed up');
});

test('long chats are summed up in pieces, each carrying the summary so far', async () => {
  const older = [];
  for (let i = 0; i < 12; i++) older.push(u(`u${i}`, `Question ${i} ${'x'.repeat(900)}`), a(`a${i}`, `Answer ${i} ${'y'.repeat(900)}`));
  const parts = summaryParts(older, 4096); // 1638 tokens a piece → about 4900 characters
  assert.ok(parts.length >= 4, `${parts.length} parts`);
  assert.ok(parts.every((p) => p.length <= 4914));
  assert.match(parts[0], /^User: Question 0/);
  assert.equal(parts.join('\n\n').match(/Answer \d+ /g).length, 12, 'nothing is lost between the pieces');
  // One message longer than a piece is cut, not dropped.
  const huge = summaryParts([u('u', 'z'.repeat(12000))], 4096);
  assert.equal(huge.length, 3);
  assert.match(huge[1], /^\(continued\)/);

  const seen = [];
  const sum = await summarize({ parts: ['part one', 'part two'], previous: 'older summary', ask: async (messages) => (seen.push(messages), `<think>hm</think> summary ${seen.length}`), onProgress: () => {} });
  assert.equal(sum, 'summary 2');
  assert.match(seen[0][1].content, /^Summary of the conversation so far:\nolder summary\n\nThe next part of the conversation:\n\npart one/);
  assert.match(seen[1][1].content, /^Summary of the conversation so far:\nsummary 1\n\n/);
  assert.equal(seen[0][0].role, 'system');
  await assert.rejects(summarize({ parts: ['x'], ask: async () => '  ' }), /empty/);
  assert.equal(plainMessage(u('u', 'See', { files: [{ name: 'a.txt', text: 'hello' }], images: [{}, {}], quotes: [{ text: 'that' }] })), 'User: (quoting: "that")\nSee\n[file "a.txt": hello]\n[2 picture(s)]');
});

test('a chat keeps its summary, and pin and archive, across saves', () => {
  saveChat('chat0001', { title: 'Shirts', messages: [u('u1', 'Hi')], summary: { upto: 'u1', text: 'A summary.', at: 5 } });
  assert.deepEqual(getChat('chat0001').summary, { upto: 'u1', text: 'A summary.', at: 5 });
  saveChat('chat0001', { title: 'Shirts', messages: [u('u1', 'Hi')] });
  assert.equal(getChat('chat0001').summary.text, 'A summary.', 'a save without the field keeps it');
  const before = getChat('chat0001').updatedAt;
  assert.deepEqual([flagChat('chat0001', { pinned: true }).pinned, listChats()[0].pinned], [true, true]);
  assert.equal(getChat('chat0001').updatedAt, before, 'pinning does not move the chat in the list');
  saveChat('chat0001', { title: 'Shirts 2', messages: [u('u1', 'Hi')], summary: null, pinned: false });
  const c = getChat('chat0001');
  assert.equal(c.summary, undefined, 'null takes the summary away');
  assert.equal(c.pinned, true, 'only the flags call changes pin and archive');
  assert.deepEqual(flagChat('chat0001', { archived: true }), { ...listChats()[0], pinned: false, archived: true }, 'an archived chat is no longer pinned');
  assert.equal(flagChat('nochat01', { pinned: true }), null);
  saveChat('chat0002', { title: 'x', messages: [], summary: { upto: 'u1', text: '   ' } });
  assert.equal(getChat('chat0002').summary, undefined, 'an empty summary is not kept');
});

test('shortcuts follow the key’s place on the keyboard, not the letter it types', () => {
  assert.equal(comboOf({ key: 'k', code: 'KeyK', metaKey: true }, true), 'mod+k');
  assert.equal(comboOf({ key: 'л', code: 'KeyK', metaKey: true }, true), 'mod+k', 'Russian layout');
  assert.equal(comboOf({ key: 'O', code: 'KeyO', ctrlKey: true, shiftKey: true }, false), 'mod+shift+o');
  assert.equal(comboOf({ key: 'k', code: 'KeyK', ctrlKey: true }, true), 'ctrl+k', 'on a Mac Ctrl is its own key');
  assert.equal(comboOf({ key: 'б', code: 'Comma', metaKey: true }, true), 'mod+,');
  assert.equal(comboOf({ key: 'Shift', code: 'ShiftLeft', shiftKey: true }, true), '');
  assert.equal(comboOf({ key: 'Escape', code: 'Escape' }, true), 'esc');
  assert.equal(usable('mod+k'), true);
  assert.equal(usable('shift+k'), false, 'would fire while typing');
  assert.equal(usable('k'), false);
  assert.equal(usable('f5'), true);
  assert.equal(fmtCombo('mod+shift+o', true), '⌘⇧O');
  assert.equal(fmtCombo('mod+shift+o', false), 'Ctrl+Shift+O');
  assert.equal(fmtCombo('', true), '');
  const mine = activeShortcuts({ models: 'mod+alt+j', stop: '', nonsense: 'x' });
  assert.equal(mine.find((s) => s.id === 'models').combo, 'mod+alt+j');
  assert.equal(mine.find((s) => s.id === 'stop').combo, '', 'turned off');
  assert.equal(mine.find((s) => s.id === 'palette').combo, 'mod+k');
  assert.equal(mine.length, SHORTCUTS.length);
  assert.equal(new Set(SHORTCUTS.map((s) => s.combo)).size, SHORTCUTS.length, 'no two defaults share keys');
});

test('the palette finds by every word, with the closest match first', () => {
  const items = [{ label: 'New chat' }, { label: 'Settings', hint: 'Page' }, { label: 'Chat about DTF film', hint: 'Chat' }, { label: 'Models', hint: 'Page' }, { label: 'Keyboard shortcuts', hint: 'Page' }];
  assert.deepEqual(filterItems(items, '').map((i) => i.label), items.map((i) => i.label));
  assert.deepEqual(filterItems(items, 'chat').map((i) => i.label), ['Chat about DTF film', 'New chat']);
  assert.deepEqual(filterItems(items, 'dtf chat').map((i) => i.label), ['Chat about DTF film']);
  assert.deepEqual(filterItems(items, 'SHORT').map((i) => i.label), ['Keyboard shortcuts']);
  assert.deepEqual(filterItems(items, 'page', 2).length, 2);
  assert.deepEqual(filterItems(items, 'zzz'), []);
});

test('an install from before 0.2.25 moves from Wikipedia-only to the search without a key, once', () => {
  assert.equal(getSettings().searchProvider, 'free', 'a new install starts with it');
  const run = (dir) => execFileSync(process.execPath, ['--input-type=module', '-e', `const { getSettings, updateSettings } = await import(${JSON.stringify(path.join(ROOT, 'server/settings.mjs'))}); if (process.argv[1]) updateSettings({ searchProvider: process.argv[1] }); console.log(getSettings().searchProvider);`, ...(dir.set ? [dir.set] : [])], { env: { ...process.env, HEARTH_DATA_DIR: dir.path }, encoding: 'utf8' }).trim();
  const old = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-test-'));
  fs.writeFileSync(path.join(old, 'settings.json'), JSON.stringify({ apiKey: 'hearth-x', searchProvider: 'wikipedia', toolsOn: true }));
  assert.equal(run({ path: old }), 'free');
  assert.equal(run({ path: old, set: 'wikipedia' }), 'wikipedia', 'choosing Wikipedia afterwards…');
  assert.equal(run({ path: old }), 'wikipedia', '…stays');
  const keyed = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-test-'));
  fs.writeFileSync(path.join(keyed, 'settings.json'), JSON.stringify({ apiKey: 'hearth-x', searchProvider: 'brave', searchKey: 'k' }));
  assert.equal(run({ path: keyed }), 'brave', 'a search with a key is left alone');
  updateSettings({ freeSearchOffered: false });
  assert.equal(getSettings().freeSearchOffered, true, 'the page cannot reset the mark');
});
