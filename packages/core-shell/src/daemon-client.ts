import type { DesktopEntitlements } from './entitlements.ts'
import type { AgentRole } from './roles.ts'

export interface DesktopConnection {
  protocol: 'aos-desktop/v1'
  port: number
  base_url: string
  human_token: string
}

export interface DesktopHealthResponse {
  status: string
  protocol: string
  version: string
  runtime_dir: string
}

export interface SandboxHealthResponse {
  ready: boolean
  driver: string
  hint: string
  documents_crdt_profile: {
    domain: string
    merge: string
    claims: string
    evidence: string
  }
}

export interface AdapterInstallRecipe {
  macos: string[]
  linux: string[]
  docs_url: string
  notes: string
}

export interface DesktopAgentStatus {
  id: string
  display_name: string
  description: string
  roles: string[]
  installed: boolean
  binary_path: string | null
  version: string | null
  authenticated: boolean
  auth_hint: string
  install_command_for_os: string[]
  install_recipe: AdapterInstallRecipe
}

export type SyncMode = 'local_only' | 'cloud_crdt' | 'cloud_blob'

export interface SyncRule {
  path_prefix: string
  mode: SyncMode
}

export interface SyncPolicy {
  default_mode: SyncMode
  rules: SyncRule[]
}

export interface ChildRepoSummary {
  name: string
  rel_path: string
  path: string
  branch: string | null
}

export interface DesktopWorkspace {
  id: string
  name: string
  org_id: string
  path: string
  mode: 'local' | 'cloud' | string
  is_git_repo?: boolean
  child_repos?: ChildRepoSummary[]
  sync_policy: SyncPolicy
  created_at?: string
}

export interface WorkspaceTreeEntry {
  path: string
  name: string
  is_dir: boolean
  ext: string | null
  sync_mode: SyncMode
  tier_required: 'free' | 'cloud_pro'
}

export interface WorkspaceTreeResponse {
  workspace_id: string
  repo?: string | null
  sync_policy: SyncPolicy
  entries: WorkspaceTreeEntry[]
}

export interface WorkspaceDiffResponse {
  repo?: string | null
  source?: 'cow_shadow' | 'git' | string
  session_id?: string | null
  evidence_hash?: string | null
  is_git_repo?: boolean
  changed_files: string[]
  diff_text: string
}

export interface WorkspaceCommitResponse {
  ok: boolean
  committed: boolean
  source?: string
  session_id?: string | null
  repo?: string | null
  commit_hash?: string | null
  summary: string
}

export interface WorkspaceRollbackResponse {
  ok: boolean
  source?: string
  session_id?: string | null
  repo?: string | null
  restored_paths: string[]
}

export interface DesktopTaskStep {
  seq: number
  kind: string
  summary: string
  detail: string | null
  raw_log: string | null
  timestamp: string
}

export interface DesktopTaskRecord {
  task_id: string
  workspace_id: string
  role: string
  resolved_agent: string
  prompt: string
  status: 'queued' | 'running' | 'completed' | 'failed'
  enforcement?: string
  session_id?: string | null
  steps: DesktopTaskStep[]
  created_at: string
}

export interface TaskEventsResponse {
  task_id: string
  status: string
  events: DesktopTaskStep[]
  next_after: number
}

export interface InstallAgentResponse {
  agent: string
  status: string
  command?: string[]
  docs_url?: string
  stdout?: string
  stderr?: string
  error?: string
}

export interface PendingEscalation {
  escalation_id: string
  org_id: string
  agent_id: string
  action: string
  target_resource: string
  reason: string
  suggested_lease_scope?: string
  status: string
  created_at_ms: number
  task_id?: string | null
  rationale?: string | null
}

export interface DecideApprovalResponse {
  ok: boolean
  decision: 'approved' | 'denied'
  lease?: unknown
  escalation?: PendingEscalation
}

