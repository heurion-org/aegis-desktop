import { iconHtml, normalizeExt, resolveFormatAccess, type DesktopEntitlements } from '@aegis/core-shell'
import type { ArtifactEmbedRef, WritingHostBridge } from './bridge.ts'

export interface ProCanvasOptions {
  container: HTMLElement
  bridge: WritingHostBridge
  workspaceId: string
  filePath: string
  entitlements: DesktopEntitlements
  onRequestUpgrade: (reason: string) => void
}

export interface WordDiffOp {
  kind: 'equal' | 'delete' | 'insert'
  text: string
}

export interface BlockOutlineItem {
  id: string
  kind: 'heading' | 'paragraph' | 'slide' | 'section'
  preview: string
}

type ProSurfaceTab = 'rendered' | 'dual' | 'diff'

function tokenizeDiff(text: string): string[] {
  return text.match(/\s+|\S+/g) ?? []
}

/**
 * Word-level LCS diff used by Cloud Pro Rendered Revision Diff without pulling heavy node deps.
 */
export function computeWordDiff(before: string, after: string): WordDiffOp[] {
  const a = tokenizeDiff(before)
  const b = tokenizeDiff(after)
  const n = a.length
  const m = b.length
  if (n * m > 40_000) {
    const out: WordDiffOp[] = []
    if (before) out.push({ kind: 'delete', text: before })
    if (after) out.push({ kind: 'insert', text: after })
    return out
  }

  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      if (a[i] === b[j]) {
        dp[i]![j] = 1 + (dp[i + 1]?.[j + 1] ?? 0)
      } else {
        dp[i]![j] = Math.max(dp[i + 1]?.[j] ?? 0, dp[i]?.[j + 1] ?? 0)
      }
    }
  }

  const raw: WordDiffOp[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      raw.push({ kind: 'equal', text: a[i]! })
      i++
      j++
    } else if ((dp[i + 1]?.[j] ?? 0) >= (dp[i]?.[j + 1] ?? 0)) {
      raw.push({ kind: 'delete', text: a[i]! })
      i++
    } else {
      raw.push({ kind: 'insert', text: b[j]! })
      j++
    }
  }
  while (i < n) raw.push({ kind: 'delete', text: a[i++]! })
  while (j < m) raw.push({ kind: 'insert', text: b[j++]! })

  const merged: WordDiffOp[] = []
  for (const op of raw) {
    const prev = merged[merged.length - 1]
    if (prev && prev.kind === op.kind) {
      prev.text += op.text
    } else {
      merged.push({ ...op })
    }
  }
  return merged
}

/**
 * Extract addressable `{#id}` blocks or slide outline items for Dual-Surface CRDT preview.
 */
