import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import { DISCONNECT_COMMAND } from "../health/model.ts";
import { viewHtml } from "./html.ts";
import { COPYABLE_COMMANDS } from "./suggestions.ts";
import type { ToWebview, ViewModel } from "./types.ts";

export const VIEW_ID = "tokeniser.view";

/** The only text the view may put on the clipboard. Nothing is ever run. */
const COPYABLE: readonly string[] = [...COPYABLE_COMMANDS, DISCONNECT_COMMAND];

/** The data row's actions; each one is confirmed or chosen in VS Code itself, never in the view. */
export type ViewAction = "export" | "delete" | "settings";
const ACTIONS: readonly ViewAction[] = ["export", "delete", "settings"];

/** Decision Q18: the view in the bottom panel, next to Terminal. */
export class TokeniserViewProvider implements vscode.WebviewViewProvider {
  private readonly extensionUri: vscode.Uri;
  private readonly onVisible: () => void;
  private readonly onAction: (action: ViewAction) => void;
  private view: vscode.WebviewView | undefined;
  private model: ViewModel | null = null;

  constructor(extensionUri: vscode.Uri, onVisible: () => void, onAction: (action: ViewAction) => void) {
    this.extensionUri = extensionUri;
    this.onVisible = onVisible;
    this.onAction = onAction;
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
    const { type, command, action } = message as { type?: unknown; command?: unknown; action?: unknown };
    if (type === "ready") {
      this.post();
      return;
    }
    if (type === "action") {
      const known = ACTIONS.find((candidate) => candidate === action);
      if (known !== undefined) this.onAction(known);
      return;
    }
    if (type === "copy" && typeof command === "string" && COPYABLE.includes(command)) {
      await vscode.env.clipboard.writeText(command);
      const reply: ToWebview = { type: "copied", command };
      void this.view?.webview.postMessage(reply);
    }
  }
}
