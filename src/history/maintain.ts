import { lstatSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { ingest, MONTH_FILE } from "../index/ingest.ts";
import {
  assertPrivateDir,
  assertTrustedAncestors,
  ChangedSinceReviewError,
  currentUid,
  readFileChecked,
  readRangeChecked,
  removeFileChecked,
  sha256,
} from "../secure/fs.ts";
import { readDays, setDay, writeDays, type DaysFile } from "./days-file.ts";
import { dayStartOf, FOLLOW_MS, localDate, nextDayStart, SUMMARY_VERSION, summarizeDay } from "./summary.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
/** Decision Q16: raw data is removed a whole month file at a time, 90 days after the month ended. */
export const RETENTION_MS = 90 * DAY_MS;
/** A day is summarized once it has been over this long, so the rows a summary reads after the day exist. */
export const SETTLE_MS = FOLLOW_MS;
/** Keeps one pass short when much is waiting; the rest follows in the next pass. */
export const MAX_DAYS_PER_PASS = 7;

const MONTH_POLICY = { private: true, maxBytes: 512 * 1024 * 1024 };
const PROBLEMS_POLICY = { private: true, maxBytes: 16 * 1024 * 1024 };
const TAIL_BYTES = 1024 * 1024;
const NEWLINE = 0x0a;
/** What the collector writes in state/ besides problems.jsonl. */
const STATE_ENTRY = /^(?:[A-Za-z0-9._-]{1,128}\.last|\..+\.tmp)$/;

export interface MaintenanceResult {
  /** Local dates summarized in this pass. */
  summarized: string[];
  /** More days wait for a summary, so another pass should follow soon. */
  pending: boolean;
  removedMonths: string[];
  removedStateFiles: number;
  removedProblems: boolean;
}

export interface MaintenanceOptions {
  uid?: number;
  maxDays?: number;
  /** Tests stand in for a later version of the summaries. */
  version?: number;
}

type Row = Record<string, unknown>;

const errnoCode = (error: unknown): string | undefined => (error as NodeJS.ErrnoException | null)?.code;
const numberOrNull = (v: unknown): number | null => (typeof v === "number" || typeof v === "bigint" ? Number(v) : null);

/** Month files are named by UTC month; this is when the month ended. */
function monthEnd(name: string): number {
  return Date.UTC(Number(name.slice(0, 4)), Number(name.slice(5, 7)), 1);
}

const monthName = (ms: number): string => {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}.jsonl`;
};

/**
 * A local day can lie in two month files. Its raw data may be incomplete when a month it touches is
 * old enough to have been removed and its file is gone, so its summary is then not computed again.
 * A missing month file can also be a month without events, which leaves an older summary in place.
 */
function rawComplete(start: number, end: number, monthFiles: ReadonlySet<string>, now: number): boolean {
  return [monthName(start), monthName(end - 1)].every((name) => monthFiles.has(name) || monthEnd(name) + RETENTION_MS > now);
}

/**
 * Summarizes, oldest first, every settled day with events that has no summary, or an older version
 * of it while its raw data is complete. Returns the start of the first day that is not done, since
 * raw data from that day on stays.
 */
function summarizeDays(
  db: DatabaseSync,
  file: DaysFile,
  monthFiles: ReadonlySet<string>,
  now: number,
  options: Required<Pick<MaintenanceOptions, "maxDays" | "version">>,
  result: MaintenanceResult,
): number {
  const oldest = numberOrNull((db.prepare("SELECT MIN(received_at) AS at FROM events").get() as Row | undefined)?.at);
  if (oldest === null) return dayStartOf(now);
  const hasEvents = db.prepare("SELECT 1 AS found FROM events WHERE received_at >= ? AND received_at < ? LIMIT 1");
  for (let start = dayStartOf(oldest); ; start = nextDayStart(start)) {
    const end = nextDayStart(start);
    if (end + SETTLE_MS > now) return start;
    if (hasEvents.get(start, end) === undefined) continue;
    const existing = file.days.get(localDate(start));
    if (existing !== undefined && (existing.v >= options.version || !rawComplete(start, end, monthFiles, now))) continue;
    if (result.summarized.length >= options.maxDays) {
      result.pending = true;
      return start;
    }
    const summary = summarizeDay(db, start, end, options.version);
    if (summary === null) continue;
    setDay(file, summary);
    result.summarized.push(summary.date);
  }
}

/** Every complete line in the file is in the index; a trailing half line is never finished in an old month. */
function fullyRead(db: DatabaseSync, path: string, name: string, uid: number): boolean {
  const row = db.prepare("SELECT dev, ino, read_offset AS offset FROM source_files WHERE name = ?").get(name) as Row | undefined;
  const offset = numberOrNull(row?.offset) ?? 0;
  const tail = readRangeChecked(path, true, offset, TAIL_BYTES, uid);
  if (tail === null) return false;
  if (row !== undefined && (numberOrNull(row.dev) !== tail.dev || numberOrNull(row.ino) !== tail.ino)) return false;
  return tail.size - offset <= TAIL_BYTES && !tail.bytes.includes(NEWLINE);
}

function removeMonths(db: DatabaseSync, eventsDir: string, monthFiles: ReadonlySet<string>, settledUntil: number, now: number, uid: number): string[] {
  const removed: string[] = [];
  const lastEvent = db.prepare("SELECT MAX(received_at) AS at FROM events WHERE source_file = ?");
  for (const name of [...monthFiles].sort()) {
    if (monthEnd(name) + RETENTION_MS > now) continue;
    const last = numberOrNull((lastEvent.get(name) as Row | undefined)?.at);
    if (last !== null && last >= settledUntil) continue;
    const path = join(eventsDir, name);
    if (!fullyRead(db, path, name, uid)) continue;
    const current = readFileChecked(path, MONTH_POLICY, uid);
    if (current === null) continue;
    try {
      removeFileChecked(path, sha256(current.bytes), MONTH_POLICY, uid);
    } catch (error) {
      if (error instanceof ChangedSinceReviewError) continue;
      throw error;
    }
    removed.push(name);
  }
  return removed;
}

/** Closes known gap 6 for state/: files for sessions that have not changed in 90 days. */
function removeOldState(dir: string, now: number, uid: number): number {
  let entries;
  try {
    assertPrivateDir(dir, uid);
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return 0;
    throw error;
  }
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isFile() || !STATE_ENTRY.test(entry.name)) continue;
    const path = join(dir, entry.name);
    try {
      if (lstatSync(path).mtimeMs + RETENTION_MS > now) continue;
      unlinkSync(path);
      removed++;
    } catch (error) {
      if (errnoCode(error) !== "ENOENT") throw error;
    }
  }
  return removed;
}

/**
 * Closes known gap 6 for problems.jsonl: the whole file goes once every entry is 90 days old. A
 * rejected run logged between the check and the removal is lost; an entry holds only a reason and a time.
 */
function removeOldProblems(path: string, now: number, uid: number): boolean {
  const file = readFileChecked(path, PROBLEMS_POLICY, uid);
  if (file === null) return false;
  for (const line of file.bytes.toString("utf8").split("\n")) {
    try {
      const at: unknown = (JSON.parse(line) as { at?: unknown } | null)?.at;
      if (typeof at === "number" && at + RETENTION_MS > now) return false;
    } catch {
      // A line without a time says nothing about age.
    }
  }
  try {
    removeFileChecked(path, sha256(file.bytes), PROBLEMS_POLICY, uid);
  } catch (error) {
    if (error instanceof ChangedSinceReviewError) return false;
    throw error;
  }
  return true;
}

/**
 * Decision Q16, run by the window that holds the index lock, right after reading events in. The
 * summaries are written first; a month file is removed only when every day in it is summarized.
 */
export function maintain(db: DatabaseSync, home: string, now: number, options: MaintenanceOptions = {}): MaintenanceResult {
  const uid = options.uid ?? currentUid();
  assertTrustedAncestors(home, uid);
  assertPrivateDir(home, uid);
  const eventsDir = join(home, "events");
  assertPrivateDir(eventsDir, uid);
  const monthFiles = new Set(readdirSync(eventsDir).filter((name) => MONTH_FILE.test(name)));

  const result: MaintenanceResult = { summarized: [], pending: false, removedMonths: [], removedStateFiles: 0, removedProblems: false };
  const file = readDays(home, uid);
  const settings = { maxDays: options.maxDays ?? MAX_DAYS_PER_PASS, version: options.version ?? SUMMARY_VERSION };
  const settledUntil = summarizeDays(db, file, monthFiles, now, settings, result);
  if (result.summarized.length > 0) writeDays(home, file, uid);

  result.removedMonths = removeMonths(db, eventsDir, monthFiles, settledUntil, now, uid);
  if (result.removedMonths.length > 0) ingest(db, home, { uid });
  result.removedStateFiles = removeOldState(join(home, "state"), now, uid);
  result.removedProblems = removeOldProblems(join(home, "state", "problems.jsonl"), now, uid);
  return result;
}
