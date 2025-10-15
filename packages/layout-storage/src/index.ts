// Layout storage types
export interface LayoutTarget {
    workspaceName?: string | null
    id: string
    filename: string
    schemaId: string
}

export interface Point {
    x: number
    y: number
}

export interface Size {
    width: number
    height: number
}

export interface HandlePosition {
    side: 'Left' | 'Right' | 'Top' | 'Bottom'
    pct: number
}

export interface Handles {
    source?: HandlePosition
    target?: HandlePosition
}

export interface ExpansionState {
    expanded?: boolean
    sections?: Record<string, boolean>
}

export interface LayoutNode {
    id: string
    filename: string
    schemaId: string
    type: 'json' | 'schema' | 'virtual'
    position: Point
    size?: Size
    expansion: ExpansionState
    extra?: Record<string, unknown>
}

export interface LayoutEdge {
    id: string
    source: string
    target: string
    relation: 'implements' | 'ref' | 'gts' | 'other'
    sourceKey: string
    handles?: Handles
    labelPosition?: number
    labelOffset?: Point
}

export interface CanvasState {
    scale: number
    pan: Point
    viewportSize?: Size
}

export interface LayoutSaveRequest {
    target: LayoutTarget
    canvas: CanvasState
    nodes: LayoutNode[]
    edges: LayoutEdge[]
    meta?: Record<string, unknown>
}

export interface LayoutSnapshot extends LayoutSaveRequest {
    layoutId: string
    version: string
    createdAt: string
}

// Storage interface
export interface ILayoutStorage {
    /**
     * Get the latest layout for a target
     * @returns LayoutSnapshot or null if not found
     */
    getLatestLayout(target: Partial<LayoutTarget>): Promise<LayoutSnapshot | null>

    /**
     * Save a new layout version
     * @returns The saved snapshot with layoutId and version
     */
    saveLayout(request: LayoutSaveRequest): Promise<LayoutSnapshot>

    /**
     * List all versions for a target (optional, for versioning support)
     */
    listVersions?(target: Partial<LayoutTarget>): Promise<Array<{
        layoutId: string
        version: string
        createdAt: string
    }>>
}

// Storage type enum
export enum StorageType {
    Server = 'server',
    HomeFolder = 'home-folder',
    RepoFolder = 'repo-folder'
}

// Storage options
export interface ServerStorageOptions {
    type: StorageType.Server
    apiBaseUrl: string
}

export interface HomeFolderStorageOptions {
    type: StorageType.HomeFolder
    // Will use ~/.gts-viewer/layouts/
}

export interface RepoFolderStorageOptions {
    type: StorageType.RepoFolder
    repoRootPath: string
    // Will use {repoRootPath}/.gts-viewer/
}

export type StorageOptions =
    | ServerStorageOptions
    | HomeFolderStorageOptions
    | RepoFolderStorageOptions
