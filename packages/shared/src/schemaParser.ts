import { isGtsId, isGtsType as checkGtsType, isGtsObj as checkGtsObj, normalizeGtsId } from '@gts/shared'

export interface PropertyInfo {
  name: string
  type: string
  value?: any
  required?: boolean
  description?: string
  children?: PropertyInfo[]
  isGtsType?: boolean
  isGtsObj?: boolean
}

export function parseJsonToProperties(data: any, name = 'root'): PropertyInfo[] {
  if (data === null || data === undefined) {
    return [{
      name,
      type: data === null ? 'null' : 'undefined',
      value: data
    }]
  }

  if (typeof data !== 'object') {
    return [{
      name,
      type: typeof data,
      value: data
    }]
  }

  if (Array.isArray(data)) {
    const children: PropertyInfo[] = data.map((item, index) => {
      if (typeof item === 'object' && item !== null) {
        return {
          name: `[${index}]`,
          type: Array.isArray(item) ? 'array' : 'object',
          children: parseJsonToProperties(item, `[${index}]`)
        }
      } else {
        return {
          name: `[${index}]`,
          type: getJsonType(item),
          value: item
        }
      }
    })

    if (name === 'root') {
      return children
    }
    return [{
      name,
      type: 'array',
      children
    }]
  }

  // Object - directly return the properties without creating a wrapper
  const children: PropertyInfo[] = Object.entries(data).map(([key, value]) => {
    if (typeof value === 'object' && value !== null) {
      if (Array.isArray(value)) {
        return {
          name: key,
          type: 'array',
          children: value.map((item, index) => {
            if (typeof item === 'object' && item !== null) {
              return {
                name: `[${index}]`,
                type: Array.isArray(item) ? 'array' : 'object',
                children: parseJsonToProperties(item, `[${index}]`)
              }
            } else {
              return {
                name: `[${index}]`,
                type: getJsonType(item),
                value: item
              }
            }
          })
        }
      } else {
        // Schema-like object inside arbitrary JSON (e.g., under x-*): delegate entirely to parseSchemaToProperties
        const looksSchemaLike = (o: any) => !!(o && (o.$ref || o.type || o.allOf || o.oneOf || o.anyOf || o.properties || o.items || o.enum || o.const))
        if (looksSchemaLike(value)) {
          const wrapped = parseSchemaToProperties({ properties: { [key]: value } })
          const prop = wrapped.find(p => p.name === key)
          if (prop) return prop
          // Fallback if parsing did not return the property for some reason
          return {
            name: key,
            type: getSchemaType(value),
            children: getSchemaChildren(value)
          }
        }

        // For plain nested objects, use recursive parsing without any x-gts-ref special handling
        return {
          name: key,
          type: 'object',
          children: parseJsonToProperties(value, key)
        }
      }
    } else {
      return {
        name: key,
        type: getJsonType(value),
        value: value
      }
    }
  })

  return children
}

