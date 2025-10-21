# GTS Viewer — VS Code Extension

<img src="./resources/gts_logo.jpeg" alt="GTS Logo" width="50%" />

Visual layout preview for GTS ([Global Type System](https://github.com/globaltypesystem/gts-spec)) JSON schemas and instances. Inspect relationships between schemas and instances with an interactive diagram and save/share custom layouts via your repository.

Key features

- **Visual JSON Preview** — Interactive diagram of JSON schemas, instances and their relationship
- **Explorer / Context Menu** — Right-click a `.json`, `.jsonc` or `.gts` file and choose **GTS: Preview Layout**
- **Command Palette** — Run **GTS: Preview Layout** from the Command Palette
- **Layout Persistence** — Save layouts to `.gts-viewer/` in the workspace
- **Shareable Layouts** — Commit `.gts-viewer` to share layouts across your team

Getting started

There are two ways to preview a JSON or GTS file:

1. **Context Menu (Recommended)**
   - Right-click on any `.json`, `.jsonc` or `.gts` file in the Explorer
   - Select **"GTS: Preview Layout"**
   - The file will open in the editor (left) and the visual preview will appear (right)

2. **Command Palette**
   - Open a `.json`, `.jsonc` or `.gts` file in the editor
   - Press `Cmd+Shift+P` (Mac) or `Ctrl+Shift+P` (Windows/Linux)
   - Type "GTS: Preview Layout" and press Enter

### Supported File Types

The extension works with thre file types:

- **`.json` files** - Standard JSON files that may contain GTS schemas or instances
- **`.jsonc` files** - JSONC files that may contain GTS schemas or instances
- **`.gts` files** - GTS-specific files

**Note:** Only files with valid JSON content can be visualized.

## Layout Management

### Viewing Layouts

When you open a file, the extension automatically:
1. Loads the file content
2. Checks for an existing saved layout in `.gts-viewer/`
3. Displays the visual diagram with your saved layout (if available)

### Saving Layouts

After arranging nodes and edges in the visual diagram:

1. Click the **"Save Layout"** button in the top-right corner
2. The layout is saved to `.gts-viewer/[filename]_layout.json` in your workspace root
3. A confirmation message appears showing where the layout was saved

**Layout Files Location:**
```
your-workspace/
├── .gts-viewer/           # Layout storage directory
│   ├── schema1_layout.json
│   ├── instance1_layout.json
│   └── ...
├── your-json-files/
└── ...
```

### Version Control

The `.gts-viewer` folder can be committed to your repository so that:
- Layouts are shared with your team
- Layout changes are tracked in version control
- Everyone sees the same visual organization

To share layouts with your team, add `.gts-viewer/` to your repository:
```bash
git add .gts-viewer/
git commit -m "Add GTS layout configurations"
```

To keep layouts local only, add to `.gitignore`:
```bash
echo ".gts-viewer/" >> .gitignore
```

## Usage Tips

### Keyboard Navigation
- **Shift + Arrow Up/Down** - Switch between files in the file list
- Navigate the canvas using mouse drag or trackpad gestures

### Diagram Interactions
- **Drag nodes** - Reposition schema and instance nodes
- **Zoom** - Use mouse wheel or pinch gesture to zoom in/out
- **Pan** - Click and drag the canvas background to pan
- **Expand/Collapse** - Click nodes to expand or collapse details

## Troubleshooting

### "No file selected" error
Make sure you right-click on a `.json`, `.jsonc` or `.gts` file, not a folder or other file type.

### "Please open a workspace folder" error
The extension requires an open workspace to save layouts. Open a folder in VSCode first.

### Layout not saving
- Check that you have write permissions in your workspace
- Verify that the workspace folder is not read-only
- Check the VSCode Output panel (select "GTS" from dropdown) for error messages

### File not parsing
- Ensure the file contains valid JSON
- Check for syntax errors in your JSON file
- Look for error messages in the preview panel

## Requirements

- VSCode version 1.85.0 or higher
- A workspace folder must be open
- Files must contain valid JSON content

## Extension Settings

This extension does not currently add any VSCode settings. Configuration is automatic based on your workspace.

## Known Limitations

- Only JSON and GTS files are supported
- Large JSON files (>10MB) may take longer to render
- Complex schemas with many relationships may affect performance

## Feedback & Issues

Found a bug or have a feature request? Please open an issue on our [GitHub repository](https://github.com/globaltypesystem/gts-viewer).

## License

See LICENSE file in the repository root.
