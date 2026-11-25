import { renderAgentOnboarding } from './agent-onboarding.ts'
import { renderApprovalPanel } from './approval-modal.ts'
import type { OnboardingIntent } from './onboarding-wizard.ts'
import { TaskStreamController, type TaskArtifactRef } from './task-stream.ts'
import { renderWorkspaceTree, upsertSyncRule } from './workspace-tree.ts'
import { brandMarkSvg, iconHtml } from '../icons.ts'
import type { AgentRole } from '../roles.ts'
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
export type ShellDrawerKind = 'none' | 'approvals' | 'system'

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

const SAMPLE_NOTE_CONTENT = `# Working Draft

Welcome to the **Heurion Doc Canvas**.

- Edit Markdown on the left and preview live on the right.
- Press \`Ctrl+S\` to save into the sandbox, then inspect **Diff** or **Accept Changes**.
- Ask the **Agent Workstream** on the left to rewrite sections, cite sources, or analyze data.
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
  private preferredRole: AgentRole = 'coder'
  private leftCollapsed = false
  private canvasOpen = false
  private activeDrawer: ShellDrawerKind = 'none'
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
      this.canvasOpen = true
      this.render()
    }
  }

  openExistingFile(relPath: string): void {
    const entry = this.treeEntries.find(e => !e.is_dir && e.path === relPath)
    if (!entry) return
    const decision = resolveFormatAccess(entry.name, this.entitlements)
    this.selectedFile = entry
    this.canvasOpen = true
    if (!decision.allowed) {
      this.opts.onRequestUpgrade?.(decision.reason ?? 'Requires Cloud Pro')
    }
    this.render()
  }

  attachFileToPrompt(relPath: string): void {
    const clean = relPath.trim()
    if (!clean) return
    if (!this.attachedTaskRefs.includes(clean)) {
      this.attachedTaskRefs.push(clean)
    }
    this.render()
    this.taskController?.focusComposer()
  }

  focusAssistant(prefillPrompt?: string): void {
    this.render()
    this.taskController?.focusComposer(prefillPrompt)
  }

  openCanvasWithSuggestedOrLauncher(): void {
    if (!this.selectedFile && this.activeWorkspace) {
      const files = this.treeEntries.filter(e => !e.is_dir)
      const preferred =
        files.find(f => /^readme\.md$/i.test(f.name)) ??
        files.find(f => /\.(md|markdown|csv|tsv)$/i.test(f.name)) ??
        null
      if (preferred) {
        this.selectedFile = preferred
      }
    }
    this.canvasOpen = true
    this.render()
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
    if (intent === 'code' || intent === 'agent') {
      this.preferredRole = 'coder'
      this.canvasOpen = false
      this.render()
      this.taskController?.focusComposer()
      return
    }
    if (intent === 'data') {
      this.preferredRole = 'analyst'
      const dataset = files.find(f => /\.(csv|tsv)$/i.test(f.name))
      if (dataset) {
        this.selectedFile = dataset
        this.canvasOpen = true
        this.render()
        return
      }
      await this.createAndOpenFile('data/sample_metrics.csv', SAMPLE_CSV_CONTENT)
      return
    }
    if (intent === 'write') {
      this.preferredRole = 'writer'
      const doc =
        files.find(f => /^readme\.md$/i.test(f.name)) ?? files.find(f => /\.(md|markdown)$/i.test(f.name))
      if (doc) {
        this.selectedFile = doc
        this.canvasOpen = true
        this.render()
        return
      }
      await this.createAndOpenFile('notes/draft.md', SAMPLE_NOTE_CONTENT)
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
      this.approvalBellEl.className = `aos-btn aos-btn-sm ${this.escalations.length > 0 ? 'aos-bell-active' : ''}`
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
    this.render()
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
      onAttachFile: relPath => {
        this.attachFileToPrompt(relPath)
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

  private renderSystemDrawerBody(container: HTMLElement): void {
    const infoCard = document.createElement('div')
    infoCard.className = 'aos-system-card'
    infoCard.innerHTML = `
      <div class="aos-panel-header"><span>Sandbox &amp; Tier</span><span class="aos-badge ${this.sandboxHealthy ? 'ok' : 'warn'}">${this.sandboxDriver}</span></div>
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
        void this.createAndOpenFile('notes/draft.md', SAMPLE_NOTE_CONTENT)
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

    // Minimal CLI-parity Topbar
    const topbar = document.createElement('header')
    topbar.className = 'aos-topbar'

    const toggleFilesBtn = document.createElement('button')
    toggleFilesBtn.type = 'button'
    toggleFilesBtn.className = 'aos-btn aos-btn-sm'
    toggleFilesBtn.innerHTML = iconHtml('folder')
    toggleFilesBtn.title = this.leftCollapsed ? 'Show workspace files' : 'Hide workspace files'
    toggleFilesBtn.onclick = () => {
      this.leftCollapsed = !this.leftCollapsed
      this.render()
    }

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
    openBtn.innerHTML = `${iconHtml('folderOpen')}<span>+ Folder</span>`
    openBtn.onclick = () => {
      void this.openWorkspaceInteractive()
    }

    topbar.append(toggleFilesBtn, brand, wsPicker, openBtn)

    const childRepos = this.activeWorkspace?.child_repos ?? []
    if (childRepos.length > 0) {
      const repoPicker = document.createElement('select')
      repoPicker.className = 'aos-select aos-repo-select'
      repoPicker.title = 'Scope git diff/commit and tasks to a child repository'
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

    const canvasToggleBtn = document.createElement('button')
    canvasToggleBtn.type = 'button'
    canvasToggleBtn.className = `aos-btn aos-btn-sm ${this.canvasOpen ? 'aos-btn-primary' : ''}`
    canvasToggleBtn.innerHTML = `${iconHtml('layers')}<span>${this.canvasOpen ? 'Close Canvas' : 'Open Canvas'}</span>`
    canvasToggleBtn.title = 'Open or close Heurion Doc / Data Studio Canvas alongside your workstream'
    canvasToggleBtn.onclick = () => {
      if (this.canvasOpen) {
        this.canvasOpen = false
        this.render()
      } else {
        this.openCanvasWithSuggestedOrLauncher()
      }
    }
    statusRight.appendChild(canvasToggleBtn)

    const approvalBell = document.createElement('button')
    approvalBell.type = 'button'
    this.approvalBellEl = approvalBell
    approvalBell.onclick = () => {
      this.activeDrawer = this.activeDrawer === 'approvals' ? 'none' : 'approvals'
      this.render()
    }
    this.renderApprovalsAndBell()
    statusRight.appendChild(approvalBell)

    const sysBtn = document.createElement('button')
    sysBtn.type = 'button'
    sysBtn.className = `aos-btn aos-btn-sm ${this.activeDrawer === 'system' ? 'aos-btn-primary' : ''}`
    sysBtn.innerHTML = `${iconHtml('server')}<span>CLIs</span>`
    sysBtn.title = 'Manage BYO AI CLIs, Sandbox health, and Cloud Pro tier'
    sysBtn.onclick = () => {
      this.activeDrawer = this.activeDrawer === 'system' ? 'none' : 'system'
      this.render()
    }
    statusRight.appendChild(sysBtn)

    if (this.opts.onOpenWizard) {
      const guideBtn = document.createElement('button')
      guideBtn.type = 'button'
      guideBtn.className = 'aos-btn aos-btn-sm'
      guideBtn.innerHTML = `${iconHtml('compass')}<span>Guide</span>`
      guideBtn.onclick = () => this.opts.onOpenWizard?.()
      statusRight.appendChild(guideBtn)
    }

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
    refreshBtn.title = 'Refresh workspace files & daemon state'
    refreshBtn.onclick = () => {
      refreshBtn.disabled = true
      void this.refresh().finally(() => {
        refreshBtn.disabled = false
      })
    }
    statusRight.appendChild(refreshBtn)

    topbar.appendChild(statusRight)

    // Primary Body: Optional Left Files + Central Agent Workstream + Optional On-Demand Heurion Doc Canvas
    const main = document.createElement('div')
    const layoutClasses = ['aos-main-grid']
    if (this.leftCollapsed) layoutClasses.push('is-left-collapsed')
    if (this.canvasOpen) layoutClasses.push('has-canvas')
    main.className = layoutClasses.join(' ')

    if (!this.leftCollapsed) {
      const left = document.createElement('aside')
      left.className = 'aos-sidebar-left'
      const treeContainer = document.createElement('div')
      this.treeContainerEl = treeContainer
      left.appendChild(treeContainer)
      this.renderTreeOnly()
      main.appendChild(left)
    } else {
      this.treeContainerEl = null
    }

    const workstreamPane = document.createElement('main')
    workstreamPane.className = 'aos-workstream-pane'

    const workstreamInner = document.createElement('div')
    workstreamInner.className = 'aos-workstream-inner'

    if (this.escalations.length > 0) {
      const alertBar = document.createElement('div')
      alertBar.className = 'aos-inline-approval-bar'
      alertBar.innerHTML = `${iconHtml('bell')}<span><strong>${this.escalations.length} action(s)</strong> awaiting your approval to run cleanly.</span>`
      const reviewBtn = document.createElement('button')
      reviewBtn.type = 'button'
      reviewBtn.className = 'aos-btn aos-btn-sm aos-btn-primary'
      reviewBtn.textContent = 'Review'
      reviewBtn.onclick = () => {
        this.activeDrawer = 'approvals'
        this.render()
      }
      alertBar.appendChild(reviewBtn)
      workstreamInner.appendChild(alertBar)
    }

    if (!this.activeWorkspace) {
      const noWsCard = document.createElement('div')
      noWsCard.className = 'aos-workstream-empty'
      noWsCard.innerHTML = `
        ${brandMarkSvg()}
        <div class="aos-eyebrow">CLI-PARITY SANDBOX WORKBENCH</div>
        <h2 class="aos-serif-title">Pick a workspace folder to begin</h2>
        <p class="aos-muted">Just like launching Aegis CLI in your terminal — select a folder to start coding, analyzing data, or writing with Heurion Doc Canvas on demand.</p>
      `
      const openPrimaryBtn = document.createElement('button')
      openPrimaryBtn.type = 'button'
      openPrimaryBtn.className = 'aos-btn aos-btn-primary aos-btn-lg'
      openPrimaryBtn.innerHTML = `${iconHtml('folderOpen')}<span>Open Local Folder</span>`
      openPrimaryBtn.onclick = () => {
        void this.openWorkspaceInteractive()
      }
      noWsCard.appendChild(openPrimaryBtn)
      workstreamInner.appendChild(noWsCard)
    } else {
      const streamHost = document.createElement('div')
      streamHost.className = 'aos-workstream-host'
      this.taskController = new TaskStreamController({
        container: streamHost,
        client: this.opts.client,
        workspaceId: this.activeWorkspace.id,
        workspaceName: this.activeWorkspace.name,
        activeRepo: this.activeRepo,
        agents: this.agents,
        activeFilePath: this.selectedFile?.path ?? null,
        workspaceFiles: this.treeEntries,
        artifacts: this.workspaceArtifacts,
        attachedRefs: this.attachedTaskRefs,
        tasks: this.taskHistory,
        initialRole: this.preferredRole,
        onRoleChanged: role => {
          this.preferredRole = role
        },
        onOpenCanvas: this.opts.renderStudio
          ? () => {
              this.openCanvasWithSuggestedOrLauncher()
            }
          : undefined,
      })
      this.taskController.render()
      workstreamInner.appendChild(streamHost)
    }

    workstreamPane.appendChild(workstreamInner)
    main.appendChild(workstreamPane)

    if (this.canvasOpen && this.opts.renderStudio) {
      const canvasPane = document.createElement('section')
      canvasPane.className = 'aos-canvas-pane'

      const canvasHeader = document.createElement('div')
      canvasHeader.className = 'aos-canvas-header'
      const titleWrap = document.createElement('div')
      titleWrap.className = 'aos-canvas-title'
      titleWrap.innerHTML = `${iconHtml('layers')}<strong>Heurion Doc Canvas</strong>`
      if (this.selectedFile) {
        const badge = document.createElement('code')
        badge.className = 'aos-badge info'
        badge.textContent = this.selectedFile.path
        titleWrap.appendChild(badge)
      }

      const canvasActions = document.createElement('div')
      canvasActions.className = 'aos-canvas-actions'
      if (this.activeWorkspace) {
        const newNoteBtn = document.createElement('button')
        newNoteBtn.type = 'button'
        newNoteBtn.className = 'aos-btn aos-btn-sm'
        newNoteBtn.innerHTML = `${iconHtml('plus')}<span>New Note</span>`
        newNoteBtn.onclick = () => {
          void this.createAndOpenFile('notes/draft.md', SAMPLE_NOTE_CONTENT)
        }
        canvasActions.appendChild(newNoteBtn)
      }
      const closeCanvasBtn = document.createElement('button')
      closeCanvasBtn.type = 'button'
      closeCanvasBtn.className = 'aos-btn aos-btn-sm'
      closeCanvasBtn.innerHTML = iconHtml('x')
      closeCanvasBtn.title = 'Close Canvas & return to full-width Workstream'
      closeCanvasBtn.onclick = () => {
        this.canvasOpen = false
        this.render()
      }
      canvasActions.appendChild(closeCanvasBtn)

      canvasHeader.append(titleWrap, canvasActions)

      const canvasBody = document.createElement('div')
      canvasBody.className = 'aos-canvas-body'
      this.opts.renderStudio({
        container: canvasBody,
        workspace: this.activeWorkspace,
        activeRepo: this.activeRepo,
        file: this.selectedFile,
        entitlements: this.entitlements,
        onRequestUpgrade: reason => this.opts.onRequestUpgrade?.(reason),
        quickActions: this.buildQuickActions(),
      })

      canvasPane.append(canvasHeader, canvasBody)
      main.appendChild(canvasPane)
    }

    shell.append(topbar, main)

    if (this.activeDrawer !== 'none') {
      const backdrop = document.createElement('div')
      backdrop.className = 'aos-drawer-backdrop'
      backdrop.onclick = ev => {
        if (ev.target === backdrop) {
          this.activeDrawer = 'none'
          this.render()
        }
      }

      const drawer = document.createElement('aside')
      drawer.className = 'aos-drawer-panel'

      const dHead = document.createElement('div')
      dHead.className = 'aos-canvas-header'
      const dTitle = document.createElement('strong')
      dTitle.textContent =
        this.activeDrawer === 'approvals' ? 'Policy Approvals' : 'CLIs, Sandbox & Tier'
      const dClose = document.createElement('button')
      dClose.type = 'button'
      dClose.className = 'aos-btn aos-btn-sm'
      dClose.innerHTML = iconHtml('x')
      dClose.onclick = () => {
        this.activeDrawer = 'none'
        this.render()
      }
      dHead.append(dTitle, dClose)

      const dBody = document.createElement('div')
      dBody.className = 'aos-side-tab-body'
      if (this.activeDrawer === 'approvals') {
        const approvalsHost = document.createElement('div')
        this.approvalsContainerEl = approvalsHost
        this.renderApprovalsAndBell()
        dBody.appendChild(approvalsHost)
      } else {
        this.approvalsContainerEl = null
        this.renderSystemDrawerBody(dBody)
      }

      drawer.append(dHead, dBody)
      backdrop.appendChild(drawer)
      shell.appendChild(backdrop)
    } else {
      this.approvalsContainerEl = null
    }

    root.appendChild(shell)
  }
}
