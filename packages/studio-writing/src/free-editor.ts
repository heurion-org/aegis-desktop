import type { WritingHostBridge } from './bridge.ts'

export interface FreeMarkdownEditorOptions {
  container: HTMLElement
  bridge: WritingHostBridge
  workspaceId: string
  filePath: string
}

/** Simple safe Markdown preview renderer for offline local-only Free mode (zero cloud sync). */
export function renderMarkdownPreviewHtml(markdown: string): string {
  const escaped = markdown
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')

  const inlineFmt = (s: string): string =>
    s
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/`([^`]+)`/g, '<code>$1</code>')

  return escaped
    .split(/\r?\n/)
    .map(line => {
      if (line.startsWith('### ')) return `<h3>${inlineFmt(line.slice(4))}</h3>`
      if (line.startsWith('## ')) return `<h2>${inlineFmt(line.slice(3))}</h2>`
      if (line.startsWith('# ')) return `<h1>${inlineFmt(line.slice(2))}</h1>`
      if (line.startsWith('- ')) return `<li>${inlineFmt(line.slice(2))}</li>`
      if (line.trim() === '') return '<div class="md-spacer"></div>'
      return `<p>${inlineFmt(line)}</p>`
    })
    .join('\n')
}

export async function mountFreeMarkdownEditor(opts: FreeMarkdownEditorOptions): Promise<void> {
  const { container, bridge, workspaceId, filePath } = opts
  container.innerHTML = ''

  const wrapper = document.createElement('div')
  wrapper.className = 'sw-free-editor'

  const toolbar = document.createElement('div')
  toolbar.className = 'sw-toolbar'
  const title = document.createElement('strong')
  title.textContent = `${filePath} (Local Free Mode · No Cloud Sync)`

  const actions = document.createElement('div')
  actions.className = 'sw-toolbar-actions'

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
  toolbar.append(title, actions)

  const panes = document.createElement('div')
  panes.className = 'sw-split-panes'

  const textarea = document.createElement('textarea')
  textarea.className = 'sw-md-source'
  textarea.value = await bridge.readTextFile(workspaceId, filePath).catch(() => '')

  const preview = document.createElement('div')
  preview.className = 'sw-md-preview'
  preview.innerHTML = renderMarkdownPreviewHtml(textarea.value)

  const diffDrawer = document.createElement('pre')
  diffDrawer.className = 'sw-diff-drawer'
  diffDrawer.hidden = true

  const showStatus = (msg: string) => {
    diffDrawer.hidden = false
    diffDrawer.textContent = msg
  }

  textarea.oninput = () => {
    preview.innerHTML = renderMarkdownPreviewHtml(textarea.value)
  }

  saveBtn.onclick = async () => {
    saveBtn.disabled = true
    try {
      await bridge.writeTextFile(workspaceId, filePath, textarea.value)
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

  diffBtn.onclick = async () => {
    if (!bridge.diffWorkspace) return
    diffBtn.disabled = true
    try {
      const summary = await bridge.diffWorkspace(workspaceId)
      diffDrawer.hidden = !diffDrawer.hidden
      if (!summary.diff_text && summary.changed_files.length === 0) {
        diffDrawer.textContent = summary.is_git_repo === false
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
      textarea.value = await bridge.readTextFile(workspaceId, filePath).catch(() => '')
      preview.innerHTML = renderMarkdownPreviewHtml(textarea.value)
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
  wrapper.append(toolbar, panes, diffDrawer)
  container.appendChild(wrapper)
}
