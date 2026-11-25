import { ROLE_CATALOG, selectAgentForRole, type AgentRole } from '../roles.ts'
import { brandMarkSvg, iconHtml, type IconName } from '../icons.ts'
import { escapeHtml, renderChatMarkdownHtml } from '../markdown.ts'
import type {
  AegisDaemonClient,
  DesktopAgentStatus,
  DesktopTaskRecord,
  DesktopTaskStep,
  WorkspaceTreeEntry,
} from '../daemon-client.ts'

export interface TaskArtifactRef {
  id: string
  title: string
  sourcePath?: string
}

export interface TaskStreamOptions {
  container: HTMLElement
  client: AegisDaemonClient
  workspaceId: string | null
  workspaceName?: string | null
  activeRepo?: string | null
  agents: DesktopAgentStatus[]
  activeFilePath: string | null
  workspaceFiles?: WorkspaceTreeEntry[]
  artifacts?: TaskArtifactRef[]
  attachedRefs?: string[]
  tasks?: DesktopTaskRecord[]
  initialRole?: AgentRole
  initialDraft?: string
  daemonOutdated?: boolean
  onDraftChanged?: (draft: string) => void
  onRoleChanged?: (role: AgentRole) => void
  onTaskUpdated?: (task: DesktopTaskRecord) => void
  onTaskSettled?: (task: DesktopTaskRecord) => void
  onClearTasks?: () => void
  onSendOutputToCanvas?: (task: DesktopTaskRecord, outputText: string) => void
  onRemoveAttachedRef?: (refPath: string) => void
  onOpenCanvas?: () => void
}

const ROLE_ICONS: Record<AgentRole, IconName> = {
  writer: 'pen',
  coder: 'terminal',
  analyst: 'chartBar',
  reviewer: 'sparkles',
}

interface StarterPromptItem {
  title: string
  prompt: string
}

const ROLE_STARTERS: Record<AgentRole, readonly StarterPromptItem[]> = {
  coder: [
    {
      title: 'Explore architecture',
      prompt: 'Summarize the architecture, key entrypoints, and build/test commands in this workspace.',
    },
    {
      title: 'Review & harden',
      prompt: 'Inspect recent changes or open modules for bugs, edge cases, and missing tests.',
    },
    {
      title: 'Implement feature',
      prompt: 'Add a focused improvement with unit tests inside the CoW sandbox and explain the diff.',
    },
  ],
  analyst: [
    {
      title: 'Profile dataset',
      prompt: 'Scan CSV/JSON datasets in this workspace and report key distributions, outliers, and missing values.',
    },
    {
      title: 'Compare cohorts',
      prompt: 'Analyze outcomes across groups in the dataset and summarize statistically notable differences.',
    },
    {
      title: 'Draft figure plan',
      prompt: 'Propose 2 concise summary tables and charts ready to embed into a report.',
    },
  ],
  writer: [
    {
      title: 'Draft document outline',
      prompt: 'Draft a clear executive outline and section plan based on the files in this workspace.',
    },
    {
      title: 'Polish & tighten prose',
      prompt: 'Edit the active document for clarity, active voice, and tighter structure while keeping key facts.',
    },
    {
      title: 'Executive summary',
      prompt: 'Write a concise 1-page briefing summarizing conclusions from the attached files and artifacts.',
    },
  ],
  reviewer: [
    {
      title: 'Security & boundary audit',
      prompt: 'Audit this workspace for unsafe assumptions, error handling gaps, and permission edge cases.',
    },
    {
      title: 'Pre-commit review',
      prompt: 'Review uncommitted changes and list high-priority fixes before landing.',
    },
    {
      title: 'Verify claims & numbers',
      prompt: 'Cross-check factual statements and metrics against attached source files.',
    },
  ],
}

const CONTEXT_PREFIX_RE = /^\[Workspace context files:\s*([^\]]+)\]\r?\n\r?\n([\s\S]*)$/

/**
 * Formats `@file` context references into the prompt payload so CLI agents run by
 * `aegis-os desktop-daemon` receive explicit file paths immediately.
 */
