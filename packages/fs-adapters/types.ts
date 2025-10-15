// Purpose: declare cross-app port for listing/reading/watching JSON files
export type JsonDoc = { path: string; name: string; mtimeMs: number; size: number };

export interface ScanOptions {
  glob?: string;             // default: **/*.json
  ignore?: string[];         // e.g., node_modules, .git, dist
  maxSizeBytes?: number;     // guardrails
  followSymlinks?: boolean;  // default false
}

export interface FileChange {
  type: "add" | "change" | "unlink";
  doc: JsonDoc;
}

export interface Scanner {
  requestDirectoryAccess(): Promise<void>; // no-op in VS Code (workspace already open)
  list(options?: ScanOptions): Promise<JsonDoc[]>;
  read(path: string): Promise<string>;
  watch(options: ScanOptions, onChange: (ev: FileChange) => void): () => void; // returns disposer
}

export interface ScannerCapabilities {
  supportsRefresh: boolean;
  supportsFileWatching: boolean;
  requiresReselection: boolean; // true for fallback scanners that need directory re-selection
}

export interface CapabilityProvider {
  getCapabilities(): ScannerCapabilities;
}
