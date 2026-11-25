export interface ArtifactEmbedRef {
  id: string
  title: string
  kind: string
  version: number
  sourcePath?: string
  previewMarkdown?: string
}

export interface WorkspaceDiffSummary {
  repo?: string | null
  is_git_repo?: boolean
  changed_files: string[]
  diff_text: string
}

export interface WorkspaceCommitResult {
  ok: boolean
  committed?: boolean
  commit_hash?: string | null
  summary?: string
}

export interface WorkspaceRollbackResult {
  ok: boolean
  restored_paths?: string[]
}

/**
 * Host abstraction decoupling `@aegis/studio-writing` from Tauri, Aegis OS,
 * and Data Studio. Both `apps/desktop` and `apps/writing-standalone` provide an
 * implementation of this bridge.
 */
export interface WritingHostBridge {
  readTextFile(workspaceId: string, relPath: string): Promise<string>
  writeTextFile(workspaceId: string, relPath: string, content: string): Promise<void>
  revertTurn?(docId: string, turnId: string): Promise<{ docId: string; reverted: boolean; skipped?: string[] }>
  diffWorkspace?(workspaceId: string): Promise<WorkspaceDiffSummary>
  commitWorkspace?(workspaceId: string, message?: string): Promise<WorkspaceCommitResult>
  rollbackWorkspace?(workspaceId: string): Promise<WorkspaceRollbackResult>
  connectCollabWebSocket?(docId: string): WebSocket | null
  listArtifactEmbeds?(workspaceId: string): Promise<ArtifactEmbedRef[]>
}

export function createInMemoryWritingBridge(initialFiles: Record<string, string> = {}): WritingHostBridge {
  const files = new Map(Object.entries(initialFiles))
  return {
    async readTextFile(_workspaceId, relPath) {
      return files.get(relPath) ?? ''
    },
    async writeTextFile(_workspaceId, relPath, content) {
      files.set(relPath, content)
    },
    async diffWorkspace() {
      return { changed_files: [...files.keys()], diff_text: '' }
    },
    async commitWorkspace() {
      return { ok: true, committed: true }
    },
    async rollbackWorkspace() {
      return { ok: true, restored_paths: [] }
    },
    async listArtifactEmbeds() {
      return []
    },
  }
}
