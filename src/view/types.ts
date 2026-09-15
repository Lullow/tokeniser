// Shared by the extension and the webview. No imports, so the webview bundle stays free of Node code.

export type LimitKind = "current" | "stale" | "reset" | "missing";
export type Level = "normal" | "warning" | "error";

export interface RingModel {
  key: "fiveHour" | "week";
  label: string;
  kind: LimitKind;
  /** Percent consumed; null when reset or missing, never 0 in their place. */
  value: number | null;
  level: Level;
  center: string;
  lines: string[];
  pill: string;
  note: string | null;
}

export interface ForecastModel {
  label: string;
  text: string;
  estimated: boolean;
}

export interface ContextModel {
  kind: "current" | "stale" | "missing";
  value: number | null;
  summary: string;
  ticks: { at: number; label: string }[];
  note: string | null;
}

export interface TileModel {
  label: string;
  value: number | null;
}

export interface DayModel {
  label: string;
  tokens: number;
  today: boolean;
}

export interface ProjectModel {
  label: string;
  detail: string;
  tokens: number;
}

/** Decisions Q13 and Q25: every suggestion has all five parts. */
export interface Suggestion {
  id: "context" | "cache-miss";
  title: string;
  observed: string;
  why: string;
  action: string;
  effect: string;
  certainty: string;
  estimated: boolean;
  commands: string[];
}

/** The health check's own states, separate from the four data states. */
export type HealthMark = "ok" | "warning" | "unknown" | "unchecked";

export interface HealthCheck {
  id: string;
  label: string;
  mark: HealthMark;
  /** The mark in words, so a state never depends on color alone. */
  state: string;
  /** Plain text where `backticks` mark code. */
  detail: string;
  action: string | null;
  command: string | null;
}

export interface HealthModel {
  level: "ok" | "warning";
  title: string;
  summary: string;
  checks: HealthCheck[];
}

export interface DataRowModel {
  /** Plain text where `backticks` mark code. */
  summary: string;
}

export interface ViewModel {
  unavailable: string | null;
  health: HealthModel | null;
  /** Null when ~/.tokeniser does not exist. */
  data: DataRowModel | null;
  updated: string | null;
  limits: {
    rings: [RingModel, RingModel];
    forecasts: ForecastModel[];
    outside: { title: string; text: string };
  };
  session: {
    title: string;
    detail: string;
    context: ContextModel;
    tiles: TileModel[];
    tilesNote: string;
  };
  history: {
    total: number;
    days: DayModel[];
    projects: ProjectModel[];
  };
  suggestions: Suggestion[];
}

export type ToWebview = { type: "model"; model: ViewModel } | { type: "copied"; command: string };
