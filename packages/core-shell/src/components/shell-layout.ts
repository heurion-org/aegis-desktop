import { renderAgentOnboarding } from './agent-onboarding.ts'
import { renderApprovalPanel } from './approval-modal.ts'
import type { OnboardingIntent } from './onboarding-wizard.ts'
import { TaskStreamController, type TaskArtifactRef } from './task-stream.ts'
import { renderWorkspaceTree, upsertSyncRule } from './workspace-tree.ts'
import { brandMarkSvg, iconHtml } from '../icons.ts'
import { escapeHtml } from '../markdown.ts'
import type { AgentRole } from '../roles.ts'
import { getThemePref, resolveEffectiveTheme, setThemePref } from '../theme.ts'
import {
  MIN_RECOMMENDED_DAEMON_VERSION,
  applySyncModeFilter,
  isSemverAtLeast,
  type AegisDaemonClient,
  type DesktopAgentStatus,
  type DesktopTaskRecord,
  type DesktopWorkspace,
  type McpInventoryEntry,
  type PendingEscalation,
  type WorkspaceDiffResponse,
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

const UPDATE_COMMAND =
  '/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/heurion-org/aegis-desktop/main/install.sh)"'

const SAMPLE_NOTE_CONTENT = `# Working Draft

Welcome to the **Heurion Doc Canvas**.

- Edit Markdown on the left and preview live on the right.
- Press \`Ctrl+S\` to save into the sandbox, then inspect **Diff** or **Commit**.
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
  private daemonVersion: string | null = null
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
  private sandboxHint = ''
  private escalations: PendingEscalation[] = []
  private knownEscalationIds = new Set<string>()
  private mcpEntries: McpInventoryEntry[] = []
  private taskHistoryByWorkspace = new Map<string, DesktopTaskRecord[]>()
  private draftByWorkspace = new Map<string, string>()
  private activeDiff: WorkspaceDiffResponse | null = null
  private diffExpanded = false
  private commitFormOpen = false
  private rollbackConfirmOpen = false
  private vcsFeedback = ''
  private taskController: TaskStreamController | null = null
  private approvalPollTimer: number | null = null
  private treeContainerEl: HTMLElement | null = null
  private vcsBarHostEl: HTMLElement | null = null
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

  private getActiveTasks(): DesktopTaskRecord[] {
    const wsId = this.activeWorkspace?.id
    if (!wsId) return []
    let list = this.taskHistoryByWorkspace.get(wsId)
    if (!list) {
      list = []
      this.taskHistoryByWorkspace.set(wsId, list)
    }
    return list
  }

  private isDaemonOutdated(): boolean {
    return Boolean(this.daemonVersion && !isSemverAtLeast(this.daemonVersion, MIN_RECOMMENDED_DAEMON_VERSION))
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

  async openAgentOutputInCanvas(task: DesktopTaskRecord, outputText: string): Promise<void> {
    if (!this.activeWorkspace) return
    const cleanPrompt = task.prompt.replace(/^\[Workspace context files:[^\]]*\]\s*/i, '').trim()
    const slug =
      cleanPrompt
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 32) || task.resolved_agent
    const suffix = task.task_id.replace(/^tsk_/, '').slice(0, 6) || String(Date.now()).slice(-4)
    const relPath = `notes/agent-${slug}-${suffix}.md`
    const heading = cleanPrompt.split(/\r?\n/)[0]?.slice(0, 80) || 'Agent Response'
    const markdown = `# ${heading}\n\n> Generated by \`${task.resolved_agent}\` (${task.role})\n\n${outputText}\n`
    await this.createAndOpenFile(relPath, markdown)
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
    const [health, sandbox, agents, workspaces, approvals, inventory] = await Promise.all([
      this.opts.client.health().catch(() => null),
      this.opts.client.sandboxHealth().catch(() => null),
      this.opts.client.listAgents().catch(() => []),
      this.opts.client.listWorkspaces().catch(() => []),
      this.opts.client.listApprovals().catch(() => ({ escalations: [] })),
      this.opts.client.mcpInventory().catch(() => ({ entries: [] })),
    ])
    if (health) {
      this.daemonVersion = health.version ?? null
    }
    if (sandbox) {
      this.sandboxHealthy = sandbox.ready
      this.sandboxDriver = sandbox.driver
      this.sandboxHint = sandbox.hint
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
    this.activeDiff = null
    this.diffExpanded = false
    this.commitFormOpen = false
    this.rollbackConfirmOpen = false
    this.vcsFeedback = ''
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

  private async reloadDiffOnly(): Promise<void> {
    if (!this.activeWorkspace) {
      this.activeDiff = null
      return
    }
    this.activeDiff = await this.opts.client
      .workspaceDiff(this.activeWorkspace.id, this.activeRepo)
      .catch(() => null)
  }

  async selectRepo(repoRelPath: string | null): Promise<void> {
    this.activeRepo = repoRelPath && repoRelPath.trim() ? repoRelPath : null
    this.diffExpanded = false
    this.commitFormOpen = false
    this.rollbackConfirmOpen = false
    this.vcsFeedback = ''
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
    const [tree] = await Promise.all([
      this.opts.client.workspaceTree(this.activeWorkspace.id, this.activeRepo),
      this.reloadArtifactsOnly(),
      this.reloadDiffOnly(),
    ])
    this.rawTreeEntries = tree.entries
    this.treeEntries = applySyncModeFilter(tree.entries, this.entitlements)
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
      activeRepo: this.activeRepo,
      attachedRefs: this.attachedTaskRefs,
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

  private renderVcsBarOnly(): void {
    const host = this.vcsBarHostEl
    const ws = this.activeWorkspace
    if (!host || !ws) return
    host.innerHTML = ''

    const diff = this.activeDiff
    const childRepos = ws.child_repos ?? []
    const readyClis = this.agents.filter(a => a.installed && a.authenticated).length
    const scopeLabel = this.activeRepo ?? ws.name
    const changedFiles = diff?.changed_files ?? []
    const isGit = diff?.is_git_repo ?? false
    const isCowShadow = diff?.source === 'cow_shadow' && Boolean(diff.session_id)
    const needsRepoPick =
      !isCowShadow && !this.activeRepo && childRepos.length > 0 && diff !== null && !isGit

    const bar = document.createElement('div')
    bar.className = 'aos-ws-status-bar'

    const left = document.createElement('div')
    left.className = 'aos-ws-status-group'

    const scopePill = document.createElement('span')
    scopePill.className = 'aos-badge info'
    scopePill.innerHTML = `${iconHtml('gitBranch')}<span>${escapeHtml(scopeLabel)}</span>`

    const sandboxPill = document.createElement('span')
    sandboxPill.className = `aos-badge ${this.sandboxHealthy ? 'ok' : 'warn'}`
    sandboxPill.title = this.sandboxHint || this.sandboxDriver
    sandboxPill.innerHTML = `${iconHtml('shield')}<span>${escapeHtml(this.sandboxDriver)}</span>`

    const cliPill = document.createElement('span')
    cliPill.className = `aos-badge ${readyClis > 0 ? 'ok' : 'warn'}`
    cliPill.innerHTML = `${iconHtml('terminal')}<span>${readyClis}/${this.agents.length} CLIs</span>`

    left.append(scopePill, sandboxPill, cliPill)

    if (isCowShadow && diff?.session_id) {
      const cowPill = document.createElement('span')
      cowPill.className = 'aos-badge info'
      cowPill.title = diff.evidence_hash
        ? `CoW Shadow Evidence ${diff.evidence_hash}`
        : `CoW Shadow Session ${diff.session_id}`
      cowPill.innerHTML = `${iconHtml('shield')}<span>CoW ${escapeHtml(diff.session_id.slice(0, 12))}</span>`
      left.appendChild(cowPill)
    }

    const right = document.createElement('div')
    right.className = 'aos-ws-status-group'

    if (needsRepoPick) {
      const pickWrap = document.createElement('div')
      pickWrap.className = 'aos-repo-chips'
      const lbl = document.createElement('small')
      lbl.className = 'aos-muted'
      lbl.textContent = 'Select repo for git ops:'
      pickWrap.appendChild(lbl)
      for (const repo of childRepos.slice(0, 6)) {
        const chip = document.createElement('button')
        chip.type = 'button'
        chip.className = 'aos-pill'
        chip.textContent = repo.branch ? `${repo.name} (${repo.branch})` : repo.name
        chip.onclick = () => {
          void this.selectRepo(repo.rel_path)
        }
        pickWrap.appendChild(chip)
      }
      right.appendChild(pickWrap)
    } else if (diff) {
      const changeBadge = document.createElement('span')
      changeBadge.className = `aos-badge ${changedFiles.length > 0 ? 'warn' : 'ok'}`
      changeBadge.textContent =
        changedFiles.length > 0
          ? isCowShadow
            ? `${changedFiles.length} CoW staged`
            : `${changedFiles.length} changed`
          : 'Clean'
      left.appendChild(changeBadge)

      if (isCowShadow || isGit) {
        const diffBtn = document.createElement('button')
        diffBtn.type = 'button'
        diffBtn.className = `aos-btn aos-btn-sm ${this.diffExpanded ? 'aos-btn-primary' : ''}`
        diffBtn.innerHTML = `${iconHtml('diff')}<span>Diff</span>`
        diffBtn.onclick = () => {
          this.diffExpanded = !this.diffExpanded
          this.renderVcsBarOnly()
        }

        if (isCowShadow && diff.session_id) {
          const landBtn = document.createElement('button')
          landBtn.type = 'button'
          landBtn.className = 'aos-btn aos-btn-sm aos-btn-primary'
          landBtn.innerHTML = `${iconHtml('check')}<span>Land to Host</span>`
          landBtn.disabled = changedFiles.length === 0
          landBtn.onclick = async () => {
            landBtn.disabled = true
            try {
              const res = await this.opts.client.commitWorkspace(ws.id, {
                repo: this.activeRepo,
                session_id: diff.session_id,
                expected_diff_hash: diff.evidence_hash,
              })
              this.diffExpanded = false
              this.rollbackConfirmOpen = false
              this.vcsFeedback = res.summary || 'Landed CoW shadow changes to host.'
              await this.reloadTree()
            } catch (err) {
              this.vcsFeedback = err instanceof Error ? err.message : String(err)
              this.renderVcsBarOnly()
            } finally {
              landBtn.disabled = false
            }
          }

          const discardBtn = document.createElement('button')
          discardBtn.type = 'button'
          discardBtn.className = `aos-btn aos-btn-sm ${this.rollbackConfirmOpen ? 'aos-btn-primary' : ''}`
          discardBtn.innerHTML = `${iconHtml('undo')}<span>Discard Shadow</span>`
          discardBtn.disabled = changedFiles.length === 0
          discardBtn.onclick = () => {
            this.rollbackConfirmOpen = !this.rollbackConfirmOpen
            this.commitFormOpen = false
            this.renderVcsBarOnly()
          }

          right.append(diffBtn, landBtn, discardBtn)
        } else {
          const commitBtn = document.createElement('button')
          commitBtn.type = 'button'
          commitBtn.className = `aos-btn aos-btn-sm ${this.commitFormOpen ? 'aos-btn-primary' : ''}`
          commitBtn.innerHTML = `${iconHtml('check')}<span>Commit</span>`
          commitBtn.disabled = changedFiles.length === 0
          commitBtn.onclick = () => {
            this.commitFormOpen = !this.commitFormOpen
            this.rollbackConfirmOpen = false
            this.renderVcsBarOnly()
          }

          const rollbackBtn = document.createElement('button')
          rollbackBtn.type = 'button'
          rollbackBtn.className = `aos-btn aos-btn-sm ${this.rollbackConfirmOpen ? 'aos-btn-primary' : ''}`
          rollbackBtn.innerHTML = `${iconHtml('undo')}<span>Rollback</span>`
          rollbackBtn.disabled = changedFiles.length === 0
          rollbackBtn.onclick = () => {
            this.rollbackConfirmOpen = !this.rollbackConfirmOpen
            this.commitFormOpen = false
            this.renderVcsBarOnly()
          }

          right.append(diffBtn, commitBtn, rollbackBtn)
        }
      }
    }

    bar.append(left, right)
    host.appendChild(bar)

    if (this.vcsFeedback) {
      const fb = document.createElement('div')
      fb.className = 'aos-vcs-feedback'
      const text = document.createElement('span')
      text.textContent = this.vcsFeedback
      const dismiss = document.createElement('button')
      dismiss.type = 'button'
      dismiss.className = 'aos-btn aos-btn-sm'
      dismiss.innerHTML = iconHtml('x')
      dismiss.onclick = () => {
        this.vcsFeedback = ''
        this.renderVcsBarOnly()
      }
      fb.append(text, dismiss)
      host.appendChild(fb)
    }

    if (this.commitFormOpen) {
      const form = document.createElement('form')
      form.className = 'aos-commit-inline-bar'
      const input = document.createElement('input')
      input.type = 'text'
      input.className = 'aos-input'
      input.placeholder = `Commit message for ${scopeLabel}…`
      const submit = document.createElement('button')
      submit.type = 'submit'
      submit.className = 'aos-btn aos-btn-sm aos-btn-primary'
      submit.innerHTML = `${iconHtml('check')}<span>Commit ${changedFiles.length} file(s)</span>`
      const cancel = document.createElement('button')
      cancel.type = 'button'
      cancel.className = 'aos-btn aos-btn-sm'
      cancel.textContent = 'Cancel'
      cancel.onclick = () => {
        this.commitFormOpen = false
        this.renderVcsBarOnly()
      }
      form.onsubmit = async ev => {
        ev.preventDefault()
        submit.disabled = true
        try {
          const res = await this.opts.client.commitWorkspace(ws.id, {
            repo: this.activeRepo,
            message: input.value.trim() || undefined,
          })
          this.commitFormOpen = false
          this.diffExpanded = false
          this.vcsFeedback = res.commit_hash
            ? `Committed ${res.commit_hash} (${res.summary})`
            : res.summary || 'Committed changes.'
          await this.reloadTree()
        } catch (err) {
          this.vcsFeedback = err instanceof Error ? err.message : String(err)
          this.renderVcsBarOnly()
        } finally {
          submit.disabled = false
        }
      }
      form.append(input, submit, cancel)
      host.appendChild(form)
    }

    if (this.rollbackConfirmOpen) {
      const confirmBar = document.createElement('div')
      confirmBar.className = 'aos-commit-inline-bar is-warn'
      const msg = document.createElement('span')
      msg.textContent = isCowShadow
        ? `Discard ${changedFiles.length} CoW shadow change(s) (${diff?.session_id ?? ''})?`
        : `Discard ${changedFiles.length} uncommitted change(s) in ${scopeLabel}?`
      const confirmBtn = document.createElement('button')
      confirmBtn.type = 'button'
      confirmBtn.className = 'aos-btn aos-btn-sm aos-btn-primary'
      confirmBtn.innerHTML = `${iconHtml('undo')}<span>${isCowShadow ? 'Confirm Discard' : 'Confirm Rollback'}</span>`
      confirmBtn.onclick = async () => {
        confirmBtn.disabled = true
        try {
          const res = await this.opts.client.rollbackWorkspace(ws.id, {
            repo: this.activeRepo,
            session_id: isCowShadow ? diff?.session_id : undefined,
          })
          this.rollbackConfirmOpen = false
          this.diffExpanded = false
          this.vcsFeedback = isCowShadow
            ? `Discarded CoW shadow session ${res.session_id ?? ''}.`
            : `Rolled back ${res.restored_paths.length} path(s).`
          await this.reloadTree()
        } catch (err) {
          this.vcsFeedback = err instanceof Error ? err.message : String(err)
          this.renderVcsBarOnly()
        } finally {
          confirmBtn.disabled = false
        }
      }
      const cancelBtn = document.createElement('button')
      cancelBtn.type = 'button'
      cancelBtn.className = 'aos-btn aos-btn-sm'
      cancelBtn.textContent = 'Cancel'
      cancelBtn.onclick = () => {
        this.rollbackConfirmOpen = false
        this.renderVcsBarOnly()
      }
      confirmBar.append(msg, confirmBtn, cancelBtn)
      host.appendChild(confirmBar)
    }

    if (this.diffExpanded && diff) {
      const panel = document.createElement('div')
      panel.className = 'aos-diff-panel'

      if (changedFiles.length > 0) {
        const filesRow = document.createElement('div')
        filesRow.className = 'aos-ref-bar'
        for (const f of changedFiles) {
          const chip = document.createElement('span')
          chip.className = 'aos-badge info'
          chip.textContent = f
          filesRow.appendChild(chip)
        }
        panel.appendChild(filesRow)
      }

      const pre = document.createElement('pre')
      pre.className = 'aos-diff-pre'
      if (!diff.diff_text.trim()) {
        pre.textContent =
          changedFiles.length > 0
            ? 'Untracked or binary changes present (no unified text diff).'
            : 'Working tree clean (no uncommitted changes).'
      } else {
        pre.innerHTML = diff.diff_text
          .split(/\r?\n/)
          .map(line => {
            const cls =
              line.startsWith('+') && !line.startsWith('+++')
                ? 'is-add'
                : line.startsWith('-') && !line.startsWith('---')
                  ? 'is-del'
                  : line.startsWith('@@') || line.startsWith('diff --git')
                    ? 'is-hunk'
                    : ''
            return `<span class="aos-diff-line ${cls}">${escapeHtml(line)}</span>`
          })
          .join('\n')
      }
      panel.appendChild(pre)
      host.appendChild(panel)
    }
  }

  private renderSystemDrawerBody(container: HTMLElement): void {
    const outdated = this.isDaemonOutdated()
    const readyClis = this.agents.filter(a => a.installed && a.authenticated).length

    const infoCard = document.createElement('div')
    infoCard.className = 'aos-system-card'
    infoCard.innerHTML = `
      <div class="aos-panel-header"><span>Aegis OS Doctor</span><span class="aos-badge ${this.sandboxHealthy && !outdated && readyClis > 0 ? 'ok' : 'warn'}">${this.sandboxHealthy && !outdated ? 'Healthy' : 'Attention'}</span></div>
      <div class="aos-system-row"><span class="aos-muted">Daemon</span><span class="aos-badge ${outdated ? 'warn' : 'ok'}">${escapeHtml(this.daemonVersion ? `v${this.daemonVersion}` : 'unknown')}${outdated ? ` (need >= ${MIN_RECOMMENDED_DAEMON_VERSION})` : ''}</span></div>
      <div class="aos-system-row"><span class="aos-muted">Sandbox Driver</span><span class="aos-badge ${this.sandboxHealthy ? 'ok' : 'warn'}">${escapeHtml(this.sandboxDriver)}</span></div>
      ${this.sandboxHint ? `<small class="aos-muted">${escapeHtml(this.sandboxHint)}</small>` : ''}
      <div class="aos-system-row"><span class="aos-muted">Organization</span><code>${escapeHtml(this.activeWorkspace?.org_id ?? 'personal')}</code></div>
      <div class="aos-system-row"><span class="aos-muted">Entitlement Tier</span><strong>${this.entitlements.dual_surface_crdt ? `Cloud ${this.entitlements.tier.toUpperCase()}` : 'Free Local'}</strong></div>
    `
    const sysBtns = document.createElement('div')
    sysBtns.className = 'sw-toolbar-actions'

    const recheckBtn = document.createElement('button')
    recheckBtn.type = 'button'
    recheckBtn.className = 'aos-btn aos-btn-sm'
    recheckBtn.innerHTML = `${iconHtml('refresh')}<span>Re-run Check</span>`
    recheckBtn.onclick = () => {
      recheckBtn.disabled = true
      void this.refresh().finally(() => {
        recheckBtn.disabled = false
      })
    }

    const upgradeBtn = document.createElement('button')
    upgradeBtn.type = 'button'
    upgradeBtn.className = 'aos-btn aos-btn-sm'
    upgradeBtn.textContent = this.entitlements.dual_surface_crdt ? 'Manage Pro Token' : 'Cloud Pro Token'
    upgradeBtn.onclick = () => {
      this.opts.onRequestUpgrade?.(
        'Upgrade to Cloud Pro to unlock Dual-Surface CRDT (.docx/.pptx/.pdf/.tex) and Yjs cloud sync.',
      )
    }
    sysBtns.append(recheckBtn, upgradeBtn)
    infoCard.appendChild(sysBtns)

    if (outdated) {
      const updateBox = document.createElement('div')
      updateBox.className = 'aos-cli-cmd-row'
      const code = document.createElement('code')
      code.className = 'aos-cli-cmd-code'
      code.textContent = UPDATE_COMMAND
      const copyBtn = document.createElement('button')
      copyBtn.type = 'button'
      copyBtn.className = 'aos-btn aos-btn-sm aos-btn-primary'
      copyBtn.innerHTML = `${iconHtml('copy')}<span>Copy Update</span>`
      copyBtn.onclick = () => {
        void navigator.clipboard?.writeText(UPDATE_COMMAND)
      }
      updateBox.append(code, copyBtn)
      infoCard.appendChild(updateBox)
    }

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

    if (this.escalations.length > 0) {
      const jumpBtn = document.createElement('button')
      jumpBtn.type = 'button'
      jumpBtn.className = 'aos-btn aos-btn-sm aos-btn-primary'
      jumpBtn.innerHTML = `${iconHtml('bell')}<span>Open Policy Approvals (${this.escalations.length})</span>`
      jumpBtn.onclick = () => {
        this.activeDrawer = 'approvals'
        this.render()
      }
      container.appendChild(jumpBtn)
    }
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
    this.vcsBarHostEl = null
    root.innerHTML = ''

    const shell = document.createElement('div')
    shell.className = 'aos-shell'

    // Clean CLI-parity Topbar
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

    const readyClis = this.agents.filter(a => a.installed && a.authenticated).length
    const doctorOk = this.sandboxHealthy && !this.isDaemonOutdated() && readyClis > 0
    const sysBtn = document.createElement('button')
    sysBtn.type = 'button'
    sysBtn.className = `aos-btn aos-btn-sm ${this.activeDrawer === 'system' ? 'aos-btn-primary' : ''}`
    sysBtn.innerHTML = `<span class="aos-status-dot ${doctorOk ? 'is-ok' : 'is-warn'}"></span>${iconHtml('server')}<span>Doctor</span>`
    sysBtn.title = 'Aegis OS Doctor: sidecar version, sandbox driver, BYO CLIs & MCP firewall'
    sysBtn.onclick = () => {
      this.activeDrawer = this.activeDrawer === 'system' ? 'none' : 'system'
      this.render()
    }
    statusRight.appendChild(sysBtn)

    if (this.opts.onOpenWizard) {
      const guideBtn = document.createElement('button')
      guideBtn.type = 'button'
      guideBtn.className = 'aos-btn aos-btn-sm'
      guideBtn.innerHTML = iconHtml('compass')
      guideBtn.title = 'Open Setup Guide'
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

    if (this.isDaemonOutdated()) {
      const upgradeBanner = document.createElement('div')
      upgradeBanner.className = 'aos-upgrade-banner'
      upgradeBanner.innerHTML = `${iconHtml('alertTriangle')}<span><strong>Outdated sidecar detected (aegis-os v${escapeHtml(this.daemonVersion ?? 'unknown')}).</strong> Upgrade to v${MIN_RECOMMENDED_DAEMON_VERSION}+ for live agent task execution and 3-layer repo support.</span>`
      const copyUpdateBtn = document.createElement('button')
      copyUpdateBtn.type = 'button'
      copyUpdateBtn.className = 'aos-btn aos-btn-sm aos-btn-primary'
      copyUpdateBtn.innerHTML = `${iconHtml('copy')}<span>Copy Update Cmd</span>`
      copyUpdateBtn.onclick = () => {
        void navigator.clipboard?.writeText(UPDATE_COMMAND).then(() => {
          copyUpdateBtn.innerHTML = `${iconHtml('check')}<span>Copied</span>`
        })
      }
      upgradeBanner.appendChild(copyUpdateBtn)
      workstreamInner.appendChild(upgradeBanner)
    }

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
      const vcsHost = document.createElement('div')
      vcsHost.className = 'aos-vcs-host'
      this.vcsBarHostEl = vcsHost
      this.renderVcsBarOnly()
      workstreamInner.appendChild(vcsHost)

      const wsId = this.activeWorkspace.id
      const streamHost = document.createElement('div')
      streamHost.className = 'aos-workstream-host'
      this.taskController = new TaskStreamController({
        container: streamHost,
        client: this.opts.client,
        workspaceId: wsId,
        workspaceName: this.activeWorkspace.name,
        activeRepo: this.activeRepo,
        agents: this.agents,
        activeFilePath: this.selectedFile?.path ?? null,
        workspaceFiles: this.treeEntries,
        artifacts: this.workspaceArtifacts,
        attachedRefs: this.attachedTaskRefs,
        tasks: this.getActiveTasks(),
        initialRole: this.preferredRole,
        initialDraft: this.draftByWorkspace.get(wsId) ?? '',
        daemonOutdated: this.isDaemonOutdated(),
        onDraftChanged: draft => {
          this.draftByWorkspace.set(wsId, draft)
        },
        onRoleChanged: role => {
          this.preferredRole = role
        },
        onTaskSettled: () => {
          void (async () => {
            if (!this.activeWorkspace || this.activeWorkspace.id !== wsId) return
            const [tree] = await Promise.all([
              this.opts.client.workspaceTree(wsId, this.activeRepo).catch(() => null),
              this.reloadArtifactsOnly(),
              this.reloadDiffOnly(),
            ])
            if (tree && this.activeWorkspace?.id === wsId) {
              this.rawTreeEntries = tree.entries
              this.treeEntries = applySyncModeFilter(tree.entries, this.entitlements)
              this.renderTreeOnly()
            }
            if (this.activeWorkspace?.id === wsId) {
              this.renderVcsBarOnly()
            }
          })()
        },
        onClearTasks: () => {
          this.taskHistoryByWorkspace.set(wsId, [])
        },
        onSendOutputToCanvas: (task, outputText) => {
          void this.openAgentOutputInCanvas(task, outputText)
        },
        onRemoveAttachedRef: refPath => {
          const idx = this.attachedTaskRefs.indexOf(refPath)
          if (idx >= 0) {
            this.attachedTaskRefs.splice(idx, 1)
            this.renderTreeOnly()
          }
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
        this.activeDrawer === 'approvals' ? 'Policy Approvals' : 'Aegis OS Doctor & CLIs'
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
