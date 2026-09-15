import type { HealthModel } from "../view/types.ts";
import { duration } from "./format.ts";

/** Decision Q7: a value older than this is shown as "Äldre". */
export const STALE_AFTER_MS = 5 * 60 * 1000;
/** Other sessions updated this recently count as active. */
export const ACTIVE_SESSION_MS = 15 * 60 * 1000;

export interface ForecastWindow {
  windowMs: number;
  /** The measurements must span at least this long for the rate to mean anything. */
  minSpanMs: number;
}

/** Decision Q14: the rate is measured over the recent window of the same limit window. */
export const FORECAST = {
  fiveHour: { windowMs: 30 * 60 * 1000, minSpanMs: 10 * 60 * 1000 },
  /** Over a day, idle time must be part of the rate, so the measurements must span most of it. */
  week: { windowMs: 24 * 60 * 60 * 1000, minSpanMs: 20 * 60 * 60 * 1000 },
} as const satisfies Record<string, ForecastWindow>;

const FORECAST_MIN_POINTS = 3;
const FIVE_MINUTES = 5 * 60 * 1000;

export const NO_EVENTS = "Ingen data från Claude Code ännu.";
export const NO_LIMIT = "Claude Code har inte skickat gränsen. Den finns bara för Pro och Max och kommer med första svaret i en session.";
export const NO_SESSION = "Ingen session från Claude Code ännu.";
export const NO_CONTEXT = "Kontexten mäts efter första svaret i sessionen.";

export interface Point {
  at: number;
  used: number;
}

export interface LimitReading {
  used: number;
  /** Epoch milliseconds. */
  resetsAt: number;
  measuredAt: number;
}

export interface ContextReading {
  usedPct: number | null;
  size: number | null;
  tokens: number | null;
  measuredAt: number;
}

export interface SessionInfo {
  id: string;
  label: string | null;
  /** False when no session matched the window's folders and the latest session overall is used. */
  inWindowProject: boolean;
  modelId: string | null;
  effort: string | null;
  context: ContextReading;
}

export interface Snapshot {
  /** Set when nothing can be read at all, with the reason. */
  unavailable: string | null;
  hasEvents: boolean;
  fiveHour: { latest: LimitReading | null; points: Point[] };
  week: { latest: LimitReading | null; points: Point[] };
  session: SessionInfo | null;
  otherActiveSessions: number;
}

export function emptySnapshot(unavailable: string | null): Snapshot {
  return {
    unavailable,
    hasEvents: false,
    fiveHour: { latest: null, points: [] },
    week: { latest: null, points: [] },
    session: null,
    otherActiveSessions: 0,
  };
}

export type LimitState =
  | { kind: "current"; used: number; resetsAt: number; measuredAt: number }
  | { kind: "stale"; used: number; resetsAt: number; measuredAt: number; age: number }
  | { kind: "reset"; resetsAt: number }
  | { kind: "missing"; reason: string };

export type ContextState =
  | { kind: "current"; usedPct: number; size: number | null; tokens: number | null; measuredAt: number }
  | { kind: "stale"; usedPct: number; size: number | null; tokens: number | null; measuredAt: number; age: number }
  | { kind: "missing"; reason: string };

export function limitState(snapshot: Snapshot, which: "fiveHour" | "week", now: number): LimitState {
  if (snapshot.unavailable !== null) return { kind: "missing", reason: snapshot.unavailable };
  const latest = snapshot[which].latest;
  if (latest === null) return { kind: "missing", reason: snapshot.hasEvents ? NO_LIMIT : NO_EVENTS };
  // Never 0 %: after resets_at the old value says nothing about the new window.
  if (latest.resetsAt <= now) return { kind: "reset", resetsAt: latest.resetsAt };
  const age = now - latest.measuredAt;
  const reading = { used: latest.used, resetsAt: latest.resetsAt, measuredAt: latest.measuredAt };
  return age > STALE_AFTER_MS ? { kind: "stale", ...reading, age } : { kind: "current", ...reading };
}

export function contextState(snapshot: Snapshot, now: number): ContextState {
  if (snapshot.unavailable !== null) return { kind: "missing", reason: snapshot.unavailable };
  if (snapshot.session === null) return { kind: "missing", reason: snapshot.hasEvents ? NO_SESSION : NO_EVENTS };
  const { usedPct, size, tokens, measuredAt } = snapshot.session.context;
  if (usedPct === null) return { kind: "missing", reason: NO_CONTEXT };
  const age = now - measuredAt;
  return age > STALE_AFTER_MS
    ? { kind: "stale", usedPct, size, tokens, measuredAt, age }
    : { kind: "current", usedPct, size, tokens, measuredAt };
}

export type Forecast =
  | { kind: "reaches"; at: number }
  | { kind: "lasts"; resetsAt: number }
  | { kind: "reached"; resetsAt: number }
  | { kind: "hidden"; reason: string };

function slopePerMs(points: readonly Point[]): number {
  const meanAt = points.reduce((sum, p) => sum + p.at, 0) / points.length;
  const meanUsed = points.reduce((sum, p) => sum + p.used, 0) / points.length;
  let numerator = 0;
  let denominator = 0;
  for (const p of points) {
    numerator += (p.at - meanAt) * (p.used - meanUsed);
    denominator += (p.at - meanAt) ** 2;
  }
  return denominator === 0 ? 0 : numerator / denominator;
}

