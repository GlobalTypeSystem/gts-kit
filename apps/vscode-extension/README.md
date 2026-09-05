# Global Type System (GTS) — VS Code Extension

Browse, validate, visualize, and manage [GTS](https://github.com/globaltypesystem/gts-spec) (Global Type System) schemas and instances directly in VS Code -based IDEs.

## What is GTS?

The **Global Type System** (GTS) is a specification for human-readable, globally unique identifiers for data type definitions (JSON Schemas) and data instances (JSON objects). Every identifier encodes vendor, package, namespace, type, and version in a single string:

```
gts.<vendor>.<package>.<namespace>.<type>.v<MAJOR>[.<MINOR>]
```

Unlike opaque UUIDs or URL-based identifiers, GTS IDs are immediately comprehensible in logs, traces, and code. They tell you at a glance *who* defined a type, *what domain* it belongs to, and *which version* you are looking at—making them ideal for ABAC (Attribute-Based Access Control) policies, runtime access checks, and database queries that filter by vendor, package, or type lineage.

GTS supports **type derivation** through chaining: a derived type extends a base type and inherits its schema, while an instance declares which concrete type it conforms to. The chain is expressed in the identifier itself using `~` as a separator, so the full lineage is always visible.

### Example: Users

**1. Base type** -- defines the common fields every user has:

```jsonc
// file: gts.x.core.idp.user.v1~.schema.json
{
  "$id": "gts://gts.x.core.idp.user.v1~",
  "$schema": "http://json-schema.org/draft-07/schema#",
  "x-gts-abstract": true,
  "title": "User (Base)",
  "type": "object",
  "required": ["id", "type", "email", "display_name", "status"],
  "properties": {
    "id":           { "type": "string", "format": "uuid" },
    "type":         { "type": "string", "x-gts-ref": "/$id" },
    "email":        { "type": "string", "format": "email" },
    "display_name": { "type": "string" },
    "properties":   { "type": "object" }
  }
}
```

**2. Derived type** -- extends the base with admin-specific fields. The chained `$id` shows that `platform_admin` inherits from `user`:

```jsonc
// file: gts.x.core.idp.user.v1~x.core.idp.platform_admin.v1~.schema.json
{
  "$id": "gts://gts.x.core.idp.user.v1~x.core.idp.platform_admin.v1~",
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "Platform Administrator",
  "type": "object",
  "allOf": [
    { "$ref": "gts://gts.x.core.idp.user.v1~" },
    {
      "properties": {
        "type": { "const": "gts.x.core.idp.user.v1~x.core.idp.platform_admin.v1~" },
        "properties": {
          "type": "object",
          "required": ["mfa_enabled"],
          "properties": {
            "mfa_enabled":  { "type": "boolean" },
            "admin_notes":  { "type": "string", "maxLength": 1000 }
          }
        }
      }
    }
  ]
}
```

**3. Instance** -- a concrete platform administrator that conforms to the derived type:

```jsonc
// file: gts.x.core.idp.user.v1~x.core.idp.platform_admin.v1~.examples.jsonc
{
  "id": "f0e1d2c3-b4a5-6789-0123-456789abcdef",
  "type": "gts.x.core.idp.user.v1~x.core.idp.platform_admin.v1~",
  "email": "admin@example.com",
  "display_name": "Alice Admin",
  "status": "active",
  "properties": {
    "mfa_enabled": true,
    "admin_notes": "Primary infrastructure admin."
  }
}
```

The extension validates each of these files: it checks that the instance conforms to the derived type schema, that the derived type is compatible with the base type, and that every GTS ID reference resolves to an existing entity in the project.

See the full [GTS Specification](https://github.com/globaltypesystem/gts-spec) for details on the identifier format, type derivation rules, versioning, query language, and access control.

## GTS VS Code Extension

### Key Features

- **Visual Diagram** — Interactive graph of GTS schemas, instances, and their relationships
- **Schema & Instance Validation** — Real-time validation of JSON/JSONC/YAML/GTS files against GTS schemas with inline diagnostics (errors, squiggly underlines) in the Problems panel
- **GTS ID Validation** — Verify GTS identifier syntax, detect misprints, and suggest corrections
- **Jump to Entity** — Click a GTS ID to navigate to the entity's source file; peek references across the project
- **Inline Decorations** — Color-coded chips for schema and instance segments in GTS identifiers
- **Code Actions** — Quick fixes for common GTS ID issues
- **Auto-Discovery** — Scans the workspace for all `.json`, `.jsonc`, `.yaml`, `.yml`, and `.gts` files
- **Context Menu & Command Palette** — Right-click a file or run **GTS: Open Viewer**
- **Layout Persistence** — Save and share diagram layouts via `.gts-viewer/` in your workspace

### Getting Started

#### Open the Viewer

1. **Context Menu** — Right-click any `.json`, `.jsonc`, or `.gts` file in the Explorer and select **"GTS: Open Viewer"**
2. **Command Palette** — Press `Cmd+Shift+P` / `Ctrl+Shift+P`, type **GTS: Open Viewer**, and press Enter

#### Supported File Types

- **`.json`** — Standard JSON (schemas and instances)
- **`.jsonc`** — JSON with Comments (single-line, multi-line, trailing commas)
- **`.yaml` / `.yml`** — YAML files parsed and treated identically to JSON
- **`.gts`** — GTS-specific files

### Validation

The extension validates GTS files automatically as you open, edit, and save them.

#### What is Validated

- **JSON / JSONC / YAML syntax** — Parse errors are reported inline
- **GTS schema validation** — Instance documents are validated against their corresponding GTS schemas
- **GTS ID format** — Identifiers are checked against the GTS naming convention (`gts.<VENDOR>.<PACKAGE>.<NAMESPACE>.<TYPE>.v<MAJ>`)
- **Cross-references** — Referenced GTS IDs are verified to exist in the project; similar IDs are suggested for misprints

#### Where to See Errors

- **Problems panel** (`View > Problems`) — All validation errors across the workspace
- **Inline underlines** — Red squiggly underlines on the exact error location in the editor
- **Hover tooltips** — Hover over an underlined range to see the error message

### Layout Management

#### Viewing Layouts

When you open a file, the extension automatically:
1. Loads the file content
2. Checks for an existing saved layout in `.gts-viewer/`
3. Displays the visual diagram with your saved layout (if available)

#### Saving Layouts

After arranging nodes in the diagram, click **"Save Layout"**. The layout is saved to `.gts-viewer/` in your workspace root.

```
your-workspace/
├── .gts-viewer/           # Layout storage directory
│   ├── schema1_layout.json
│   ├── instance1_layout.json
│   └── ...
├── your-json-files/
└── ...
```

#### Version Control

To share layouts with your team, commit the `.gts-viewer/` folder:
```bash
git add .gts-viewer/
git commit -m "Add GTS layout configurations"
```

To keep layouts local only:
```bash
echo ".gts-viewer/" >> .gitignore
```

### Usage Tips

#### Keyboard Navigation
- **Shift + Arrow Up/Down** — Switch between files in the file list

#### Diagram Interactions
- **Drag nodes** — Reposition schema and instance nodes
- **Zoom** — Mouse wheel or pinch gesture
- **Pan** — Click and drag the canvas background
- **Expand/Collapse** — Click nodes to expand or collapse details

### Troubleshooting

#### Extension Not Loading
1. Check the Output panel (select **GTS** from dropdown) for error messages
2. Ensure `npm run build:vscode` completed successfully
3. Verify a workspace folder is open (required for layout storage)

#### File Not Parsing
- Ensure the file contains valid JSON, JSONC, or YAML
- Check for syntax errors — look for red underlines or the Problems panel

#### Layout Not Saving
- Check that you have write permissions in your workspace
- Verify the workspace folder is not read-only

## Requirements

- VS Code 1.85.0 or higher (also works in Cursor, Windsurf, Devin Desktop, Antigravity)
- A workspace folder must be open

## Feedback & Issues

Found a bug or have a feature request? Please open an issue on the [GitHub repository](https://github.com/GlobalTypeSystem/gts-kit/issues).

## License

Apache License 2.0 — see [LICENSE](https://github.com/GlobalTypeSystem/gts-kit/blob/main/LICENSE) in the repository root.
