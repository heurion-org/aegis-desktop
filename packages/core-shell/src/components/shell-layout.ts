import { renderAgentOnboarding } from './agent-onboarding.ts'
import { renderApprovalPanel } from './approval-modal.ts'
import type { OnboardingIntent } from './onboarding-wizard.ts'
import { TaskStreamController, type TaskArtifactRef } from './task-stream.ts'
import { renderWorkspaceTree, upsertSyncRule } from './workspace-tree.ts'
import { brandMarkSvg, iconHtml } from '../icons.ts'
import { getThemePref, resolveEffectiveTheme, setThemePref } from '../theme.ts'
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
export type RightSidebarTab = 'assistant' | 'approvals' | 'system'

export interface StudioQuickActions {
  onOpenWorkspace: () => void
  onCreateMarkdown: () => void
  onOpenOrCreateDataset: () => void
  onAskAgent: () => void
  onOpenGuide?: () => void
  onSelectFile: (relPath: string) => void
  suggestedFiles: Array<{ path: string; name: string }>
}

export interface StudioMountContext {
  container: HTMLElement
  workspace: DesktopWorkspace | null
  activeRepo: string | null
  file: WorkspaceTreeEntry | null
  entitlements: DesktopEntitlements
  onRequestUpgrade: (reason: string) => void
  quickActions: StudioQuickActions
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
  onOpenWizard?: () => void
  listArtifacts?: (workspaceId: string) => Promise<TaskArtifactRef[]>
}

const SAMPLE_NOTE_CONTENT = `# Getting Started

Welcome to **Aegis Desktop**.

- Write in Markdown on the left and see live preview on the right.
- Press \`Ctrl+S\` (or \`Save\`) to write into the sandbox, then inspect **Diff** or **Accept Changes**.
- Open **AI Assistant** on the right to draft sections or analyze data with \`@File\` / \`@Artifact\`.
`

const SAMPLE_CSV_CONTENT = `cohort,patients,response_rate,median_months
Control,42,0.38,11.2
Low Dose,45,0.56,14.8
Target Dose,48,0.74,19.4
Combination,44,0.81,22.1
`

export class AegisCoreShell {
  private readonly opts: CoreShellOptions
  private entitlements: DesktopEntitlements
  private mode: ShellSurfaceMode = 'studio'
  private rightTab: RightSidebarTab = 'assistant'
  private rightCollapsed = false
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

  getAgentsSnapshot(): DesktopAgentStatus[] {
    return this.agents
  }

  getWorkspacesSnapshot(): DesktopWorkspace[] {
    return this.workspaces
  }

  getActiveWorkspaceSnapshot(): DesktopWorkspace | null {
    return this.activeWorkspace
  }

  getSandboxStatus(): { ready: boolean; driver: string } {
    return { ready: this.sandboxHealthy, driver: this.sandboxDriver }
  }

  getEntitlementsSnapshot(): DesktopEntitlements {
    return this.entitlements
  }

