import { brandMarkSvg, iconHtml, resolveFormatAccess, type DesktopEntitlements } from '@aegis/core-shell'
import type { WritingHostBridge } from './bridge.ts'
import { mountFreeMarkdownEditor } from './free-editor.ts'
import { mountProDualSurfaceCanvas } from './pro-canvas.ts'

export * from './bridge.ts'
export * from './free-editor.ts'
export * from './pro-canvas.ts'

export interface MountWritingStudioOptions {
  container: HTMLElement
  bridge: WritingHostBridge
  workspaceId: string | null
  filePath: string | null
  entitlements: DesktopEntitlements
  onRequestUpgrade: (reason: string) => void
}

/**
 * Main entry point mounted by either `apps/desktop` or standalone `apps/writing-standalone`.
 */
export async function mountWritingStudio(opts: MountWritingStudioOptions): Promise<void> {
  const { container, bridge, workspaceId, filePath, entitlements, onRequestUpgrade } = opts
  if (!workspaceId || !filePath) {
    container.innerHTML = `
      <div class="sw-empty-state">
        <div class="sw-empty-hero">
          ${brandMarkSvg()}
          <div class="aos-eyebrow">HEURION · AEGIS WORKBENCH</div>
          <h2 class="aos-serif-title">${workspaceId ? 'Select a file to begin' : 'Open a workspace to begin'}</h2>
          <p class="aos-muted">
            ${
              workspaceId
                ? 'Pick any file on the left, or click + File to start drafting.'
                : 'Open a folder from the top bar or launch Guide to begin.'
            }
          </p>
        </div>
        <div class="sw-empty-cards">
          <div class="sw-empty-card">
            ${iconHtml('pen')}
            <strong>Writing Studio</strong>
            <small>Split Markdown preview + instant CoW diff &amp; rollback.</small>
          </div>
          <div class="sw-empty-card">
            ${iconHtml('chartBar')}
            <strong>Data Studio</strong>
            <small>Interactive tables, column stats, and SVG charts from CSV/JSON.</small>
          </div>
          <div class="sw-empty-card">
            ${iconHtml('layers')}
            <strong>Cloud Pro</strong>
            <small>Dual-Surface CRDT for <code>.docx</code>, <code>.pptx</code>, <code>.pdf</code>, <code>.tex</code>.</small>
          </div>
        </div>
      </div>
    `
    return
  }

  const access = resolveFormatAccess(filePath, entitlements)
  if (access.mode === 'local_markdown' || access.mode === 'local_code') {
    await mountFreeMarkdownEditor({ container, bridge, workspaceId, filePath })
    return
  }

  await mountProDualSurfaceCanvas({
    container,
    bridge,
    workspaceId,
    filePath,
    entitlements,
    onRequestUpgrade,
  })
}
