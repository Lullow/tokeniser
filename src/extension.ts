import { existsSync, watch, type FSWatcher } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import * as vscode from "vscode";
import { indexPaths, openIndex } from "./index/db.ts";
import { ingest } from "./index/ingest.ts";
import { tryAcquireLock } from "./index/lock.ts";
import { buildHover, type ThemeKind } from "./status/hover.ts";
import { emptySnapshot, statusView, type Snapshot, type StatusMode } from "./status/model.ts";
import { readSnapshot } from "./status/snapshot.ts";
import { emptyViewData, readViewData, type ViewData } from "./view/data.ts";
import { buildViewModel, type ViewSettings } from "./view/model.ts";
import { TokeniserViewProvider, VIEW_ID } from "./view/provider.ts";

const OPEN_COMMAND = "tokeniser.openView";
const TOGGLE_COMMAND = "tokeniser.toggleView";
const REFRESH_DEBOUNCE_MS = 300;
/** Ages, resets and forecasts change with time alone; this re-renders without any file access. */
const RENDER_EVERY_MS = 30_000;
/** A fallback in case a file system event is missed. */
const POLL_EVERY_MS = 60_000;
const NOT_CONNECTED = "Tokeniser är inte ansluten till Claude Code. Anslut med npm run connect i Tokeniser-repot.";
const MODES: readonly StatusMode[] = ["both", "fiveHour", "week", "nearest", "context"];

function numberSetting(config: vscode.WorkspaceConfiguration, key: string, min: number, max: number, fallback: number): number {
  const value = config.get<unknown>(key);
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max ? value : fallback;
}

function readSettings(): ViewSettings {
  const statusBar = vscode.workspace.getConfiguration("tokeniser.statusBar");
  const suggestions = vscode.workspace.getConfiguration("tokeniser.suggestions");
  const mode = statusBar.get<unknown>("mode");
  const warningAt = numberSetting(statusBar, "warningAt", 1, 100, 80);
  return {
    status: {
      mode: MODES.find((m) => m === mode) ?? "both",
      warningAt,
      errorAt: Math.max(warningAt, numberSetting(statusBar, "errorAt", 1, 100, 95)),
    },
    suggestions: {
      contextPercent: numberSetting(suggestions, "contextPercent", 1, 100, 60),
      contextTokens: numberSetting(suggestions, "contextTokens", 1_000, 10_000_000, 200_000),
    },
  };
}

function themeKind(): ThemeKind {
  switch (vscode.window.activeColorTheme.kind) {
    case vscode.ColorThemeKind.Light:
      return "light";
    case vscode.ColorThemeKind.HighContrast:
      return "highContrast";
    case vscode.ColorThemeKind.HighContrastLight:
      return "highContrastLight";
    default:
      return "dark";
  }
}

const workspaceFolders = (): string[] => (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath);

class Controller implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem("tokeniser.status", vscode.StatusBarAlignment.Right, 100);
  private readonly home = join(homedir(), ".tokeniser");
  private readonly provider: TokeniserViewProvider;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly intervals: NodeJS.Timeout[] = [];
  private snapshot: Snapshot = emptySnapshot("Läser in data från Claude Code …");
  private viewData: ViewData = emptyViewData();
  private watcher: FSWatcher | undefined;
  private pending: NodeJS.Timeout | undefined;

  constructor(extensionUri: vscode.Uri) {
    this.provider = new TokeniserViewProvider(extensionUri, () => this.scheduleRefresh());
    this.item.name = "Tokeniser";
    this.item.command = { command: TOGGLE_COMMAND, title: "Visa eller dölj Tokeniser" };
    this.render();
    this.item.show();
    this.disposables.push(
      vscode.window.registerWebviewViewProvider(VIEW_ID, this.provider),
      vscode.commands.registerCommand(OPEN_COMMAND, () => vscode.commands.executeCommand(`${VIEW_ID}.focus`)),
      vscode.commands.registerCommand(TOGGLE_COMMAND, () => this.toggleView()),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration("tokeniser")) this.render();
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.scheduleRefresh()),
      vscode.window.onDidChangeActiveColorTheme(() => this.render()),
    );
    this.intervals.push(
      setInterval(() => this.render(), RENDER_EVERY_MS),
      setInterval(() => this.refresh(), POLL_EVERY_MS),
    );
    this.scheduleRefresh();
  }

  /** Decision Q18: a click on the status bar shows or hides the view, wherever it has been placed. */
  private async toggleView(): Promise<void> {
    if (!this.provider.visible) {
      await vscode.commands.executeCommand(`${VIEW_ID}.focus`);
      return;
    }
    await vscode.commands.executeCommand("workbench.action.closePanel");
    if (this.provider.visible) await vscode.commands.executeCommand("workbench.action.closeAuxiliaryBar");
  }

  private scheduleRefresh(): void {
    clearTimeout(this.pending);
    this.pending = setTimeout(() => this.refresh(), REFRESH_DEBOUNCE_MS);
  }

  private ensureWatcher(eventsDir: string): void {
    if (this.watcher !== undefined) return;
    try {
      this.watcher = watch(eventsDir, () => this.scheduleRefresh());
      this.watcher.on("error", () => {
        this.watcher?.close();
        this.watcher = undefined;
      });
    } catch {
      this.watcher = undefined;
    }
  }

  /** One window at a time reads new events into the index; every window reads the index (decision Q21). */
  private refresh(): void {
    const eventsDir = join(this.home, "events");
    try {
      if (!existsSync(eventsDir)) {
        this.snapshot = emptySnapshot(NOT_CONNECTED);
        this.viewData = emptyViewData();
      } else {
        this.ensureWatcher(eventsDir);
        const db = openIndex(this.home);
        try {
          const lock = tryAcquireLock(indexPaths(this.home).lock);
          if (lock !== null) {
            try {
              ingest(db, this.home);
            } finally {
              lock.release();
            }
          }
          const now = Date.now();
          this.snapshot = readSnapshot(db, workspaceFolders(), now);
          if (this.provider.visible) this.viewData = readViewData(db, this.snapshot.session?.id ?? null, now);
        } finally {
          db.close();
        }
      }
    } catch (error) {
      this.snapshot = emptySnapshot(`Kan inte läsa Tokenisers data: ${error instanceof Error ? error.message : String(error)}`);
      this.viewData = emptyViewData();
    }
    this.render();
  }

  private render(): void {
    const settings = readSettings();
    const now = Date.now();
    const view = statusView(this.snapshot, settings.status, now);
    this.item.text = view.text;
    this.item.accessibilityInformation = { label: view.accessibleLabel };
    this.item.backgroundColor =
      view.level === null ? undefined : new vscode.ThemeColor(view.level === "error" ? "statusBarItem.errorBackground" : "statusBarItem.warningBackground");
    const tooltip = new vscode.MarkdownString(buildHover(this.snapshot, settings.status, now, themeKind()));
    tooltip.supportHtml = true;
    tooltip.isTrusted = { enabledCommands: [OPEN_COMMAND] };
    this.item.tooltip = tooltip;
    if (this.provider.visible) this.provider.update(buildViewModel(this.snapshot, this.viewData, settings, now));
  }

  dispose(): void {
    clearTimeout(this.pending);
    for (const interval of this.intervals) clearInterval(interval);
    this.watcher?.close();
    for (const disposable of this.disposables) disposable.dispose();
    this.item.dispose();
  }
}

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(new Controller(context.extensionUri));
}

export function deactivate(): void {}
