# Changelog

All notable changes to the GTS Viewer extension will be documented in this file.

## [1.0.0] - 2025-10-08

### Added
- **Context Menu Integration**: Right-click `.json` and `.gts` files to preview layouts
- **Visual Layout Viewer**: Interactive diagram showing JSON schemas and instances
- **Layout Persistence**: Save and load custom layouts from workspace `.gts-viewer/` folder
- **Dual Panel View**: File opens in editor (left) with preview panel (right)
- **Welcome Message**: First-time user guidance
- **Auto-detection**: Automatic file validation for supported formats

### Features
- Support for `.json` and `.gts` file types
- RepoLayoutStorage integration for team-shared layouts
- Version control friendly layout storage
- Error handling with user-friendly messages
- Webview-based rendering for rich visual experience

### Commands
- `GTS: Preview Layout` - Open selected file in visual viewer
- `GTS: Open Viewer` - Show usage instructions

### Context Menu Locations
- Explorer context menu (right-click files)
- Editor title context menu

## [Unreleased]

### Planned
- Multi-file comparison view
- Layout templates
- Export to image/SVG
- Search and filter capabilities
- Enhanced keyboard shortcuts
