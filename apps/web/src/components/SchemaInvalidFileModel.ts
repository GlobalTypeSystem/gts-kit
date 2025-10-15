import type { JsonFile } from '@gts/shared'

export class SchemaInvalidFileModel {
  file: JsonFile
  id: string

  constructor(file: JsonFile) {
    this.file = file
    this.id = file.path
  }
}
