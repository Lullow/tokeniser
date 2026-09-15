import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { assertPrivateDir, assertPrivateFileIfExists, assertTrustedAncestors, currentUid, ensurePrivateFile } from "../secure/fs.ts";
import { SCHEMA_SQL, SCHEMA_VERSION } from "./schema.ts";

export interface IndexPaths {
  db: string;
  lock: string;
}

export const indexPaths = (home: string): IndexPaths => ({
  db: join(home, "index.sqlite"),
  lock: join(home, "index.lock"),
});

const SIDE_FILES = ["-wal", "-shm", "-journal"];

/** SQLite cannot open with O_NOFOLLOW, so the database and its side files are checked first. */
function checkIndexFiles(home: string, uid: number): string {
  assertTrustedAncestors(home, uid);
  assertPrivateDir(home, uid);
  const { db } = indexPaths(home);
  for (const suffix of SIDE_FILES) assertPrivateFileIfExists(db + suffix, uid);
  return db;
}

export function transaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const value = fn();
    db.exec("COMMIT");
    return value;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

const userVersion = (db: DatabaseSync): number =>
  Number((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);

const BUSY_TIMEOUT_MS = 5000;
const SQLITE_BUSY = 5;

const isBusy = (error: unknown): boolean => {
  const code = (error as { errcode?: unknown } | null)?.errcode;
  return typeof code === "number" && (code & 0xff) === SQLITE_BUSY;
};

/** openIndex is synchronous, like node:sqlite, so a retry waits by blocking briefly. */
function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

const journalMode = (db: DatabaseSync, sql: string): string =>
  String((db.prepare(sql).get() as { journal_mode?: unknown } | undefined)?.journal_mode ?? "");

/**
 * Converting to WAL needs exclusive access. When several processes open a new index at once,
 * SQLite answers SQLITE_BUSY at once instead of waiting for busy_timeout, so the conversion is
 * retried for as long as busy_timeout. WAL is persistent, so an index in WAL is never converted again.
 */
export function ensureWal(db: DatabaseSync, waitMs = BUSY_TIMEOUT_MS): void {
  const deadline = Date.now() + waitMs;
  for (let wait = 5; ; wait = Math.min(wait * 2, 100)) {
    let mode = "";
    try {
      mode = journalMode(db, "PRAGMA journal_mode");
      if (mode !== "wal") mode = journalMode(db, "PRAGMA journal_mode = WAL");
    } catch (error) {
      if (!isBusy(error) || Date.now() >= deadline) throw error;
    }
    if (mode === "wal") return;
    if (Date.now() >= deadline) throw new Error(`index.sqlite kunde inte byta till WAL-läge (läget är ${mode || "okänt"}).`);
    pause(wait);
  }
}

function connect(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
  return db;
}

export function deleteIndex(home: string, uid = currentUid()): void {
  const path = checkIndexFiles(home, uid);
  assertPrivateFileIfExists(path, uid);
  for (const file of [path, ...SIDE_FILES.map((suffix) => path + suffix)]) {
    try {
      unlinkSync(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

/** Opens ~/.tokeniser/index.sqlite, creating it, or rebuilding it when the schema version differs. */
export function openIndex(home: string, uid = currentUid()): DatabaseSync {
  const path = checkIndexFiles(home, uid);
  ensurePrivateFile(path, uid);
  let db = connect(path);
  try {
    const version = userVersion(db);
    if (version !== 0 && version !== SCHEMA_VERSION) {
      db.close();
      deleteIndex(home, uid);
      ensurePrivateFile(path, uid);
      db = connect(path);
    }
    ensureWal(db);
    db.exec("PRAGMA foreign_keys = ON");
    if (userVersion(db) !== SCHEMA_VERSION) {
      transaction(db, () => {
        if (userVersion(db) !== 0) return;
        db.exec(SCHEMA_SQL);
        db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
      });
    }
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
