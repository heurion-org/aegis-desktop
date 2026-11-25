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
                ? 'Choose any Markdown, source file, or CSV/JSON dataset from the left workspace tree, or create a new file.'
                : 'Use "+ Workspace" in the top bar (or open the Setup Guide) to mount a local folder under CoW isolation.'
            }
          </p>
        </div>
        <div class="sw-empty-cards">
          <div class="sw-empty-card">
            ${iconHtml('pen')}
            <strong>Free Local Studio</strong>
            <small>Split Markdown preview, source editing, and CoW Diff / Commit / Rollback for <code>.md</code> &amp; code.</small>
          </div>
          <div class="sw-empty-card">
            ${iconHtml('chartBar')}
            <strong>Data Studio (V1.5)</strong>
            <small>Open any <code>.csv</code>, <code>.tsv</code>, or tabular <code>.json</code> for sortable tables, stats, and SVG charts.</small>
          </div>
          <div class="sw-empty-card">
            ${iconHtml('layers')}
            <strong>Cloud Pro Dual-Surface</strong>
            <small>Upgrade with an Ed25519 token for <code>.docx</code>, <code>.pptx</code>, <code>.pdf</code>, and <code>.tex</code> CRDT editing.</small>
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