export function parseSchemaToProperties(schema: any): PropertyInfo[] {
  if (!schema || typeof schema !== 'object') {
    return []
  }

  const properties: PropertyInfo[] = []

  // Show extension annotations (x-*) as regular fields
  Object.entries(schema)
    .filter(([key]) => key.startsWith('x-'))
    .forEach(([key, value]) => {
      const childProps = typeof value === 'object' && value !== null
        ? parseJsonToProperties(value, key)
        : [{ name: 'value', type: typeof value, value}]

      properties.push({
        name: key,
        type: Array.isArray(value) ? 'array' : typeof value === 'object' ? 'object' : typeof value,
        children: childProps
      })
    })

  // Handle schema properties
  if (schema.properties) {
    const required = schema.required || []

    Object.entries(schema.properties).forEach(([key, prop]: [string, any]) => {
      let description = prop.description
      let isGtsType = false
      let isGtsObj = false

      // Add $ref information to description (normalize to strip gts:// prefix per GTS spec)
      if (prop.$ref) {
        const normalizedRef = normalizeGtsId(prop.$ref)
        const refDescription = `Ref: ${normalizedRef}`
        description = description ? `${description}\n${refDescription}` : refDescription
        if (checkGtsType(normalizedRef)) isGtsType = true
        if (isGtsId(normalizedRef)) isGtsObj = true
      }

      // Add pattern information
      if (prop.pattern) {
        const patDescription = `Pattern: ${prop.pattern}`
        description = description ? `${description}\n${patDescription}` : patDescription
      }

      if (prop['x-gts-ref']) {
        const gtsTypeDescription = `GTS Type: ${prop['x-gts-ref']}`
        description = description ? `${description}\n${gtsTypeDescription}` : gtsTypeDescription
        isGtsType = true
      }

      properties.push({
        name: key,
        type: getSchemaType(prop),
        required: required.includes(key),
        description,
        children: getSchemaChildren(prop),
        isGtsType,
        isGtsObj
      })
    })
  }

  // Handle allOf, oneOf, anyOf
  if (schema.allOf) {
    schema.allOf.forEach((subSchema: any, index: number) => {

      const subProperties = parseSchemaToProperties(subSchema)
      let description = subSchema.description
      let isGtsType = false
      let isGtsObj = false

      // Normalize $ref to strip gts:// prefix per GTS spec
      const normalizedRef = subSchema.$ref ? normalizeGtsId(subSchema.$ref) : undefined

      // Add schema title or $ref information
      if (subSchema.title) {
        const titleDescription = `Schema: ${subSchema.title}`
        description = description ? `${description}\n${titleDescription}` : titleDescription
        if (normalizedRef && checkGtsType(normalizedRef)) isGtsType = true
      }

      if (normalizedRef) {
        const refDescription = `Ref: ${normalizedRef}`
        description = description ? `${description}\n${refDescription}` : refDescription
        if (checkGtsType(normalizedRef)) isGtsType = true
        if (checkGtsObj(normalizedRef)) isGtsObj = true
      }

      properties.push({
        name: `allOf[${index}]`,
        type: 'schema',
        description,
        children: subProperties,
        isGtsType,
        isGtsObj
      })
    })
  }

  if (schema.oneOf) {
    schema.oneOf.forEach((subSchema: any, index: number) => {
      const subProperties = parseSchemaToProperties(subSchema)
      let description = subSchema.description

      // Normalize $ref to strip gts:// prefix per GTS spec
      const normalizedRef = subSchema.$ref ? normalizeGtsId(subSchema.$ref) : undefined

      // Add schema title or $ref information
      if (subSchema.title) {
        const titleDescription = `Schema: ${subSchema.title}`
        description = description ? `${description}\n${titleDescription}` : titleDescription
      }
      if (normalizedRef) {
        const refDescription = `Ref: ${normalizedRef}`
        description = description ? `${description}\n${refDescription}` : refDescription
      }

      properties.push({
        name: `oneOf[${index}]`,
        type: 'schema',
        description,
        children: subProperties
      })
    })
  }

  if (schema.anyOf) {
    schema.anyOf.forEach((subSchema: any, index: number) => {
      const subProperties = parseSchemaToProperties(subSchema)
      let description = subSchema.description

      // Normalize $ref to strip gts:// prefix per GTS spec
      const normalizedRef = subSchema.$ref ? normalizeGtsId(subSchema.$ref) : undefined

      // Add schema title or $ref information
      if (subSchema.title) {
        const titleDescription = `Schema: ${subSchema.title}`
        description = description ? `${description}\n${titleDescription}` : titleDescription
      }
      if (normalizedRef) {
        const refDescription = `Ref: ${normalizedRef}`
        description = description ? `${description}\n${refDescription}` : refDescription
      }

      properties.push({
        name: `anyOf[${index}]`,
        type: 'schema',
        description,
        children: subProperties
      })
    })
  }

  // Handle array items
  if (schema.type === 'array' && schema.items) {
    const itemProperties = parseSchemaToProperties(schema.items)
    if (itemProperties.length > 0) {
      properties.push({
        name: 'items',
        type: 'schema',
        children: itemProperties
      })
    }
  }

  return properties
}

function getJsonType(value: any): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

function getSchemaType(schema: any): string {
  if (schema.$ref) {
    return '$ref'
  }

  if (schema.type) {
    if (Array.isArray(schema.type)) {
      return schema.type.join(' | ')
    }
    return schema.type
  }

  if (schema.enum) {
    return 'enum'
  }

  if (schema.const !== undefined) {
    return 'const'
  }

  if (schema.allOf) return 'allOf'
  if (schema.oneOf) return 'oneOf'
  if (schema.anyOf) return 'anyOf'

  return 'unknown'
}

function getSchemaChildren(schema: any): PropertyInfo[] | undefined {
  // Handle $ref - don't expand children for references, let the description show the reference
  if (schema.$ref) {
    return undefined
  }

  if (schema.type === 'object' && schema.properties) {
    return parseSchemaToProperties(schema)
  }

  if (schema.type === 'array' && schema.items) {
    return parseSchemaToProperties(schema.items)
  }

  if (schema.enum) {
    return schema.enum.map((value: any, index: number) => ({
      name: `[${index}]`,
      type: typeof value,
      value
    }))
  }

  if (schema.const !== undefined) {
    return [{
      name: 'value',
      type: typeof schema.const,
      value: schema.const
    }]
  }

  // Handle allOf, oneOf, anyOf in children
  if (schema.allOf || schema.oneOf || schema.anyOf) {
    return parseSchemaToProperties(schema)
  }

  return undefined
}

/**
 * Locate the JSON Pointer instancePath of a property within a schema document
 * (including inside allOf branches or top-level properties).
 */
