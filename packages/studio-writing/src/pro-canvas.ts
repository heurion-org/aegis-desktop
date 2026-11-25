import { normalizeExt, resolveFormatAccess, type DesktopEntitlements } from '@aegis/core-shell'
import type { WritingHostBridge } from './bridge.ts'

export interface ProCanvasOptions {
  container: HTMLElement
  bridge: WritingHostBridge
  workspaceId: string
  filePath: string
  entitlements: DesktopEntitlements
  onRequestUpgrade: (reason: string) => void
}

/**
 * Cloud Pro Dual-Surface CRDT view for `.docx` / `.pptx` / `.pdf` / `.tex`.
 * Enforces the Free -> Cloud Pro product boundary: free users see an explicit
 * upgrade prompt and zero Cloud Yjs sync attempts.
 */
export async function mountProDualSurfaceCanvas(opts: ProCanvasOptions): Promise<void> {
  const { container, bridge, workspaceId, filePath, entitlements, onRequestUpgrade } = opts
  container.innerHTML = ''

  const access = resolveFormatAccess(filePath, entitlements)
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
    container.appendChild(gate)
    return
  }

  const ext = normalizeExt(filePath)
  const wrapper = document.createElement('div')
  wrapper.className = 'sw-pro-canvas'

  const toolbar = document.createElement('div')
  toolbar.className = 'sw-toolbar'
  const label = document.createElement('strong')
  label.textContent = `${filePath} · Dual-Surface CRDT (.${ext})`

  const embedBtn = document.createElement('button')
  embedBtn.type = 'button'
  embedBtn.className = 'aos-btn aos-btn-sm'
  embedBtn.textContent = '+ ArtifactEmbed'

  const revertBtn = document.createElement('button')
  revertBtn.type = 'button'
  revertBtn.className = 'aos-btn aos-btn-sm'
  revertBtn.textContent = 'Revert Last AI Turn'

  toolbar.append(label, embedBtn, revertBtn)

  const mountStage = document.createElement('div')
  mountStage.className = 'sw-dual-stage'

  const canvasHint = document.createElement('div')
  canvasHint.className = 'sw-dual-banner'
  canvasHint.textContent =
    ext === 'pptx'
      ? 'Deck Visual Slide Editor + Dual-Surface CRDT Inspector (@heurion/doc-ui/deck)'
      : 'Document Dual-Surface CRDT Editor + Source XML/TeX Inspector (@heurion/doc-ui/editor)'

  const surfaceBody = document.createElement('div')
  surfaceBody.className = 'sw-dual-body'
  const content = await bridge.readTextFile(workspaceId, filePath).catch(() => '')
  const pre = document.createElement('pre')
  pre.className = 'sw-raw-preview'
  pre.textContent = content || `[Ready to mount @heurion/doc-ui CRDT surface for ${filePath}]`
  surfaceBody.appendChild(pre)

  embedBtn.onclick = async () => {
    const artifacts = (await bridge.listArtifactEmbeds?.(workspaceId)) ?? []
    canvasHint.textContent = artifacts.length
      ? `Found ${artifacts.length} embeddable artifact(s): ${artifacts.map(a => a.title).join(', ')}`
      : 'No V1.5 Data Studio artifacts available yet.'
  }

  revertBtn.onclick = async () => {
    if (!bridge.revertTurn) {
      canvasHint.textContent = 'Connect Cloud Collab Gateway to enable turn-level CRDT revert.'
      return
    }
    const res = await bridge.revertTurn(filePath, 'latest')
    canvasHint.textContent = res.reverted ? `Reverted turn on ${res.docId}` : 'Turn already reverted.'
  }

  mountStage.append(canvasHint, surfaceBody)
  wrapper.append(toolbar, mountStage)
  container.appendChild(wrapper)
}
