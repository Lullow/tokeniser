import { join } from "node:path";
import { currentUid, readFileChecked, replaceFileAtomic, sha256 } from "../secure/fs.ts";
import type { DaySummary } from "./summary.ts";

export const DAYS_FILE = "days.jsonl";
export const DAYS_POLICY = { private: true, maxBytes: 64 * 1024 * 1024 };

const DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const utf8 = new TextDecoder("utf-8", { fatal: true });

export interface DayLine {
  date: string;
  v: number;
  text: string;
}

export interface DaysFile {
  /** The hash of the file as it was read, or null when it did not exist. A write checks it again. */
  sha256: string | null;
  days: Map<string, DayLine>;
  /** Lines without a readable date and version, or a second line for a date, kept exactly as they were. */
  other: string[];
}

export const daysPath = (home: string): string => join(home, DAYS_FILE);

function parseDayLine(text: string): DayLine | null {
  try {
    const data: unknown = JSON.parse(text);
    if (typeof data !== "object" || data === null || Array.isArray(data)) return null;
    const { v, date } = data as { v?: unknown; date?: unknown };
    if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 1 || typeof date !== "string" || !DATE.test(date)) return null;
    return { date, v, text };
  } catch {
    return null;
  }
}

/**
 * The summaries are the only history left once raw data is removed, so a rewrite drops nothing
 * but a summary replaced by a new one for the same day. Only the date and version are read here.
 */
export function readDays(home: string, uid = currentUid()): DaysFile {
  const file = readFileChecked(daysPath(home), DAYS_POLICY, uid);
  const result: DaysFile = { sha256: file === null ? null : sha256(file.bytes), days: new Map(), other: [] };
  if (file === null) return result;
  for (const text of utf8.decode(file.bytes).split("\n")) {
    if (text === "") continue;
    const line = parseDayLine(text);
    const existing = line === null ? undefined : result.days.get(line.date);
    if (line === null) {
      result.other.push(text);
    } else if (existing === undefined) {
      result.days.set(line.date, line);
    } else if (line.v > existing.v) {
      result.other.push(existing.text);
      result.days.set(line.date, line);
    } else {
      result.other.push(text);
    }
  }
  return result;
}

export function setDay(file: DaysFile, summary: DaySummary): void {
  file.days.set(summary.date, { date: summary.date, v: summary.v, text: JSON.stringify(summary) });
}

/** Oldest day first. Written atomically and durably with mode 0600, and only if nobody changed the file since it was read. */
export function writeDays(home: string, file: DaysFile, uid = currentUid()): void {
  const lines = [...[...file.days.values()].sort((a, b) => a.date.localeCompare(b.date)).map((day) => day.text), ...file.other];
  const data = Buffer.from(lines.map((line) => `${line}\n`).join(""));
  replaceFileAtomic(daysPath(home), data, { mode: 0o600, exactMode: true, expectedSha256: file.sha256, currentPolicy: DAYS_POLICY, durable: true }, uid);
  file.sha256 = sha256(data);
}
