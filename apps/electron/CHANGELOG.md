# Changelog

All notable changes to the GTS Electron app will be documented in this file.

## [Unreleased]

## [0.3.0] - 2026-09-18

### Changed
- Rebased validation on `gts-ts` v0.7.0 for additional checks

### Fixed
- Reject schema-less `$id` instances
- Prune annotation-only GTS reference branches and skip ID-less YAML containers
- Enforce strict RFC 3339 for date/time formats

## [0.2.6] - 2026-09-07

_Released alongside the rest of the suite._

## [0.2.5] - 2026-09-06

_Released alongside the rest of the suite._

## [0.2.4] - 2026-09-06

### Added
- YAML file format support

### Changed
- Rebased schema validation on `gts-ts`
- Aligned schema handling with GTS spec v0.7

## [0.2.1] - 2025-10-22

_Released alongside the rest of the suite._

## [0.2.0] - 2025-10-19

### Fixed
- Fixed errors on Electron start
- Moved the primary web server port to 7805 and the DB server to 7806 for npm/docker

## [0.1.0] - 2025-10-16

### Added
- Initial release of the GTS Electron viewer
