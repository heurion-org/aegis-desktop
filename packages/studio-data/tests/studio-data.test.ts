import assert from 'node:assert/strict'
import test from 'node:test'
import { createLocalDataArtifactProducer } from '../src/producer.ts'
import {
  computeColumnStats,
  generateBarChartSvg,
  isDataFile,
  parseCsv,
  parseJsonTable,
  tableToMarkdown,
} from '../src/tabular.ts'

test('isDataFile distinguishes CSV/TSV/data JSON from config JSON files', () => {
  assert.equal(isDataFile('raw_data/patients.csv'), true)
  assert.equal(isDataFile('metrics/cohort.tsv'), true)
  assert.equal(isDataFile('analytics/summary.json'), true)

  assert.equal(isDataFile('package.json'), false)
  assert.equal(isDataFile('apps/desktop/tsconfig.json'), false)
  assert.equal(isDataFile('apps/desktop/src-tauri/tauri.conf.json'), false)
  assert.equal(isDataFile('README.md'), false)
})

test('parseCsv handles quoted commas, escaped quotes, and CRLF newlines', () => {
  const ds = parseCsv('name,revenue,active\r\n"Acme, Inc.",120.5,true\r\n"Bob ""Builder""",80,false\r\n')
  assert.deepEqual(ds.headers, ['name', 'revenue', 'active'])
  assert.equal(ds.rows.length, 2)
  assert.equal(ds.rows[0]?.[0], 'Acme, Inc.')
  assert.equal(ds.rows[1]?.[0], 'Bob "Builder"')
})

test('parseJsonTable parses wrapped records and computeColumnStats computes numeric summaries', () => {
  const ds = parseJsonTable(
    JSON.stringify({
      rows: [
        { arm: 'Control', score: 10 },
        { arm: 'Treatment', score: 20 },
        { arm: 'Treatment', score: '' },
      ],
    }),
  )
  assert.deepEqual(ds.headers, ['arm', 'score'])
  const stats = computeColumnStats(ds)
  assert.equal(stats[0]?.kind, 'string')
  assert.equal(stats[0]?.unique, 2)
  assert.equal(stats[1]?.kind, 'number')
  assert.equal(stats[1]?.min, 10)
  assert.equal(stats[1]?.max, 20)
  assert.equal(stats[1]?.mean, 15)
  assert.equal(stats[1]?.missing, 1)

  const md = tableToMarkdown(ds, 2)
  assert.match(md, /\| arm \| score \|/)
  assert.match(md, /Showing first 2 of 3 rows/)
})

test('generateBarChartSvg escapes XSS characters in titles and labels', () => {
  const svg = generateBarChartSvg('Sales <script>alert(1)</script>', ['A & B', 'C'], [12, 24])
  assert.doesNotMatch(svg, /<script>/)
  assert.match(svg, /&lt;script&gt;/)
  assert.match(svg, /A &amp; B/)
})

test('LocalDataArtifactProducer publishes, increments version, and deletes workspace artifacts', async () => {
  const producer = createLocalDataArtifactProducer()
  const a1 = await producer.publishArtifact('ws-1', {
    title: 'Q4 Summary',
    kind: 'table_snapshot',
    sourcePath: 'raw_data/q4.csv',
    previewMarkdown: '| k | v |\n| --- | --- |\n| rev | 100 |',
  })
  assert.equal(a1.version, 1)

  const a2 = await producer.publishArtifact('ws-1', {
    title: 'Q4 Summary',
    kind: 'table_snapshot',
    sourcePath: 'raw_data/q4.csv',
    previewMarkdown: '| k | v |\n| --- | --- |\n| rev | 120 |',
  })
  assert.equal(a2.id, a1.id)
  assert.equal(a2.version, 2)

  const list = await producer.listArtifacts('ws-1')
  assert.equal(list.length, 1)
  assert.equal(await producer.deleteArtifact('ws-1', a1.id), true)
  assert.equal((await producer.listArtifacts('ws-1')).length, 0)
})
