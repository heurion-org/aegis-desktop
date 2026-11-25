import {
  brandMarkSvg,
  iconHtml,
  resolveFormatAccess,
  type DesktopEntitlements,
  type StudioQuickActions,
} from '@aegis/core-shell'
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
  quickActions?: StudioQuickActions
  onOpenDataView?: () => void
}

function esc(raw: string): string {
  return raw.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/**
 * Main entry point mounted by either `apps/desktop` or standalone `apps/writing-standalone`.
 */
export async function mountWritingStudio(opts: MountWritingStudioOptions): Promise<void> {
  const { container, bridge, workspaceId, filePath, entitlements, onRequestUpgrade, quickActions, onOpenDataView } = opts
  if (!workspaceId || !filePath) {
    container.innerHTML = ''
    const wrap = document.createElement('div')
    wrap.className = 'sw-empty-state'

    const hero = document.createElement('div')
    hero.className = 'sw-empty-hero'
    hero.innerHTML = `
      ${brandMarkSvg()}
      <div class="aos-eyebrow">${workspaceId ? 'WORKSPACE READY' : 'GET STARTED'}</div>
      <h2 class="aos-serif-title">${workspaceId ? 'What would you like to do?' : 'Open a folder to start'}</h2>
      <p class="aos-muted">
        ${
          workspaceId
            ? 'Start a new note, explore tabular data, ask your AI assistant, or jump straight into an existing file.'
            : 'Choose a local folder on your machine — all edits stay safely inside your Copy-on-Write sandbox.'
        }
      </p>
    `
    wrap.appendChild(hero)

    const cards = document.createElement('div')
    cards.className = workspaceId ? 'sw-action-cards' : 'sw-action-cards is-two-col'

    if (!workspaceId) {
      const openCard = document.createElement('button')
      openCard.type = 'button'
      openCard.className = 'sw-action-card is-primary'
      openCard.innerHTML = `
        <div class="sw-action-head">${iconHtml('folderOpen')}<span>Open Local Folder</span>${iconHtml('arrowRight')}</div>
        <small>Select any project, paper, or dataset directory on your computer.</small>
      `
      openCard.onclick = () => quickActions?.onOpenWorkspace()
      cards.appendChild(openCard)

      const guideCard = document.createElement('button')
      guideCard.type = 'button'
      guideCard.className = 'sw-action-card'
      guideCard.innerHTML = `
        <div class="sw-action-head">${iconHtml('compass')}<span>Open Setup Guide</span>${iconHtml('arrowRight')}</div>
        <small>Walk through workspace selection, optional AI CLIs, and theme customization.</small>
      `
      guideCard.onclick = () => quickActions?.onOpenGuide?.()
      cards.appendChild(guideCard)
    } else {
      const writeCard = document.createElement('button')
      writeCard.type = 'button'
      writeCard.className = 'sw-action-card is-primary'
      writeCard.innerHTML = `
        <div class="sw-action-head">${iconHtml('pen')}<span>New Markdown Note</span>${iconHtml('arrowRight')}</div>
        <small>Create <code>notes/draft.md</code> with live preview and CoW Diff.</small>
      `
      writeCard.onclick = () => quickActions?.onCreateMarkdown()

      const dataCard = document.createElement('button')
      dataCard.type = 'button'
      dataCard.className = 'sw-action-card'
      dataCard.innerHTML = `
        <div class="sw-action-head">${iconHtml('chartBar')}<span>Explore Data &amp; Charts</span>${iconHtml('arrowRight')}</div>
        <small>Open a CSV/JSON file or launch a sample cohort table in Data Studio.</small>
      `
      dataCard.onclick = () => quickActions?.onOpenOrCreateDataset()

      const agentCard = document.createElement('button')
      agentCard.type = 'button'
      agentCard.className = 'sw-action-card'
      agentCard.innerHTML = `
        <div class="sw-action-head">${iconHtml('terminal')}<span>Ask AI Assistant</span>${iconHtml('arrowRight')}</div>
        <small>Focus the Agent Workstream on the left with a starter prompt.</small>
      `
      agentCard.onclick = () => quickActions?.onAskAgent()

      cards.append(writeCard, dataCard, agentCard)
    }
    wrap.appendChild(cards)

    const suggested = quickActions?.suggestedFiles ?? []
    if (workspaceId && suggested.length > 0) {
      const quickSection = document.createElement('div')
      quickSection.className = 'sw-quick-files'
      const heading = document.createElement('div')
      heading.className = 'aos-eyebrow'
      heading.textContent = 'QUICK OPEN WORKSPACE FILES'
      const list = document.createElement('div')
      list.className = 'sw-quick-list'
      for (const f of suggested) {
        const row = document.createElement('button')
        row.type = 'button'
        row.className = 'sw-quick-row'
        row.innerHTML = `<span>${iconHtml('fileDoc')}<code>${esc(f.path)}</code></span>${iconHtml('arrowRight')}`
        row.onclick = () => quickActions?.onSelectFile(f.path)
        list.appendChild(row)
      }
      quickSection.append(heading, list)
      wrap.appendChild(quickSection)
    }

    container.appendChild(wrap)
    return
  }

  const access = resolveFormatAccess(filePath, entitlements)
  if (access.mode === 'local_markdown' || access.mode === 'local_code') {
    await mountFreeMarkdownEditor({ container, bridge, workspaceId, filePath, onOpenDataView })
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
