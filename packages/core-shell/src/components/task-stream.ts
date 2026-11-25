import { ROLE_CATALOG, selectAgentForRole, type AgentRole } from '../roles.ts'
import { brandMarkSvg, iconHtml, type IconName } from '../icons.ts'
import type {
  AegisDaemonClient,
  DesktopAgentStatus,
  DesktopTaskRecord,
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
  onRoleChanged?: (role: AgentRole) => void
  onTaskUpdated?: (task: DesktopTaskRecord) => void
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

export class TaskStreamController {
  private readonly opts: TaskStreamOptions
  private role: AgentRole
  private overrideAgentId = ''
  private attachedRefs: string[]
  private tasks: DesktopTaskRecord[]
  private disposed = false
  private textareaEl: HTMLTextAreaElement | null = null

  constructor(opts: TaskStreamOptions) {
    this.opts = opts
    this.role = opts.initialRole ?? 'coder'
    this.tasks = opts.tasks ?? []
    this.attachedRefs = opts.attachedRefs ?? []
  }

  setRole(role: AgentRole): void {
    this.role = role
    this.opts.onRoleChanged?.(role)
    this.render()
  }

  focusComposer(prefillPrompt?: string): void {
    if (!this.textareaEl) return
    if (prefillPrompt !== undefined) {
      this.textareaEl.value = prefillPrompt
    }
    this.textareaEl.focus()
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
  }

  private async pollTask(task: DesktopTaskRecord): Promise<void> {
    let cursor = task.steps.at(-1)?.seq ?? 0
    while (!this.disposed && (task.status === 'queued' || task.status === 'running')) {
      try {
        const res = await this.opts.client.pollTaskEvents(task.task_id, cursor, 1200)
        if (this.disposed) break
        if (res.events.length > 0) {
          task.steps.push(...res.events)
          cursor = res.next_after
        }
        task.status = res.status as DesktopTaskRecord['status']
        this.opts.onTaskUpdated?.(task)
        this.render()
        if (task.status === 'completed' || task.status === 'failed') break
      } catch {
        break
      }
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
      this.render()
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

    const roleDesc = ROLE_CATALOG.find(r => r.id === this.role)?.description ?? ''

    const textarea = document.createElement('textarea')
    this.textareaEl = textarea
    textarea.className = 'aos-textarea'
    textarea.rows = 4
    const scopeHint = activeFilePath ?? activeRepo ?? workspaceName ?? 'current workspace'
    textarea.placeholder = workspaceId
      ? `Ask ${resolved.selectedAgentId ?? 'agent'} (${this.role}) on ${scopeHint}… (Ctrl+Enter to run)`
      : 'Pick a workspace folder first to start working…'
    textarea.disabled = !workspaceId

    const submitRow = document.createElement('div')
    submitRow.className = 'aos-task-submit'
    const hint = document.createElement('small')
    hint.className = 'aos-muted'
    hint.textContent = resolved.fallbackReason ?? roleDesc

    const submitBtn = document.createElement('button')
    submitBtn.type = 'submit'
    submitBtn.className = 'aos-btn aos-btn-primary'
    submitBtn.innerHTML = `${iconHtml('arrowRight')}<span>Run Task</span>`
    submitBtn.disabled = !workspaceId

    const submitTask = async () => {
      const prompt = textarea.value.trim()
      if (!prompt || !workspaceId) return
      textarea.value = ''
      submitBtn.disabled = true
      const docRefs = [...effectiveRefs]
      try {
        const created = await this.opts.client.startTask(workspaceId, {
          role: this.role,
          agent_override: this.overrideAgentId || null,
          repo: activeRepo ?? null,
          prompt,
          doc_refs: docRefs,
        })
        this.tasks.unshift(created)
        this.render()
        void this.pollTask(created)
      } finally {
        submitBtn.disabled = false
      }
    }

    textarea.onkeydown = ev => {
      if ((ev.ctrlKey || ev.metaKey) && ev.key === 'Enter') {
        ev.preventDefault()
        void submitTask()
      }
    }

    submitRow.append(hint, submitBtn)
    composer.append(roleChips, controls)
    if (effectiveRefs.size > 0) {
      composer.appendChild(refBar)
    }
    composer.append(textarea, submitRow)

    composer.onsubmit = async ev => {
      ev.preventDefault()
      await submitTask()
    }

    if (workspaceId && this.tasks.length === 0) {
      const hero = document.createElement('div')
      hero.className = 'aos-workstream-hero'
      hero.innerHTML = `
        <div class="aos-workstream-kicker">
          ${brandMarkSvg()}
          <span class="aos-eyebrow">${workspaceName ?? 'WORKSPACE READY'}</span>
        </div>
        <h2 class="aos-serif-title">What are we working on?</h2>
        <p class="aos-muted">Type a prompt below like in the CLI, attach <code>@File</code> context from the tree, or open the Heurion Doc Canvas alongside.</p>
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

      container.append(hero, composer, starterGrid)

      if (onOpenCanvas) {
        const canvasRow = document.createElement('div')
        canvasRow.className = 'aos-canvas-hint-row'
        const canvasBtn = document.createElement('button')
        canvasBtn.type = 'button'
        canvasBtn.className = 'aos-btn aos-btn-sm'
        canvasBtn.innerHTML = `${iconHtml('layers')}<span>Need a visual workspace? Open Heurion Doc Canvas</span>${iconHtml('arrowRight')}`
        canvasBtn.onclick = onOpenCanvas
        canvasRow.appendChild(canvasBtn)
        container.appendChild(canvasRow)
      }
      return
    }

    const timeline = document.createElement('div')
    timeline.className = 'aos-task-timeline'
    for (const task of this.tasks) {
      const card = document.createElement('div')
      card.className = `aos-task-card status-${task.status}`
      const head = document.createElement('div')
      head.className = 'aos-task-head'
      const agentEl = document.createElement('strong')
      agentEl.textContent = task.resolved_agent
      const roleSpan = document.createElement('span')
      roleSpan.textContent = `[${task.role}]`
      const statusBadge = document.createElement('span')
      statusBadge.className = `aos-badge ${task.status === 'completed' ? 'ok' : task.status === 'failed' ? 'warn' : 'info'}`
      statusBadge.textContent = task.status
      head.append(agentEl, roleSpan, statusBadge)

      const promptEl = document.createElement('div')
      promptEl.className = 'aos-task-prompt'
      promptEl.textContent = task.prompt

      const stepsEl = document.createElement('ul')
      stepsEl.className = 'aos-task-steps'
      for (const s of task.steps) {
        const li = document.createElement('li')
        li.textContent = `[${s.kind}] ${s.summary}`
        if (s.detail) {
          const detailEl = document.createElement('div')
          detailEl.className = 'aos-muted'
          detailEl.textContent = s.detail
          li.appendChild(detailEl)
        }
        if (s.raw_log && s.raw_log.trim().length > 0) {
          const details = document.createElement('details')
          details.className = 'aos-raw-log'
          const summary = document.createElement('summary')
          summary.textContent = 'View execution details'
          const pre = document.createElement('pre')
          pre.textContent = s.raw_log
          details.append(summary, pre)
          li.appendChild(details)
        }
        stepsEl.appendChild(li)
      }
      card.append(head, promptEl, stepsEl)
      timeline.appendChild(card)
    }

    container.append(composer, timeline)
  }
}
