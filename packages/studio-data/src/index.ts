/**
 * V1.5 Data Studio interface stub.
 * Keeps the `DataArtifactProducer` and `ArtifactEmbed` contracts strongly typed in V1
 * so `@aegis/studio-writing` and `@heurion/doc-core` can embed table/chart snapshots
 * without bundling a full notebook/spreadsheet runtime in V1.
 */
export interface DataArtifact {
  id: string
  title: string
  kind: 'table_snapshot' | 'chart_svg' | 'kpi_metric'
  version: number
  sourcePath: string
  previewMarkdown: string
  svgMarkup?: string
  updatedAt: string
}

export interface DataArtifactProducer {
  readonly kind: 'studio-data'
  listArtifacts(workspaceId: string): Promise<DataArtifact[]>
  getArtifact(workspaceId: string, artifactId: string): Promise<DataArtifact | null>
}

export function createStubDataProducer(): DataArtifactProducer {
  return {
    kind: 'studio-data',
    async listArtifacts() {
      return []
    },
    async getArtifact() {
      return null
    },
  }
}
