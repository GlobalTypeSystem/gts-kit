# GTS Server

Simple CRUD server for GTS (Graph Type System) entities, layouts, and settings. It's primary purpose is to serve GTS entities to the GTS Viewer web app for development and testing purposes.

NOTE: This is a simple server for development and testing purposes. It is not intended for production use. It doesn't provide any security features - authentication, authorization, multi-user/multi-tenancy support, etc.

## Features

- **GTS Entity Discovery**: Automatically scans directories for GTS entities (JSON files with IDs starting with `gts.`)
- **Layout Management**: Save and retrieve visual layouts with versioning
- **Settings Storage**: Global settings persistence
- **In-Memory Entity Cache**: Fast access to discovered GTS entities via REST API
- **Configurable**: File-based config, environment variables, and CLI overrides

## Installation

If you use nvm:

```bash
nvm install 20
nvm use 20
cd apps/server
rm -rf node_modules package-lock.json
npm install
npm run dev  # for development
# or
npm run build && npm start  # for production
```

If you use Homebrew:

```bash
brew install node@20
echo 'export PATH="/opt/homebrew/opt/node@20/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc
node -v  # verify v20.x
cd apps/server
rm -rf node_modules package-lock.json
npm install
npm run dev
```

## Configuration

The server can be configured through multiple sources (priority: CLI > Config File > Environment > Defaults).

### Configuration File

Create a `.gts-server.json` file in one of these locations:
- Current directory: `.gts-server.json` or `gts-server.json`
- Home directory: `~/.gts-server.json`
- Custom path via `--config` flag

Example config file:
```json
{
  "port": 7080,
  "homeFolder": "~/.gts-viewer/server",
  "scanFolder": ".",
  "verbosity": "normal",
  "dbFile": "viewer.db"
}
```

### CLI Options

```bash
gts-server [options]

Options:
  --port, -p <number>           Port to listen on (default: 7080)
  --home, --home-folder <path>  Home folder for server data (default: ~/.gts-viewer/server/)
  --scan, --scan-folder <path>  Folder to scan for GTS entities (default: current directory)
  --verbosity, -v <level>       Verbosity level: silent, normal, debug (default: normal)
  --debug                       Enable debug verbosity
  --silent                      Enable silent verbosity
  --db, --db-file <path>        Database file path (default: <home-folder>/viewer.db)
  --config, -c <path>           Path to config file
  --help, -h                    Show help message
```

### Environment Variables

- `GTS_SERVER_PORT`: Port to listen on
- `GTS_SERVER_HOME_FOLDER`: Home folder path
- `GTS_SERVER_SCAN_FOLDER`: Folder to scan for GTS entities
- `GTS_SERVER_VERBOSITY`: Verbosity level (silent/normal/debug)
- `GTS_SERVER_DB_FILE`: Database file path

### Examples

```bash
# Start with debug logging
npm run dev -- --debug

# Scan a specific directory
npm run dev -- --scan-folder /path/to/gts/entities

# Use custom port and config
npm run dev -- --port 8080 --config /path/to/config.json

# Production mode with custom settings
npm run build
node dist/index-cli.js --port 9000 --scan ../examples --verbosity debug
```

## API Endpoints

### GTS Entities

- `GET /gts/:name` - Get a GTS entity by ID (e.g., `/gts/gts.vendor.app.namespace.type.v1`)
  - Returns: `{ id, content, file: { path, name }, isSchema }`
  - 404 if entity not found

### Health & Info

- `GET /health` - Server health check
  - Returns: `{ status, db, backendVersion, gtsEntities }`

### Layouts

- `GET /layouts` - Get latest layout (query params: workspaceName, id, filename, schemaId, version)
- `POST /layouts` - Save new layout version
- `GET /layouts/versions` - List versions for a target
- `GET /layouts/:layoutId/versions/:version` - Get specific version
- `POST /layouts/:layoutId/versions/:version` - Restore version as latest

### Settings

- `GET /settings` - Get global settings
- `PUT /settings` - Update global settings

### Documentation

- `GET /docs` - API documentation (Swagger UI)
- `GET /openapi.yaml` - OpenAPI specification

## GTS Entity Filtering

The server only discovers and serves entities with IDs starting with `gts.`. Non-GTS JSON files are ignored during scanning.

**Valid GTS entity example:**
```json
{
  "id": "gts.example.type.user.profile.v1",
  "type": "object",
  "properties": { ... }
}
```

**Ignored (non-GTS):**
```json
{
  "id": "my-custom-id",
  "data": "..."
}
```

## Architecture

- **Scanner**: Recursively scans configured folder for `.json` and `.gts` files
- **Entity Filter**: Only includes entities with IDs starting with `gts.`
- **In-Memory Cache**: Loaded entities stored in Map for fast lookup
- **Database**: SQLite for layouts, versions, and settings
- **Express API**: RESTful endpoints with CORS support
