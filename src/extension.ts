import { existsSync, watch, type FSWatcher } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import * as vscode from "vscode";
import { indexPaths, openIndex } from "./index/db.ts";
import { ingest } from "./index/ingest.ts";
import { tryAcquireLock } from "./index/lock.ts";
import { buildHover, type ThemeKind } from "./status/hover.ts";
import { emptySnapshot, statusView, type Snapshot, type StatusMode, type StatusSettings } from "./status/model.ts";
import { readSnapshot } from "./status/snapshot.ts";

const REFRESH_DEBOUNCE_MS = 300;
/** Ages, resets and forecasts change with time alone; this re-renders without any file access. */
const RENDER_EVERY_MS = 30_000;
/** A fallback in case a file system event is missed. */
const POLL_EVERY_MS = 60_000;
const NOT_CONNECTED = "Tokeniser är inte ansluten till Claude Code. Anslut med npm run connect i Tokeniser-repot.";
const MODES: readonly StatusMode[] = ["both", "fiveHour", "week", "nearest", "context"];

function readSettings(): StatusSettings {
  const config = vscode.workspace.getConfiguration("tokeniser.statusBar");
  const mode = config.get<unknown>("mode");
  const threshold = (key: string, fallback: number): number => {
    const value = config.get<unknown>(key);
    return typeof value === "number" && Number.isFinite(value) && value >= 1 && value <= 100 ? value : fallback;
  };
  const warningAt = threshold("warningAt", 80);
  return {
    mode: MODES.find((m) => m === mode) ?? "both",
    warningAt,
    errorAt: Math.max(warningAt, threshold("errorAt", 95)),
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

class StatusController implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem("tokeniser.status", vscode.StatusBarAlignment.Right, 100);
  private readonly home = join(homedir(), ".tokeniser");
  private readonly disposables: vscode.Disposable[] = [];
  private readonly intervals: NodeJS.Timeout[] = [];
  private snapshot: Snapshot = emptySnapshot("Läser in data från Claude Code …");
  private watcher: FSWatcher | undefined;
  private pending: NodeJS.Timeout | undefined;

  constructor() {
    this.item.name = "Tokeniser";
    this.render();
    this.item.show();
    this.disposables.push(
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
          this.snapshot = readSnapshot(db, workspaceFolders(), Date.now());
        } finally {
          db.close();
        }
      }
    } catch (error) {
      this.snapshot = emptySnapshot(`Kan inte läsa Tokenisers data: ${error instanceof Error ? error.message : String(error)}`);
    }
    this.render();
  }

  private render(): void {
    const settings = readSettings();
    const now = Date.now();
    const view = statusView(this.snapshot, settings, now);
    this.item.text = view.text;
    this.item.accessibilityInformation = { label: view.accessibleLabel };
    this.item.backgroundColor =
      view.level === null ? undefined : new vscode.ThemeColor(view.level === "error" ? "statusBarItem.errorBackground" : "statusBarItem.warningBackground");
    const tooltip = new vscode.MarkdownString(buildHover(this.snapshot, settings, now, themeKind()));
    tooltip.supportHtml = true;
    tooltip.isTrusted = false;
    this.item.tooltip = tooltip;
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
  context.subscriptions.push(new StatusController());
}

export function deactivate(): void {}