export function buildTaskPromptWithRefs(prompt: string, docRefs: string[]): string {
  const trimmed = prompt.trim()
  if (!trimmed || docRefs.length === 0) return trimmed
  const refsLine = docRefs.map(r => (r.startsWith('@') ? r : `@${r}`)).join(', ')
  return `[Workspace context files: ${refsLine}]\n\n${trimmed}`
}

export function parseTaskPromptDisplay(rawPrompt: string): { refs: string[]; body: string } {
  const m = rawPrompt.match(CONTEXT_PREFIX_RE)
  if (!m) {
    return { refs: [], body: rawPrompt }
  }
  const refs = m[1]!
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
  return { refs, body: m[2] ?? '' }
}

/**
 * Extracts live streamed chunks and final assistant output from a task so the Workstream
 * renders streaming text as it arrives and final answers visibly in Markdown.
 */
export function extractTaskPrimaryOutput(task: DesktopTaskRecord): {
  text: string
  streamingText: string
  isError: boolean
  traceSteps: DesktopTaskStep[]
} {
  let terminal: DesktopTaskStep | undefined
  for (let i = task.steps.length - 1; i >= 0; i--) {
    const step = task.steps[i]!
    if (step.kind === 'completed' || step.kind === 'failed') {
      terminal = step
      break
    }
  }
  const streamedChunks = task.steps
    .filter(s => s.kind === 'output' && Boolean(s.raw_log?.trim()))
    .map(s => s.raw_log!.trimEnd())
  const streamingText = streamedChunks.join('\n').trim()
  const text = terminal
    ? terminal.raw_log?.trim() || streamingText || terminal.detail?.trim() || ''
    : ''
  return {
    text,
    streamingText,
    isError: task.status === 'failed',
    traceSteps: task.steps,
  }
}

export class TaskStreamController {
  private readonly opts: TaskStreamOptions
  private role: AgentRole
  private overrideAgentId = ''
  private attachedRefs: string[]
  private tasks: DesktopTaskRecord[]
  private draftText: string
  private submitError = ''
  private disposed = false
  private textareaEl: HTMLTextAreaElement | null = null
  private timelineEl: HTMLElement | null = null
  private errorBannerEl: HTMLElement | null = null
  private activePolls = new Set<string>()

  constructor(opts: TaskStreamOptions) {
    this.opts = opts
    this.role = opts.initialRole ?? 'coder'
    this.tasks = opts.tasks ?? []
    this.attachedRefs = opts.attachedRefs ?? []
    this.draftText = opts.initialDraft ?? ''
  }

  setRole(role: AgentRole): void {
    this.role = role
    this.opts.onRoleChanged?.(role)
    this.render()
  }

  focusComposer(prefillPrompt?: string): void {
    if (prefillPrompt !== undefined) {
      this.draftText = prefillPrompt
      this.opts.onDraftChanged?.(prefillPrompt)
      if (this.textareaEl) {
        this.textareaEl.value = prefillPrompt
      }
    }
    this.textareaEl?.focus()
  }

  setAgents(agents: DesktopAgentStatus[]): void {
    this.opts.agents = agents
    this.render()
  }

  setWorkspace(workspaceId: string | null, activeFilePath: string | null, activeRepo: string | null = null): void {
    this.opts.workspaceId = workspaceId
    this.opts.activeFilePath = activeFilePath
    this.opts.activeRepo = activeRepo
    this.render()
  }

  dispose(): void {
    this.disposed = true
    this.activePolls.clear()
  }