export interface McpInventoryEntry {
  server_id?: string
  name?: string
  transport?: string
  status?: string
  [key: string]: unknown
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

/**
 * Typed HTTP client talking exclusively to the local `aegis-os desktop-daemon` loopback API
 * authenticated with the ephemeral per-session `human_token` Bearer secret.
 */
export class AegisDaemonClient {
  private readonly baseUrl: string
  private readonly token: string
  private readonly fetchImpl: FetchLike

  constructor(connection: DesktopConnection, fetchImpl: FetchLike = globalThis.fetch.bind(globalThis)) {
    this.baseUrl = connection.base_url.replace(/\/+$/, '')
    this.token = connection.human_token
    this.fetchImpl = fetchImpl
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers)
    headers.set('Authorization', `Bearer ${this.token}`)
    if (init.body && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json')
    }
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, { ...init, headers })
    if (!res.ok) {
      const detail = await res.text().catch(() => res.statusText)
      throw new Error(`Daemon request ${init.method ?? 'GET'} ${path} failed (${res.status}): ${detail}`)
    }
    return (await res.json()) as T
  }

  health(): Promise<DesktopHealthResponse> {
    return this.request('/v1/health')
  }

  sandboxHealth(): Promise<SandboxHealthResponse> {
    return this.request('/v1/health/sandbox')
  }

  async listAgents(): Promise<DesktopAgentStatus[]> {
    const res = await this.request<{ agents: DesktopAgentStatus[] }>('/v1/agents')
    return res.agents
  }

  installAgent(agentId: string, dryRun = false): Promise<InstallAgentResponse> {
    return this.request(`/v1/agents/${encodeURIComponent(agentId)}/install`, {
      method: 'POST',
      body: JSON.stringify({ dry_run: dryRun }),
    })
  }

  async listWorkspaces(): Promise<DesktopWorkspace[]> {
    const res = await this.request<{ workspaces: DesktopWorkspace[] }>('/v1/workspaces')
    return res.workspaces
  }

  async openWorkspace(input: {
    name?: string
    path: string
    org_id?: string
    mode?: 'local' | 'cloud'
  }): Promise<DesktopWorkspace> {
    const res = await this.request<{ workspace: DesktopWorkspace }>('/v1/workspaces', {
      method: 'POST',
      body: JSON.stringify(input),
    })
    return res.workspace
  }

  removeWorkspace(workspaceId: string): Promise<{ ok: boolean; removed_id: string }> {
    return this.request(`/v1/workspaces/${encodeURIComponent(workspaceId)}`, {
      method: 'DELETE',
    })
  }

  workspaceTree(workspaceId: string, repo?: string | null): Promise<WorkspaceTreeResponse> {
    const q = repo ? `?${new URLSearchParams({ repo }).toString()}` : ''
    return this.request(`/v1/workspaces/${encodeURIComponent(workspaceId)}/tree${q}`)
  }

  readWorkspaceFile(workspaceId: string, relPath: string): Promise<{ path: string; content: string }> {
    const q = new URLSearchParams({ path: relPath })
    return this.request(`/v1/workspaces/${encodeURIComponent(workspaceId)}/file?${q.toString()}`)
  }

  writeWorkspaceFile(workspaceId: string, relPath: string, content: string): Promise<{ ok: boolean; path: string }> {
    return this.request(`/v1/workspaces/${encodeURIComponent(workspaceId)}/file`, {
      method: 'PUT',
      body: JSON.stringify({ path: relPath, content }),
    })
  }

  workspaceDiff(workspaceId: string, repo?: string | null): Promise<WorkspaceDiffResponse> {
    const q = repo ? `?${new URLSearchParams({ repo }).toString()}` : ''
    return this.request(`/v1/workspaces/${encodeURIComponent(workspaceId)}/diff${q}`)
  }

  commitWorkspace(
    workspaceId: string,
    input: {
      repo?: string | null
      message?: string
      paths?: string[]
      session_id?: string | null
      expected_diff_hash?: string | null
      allow_sensitive?: boolean
    } = {},
  ): Promise<WorkspaceCommitResponse> {
    return this.request(`/v1/workspaces/${encodeURIComponent(workspaceId)}/commit`, {
      method: 'POST',
      body: JSON.stringify(input),
    })
  }

  rollbackWorkspace(
    workspaceId: string,
    input: { repo?: string | null; paths?: string[]; session_id?: string | null } = {},
  ): Promise<WorkspaceRollbackResponse> {
    return this.request(`/v1/workspaces/${encodeURIComponent(workspaceId)}/rollback`, {
      method: 'POST',
      body: JSON.stringify(input),
    })
  }

  async getSyncPolicy(workspaceId: string): Promise<SyncPolicy> {
    const res = await this.request<{ workspace_id: string; sync_policy: SyncPolicy }>(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/sync-policy`,
    )
    return res.sync_policy
  }

  async updateSyncPolicy(workspaceId: string, policy: SyncPolicy): Promise<SyncPolicy> {
    const res = await this.request<{ workspace_id: string; sync_policy: SyncPolicy }>(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/sync-policy`,
      {
        method: 'PATCH',
        body: JSON.stringify(policy),
      },
    )
    return res.sync_policy
  }

  async startTask(
    workspaceId: string,
    input: {
      role: AgentRole
      agent_override?: string | null
      repo?: string | null
      prompt: string
      doc_refs?: string[]
      enforcement?: 'enforced' | 'advisory' | 'isolated' | 'direct'
    },
  ): Promise<DesktopTaskRecord> {
    const res = await this.request<{ task: DesktopTaskRecord }>(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/tasks`,
      {
        method: 'POST',
        body: JSON.stringify(input),
      },
    )
    return res.task
  }

  pollTaskEvents(taskId: string, after = 0, waitMs = 1500): Promise<TaskEventsResponse> {
    const q = new URLSearchParams({ after: String(after), wait_ms: String(waitMs) })
    return this.request(`/v1/tasks/${encodeURIComponent(taskId)}/events?${q.toString()}`)
  }

  async listApprovals(): Promise<{ escalations: PendingEscalation[] }> {
    return this.request('/v1/approvals')
  }

  decideApproval(
    escalationId: string,
    decision: 'approve' | 'deny',
    ttlSecs = 900,
  ): Promise<DecideApprovalResponse> {
    return this.request(`/v1/approvals/${encodeURIComponent(escalationId)}/decide`, {
      method: 'POST',
      body: JSON.stringify({ decision, ttl_secs: ttlSecs }),
    })
  }

  async mcpInventory(): Promise<{ entries: McpInventoryEntry[] }> {
    return this.request('/v1/mcp/inventory')
  }
}

export const MIN_RECOMMENDED_DAEMON_VERSION = '0.12.1'

function parseSemverParts(raw: string | null | undefined): [number, number, number] | null {
  if (!raw) return null
  const m = raw.match(/(\d+)\.(\d+)\.(\d+)/)
  if (!m) return null
  return [Number(m[1]), Number(m[2]), Number(m[3])]
}

/**
 * Returns `true` iff `actual` contains a `major.minor.patch` semver >= `minimum`.
 */
export function isSemverAtLeast(
  actual: string | null | undefined,
  minimum = MIN_RECOMMENDED_DAEMON_VERSION,
): boolean {
  const a = parseSemverParts(actual)
  const b = parseSemverParts(minimum)
  if (!a || !b) return false
  if (a[0] !== b[0]) return a[0] > b[0]
  if (a[1] !== b[1]) return a[1] > b[1]
  return a[2] >= b[2]
}

export function applySyncModeFilter(
  entries: WorkspaceTreeEntry[],
  entitlements: DesktopEntitlements,
): WorkspaceTreeEntry[] {
  if (!entitlements.cloud_yjs_sync) {
    return entries.map(e => ({ ...e, sync_mode: 'local_only' }))
  }
  return entries
}
