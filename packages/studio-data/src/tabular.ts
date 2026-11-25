export interface TabularDataset {
  headers: string[]
  rows: string[][]
}

export interface ColumnSummary {
  name: string
  kind: 'number' | 'string' | 'boolean' | 'empty'
  count: number
  missing: number
  unique: number
  min?: number
  max?: number
  mean?: number
  sum?: number
}

const CONFIG_JSON_BASENAMES = new Set([
  'package.json',
  'package-lock.json',
  'tsconfig.json',
  'tsconfig.base.json',
  'tauri.conf.json',
  'manifest.json',
  'sync_policy.json',
  'registry.json',
])

export function isDataFile(filePath: string): boolean {
  const base = (filePath.split('/').pop() ?? filePath).toLowerCase()
  if (base.endsWith('.csv') || base.endsWith('.tsv')) return true
  if (base.endsWith('.json') && !CONFIG_JSON_BASENAMES.has(base)) return true
  return false
}

function escapeXml(raw: string): string {
  return raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * RFC-4180 CSV/TSV parser supporting quoted fields, embedded commas/newlines, and `""` escapes.
 */
export function parseCsv(text: string, delimiter?: string): TabularDataset {
  const sep = delimiter ?? ','
  const records: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  let i = 0

  while (i < text.length) {
    const ch = text[i]!
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i += 2
          continue
        }
        inQuotes = false
        i += 1
        continue
      }
      field += ch
      i += 1
      continue
    }

    if (ch === '"') {
      inQuotes = true
      i += 1
    } else if (ch === sep) {
      row.push(field)
      field = ''
      i += 1
    } else if (ch === '\r') {
      row.push(field)
      field = ''
      records.push(row)
      row = []
      i += text[i + 1] === '\n' ? 2 : 1
    } else if (ch === '\n') {
      row.push(field)
      field = ''
      records.push(row)
      row = []
      i += 1
    } else {
      field += ch
      i += 1
    }
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field)
    records.push(row)
  }

  const nonEmpty = records.filter(r => r.some(cell => cell.trim() !== ''))
  if (nonEmpty.length === 0) {
    return { headers: [], rows: [] }
  }
  const headers = nonEmpty[0]!.map((h, idx) => h.trim() || `col_${idx + 1}`)
  const width = headers.length
  const rows = nonEmpty.slice(1).map(r => {
    const padded = r.slice(0, width)
    while (padded.length < width) padded.push('')
    return padded
  })
  return { headers, rows }
}

/**
 * Parse a JSON array of flat objects (or `{ data | rows | items: [...] }`) into a TabularDataset.
 */
export function parseJsonTable(text: string): TabularDataset {
  const trimmed = text.trim()
  if (!trimmed) return { headers: [], rows: [] }
  const parsed = JSON.parse(trimmed) as unknown
  const arr = Array.isArray(parsed)
    ? parsed
    : typeof parsed === 'object' && parsed !== null
      ? ((parsed as Record<string, unknown>).data ??
          (parsed as Record<string, unknown>).rows ??
          (parsed as Record<string, unknown>).items)
      : null

  if (!Array.isArray(arr) || arr.length === 0) {
    return { headers: [], rows: [] }
  }

  const headerSet = new Set<string>()
  for (const item of arr) {
    if (typeof item === 'object' && item !== null && !Array.isArray(item)) {
      for (const k of Object.keys(item)) headerSet.add(k)
    }
  }
  const headers = [...headerSet]
  if (headers.length === 0) {
    return {
      headers: ['value'],
      rows: arr.map(v => [typeof v === 'object' ? JSON.stringify(v) : String(v ?? '')]),
    }
  }
  const rows = arr.map(item => {
    const obj = (typeof item === 'object' && item !== null ? item : {}) as Record<string, unknown>
    return headers.map(h => {
      const val = obj[h]
      if (val === undefined || val === null) return ''
      return typeof val === 'object' ? JSON.stringify(val) : String(val)
    })
  })
  return { headers, rows }
}

export function parseTabularFile(filePath: string, text: string): TabularDataset {
  const lower = filePath.toLowerCase()
  if (lower.endsWith('.tsv')) return parseCsv(text, '\t')
  if (lower.endsWith('.json')) return parseJsonTable(text)
  return parseCsv(text, ',')
}

