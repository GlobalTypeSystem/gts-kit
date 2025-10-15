# Contributing to GTS Viewer

Thank you for your interest in contributing to the Global Type System (GTS) Viewer! This document provides guidelines and information for contributors.

## Quick Start

### Prerequisites

- **Git** for version control
- **VS Code** (optional, for testing the VS Code plugins)

### Development Setup

```bash
# Clone the repository
git clone <repository-url>
cd gts-viewer
```

## Development Workflow

### 1. Create a Feature Branch or fork the repository

```bash
git checkout -b feature/your-feature-name
```

Use descriptive branch names:
- `feature/add-event-examples`
- `fix/schema-validation-error`
- `docs/clarify-chaining-rules`
- `spec/minor-version-compatibility`

### 2. Make Your Changes

Follow the specification standards and patterns described below.

### 3. Validate Your Changes

- Run and test the web version
```
```

- Run and test the Electron version
```
```

- Build the VS Code plugin, load and test it
```
```

### 4. Commit Changes

Follow a structured commit message format:

```text
<type>(<module>): <description>
```

- `<type>`: change category (see table below)
- `<module>` (optional): the area touched (e.g., spec, examples, schemas)
- `<description>`: concise, imperative summary

Accepted commit types:

| Type       | Meaning                                                     |
|------------|-------------------------------------------------------------|
| spec       | Specification changes or clarifications                     |
| fix        | Bug fixes in schemas or examples                            |
| feat       | New feature                                                 |
| tech       | Technical change or refactoring                             |
| docs       | Documentation updates                                       |
| examples   | Adding or updating example schemas/instances                |
| test       | Adding or modifying validation tests                        |
| style      | Formatting changes (whitespace, JSON formatting, etc.)      |
| chore      | Misc tasks (tooling, scripts)                               |
| breaking   | Backward incompatible specification changes                 |

Examples:

```text
feat(vscode): implement diagram reload on VS Code file save event
fix(schemas): fix the schame parsing
```

Best practices:

- Keep the title concise (ideally < 50 chars)
- Use imperative mood (e.g., "Fix schema", not "Fixed schema")
- Make commits atomic (one logical change per commit)
- Add details in the body when necessary (what/why, not how)
