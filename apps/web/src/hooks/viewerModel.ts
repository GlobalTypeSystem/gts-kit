import type { JsonRegistry, JsonObj, JsonSchema, JsonFile } from '@gts/shared'

export class ViewerModel {
  registry: JsonRegistry
  version: number
  loading: boolean
  error: string | null
  reload: () => Promise<void>
  chooseDirectory: () => Promise<void>
  needsDirectory: boolean
  progress?: { processed: number; total: number } | null
  initialSelectedId?: string | null

  constructor(params: {
    registry: JsonRegistry
    version: number
    loading: boolean
    error: string | null
    reload: () => Promise<void>
    chooseDirectory: () => Promise<void>
    needsDirectory: boolean
    progress?: { processed: number; total: number } | null
    initialSelectedId?: string | null
  }) {
    this.registry = params.registry
    this.version = params.version
    this.loading = params.loading
    this.error = params.error
    this.reload = params.reload
    this.chooseDirectory = params.chooseDirectory
    this.needsDirectory = params.needsDirectory
    this.progress = params.progress
    this.initialSelectedId = params.initialSelectedId ?? null
  }

  getJsonObjs(): JsonObj[] {
    const arr = Array.from(this.registry.jsonObjs.values())
    arr.sort((a, b) => (a.file?.name || a.id).localeCompare(b.file?.name || b.id))
    return arr
  }

  getJsonSchemas(): JsonSchema[] {
    const arr = Array.from(this.registry.jsonSchemas.values())
    arr.sort((a, b) => (a.file?.name || a.id).localeCompare(b.file?.name || b.id))
    return arr
  }

  getInvalidFiles(): JsonFile[] {
    const arr = Array.from(this.registry.invalidFiles.values())
    arr.sort((a, b) => a.name.localeCompare(b.name))
    return arr
  }
}
