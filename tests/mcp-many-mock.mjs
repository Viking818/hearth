// A connector (MCP server over stdio) with many tools and long instructions, like Notion's, for the tests of the tool
// lookup. Each call answers with the tool's name and the arguments it got.
import readline from 'node:readline';

const BASE = ['search', 'fetch', 'create-pages', 'update-page', 'move-pages', 'duplicate-page', 'create-database', 'update-database', 'query-data', 'create-comment', 'get-comments', 'get-users'];
const long = (what) => `${what}. `.repeat(1) + 'It works with pages, databases, comments and people in the workspace; give it the details below, and it answers with the result as text. '.repeat(4);
const tools = [...BASE, ...Array.from({ length: 18 }, (_, i) => `extra-${i + 1}`)].map((n) => ({
  name: `notes-${n}`,
  description: long(n === 'create-pages' ? 'Create new pages in the notes, with a title and content in Markdown' : n === 'search' ? 'Search the notes by words' : `Do “${n}” in the notes`),
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'The title of the page. '.repeat(6) },
      content: { type: 'string', description: 'The content, in Markdown: headings, lists, tables and links are kept as they are written. '.repeat(3) },
      parent: { type: 'object', description: 'Where the page goes. '.repeat(5), properties: { page_id: { type: 'string', description: 'The id of the parent page. '.repeat(4) }, database_id: { type: 'string', description: 'The id of the parent database. '.repeat(4) } } },
      tags: { type: 'array', items: { type: 'string' }, description: 'Words to find the page by later. '.repeat(4) },
    },
    required: ['title'],
    additionalProperties: false,
  },
}));

const rl = readline.createInterface({ input: process.stdin });
const send = (o) => process.stdout.write(JSON.stringify(o) + '\n');
rl.on('line', (line) => {
  const m = JSON.parse(line);
  if (m.method === 'initialize') send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'many', version: '1' } } });
  else if (m.method === 'tools/list') send({ jsonrpc: '2.0', id: m.id, result: { tools } });
  else if (m.method === 'tools/call') send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: `${m.params.name}: ${JSON.stringify(m.params.arguments)}` }] } });
  else if (m.id != null) send({ jsonrpc: '2.0', id: m.id, result: {} });
});
