// Tests for extensions: skills, plugins, plugin collections, commands, and plugins' connectors.
// Run with: npm test. No network needed (GitHub links are only parsed here).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
process.env.HEARTH_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-test-'));
const { updateSettings } = await import('../server/settings.mjs');
const ext = await import('../server/extensions.mjs');
const { inspect, install, parseGithub } = await import('../server/ext-install.mjs');
const { listTools, callTool } = await import('../server/tools.mjs');
const { stopMcp } = await import('../server/mcp.mjs');
const { listAssistants } = await import('../server/assistants.mjs');
const { expandCommand, splitSlash, matchSlash } = await import('../public/js/commands.js');
updateSettings({ language: 'en', toolsOn: true, toolApproval: 'ask' });

// Write a folder tree: { 'a/b.txt': 'text' }.
function tree(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-ext-'));
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
  return root;
}

test('SKILL.md headers: plain, quoted, folded, block and list values', () => {
  const a = ext.parseFrontmatter('---\nname: brand-guidelines\ndescription: Applies brand colors: use it for\n  posters and cards.\nlicense: "MIT"\n---\n\n# Body\nText');
  assert.equal(a.data.name, 'brand-guidelines');
  assert.equal(a.data.description, 'Applies brand colors: use it for posters and cards.');
  assert.equal(a.data.license, 'MIT');
  assert.equal(a.body.trim(), '# Body\nText');
  const b = ext.parseFrontmatter("---\ndescription: >\n  Folded\n  text\nnotes: |\n  line 1\n  line 2\ntools:\n  - Read\n  - Grep\nargument-hint: '[file]'\n---\nx");
  assert.equal(b.data.description, 'Folded text');
  assert.equal(b.data.notes, 'line 1\nline 2');
  assert.deepEqual(b.data.tools, ['Read', 'Grep']);
  assert.equal(b.data['argument-hint'], '[file]');
  assert.deepEqual(ext.parseFrontmatter('No header here').data, {});
  assert.equal(ext.parseFrontmatter('---\n---\nBody').body, 'Body');
});

test('commands: $ARGUMENTS, $1, text added at the end, shell lines dropped; the / menu matches', () => {
  assert.equal(expandCommand('Card for $ARGUMENTS.', 'black hoodie'), 'Card for black hoodie.');
  assert.equal(expandCommand('Compare $1 and $2', 'tee hoodie'), 'Compare tee and hoodie');
  assert.equal(expandCommand('Write a post.', 'about the sale'), 'Write a post.\n\nabout the sale');
  assert.equal(expandCommand('Status: !`git status`\nDo it', ''), 'Status: \nDo it');
  assert.deepEqual(splitSlash('/card  black hoodie'), { name: 'card', rest: 'black hoodie' });
  assert.equal(splitSlash('no slash'), null);
  const items = [{ name: 'card' }, { name: 'plug:commit' }, { name: 'brand', title: 'Brand guidelines' }];
  assert.deepEqual(matchSlash(items, 'c').map((i) => i.name), ['card', 'plug:commit']);
  assert.deepEqual(matchSlash(items, 'guide').map((i) => i.name), ['brand']);
});

test('GitHub links: repository, folder, file, shorthand', () => {
  assert.deepEqual(parseGithub('https://github.com/anthropics/skills'), { owner: 'anthropics', repo: 'skills', ref: '', sub: '' });
  assert.deepEqual(parseGithub('github.com/anthropics/skills/tree/main/skills/pdf'), { owner: 'anthropics', repo: 'skills', ref: 'main', sub: 'skills/pdf' });
  assert.deepEqual(parseGithub('https://github.com/a/b/blob/main/skills/x/SKILL.md'), { owner: 'a', repo: 'b', ref: 'main', sub: 'skills/x' });
  assert.deepEqual(parseGithub('https://github.com/a/b/blob/main/p/.claude-plugin/plugin.json'), { owner: 'a', repo: 'b', ref: 'main', sub: 'p' });
  assert.deepEqual(parseGithub('anthropics/claude-plugins-official'), { owner: 'anthropics', repo: 'claude-plugins-official', ref: '', sub: '' });
  assert.equal(parseGithub('https://gitlab.com/a/b'), null);
  assert.equal(parseGithub('not a link'), null);
});