export function extractBlockOutline(content: string): BlockOutlineItem[] {
  const trimmed = content.trim()
  if (!trimmed) return []

  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed) as { slides?: Array<{ title?: string; id?: string }> }
      if (Array.isArray(parsed.slides)) {
        return parsed.slides.map((s, idx) => ({
          id: s.id ?? `slide-${idx + 1}`,
          kind: 'slide',
          preview: s.title?.trim() || `Slide ${idx + 1}`,
        }))
      }
    } catch {
      // Fall through to line-based outline parsing
    }
  }

  const items: BlockOutlineItem[] = []
  let idx = 0
  for (const raw of trimmed.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    idx += 1
    const idMatch = line.match(/\{#([A-Za-z0-9_.:-]+)\}\s*$/)
    const blockId = idMatch?.[1] ?? `blk-${idx}`
    const cleaned = line.replace(/\s*\{#[A-Za-z0-9_.:-]+\}\s*$/, '')
    const kind: BlockOutlineItem['kind'] = cleaned.startsWith('#')
      ? 'heading'
      : /^slide\s+\d+/i.test(cleaned)
        ? 'slide'
        : 'paragraph'
    items.push({
      id: blockId,
      kind,
      preview: cleaned.replace(/^#+\s*/, '').slice(0, 140),
    })
  }
  return items
}

function formatProArtifactBlock(art: ArtifactEmbedRef): string {
  const body = art.previewMarkdown?.trim() || ''
  return `\n### ${art.title} {#art_${art.id}}\n${body}\n`
}

/**
 * Cloud Pro Dual-Surface CRDT view for `.docx` / `.pptx` / `.pdf` / `.tex`.
 * Free tier shows an explicit upgrade card + read-only preview outline (zero Cloud Yjs sync / edits).
 */
export async function mountProDualSurfaceCanvas(opts: ProCanvasOptions): Promise<void> {
  const { container, bridge, workspaceId, filePath, entitlements, onRequestUpgrade } = opts
  container.innerHTML = ''

  const ext = normalizeExt(filePath)
  const access = resolveFormatAccess(filePath, entitlements)
  const rawContent = await bridge.readTextFile(workspaceId, filePath).catch(() => '')

  if (!access.allowed) {
    const gate = document.createElement('div')
    gate.className = 'sw-pro-gate'
    gate.innerHTML = `
      <h3>Dual-Surface CRDT Locked (Cloud Pro)</h3>
      <p>${access.reason ?? 'Upgrade to Aegis Cloud Pro to unlock rich document & presentation editing.'}</p>
      <ul>
        <li>Semantic Dual-Surface CRDT editing for <code>.docx</code>, <code>.pptx</code>, <code>.pdf</code>, <code>.tex</code></li>
        <li>Lossless OOXML / TeX source-map round-tripping &amp; turn-level <code>revertTurn</code></li>
        <li>Selective Cloud Yjs relay across collaborators and AI Co-Writers</li>
      </ul>
    `
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'aos-btn aos-btn-primary'
    btn.textContent = 'Upgrade to Aegis Cloud Pro'
    btn.onclick = () => onRequestUpgrade(access.reason ?? 'Unlock Dual-Surface CRDT')
    gate.appendChild(btn)

    const outline = extractBlockOutline(rawContent)
    if (outline.length > 0) {
      const roHead = document.createElement('div')
      roHead.className = 'aos-panel-header'
      roHead.style.marginTop = '12px'
      roHead.innerHTML = `<span>Read-Only Outline Preview (.${ext})</span><small>${outline.length} blocks</small>`
      const list = document.createElement('ul')
      list.className = 'sw-outline-list'
      for (const item of outline.slice(0, 12)) {
        const li = document.createElement('li')
        li.textContent = `[#${item.id}] ${item.preview}`
        list.appendChild(li)
      }
      gate.append(roHead, list)
    }

    container.appendChild(gate)
    return
  }

  let baselineContent = rawContent
  let currentContent = rawContent
  const turnHistory: string[] = []
  let activeTab: ProSurfaceTab = 'rendered'

  const wrapper = document.createElement('div')
  wrapper.className = 'sw-pro-canvas'

  const toolbar = document.createElement('div')
  toolbar.className = 'sw-toolbar'
  const label = document.createElement('strong')
  label.textContent = `${filePath} · Dual-Surface CRDT (.${ext})`

  const tabGroup = document.createElement('div')
  tabGroup.className = 'aos-segmented'

  const embedBtn = document.createElement('button')
  embedBtn.type = 'button'
  embedBtn.className = 'aos-btn aos-btn-sm'
  embedBtn.textContent = '+ ArtifactEmbed'

  const saveBtn = document.createElement('button')
  saveBtn.type = 'button'
  saveBtn.className = 'aos-btn aos-btn-sm aos-btn-primary'
  saveBtn.textContent = 'Save CRDT Source'

  const revertBtn = document.createElement('button')
  revertBtn.type = 'button'
  revertBtn.className = 'aos-btn aos-btn-sm'
  revertBtn.textContent = 'Revert Last AI Turn'

  const actionGroup = document.createElement('div')
  actionGroup.className = 'sw-toolbar-actions'
  actionGroup.append(tabGroup, embedBtn, saveBtn, revertBtn)
  toolbar.append(label, actionGroup)

  const artifactPicker = document.createElement('div')
  artifactPicker.className = 'sw-artifact-picker'
  artifactPicker.hidden = true

  const mountStage = document.createElement('div')
  mountStage.className = 'sw-dual-stage'

  const canvasHint = document.createElement('div')
  canvasHint.className = 'aos-muted'
  canvasHint.textContent =
    ext === 'pptx'
      ? '16:9 Slide Visual Deck + Dual-Surface CRDT Addressable Blocks'
      : 'Semantic Dual-Surface CRDT Document + Annotated {#id} Inspector'

  const embeddedSvgHost = document.createElement('div')
  embeddedSvgHost.className = 'sw-embedded-svg-host'
  embeddedSvgHost.hidden = true

  const bodyStage = document.createElement('div')
  bodyStage.className = 'sw-dual-body'

  const renderSurface = () => {
    bodyStage.innerHTML = ''
    tabGroup.innerHTML = ''
    for (const [tab, text] of [
      ['rendered', ext === 'pptx' ? 'Slides' : 'Canvas'],
      ['dual', 'Dual-Surface {#id}'],
      ['diff', 'Revision Diff'],
    ] as const) {
      const b = document.createElement('button')
      b.type = 'button'
      b.className = `aos-seg-btn ${activeTab === tab ? 'is-active' : ''}`
      b.textContent = text
      b.onclick = () => {
        activeTab = tab
        renderSurface()
      }
      tabGroup.appendChild(b)
    }

    if (activeTab === 'dual') {
      const panes = document.createElement('div')
      panes.className = 'sw-split-panes'
      const editor = document.createElement('textarea')
      editor.className = 'sw-md-source'
      editor.value = currentContent

      const outlinePanel = document.createElement('div')
      outlinePanel.className = 'sw-md-preview'
      const paintOutline = () => {
        outlinePanel.innerHTML = ''
        const items = extractBlockOutline(editor.value)
        if (items.length === 0) {
          outlinePanel.textContent = `[No addressable {#id} blocks in ${filePath}]`
          return
        }
        const ul = document.createElement('ul')
        ul.className = 'sw-outline-list'
        for (const it of items) {
          const li = document.createElement('li')
          li.innerHTML = `<span class="aos-badge info">#${it.id}</span> `
          li.appendChild(document.createTextNode(it.preview))
          ul.appendChild(li)
        }
        outlinePanel.appendChild(ul)
      }
      editor.oninput = () => {
        currentContent = editor.value
        paintOutline()
      }
      paintOutline()
      panes.append(editor, outlinePanel)
      bodyStage.appendChild(panes)
      return
    }

    if (activeTab === 'diff') {
      const diffCard = document.createElement('div')
      diffCard.className = 'sw-md-preview'
      const ops = computeWordDiff(baselineContent, currentContent)
      const hasChanges = ops.some(o => o.kind !== 'equal')
      if (!hasChanges) {
        diffCard.textContent = 'No unaccepted revisions vs baseline CRDT state.'
      } else {
        for (const op of ops) {
          if (op.kind === 'insert') {
            const ins = document.createElement('ins')
            ins.className = 'sw-diff-ins'
            ins.textContent = op.text
            diffCard.appendChild(ins)
          } else if (op.kind === 'delete') {
            const del = document.createElement('del')
            del.className = 'sw-diff-del'
            del.textContent = op.text
            diffCard.appendChild(del)
          } else {
            diffCard.appendChild(document.createTextNode(op.text))
          }
        }
      }
      bodyStage.appendChild(diffCard)
      return
    }

    // Rendered Canvas mode
    const items = extractBlockOutline(currentContent)
    if (items.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'sw-md-preview'
      empty.textContent =
        currentContent || `[Ready to mount Dual-Surface CRDT surface for ${filePath}]`
      bodyStage.appendChild(empty)
      return
    }

    const list = document.createElement('div')
    list.className = 'aos-agent-list'
    for (const it of items) {
      const card = document.createElement('div')
      card.className = it.kind === 'slide' ? 'sw-slide-card' : 'aos-agent-card'
      const head = document.createElement('div')
      head.className = 'aos-approval-top'
      const idBadge = document.createElement('span')
      idBadge.className = 'aos-badge info'
      idBadge.textContent = `#${it.id} · ${it.kind}`
      head.appendChild(idBadge)

      const body = document.createElement('div')
      body.textContent = it.preview
      card.append(head, body)
      list.appendChild(card)
    }
    bodyStage.appendChild(list)
  }

  saveBtn.onclick = async () => {
    saveBtn.disabled = true
    try {
      await bridge.writeTextFile(workspaceId, filePath, currentContent)
      baselineContent = currentContent
      canvasHint.innerHTML = `${iconHtml('check')}<span>Saved </span>`
      canvasHint.appendChild(document.createTextNode(filePath))
      renderSurface()
    } catch (err) {
      canvasHint.textContent = err instanceof Error ? err.message : String(err)
    } finally {
      saveBtn.disabled = false
    }
  }

  embedBtn.onclick = async () => {
    artifactPicker.hidden = !artifactPicker.hidden
    if (artifactPicker.hidden) return
    artifactPicker.innerHTML = ''
    const artifacts = (await bridge.listArtifactEmbeds?.(workspaceId)) ?? []
    if (artifacts.length === 0) {
      const empty = document.createElement('small')
      empty.className = 'aos-muted'
      empty.textContent =
        'No Data Studio artifacts available yet. Publish one from any .csv/.tsv/.json dataset first.'
      artifactPicker.appendChild(empty)
      return
    }
    for (const art of artifacts) {
      const row = document.createElement('div')
      row.className = 'sw-artifact-row'
      const lbl = document.createElement('span')
      lbl.textContent = `${art.title} (v${art.version} · ${art.kind})`
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'aos-btn aos-btn-sm aos-btn-primary'
      btn.textContent = 'Embed'
      btn.onclick = () => {
        turnHistory.push(currentContent)
        currentContent = currentContent + formatProArtifactBlock(art)
        if (art.svgMarkup) {
          embeddedSvgHost.hidden = false
          embeddedSvgHost.innerHTML = art.svgMarkup
        }
        canvasHint.textContent = `Embedded ${art.title} (v${art.version})`
        artifactPicker.hidden = true
        renderSurface()
      }
      row.append(lbl, btn)
      artifactPicker.appendChild(row)
    }
  }

  revertBtn.onclick = async () => {
    if (bridge.revertTurn) {
      const res = await bridge.revertTurn(filePath, 'latest')
      canvasHint.textContent = res.reverted ? `Reverted turn on ${res.docId}` : 'Turn already reverted.'
      return
    }
    const prev = turnHistory.pop()
    if (prev !== undefined) {
      currentContent = prev
      canvasHint.textContent = 'Reverted last local Canvas turn.'
      renderSurface()
    } else {
      canvasHint.textContent = 'No local Canvas turns to revert.'
    }
  }

  renderSurface()
  mountStage.append(canvasHint, embeddedSvgHost, bodyStage)
  wrapper.append(toolbar, artifactPicker, mountStage)
  container.appendChild(wrapper)
}
