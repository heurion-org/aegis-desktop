import type { WritingHostBridge } from './bridge.ts'

export interface FreeMarkdownEditorOptions {
  container: HTMLElement
  bridge: WritingHostBridge
  workspaceId: string
  filePath: string
}

type FreeEditorViewMode = 'split' | 'source' | 'preview'

const MARKDOWN_EXTS = new Set(['md', 'markdown', 'mdx'])

export function isMarkdownFile(filePath: string): boolean {
  const dot = filePath.lastIndexOf('.')
  if (dot < 0) return false
  return MARKDOWN_EXTS.has(filePath.slice(dot + 1).toLowerCase())
}

function escapeHtml(raw: string): string {
  return raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

/** Simple safe Markdown preview renderer for offline local-only Free mode (zero cloud sync). */
export function renderMarkdownPreviewHtml(markdown: string): string {
  const inlineFmt = (s: string): string =>
    s
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*([^*]+)\*/g, '<em>$1</em>')
      .replace(/`([^`]+)`/g, '<code>$1</code>')

  const lines = markdown.split(/\r?\n/)
  const out: string[] = []
  let inFence = false
  let fenceLines: string[] = []

  for (const rawLine of lines) {
    if (rawLine.trimStart().startsWith('```')) {
      if (!inFence) {
        inFence = true
        fenceLines = []
      } else {
        out.push(`<pre><code>${escapeHtml(fenceLines.join('\n'))}</code></pre>`)
        inFence = false
        fenceLines = []
      }
      continue
    }
    if (inFence) {
      fenceLines.push(rawLine)
      continue
    }

    const line = escapeHtml(rawLine)
    if (line.startsWith('### ')) {
      out.push(`<h3>${inlineFmt(line.slice(4))}</h3>`)
    } else if (line.startsWith('## ')) {
      out.push(`<h2>${inlineFmt(line.slice(3))}</h2>`)
    } else if (line.startsWith('# ')) {
      out.push(`<h1>${inlineFmt(line.slice(2))}</h1>`)
    } else if (line.startsWith('- ') || line.startsWith('* ')) {
      out.push(`<li>${inlineFmt(line.slice(2))}</li>`)
    } else if (line.startsWith('&gt; ')) {
      out.push(`<blockquote>${inlineFmt(line.slice(5))}</blockquote>`)
    } else if (line.trim() === '---') {
      out.push('<hr>')
    } else if (line.trim() === '') {
      out.push('<div class="md-spacer"></div>')
    } else {
      out.push(`<p>${inlineFmt(line)}</p>`)
    }
  }
  if (inFence && fenceLines.length > 0) {
    out.push(`<pre><code>${escapeHtml(fenceLines.join('\n'))}</code></pre>`)
  }
  return out.join('\n')
}

