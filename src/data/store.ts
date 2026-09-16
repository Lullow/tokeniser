import { lstatSync, readdirSync, rmdirSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { deleteIndex, indexPaths } from "../index/db.ts";
import { MONTH_FILE } from "../index/ingest.ts";
import { tryAcquireLock } from "../index/lock.ts";
import { assertPrivateDir, assertTrustedAncestors, currentUid, readFileChecked, replaceFileAtomic } from "../secure/fs.ts";

const EXPORT_MAX_BYTES = 512 * 1024 * 1024;
const NEWLINE = 0x0a;
const SUBDIRS = ["events", "state", "backup", "bin"];
/** What the collector and the atomic writes leave in state/. */
const STATE_FILE = /^(?:[A-Za-z0-9._-]{1,128}\.last|problems\.jsonl|\..+\.tmp)$/;
const BACKUP_FILE = /^settings\.[0-9a-f]{16}\.json$/;
const COLLECTOR_FILE = /^collector\.cjs$/;
/** The daily summaries and a temporary file left by an interrupted write. */
const DAYS_ENTRY = /^(?:days\.jsonl|\.days\.jsonl\.[0-9a-f]{16}\.tmp)$/;

const errnoCode = (error: unknown): string | undefined => (error as NodeJS.ErrnoException | null)?.code;
const numberOrNull = (v: unknown): number | null => (typeof v === "number" || typeof v === "bigint" ? Number(v) : null);

function display(path: string): string {
  const home = homedir();
  return path.startsWith(`${home}/`) ? `~/${path.slice(home.length + 1)}` : path;
}

function exists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return false;
    throw error;
  }
}

export interface StorageSummary {
  events: number;
  firstAt: number | null;
  bytes: number;
}

/** Regular files directly in ~/.tokeniser and in its subdirectories; links are never followed. */
function sizeOf(home: string): number {
  let total = 0;
  const add = (dir: string, depth: number): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isFile()) {
        try {
          total += lstatSync(path).size;
        } catch {
          // Removed while counting.
        }
      } else if (entry.isDirectory() && depth === 0) {
        add(path, 1);
      }
    }
  };
  add(home, 0);
  return total;
}

/** The data row: how many events the index holds, since when, and the size of ~/.tokeniser. Null when it does not exist. */
export function readStorage(home: string, db: DatabaseSync | null): StorageSummary | null {
  try {
    if (!lstatSync(home).isDirectory()) return null;
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return null;
    throw error;
  }
  const row = db?.prepare("SELECT COUNT(*) AS n, MIN(received_at) AS first FROM events").get() as Record<string, unknown> | undefined;
  return { events: numberOrNull(row?.n) ?? 0, firstAt: numberOrNull(row?.first), bytes: sizeOf(home) };
}

export interface ExportResult {
  path: string;
  events: number;
  /** The mode the file actually got, which a Windows drive does not honor. */
  mode: number;
}

/**
 * Point 8: every complete line from events/*.jsonl, oldest month first. A line the collector is
 * still writing is left out. The file is written atomically with mode 0600, and a symlink at the
 * target is replaced rather than followed.
 */
export function exportEvents(home: string, target: string, uid = currentUid()): ExportResult {
  const path = resolve(target);
  if (path === home || path.startsWith(`${home}${sep}`)) {
    throw new Error("Exporten kan inte sparas i ~/.tokeniser, eftersom en radering tar bort det som ligger där.");
  }
  const events = join(home, "events");
  assertTrustedAncestors(home, uid);
  assertPrivateDir(events, uid);

  const parts: Buffer[] = [];
  let lines = 0;
  for (const name of readdirSync(events).filter((n) => MONTH_FILE.test(n)).sort()) {
    const file = readFileChecked(join(events, name), { private: true, maxBytes: EXPORT_MAX_BYTES }, uid);
    if (file === null) continue;
    const complete = file.bytes.subarray(0, file.bytes.lastIndexOf(NEWLINE) + 1);
    for (let i = complete.indexOf(NEWLINE); i !== -1; i = complete.indexOf(NEWLINE, i + 1)) lines++;
    if (complete.length > 0) parts.push(complete);
  }

  replaceFileAtomic(path, Buffer.concat(parts), { mode: 0o600, exactMode: true, durable: true }, uid);
  return { path, events: lines, mode: lstatSync(path).mode & 0o7777 };
}

/** Collected data only while connected, since the collector needs its directories; everything otherwise. */
export type DeleteScope = "collected" | "everything";

export function deleteScope(home: string): DeleteScope | null {
  if (!exists(home)) return null;
  return exists(join(home, "connection.json")) ? "collected" : "everything";
}

export interface DeleteResult {
  /** Entries Tokeniser did not create, which are left in place. */
  remaining: string[];
}

/** Removes only names Tokeniser writes, one at a time; unlink never follows a link. Without a list, other entries are not reported. */
function removeMatching(dir: string, pattern: RegExp, uid: number, remaining: string[] | null): void {
  let entries;
  try {
    assertPrivateDir(dir, uid);
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if ((entry.isFile() || entry.isSymbolicLink()) && pattern.test(entry.name)) {
      try {
        unlinkSync(path);
      } catch (error) {
        if (errnoCode(error) !== "ENOENT") throw error;
      }
    } else {
      remaining?.push(display(path));
    }
  }
}

function removeDirIfEmpty(dir: string): boolean {
  try {
    rmdirSync(dir);
    return true;
  } catch (error) {
    const code = errnoCode(error);
    if (code === "ENOENT") return true;
    if (code === "ENOTEMPTY" || code === "EEXIST") return false;
    throw error;
  }
}

/**
 * Point 8 and acceptance criterion 12. The index lock keeps other windows from reading events in
 * while files disappear, and the scope must still be the one the user confirmed.
 */
export function deleteData(home: string, confirmed: DeleteScope, uid = currentUid()): DeleteResult {
  if (deleteScope(home) !== confirmed) {
    throw new Error("Anslutningen ändrades medan dialogen var öppen, så inget raderades. Försök igen.");
  }
  assertTrustedAncestors(home, uid);
  assertPrivateDir(home, uid);
  const lock = tryAcquireLock(indexPaths(home).lock, { uid });
  if (lock === null) {
    throw new Error("Ett annat VS Code-fönster läser in data just nu, så inget raderades. Försök igen om en stund.");
  }

  const remaining: string[] = [];
  try {
    removeMatching(join(home, "events"), MONTH_FILE, uid, remaining);
    removeMatching(join(home, "state"), STATE_FILE, uid, remaining);
    removeMatching(home, DAYS_ENTRY, uid, null);
    deleteIndex(home, uid);
    if (confirmed === "everything") {
      removeMatching(join(home, "backup"), BACKUP_FILE, uid, remaining);
      removeMatching(join(home, "bin"), COLLECTOR_FILE, uid, remaining);
    }
  } finally {
    lock.release();
  }

  if (confirmed === "everything") {
    for (const dir of SUBDIRS) removeDirIfEmpty(join(home, dir));
    if (!removeDirIfEmpty(home)) {
      for (const name of readdirSync(home)) if (!SUBDIRS.includes(name)) remaining.push(display(join(home, name)));
    }
  }
  return { remaining };
}