  private async pollTask(task: DesktopTaskRecord): Promise<void> {
    if (this.activePolls.has(task.task_id)) return
    this.activePolls.add(task.task_id)

    let cursor = task.steps.at(-1)?.seq ?? 0
    let retries = 0

    try {
      while (!this.disposed && (task.status === 'queued' || task.status === 'running')) {
        try {
          const res = await this.opts.client.pollTaskEvents(task.task_id, cursor, 1200)
          retries = 0
          if (this.disposed) break

          let changed = false
          if (res.events.length > 0) {
            const seenSeqs = new Set(task.steps.map(s => s.seq))
            for (const ev of res.events) {
              if (!seenSeqs.has(ev.seq)) {
                task.steps.push(ev)
                changed = true
              }
            }
            cursor = res.next_after
          }
          if (task.status !== res.status) {
            task.status = res.status as DesktopTaskRecord['status']
            changed = true
          }
          if (changed) {
            this.opts.onTaskUpdated?.(task)
            this.renderTimelineOnly()
          }
          if (task.status === 'completed' || task.status === 'failed') {
            this.opts.onTaskSettled?.(task)
            break
          }
        } catch (err) {
          retries += 1
          if (retries < 3) {
            await new Promise(resolve => setTimeout(resolve, 600))
            continue
          }
          const nextSeq = (task.steps.at(-1)?.seq ?? 0) + 1
          task.status = 'failed'
          task.steps.push({
            seq: nextSeq,
            kind: 'failed',
            summary: 'Lost connection while polling task updates',
            detail: err instanceof Error ? err.message : String(err),
            raw_log: null,
            timestamp: new Date().toISOString(),
          })
          this.renderTimelineOnly()
          this.opts.onTaskSettled?.(task)
          break
        }
      }
    } finally {
      this.activePolls.delete(task.task_id)
    }
  }

  private addRef(refPath: string): void {
    const clean = refPath.trim()
    if (!clean || this.attachedRefs.includes(clean)) return
    this.attachedRefs.push(clean)
    this.render()
  }

  private removeRef(refPath: string): void {
    const idx = this.attachedRefs.indexOf(refPath)
    if (idx >= 0) {
      this.attachedRefs.splice(idx, 1)
      this.opts.onRemoveAttachedRef?.(refPath)
      this.render()
    }
  }

  private renderErrorBanner(): void {
    if (!this.errorBannerEl) return
    if (!this.submitError) {
      this.errorBannerEl.hidden = true
      this.errorBannerEl.textContent = ''
      return
    }
    this.errorBannerEl.hidden = false
    this.errorBannerEl.innerHTML = `${iconHtml('alertTriangle')}`
    const span = document.createElement('span')
    span.textContent = this.submitError
    this.errorBannerEl.appendChild(span)
  }

