import { existsSync, watch, type FSWatcher } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import * as vscode from "vscode";
import { deleteData, deleteScope, exportEvents, readStorage, type StorageSummary } from "./data/store.ts";
import { deleteDialog, deleteDone, exportDone, exportTitle } from "./data/text.ts";
import { buildHealth, type HealthFacts } from "./health/model.ts";
import { MANAGED_DIR, readHealthFacts, type HealthIndex } from "./health/read.ts";
import { indexPaths, openIndex } from "./index/db.ts";
import { ingest } from "./index/ingest.ts";
import { tryAcquireLock } from "./index/lock.ts";
import { buildHover, type ThemeKind } from "./status/hover.ts";
import { emptySnapshot, statusView, type Snapshot, type StatusMode } from "./status/model.ts";
import { readSnapshot } from "./status/snapshot.ts";
import { emptyViewData, readViewData, type ViewData } from "./view/data.ts";
import { buildViewModel, type ViewSettings } from "./view/model.ts";
import { TokeniserViewProvider, VIEW_ID, type ViewAction } from "./view/provider.ts";

const OPEN_COMMAND = "tokeniser.openView";
const TOGGLE_COMMAND = "tokeniser.toggleView";
const EXPORT_COMMAND = "tokeniser.exportData";
const DELETE_COMMAND = "tokeniser.deleteData";
const SETTINGS_COMMAND = "tokeniser.openSettings";
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

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

function isoDate(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
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
  private healthFacts: HealthFacts | null = null;
  private storage: StorageSummary | null = null;
  private watcher: FSWatcher | undefined;
  private pending: NodeJS.Timeout | undefined;

  constructor(extensionUri: vscode.Uri) {
    this.provider = new TokeniserViewProvider(
      extensionUri,
      () => this.scheduleRefresh(),
      (action) => void this.runAction(action),
    );
    this.item.name = "Tokeniser";
    this.item.command = { command: TOGGLE_COMMAND, title: "Visa eller dölj Tokeniser" };
    this.render();
    this.item.show();
    this.disposables.push(
      vscode.window.registerWebviewViewProvider(VIEW_ID, this.provider),
      vscode.commands.registerCommand(OPEN_COMMAND, () => vscode.commands.executeCommand(`${VIEW_ID}.focus`)),
      vscode.commands.registerCommand(TOGGLE_COMMAND, () => this.toggleView()),
      vscode.commands.registerCommand(EXPORT_COMMAND, () => this.runAction("export")),
      vscode.commands.registerCommand(DELETE_COMMAND, () => this.runAction("delete")),
      vscode.commands.registerCommand(SETTINGS_COMMAND, () => this.runAction("settings")),
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
        this.healthFacts = null;
        this.storage = this.readStorage(null);
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
          if (this.provider.visible) {
            this.viewData = readViewData(db, this.snapshot.session?.id ?? null, now);
            this.storage = this.readStorage(db);
          }
          this.healthFacts = this.readHealth({ db }, this.snapshot.session?.inWindowProject ?? null);
        } finally {
          db.close();
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.snapshot = emptySnapshot(`Kan inte läsa Tokenisers data: ${message}`);
      this.viewData = emptyViewData();
      this.healthFacts = this.readHealth({ error: message }, null);
      this.storage = this.readStorage(null);
    }
    this.render();
  }

  /** Point 7: the health check runs with every refresh and never throws. */
  private readHealth(index: HealthIndex, inWindowProject: boolean | null): HealthFacts {
    return readHealthFacts({
      home: this.home,
      claudeDir: join(homedir(), ".claude"),
      managedDir: MANAGED_DIR,
      workspaceFolders: workspaceFolders(),
      index,
      inWindowProject,
      now: Date.now(),
    });
  }

  private render(): void {
    const settings = readSettings();
    const now = Date.now();
    const health = this.healthFacts === null ? null : buildHealth(this.healthFacts, now);
    const view = statusView(this.snapshot, settings.status, now, health);
    this.item.text = view.text;
    this.item.accessibilityInformation = { label: view.accessibleLabel };
    this.item.backgroundColor =
      view.level === null ? undefined : new vscode.ThemeColor(view.level === "error" ? "statusBarItem.errorBackground" : "statusBarItem.warningBackground");
    const tooltip = new vscode.MarkdownString(buildHover(this.snapshot, settings.status, now, themeKind(), health));
    tooltip.supportHtml = true;
    tooltip.supportThemeIcons = true;
    tooltip.isTrusted = { enabledCommands: [OPEN_COMMAND] };
    this.item.tooltip = tooltip;
    if (this.provider.visible) this.provider.update(buildViewModel(this.snapshot, this.viewData, settings, now, health, this.storage));
  }

  private readStorage(db: DatabaseSync | null): StorageSummary | null {
    try {
      return readStorage(this.home, db);
    } catch {
      return null;
    }
  }

  /** Counts from the index when there is one, for dialogs opened from the command palette too. */
  private freshStorage(): StorageSummary | null {
    try {
      if (!existsSync(join(this.home, "events"))) return readStorage(this.home, null);
      const db = openIndex(this.home);
      try {
        return readStorage(this.home, db);
      } finally {
        db.close();
      }
    } catch {
      return null;
    }
  }

  private async runAction(action: ViewAction): Promise<void> {
    if (action === "export") await this.exportData();
    else if (action === "delete") await this.deleteData();
    else await vscode.commands.executeCommand("workbench.action.openSettings", "@ext:lullo.tokeniser");
  }

  /** Point 8: the place is an active choice, and the notice afterwards says what the file holds and who can read it. */
  private async exportData(): Promise<void> {
    const storage = this.freshStorage();
    if (storage === null || storage.events === 0) {
      void vscode.window.showInformationMessage("Det finns ingen insamlad data att exportera.");
      return;
    }
    const target = await vscode.window.showSaveDialog({
      title: exportTitle(storage),
      defaultUri: vscode.Uri.file(join(homedir(), `tokeniser-export-${isoDate(Date.now())}.jsonl`)),
      filters: { "JSON Lines": ["jsonl"] },
    });
    if (target === undefined) return;
    if (target.scheme !== "file") {
      void vscode.window.showErrorMessage("Exporten kan bara sparas i WSL. Välj en sökväg som börjar med /.");
      return;
    }
    try {
      void vscode.window.showInformationMessage(exportDone(exportEvents(this.home, target.fsPath)));
    } catch (error) {
      void vscode.window.showErrorMessage(`Exporten avbröts: ${messageOf(error)}`);
    }
  }

  /** Point 8 and acceptance criterion 12: confirmed in VS Code's own modal dialog, never in the view. */
  private async deleteData(): Promise<void> {
    try {
      const scope = deleteScope(this.home);
      if (scope === null) {
        void vscode.window.showInformationMessage("Det finns ingen data att radera.");
        return;
      }
      const dialog = deleteDialog(scope, this.freshStorage(), Date.now());
      const choice = await vscode.window.showWarningMessage(dialog.message, { modal: true, detail: dialog.detail }, dialog.confirm);
      if (choice !== dialog.confirm) return;
      void vscode.window.showInformationMessage(deleteDone(scope, deleteData(this.home, scope)));
    } catch (error) {
      void vscode.window.showErrorMessage(`Raderingen avbröts: ${messageOf(error)}`);
    } finally {
      this.scheduleRefresh();
    }
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
