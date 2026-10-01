# `@globaltypesystem/gts-ts` as the validation source of truth

## Current state

gts-ts now owns parsing, entity extraction, schema meta-validation, instance
validation, derivation, traits, modifiers, formats, `$ref` resolution, and
`x-gts-ref` validation. gts-kit consumes the structured results and only maps
JSON Pointer paths to editor ranges.

`packages/shared` depends on the official `@globaltypesystem/gts-ts` NPM
package (`^0.8.1`).

## Added gts-ts APIs

### Structured validation issues

`ValidationResult` retains every existing field and adds an optional array:

```ts
interface ValidationIssue {
  instancePath: string
  schemaPath: string
  keyword: string
  message: string
  params: Record<string, unknown>
  data?: unknown
}

interface ValidationResult {
  id: string
  ok: boolean
  valid?: boolean
  error: string
  is_wildcard?: boolean
  errors?: ValidationIssue[]
}
```

The legacy joined `error` string remains unchanged for compatibility. Structured
issues are returned for JSON Schema assertions, schema meta-validation,
derivation constraints, traits, abstract instances, and `x-gts-ref` failures.

### Full schema validation

`GtsStore.validateSchema(id)` and `GTS.validateSchema(id)` combine:

- JSON Schema meta-validation;
- document-level GTS rules;
- derivation compatibility;
- trait validation;
- GTS `$ref` resolution;
- `x-gts-ref` declaration, existence, and transitive validity checks.

The additive `validateSchemaAsync` and `validateInstanceAsync` methods provide
Promise-based entry points without changing synchronous APIs.

### JSON Schema dialects

Validation selects the correct Ajv implementation for Draft 7, Draft 2019-09,
and Draft 2020-12. Equivalent HTTP/HTTPS and trailing-fragment dialect URLs are
normalized internally. Registered schemas remain available for synchronous GTS
`$ref` resolution in the matching dialect registry.

### File parsing

gts-ts exports:

- `isYamlFileName`;
- `parseJSONC` / `tryParseJSONC`;
- `parseYAML` / `tryParseYAML`;
- `parseGtsFileContent`;
- `parseGtsFile`.

JSONC comments and trailing commas are supported. YAML selection is based on the
`.yaml` or `.yml` extension. `parseGtsFile` returns parsed content and
`JsonEntity` values without registering them.

## Removed from gts-kit

`packages/shared/src/registry.ts` no longer contains or invokes:

- a local Ajv instance or schema loader;
- local format registration and temporal-format composition;
- local `x-gts-ref` stripping/combinator normalization;
- local Ajv error formatting;
- local abstract-instance checks;
- local `x-gts-ref` instance validation;
- derivation error-string parsing and schema-property path reconstruction.

Direct `ajv` and `ajv-formats` dependencies were removed from all gts-kit
package manifests. Shared JSONC/YAML helpers now re-export the gts-ts parsers.

## Responsibilities that remain in gts-kit

These are application/editor concerns rather than duplicated schema validation:

- mapping `ValidationIssue.instancePath` to JSONC/YAML source ranges;
- choosing whether a diagnostic underlines a key or a value;
- maintaining the reverse dependency graph used for incremental revalidation;
- enforcing and positioning the gts-kit-specific `gts://` field-placement
  diagnostic;
- reporting general GTS references found outside schema assertion contexts;
- relaying host-side validation results into CSP-restricted VS Code webviews.

The gts-ts Ajv engine still uses generated validator functions, so validation
continues to run in Node/extension-host contexts rather than inside the VS Code
webview.
