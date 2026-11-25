import assert from 'node:assert/strict'
import test from 'node:test'
import { createInMemoryWritingBridge } from '../src/bridge.ts'
import { renderMarkdownPreviewHtml } from '../src/free-editor.ts'

test('renderMarkdownPreviewHtml escapes HTML and renders headings, lists, and bold text', () => {
  const html = renderMarkdownPreviewHtml('# Title\n- item **bold** and `code` <script>x</script>')
  assert.match(html, /<h1>Title<\/h1>/)
  assert.match(html, /<li>item <strong>bold<\/strong> and <code>code<\/code> &lt;script&gt;x&lt;\/script&gt;<\/li>/)
})

test('createInMemoryWritingBridge reads and writes local workspace documents without Tauri', async () => {
  const bridge = createInMemoryWritingBridge({ 'README.md': '# Hello' })
  assert.equal(await bridge.readTextFile('ws-1', 'README.md'), '# Hello')
  await bridge.writeTextFile('ws-1', 'README.md', '# Updated')
  assert.equal(await bridge.readTextFile('ws-1', 'README.md'), '# Updated')
})
