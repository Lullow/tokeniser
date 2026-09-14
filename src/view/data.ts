import type { DatabaseSync, SQLInputValue } from "node:sqlite";

export const HISTORY_DAYS = 7;
/** A gap longer than this between two events in a session counts as a break. */
export const ACTIVE_GAP_MS = 10 * 60 * 1000;

export interface UsageTotals {
  input: number;
  output: number;
  cacheCreation: number;
  cacheRead: number;
  calls: number;
}

export interface DayUsage {
  start: number;
  tokens: number;
}

export interface ProjectToday {
  label: string;
  kind: "repo" | "dir";
  sessions: number;
  activeMs: number;
  tokens: number;
}

export interface CacheMiss {
  causes: string[];
  at: number;
}

export interface ViewData {
  days: DayUsage[];
  projectsToday: ProjectToday[];
  sessionTotals: UsageTotals | null;
  cacheMiss: CacheMiss | null;
}

export const emptyViewData = (): ViewData => ({ days: [], projectsToday: [], sessionTotals: null, cacheMiss: null });

interface UsageRow {
  sessionId: string;
  projectId: number | null;
  at: number;
  input: number | null;
  output: number | null;
  cacheCreation: number | null;
  cacheRead: number | null;
}

type Row = Record<string, unknown>;

const numberOrNull = (v: unknown): number | null => (typeof v === "number" || typeof v === "bigint" ? Number(v) : null);
const MISS_CAUSE = /^[a-z0-9_]{1,64}$/;

/** Local midnight for each of the last `days` days, today last. */
export function dayStarts(now: number, days = HISTORY_DAYS): number[] {
  const today = new Date(now);
  return Array.from({ length: days }, (_, i) =>
    new Date(today.getFullYear(), today.getMonth(), today.getDate() - (days - 1 - i)).getTime(),
  );
}

function usageRows(db: DatabaseSync, where: string, ...params: SQLInputValue[]): UsageRow[] {
  const rows = db
    .prepare(
      `SELECT session_id AS sessionId, project_id AS projectId, received_at AS at, usage_input AS input, usage_output AS output,
         usage_cache_creation AS cacheCreation, usage_cache_read AS cacheRead
       FROM events WHERE ${where} ORDER BY received_at, id`,
    )
    .all(...params) as Row[];
  return rows.map((r) => ({
    sessionId: String(r.sessionId),
    projectId: numberOrNull(r.projectId),
    at: Number(r.at),
    input: numberOrNull(r.input),
    output: numberOrNull(r.output),
    cacheCreation: numberOrNull(r.cacheCreation),
    cacheRead: numberOrNull(r.cacheRead),
  }));
}

const tokensOf = (r: UsageRow): number => (r.input ?? 0) + (r.output ?? 0) + (r.cacheCreation ?? 0) + (r.cacheRead ?? 0);

/**
 * The status line only carries the latest API call, so each call is counted once, when its
 * usage first appears in a session. Calls between two status line updates are missed, which
 * makes every sum a lower bound (decision Q16: always marked as an estimate).
 */
function newCalls(rows: readonly UsageRow[]): UsageRow[] {
  const lastUsage = new Map<string, string>();
  return rows.filter((row) => {
    if (row.input === null && row.output === null && row.cacheCreation === null && row.cacheRead === null) return false;
    const key = `${row.input}|${row.output}|${row.cacheCreation}|${row.cacheRead}`;
    if (lastUsage.get(row.sessionId) === key) return false;
    lastUsage.set(row.sessionId, key);
    return true;
  });
}

/** Time between consecutive events in a session, leaving out breaks. */
function activeTime(rows: readonly UsageRow[]): Map<string, number> {
  const sessions = new Map<string, { last: number; total: number }>();
  for (const row of rows) {
    const session = sessions.get(row.sessionId);
    if (session === undefined) {
      sessions.set(row.sessionId, { last: row.at, total: 0 });
      continue;
    }
    const gap = row.at - session.last;
    if (gap <= ACTIVE_GAP_MS) session.total += gap;
    session.last = row.at;
  }
  return new Map([...sessions].map(([id, session]) => [id, session.total]));
}

