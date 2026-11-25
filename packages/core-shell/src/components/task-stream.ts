import { ROLE_CATALOG, selectAgentForRole, type AgentRole } from '../roles.ts'
import type { AegisDaemonClient, DesktopAgentStatus, DesktopTaskRecord } from '../daemon-client.ts'

export interface TaskStreamOptions {
  container: HTMLElement
  client: AegisDaemonClient
  workspaceId: string | null
  activeRepo?: string | null
  agents: DesktopAgentStatus[]
  activeFilePath: string | null
  tasks?: DesktopTaskRecord[]
  onTaskUpdated?: (task: DesktopTaskRecord) => void
}

export class TaskStreamController {
  private readonly opts: TaskStreamOptions
  private role: AgentRole = 'coder'
  private overrideAgentId = ''
  private tasks: DesktopTaskRecord[]
  private disposed = false

  constructor(opts: TaskStreamOptions) {
    this.opts = opts
    this.tasks = opts.tasks ?? []
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

  render(): void {
    if (this.disposed) return
    const { container, agents, workspaceId, activeRepo, activeFilePath } = this.opts
    container.innerHTML = ''

    const composer = document.createElement('form')
    composer.className = 'aos-task-composer'

    const controls = document.createElement('div')
    controls.className = 'aos-task-controls'

    const roleSelect = document.createElement('select')
    roleSelect.className = 'aos-select'
    for (const r of ROLE_CATALOG) {
      const opt = document.createElement('option')
      opt.value = r.id
      opt.textContent = r.label
      opt.selected = r.id === this.role
      roleSelect.appendChild(opt)
    }
    roleSelect.onchange = () => {
      this.role = roleSelect.value as AgentRole
      this.render()
    }

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

    controls.append(roleSelect, agentSelect)

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
    hint.textContent = resolved.fallbackReason ?? 'Isolated CoW task stream ready.'

    const submitBtn = document.createElement('button')
    submitBtn.type = 'submit'
    submitBtn.className = 'aos-btn aos-btn-primary'
    submitBtn.textContent = 'Run Isolated Task'
    submitBtn.disabled = !workspaceId

    submitRow.append(hint, submitBtn)
    composer.append(controls, textarea, submitRow)

    composer.onsubmit = async ev => {
      ev.preventDefault()
      const prompt = textarea.value.trim()
      if (!prompt || !workspaceId) return
      textarea.value = ''
      submitBtn.disabled = true
      try {
        const created = await this.opts.client.startTask(workspaceId, {
          role: this.role,
          agent_override: this.overrideAgentId || null,
          repo: activeRepo ?? null,
          prompt,
          doc_refs: activeFilePath ? [activeFilePath] : [],
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
        stepsEl.appendChild(li)
      }
      card.append(head, promptEl, stepsEl)
      timeline.appendChild(card)
    }

    container.append(composer, timeline)
  }
}
