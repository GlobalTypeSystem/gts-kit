# Changelog

All notable changes to the GTS web app will be documented in this file.

## [Unreleased]

## [0.2.7] - 2026-09-16

### Added
- Dependent entities are revalidated automatically when a file changes

### Fixed
- GTS validation errors are now surfaced across the VS Code viewer
- Stale files are invalidated after parse errors
- Removed a deprecated TypeScript base URL and corrected the TypeScript ESLint preset

## [0.2.6] - 2026-09-07

### Added
- Diagnostics shown when the web server isn't running
- Progress bar for large repo scans

### Fixed
- Compact UI layout for the VS Code webview; validation errors now wrap properly

## [0.2.5] - 2026-09-06

_No web-specific changes; released alongside the rest of the suite._

## [0.2.4] - 2026-09-06

### Added
- YAML file format support
- Schema examples preview feature
- All/errors/valid entities selector in the GTS viewer

### Changed
- Rebased schema validation on `gts-ts`
- Made `config.schema_if_fields` consistent with the gts-rust and gts-go implementations

### Fixed
- Removed duplicated validation errors in the GTS viewer

## [0.2.1] - 2025-10-22

### Added
- Open the file containing a GTS node directly from the VS Code editor
- Neutral file link color (blue was reserved for "schema" elsewhere)

### Changed
- Cumulative visual style polish for the web view
- Improved invalid GTS format error display

### Fixed
- Popup GTS error display position
- Color annotations for broken GTS IDs
- Removed the redundant file link in the VS Code web viewer

## [0.2.0] - 2025-10-19

### Changed
- Switched the backing store from `better-sqlite3` to `sql.js` (no native compilation required)

## [0.1.0] - 2025-10-16

### Added
- Initial release of the GTS web viewer
