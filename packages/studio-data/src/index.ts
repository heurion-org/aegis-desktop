/**
 * V1.5 Data Studio interfaces & offline tabular analytics / ArtifactEmbed runtime.
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

export * from './tabular.ts'
export * from './producer.ts'
export * from './data-view.ts'
