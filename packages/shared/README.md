# @gts/shared

Shared GTS models, parsing, and the `JsonRegistry` used by every app (web,
server, electron, VS Code) to index and validate GTS entities.

## How files are recognized as GTS entity sources

`isGtsCandidateFileName` accepts `.json`, `.jsonc`, `.gts`, `.yaml`, and `.yml`.
How a file's contents are interpreted depends on its extension:

- **JSON / JSONC / .gts** — the document is either a **single entity** or a
  **top-level array of entities**. Nothing else is scanned; any GTS id that
  appears elsewhere is treated as a *reference*.

- **YAML** — everything above, **plus** inline definitions. A YAML config file
  may *define* GTS types/instances inline under any nested `entities:` array
  (for example a service's `types-registry.config.entities` seed block), even
  when it is buried several levels deep inside otherwise-non-GTS config. Each
  element of such an array is registered as a real definition (keyed by its
  `$id`), so its `$id` is treated as a **definition**, not as a dangling
  reference.

This YAML-only rule exists because runtime config files legitimately seed GTS
types inline. Without it, every inline `$id` was harvested by the generic id
walker and reported as `GTS reference not found`. Non-GTS entries under an
`entities:` array are ignored automatically (they fail the `isGtsEntity` gate).

See `collectInlineEntityDefinitions` and `processFileContent` in
`src/registry.ts`.
