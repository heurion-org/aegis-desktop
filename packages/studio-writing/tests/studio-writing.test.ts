import assert from 'node:assert/strict'
import test from 'node:test'
import { createInMemoryWritingBridge } from '../src/bridge.ts'
import {
  formatArtifactMarkdownEmbed,
  isMarkdownFile,
  renderMarkdownPreviewHtml,
} from '../src/free-editor.ts'
import { computeWordDiff, extractBlockOutline } from '../src/pro-canvas.ts'

test('renderMarkdownPreviewHtml escapes HTML and renders headings, lists, blockquotes, tables, code fences, and bold text', () => {
  const html = renderMarkdownPreviewHtml(
    '# Title\n> quote **em**\n```ts\nconst x = "<script>"\n```\n| colA | colB |\n| --- | --- |\n| v1 | **v2** |\n- item **bold** and `code` <script>x</script>',
  )
  assert.match(html, /<h1>Title<\/h1>/)
  assert.match(html, /<blockquote>quote <strong>em<\/strong><\/blockquote>/)
  assert.match(html, /<pre><code>const x = "&lt;script&gt;"<\/code><\/pre>/)
  assert.match(html, /<table><thead><tr><th>colA<\/th><th>colB<\/th><\/tr><\/thead><tbody>/)
  assert.match(html, /<td><strong>v2<\/strong><\/td>/)
  assert.match(html, /<li>item <strong>bold<\/strong> and <code>code<\/code> &lt;script&gt;x&lt;\/script&gt;<\/li>/)
  assert.equal(isMarkdownFile('notes/design.md'), true)
  assert.equal(isMarkdownFile('crates/main.rs'), false)

  const embed = formatArtifactMarkdownEmbed({
    id: 'art_1',
    title: 'Sales Table',
    kind: 'table_snapshot',
    version: 2,
    sourcePath: 'raw_data/sales.csv',
    previewMarkdown: '| k | v |\n| --- | --- |\n| rev | 42 |',
  })
  assert.match(embed, /<!-- artifact:art_1 v2 source:raw_data\/sales\.csv -->/)
  assert.match(embed, /### Sales Table/)
})

test('createInMemoryWritingBridge reads and writes local workspace documents without Tauri', async () => {
  const bridge = createInMemoryWritingBridge({ 'README.md': '# Hello' })
  assert.equal(await bridge.readTextFile('ws-1', 'README.md'), '# Hello')
  await bridge.writeTextFile('ws-1', 'README.md', '# Updated')
  assert.equal(await bridge.readTextFile('ws-1', 'README.md'), '# Updated')
})

test('computeWordDiff captures equal, deleted, and inserted segments cleanly', () => {
  const ops = computeWordDiff('Hello old world', 'Hello new world!')
  assert.ok(ops.some(o => o.kind === 'equal' && o.text.includes('Hello')))
  assert.ok(ops.some(o => o.kind === 'delete' && o.text.includes('old')))
  assert.ok(ops.some(o => o.kind === 'insert' && o.text.includes('new')))
})

test('extractBlockOutline parses {#id} annotated blocks and deck JSON slides', () => {
  const mdOutline = extractBlockOutline('## Intro {#sec_1}\nBody paragraph {#p_1}')
  assert.deepEqual(mdOutline, [
    { id: 'sec_1', kind: 'heading', preview: 'Intro' },
    { id: 'p_1', kind: 'paragraph', preview: 'Body paragraph' },
  ])

  const deckOutline = extractBlockOutline(JSON.stringify({ slides: [{ id: 's1', title: 'Cover' }] }))
  assert.deepEqual(deckOutline, [{ id: 's1', kind: 'slide', preview: 'Cover' }])
})
