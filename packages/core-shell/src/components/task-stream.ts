import { ROLE_CATALOG, selectAgentForRole, type AgentRole } from '../roles.ts'
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
  activeRepo?: string | null
  agents: DesktopAgentStatus[]
  activeFilePath: string | null
  workspaceFiles?: WorkspaceTreeEntry[]
  artifacts?: TaskArtifactRef[]
  attachedRefs?: string[]
  tasks?: DesktopTaskRecord[]
  onTaskUpdated?: (task: DesktopTaskRecord) => void
}

const ROLE_ICONS: Record<AgentRole, string> = {
  writer: '✍️',
  coder: '💻',
  analyst: '📊',
  reviewer: '✨',
}

export class TaskStreamController {
  private readonly opts: TaskStreamOptions
  private role: AgentRole = 'writer'
  private overrideAgentId = ''
  private attachedRefs: string[]
  private tasks: DesktopTaskRecord[]
  private disposed = false

  constructor(opts: TaskStreamOptions) {
    this.opts = opts
    this.tasks = opts.tasks ?? []
    this.attachedRefs = opts.attachedRefs ?? []
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
    const { container, agents, workspaceId, activeRepo, activeFilePath, workspaceFiles = [], artifacts = [] } =
      this.opts
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
      chip.textContent = `${ROLE_ICONS[r.id]} ${r.label}`
      chip.onclick = () => {
        this.role = r.id
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
      opt.textContent = `📎 ${art.title}`
      refPicker.appendChild(opt)
    }
    for (const entry of workspaceFiles) {
      if (entry.is_dir) continue
      const opt = document.createElement('option')
      opt.value = entry.path
      opt.textContent = `${entry.sync_mode === 'local_only' ? '💻 ' : ''}${entry.path}`
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
    textarea.className = 'aos-textarea'
    textarea.rows = 3
    const scopeHint = activeFilePath ?? activeRepo ?? 'current workspace'
    textarea.placeholder = workspaceId
      ? `Ask ${resolved.selectedAgentId ?? 'agent'} (${this.role}) on ${scopeHint}…`
      : 'Open a workspace first to run an isolated CoW task…'
    textarea.disabled = !workspaceId

    const submitRow = document.createElement('div')
    submitRow.className = 'aos-task-submit'
    const hint = document.createElement('small')
    hint.className = 'aos-muted'
    hint.textContent = resolved.fallbackReason ?? roleDesc

    const submitBtn = document.createElement('button')
    submitBtn.type = 'submit'
    submitBtn.className = 'aos-btn aos-btn-primary'
    submitBtn.textContent = 'Run Isolated Task'
    submitBtn.disabled = !workspaceId

    submitRow.append(hint, submitBtn)
    composer.append(roleChips, controls)
    if (effectiveRefs.size > 0) {
      composer.appendChild(refBar)
    }
    composer.append(textarea, submitRow)

    composer.onsubmit = async ev => {
      ev.preventDefault()
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
