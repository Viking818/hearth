// Tests for Artifacts and Design: keeping what the model made with its versions, finding it by its words, showing it
// sandboxed, the brand kit, and the design brief the model gets. Run with: npm test. No model or network needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.HEARTH_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-test-'));
const { updateSettings, DIRS } = await import('../server/settings.mjs');
const art = await import('../server/artifacts.mjs');
const { designSystem, htmlFrom } = await import('../public/js/design-prompt.js');
updateSettings({ language: 'en' });

const page = (title, body) => `<!doctype html><html><head><title>${title}</title></head><body><h1>${body}</h1><script>console.log(1)</script></body></html>`;

test('a chat answer is kept once, with a new version when it changes; earlier versions come back', () => {
  const a = art.saveArtifact({ code: page('Price calculator', 'DTF prices'), chatId: 'chat1234', messageId: 'msg12345', block: 0, fallbackTitle: 'My chat' });
  assert.equal(a.title, 'Price calculator'); // its own <title> wins over the chat's
  assert.equal(a.kind, 'html');
  assert.deepEqual(a.versions, [1]);
  const same = art.saveArtifact({ code: page('Price calculator', 'DTF prices'), chatId: 'chat1234', messageId: 'msg12345', block: 0 });
  assert.equal(same.id, a.id);
  assert.deepEqual(same.versions, [1]); // nothing changed: no new version
  const changed = art.saveArtifact({ code: page('Price calculator', 'DTF and hoodie prices'), chatId: 'chat1234', messageId: 'msg12345', block: 0 });
  assert.deepEqual(changed.versions, [1, 2]);
  assert.equal(art.getArtifact(a.id, 1).code.includes('DTF prices'), true);
  const back = art.updateArtifact(a.id, { restore: 1 });
  assert.deepEqual(back.versions, [1, 2, 3]);
  assert.match(back.code, /<h1>DTF prices<\/h1>/);
  // Another answer of the same chat is another artifact; a page without a title takes the chat's.
  const other = art.saveArtifact({ code: '<div>hello there, this is a page without a title of its own</div>', chatId: 'chat1234', messageId: 'msg99999', fallbackTitle: 'Winter ideas' });
  assert.notEqual(other.id, a.id);
  assert.equal(other.title, 'Winter ideas');
  const svg = art.saveArtifact({ code: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle r="4" cx="5" cy="5"/></svg>', chatId: 'chat5678', messageId: 'msg55555' });
  assert.equal(svg.kind, 'svg');
});

test('search finds artifacts by their title or by the words on the page, never by their code', () => {
  art.saveArtifact({ code: page('Hoodie order form', 'Order your hoodies here') });
  const titles = (q, kind) => art.listArtifacts({ q, kind }).map((x) => x.title);
  assert.ok(titles('hoodie').includes('Hoodie order form'));
  assert.ok(titles('order your').includes('Hoodie order form'));
  assert.deepEqual(titles('console'), []); // inside a script: not a word of the page
  assert.deepEqual(titles('', 'svg').length, 1);
  assert.ok(titles('').length >= 4);
});

test('artifacts are shown sandboxed, and a design carries its pictures inside it', () => {
  assert.match(art.SANDBOX_HEADERS['content-security-policy'], /^sandbox /);
  assert.doesNotMatch(art.SANDBOX_HEADERS['content-security-policy'], /allow-same-origin/);
  const pic = path.join(DIRS.uploads, 'test-pic.png');
  fs.writeFileSync(pic, Buffer.from('89504e470d0a1a0a', 'hex'));
  const d = art.saveArtifact({ kind: 'design', code: '<!doctype html><html><body><div id="design"><img src="{{image:1}}"><img src="{{image:2}}"></div></body></html>', format: { id: 'ig-post', name: 'Instagram post', w: 1080, h: 1080, scale: 1 }, images: ['/uploads/test-pic.png', 'https://evil.example/x.png'], prompt: 'Winter sale post' });
  assert.deepEqual(d.images, ['/uploads/test-pic.png']); // only Hearth's own pictures
  assert.equal(d.prompts[0].text, 'Winter sale post');
  // The picture goes inside the page (a sandboxed page may not load anything from Hearth's own address).
  assert.match(art.artifactDoc(d), /<img src="data:image\/png;base64,iVBORw0KGgo="><img src="">/);
  const svg = art.listArtifacts({ kind: 'svg' })[0];
  assert.match(art.artifactDoc(art.getArtifact(svg.id)), /^<!doctype html>[\s\S]*<svg/);
  assert.ok(art.deleteArtifact(d.id));
  assert.equal(art.getArtifact(d.id), null);
});

test('the brand kit keeps only good colours and Hearth’s own pictures', () => {
  const b = art.saveBrand({ name: '  Print Lab ', colors: ['#FF6A2B', 'red', '#123', '#0a0a0a'], logo: 'https://x.io/logo.png', headingFont: 'Montserrat' });
  assert.equal(b.name, 'Print Lab');
  assert.deepEqual(b.colors, ['#FF6A2B', '#0a0a0a']);
  assert.equal(b.logo, '');
  assert.equal(art.saveBrand({ logo: '/uploads/logo.png' }).logo, '/uploads/logo.png');
  assert.equal(art.getBrand().logo, '/uploads/logo.png');
});

test('the design brief: exact size, transparent prints, pictures and the brand logo as placeholders', () => {
  const tshirt = designSystem({ fmt: { name: 'T-shirt print', w: 1500, h: 1800, transparent: true }, images: ['/uploads/a.png', '/uploads/logo.png'], logoIndex: 2, brand: { name: 'Print Lab', colors: ['#ff6a2b'], headingFont: 'Oswald' } });
  assert.match(tshirt, /exactly 1500×1800 CSS pixels/);
  assert.match(tshirt, /background:transparent/);
  assert.match(tshirt, /keep the background transparent/);
  assert.match(tshirt, /\{\{image:1\}\}, \{\{image:2\}\} \(the logo\)/);
  assert.match(tshirt, /name “Print Lab”; colours #ff6a2b/);
  assert.doesNotMatch(designSystem({ fmt: { name: 'Post', w: 1080, h: 1080 } }), /transparent|\{\{image/);
  // The file is taken from the answer's html block, or from the answer itself.
  const file = '<!doctype html><html><body><div id="design">Sale</div></body></html>';
  assert.equal(htmlFrom(`Here it is:\n\`\`\`html\n${file}\n\`\`\`\nA bright post.`), file);
  assert.equal(htmlFrom(`Sure! ${file} Hope you like it.`), file);
  assert.equal(htmlFrom('I can’t do that.'), '');
});