test('a skill from a folder: install, use_skill, its files, nothing outside it, and in the prompt', async () => {
  const src = tree({ 'shop-cards/SKILL.md': '---\nname: shop-cards\ndescription: Use when writing product cards for the shop.\n---\n\nWrite a title, 3 sentences and 10 tags. See reference/tone.md.', 'shop-cards/reference/tone.md': 'Friendly, short.', 'shop-cards/scripts/make.py': 'print(1)' });
  const found = await inspect({ folder: src });
  assert.equal(found.kind, 'skills');
  assert.equal(found.skills[0].name, 'shop-cards');
  const r = await install(found.token);
  assert.deepEqual(r.skills, ['shop-cards']);
  assert.ok(fs.existsSync(path.join(src, 'shop-cards', 'SKILL.md')), 'the user’s own folder is left alone');
  const s = ext.listSkills().find((x) => x.id === 'shop-cards');
  assert.equal(s.source, `folder:${fs.realpathSync(src)}`);
  assert.equal(s.scripts, 1);
  const used = await callTool('use_skill', { name: 'shop-cards' });
  assert.match(used, /Write a title, 3 sentences/);
  assert.match(used, /reference\/tone\.md/);
  assert.match(used, /cannot run this skill’s scripts/);
  assert.equal(await callTool('read_skill_file', { skill: 'shop-cards', path: 'reference/tone.md' }), 'Friendly, short.');
  await assert.rejects(() => callTool('read_skill_file', { skill: 'shop-cards', path: '../../state.json' }), /No file/);
  await assert.rejects(() => callTool('use_skill', { name: 'nope' }), /No skill named “nope”/);
  assert.ok((await listTools()).tools.some((x) => x.name === 'use_skill'));
  assert.equal(ext.skillsMode(), 'full');
  assert.match(ext.skillsList(), /- shop-cards: Use when writing product cards/);
  assert.match(ext.activeSkillsPrompt(['shop-cards']), /switched on in this chat[\s\S]*Write a title/);
  assert.equal(ext.activeSkillsPrompt(['nope']), '');
  // Off: gone from the tools and the prompt.
  ext.setSkillEnabled('shop-cards', false);
  assert.equal(ext.skillsList(), '');
  assert.ok(!(await listTools()).tools.some((x) => x.name === 'use_skill'));
  ext.setSkillEnabled('shop-cards', true);
});

test('own skills: write, rename, refuse duplicates, never overwritten by an install, delete', async () => {
  const a = ext.saveOwnSkill('new', { name: 'Ответы клиентам', description: 'Use for replies to customers.', instructions: 'Be kind.' });
  assert.equal(a.id, 'ответы-клиентам');
  assert.equal(a.editable, true);
  const b = ext.saveOwnSkill(a.id, { name: 'replies', description: 'Use for replies.', instructions: 'Be brief.' });
  assert.equal(b.id, 'replies');
  assert.ok(!ext.listSkills().some((x) => x.id === a.id));
  assert.throws(() => ext.saveOwnSkill('new', { name: 'replies', description: 'x', instructions: 'y' }), /already exists/);
  // Found in the 0.2.19 review: an id that is a path ("../../chats") moved that folder into the skills folder.
  const outside = path.join(process.env.HEARTH_DATA_DIR, 'keep-me');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'file.txt'), 'important');
  for (const id of ['../../keep-me', '..', '../skills/replies', 'a/b', '.']) assert.throws(() => ext.saveOwnSkill(id, { name: 'moved', description: 'x', instructions: 'y' }), /not found/i, id);
  assert.equal(fs.readFileSync(path.join(outside, 'file.txt'), 'utf8'), 'important');
  assert.ok(!fs.existsSync(path.join(ext.SKILLS_DIR, 'moved')), 'no skill was made from it');
  assert.throws(() => ext.saveOwnSkill('new', { name: 'x', description: '', instructions: 'y' }), /when the skill should be used/);
  // An installed skill with the same name gets its own folder.
  const src = tree({ 'SKILL.md': '---\nname: replies\ndescription: From GitHub.\n---\nOther.' });
  const r = await install((await inspect({ folder: src })).token);
  assert.deepEqual(r.skills, ['replies-2']);
  assert.match(ext.getSkill('replies').body, /Be brief/);
  assert.throws(() => ext.saveOwnSkill('replies-2', { name: 'replies-2', description: 'x', instructions: 'y' }), /Only your own skills/);
  ext.deleteSkill('replies');
  ext.deleteSkill('replies-2');
  assert.ok(!ext.listSkills().some((x) => x.id.startsWith('replies')));
});