  private renderTimelineOnly(): void {
    const timeline = this.timelineEl
    if (!timeline || this.disposed) return

    const wasNearBottom =
      timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight < 80

    timeline.innerHTML = ''
    for (const task of this.tasks) {
      const turn = document.createElement('article')
      turn.className = `aos-task-turn status-${task.status}`

      const head = document.createElement('div')
      head.className = 'aos-task-head'

      const metaLeft = document.createElement('div')
      metaLeft.className = 'aos-task-meta'
      const roleKey = (ROLE_CATALOG.some(r => r.id === task.role) ? task.role : 'coder') as AgentRole
      metaLeft.innerHTML = iconHtml(ROLE_ICONS[roleKey])
      const agentEl = document.createElement('strong')
      agentEl.textContent = task.resolved_agent
      const roleSpan = document.createElement('span')
      roleSpan.className = 'aos-badge muted'
      roleSpan.textContent = task.role
      metaLeft.append(agentEl, roleSpan)

      const sessionStep = task.steps.find(s => s.kind === 'session_started')
      const sessionId =
        task.session_id ??
        sessionStep?.summary.match(/(ses_[A-Za-z0-9]+)/)?.[1] ??
        null
      if (task.enforcement || sessionId) {
        const enfBadge = document.createElement('span')
        enfBadge.className = 'aos-badge info'
        const labelParts = [task.enforcement ?? 'enforced']
        if (sessionId) labelParts.push(sessionId.slice(0, 12))
        enfBadge.innerHTML = `${iconHtml('shield')}<span>${escapeHtml(labelParts.join(' · '))}</span>`
        metaLeft.appendChild(enfBadge)
      }

      const statusBadge = document.createElement('span')
      const statusCls =
        task.status === 'completed' ? 'ok' : task.status === 'failed' ? 'warn' : 'info'
      statusBadge.className = `aos-badge ${statusCls}`
      if (task.status === 'queued' || task.status === 'running') {
        statusBadge.innerHTML = `<span class="aos-pulse-dot"></span><span>${escapeHtml(task.status)}</span>`
      } else {
        statusBadge.textContent = task.status
      }
      head.append(metaLeft, statusBadge)

      const parsedPrompt = parseTaskPromptDisplay(task.prompt)
      const promptBox = document.createElement('div')
      promptBox.className = 'aos-task-user-prompt'
      if (parsedPrompt.refs.length > 0) {
        const refList = document.createElement('div')
        refList.className = 'aos-ref-bar'
        for (const ref of parsedPrompt.refs) {
          const chip = document.createElement('span')
          chip.className = 'aos-ref-chip'
          chip.textContent = ref.startsWith('@') ? ref : `@${ref}`
          refList.appendChild(chip)
        }
        promptBox.appendChild(refList)
      }
      const promptText = document.createElement('div')
      promptText.className = 'aos-task-prompt-text'
      promptText.textContent = parsedPrompt.body
      promptBox.appendChild(promptText)

      const answerBox = document.createElement('div')
      answerBox.className = 'aos-task-answer'
      const output = extractTaskPrimaryOutput(task)

      if (task.status === 'queued' || task.status === 'running') {
        const latest = task.steps.at(-1)
        const liveRow = document.createElement('div')
        liveRow.className = 'aos-task-live-row'
        liveRow.innerHTML = `<span class="aos-pulse-dot"></span><span>${escapeHtml(latest?.summary ?? 'Running task in workspace…')}</span>`
        answerBox.appendChild(liveRow)

        if (this.opts.daemonOutdated && task.status === 'queued') {
          const warnEl = document.createElement('div')
          warnEl.className = 'aos-inline-hint-warn'
          warnEl.innerHTML = `${iconHtml('alertTriangle')}<span>Sidecar is older than v0.12.1 and keeps tasks queued. Upgrade aegis-os to run prompts live.</span>`
          answerBox.appendChild(warnEl)
        }

        if (output.streamingText) {
          const streamHost = document.createElement('div')
          streamHost.className = 'aos-task-markdown'
          streamHost.innerHTML = renderChatMarkdownHtml(output.streamingText)
          answerBox.appendChild(streamHost)
        }
      } else if (output.text) {
        const mdHost = document.createElement('div')
        mdHost.className = `aos-task-markdown ${output.isError ? 'is-error' : ''}`
        mdHost.innerHTML = renderChatMarkdownHtml(output.text)
        answerBox.appendChild(mdHost)
      } else if (task.status === 'failed') {
        const latest = task.steps.at(-1)
        const errP = document.createElement('div')
        errP.className = 'aos-task-markdown is-error'
        errP.textContent = latest?.detail || latest?.summary || 'Task failed without output.'
        answerBox.appendChild(errP)
      }

      turn.append(head, promptBox)
      if (answerBox.childElementCount > 0) {
        turn.appendChild(answerBox)
      }

      if (output.traceSteps.length > 0) {
        const details = document.createElement('details')
        details.className = 'aos-task-trace'
        if (task.status === 'failed' && !output.text) {
          details.open = true
        }
        const summary = document.createElement('summary')
        summary.textContent = `Execution trace (${output.traceSteps.length} step${output.traceSteps.length === 1 ? '' : 's'})`
        details.appendChild(summary)

        const stepsEl = document.createElement('ul')
        stepsEl.className = 'aos-task-steps'
        for (const s of output.traceSteps) {
          const li = document.createElement('li')
          const lineHead = document.createElement('div')
          lineHead.textContent = `[${s.kind}] ${s.summary}`
          li.appendChild(lineHead)
          if (s.detail && s.detail.trim() !== output.text) {
            const detailEl = document.createElement('div')
            detailEl.className = 'aos-muted'
            detailEl.textContent = s.detail
            li.appendChild(detailEl)
          }
          if (
            s.raw_log &&
            s.raw_log.trim().length > 0 &&
            s.raw_log.trim() !== output.text &&
            s.kind !== 'output'
          ) {
            const pre = document.createElement('pre')
            pre.textContent = s.raw_log
            li.appendChild(pre)
          }
          stepsEl.appendChild(li)
        }
        details.appendChild(stepsEl)
        turn.appendChild(details)
      }

      if (task.status === 'completed' || task.status === 'failed') {
        const actionRow = document.createElement('div')
        actionRow.className = 'aos-task-actions'

        const copyTarget = output.text || parsedPrompt.body
        const copyBtn = document.createElement('button')
        copyBtn.type = 'button'
        copyBtn.className = 'aos-btn aos-btn-sm'
        copyBtn.innerHTML = `${iconHtml('copy')}<span>Copy</span>`
        copyBtn.onclick = () => {
          void navigator.clipboard?.writeText(copyTarget).then(() => {
            copyBtn.innerHTML = `${iconHtml('check')}<span>Copied</span>`
            setTimeout(() => {
              if (!this.disposed) {
                copyBtn.innerHTML = `${iconHtml('copy')}<span>Copy</span>`
              }
            }, 1500)
          })
        }
        actionRow.appendChild(copyBtn)

        if (output.text && this.opts.onSendOutputToCanvas) {
          const canvasBtn = document.createElement('button')
          canvasBtn.type = 'button'
          canvasBtn.className = 'aos-btn aos-btn-sm'
          canvasBtn.innerHTML = `${iconHtml('layers')}<span>Open in Canvas</span>`
          canvasBtn.title = 'Save response as Markdown and open in Heurion Doc Canvas'
          canvasBtn.onclick = () => {
            this.opts.onSendOutputToCanvas?.(task, output.text)
          }
          actionRow.appendChild(canvasBtn)
        }

        const rerunBtn = document.createElement('button')
        rerunBtn.type = 'button'
        rerunBtn.className = 'aos-btn aos-btn-sm'
        rerunBtn.innerHTML = `${iconHtml('play')}<span>Re-run</span>`
        rerunBtn.onclick = () => {
          this.focusComposer(parsedPrompt.body)
        }
        actionRow.appendChild(rerunBtn)

        turn.appendChild(actionRow)
      }

      timeline.appendChild(turn)
    }

    if (wasNearBottom) {
      timeline.scrollTop = timeline.scrollHeight
    }
  }