function parseMiss(row: Row | undefined): CacheMiss | null {
  const at = numberOrNull(row?.at);
  if (row === undefined || typeof row.causes !== "string" || at === null) return null;
  try {
    const causes: unknown = JSON.parse(row.causes);
    if (!Array.isArray(causes) || !causes.every((c) => typeof c === "string" && MISS_CAUSE.test(c))) return null;
    return { causes: causes as string[], at: at * 1000 };
  } catch {
    return null;
  }
}

export function readViewData(db: DatabaseSync, sessionId: string | null, now: number): ViewData {
  const starts = dayStarts(now);
  const windowStart = starts[0] ?? now;
  const todayStart = starts.at(-1) ?? now;
  const recent = usageRows(db, "received_at >= ?", windowStart);
  const calls = newCalls(recent);

  const days = starts.map((start, i) => {
    const end = starts[i + 1] ?? Number.POSITIVE_INFINITY;
    return { start, tokens: calls.filter((c) => c.at >= start && c.at < end).reduce((sum, c) => sum + tokensOf(c), 0) };
  });

  const projects = new Map(
    (db.prepare("SELECT id, label, kind FROM projects").all() as Row[]).map((p) => [
      Number(p.id),
      { label: String(p.label), kind: p.kind === "repo" ? ("repo" as const) : ("dir" as const) },
    ]),
  );
  const today = recent.filter((r) => r.at >= todayStart);
  const totals = new Map<number, { sessions: Set<string>; activeMs: number; tokens: number }>();
  const totalFor = (projectId: number) => {
    let total = totals.get(projectId);
    if (total === undefined) {
      total = { sessions: new Set(), activeMs: 0, tokens: 0 };
      totals.set(projectId, total);
    }
    return total;
  };
  const sessionProject = new Map<string, number>();
  for (const row of today) {
    if (row.projectId === null) continue;
    totalFor(row.projectId).sessions.add(row.sessionId);
    sessionProject.set(row.sessionId, row.projectId);
  }
  for (const call of calls) {
    if (call.at >= todayStart && call.projectId !== null) totalFor(call.projectId).tokens += tokensOf(call);
  }
  for (const [session, ms] of activeTime(today)) {
    const projectId = sessionProject.get(session);
    if (projectId !== undefined) totalFor(projectId).activeMs += ms;
  }
  const projectsToday = [...totals]
    .flatMap(([id, total]) => {
      const project = projects.get(id);
      return project === undefined
        ? []
        : [{ label: project.label, kind: project.kind, sessions: total.sessions.size, activeMs: total.activeMs, tokens: total.tokens }];
    })
    .sort((a, b) => b.tokens - a.tokens || a.label.localeCompare(b.label));

  let sessionTotals: UsageTotals | null = null;
  let cacheMiss: CacheMiss | null = null;
  if (sessionId !== null) {
    const sessionCalls = newCalls(usageRows(db, "session_id = ?", sessionId));
    if (sessionCalls.length > 0) {
      sessionTotals = sessionCalls.reduce(
        (sum, c) => ({
          input: sum.input + (c.input ?? 0),
          output: sum.output + (c.output ?? 0),
          cacheCreation: sum.cacheCreation + (c.cacheCreation ?? 0),
          cacheRead: sum.cacheRead + (c.cacheRead ?? 0),
          calls: sum.calls + 1,
        }),
        { input: 0, output: 0, cacheCreation: 0, cacheRead: 0, calls: 0 },
      );
    }
    cacheMiss = parseMiss(
      db
        .prepare("SELECT cache_last_miss_causes AS causes, cache_last_miss_at AS at FROM events WHERE session_id = ? ORDER BY received_at DESC, id DESC LIMIT 1")
        .get(sessionId) as Row | undefined,
    );
  }

  return { days, projectsToday, sessionTotals, cacheMiss };
}