test('a plugin: skills, commands, assistants and a connector that stays off until turned on', async () => {
  const mock = path.join(HERE, 'mcp-mock.mjs');
  const src = tree({
    '.claude-plugin/plugin.json': JSON.stringify({ name: 'Print Shop', description: 'Helpers for a print shop', version: '1.2.0', author: { name: 'Alex' } }),
    'skills/sizes/SKILL.md': '---\nname: sizes\ndescription: Use for T-shirt size questions.\n---\nS M L XL.',
    'commands/quote.md': '---\ndescription: Price a print order\nargument-hint: [order]\n---\nPrice this order: $ARGUMENTS',
    'commands/files/list.md': 'List the files.',
    'agents/designer.md': '---\nname: designer\ndescription: Helps with print designs\ntools: Read, Grep\n---\nYou are a print designer.',
    '.mcp.json': JSON.stringify({ mcpServers: { calc: { command: process.execPath, args: ['${CLAUDE_PLUGIN_ROOT}/mock.mjs'], env: { TOKEN: '${SHOP_TOKEN}' } } } }),
    'hooks/hooks.json': '{}',
    'README.md': 'readme',
  });
  fs.copyFileSync(mock, path.join(src, 'mock.mjs'));
  const found = await inspect({ folder: src });
  assert.equal(found.kind, 'plugin');
  assert.equal(found.plugin.name, 'Print Shop');
  assert.deepEqual(found.plugin.commands, ['files:list', 'quote']);
  assert.deepEqual(found.plugin.connectors.map((c) => [c.name, c.kind, c.needs]), [['calc', 'program', ['SHOP_TOKEN']]]);
  assert.equal(found.plugin.hooks, true);
  const r = await install(found.token);
  assert.deepEqual(r.plugins, ['print-shop']);

  const p = ext.listPlugins().map(ext.publicPlugin).find((x) => x.id === 'print-shop');
  assert.equal(p.version, '1.2.0');
  assert.deepEqual(p.skills, ['sizes']);
  assert.ok(ext.listSkills().some((s) => s.id === 'print-shop:sizes' && s.enabled));
  const cmd = ext.listCommands().find((c) => c.name === 'quote');
  assert.equal(cmd.hint, '[order]');
  assert.equal(expandCommand(cmd.prompt, 'order 7'), 'Price this order: order 7');
  assert.ok(ext.slashMenu().some((i) => i.kind === 'skill' && i.id === 'print-shop:sizes' && i.name === 'sizes'), 'typed by its short name');
  const designer = listAssistants().find((a) => a.plugin === 'Print Shop');
  assert.equal(designer.name, 'designer');
  assert.match(designer.instructions, /print designer/);
  assert.match(designer.id, /^p-[0-9a-f]{12}$/);

  // The connector: off, then on but missing its value, then working.
  assert.deepEqual(ext.pluginConnectors(), {});
  ext.updatePlugin('print-shop', { connector: 'calc', connectorOn: true });
  assert.deepEqual(ext.pluginConnectors(), {});
  ext.updatePlugin('print-shop', { values: { SHOP_TOKEN: 'secret' } });
  const cfg = ext.pluginConnectors()['print-shop:calc'];
  assert.equal(cfg.env.TOKEN, 'secret');
  assert.equal(cfg.args[0], path.join(ext.PLUGINS_DIR, 'print-shop', 'mock.mjs'));
  assert.deepEqual(ext.listPlugins().map(ext.publicPlugin)[0].values, { SHOP_TOKEN: true }, 'values are never sent to the page');
  const tools = await listTools();
  const add = tools.tools.find((x) => x.name === 'print-shop_calc__add');
  assert.ok(add, 'the plugin connector’s tool is offered');
  assert.equal(add.ask, true);
  assert.equal(await callTool(add.name, { a: 2, b: 3 }, { approved: add.name }), '5');

  // A plugin switched off takes its parts with it.
  ext.updatePlugin('print-shop', { enabled: false });
  assert.ok(!ext.listSkills().find((s) => s.id === 'print-shop:sizes').enabled);
  assert.ok(!ext.listCommands().find((c) => c.name === 'quote').enabled);
  assert.ok(!listAssistants().some((a) => a.plugin === 'Print Shop'));
  assert.deepEqual(ext.pluginConnectors(), {});
  assert.ok(!(await listTools()).tools.some((x) => x.name === add.name));
  ext.removePlugin('print-shop');
  assert.ok(!ext.listPlugins().length);
  stopMcp();
});

