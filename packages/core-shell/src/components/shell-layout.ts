import { renderAgentOnboarding } from './agent-onboarding.ts'
import { renderApprovalPanel } from './approval-modal.ts'
import { TaskStreamController, type TaskArtifactRef } from './task-stream.ts'
import { renderWorkspaceTree, upsertSyncRule } from './workspace-tree.ts'
import {
  applySyncModeFilter,
  type AegisDaemonClient,
  type DesktopAgentStatus,
  type DesktopTaskRecord,
  type DesktopWorkspace,
  type McpInventoryEntry,
  type PendingEscalation,
  type WorkspaceTreeEntry,
} from '../daemon-client.ts'
import { DEFAULT_FREE_ENTITLEMENTS, resolveFormatAccess, type DesktopEntitlements } from '../entitlements.ts'

export type ShellSurfaceMode = 'workbench' | 'studio'

export interface StudioMountContext {
  container: HTMLElement
  workspace: DesktopWorkspace | null
  activeRepo: string | null
  file: WorkspaceTreeEntry | null
  entitlements: DesktopEntitlements
  onRequestUpgrade: (reason: string) => void
}

export interface CoreShellOptions {
  root: HTMLElement
  client: AegisDaemonClient
  entitlements?: DesktopEntitlements
  approvalPollIntervalMs?: number
  renderStudio?: (ctx: StudioMountContext) => void
  onOpenWorkspacePrompt?: () => Promise<string | null>
  onRequestUpgrade?: (reason: string) => void
  onNewEscalation?: (esc: PendingEscalation) => void
  listArtifacts?: (workspaceId: string) => Promise<TaskArtifactRef[]>
}

export class AegisCoreShell {
  private readonly opts: CoreShellOptions
  private entitlements: DesktopEntitlements
  private mode: ShellSurfaceMode = 'studio'
  private agents: DesktopAgentStatus[] = []
  private workspaces: DesktopWorkspace[] = []
  private activeWorkspace: DesktopWorkspace | null = null
  private activeRepo: string | null = null
  private rawTreeEntries: WorkspaceTreeEntry[] = []
  private treeEntries: WorkspaceTreeEntry[] = []
  private workspaceArtifacts: TaskArtifactRef[] = []
  private attachedTaskRefs: string[] = []
  private selectedFile: WorkspaceTreeEntry | null = null
  private collapsedDirs = new Set<string>()
  private treeSearchQuery = ''
  private sandboxHealthy = false
  private sandboxDriver = 'checking'
  private escalations: PendingEscalation[] = []
  private knownEscalationIds = new Set<string>()
  private mcpEntries: McpInventoryEntry[] = []
  private taskHistory: DesktopTaskRecord[] = []
  private taskController: TaskStreamController | null = null
  private approvalPollTimer: number | null = null
  private treeContainerEl: HTMLElement | null = null
  private approvalsContainerEl: HTMLElement | null = null
  private approvalBellEl: HTMLButtonElement | null = null

  constructor(opts: CoreShellOptions) {
    this.opts = opts
    this.entitlements = opts.entitlements ?? DEFAULT_FREE_ENTITLEMENTS
  }

  getActiveRepo(): string | null {
    return this.activeRepo
  }

  setEntitlements(entitlements: DesktopEntitlements): void {
    this.entitlements = entitlements
    this.treeEntries = applySyncModeFilter(this.rawTreeEntries, this.entitlements)
    this.render()
  }

  dispose(): void {
    if (this.approvalPollTimer !== null && typeof window !== 'undefined') {
      window.clearInterval(this.approvalPollTimer)
      this.approvalPollTimer = null
    }
    this.taskController?.dispose()
    this.taskController = null
  }

  startLivePolling(): void {
    const intervalMs = this.opts.approvalPollIntervalMs ?? 5000
    if (intervalMs <= 0 || typeof window === 'undefined' || this.approvalPollTimer !== null) return
    this.approvalPollTimer = window.setInterval(() => {
      void this.pollApprovalsInBackground()
    }, intervalMs)
  }