  render(): void {
    if (this.disposed) return
    const {
      container,
      agents,
      workspaceId,
      workspaceName,
      activeRepo,
      activeFilePath,
      workspaceFiles = [],
      artifacts = [],
      onOpenCanvas,
    } = this.opts
    container.innerHTML = ''
    this.timelineEl = null

    const composer = document.createElement('form')
    composer.className = 'aos-task-composer'

    const roleChips = document.createElement('div')
    roleChips.className = 'aos-role-chips'
    for (const r of ROLE_CATALOG) {
      const chip = document.createElement('button')
      chip.type = 'button'
      chip.className = `aos-role-chip ${r.id === this.role ? 'is-active' : ''}`
      chip.title = r.description
      chip.innerHTML = `${iconHtml(ROLE_ICONS[r.id])}<span>${r.label}</span>`
      chip.onclick = () => {
        this.role = r.id
        this.opts.onRoleChanged?.(r.id)
        this.render()
      }
      roleChips.appendChild(chip)
    }

    const controls = document.createElement('div')
    controls.className = 'aos-task-controls'

    const agentSelect = document.createElement('select')
    agentSelect.className = 'aos-select'
    const autoOpt = document.createElement('option')
    autoOpt.value = ''
    const resolved = selectAgentForRole(this.role, agents)
    autoOpt.textContent = `Auto (${resolved.selectedAgentId ?? 'none'})`
    agentSelect.appendChild(autoOpt)
    for (const a of agents) {
      const opt = document.createElement('option')
      opt.value = a.id
      opt.textContent = `${a.display_name}${a.installed ? '' : ' (not installed)'}`
      opt.selected = this.overrideAgentId === a.id
      agentSelect.appendChild(opt)
    }
    agentSelect.onchange = () => {
      this.overrideAgentId = agentSelect.value
    }

    const refPicker = document.createElement('select')
    refPicker.className = 'aos-select'
    refPicker.disabled = !workspaceId
    const refDefault = document.createElement('option')
    refDefault.value = ''
    refDefault.textContent = '+ @File / @Artifact'
    refPicker.appendChild(refDefault)

    for (const art of artifacts) {
      const opt = document.createElement('option')
      opt.value = art.sourcePath ? art.sourcePath : `artifact:${art.id}`
      opt.textContent = `[Artifact] ${art.title}`
      refPicker.appendChild(opt)
    }
    for (const entry of workspaceFiles) {
      if (entry.is_dir) continue
      const opt = document.createElement('option')
      opt.value = entry.path
      opt.textContent = `${entry.sync_mode === 'local_only' ? '[Local] ' : ''}${entry.path}`
      refPicker.appendChild(opt)
    }
    refPicker.onchange = () => {
      if (refPicker.value) {
        this.addRef(refPicker.value)
      }
    }

    controls.append(agentSelect, refPicker)

    const refBar = document.createElement('div')
    refBar.className = 'aos-ref-bar'
    const effectiveRefs = new Set<string>(this.attachedRefs)
    if (activeFilePath) effectiveRefs.add(activeFilePath)

    if (effectiveRefs.size > 0) {
      for (const refPath of effectiveRefs) {
        const chip = document.createElement('span')
        chip.className = 'aos-ref-chip'
        chip.textContent = `@${refPath}`
        if (this.attachedRefs.includes(refPath)) {
          const rm = document.createElement('button')
          rm.type = 'button'
          rm.textContent = '×'
          rm.title = `Remove ${refPath}`
          rm.onclick = () => this.removeRef(refPath)
          chip.appendChild(rm)
        }
        refBar.appendChild(chip)
      }
    }

    const errorBanner = document.createElement('div')
    errorBanner.className = 'aos-wizard-feedback error'
    this.errorBannerEl = errorBanner
    this.renderErrorBanner()

    const roleDesc = ROLE_CATALOG.find(r => r.id === this.role)?.description ?? ''

    const textarea = document.createElement('textarea')
    this.textareaEl = textarea
    textarea.className = 'aos-textarea'
    textarea.rows = this.tasks.length > 0 ? 3 : 4
    textarea.value = this.draftText
    const scopeHint = activeFilePath ?? activeRepo ?? workspaceName ?? 'current workspace'
    textarea.placeholder = workspaceId
      ? `Ask ${resolved.selectedAgentId ?? 'agent'} (${this.role}) on ${scopeHint}… (Enter to run, Shift+Enter for newline)`
      : 'Pick a workspace folder first to start working…'
    textarea.disabled = !workspaceId
    textarea.oninput = () => {
      this.draftText = textarea.value
      this.opts.onDraftChanged?.(this.draftText)
    }

    const submitRow = document.createElement('div')
    submitRow.className = 'aos-task-submit'
    const hint = document.createElement('small')
    hint.className = 'aos-muted'
    hint.textContent = resolved.fallbackReason ?? `${roleDesc} · Enter to run, Shift+Enter newline`

    const submitBtn = document.createElement('button')
    submitBtn.type = 'submit'
    submitBtn.className = 'aos-btn aos-btn-primary'
    submitBtn.innerHTML = `${iconHtml('arrowRight')}<span>Run Task</span>`
    submitBtn.disabled = !workspaceId

    const submitTask = async () => {
      const rawPrompt = textarea.value.trim()
      if (!rawPrompt || !workspaceId) return
      this.submitError = ''
      this.renderErrorBanner()
      submitBtn.disabled = true
      const docRefs = [...effectiveRefs]
      const fullPrompt = buildTaskPromptWithRefs(rawPrompt, docRefs)
      try {
        const created = await this.opts.client.startTask(workspaceId, {
          role: this.role,
          agent_override: this.overrideAgentId || null,
          repo: activeRepo ?? null,
          prompt: fullPrompt,
          doc_refs: docRefs,
        })
        this.draftText = ''
        this.opts.onDraftChanged?.('')
        textarea.value = ''
        this.tasks.push(created)
        this.render()
        void this.pollTask(created)
      } catch (err) {
        this.submitError = err instanceof Error ? err.message : String(err)
        this.renderErrorBanner()
      } finally {
        submitBtn.disabled = false
      }
    }

    textarea.onkeydown = ev => {
      if (
        ((ev.ctrlKey || ev.metaKey) && ev.key === 'Enter') ||
        (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing)
      ) {
        ev.preventDefault()
        void submitTask()
      }
    }

    submitRow.append(hint, submitBtn)
    composer.append(roleChips, controls)
    if (effectiveRefs.size > 0) {
      composer.appendChild(refBar)
    }
    composer.append(errorBanner, textarea, submitRow)

    composer.onsubmit = async ev => {
      ev.preventDefault()
      await submitTask()
    }

    if (this.tasks.length === 0) {
      const welcome = document.createElement('div')
      welcome.className = 'aos-workstream-welcome'

      const hero = document.createElement('div')
      hero.className = 'aos-workstream-hero'
      hero.innerHTML = `
        <div class="aos-workstream-kicker">
          ${brandMarkSvg()}
          <span class="aos-eyebrow">${escapeHtml(workspaceName ?? 'WORKSPACE READY')}</span>
        </div>
        <h2 class="aos-serif-title">What are we working on?</h2>
        <p class="aos-muted">Type a prompt below just like in Aegis CLI, attach <code>@File</code> context from the sidebar, or open the Heurion Doc Canvas alongside.</p>
      `

      const starterGrid = document.createElement('div')
      starterGrid.className = 'aos-starter-grid'
      for (const item of ROLE_STARTERS[this.role]) {
        const btn = document.createElement('button')
        btn.type = 'button'
        btn.className = 'aos-starter-card'
        btn.innerHTML = `<strong>${item.title}</strong><small>${item.prompt}</small>`
        btn.onclick = () => {
          this.focusComposer(item.prompt)
        }
        starterGrid.appendChild(btn)
      }

      welcome.append(hero, composer, starterGrid)

      if (onOpenCanvas) {
        const canvasRow = document.createElement('div')
        canvasRow.className = 'aos-canvas-hint-row'
        const canvasBtn = document.createElement('button')
        canvasBtn.type = 'button'
        canvasBtn.className = 'aos-btn aos-btn-sm'
        canvasBtn.innerHTML = `${iconHtml('layers')}<span>Need a visual workspace? Open Heurion Doc Canvas</span>${iconHtml('arrowRight')}`
        canvasBtn.onclick = onOpenCanvas
        canvasRow.appendChild(canvasBtn)
        welcome.appendChild(canvasRow)
      }

      container.appendChild(welcome)
      return
    }

    const chatWrap = document.createElement('div')
    chatWrap.className = 'aos-workstream-chat'

    const sessionBar = document.createElement('div')
    sessionBar.className = 'aos-session-bar'
    const turnCount = document.createElement('span')
    turnCount.className = 'aos-muted'
    const activeCount = this.tasks.filter(t => t.status === 'queued' || t.status === 'running').length
    turnCount.textContent =
      activeCount > 0
        ? `${this.tasks.length} turn(s) · ${activeCount} running`
        : `${this.tasks.length} turn(s)`

    const sessionActions = document.createElement('div')
    sessionActions.className = 'sw-toolbar-actions'
    if (onOpenCanvas) {
      const openCanvasBtn = document.createElement('button')
      openCanvasBtn.type = 'button'
      openCanvasBtn.className = 'aos-btn aos-btn-sm'
      openCanvasBtn.innerHTML = `${iconHtml('layers')}<span>Canvas</span>`
      openCanvasBtn.onclick = onOpenCanvas
      sessionActions.appendChild(openCanvasBtn)
    }
    const clearBtn = document.createElement('button')
    clearBtn.type = 'button'
    clearBtn.className = 'aos-btn aos-btn-sm'
    clearBtn.innerHTML = `${iconHtml('trash')}<span>New Session</span>`
    clearBtn.onclick = () => {
      this.tasks.length = 0
      this.submitError = ''
      this.opts.onClearTasks?.()
      this.render()
    }
    sessionActions.appendChild(clearBtn)
    sessionBar.append(turnCount, sessionActions)

    const timeline = document.createElement('div')
    timeline.className = 'aos-task-timeline-scroll'
    this.timelineEl = timeline
    this.renderTimelineOnly()

    const composerDock = document.createElement('div')
    composerDock.className = 'aos-composer-dock'
    composerDock.appendChild(composer)

    chatWrap.append(sessionBar, timeline, composerDock)
    container.appendChild(chatWrap)

    for (const task of this.tasks) {
      if (task.status === 'queued' || task.status === 'running') {
        void this.pollTask(task)
      }
    }
  }
}