test('a collection (marketplace): pick plugins; listed skills from a shared folder become one plugin', async () => {
  const src = tree({
    '.claude-plugin/marketplace.json': JSON.stringify({
      name: 'shop-skills',
      plugins: [
        { name: 'docs', description: 'Document skills', source: './', strict: false, skills: ['./skills/a', './skills/b'] },
        { name: 'helper', source: './plugins/helper' },
        { name: 'elsewhere', source: { source: 'url', url: 'https://example.com/x.git' } },
      ],
    }),
    'skills/a/SKILL.md': '---\nname: a\ndescription: Skill A\n---\nA',
    'skills/b/SKILL.md': '---\nname: b\ndescription: Skill B\n---\nB',
    'skills/c/SKILL.md': '---\nname: c\ndescription: Skill C\n---\nC',
    'plugins/helper/commands/hi.md': 'Say hi to $ARGUMENTS',
  });
  const found = await inspect({ folder: src });
  assert.equal(found.kind, 'marketplace');
  assert.deepEqual(found.plugins.map((x) => [x.name, x.available]), [['docs', true], ['helper', true], ['elsewhere', false]]);
  assert.deepEqual(found.plugins[0].parts, { skills: 2, commands: 0, agents: 0, connectors: 0 });
  await assert.rejects(() => install(found.token, { pick: [] }), /Pick what to install/);
  const again = await inspect({ folder: src });
  const r = await install(again.token, { pick: ['docs', 'helper'] });
  assert.deepEqual(r.plugins.sort(), ['docs', 'helper']);
  const docs = ext.listPlugins().map(ext.publicPlugin).find((x) => x.id === 'docs');
  assert.deepEqual(docs.skills.sort(), ['a', 'b'], 'only the listed skills');
  assert.ok(ext.listCommands().some((c) => c.name === 'hi' && c.plugin === 'helper'));
  ext.removePlugin('docs');
  ext.removePlugin('helper');
});

test('a .zip file with one skill in a folder', async (t) => {
  const src = tree({ 'pack/my-skill/SKILL.md': '---\nname: zipped\ndescription: From a zip.\n---\nZ' });
  const zip = path.join(os.tmpdir(), `hearth-skill-${Date.now()}.zip`);
  const made = spawnSync('tar', ['--format', 'zip', '-cf', zip, '-C', path.join(src, 'pack'), 'my-skill']);
  if (made.status !== 0) return t.skip('no zip tool here');
  const found = await inspect({ upload: fs.readFileSync(zip), name: 'my-skill.zip' });
  assert.equal(found.kind, 'skills');
  const r = await install(found.token);
  assert.deepEqual(r.skills, ['zipped']);
  assert.equal(ext.listSkills().find((s) => s.id === 'zipped').source, 'file:my-skill.zip');
  ext.deleteSkill('zipped');
  await assert.rejects(() => inspect({ upload: Buffer.from('not a zip'), name: 'x.zip' }), /Could not open this file/);
  await assert.rejects(() => inspect({ folder: tree({ 'notes.txt': 'hi' }) }), /No skills or plugins found/);
});