export async function mountFreeMarkdownEditor(opts: FreeMarkdownEditorOptions): Promise<void> {
  const { container, bridge, workspaceId, filePath } = opts
  container.innerHTML = ''

  const isMd = isMarkdownFile(filePath)
  let viewMode: FreeEditorViewMode = isMd ? 'split' : 'source'
  let savedContent = await bridge.readTextFile(workspaceId, filePath).catch(() => '')

  const wrapper = document.createElement('div')
  wrapper.className = 'sw-free-editor'

  const toolbar = document.createElement('div')
  toolbar.className = 'sw-toolbar'

  const titleGroup = document.createElement('div')
  titleGroup.className = 'sw-toolbar-actions'
  const title = document.createElement('strong')
  title.textContent = isMd
    ? `${filePath} (Local Free Markdown · No Cloud Sync)`
    : `${filePath} (Local Free Code · No Cloud Sync)`
  const dirtyBadge = document.createElement('span')
  dirtyBadge.className = 'aos-badge warn sw-dirty-dot'
  dirtyBadge.textContent = '● Unsaved'
  dirtyBadge.hidden = true
  titleGroup.append(title, dirtyBadge)

  const actions = document.createElement('div')
  actions.className = 'sw-toolbar-actions'

  if (isMd) {
    const viewGroup = document.createElement('div')
    viewGroup.className = 'aos-segmented'
    const modeBtns: Array<{ mode: FreeEditorViewMode; label: string; btn: HTMLButtonElement }> = []
    for (const [m, label] of [
      ['split', 'Split'],
      ['source', 'Source'],
      ['preview', 'Preview'],
    ] as const) {
      const b = document.createElement('button')
      b.type = 'button'
      b.className = `aos-seg-btn ${viewMode === m ? 'is-active' : ''}`
      b.textContent = label
      b.onclick = () => {
        viewMode = m
        applyViewMode()
        for (const item of modeBtns) {
          item.btn.className = `aos-seg-btn ${item.mode === viewMode ? 'is-active' : ''}`
        }
      }
      modeBtns.push({ mode: m, label, btn: b })
      viewGroup.appendChild(b)
    }
    actions.appendChild(viewGroup)
  }

  const saveBtn = document.createElement('button')
  saveBtn.type = 'button'
  saveBtn.className = 'aos-btn aos-btn-sm aos-btn-primary'
  saveBtn.textContent = 'Save'

  const diffBtn = document.createElement('button')
  diffBtn.type = 'button'
  diffBtn.className = 'aos-btn aos-btn-sm'
  diffBtn.textContent = 'Diff'

  const acceptBtn = document.createElement('button')
  acceptBtn.type = 'button'
  acceptBtn.className = 'aos-btn aos-btn-sm'
  acceptBtn.textContent = 'Accept Changes'

  const rollbackBtn = document.createElement('button')
  rollbackBtn.type = 'button'
  rollbackBtn.className = 'aos-btn aos-btn-sm'
  rollbackBtn.textContent = 'Rollback'

  actions.append(saveBtn, diffBtn, acceptBtn, rollbackBtn)
  toolbar.append(titleGroup, actions)

  const panes = document.createElement('div')
  panes.className = 'sw-split-panes'

  const textarea = document.createElement('textarea')
  textarea.className = 'sw-md-source'
  textarea.value = savedContent

  const preview = document.createElement('div')
  preview.className = 'sw-md-preview'
  if (isMd) {
    preview.innerHTML = renderMarkdownPreviewHtml(savedContent)
  }

  const metaFooter = document.createElement('small')
  metaFooter.className = 'aos-muted'

  const diffDrawer = document.createElement('pre')
  diffDrawer.className = 'sw-diff-drawer'
  diffDrawer.hidden = true

  const updateMetaAndDirty = () => {
    dirtyBadge.hidden = textarea.value === savedContent
    const lineCount = textarea.value ? textarea.value.split(/\r?\n/).length : 0
    metaFooter.textContent = `${lineCount} line(s) · ${textarea.value.length} chars`
  }

  const applyViewMode = () => {
    if (!isMd || viewMode === 'source') {
      panes.className = 'sw-split-panes sw-code-single'
      textarea.hidden = false
      preview.hidden = true
    } else if (viewMode === 'preview') {
      panes.className = 'sw-split-panes sw-code-single'
      textarea.hidden = true
      preview.hidden = false
      preview.innerHTML = renderMarkdownPreviewHtml(textarea.value)
    } else {
      panes.className = 'sw-split-panes'
      textarea.hidden = false
      preview.hidden = false
      preview.innerHTML = renderMarkdownPreviewHtml(textarea.value)
    }
  }

  const showStatus = (msg: string) => {
    diffDrawer.hidden = false
    diffDrawer.textContent = msg
  }

  const performSave = async () => {
    saveBtn.disabled = true
    try {
      await bridge.writeTextFile(workspaceId, filePath, textarea.value)
      savedContent = textarea.value
      updateMetaAndDirty()
      saveBtn.textContent = 'Saved ✓'
      setTimeout(() => {
        saveBtn.textContent = 'Save'
      }, 1200)
    } catch (err) {
      showStatus(err instanceof Error ? err.message : String(err))
    } finally {
      saveBtn.disabled = false
    }
  }

  textarea.oninput = () => {
    if (isMd && !preview.hidden) {
      preview.innerHTML = renderMarkdownPreviewHtml(textarea.value)
    }
    updateMetaAndDirty()
  }

  textarea.onkeydown = ev => {
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 's') {
      ev.preventDefault()
      void performSave()
    }
  }

  saveBtn.onclick = () => void performSave()

  diffBtn.onclick = async () => {
    if (!bridge.diffWorkspace) return
    diffBtn.disabled = true
    try {
      const summary = await bridge.diffWorkspace(workspaceId)
      diffDrawer.hidden = !diffDrawer.hidden
      if (!summary.diff_text && summary.changed_files.length === 0) {
        diffDrawer.textContent =
          summary.is_git_repo === false
            ? 'Not a git repository (select a child git repo in topbar for git diff).'
            : 'Workspace clean (no unaccepted changes).'
      } else {
        diffDrawer.textContent =
          summary.diff_text || `Changed files:\n${summary.changed_files.join('\n')}`
      }
    } catch (err) {
      showStatus(err instanceof Error ? err.message : String(err))
    } finally {
      diffBtn.disabled = false
    }
  }

  acceptBtn.onclick = async () => {
    if (!bridge.commitWorkspace) return
    acceptBtn.disabled = true
    try {
      if (textarea.value !== savedContent) {
        await bridge.writeTextFile(workspaceId, filePath, textarea.value)
        savedContent = textarea.value
        updateMetaAndDirty()
      }
      const res = await bridge.commitWorkspace(workspaceId, `Accept edits to ${filePath}`)
      acceptBtn.textContent = res.committed === false ? 'Clean' : 'Accepted ✓'
      setTimeout(() => {
        acceptBtn.textContent = 'Accept Changes'
      }, 1500)
      showStatus(res.summary ?? (res.commit_hash ? `Committed ${res.commit_hash}` : 'Changes committed.'))
    } catch (err) {
      showStatus(err instanceof Error ? err.message : String(err))
    } finally {
      acceptBtn.disabled = false
    }
  }

  rollbackBtn.onclick = async () => {
    if (!bridge.rollbackWorkspace) return
    rollbackBtn.disabled = true
    try {
      await bridge.rollbackWorkspace(workspaceId)
      savedContent = await bridge.readTextFile(workspaceId, filePath).catch(() => '')
      textarea.value = savedContent
      if (isMd) {
        preview.innerHTML = renderMarkdownPreviewHtml(savedContent)
      }
      updateMetaAndDirty()
      rollbackBtn.textContent = 'Rolled Back ✓'
      setTimeout(() => {
        rollbackBtn.textContent = 'Rollback'
      }, 1500)
      diffDrawer.hidden = true
    } catch (err) {
      showStatus(err instanceof Error ? err.message : String(err))
    } finally {
      rollbackBtn.disabled = false
    }
  }

  panes.append(textarea, preview)
  applyViewMode()
  updateMetaAndDirty()
  wrapper.append(toolbar, panes, metaFooter, diffDrawer)
  container.appendChild(wrapper)
}