export function findSchemaPropertyPath(content: any, propPath: string): string | null {
  if (!content || typeof content !== 'object') return null
  const parts = propPath.split('.')

  function walk(node: any, currentPath: string): string | null {
    if (!node || typeof node !== 'object') return null

    if (node.properties && typeof node.properties === 'object') {
      let cur = node.properties
      let curPath = currentPath ? `${currentPath}/properties` : '/properties'
      let found = true
      for (let i = 0; i < parts.length; i++) {
        const p = parts[i]
        if (cur && cur[p] !== undefined) {
          curPath += `/${p}`
          cur = cur[p]
        } else if (cur && cur.properties && cur.properties[p] !== undefined) {
          curPath += `/properties/${p}`
          cur = cur.properties[p]
        } else if (cur && cur.items && p === 'items') {
          curPath += '/items'
          cur = cur.items
        } else {
          found = false
          break
        }
      }
      if (found) return curPath
    }

    if (Array.isArray(node.allOf)) {
      for (let i = 0; i < node.allOf.length; i++) {
        const branchPath = currentPath ? `${currentPath}/allOf/${i}` : `/allOf/${i}`
        const res = walk(node.allOf[i], branchPath)
        if (res) return res
      }
    }

    return null
  }

  return walk(content, '')
}

/**
 * Locate the JSON Pointer instancePath of the `x-gts-ref` keyword whose value
 * equals `refValue` (any `gts://` prefix ignored), searching every position in
 * the schema document. Used to anchor a "Referenced x-gts-ref entity '<id>' is
 * invalid" diagnostic to the offending `x-gts-ref` node rather than the
 * document root. Returns null when no matching `x-gts-ref` is present.
 */
export function findXGtsRefPath(content: any, refValue: string): string | null {
  const target = normalizeGtsId(refValue)

  function walk(node: any, currentPath: string): string | null {
    if (!node || typeof node !== 'object') return null
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) {
        const res = walk(node[i], `${currentPath}/${i}`)
        if (res) return res
      }
      return null
    }
    for (const [key, value] of Object.entries(node)) {
      const childPath = `${currentPath}/${key}`
      if (key === 'x-gts-ref' && typeof value === 'string' && normalizeGtsId(value) === target) {
        return childPath
      }
      const res = walk(value, childPath)
      if (res) return res
    }
    return null
  }

  return walk(content, '')
}

/**
 * Locate the JSON Pointer instancePath to anchor a trait-completeness error
 * (OP#13) on. When `traitName` is a required trait declared in this document's
 * top-level `x-gts-traits-schema`, point at that specific `required` entry
 * (e.g. `/x-gts-traits-schema/required/0`); otherwise fall back to the
 * `x-gts-traits-schema` node. Returns null when the document has no local
 * `x-gts-traits-schema` (the requirement came from an ancestor in the chain),
 * so callers can fall back to `/$id`.
 */
export function findTraitRequiredPath(content: any, traitName?: string): string | null {
  const traitSchema = content && typeof content === 'object' ? content['x-gts-traits-schema'] : undefined
  if (!traitSchema || typeof traitSchema !== 'object' || Array.isArray(traitSchema)) return null
  if (traitName && Array.isArray(traitSchema.required)) {
    const idx = traitSchema.required.indexOf(traitName)
    if (idx >= 0) return `/x-gts-traits-schema/required/${idx}`
  }
  return '/x-gts-traits-schema'
}

/**
 * Navigate a JSON Schema to the subschema that governs the value at a given
 * *instance* source path (dot/bracket notation as produced by the reference
 * walker, e.g. "uuidValue", "contact.gtsIid", "items[0].sku"). Follows
 * `properties`, array `items` (single-schema or tuple), and searches
 * `allOf`/`anyOf`/`oneOf` branches.
 *
 * Returns the subschema, or null when it cannot be resolved locally (e.g. the
 * field is an `additionalProperties` value or is inherited from an ancestor
 * schema not present in this document) — callers should treat null
 * conservatively rather than assuming the field is unconstrained.
 */
export function getInstanceFieldSubschema(schemaContent: any, sourcePath: string): any | null {
  if (!schemaContent || typeof schemaContent !== 'object') return null
  if (!sourcePath || sourcePath === 'root') return null

  const segments = sourcePath
    .replace(/\[(\d+)\]/g, '.$1') // arr[0] -> arr.0
    .split('.')
    .filter(s => s.length > 0)

  function resolveKey(node: any, key: string, depth: number): any | null {
    if (!node || typeof node !== 'object' || depth > 20) return null
    const isIndex = /^\d+$/.test(key)
    if (isIndex) {
      if (node.items !== undefined) {
        return Array.isArray(node.items) ? (node.items[Number(key)] ?? null) : node.items
      }
    } else if (node.properties && typeof node.properties === 'object' && node.properties[key] !== undefined) {
      return node.properties[key]
    }
    for (const comb of ['allOf', 'anyOf', 'oneOf'] as const) {
      if (Array.isArray(node[comb])) {
        for (const branch of node[comb]) {
          const res = resolveKey(branch, key, depth + 1)
          if (res) return res
        }
      }
    }
    return null
  }

  let current: any = schemaContent
  for (const seg of segments) {
    current = resolveKey(current, seg, 0)
    if (!current || typeof current !== 'object') return null
  }
  return current
}
