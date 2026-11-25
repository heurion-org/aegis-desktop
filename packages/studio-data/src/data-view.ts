import type { DataArtifact } from './index.ts'
import type { LocalDataArtifactProducer } from './producer.ts'
import {
  computeColumnStats,
  generateBarChartSvg,
  parseTabularFile,
  tableToMarkdown,
} from './tabular.ts'

export interface MountDataStudioOptions {
  container: HTMLElement
  workspaceId: string
  filePath: string
  readTextFile: (workspaceId: string, relPath: string) => Promise<string>
  producer: LocalDataArtifactProducer
  onArtifactPublished?: (artifact: DataArtifact) => void
  onOpenRawText?: () => void
}

const SVG_ICON_PLUS =
  '<svg class="aos-icon" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 4.25v11.5M4.25 10h11.5"/></svg>'
const SVG_ICON_CHART =
  '<svg class="aos-icon" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.25 3.75v12.5h13.5M6.75 13.5V9.25M10.25 13.5V5.5M13.75 13.5V10"/></svg>'
const SVG_ICON_CODE =
  '<svg class="aos-icon" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 2.75h6.75L15.25 6.25v11H5z"/><path d="M11.75 2.75v3.5h3.5"/><path d="M8.5 10.5L7 12l1.5 1.5M11.5 10.5L13 12l-1.5 1.5"/></svg>'

