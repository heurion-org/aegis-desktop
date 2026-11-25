import type { DataArtifact, DataArtifactProducer } from './index.ts'

const STORAGE_PREFIX = 'aegis.desktop.data_artifacts.'

export class LocalDataArtifactProducer implements DataArtifactProducer {
  readonly kind = 'studio-data' as const
  private readonly memory = new Map<string, DataArtifact[]>()

  private readStore(workspaceId: string): DataArtifact[] {
    if (typeof window !== 'undefined' && window.localStorage) {
      try {
        const raw = window.localStorage.getItem(`${STORAGE_PREFIX}${workspaceId}`)
        if (raw) {
          const parsed = JSON.parse(raw) as unknown
          if (Array.isArray(parsed)) return parsed as DataArtifact[]
        }
      } catch {
        // Fallback to memory map
      }
    }
    return this.memory.get(workspaceId) ?? []
  }

  private writeStore(workspaceId: string, items: DataArtifact[]): void {
    this.memory.set(workspaceId, items)
    if (typeof window !== 'undefined' && window.localStorage) {
      try {
        window.localStorage.setItem(`${STORAGE_PREFIX}${workspaceId}`, JSON.stringify(items))
      } catch {
        // Ignore storage quota errors in fallback mode
      }
    }
  }

  async listArtifacts(workspaceId: string): Promise<DataArtifact[]> {
    return [...this.readStore(workspaceId)]
  }

  async getArtifact(workspaceId: string, artifactId: string): Promise<DataArtifact | null> {
    return this.readStore(workspaceId).find(a => a.id === artifactId) ?? null
  }

  async publishArtifact(
    workspaceId: string,
    input: Omit<DataArtifact, 'id' | 'version' | 'updatedAt'>,
  ): Promise<DataArtifact> {
    const items = this.readStore(workspaceId)
    const existingIdx = items.findIndex(
      a => a.title === input.title && a.sourcePath === input.sourcePath && a.kind === input.kind,
    )
    const prev = existingIdx >= 0 ? items[existingIdx]! : null
    const next: DataArtifact = {
      id: prev?.id ?? `art_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      title: input.title,
      kind: input.kind,
      version: (prev?.version ?? 0) + 1,
      sourcePath: input.sourcePath,
      previewMarkdown: input.previewMarkdown,
      svgMarkup: input.svgMarkup,
      updatedAt: new Date().toISOString(),
    }
    if (existingIdx >= 0) {
      items[existingIdx] = next
    } else {
      items.unshift(next)
    }
    this.writeStore(workspaceId, items)
    return next
  }

  async deleteArtifact(workspaceId: string, artifactId: string): Promise<boolean> {
    const items = this.readStore(workspaceId)
    const filtered = items.filter(a => a.id !== artifactId)
    if (filtered.length === items.length) return false
    this.writeStore(workspaceId, filtered)
    return true
  }
}

export function createLocalDataArtifactProducer(): LocalDataArtifactProducer {
  return new LocalDataArtifactProducer()
}