  setAgentsSnapshot(agents: DesktopAgentStatus[]): void {
    this.agents = agents
    this.render()
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

  async openWorkspaceInteractive(): Promise<void> {
    const path = (await this.opts.onOpenWorkspacePrompt?.()) ?? window.prompt('Workspace directory path:')
    if (!path) return
    const created = await this.opts.client.openWorkspace({
      path,
      mode: this.entitlements.cloud_yjs_sync ? 'cloud' : 'local',
    })
    await this.refresh()
    await this.selectWorkspace(created)
  }

  async createAndOpenFile(relPath: string, initialContent = ''): Promise<void> {
    if (!this.activeWorkspace) return
    const clean = relPath.replace(/^\/+/, '').replace(/^\.\//, '')
    const targetPath =
      this.activeRepo && !clean.startsWith(`${this.activeRepo}/`)
        ? `${this.activeRepo}/${clean}`
        : clean
    await this.opts.client.writeWorkspaceFile(this.activeWorkspace.id, targetPath, initialContent)
    await this.reloadTree()
    const createdEntry = this.treeEntries.find(e => !e.is_dir && e.path === targetPath)
    if (createdEntry) {
      this.selectedFile = createdEntry
      this.mode = 'studio'
      this.render()
    }
  }

  openExistingFile(relPath: string): void {
    const entry = this.treeEntries.find(e => !e.is_dir && e.path === relPath)
    if (!entry) return
    const decision = resolveFormatAccess(entry.name, this.entitlements)
    this.selectedFile = entry
    if (!decision.allowed) {
      this.opts.onRequestUpgrade?.(decision.reason ?? 'Requires Cloud Pro')
    }
    this.mode = 'studio'
    this.render()
  }

  focusAssistant(prefillPrompt?: string): void {
    this.rightCollapsed = false
    this.rightTab = 'assistant'
    this.mode = 'studio'
    this.render()
    this.taskController?.focusComposer(prefillPrompt)
  }

  async runIntentAction(intent?: OnboardingIntent): Promise<void> {
    if (!intent) {
      this.render()
      return
    }
    if (!this.activeWorkspace) {
      this.render()
      return
    }
    const files = this.treeEntries.filter(e => !e.is_dir)
    if (intent === 'write') {
      const readme = files.find(f => /^readme\.md$/i.test(f.name)) ?? files.find(f => /\.(md|markdown)$/i.test(f.name))
      if (readme) {
        this.openExistingFile(readme.path)
        return
      }
      await this.createAndOpenFile('notes/getting-started.md', SAMPLE_NOTE_CONTENT)
      return
    }
    if (intent === 'data') {
      const dataset = files.find(f => /\.(csv|tsv)$/i.test(f.name))
      if (dataset) {
        this.openExistingFile(dataset.path)
        return
      }
      await this.createAndOpenFile('data/sample_metrics.csv', SAMPLE_CSV_CONTENT)
      return
    }
    if (intent === 'agent') {
      this.focusAssistant('Summarize the structure and key files in this workspace.')
    }
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
      this.approvalBellEl.innerHTML = `${iconHtml('bell')}<span>${this.escalations.length > 0 ? `Approvals (${this.escalations.length})` : 'Approvals'}</span>`
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
        this.openExistingFile(entry.path)
      },
      onCreateFile: async rawPath => {
        await this.createAndOpenFile(rawPath, '')
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

  private renderSystemTab(container: HTMLElement): void {
    const infoCard = document.createElement('div')
    infoCard.className = 'aos-system-card'
    infoCard.innerHTML = `
      <div class="aos-panel-header"><span>Environment</span><span class="aos-badge ${this.sandboxHealthy ? 'ok' : 'warn'}">${this.sandboxDriver}</span></div>
      <div class="aos-system-row"><span class="aos-muted">Organization</span><code>${this.activeWorkspace?.org_id ?? 'personal'}</code></div>
      <div class="aos-system-row"><span class="aos-muted">Entitlement Tier</span><strong>${this.entitlements.dual_surface_crdt ? `Cloud ${this.entitlements.tier.toUpperCase()}` : 'Free Local'}</strong></div>
    `
    const upgradeBtn = document.createElement('button')
    upgradeBtn.type = 'button'
    upgradeBtn.className = 'aos-btn aos-btn-sm'
    upgradeBtn.textContent = this.entitlements.dual_surface_crdt ? 'Manage Pro Token' : 'Upgrade to Cloud Pro'
    upgradeBtn.onclick = () => {
      this.opts.onRequestUpgrade?.(
        'Upgrade to Cloud Pro to unlock Dual-Surface CRDT (.docx/.pptx/.pdf/.tex) and Yjs cloud sync.',
      )
    }
    infoCard.appendChild(upgradeBtn)

    const agentsBox = document.createElement('div')
    renderAgentOnboarding({
      container: agentsBox,
      client: this.opts.client,
      agents: this.agents,
      onAgentsChanged: agents => {
        this.agents = agents
        this.render()
      },
    })

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

    container.append(infoCard, agentsBox, mcpPanel)
  }

  private buildQuickActions(): StudioQuickActions {
    const suggestedFiles = this.treeEntries
      .filter(e => !e.is_dir)
      .slice(0, 6)
      .map(e => ({ path: e.path, name: e.name }))

    return {
      onOpenWorkspace: () => {
        void this.openWorkspaceInteractive()
      },
      onCreateMarkdown: () => {
        void this.createAndOpenFile('notes/getting-started.md', SAMPLE_NOTE_CONTENT)
      },
      onOpenOrCreateDataset: () => {
        void this.runIntentAction('data')
      },
      onAskAgent: () => {
        this.focusAssistant('Summarize the structure and key files in this workspace.')
      },
      onOpenGuide: this.opts.onOpenWizard ? () => this.opts.onOpenWizard?.() : undefined,
      onSelectFile: relPath => {
        this.openExistingFile(relPath)
      },
      suggestedFiles,
    }
  }

  render(): void {
    const { root } = this.opts
    this.taskController?.dispose()
    this.taskController = null
    root.innerHTML = ''

    const shell = document.createElement('div')
    shell.className = 'aos-shell'

    // Calm Top Bar
    const topbar = document.createElement('header')
    topbar.className = 'aos-topbar'

    const brand = document.createElement('div')
    brand.className = 'aos-brand'
    brand.innerHTML = `${brandMarkSvg()}<span class="aos-brand-text"><strong>AEGIS</strong><small>HEURION DESKTOP</small></span>`

    const wsPicker = document.createElement('select')
    wsPicker.className = 'aos-select'
    const emptyOpt = document.createElement('option')
    emptyOpt.value = ''
    emptyOpt.textContent = this.workspaces.length ? 'Select workspace…' : 'No workspace open'
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
    openBtn.innerHTML = `${iconHtml('folderOpen')}<span>Open Folder</span>`
    openBtn.onclick = () => {
      void this.openWorkspaceInteractive()
    }

    topbar.append(brand, wsPicker, openBtn)

    const childRepos = this.activeWorkspace?.child_repos ?? []
    if (childRepos.length > 0) {
      const repoPicker = document.createElement('select')
      repoPicker.className = 'aos-select aos-repo-select'
      repoPicker.title = 'Scope files, diff, commit/rollback, and agent tasks to a child git repo'
      const allOpt = document.createElement('option')
      allOpt.value = ''
      allOpt.textContent = 'All repos'
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

    const statusRight = document.createElement('div')
    statusRight.className = 'aos-topbar-right'

    if (this.opts.onOpenWizard) {
      const guideBtn = document.createElement('button')
      guideBtn.type = 'button'
      guideBtn.className = 'aos-btn aos-btn-sm'
      guideBtn.innerHTML = `${iconHtml('compass')}<span>Guide</span>`
      guideBtn.title = 'Open interactive setup & workflow guide'
      guideBtn.onclick = () => this.opts.onOpenWizard?.()
      statusRight.appendChild(guideBtn)
    }

    const approvalBell = document.createElement('button')
    approvalBell.type = 'button'
    this.approvalBellEl = approvalBell
    approvalBell.onclick = () => {
      this.rightCollapsed = false
      this.rightTab = 'approvals'
      this.render()
    }
    statusRight.appendChild(approvalBell)

    const effectiveTheme = resolveEffectiveTheme(getThemePref())
    const themeBtn = document.createElement('button')
    themeBtn.type = 'button'
    themeBtn.className = 'aos-btn aos-btn-sm'
    themeBtn.innerHTML = iconHtml(effectiveTheme === 'dark' ? 'sun' : 'moon')
    themeBtn.title =
      effectiveTheme === 'dark' ? 'Switch to Nordic Editorial Light' : 'Switch to Nordic Forest Dark'
    themeBtn.onclick = () => {
      setThemePref(effectiveTheme === 'dark' ? 'light' : 'dark')
      this.render()
    }
    statusRight.appendChild(themeBtn)

    const refreshBtn = document.createElement('button')
    refreshBtn.type = 'button'
    refreshBtn.className = 'aos-btn aos-btn-sm'
    refreshBtn.innerHTML = iconHtml('refresh')
    refreshBtn.title = 'Refresh workspace tree & daemon state'
    refreshBtn.onclick = () => {
      refreshBtn.disabled = true
      void this.refresh().finally(() => {
        refreshBtn.disabled = false
      })
    }
    statusRight.appendChild(refreshBtn)

    const panelToggleBtn = document.createElement('button')
    panelToggleBtn.type = 'button'
    panelToggleBtn.className = `aos-btn aos-btn-sm ${!this.rightCollapsed ? 'aos-btn-primary' : ''}`
    panelToggleBtn.innerHTML = `${iconHtml('sparkles')}<span>${this.rightCollapsed ? 'Show Panel' : 'Hide Panel'}</span>`
    panelToggleBtn.onclick = () => {
      this.rightCollapsed = !this.rightCollapsed
      this.render()
    }
    statusRight.appendChild(panelToggleBtn)

    topbar.appendChild(statusRight)

    // Three-column body (Left = Files, Center = Studio/Launchpad, Right = Tabbed Inspector)
    const main = document.createElement('div')
    main.className = `aos-main-grid ${this.rightCollapsed ? 'is-right-collapsed' : ''}`

    const left = document.createElement('aside')
    left.className = 'aos-sidebar-left'
    const treeContainer = document.createElement('div')
    this.treeContainerEl = treeContainer
    left.appendChild(treeContainer)
    this.renderTreeOnly()

    const center = document.createElement('section')
    center.className = 'aos-center-stage'
    if (this.opts.renderStudio) {
      this.opts.renderStudio({
        container: center,
        workspace: this.activeWorkspace,
        activeRepo: this.activeRepo,
        file: this.selectedFile,
        entitlements: this.entitlements,
        onRequestUpgrade: reason => this.opts.onRequestUpgrade?.(reason),
        quickActions: this.buildQuickActions(),
      })
    }

    const right = document.createElement('aside')
    right.className = 'aos-sidebar-right'

    const tabs = document.createElement('div')
    tabs.className = 'aos-side-tabs'
    const tabDefs: Array<{ id: RightSidebarTab; label: string }> = [
      { id: 'assistant', label: 'AI Assistant' },
      {
        id: 'approvals',
        label: this.escalations.length > 0 ? `Approvals (${this.escalations.length})` : 'Approvals',
      },
      { id: 'system', label: 'System' },
    ]
    for (const t of tabDefs) {
      const tb = document.createElement('button')
      tb.type = 'button'
      tb.className = `aos-tab-btn ${this.rightTab === t.id ? 'is-active' : ''}`
      tb.textContent = t.label
      tb.onclick = () => {
        this.rightTab = t.id
        this.render()
      }
      tabs.appendChild(tb)
    }

    const tabBody = document.createElement('div')
    tabBody.className = 'aos-side-tab-body'

    const approvalsHost = document.createElement('div')
    this.approvalsContainerEl = approvalsHost
    this.renderApprovalsAndBell()

    if (this.rightTab === 'assistant') {
      this.taskController = new TaskStreamController({
        container: tabBody,
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
    } else if (this.rightTab === 'approvals') {
      tabBody.appendChild(approvalsHost)
    } else {
      this.renderSystemTab(tabBody)
    }

    right.append(tabs, tabBody)

    main.append(left, center)
    if (!this.rightCollapsed) {
      main.appendChild(right)
    }
    shell.append(topbar, main)
    root.appendChild(shell)
  }
}
