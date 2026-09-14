import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { ACTIVE_SESSION_MS, FORECAST_WINDOW, type LimitReading, type Point, type Snapshot } from "./model.ts";

type Row = Record<string, unknown>;

const get = (db: DatabaseSync, sql: string, ...params: SQLInputValue[]): Row | undefined =>
  db.prepare(sql).get(...params) as Row | undefined;
const all = (db: DatabaseSync, sql: string, ...params: SQLInputValue[]): Row[] => db.prepare(sql).all(...params) as Row[];
const numberOrNull = (v: unknown): number | null => (typeof v === "number" || typeof v === "bigint" ? Number(v) : null);
const textOrNull = (v: unknown): string | null => (typeof v === "string" ? v : null);

const LIMIT_COLUMNS = {
  fiveHour: { used: "five_used", resets: "five_resets" },
  week: { used: "week_used", resets: "week_resets" },
} as const;

/** Decision Q10: limits come from the latest measurement in any session. */
function readLimit(db: DatabaseSync, which: "fiveHour" | "week"): { latest: LimitReading | null; points: Point[] } {
  const { used, resets } = LIMIT_COLUMNS[which];
  const row = get(
    db,
    `SELECT received_at AS at, ${used} AS used, ${resets} AS resets FROM events
     WHERE ${used} IS NOT NULL AND ${resets} IS NOT NULL ORDER BY received_at DESC, id DESC LIMIT 1`,
  );
  if (row === undefined) return { latest: null, points: [] };
  const at = Number(row.at);
  const resetsAt = Number(row.resets);
  const points = all(
    db,
    `SELECT received_at AS at, ${used} AS used FROM events
     WHERE ${used} IS NOT NULL AND ${resets} = ? AND received_at >= ? ORDER BY received_at`,
    resetsAt,
    at - FORECAST_WINDOW[which],
  ).map((p) => ({ at: Number(p.at), used: Number(p.used) }));
  return { latest: { used: Number(row.used), resetsAt: resetsAt * 1000, measuredAt: at }, points };
}

const normalize = (path: string): string => (path.length > 1 ? path.replace(/\/+$/, "") : path);

/**
 * A window folder belongs to a project when they are the same directory or the folder
 * contains the project directory. A folder inside the project directory counts only when
 * that directory is a repository, so a session started in the home directory does not
 * claim every window.
 */
export function folderMatches(projectDir: string, kind: string, folder: string): boolean {
  const dir = normalize(projectDir);
  const open = normalize(folder);
  return dir === open || dir.startsWith(`${open}/`) || (kind === "repo" && open.startsWith(`${dir}/`));
}

/** Decision Q10: context and model come from the latest session in the window's project, else the latest overall. */
export function readSnapshot(db: DatabaseSync, workspaceFolders: readonly string[], now: number): Snapshot {
  const hasEvents = get(db, "SELECT 1 AS one FROM events LIMIT 1") !== undefined;
  const dirs = all(db, "SELECT d.dir, d.project_id AS projectId, p.kind FROM project_dirs d JOIN projects p ON p.id = d.project_id");
  const projectIds = [
    ...new Set(
      dirs
        .filter((d) => workspaceFolders.some((folder) => folderMatches(String(d.dir), String(d.kind), folder)))
        .map((d) => Number(d.projectId)),
    ),
  ];

  const sessionSql = "SELECT s.session_id AS id, p.label FROM sessions s LEFT JOIN projects p ON p.id = s.project_id";
  let row =
    projectIds.length === 0
      ? undefined
      : get(db, `${sessionSql} WHERE s.project_id IN (${projectIds.map(() => "?").join(", ")}) ORDER BY s.last_at DESC LIMIT 1`, ...projectIds);
  const inWindowProject = row !== undefined;
  row ??= get(db, `${sessionSql} ORDER BY s.last_at DESC LIMIT 1`);

  let session: Snapshot["session"] = null;
  let otherActiveSessions = 0;
  if (row !== undefined) {
    const id = String(row.id);
    const latest = get(
      db,
      `SELECT received_at AS at, model_id AS modelId, effort, context_used_pct AS usedPct, context_size AS size, total_input AS tokens
       FROM events WHERE session_id = ? ORDER BY received_at DESC, id DESC LIMIT 1`,
      id,
    );
    session = {
      label: textOrNull(row.label),
      inWindowProject,
      modelId: textOrNull(latest?.modelId),
      effort: textOrNull(latest?.effort),
      context: {
        usedPct: numberOrNull(latest?.usedPct),
        size: numberOrNull(latest?.size),
        tokens: numberOrNull(latest?.tokens),
        measuredAt: Number(latest?.at ?? 0),
      },
    };
    otherActiveSessions = Number(get(db, "SELECT COUNT(*) AS n FROM sessions WHERE session_id != ? AND last_at >= ?", id, now - ACTIVE_SESSION_MS)?.n ?? 0);
  }

  return {
    unavailable: null,
    hasEvents,
    fiveHour: readLimit(db, "fiveHour"),
    week: readLimit(db, "week"),
    session,
    otherActiveSessions,
  };
}
