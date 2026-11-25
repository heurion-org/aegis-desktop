import type { DesktopAgentStatus } from './daemon-client.ts'

export type AgentRole = 'coder' | 'writer' | 'analyst' | 'reviewer'

export interface RoleDescriptor {
  id: AgentRole
  label: string
  description: string
  preferredAgents: string[]
}

export const ROLE_CATALOG: RoleDescriptor[] = [
  {
    id: 'coder',
    label: 'Coder',
    description: 'Builds features, refactors modules, and verifies tests inside CoW isolation.',
    preferredAgents: ['opencode', 'claude', 'codex', 'agy'],
  },
  {
    id: 'writer',
    label: 'Writer',
    description: 'Drafts Markdown locally or edits Dual-Surface CRDT docs & slides in Cloud Pro.',
    preferredAgents: ['claude', 'opencode', 'codex', 'agy'],
  },
  {
    id: 'analyst',
    label: 'Analyst',
    description: 'Queries datasets, verifies numbers, and prepares data artifacts for docs.',
    preferredAgents: ['opencode', 'claude', 'codex', 'agy'],
  },
  {
    id: 'reviewer',
    label: 'Reviewer',
    description: 'Audits diffs, citations, security rules, and merge readiness.',
    preferredAgents: ['claude', 'codex', 'opencode', 'agy'],
  },
]

export interface RoleRoutingResolution {
  role: AgentRole
  selectedAgentId: string | null
  ready: boolean
  fallbackReason?: string
}

export function selectAgentForRole(
  role: AgentRole,
  agents: DesktopAgentStatus[],
  overrideAgentId?: string | null,
): RoleRoutingResolution {
  if (overrideAgentId) {
    const exact = agents.find(a => a.id === overrideAgentId)
    if (exact) {
      return {
        role,
        selectedAgentId: exact.id,
        ready: exact.installed,
        fallbackReason: exact.installed ? undefined : `${exact.display_name} is not installed yet.`,
      }
    }
  }

  const descriptor = ROLE_CATALOG.find(r => r.id === role) ?? ROLE_CATALOG[0]!
  for (const candidateId of descriptor.preferredAgents) {
    const found = agents.find(a => a.id === candidateId && a.installed && a.authenticated)
    if (found) return { role, selectedAgentId: found.id, ready: true }
  }
  for (const candidateId of descriptor.preferredAgents) {
    const found = agents.find(a => a.id === candidateId && a.installed)
    if (found) {
      return {
        role,
        selectedAgentId: found.id,
        ready: true,
        fallbackReason: `${found.display_name} installed (authentication status unverified).`,
      }
    }
  }
  const anyInstalled = agents.find(a => a.installed)
  if (anyInstalled) {
    return {
      role,
      selectedAgentId: anyInstalled.id,
      ready: true,
      fallbackReason: `Using ${anyInstalled.display_name} for role ${role}.`,
    }
  }
  const recommended = descriptor.preferredAgents[0] ?? 'opencode'
  return {
    role,
    selectedAgentId: recommended,
    ready: false,
    fallbackReason: `No coding/writing CLI agent installed. Install ${recommended} to run ${role} tasks.`,
  }
}
