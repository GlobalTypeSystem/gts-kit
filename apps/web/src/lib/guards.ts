// Type guards for entity checking
import type { WebJsonEntity, JsonSchema, JsonObj } from './entities'

export function isSchema(entity: WebJsonEntity | JsonSchema | JsonObj): entity is JsonSchema {
  return 'isSchema' in entity && entity.isSchema === true
}

export function isJsonObj(entity: WebJsonEntity | JsonSchema | JsonObj): entity is JsonObj {
  return !isSchema(entity)
}

// Deep equality check for objects
export function deepEqual(obj1: any, obj2: any): boolean {
  if (obj1 === obj2) return true
  if (obj1 == null || obj2 == null) return false
  if (typeof obj1 !== 'object' || typeof obj2 !== 'object') return false

  const keys1 = Object.keys(obj1)
  const keys2 = Object.keys(obj2)

  if (keys1.length !== keys2.length) return false

  return keys1.every(key => {
    const val1 = obj1[key]
    const val2 = obj2[key]

    if (typeof val1 === 'object' && typeof val2 === 'object') {
      return deepEqual(val1, val2)
    }

    return val1 === val2
  })
}
