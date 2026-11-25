import { resolveFormatAccess, type DesktopEntitlements } from '@aegis/core-shell'
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
        <h3>Writing Studio</h3>
        <p>Select a workspace file to edit:</p>
        <ul>
          <li><strong>Free Local:</strong> <code>.md</code>, <code>.markdown</code>, and source code files inside Aegis CoW isolation.</li>
          <li><strong>Cloud Pro:</strong> Dual-Surface CRDT for <code>.docx</code>, <code>.pptx</code>, <code>.pdf</code>, <code>.tex</code> &amp; Cloud Yjs collaboration.</li>
        </ul>
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
