# GTS (Global Type System) Viewer

A modern React application for visualizing JSON files and their schema relationships in an interactive diagram format using the GTS relationship

## Features

- 🔍 **File Discovery**: Automatically discovers JSON files based on VS Code settings
- 🔎 **Search**: Real-time search through JSON files by name or path
- 📊 **Visual Diagram**: ERD-style diagram showing relationships between JSON files and schemas
- 🌳 **Property Explorer**: Collapsible tree view of JSON properties and schema definitions
- 🎨 **Modern UI**: Built with shadcn/ui components and Tailwind CSS
- ⚡ **Fast**: Powered by Vite for lightning-fast development

## Getting Started

### Prerequisites

- Node.js 18+
- npm or yarn

### Installation

```bash
# Install dependencies
npm install

# Start development server
npm run dev

# Build for production
npm run build

# Preview production build
npm run preview
```

### Usage

1. Place your JSON files in the appropriate directories (e.g., `examples/events/instances/`)
2. Configure schema mappings in `.vscode/settings.json`
3. Start the development server
4. Browse files in the left sidebar
5. Explore the visual diagram in the main panel
6. Click on nodes to expand property details

## Project Structure

```
viewer/
├── src/
│   ├── components/          # React components
│   │   ├── ui/             # shadcn/ui components
│   │   ├── EntitiesListMenu.tsx    # File browser sidebar
│   │   ├── SchemaDiagram.tsx # Main diagram view
│   │   ├── SchemaNode.tsx  # Individual diagram nodes
│   │   └── PropertyViewer.tsx # Property tree viewer
│   ├── hooks/              # Custom React hooks
│   ├── types/              # TypeScript type definitions
│   ├── utils/              # Utility functions
│   └── lib/                # Library configurations
├── public/                 # Static assets
└── package.json           # Dependencies and scripts
```

## Configuration

The application reads JSON schema mappings from `.vscode/settings.json`:

```json
{
  "json.schemas": [
    {
      "fileMatch": ["examples/events/instances/*.json"],
      "url": "./examples/events/schemas/base.event.schema.json"
    }
  ]
}
```

## Technologies

- **React 18** - UI framework
- **TypeScript** - Type safety
- **Vite** - Build tool and dev server
- **Tailwind CSS** - Utility-first CSS framework
- **shadcn/ui** - Modern component library
- **React Flow** - Interactive diagrams
- **Dagre** - Automatic graph layout
- **Lucide React** - Beautiful icons

## License

MIT
