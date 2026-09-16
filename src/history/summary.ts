import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { forEachActiveGap, newCalls, type CallRow } from "../index/usage.ts";

/**
 * Bump when a day is summarized differently. Days whose raw data is still complete are then
 * summarized again; older days keep the summary they have.
 */
export const SUMMARY_VERSION = 1;

/** A call that starts before midnight can finish after it, so rows this long after the day are read for its output. */
export const FOLLOW_MS = 60 * 60 * 1000;

export interface ModelDay {
  model: string | null;
  calls: number;
  input: number;
  output: number;
  cacheCreation: number;
  cacheRead: number;
  /** The increase of each session's running cost, from the first value seen; null when no event had one. */
  costUsd: number | null;
}

export interface ProjectDay {
  /** Null for events without a repository or project directory. */
  key: string | null;
  kind: "repo" | "dir" | null;
  label: string | null;
  /** Sessions and active time belong to the project, so a session that changes model is counted once. */
  sessions: number;
  activeMs: number;
  models: ModelDay[];
}

/** One line in ~/.tokeniser/days.jsonl. Tokens and cost are estimates (decision Q16). */
export interface DaySummary {
  v: number;
  /** The local date, for example "2026-09-15". */
  date: string;
  start: number;
  end: number;
  events: number;
  fiveHourPeak: number | null;
  weekPeak: number | null;
  projects: ProjectDay[];
}

interface DayRow extends CallRow {
  id: number;
  projectId: number | null;
  model: string | null;
  costUsd: number | null;
  fiveUsed: number | null;
  weekUsed: number | null;
}

type Row = Record<string, unknown>;

const numberOrNull = (v: unknown): number | null => (typeof v === "number" || typeof v === "bigint" ? Number(v) : null);
const pad = (n: number): string => String(n).padStart(2, "0");

export const dayStartOf = (ms: number): number => {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
};

export const nextDayStart = (start: number): number => {
  const d = new Date(start);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
};

export const localDate = (ms: number): string => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

/** Local midnight of a date such as "2026-09-14". */
export const dateStart = (date: string): number => {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(year ?? 0, (month ?? 1) - 1, day ?? 1).getTime();
};

const COLUMNS = `id, session_id AS sessionId, project_id AS projectId, model_id AS model, received_at AS at,
  usage_input AS input, usage_output AS output, usage_cache_creation AS cacheCreation, usage_cache_read AS cacheRead,
  cost_usd AS costUsd, five_used AS fiveUsed, week_used AS weekUsed`;

function dayRows(db: DatabaseSync, where: string, ...params: SQLInputValue[]): DayRow[] {
  const rows = db.prepare(`SELECT ${COLUMNS} FROM events WHERE ${where} ORDER BY received_at, id`).all(...params) as Row[];
  return rows.map((r) => ({
    id: Number(r.id),
    sessionId: String(r.sessionId),
    projectId: numberOrNull(r.projectId),
    model: typeof r.model === "string" ? r.model : null,
    at: Number(r.at),
    input: numberOrNull(r.input),
    output: numberOrNull(r.output),
    cacheCreation: numberOrNull(r.cacheCreation),
    cacheRead: numberOrNull(r.cacheRead),
    costUsd: numberOrNull(r.costUsd),
    fiveUsed: numberOrNull(r.fiveUsed),
    weekUsed: numberOrNull(r.weekUsed),
  }));
}

/**
 * For every session in the day, its last event with usage and with cost before the day starts.
 * A call that first appeared the day before is then not counted again, and cost grows from there.
 */
function earlierRows(db: DatabaseSync, start: number, end: number): DayRow[] {
  const sessions = "SELECT DISTINCT session_id FROM events WHERE received_at >= ? AND received_at < ?";
  const last = (column: string) =>
    `SELECT (SELECT p.id FROM events p WHERE p.session_id = s.session_id AND p.received_at < ? AND p.${column} IS NOT NULL
       ORDER BY p.received_at DESC, p.id DESC LIMIT 1) AS id FROM (${sessions}) s`;
  const ids = (db.prepare(`${last("usage_input")} UNION ${last("cost_usd")}`).all(start, start, end, start, start, end) as Row[])
    .map((r) => numberOrNull(r.id))
    .filter((id): id is number => id !== null);
  return ids.length === 0 ? [] : dayRows(db, `id IN (${ids.map(() => "?").join(", ")})`, ...ids);
}