/**
 * Decision Q14: a least-squares rate over the recent window of the same limit window.
 * Needs at least 3 measurements spanning the window's minimum, and is hidden for old data.
 */
export function forecast(state: LimitState, points: readonly Point[], window: ForecastWindow, now: number): Forecast {
  if (state.kind === "stale") return { kind: "hidden", reason: `senaste värdet är ${duration(state.age)} gammalt` };
  if (state.kind === "reset") return { kind: "hidden", reason: "ny siffra kommer vid nästa svar" };
  if (state.kind === "missing") return { kind: "hidden", reason: "det finns ingen mätning" };
  if (state.used >= 100) return { kind: "reached", resetsAt: state.resetsAt };

  const recent = points.filter((p) => p.at >= now - window.windowMs && p.at <= now);
  const first = recent[0];
  const last = recent.at(-1);
  if (first === undefined || last === undefined || recent.length < FORECAST_MIN_POINTS || last.at - first.at < window.minSpanMs) {
    return { kind: "hidden", reason: `den kräver minst ${FORECAST_MIN_POINTS} mätningar under minst ${duration(window.minSpanMs)}` };
  }
  const slope = slopePerMs(recent);
  if (slope <= 0) return { kind: "lasts", resetsAt: state.resetsAt };
  const reachesAt = last.at + (100 - last.used) / slope;
  if (reachesAt >= state.resetsAt) return { kind: "lasts", resetsAt: state.resetsAt };
  return { kind: "reaches", at: Math.round(reachesAt / FIVE_MINUTES) * FIVE_MINUTES };
}

export type StatusMode = "both" | "fiveHour" | "week" | "nearest" | "context";

export interface StatusSettings {
  mode: StatusMode;
  warningAt: number;
  errorAt: number;
}

export interface StatusView {
  text: string;
  level: "warning" | "error" | null;
  accessibleLabel: string;
}

const hasValue = (state: LimitState): state is Extract<LimitState, { used: number }> => state.kind === "current" || state.kind === "stale";

function limitToken(prefix: string, state: LimitState): string {
  if (hasValue(state)) return `${prefix} ${Math.round(state.used)}%`;
  return state.kind === "reset" ? `${prefix} ↺` : `${prefix} –`;
}

function describeLimit(name: string, state: LimitState): string {
  switch (state.kind) {
    case "current":
      return `${name}: ${Math.round(state.used)} procent förbrukat`;
    case "stale":
      return `${name}: ${Math.round(state.used)} procent förbrukat, mätt för ${duration(state.age)} sedan`;
    case "reset":
      return `${name}: återställd, ny siffra vid nästa svar`;
    case "missing":
      return `${name}: saknas`;
  }
}

function describeContext(state: ContextState): string {
  if (state.kind === "missing") return "Kontext: saknas";
  const age = state.kind === "stale" ? `, mätt för ${duration(state.age)} sedan` : "";
  return `Kontext: ${Math.round(state.usedPct)} procent${age}`;
}

/**
 * Decision Q8: the status bar shows consumed, never remaining, in the chosen mode. A health
 * warning adds an icon but never a background, since the warning color already means 80 %.
 */
export function statusView(snapshot: Snapshot, settings: StatusSettings, now: number, health: HealthModel | null = null): StatusView {
  const five = limitState(snapshot, "fiveHour", now);
  const week = limitState(snapshot, "week", now);
  const warned = health !== null && health.level === "warning";
  const icon = warned ? "$(dashboard) $(warning)" : "$(dashboard)";
  const healthLabel = health !== null && warned ? ` Hälsovarning: ${health.title}.` : "";

  if (settings.mode === "context") {
    const context = contextState(snapshot, now);
    const token = context.kind === "missing" ? "ktx –" : `ktx ${Math.round(context.usedPct)}%`;
    return {
      text: `${icon}${context.kind === "stale" ? " $(history)" : ""} ${token}`,
      level: null,
      accessibleLabel: `Tokeniser.${healthLabel} ${describeContext(context)}.`,
    };
  }

  let shown: [string, string, LimitState][];
  if (settings.mode === "fiveHour") shown = [["5h", "5 timmar", five]];
  else if (settings.mode === "week") shown = [["v", "Vecka", week]];
  else if (settings.mode === "nearest") {
    const weekNearer = hasValue(week) && (!hasValue(five) || week.used > five.used);
    shown = [weekNearer ? ["v", "Vecka", week] : ["5h", "5 timmar", five]];
  } else shown = [["5h", "5 timmar", five], ["v", "Vecka", week]];

  const states = shown.map(([, , state]) => state);
  const highest = Math.max(0, ...states.filter(hasValue).map((s) => s.used));
  const level = highest >= settings.errorAt ? "error" : highest >= settings.warningAt ? "warning" : null;
  const stale = states.some((s) => s.kind === "stale");
  return {
    text: `${icon}${stale ? " $(history)" : ""} ${shown.map(([prefix, , state]) => limitToken(prefix, state)).join(" · ")}`,
    level,
    accessibleLabel: `Tokeniser.${healthLabel} ${shown.map(([, name, state]) => describeLimit(name, state)).join(". ")}.`,
  };
}
