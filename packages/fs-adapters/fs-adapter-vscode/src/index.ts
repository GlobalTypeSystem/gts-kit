// Purpose: VS Code scanner implementation with capability support
import * as vscode from "vscode";
import { Scanner, ScanOptions, JsonDoc, FileChange, CapabilityProvider, ScannerCapabilities } from "../../types";
import { getVSCodeCapabilities } from './capabilities';

export class VSCodeScanner implements Scanner, CapabilityProvider {
  private workspaceRoot?: string;

  async requestDirectoryAccess(): Promise<void> {
    // In VSCode, we use the current workspace
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      throw new Error("No workspace folder open");
    }
    this.workspaceRoot = workspaceFolders[0].uri.fsPath;
  }

  async list(opts: ScanOptions = {}): Promise<JsonDoc[]> {
    if (!this.workspaceRoot) {
      await this.requestDirectoryAccess();
    }

    const pattern = opts.glob || "**/*.json";
    const exclude = opts.ignore?.join(",") || "**/node_modules/**,**/.git/**,**/dist/**";

    const files = await vscode.workspace.findFiles(pattern, exclude);
    const docs: JsonDoc[] = [];

    for (const file of files) {
      try {
        const stat = await vscode.workspace.fs.stat(file);
        docs.push({
          path: vscode.workspace.asRelativePath(file),
          name: file.path.split('/').pop() || file.path,
          mtimeMs: stat.mtime,
          size: stat.size
        });
      } catch (error) {
        // Skip files that can't be accessed
        console.warn(`Failed to stat file ${file.path}:`, error);
      }
    }

    return docs;
  }

  async read(path: string): Promise<string> {
    if (!this.workspaceRoot) {
      await this.requestDirectoryAccess();
    }

    const uri = vscode.Uri.file(path.startsWith('/') ? path : `${this.workspaceRoot}/${path}`);
    try {
      const content = await vscode.workspace.fs.readFile(uri);
      return new TextDecoder().decode(content);
    } catch (error) {
      throw new Error(`Failed to read file ${path}: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  watch(opts: ScanOptions, onChange: (ev: FileChange) => void): () => void {
    const pattern = opts.glob || "**/*.json";
    const exclude = opts.ignore?.join(",") || "**/node_modules/**,**/.git/**,**/dist/**";

    const watcher = vscode.workspace.createFileSystemWatcher(pattern);

    const handleChange = async (uri: vscode.Uri, type: "add" | "change" | "unlink") => {
      try {
        const stat = type !== "unlink" ? await vscode.workspace.fs.stat(uri) : null;
        const doc: JsonDoc = {
          path: vscode.workspace.asRelativePath(uri),
          name: uri.path.split('/').pop() || uri.path,
          mtimeMs: stat?.mtime || 0,
          size: stat?.size || 0
        };
        onChange({ type, doc });
      } catch (error) {
        console.warn(`Failed to handle file change for ${uri.path}:`, error);
      }
    };

    watcher.onDidCreate(uri => handleChange(uri, "add"));
    watcher.onDidChange(uri => handleChange(uri, "change"));
    watcher.onDidDelete(uri => handleChange(uri, "unlink"));

    return () => watcher.dispose();
  }

  /**
   * Get capabilities for the VSCode environment
   */
  getCapabilities(): ScannerCapabilities {
    return getVSCodeCapabilities();
  }
}

// Export capability functions for direct use
export { getVSCodeCapabilities, getVSCodeLimitationMessage, isVSCodeEnvironment } from './capabilities';

// VSCode extension activation function
export async function activate(ctx: vscode.ExtensionContext) {
  const scanner: Scanner = new VSCodeScanner();
  const panel = vscode.window.createWebviewPanel("jsonPreview", "JSON Preview", vscode.ViewColumn.One, { enableScripts: true });
  // TODO: load webview HTML with bundled `ui-json`
  const docs = await scanner.list();
  panel.webview.postMessage({ type: "init", docs });
  const disposeWatch = scanner.watch({}, (ev) => panel.webview.postMessage({ type: "fs", ev }));
  ctx.subscriptions.push({ dispose: disposeWatch });
}