const byNullableText = (a: string | null, b: string | null): number => (a === b ? 0 : a === null ? 1 : b === null ? -1 : a.localeCompare(b));
const roundCost = (usd: number): number => Math.round(usd * 1_000_000) / 1_000_000;

/**
 * Summarizes the local day [start, end) from the index; null when it has no events. A call belongs
 * to the day it first appeared, like in the view's curve, and cost to the day it grew.
 */
export function summarizeDay(db: DatabaseSync, start: number, end: number, version = SUMMARY_VERSION): DaySummary | null {
  const within = dayRows(db, "received_at >= ? AND received_at < ?", start, end);
  if (within.length === 0) return null;
  const all = [...earlierRows(db, start, end), ...within].sort((a, b) => a.at - b.at || a.id - b.id);
  const following = dayRows(db, "received_at >= ? AND received_at < ?", end, end + FOLLOW_MS);

  const projects = new Map<number | null, { sessions: Set<string>; activeMs: number; models: Map<string | null, ModelDay> }>();
  const projectFor = (id: number | null) => {
    let project = projects.get(id);
    if (project === undefined) {
      project = { sessions: new Set(), activeMs: 0, models: new Map() };
      projects.set(id, project);
    }
    return project;
  };
  const modelFor = (projectId: number | null, model: string | null): ModelDay => {
    const models = projectFor(projectId).models;
    let day = models.get(model);
    if (day === undefined) {
      day = { model, calls: 0, input: 0, output: 0, cacheCreation: 0, cacheRead: 0, costUsd: null };
      models.set(model, day);
    }
    return day;
  };

  for (const row of within) projectFor(row.projectId).sessions.add(row.sessionId);
  forEachActiveGap(within, (row, ms) => {
    projectFor(row.projectId).activeMs += ms;
  });
  for (const call of newCalls([...all, ...following])) {
    if (call.at < start || call.at >= end) continue;
    const day = modelFor(call.projectId, call.model);
    day.calls++;
    day.input += call.input ?? 0;
    day.output += call.output ?? 0;
    day.cacheCreation += call.cacheCreation ?? 0;
    day.cacheRead += call.cacheRead ?? 0;
  }
  const lastCost = new Map<string, number>();
  for (const row of all) {
    if (row.costUsd === null) continue;
    const previous = lastCost.get(row.sessionId);
    lastCost.set(row.sessionId, row.costUsd);
    if (row.at < start) continue;
    const day = modelFor(row.projectId, row.model);
    // A lower value than before starts the running cost over.
    day.costUsd = (day.costUsd ?? 0) + (previous === undefined ? 0 : Math.max(0, row.costUsd - previous));
  }

  const identities = new Map(
    (db.prepare("SELECT id, key, kind, label FROM projects").all() as Row[]).map((p) => [
      Number(p.id),
      { key: String(p.key), kind: p.kind === "repo" ? ("repo" as const) : ("dir" as const), label: String(p.label) },
    ]),
  );
  const peak = (values: (number | null)[]): number | null =>
    values.reduce<number | null>((max, v) => (v === null ? max : max === null ? v : Math.max(max, v)), null);

  return {
    v: version,
    date: localDate(start),
    start,
    end,
    events: within.length,
    fiveHourPeak: peak(within.map((r) => r.fiveUsed)),
    weekPeak: peak(within.map((r) => r.weekUsed)),
    projects: [...projects]
      .map(([id, project]) => {
        const identity = id === null ? undefined : identities.get(id);
        return {
          key: identity?.key ?? null,
          kind: identity?.kind ?? null,
          label: identity?.label ?? null,
          sessions: project.sessions.size,
          activeMs: project.activeMs,
          models: [...project.models.values()]
            .map((m) => ({ ...m, costUsd: m.costUsd === null ? null : roundCost(m.costUsd) }))
            .sort((a, b) => byNullableText(a.model, b.model)),
        };
      })
      .sort((a, b) => byNullableText(a.key, b.key)),
  };
}