export async function mountDataStudio(opts: MountDataStudioOptions): Promise<void> {
  const { container, workspaceId, filePath, readTextFile, producer, onArtifactPublished, onOpenRawText } =
    opts
  container.innerHTML = ''

  let rawText = ''
  try {
    rawText = await readTextFile(workspaceId, filePath)
  } catch (err) {
    const box = document.createElement('div')
    box.className = 'sd-studio'
    box.textContent = err instanceof Error ? err.message : String(err)
    container.appendChild(box)
    return
  }

  let dataset
  try {
    dataset = parseTabularFile(filePath, rawText)
  } catch (err) {
    const box = document.createElement('div')
    box.className = 'sd-studio'
    const p = document.createElement('p')
    p.textContent = `Could not parse ${filePath} as structured table: ${err instanceof Error ? err.message : String(err)}`
    box.appendChild(p)
    if (onOpenRawText) {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'aos-btn aos-btn-sm'
      btn.textContent = 'Open Raw Text Editor'
      btn.onclick = () => onOpenRawText()
      box.appendChild(btn)
    }
    container.appendChild(box)
    return
  }

  const stats = computeColumnStats(dataset)
  const numericCols = stats.filter(s => s.kind === 'number')
  let sortColIdx: number | null = null
  let sortAsc = true
  let rowFilter = ''
  let chartLabelCol = 0
  let chartValCol = dataset.headers.findIndex(h => numericCols.some(n => n.name === h))
  if (chartValCol < 0) chartValCol = 0

  const root = document.createElement('div')
  root.className = 'sd-studio'

  const toolbar = document.createElement('div')
  toolbar.className = 'sw-toolbar'
  const titleWrap = document.createElement('div')
  titleWrap.className = 'sw-toolbar-actions'
  const titleEl = document.createElement('strong')
  titleEl.textContent = filePath
  const studioBadge = document.createElement('span')
  studioBadge.className = 'aos-badge muted'
  studioBadge.innerHTML = `${SVG_ICON_CHART}<span>Data Studio</span>`
  const dimBadge = document.createElement('span')
  dimBadge.className = 'aos-badge info'
  dimBadge.textContent = `${dataset.rows.length} rows × ${dataset.headers.length} cols`
  titleWrap.append(titleEl, studioBadge, dimBadge)

  const actions = document.createElement('div')
  actions.className = 'sw-toolbar-actions'

  const statusNote = document.createElement('small')
  statusNote.className = 'aos-muted'

  const pubTableBtn = document.createElement('button')
  pubTableBtn.type = 'button'
  pubTableBtn.className = 'aos-btn aos-btn-sm aos-btn-primary'
  pubTableBtn.innerHTML = `${SVG_ICON_PLUS}<span>Publish Table</span>`
  pubTableBtn.disabled = dataset.headers.length === 0

  const pubKpiBtn = document.createElement('button')
  pubKpiBtn.type = 'button'
  pubKpiBtn.className = 'aos-btn aos-btn-sm'
  pubKpiBtn.innerHTML = `${SVG_ICON_PLUS}<span>Publish KPI</span>`
  pubKpiBtn.disabled = dataset.headers.length === 0

  const pubChartBtn = document.createElement('button')
  pubChartBtn.type = 'button'
  pubChartBtn.className = 'aos-btn aos-btn-sm'
  pubChartBtn.innerHTML = `${SVG_ICON_CHART}<span>Publish Chart</span>`
  pubChartBtn.disabled = numericCols.length === 0

  actions.append(pubTableBtn, pubKpiBtn, pubChartBtn)
  if (onOpenRawText) {
    const rawBtn = document.createElement('button')
    rawBtn.type = 'button'
    rawBtn.className = 'aos-btn aos-btn-sm'
    rawBtn.innerHTML = `${SVG_ICON_CODE}<span>Raw Text</span>`
    rawBtn.onclick = () => onOpenRawText()
    actions.appendChild(rawBtn)
  }
  toolbar.append(titleWrap, actions)

  // Column stats strip
  const statsGrid = document.createElement('div')
  statsGrid.className = 'sd-stats-grid'
  for (const col of stats.slice(0, 8)) {
    const card = document.createElement('div')
    card.className = 'sd-stat-card'
    const head = document.createElement('div')
    head.className = 'aos-approval-top'
    const nameEl = document.createElement('strong')
    nameEl.textContent = col.name
    const kindBadge = document.createElement('span')
    kindBadge.className = 'aos-badge muted'
    kindBadge.textContent = col.kind
    head.append(nameEl, kindBadge)

    const detail = document.createElement('small')
    detail.className = 'aos-muted'
    if (col.kind === 'number' && col.mean !== undefined && col.min !== undefined && col.max !== undefined) {
      detail.textContent = `mean ${col.mean.toFixed(2)} · [${col.min}, ${col.max}]`
    } else {
      detail.textContent = `${col.unique} unique · ${col.missing} missing`
    }
    card.append(head, detail)
    statsGrid.appendChild(card)
  }

  // Interactive chart builder
  const chartBox = document.createElement('div')
  chartBox.className = 'sd-chart-box'
  const renderChart = () => {
    chartBox.innerHTML = ''
    if (numericCols.length === 0 || dataset.rows.length === 0) return

    const controls = document.createElement('div')
    controls.className = 'sw-toolbar-actions'
    const lblSelect = document.createElement('select')
    lblSelect.className = 'aos-select'
    const valSelect = document.createElement('select')
    valSelect.className = 'aos-select'

    dataset.headers.forEach((h, idx) => {
      const o1 = document.createElement('option')
      o1.value = String(idx)
      o1.textContent = `Label: ${h}`
      o1.selected = idx === chartLabelCol
      lblSelect.appendChild(o1)

      if (stats[idx]?.kind === 'number') {
        const o2 = document.createElement('option')
        o2.value = String(idx)
        o2.textContent = `Value: ${h}`
        o2.selected = idx === chartValCol
        valSelect.appendChild(o2)
      }
    })
    lblSelect.onchange = () => {
      chartLabelCol = Number(lblSelect.value)
      renderChart()
    }
    valSelect.onchange = () => {
      chartValCol = Number(valSelect.value)
      renderChart()
    }
    controls.append(lblSelect, valSelect)

    const labels = dataset.rows.slice(0, 12).map(r => r[chartLabelCol] ?? '')
    const values = dataset.rows
      .slice(0, 12)
      .map(r => Number((r[chartValCol] ?? '0').replace(/,/g, '')))
    const svgWrap = document.createElement('div')
    svgWrap.innerHTML = generateBarChartSvg(
      `${dataset.headers[chartValCol] ?? 'Value'} by ${dataset.headers[chartLabelCol] ?? 'Item'}`,
      labels,
      values,
    )
    chartBox.append(controls, svgWrap)
  }

  // Filter + table
  const filterInput = document.createElement('input')
  filterInput.type = 'search'
  filterInput.className = 'aos-tree-search'
  filterInput.placeholder = 'Filter rows…'

  const tableWrap = document.createElement('div')
  tableWrap.className = 'sd-table-wrap'

  const renderTable = () => {
    tableWrap.innerHTML = ''
    const q = rowFilter.trim().toLowerCase()
    let rows = q
      ? dataset.rows.filter(r => r.some(cell => cell.toLowerCase().includes(q)))
      : [...dataset.rows]

    if (sortColIdx !== null) {
      const idx = sortColIdx
      const isNum = stats[idx]?.kind === 'number'
      rows.sort((a, b) => {
        const av = a[idx] ?? ''
        const bv = b[idx] ?? ''
        const cmp = isNum
          ? Number(av.replace(/,/g, '')) - Number(bv.replace(/,/g, ''))
          : av.localeCompare(bv)
        return sortAsc ? cmp : -cmp
      })
    }

    const table = document.createElement('table')
    table.className = 'sd-table'
    const thead = document.createElement('thead')
    const trHead = document.createElement('tr')
    dataset.headers.forEach((h, idx) => {
      const th = document.createElement('th')
      const arrow = sortColIdx === idx ? (sortAsc ? ' ↑' : ' ↓') : ''
      th.textContent = `${h}${arrow}`
      th.onclick = () => {
        if (sortColIdx === idx) {
          sortAsc = !sortAsc
        } else {
          sortColIdx = idx
          sortAsc = true
        }
        renderTable()
      }
      trHead.appendChild(th)
    })
    thead.appendChild(trHead)

    const tbody = document.createElement('tbody')
    for (const r of rows.slice(0, 200)) {
      const tr = document.createElement('tr')
      for (const cell of r) {
        const td = document.createElement('td')
        td.textContent = cell
        tr.appendChild(td)
      }
      tbody.appendChild(tr)
    }
    table.append(thead, tbody)
    tableWrap.appendChild(table)
  }

  filterInput.oninput = () => {
    rowFilter = filterInput.value
    renderTable()
  }

  // Published artifacts list
  const artListWrap = document.createElement('div')
  const renderArtifactsList = async () => {
    artListWrap.innerHTML = ''
    const list = await producer.listArtifacts(workspaceId)
    const head = document.createElement('div')
    head.className = 'aos-panel-header'
    head.innerHTML = `<span>Published Data Artifacts</span><small>${list.length}</small>`
    artListWrap.appendChild(head)
    if (list.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'aos-muted'
      empty.textContent = 'Publish a table, KPI summary, or chart SVG to embed in Writing Studio.'
      artListWrap.appendChild(empty)
      return
    }
    const ul = document.createElement('ul')
    ul.className = 'aos-tree-list'
    for (const art of list) {
      const li = document.createElement('li')
      li.className = 'sd-artifact-row'
      const lbl = document.createElement('span')
      lbl.textContent = `${art.title} (v${art.version} · ${art.kind} · ${art.sourcePath})`
      const delBtn = document.createElement('button')
      delBtn.type = 'button'
      delBtn.className = 'aos-btn aos-btn-sm'
      delBtn.textContent = 'Remove'
      delBtn.onclick = async () => {
        await producer.deleteArtifact(workspaceId, art.id)
        await renderArtifactsList()
      }
      li.append(lbl, delBtn)
      ul.appendChild(li)
    }
    artListWrap.appendChild(ul)
  }

  const baseName = filePath.split('/').pop() ?? filePath
  pubTableBtn.onclick = async () => {
    const art = await producer.publishArtifact(workspaceId, {
      title: `${baseName} Table Snapshot`,
      kind: 'table_snapshot',
      sourcePath: filePath,
      previewMarkdown: tableToMarkdown(dataset, 12),
    })
    statusNote.textContent = `Published ${art.title} v${art.version} for Writing Studio.`
    onArtifactPublished?.(art)
    await renderArtifactsList()
  }

  pubKpiBtn.onclick = async () => {
    const lines = stats.map(col =>
      col.kind === 'number'
        ? `- **${col.name}**: sum=${col.sum?.toFixed(2)}, mean=${col.mean?.toFixed(2)}, range=[${col.min}, ${col.max}]`
        : `- **${col.name}**: ${col.count} values, ${col.unique} unique (${col.missing} missing)`,
    )
    const art = await producer.publishArtifact(workspaceId, {
      title: `${baseName} KPI Summary`,
      kind: 'kpi_metric',
      sourcePath: filePath,
      previewMarkdown: lines.join('\n'),
    })
    statusNote.textContent = `Published ${art.title} v${art.version} for Writing Studio.`
    onArtifactPublished?.(art)
    await renderArtifactsList()
  }

  pubChartBtn.onclick = async () => {
    const labels = dataset.rows.slice(0, 12).map(r => r[chartLabelCol] ?? '')
    const values = dataset.rows
      .slice(0, 12)
      .map(r => Number((r[chartValCol] ?? '0').replace(/,/g, '')))
    const chartTitle = `${dataset.headers[chartValCol] ?? 'Value'} by ${dataset.headers[chartLabelCol] ?? 'Item'}`
    const svg = generateBarChartSvg(chartTitle, labels, values)
    const art = await producer.publishArtifact(workspaceId, {
      title: `${baseName}: ${chartTitle}`,
      kind: 'chart_svg',
      sourcePath: filePath,
      previewMarkdown: tableToMarkdown(
        {
          headers: [dataset.headers[chartLabelCol] ?? 'Label', dataset.headers[chartValCol] ?? 'Value'],
          rows: dataset.rows.slice(0, 8).map(r => [r[chartLabelCol] ?? '', r[chartValCol] ?? '']),
        },
        8,
      ),
      svgMarkup: svg,
    })
    statusNote.textContent = `Published ${art.title} v${art.version} for Writing Studio.`
    onArtifactPublished?.(art)
    await renderArtifactsList()
  }

  renderChart()
  renderTable()
  await renderArtifactsList()

  root.append(toolbar, statusNote, statsGrid)
  if (numericCols.length > 0 && dataset.rows.length > 0) {
    root.appendChild(chartBox)
  }
  root.append(filterInput, tableWrap, artListWrap)
  container.appendChild(root)
}