test('own commands: names, duplicates, plugin commands keep their place', () => {
  const c = ext.saveCommand('new', { name: 'Карточка', description: 'Product card', prompt: 'Card for $ARGUMENTS' });
  assert.equal(c.name, 'карточка');
  assert.throws(() => ext.saveCommand('new', { name: 'карточка', prompt: 'x' }), /already exists/);
  assert.throws(() => ext.saveCommand('new', { name: '   ', prompt: 'x' }), /short name/);
  ext.setCommandEnabled(c.id, false);
  assert.ok(!ext.slashMenu().some((i) => i.name === 'карточка'));
  ext.deleteCommand(c.id);
  assert.throws(() => ext.deleteCommand('plugin:thing'), /Only your own commands/);
});

test('many skills: only names in the prompt, and find_skill looks them up', async () => {
  const files = {};
  for (let i = 1; i <= 30; i++) files[`s${i}/SKILL.md`] = `---\nname: skill-${i}\ndescription: ${i === 7 ? 'Prices for printing T-shirts and hoodies.' : `Helps with task number ${i}, a long description `.repeat(4)}\n---\nBody ${i}`;
  const found = await inspect({ folder: tree(files) });
  await install(found.token);
  assert.equal(ext.skillsMode(), 'names');
  const list = ext.skillsList();
  assert.match(list, /find_skill/);
  assert.match(list, /skill-7/);
  assert.doesNotMatch(list, /Prices for printing/);
  assert.ok(list.length < 2000, `short list (${list.length} chars)`);
  const tools = (await listTools()).tools.map((x) => x.name);
  assert.ok(tools.includes('find_skill') && tools.includes('use_skill'));
  assert.match(await callTool('find_skill', { query: 'T-shirt printing prices' }), /^- skill-7: Prices for printing/);
  assert.match(await callTool('find_skill', { query: 'zzz' }), /No skill matches/);
  for (let i = 1; i <= 30; i++) ext.deleteSkill(`skill-${i}`);
  assert.ok(!(await listTools()).tools.some((x) => x.name === 'find_skill'));
});

test('a package’s extensions are copied in on the first start only, never over what is there', () => {
  const seed = tree({
    'state.json': JSON.stringify({ skills: {}, plugins: { 'seeded-plugin': { enabled: true, source: 'file:x.zip', connectors: { calc: true } } }, commands: [{ id: 'c-1', name: 'hello', prompt: 'Hi $ARGUMENTS' }], commandsOff: [] }),
    'plugins/seeded-plugin/.claude-plugin/plugin.json': JSON.stringify({ name: 'seeded-plugin' }),
    'plugins/seeded-plugin/skills/greet/SKILL.md': '---\nname: greet\ndescription: Greets.\n---\nSay hi.',
    'skills/mine/SKILL.md': '---\nname: mine\ndescription: Mine.\n---\nMine.',
  });
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-seed-'));
  const list = (seedDir) =>
    JSON.parse(
      spawnSync(process.execPath, ['--input-type=module', '-e', "const e = await import('./server/extensions.mjs'); console.log(JSON.stringify({ plugins: e.listPlugins().map((p) => p.id), skills: e.listSkills().map((s) => s.id), commands: e.listCommands().map((c) => c.name) }))"], {
        cwd: path.join(HERE, '..'),
        env: { ...process.env, HEARTH_DATA_DIR: data, HEARTH_SEED_DIR: seedDir },
        encoding: 'utf8',
      }).stdout,
    );
  const first = list(seed);
  assert.deepEqual(first.plugins, ['seeded-plugin']);
  assert.deepEqual(first.skills.sort(), ['mine', 'seeded-plugin:greet']);
  assert.deepEqual(first.commands, ['hello']);
  // The user removes a skill; a later start (an updated app, a different package) leaves things as they are.
  fs.rmSync(path.join(data, 'extensions', 'skills', 'mine'), { recursive: true });
  const other = tree({ 'state.json': '{}', 'plugins/another/.claude-plugin/plugin.json': '{"name":"another"}' });
  const later = list(other);
  assert.deepEqual(later.plugins, ['seeded-plugin']);
  assert.deepEqual(later.skills, ['seeded-plugin:greet']);
});
