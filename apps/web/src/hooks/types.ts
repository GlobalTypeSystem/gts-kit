import type { JsonRegistry } from '@gts/shared'

export interface ViewerData {
  registry: JsonRegistry
  version: number
  loading: boolean
  error: string | null
  reload: () => Promise<void>
  chooseDirectory: () => Promise<void>
  needsDirectory: boolean
  progress?: { processed: number; total: number } | null
  initialSelectedId?: string | null
}
