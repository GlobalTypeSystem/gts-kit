# VSCode Extension - Validation Feature

## Overview

The GTS VSCode extension now provides real-time validation and syntax error highlighting for JSON and GTS files.

## Features

### Automatic Validation
- **Activates automatically** when JSON/JSONC files are opened in the editor
- **Real-time validation** triggers on:
  - File open
  - File change (as you type)
  - File save
  - Editor focus change

### Error Highlighting
- Displays validation errors as **diagnostics** in the Problems panel
- Shows **inline error messages** with red squiggly underlines
- Attempts to **locate the exact position** of errors based on the `instancePath`
- Falls back to the start of the document if position cannot be determined

### Validation Types
Currently validates:
- **JSON/JSONC syntax errors** (invalid JSON format)
- **Schema validation errors** (via JsonFile entity from @gts/shared)

## Implementation Details

### Files
- **`src/validation.ts`** - Core validation logic
  - `initValidation()` - Initializes validation listeners
  - `validateDocument()` - Validates a single document
  - `validationErrorsToDiagnostics()` - Converts ValidationError to VSCode Diagnostic
  - `findErrorPosition()` - Attempts to locate error position in document

- **`src/extension.ts`** - Main extension entry point
  - Calls `initValidation(context)` on activation

### Build Configuration
- Uses **esbuild** to bundle the extension with all dependencies
- Bundles `@gts/shared` package code directly into extension.js
- Runtime dependencies (ajv, ajv-formats, jsonc-parser) are loaded from node_modules

### Activation Events
The extension activates on:
- `onCommand:gts.openViewer` - Manual activation via command
- `onLanguage:json` - Automatic activation when JSON files are opened
- `onLanguage:jsonc` - Automatic activation when JSONC files are opened

## Usage

1. **Install the extension** - Build and install the VSIX package
2. **Open a JSON or GTS file** - Extension activates automatically
3. **View errors** - Check the Problems panel (View → Problems) or look for red squiggly underlines in the editor
4. **Fix errors** - Errors update in real-time as you edit

## Example

Given a JSON file with invalid syntax:
```json
{
  "name": "test"
  "value": 123
}
```

The extension will show:
- **Error**: `Invalid JSONC: ...` at line 2
- **Source**: GTS
- **Severity**: Error

## Future Enhancements

Potential improvements:
- Add schema-aware validation using GTS type IDs
- Support for custom validation rules
- Quick fixes for common errors
- Warning-level diagnostics for non-critical issues
