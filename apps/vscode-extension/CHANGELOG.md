# Changelog

All notable changes to the GTS Viewer extension will be documented in this file.

## [Unreleased]

## [0.2.7] - 2026-09-13

## [0.2.6] - 2026-09-07

### Fixed
- Malformed `gts://` schema IDs now surface correctly everywhere instead of failing silently
- Gray chip shown for unresolved GTS IDs in schema examples
- Compact web UI layout for the VS Code webview; validation errors now wrap properly
- `GTS: Open Viewer` now opens the currently selected file

### Added
- Diagnostics shown when the web server isn't running
- A progress bar for large repo scans

## [0.2.5] - 2026-09-06

### Changed
- Renamed extension identifier to `gts-kit` (the `gts` name was already taken on the VS Code Marketplace)
- Reduced packaged extension size

## [0.2.4] - 2026-09-06

### Fixed
- Rebased schema validation on `gts-ts`
- Invalid JSON is now rejected during editor validation
- Removed duplicated validation errors in the GTS viewer
- Consistent YAML parsing across shared registry and editor validation

### Added
- All/errors/valid entities selector in the GTS viewer

## [0.2.3] - 2026-08-31

### Added
- Scoped background validation for unopened GTS files
- GTS brand logo as extension and activity bar icon
- Enforced `gts://` URI prefix rules for JSON Schema fields

### Fixed
- Two-phase prioritized file scan with `.gitignore` exclusion for better performance
- Persisted GTS registry to reduce editor open latency
- Removed redundant margins around GTS string annotations in the editor
- Consistent segment gap width across GTS segment styles

## [0.2.2] - 2026-08-31

### Added
- YAML file format support
- Schema examples preview feature
- NOTICE file with copyright and license information

### Changed
- Aligned schema handling with GTS spec v0.7
- Prioritize the GTS ID (`id`, `gtsId`, etc.) over the `type` field for schema resolution
- Disabled GTS reference validation for `/examples` in schemas

### Fixed
- Slow GTS color annotations on file open
- Popup GTS error display position
- Restored VS Code editor inline validation
- Removed redundant file link in the web viewer

## [0.2.1] - 2025-10-22

### Added
- Open the file containing a GTS node directly from the VS Code editor

### Changed
- Cumulative visual style polish for the web view and VS Code
- Neutral file link color (blue was reserved for "schema" elsewhere)

### Fixed
- Color annotations for broken GTS IDs
- GTS replacement when clicking an auto-suggestion popup
- Rescan JSON files on edits even when the web viewer isn't active

## [0.2.0] - 2025-10-19

### Added
- Inline JSON/JSONC/GTS file validation inside the VS Code editor
- Colored GTS ID validation and suggestions in the editor
- Support for `.jsonc` and `.gts` file extensions

### Changed
- Switched from `better-sqlite3` to `sql.js` (no native compilation required)

## [0.1.0] - 2025-10-16

### Added
- Initial release of the GTS Viewer VS Code extension