export function computeColumnStats(dataset: TabularDataset): ColumnSummary[] {
  return dataset.headers.map((name, colIdx) => {
    const values = dataset.rows.map(r => (r[colIdx] ?? '').trim())
    const nonEmpty = values.filter(v => v !== '')
    const missing = values.length - nonEmpty.length
    const unique = new Set(nonEmpty).size
    if (nonEmpty.length === 0) {
      return { name, kind: 'empty', count: 0, missing, unique: 0 }
    }

    const nums = nonEmpty.map(v => Number(v.replace(/,/g, '')))
    if (nums.every(n => Number.isFinite(n))) {
      let min = Infinity
      let max = -Infinity
      let sum = 0
      for (const n of nums) {
        if (n < min) min = n
        if (n > max) max = n
        sum += n
      }
      return {
        name,
        kind: 'number',
        count: nonEmpty.length,
        missing,
        unique,
        min,
        max,
        sum,
        mean: sum / nums.length,
      }
    }

    if (nonEmpty.every(v => v === 'true' || v === 'false')) {
      return { name, kind: 'boolean', count: nonEmpty.length, missing, unique }
    }
    return { name, kind: 'string', count: nonEmpty.length, missing, unique }
  })
}

export function tableToMarkdown(dataset: TabularDataset, maxRows = 12): string {
  if (dataset.headers.length === 0) return '_Empty dataset_'
  const escCell = (s: string) => s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
  const head = `| ${dataset.headers.map(escCell).join(' | ')} |`
  const sep = `| ${dataset.headers.map(() => '---').join(' | ')} |`
  const slice = dataset.rows.slice(0, maxRows)
  const body = slice.map(r => `| ${r.map(escCell).join(' | ')} |`)
  const out = [head, sep, ...body]
  if (dataset.rows.length > maxRows) {
    out.push('', `_Showing first ${maxRows} of ${dataset.rows.length} rows._`)
  }
  return out.join('\n')
}

export function generateBarChartSvg(title: string, labels: string[], values: number[]): string {
  const count = Math.min(12, labels.length, values.length)
  if (count === 0) {
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 560 120"><rect width="560" height="120" fill="#FDFCF9" stroke="#DFDAD0" rx="2"/><text x="280" y="64" fill="#646D68" font-size="13" font-family="Inter, sans-serif" text-anchor="middle">${escapeXml(title || 'No numeric data')}</text></svg>`
  }

  const width = 560
  const height = 220
  const padLeft = 44
  const padRight = 16
  const padTop = 34
  const padBottom = 42
  const plotW = width - padLeft - padRight
  const plotH = height - padTop - padBottom
  const maxVal = Math.max(1, ...values.slice(0, count).map(v => Math.max(0, Number.isFinite(v) ? v : 0)))
  const barStep = plotW / count
  const barW = Math.max(10, barStep * 0.62)

  const bars: string[] = []
  for (let i = 0; i < count; i++) {
    const rawVal = values[i] ?? 0
    const val = Number.isFinite(rawVal) ? Math.max(0, rawVal) : 0
    const h = Math.round((val / maxVal) * plotH)
    const x = Math.round(padLeft + i * barStep + (barStep - barW) / 2)
    const y = Math.round(padTop + (plotH - h))
    const shortLabel = (labels[i] ?? `#${i + 1}`).slice(0, 10)
    const barFill = i === 0 ? '#00C472' : '#233E33'
    bars.push(
      `<rect x="${x}" y="${y}" width="${Math.round(barW)}" height="${h}" rx="2" fill="${barFill}"/>` +
        `<text x="${Math.round(x + barW / 2)}" y="${height - 16}" fill="#646D68" font-size="10" font-family="JetBrains Mono, monospace" text-anchor="middle">${escapeXml(shortLabel)}</text>` +
        `<text x="${Math.round(x + barW / 2)}" y="${Math.max(padTop + 10, y - 4)}" fill="#151C19" font-size="10" font-family="JetBrains Mono, monospace" text-anchor="middle">${escapeXml(Number.isInteger(val) ? String(val) : val.toFixed(1))}</text>`,
    )
  }

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}">` +
    `<rect width="${width}" height="${height}" fill="#FDFCF9" stroke="#DFDAD0" rx="2"/>` +
    `<text x="${padLeft}" y="20" fill="#151C19" font-size="13" font-family="Inter, sans-serif" font-weight="600">${escapeXml(title)}</text>` +
    `<line x1="${padLeft}" y1="${padTop + plotH}" x2="${width - padRight}" y2="${padTop + plotH}" stroke="#C8C2B6"/>` +
    bars.join('') +
    `</svg>`
  )
}