  private syncEscalationState(next: PendingEscalation[], notifyNew: boolean): boolean {
    const prevIds = this.escalations.map(e => e.escalation_id).join(',')
    const nextIds = next.map(e => e.escalation_id).join(',')
    if (notifyNew) {
      for (const esc of next) {
        if (!this.knownEscalationIds.has(esc.escalation_id)) {
          this.opts.onNewEscalation?.(esc)
        }
      }
    }
    for (const esc of next) {
      this.knownEscalationIds.add(esc.escalation_id)
    }
    this.escalations = next
    return prevIds !== nextIds
  }

  private async pollApprovalsInBackground(): Promise<void> {
    const approvals = await this.opts.client.listApprovals().catch(() => null)
    if (!approvals) return
    const changed = this.syncEscalationState(approvals.escalations, true)
    if (changed) {
      this.renderApprovalsAndBell()
    }
  }

  private renderApprovalsAndBell(): void {
    if (this.approvalBellEl) {
      this.approvalBellEl.className = `aos-badge aos-bell-badge ${this.escalations.length > 0 ? 'warn has-pending' : 'muted'}`
      this.approvalBellEl.textContent = `🔔 Approvals (${this.escalations.length})`
    }
    if (this.approvalsContainerEl) {
      renderApprovalPanel({
        container: this.approvalsContainerEl,
        escalations: this.escalations,
        client: this.opts.client,
        onDecided: () => this.refreshApprovals(),
      })
    }
  }

  async refresh(): Promise<void> {
    const [sandbox, agents, workspaces, approvals, inventory] = await Promise.all([
      this.opts.client.sandboxHealth().catch(() => null),
      this.opts.client.listAgents().catch(() => []),
      this.opts.client.listWorkspaces().catch(() => []),
      this.opts.client.listApprovals().catch(() => ({ escalations: [] })),
      this.opts.client.mcpInventory().catch(() => ({ entries: [] })),
    ])
    if (sandbox) {
      this.sandboxHealthy = sandbox.ready
      this.sandboxDriver = sandbox.driver
    }
    this.agents = agents
    this.workspaces = workspaces
    this.syncEscalationState(approvals.escalations, false)
    this.mcpEntries = inventory.entries
    if (this.activeWorkspace) {
      const updated = workspaces.find(w => w.id === this.activeWorkspace?.id)
      if (updated) this.activeWorkspace = updated
    }
    this.startLivePolling()
    if (!this.activeWorkspace && workspaces.length > 0) {
      await this.selectWorkspace(workspaces[0]!)
      return
    }
    if (this.activeWorkspace) {
      await this.reloadTree()
    } else {
      this.render()
    }
  }

  async selectWorkspace(workspace: DesktopWorkspace): Promise<void> {
    this.activeWorkspace = workspace
    this.activeRepo = null
    this.selectedFile = null
    this.collapsedDirs.clear()
    this.attachedTaskRefs = []
    await this.reloadArtifactsOnly()
    await this.reloadTree()
  }

  async refreshArtifacts(): Promise<void> {
    await this.reloadArtifactsOnly()
    this.render()
  }

  private async reloadArtifactsOnly(): Promise<void> {
    if (!this.activeWorkspace || !this.opts.listArtifacts) {
      this.workspaceArtifacts = []
      return
    }
    this.workspaceArtifacts = await this.opts.listArtifacts(this.activeWorkspace.id).catch(() => [])
  }

  async selectRepo(repoRelPath: string | null): Promise<void> {
    this.activeRepo = repoRelPath && repoRelPath.trim() ? repoRelPath : null
    if (
      this.activeRepo &&
      this.selectedFile &&
      !this.selectedFile.path.startsWith(`${this.activeRepo}/`)
    ) {
      this.selectedFile = null
    }
    await this.reloadTree()
  }

  private async refreshApprovals(): Promise<void> {
    const approvals = await this.opts.client.listApprovals().catch(() => ({ escalations: [] }))
    this.syncEscalationState(approvals.escalations, false)
    this.renderApprovalsAndBell()
  }

