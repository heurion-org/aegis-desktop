import { resolveFormatAccess, type DesktopEntitlements } from '../entitlements.ts'
import type { SyncPolicy, WorkspaceTreeEntry } from '../daemon-client.ts'

export interface WorkspaceTreeOptions {
  container: HTMLElement
  entries: WorkspaceTreeEntry[]
  syncPolicy: SyncPolicy
  entitlements: DesktopEntitlements
  selectedPath: string | null
  onSelectFile: (entry: WorkspaceTreeEntry) => void
  onToggleDefaultSync?: (mode: 'local_only' | 'cloud_crdt') => void
}

export function renderWorkspaceTree(opts: WorkspaceTreeOptions): void {
  const { container, entries, syncPolicy, entitlements, selectedPath, onSelectFile, onToggleDefaultSync } = opts
  container.innerHTML = ''

  const header = document.createElement('div')
  header.className = 'aos-panel-header'
  const title = document.createElement('span')
  title.textContent = 'Workspace Files'

  const policyBtn = document.createElement('button')
  policyBtn.type = 'button'
  policyBtn.className = 'aos-pill'
  const isCloudDefault = syncPolicy.default_mode !== 'local_only' && entitlements.cloud_yjs_sync
  policyBtn.textContent = isCloudDefault ? '☁ Cloud Sync' : '🔒 Local Only'
  policyBtn.title = entitlements.cloud_yjs_sync
    ? 'Toggle default workspace sync mode'
    : 'Cloud CRDT & Yjs sync unlocks with Cloud Pro'
  policyBtn.onclick = () => {
    if (!entitlements.cloud_yjs_sync) return
    onToggleDefaultSync?.(syncPolicy.default_mode === 'local_only' ? 'cloud_crdt' : 'local_only')
  }
  header.append(title, policyBtn)
  container.appendChild(header)

  const list = document.createElement('ul')
  list.className = 'aos-tree-list'

  const files = entries.filter(e => !e.is_dir)
  if (files.length === 0) {
    const empty = document.createElement('li')
    empty.className = 'aos-muted'
    empty.textContent = 'No files in workspace yet.'
    list.appendChild(empty)
  }

  for (const entry of files) {
    const li = document.createElement('li')
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = `aos-tree-item ${selectedPath === entry.path ? 'is-selected' : ''}`

    const access = resolveFormatAccess(entry.name, entitlements)
    const nameSpan = document.createElement('span')
    nameSpan.className = 'aos-tree-name'
    nameSpan.textContent = entry.path

    const badge = document.createElement('span')
    if (access.mode === 'locked_cloud_pro') {
      badge.className = 'aos-badge warn'
      badge.textContent = 'PRO 🔒'
    } else if (access.mode === 'cloud_dual_surface') {
      badge.className = 'aos-badge info'
      badge.textContent = 'CRDT'
    } else {
      badge.className = 'aos-badge ok'
      badge.textContent = 'LOCAL'
    }

    btn.append(nameSpan, badge)
    btn.onclick = () => onSelectFile(entry)
    li.appendChild(btn)
    list.appendChild(li)
  }

  container.appendChild(list)
}
