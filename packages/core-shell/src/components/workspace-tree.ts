import { resolveFormatAccess, type DesktopEntitlements } from '../entitlements.ts'
import { iconHtml, type IconName } from '../icons.ts'
import type { SyncMode, SyncPolicy, WorkspaceTreeEntry } from '../daemon-client.ts'

export interface WorkspaceTreeOptions {
  container: HTMLElement
  entries: WorkspaceTreeEntry[]
  syncPolicy: SyncPolicy
  entitlements: DesktopEntitlements
  selectedPath: string | null
  collapsedDirs?: Set<string>
  searchQuery?: string
  onSearchChange?: (query: string) => void
  onToggleDir?: (dirPath: string) => void
  onSelectFile: (entry: WorkspaceTreeEntry) => void
  onCreateFile?: (relPath: string) => Promise<void>
  onToggleDefaultSync?: (mode: 'local_only' | 'cloud_crdt') => void
  onSetFolderSyncRule?: (dirPath: string, mode: SyncMode) => Promise<void>
}

function normalizeRulePrefix(raw: string): string {
  return raw
    .trim()
    .replace(/^\.\//, '')
    .replace(/^\/+/, '')
    .replace(/\/\*\*$/, '')
    .replace(/\/+$/, '')
}

/**
 * Set or remove a per-folder selective sync override.
 * If `mode` matches `policy.default_mode`, the redundant rule is omitted.
 */
export function upsertSyncRule(policy: SyncPolicy, pathPrefix: string, mode: SyncMode): SyncPolicy {
  const norm = normalizeRulePrefix(pathPrefix)
  const remaining = policy.rules.filter(r => normalizeRulePrefix(r.path_prefix) !== norm)
  if (!norm || mode === policy.default_mode) {
    return {
      default_mode: policy.default_mode,
      rules: remaining,
    }
  }
  return {
    default_mode: policy.default_mode,
    rules: [...remaining, { path_prefix: norm, mode }],
  }
}

/**
 * Case-insensitive substring filter on tree paths while keeping ancestor directories
 * of any matching entry so hierarchical indentation remains intact.
 */
export function filterTreeEntries(entries: WorkspaceTreeEntry[], query: string): WorkspaceTreeEntry[] {
  const q = query.trim().toLowerCase()
  if (!q) return entries

  const keep = new Set<string>()
  for (const e of entries) {
    if (e.path.toLowerCase().includes(q) || e.name.toLowerCase().includes(q)) {
      keep.add(e.path)
      const parts = e.path.split('/')
      for (let i = 1; i < parts.length; i++) {
        keep.add(parts.slice(0, i).join('/'))
      }
    }
  }
  return entries.filter(e => keep.has(e.path))
}

function nextSyncMode(current: SyncMode): SyncMode {
  if (current === 'local_only') return 'cloud_crdt'
  if (current === 'cloud_crdt') return 'cloud_blob'
  return 'local_only'
}

function syncChipHtml(mode: SyncMode): string {
  if (mode === 'cloud_crdt') return `${iconHtml('cloud')}<span>CRDT</span>`
  if (mode === 'cloud_blob') return `${iconHtml('packageBox')}<span>Blob</span>`
  return `${iconHtml('lock')}<span>Local</span>`
}

function fileIconName(name: string): IconName {
  const lower = name.toLowerCase()
  if (lower.endsWith('.csv') || lower.endsWith('.tsv') || lower.endsWith('.json')) return 'fileTable'
  if (lower.endsWith('.md') || lower.endsWith('.markdown') || lower.endsWith('.docx') || lower.endsWith('.pdf') || lower.endsWith('.tex')) {
    return 'fileDoc'
  }
  if (/\.(ts|tsx|js|jsx|rs|py|go|sh|css|html|toml|yaml|yml)$/.test(lower)) return 'fileCode'
  return 'file'
}

export function renderWorkspaceTree(opts: WorkspaceTreeOptions): void {
  const {
    container,
    entries,
    syncPolicy,
    entitlements,
    selectedPath,
    collapsedDirs = new Set<string>(),
    searchQuery = '',
    onSearchChange,
    onToggleDir,
    onSelectFile,
    onCreateFile,
    onToggleDefaultSync,
    onSetFolderSyncRule,
  } = opts
  container.innerHTML = ''

  const header = document.createElement('div')
  header.className = 'aos-panel-header'
  const title = document.createElement('span')
  title.textContent = 'Workspace Files'

  const headerActions = document.createElement('div')
  headerActions.className = 'aos-tree-header-actions'

  if (onCreateFile) {
    const addBtn = document.createElement('button')
    addBtn.type = 'button'
    addBtn.className = 'aos-pill'
    addBtn.textContent = '+ File'
    addBtn.onclick = () => {
      newFileForm.hidden = !newFileForm.hidden
      if (!newFileForm.hidden) {
        newFileInput.focus()
      }
    }
    headerActions.appendChild(addBtn)
  }

  const policyBtn = document.createElement('button')
  policyBtn.type = 'button'
  policyBtn.className = 'aos-pill'
  const isCloudDefault = syncPolicy.default_mode !== 'local_only' && entitlements.cloud_yjs_sync
  policyBtn.innerHTML = isCloudDefault
    ? `${iconHtml('cloud')}<span>Cloud Sync</span>`
    : `${iconHtml('lock')}<span>Local Only</span>`
  policyBtn.title = entitlements.cloud_yjs_sync
    ? 'Toggle default workspace sync mode'
    : 'Cloud CRDT & Yjs sync unlocks with Cloud Pro'
  policyBtn.onclick = () => {
    if (!entitlements.cloud_yjs_sync) return
    onToggleDefaultSync?.(syncPolicy.default_mode === 'local_only' ? 'cloud_crdt' : 'local_only')
  }
  headerActions.appendChild(policyBtn)

  header.append(title, headerActions)
  container.appendChild(header)

  const newFileForm = document.createElement('form')
  newFileForm.className = 'aos-new-file-bar'
  newFileForm.hidden = true
  const newFileInput = document.createElement('input')
  newFileInput.type = 'text'
  newFileInput.className = 'aos-tree-search'
  newFileInput.placeholder = 'e.g. notes/draft.md'
  const createConfirm = document.createElement('button')
  createConfirm.type = 'submit'
  createConfirm.className = 'aos-btn aos-btn-sm aos-btn-primary'
  createConfirm.textContent = 'Create'
  newFileForm.append(newFileInput, createConfirm)
  newFileForm.onsubmit = async ev => {
    ev.preventDefault()
    const val = newFileInput.value.trim()
    if (!val || !onCreateFile) return
    createConfirm.disabled = true
    try {
      await onCreateFile(val)
      newFileInput.value = ''
      newFileForm.hidden = true
    } finally {
      createConfirm.disabled = false
    }
  }
  container.appendChild(newFileForm)

  const searchInput = document.createElement('input')
  searchInput.type = 'search'
  searchInput.className = 'aos-tree-search'
  searchInput.placeholder = 'Filter files…'
  searchInput.value = searchQuery
  searchInput.oninput = () => {
    onSearchChange?.(searchInput.value)
  }
  container.appendChild(searchInput)

  const list = document.createElement('ul')
  list.className = 'aos-tree-list'

  const filtered = filterTreeEntries(entries, searchQuery)
  const hasSearch = searchQuery.trim().length > 0
  const visible = filtered.filter(entry => {
    if (hasSearch) return true
    const parts = entry.path.split('/')
    for (let i = 1; i < parts.length; i++) {
      const ancestor = parts.slice(0, i).join('/')
      if (collapsedDirs.has(ancestor)) return false
    }
    return true
  })

  if (visible.length === 0) {
    const empty = document.createElement('li')
    empty.className = 'aos-muted'
    empty.textContent = entries.length === 0 ? 'No files in workspace yet.' : 'No matching files.'
    list.appendChild(empty)
  }

  for (const entry of visible) {
    const li = document.createElement('li')
    const depth = Math.max(0, entry.path.split('/').length - 1)

    if (entry.is_dir) {
      const dirRow = document.createElement('div')
      dirRow.className = 'aos-tree-dir-row'
      dirRow.style.paddingLeft = `${8 + depth * 12}px`

      const toggleBtn = document.createElement('button')
      toggleBtn.type = 'button'
      toggleBtn.className = 'aos-tree-dir-btn'
      const collapsed = !hasSearch && collapsedDirs.has(entry.path)
      toggleBtn.innerHTML = `${iconHtml(collapsed ? 'chevronRight' : 'chevronDown')}${iconHtml(collapsed ? 'folder' : 'folderOpen')}`
      const dirLabel = document.createElement('span')
      dirLabel.textContent = entry.name
      toggleBtn.appendChild(dirLabel)
      toggleBtn.onclick = () => onToggleDir?.(entry.path)
      dirRow.appendChild(toggleBtn)

      if (entitlements.cloud_yjs_sync && onSetFolderSyncRule) {
        const syncChip = document.createElement('button')
        syncChip.type = 'button'
        syncChip.className = 'aos-sync-chip'
        syncChip.innerHTML = syncChipHtml(entry.sync_mode)
        syncChip.title = `Folder sync: ${entry.sync_mode} (click to cycle)`
        syncChip.onclick = ev => {
          ev.stopPropagation()
          syncChip.disabled = true
          void onSetFolderSyncRule(entry.path, nextSyncMode(entry.sync_mode)).finally(() => {
            syncChip.disabled = false
          })
        }
        dirRow.appendChild(syncChip)
      }

      li.appendChild(dirRow)
      list.appendChild(li)
      continue
    }

    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = `aos-tree-item ${selectedPath === entry.path ? 'is-selected' : ''}`
    btn.style.paddingLeft = `${8 + depth * 12}px`

    const access = resolveFormatAccess(entry.name, entitlements)
    const nameWrap = document.createElement('span')
    nameWrap.className = 'aos-tree-name-wrap'
    nameWrap.innerHTML = iconHtml(fileIconName(entry.name))
    const nameSpan = document.createElement('span')
    nameSpan.className = 'aos-tree-name'
    nameSpan.textContent = entry.name
    nameSpan.title = entry.path
    nameWrap.appendChild(nameSpan)

    const badge = document.createElement('span')
    if (access.mode === 'locked_cloud_pro') {
      badge.className = 'aos-badge warn'
      badge.innerHTML = `${iconHtml('lock')}<span>PRO</span>`
    } else if (access.mode === 'cloud_dual_surface') {
      badge.className = 'aos-badge info'
      badge.textContent = entry.sync_mode === 'local_only' ? 'LOCAL' : 'CRDT'
    } else {
      badge.className = 'aos-badge ok'
      badge.textContent = 'LOCAL'
    }

    btn.append(nameWrap, badge)
    btn.onclick = () => onSelectFile(entry)
    li.appendChild(btn)
    list.appendChild(li)
  }

  container.appendChild(list)
}