  private async reloadTree(): Promise<void> {
    if (!this.activeWorkspace) return
    const tree = await this.opts.client.workspaceTree(this.activeWorkspace.id, this.activeRepo)
    this.rawTreeEntries = tree.entries
    this.treeEntries = applySyncModeFilter(tree.entries, this.entitlements)
    await this.reloadArtifactsOnly()
    this.render()
  }

  private renderTreeOnly(): void {
    if (!this.treeContainerEl) return
    const active = typeof document !== 'undefined' ? document.activeElement : null
    const wasSearchFocused =
      active instanceof HTMLInputElement && active.classList.contains('aos-tree-search')
    const selStart = wasSearchFocused ? active.selectionStart : null
    const selEnd = wasSearchFocused ? active.selectionEnd : null

    renderWorkspaceTree({
      container: this.treeContainerEl,
      entries: this.treeEntries,
      syncPolicy: this.activeWorkspace?.sync_policy ?? { default_mode: 'local_only', rules: [] },
      entitlements: this.entitlements,
      selectedPath: this.selectedFile?.path ?? null,
      collapsedDirs: this.collapsedDirs,
      searchQuery: this.treeSearchQuery,
      onSearchChange: query => {
        this.treeSearchQuery = query
        this.renderTreeOnly()
      },
      onToggleDir: dirPath => {
        if (this.collapsedDirs.has(dirPath)) {
          this.collapsedDirs.delete(dirPath)
        } else {
          this.collapsedDirs.add(dirPath)
        }
        this.renderTreeOnly()
      },
      onSelectFile: entry => {
        const decision = resolveFormatAccess(entry.name, this.entitlements)
        this.selectedFile = entry
        if (!decision.allowed) {
          this.opts.onRequestUpgrade?.(decision.reason ?? 'Requires Cloud Pro')
        }
        this.mode = 'studio'
        this.render()
      },
      onCreateFile: async rawPath => {
        if (!this.activeWorkspace) return
        const clean = rawPath.replace(/^\/+/, '').replace(/^\.\//, '')
        const relPath =
          this.activeRepo && !clean.startsWith(`${this.activeRepo}/`)
            ? `${this.activeRepo}/${clean}`
            : clean
        await this.opts.client.writeWorkspaceFile(this.activeWorkspace.id, relPath, '')
        await this.reloadTree()
        const createdEntry = this.treeEntries.find(e => !e.is_dir && e.path === relPath)
        if (createdEntry) {
          this.selectedFile = createdEntry
          this.mode = 'studio'
          this.render()
        }
      },
      onToggleDefaultSync: async mode => {
        if (!this.activeWorkspace) return
        const updated = await this.opts.client.updateSyncPolicy(this.activeWorkspace.id, {
          default_mode: mode,
          rules: this.activeWorkspace.sync_policy.rules,
        })
        this.activeWorkspace.sync_policy = updated
        await this.reloadTree()
      },
      onSetFolderSyncRule: async (dirPath, mode) => {
        if (!this.activeWorkspace) return
        const nextPolicy = upsertSyncRule(this.activeWorkspace.sync_policy, dirPath, mode)
        const updated = await this.opts.client.updateSyncPolicy(this.activeWorkspace.id, nextPolicy)
        this.activeWorkspace.sync_policy = updated
        await this.reloadTree()
      },
    })

    if (wasSearchFocused && this.treeContainerEl) {
      const nextInput = this.treeContainerEl.querySelector<HTMLInputElement>('.aos-tree-search')
      if (nextInput) {
        nextInput.focus()
        if (selStart !== null && selEnd !== null) {
          nextInput.setSelectionRange(selStart, selEnd)
        }
      }
    }
  }

  render(): void {
    const { root } = this.opts
    this.taskController?.dispose()
    this.taskController = null
    root.innerHTML = ''

    const shell = document.createElement('div')
    shell.className = 'aos-shell'

    // Top bar (Org / Workspace / Child Repo)
    const topbar = document.createElement('header')
    topbar.className = 'aos-topbar'

    const brand = document.createElement('div')
    brand.className = 'aos-brand'
    brand.innerHTML = '<strong>Aegis Desktop</strong>'

    const orgBadge = document.createElement('span')
    orgBadge.className = 'aos-badge info aos-org-badge'
    orgBadge.textContent = `org: ${this.activeWorkspace?.org_id ?? 'personal'}`
    orgBadge.title = '3-layer model: Org / Workspace / Repo'

    const wsPicker = document.createElement('select')
    wsPicker.className = 'aos-select'
    const emptyOpt = document.createElement('option')
    emptyOpt.value = ''
    emptyOpt.textContent = this.workspaces.length ? 'Select workspace…' : 'No workspace opened'
    wsPicker.appendChild(emptyOpt)
    for (const ws of this.workspaces) {
      const opt = document.createElement('option')
      opt.value = ws.id
      opt.textContent = ws.name
      opt.selected = this.activeWorkspace?.id === ws.id
      wsPicker.appendChild(opt)
    }
    wsPicker.onchange = () => {
      const found = this.workspaces.find(w => w.id === wsPicker.value)
      if (found) void this.selectWorkspace(found)
    }

    const openBtn = document.createElement('button')
    openBtn.type = 'button'
    openBtn.className = 'aos-btn aos-btn-sm'
    openBtn.textContent = '+ Workspace'
    openBtn.onclick = async () => {
      const path = (await this.opts.onOpenWorkspacePrompt?.()) ?? window.prompt('Workspace directory path:')
      if (!path) return
      const created = await this.opts.client.openWorkspace({
        path,
        mode: this.entitlements.cloud_yjs_sync ? 'cloud' : 'local',
      })
      await this.refresh()
      await this.selectWorkspace(created)
    }

    topbar.append(brand, orgBadge, wsPicker)

    const childRepos = this.activeWorkspace?.child_repos ?? []
    if (childRepos.length > 0) {
      const repoPicker = document.createElement('select')
      repoPicker.className = 'aos-select aos-repo-select'
      repoPicker.title = 'Scope files, diff, commit/rollback, and agent tasks to a child git repo'
      const allOpt = document.createElement('option')
      allOpt.value = ''
      allOpt.textContent = 'All workspace repos'
      allOpt.selected = !this.activeRepo
      repoPicker.appendChild(allOpt)

      for (const repo of childRepos) {
        const opt = document.createElement('option')
        opt.value = repo.rel_path
        opt.textContent = repo.branch ? `${repo.name} (${repo.branch})` : repo.name
        opt.selected = this.activeRepo === repo.rel_path
        repoPicker.appendChild(opt)
      }
      repoPicker.onchange = () => {
        void this.selectRepo(repoPicker.value || null)
      }
      topbar.appendChild(repoPicker)
    }

    const modeGroup = document.createElement('div')
    modeGroup.className = 'aos-segmented'
    for (const m of ['studio', 'workbench'] as ShellSurfaceMode[]) {
      const b = document.createElement('button')
      b.type = 'button'
      b.className = `aos-seg-btn ${this.mode === m ? 'is-active' : ''}`
      b.textContent = m === 'studio' ? 'Studio' : 'Tasks'
      b.onclick = () => {
        this.mode = m
        this.render()
      }
      modeGroup.appendChild(b)
    }

    const refreshBtn = document.createElement('button')
    refreshBtn.type = 'button'
    refreshBtn.className = 'aos-btn aos-btn-sm'
    refreshBtn.textContent = '↻ Refresh'
    refreshBtn.onclick = () => {
      refreshBtn.disabled = true
      void this.refresh().finally(() => {
        refreshBtn.disabled = false
      })
    }

    const statusRight = document.createElement('div')
    statusRight.className = 'aos-topbar-right'

    const approvalBell = document.createElement('button')
    approvalBell.type = 'button'
    this.approvalBellEl = approvalBell
    approvalBell.onclick = () => {
      this.approvalsContainerEl?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    }

    const sandboxPill = document.createElement('span')
    sandboxPill.className = `aos-badge ${this.sandboxHealthy ? 'ok' : 'warn'}`
    sandboxPill.textContent = `Sandbox: ${this.sandboxDriver}`

    const tierBtn = document.createElement('button')
    tierBtn.type = 'button'
    tierBtn.className = `aos-badge ${this.entitlements.dual_surface_crdt ? 'info' : 'muted'}`
    tierBtn.textContent = this.entitlements.dual_surface_crdt
      ? `Cloud ${this.entitlements.tier.toUpperCase()}`
      : 'Free Local (.md + Code)'
    tierBtn.onclick = () => {
      this.opts.onRequestUpgrade?.(
        'Upgrade to Cloud Pro to unlock Dual-Surface CRDT (.docx/.pptx/.pdf/.tex) and Yjs cloud sync.',
      )
    }

    statusRight.append(approvalBell, sandboxPill, tierBtn)
    topbar.append(openBtn, modeGroup, refreshBtn, statusRight)

    // Three-column body
    const main = document.createElement('div')
    main.className = 'aos-main-grid'

    const left = document.createElement('aside')
    left.className = 'aos-sidebar-left'
    const treeContainer = document.createElement('div')
    this.treeContainerEl = treeContainer
    const agentsContainer = document.createElement('div')
    left.append(treeContainer, agentsContainer)

    this.renderTreeOnly()

    renderAgentOnboarding({
      container: agentsContainer,
      client: this.opts.client,
      agents: this.agents,
      onAgentsChanged: agents => {
        this.agents = agents
        this.render()
      },
    })

    const center = document.createElement('section')
    center.className = 'aos-center-stage'
    if (this.mode === 'studio' && this.opts.renderStudio) {
      this.opts.renderStudio({
        container: center,
        workspace: this.activeWorkspace,
        activeRepo: this.activeRepo,
        file: this.selectedFile,
        entitlements: this.entitlements,
        onRequestUpgrade: reason => this.opts.onRequestUpgrade?.(reason),
      })
    } else {
      this.taskController = new TaskStreamController({
        container: center,
        client: this.opts.client,
        workspaceId: this.activeWorkspace?.id ?? null,
        activeRepo: this.activeRepo,
        agents: this.agents,
        activeFilePath: this.selectedFile?.path ?? null,
        workspaceFiles: this.treeEntries,
        artifacts: this.workspaceArtifacts,
        attachedRefs: this.attachedTaskRefs,
        tasks: this.taskHistory,
      })
      this.taskController.render()
    }

    const right = document.createElement('aside')
    right.className = 'aos-sidebar-right'
    const approvalsEl = document.createElement('div')
    this.approvalsContainerEl = approvalsEl
    this.renderApprovalsAndBell()

    const tasksPreview = document.createElement('div')
    if (this.mode === 'studio') {
      this.taskController = new TaskStreamController({
        container: tasksPreview,
        client: this.opts.client,
        workspaceId: this.activeWorkspace?.id ?? null,
        activeRepo: this.activeRepo,
        agents: this.agents,
        activeFilePath: this.selectedFile?.path ?? null,
        workspaceFiles: this.treeEntries,
        artifacts: this.workspaceArtifacts,
        attachedRefs: this.attachedTaskRefs,
        tasks: this.taskHistory,
      })
      this.taskController.render()
    }

    const mcpPanel = document.createElement('div')
    mcpPanel.className = 'aos-mcp-panel'
    const mcpHead = document.createElement('div')
    mcpHead.className = 'aos-panel-header'
    mcpHead.innerHTML = `<span>MCP Firewall</span><small>${this.mcpEntries.length}</small>`
    mcpPanel.appendChild(mcpHead)
    if (this.mcpEntries.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'aos-muted'
      empty.textContent = 'No external MCP servers registered.'
      mcpPanel.appendChild(empty)
    } else {
      const ul = document.createElement('ul')
      ul.className = 'aos-mcp-list'
      for (const srv of this.mcpEntries) {
        const li = document.createElement('li')
        li.textContent = srv.name ?? srv.server_id ?? JSON.stringify(srv)
        ul.appendChild(li)
      }
      mcpPanel.appendChild(ul)
    }

    right.append(approvalsEl, tasksPreview, mcpPanel)

    main.append(left, center, right)
    shell.append(topbar, main)
    root.appendChild(shell)
  }
}
