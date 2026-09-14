import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import { viewHtml } from "./html.ts";
import { COPYABLE_COMMANDS } from "./suggestions.ts";
import type { ToWebview, ViewModel } from "./types.ts";

export const VIEW_ID = "tokeniser.view";

/** Decision Q18: the view in the bottom panel, next to Terminal. */
export class TokeniserViewProvider implements vscode.WebviewViewProvider {
  private readonly extensionUri: vscode.Uri;
  private readonly onVisible: () => void;
  private view: vscode.WebviewView | undefined;
  private model: ViewModel | null = null;

  constructor(extensionUri: vscode.Uri, onVisible: () => void) {
    this.extensionUri = extensionUri;
    this.onVisible = onVisible;
  }

  get visible(): boolean {
    return this.view?.visible ?? false;
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    const dist = vscode.Uri.joinPath(this.extensionUri, "dist");
    view.webview.options = { enableScripts: true, enableCommandUris: false, localResourceRoots: [dist] };
    view.webview.html = viewHtml({
      cspSource: view.webview.cspSource,
      scriptUri: view.webview.asWebviewUri(vscode.Uri.joinPath(dist, "view.js")).toString(),
      styleUri: view.webview.asWebviewUri(vscode.Uri.joinPath(dist, "view.css")).toString(),
      nonce: randomBytes(18).toString("base64"),
    });
    view.webview.onDidReceiveMessage((message: unknown) => void this.receive(message));
    view.onDidChangeVisibility(() => {
      if (!view.visible) return;
      this.post();
      this.onVisible();
    });
    view.onDidDispose(() => {
      if (this.view === view) this.view = undefined;
    });
    this.onVisible();
  }

  update(model: ViewModel): void {
    this.model = model;
    this.post();
  }

  private post(): void {
    if (this.view?.visible !== true || this.model === null) return;
    const message: ToWebview = { type: "model", model: this.model };
    void this.view.webview.postMessage(message);
  }

  /** Messages from the webview are untrusted: only a known command may reach the clipboard. */
  private async receive(message: unknown): Promise<void> {
    if (typeof message !== "object" || message === null) return;
    const { type, command } = message as { type?: unknown; command?: unknown };
    if (type === "ready") {
      this.post();
      return;
    }
    if (type === "copy" && typeof command === "string" && COPYABLE_COMMANDS.includes(command)) {
      await vscode.env.clipboard.writeText(command);
      const reply: ToWebview = { type: "copied", command };
      void this.view?.webview.postMessage(reply);
    }
  }
}
