import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync, SQLInputValue, StatementSync } from "node:sqlite";
import { assertPrivateDir, currentUid, readRangeChecked, sha256 } from "../secure/fs.ts";
import { transaction } from "./db.ts";
import { parseEventLine, type IndexedEvent } from "./event.ts";
import { identityOf } from "./identity.ts";
import { EVENT_COLUMNS } from "./schema.ts";

export const MONTH_FILE = /^\d{4}-(0[1-9]|1[0-2])\.jsonl$/;

const DEFAULT_CHUNK_BYTES = 4 * 1024 * 1024;
const HEAD_BYTES = 64 * 1024;
const NEWLINE = 0x0a;
const utf8 = new TextDecoder("utf-8", { fatal: true });

export interface IngestResult {
  files: number;
  inserted: number;
  duplicates: number;
  skipped: number;
  /** Files that were replaced or truncated and therefore read again from the start. */
  resetFiles: string[];
}

export interface IngestOptions {
  chunkBytes?: number;
  uid?: number;
}

interface FileRow {
  dev: number;
  ino: number;
  read_offset: number;
  first_line_sha256: string;
}

const one = <T>(statement: StatementSync, ...params: SQLInputValue[]): T | undefined =>
  statement.get(...params) as T | undefined;

function prepare(db: DatabaseSync) {
  return {
    getFile: db.prepare("SELECT dev, ino, read_offset, first_line_sha256 FROM source_files WHERE name = ?"),
    putFile: db.prepare(
      `INSERT INTO source_files (name, dev, ino, read_offset, first_line_sha256) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET dev = excluded.dev, ino = excluded.ino,
         read_offset = excluded.read_offset, first_line_sha256 = excluded.first_line_sha256`,
    ),
    deleteFileEvents: db.prepare("DELETE FROM events WHERE source_file = ?"),
    projectForDir: db.prepare("SELECT p.id, p.kind FROM project_dirs d JOIN projects p ON p.id = d.project_id WHERE d.dir = ?"),
    upsertProject: db.prepare(
      `INSERT INTO projects (key, kind, label, repo_host, repo_owner, repo_name, dir) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET label = excluded.label RETURNING id`,
    ),
    mapDir: db.prepare("INSERT INTO project_dirs (dir, project_id) VALUES (?, ?) ON CONFLICT(dir) DO UPDATE SET project_id = excluded.project_id"),
    moveEvents: db.prepare("UPDATE events SET project_id = ? WHERE project_id = ?"),
    moveSessions: db.prepare("UPDATE sessions SET project_id = ? WHERE project_id = ?"),
    moveDirs: db.prepare("UPDATE project_dirs SET project_id = ? WHERE project_id = ?"),
    deleteProject: db.prepare("DELETE FROM projects WHERE id = ?"),
    upsertSession: db.prepare(
      `INSERT INTO sessions (session_id, project_id, first_at, last_at, model_id, git_worktree, worktree) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         project_id = COALESCE(excluded.project_id, sessions.project_id),
         first_at = MIN(sessions.first_at, excluded.first_at),
         last_at = MAX(sessions.last_at, excluded.last_at),
         model_id = CASE WHEN excluded.last_at >= sessions.last_at THEN COALESCE(excluded.model_id, sessions.model_id) ELSE sessions.model_id END,
         git_worktree = COALESCE(excluded.git_worktree, sessions.git_worktree),
         worktree = COALESCE(excluded.worktree, sessions.worktree)`,
    ),
    insertEvent: db.prepare(
      `INSERT OR IGNORE INTO events (${EVENT_COLUMNS.join(", ")}) VALUES (${EVENT_COLUMNS.map(() => "?").join(", ")})`,
    ),
  };
}

type Statements = ReturnType<typeof prepare>;

function mergeProject(s: Statements, from: number, into: number): void {
  s.moveEvents.run(into, from);
  s.moveSessions.run(into, from);
  s.moveDirs.run(into, from);
  s.deleteProject.run(from);
}

/**
 * A directory seen without a repository is merged into the repository once one appears
 * there, and later events without a repository in that directory stay with it. Two
 * different repositories in the same directory are never merged.
 */
function resolveProject(s: Statements, event: IndexedEvent): number | null {
  const identity = identityOf(event.repo, event.projectDir);
  if (identity === null) return null;
  const mapped = identity.dir === null ? undefined : one<{ id: number; kind: string }>(s.projectForDir, identity.dir);
  if (identity.kind === "dir" && mapped !== undefined) return Number(mapped.id);

  const row = one<{ id: number }>(
    s.upsertProject,
    identity.key,
    identity.kind,
    identity.label,
    identity.repo?.host ?? null,
    identity.repo?.owner ?? null,
    identity.repo?.name ?? null,
    identity.dir,
  );
  const id = Number(row?.id);
  if (identity.dir !== null && (mapped === undefined || Number(mapped.id) !== id)) {
    if (mapped !== undefined && mapped.kind === "dir") mergeProject(s, Number(mapped.id), id);
    s.mapDir.run(identity.dir, id);
  }
  return id;
}

const flag = (value: boolean | null): number | null => (value === null ? null : value ? 1 : 0);

function insertEvent(s: Statements, file: string, offset: number, projectId: number | null, e: IndexedEvent): boolean {
  const info = s.insertEvent.run(
    file,
    offset,
    e.receivedAt,
    e.sessionId,
    projectId,
    e.version,
    e.modelId,
    e.effort,
    e.fiveUsed,
    e.fiveResets,
    e.weekUsed,
    e.weekResets,
    e.spendUsed,
    e.spendResets,
    e.contextSize,
    e.contextUsedPct,
    e.totalInput,
    e.totalOutput,
    e.usage?.input ?? null,
    e.usage?.output ?? null,
    e.usage?.cacheCreation ?? null,
    e.usage?.cacheRead ?? null,
    flag(e.exceeds200k),
    flag(e.cacheWarm),
    e.cacheTtl,
    e.cacheExpiresAt,
    e.cacheRequests,
    e.cacheMisses,
    e.cacheHitRatio,
    e.cacheLastMissAt,
    e.cacheLastMissCauses === null ? null : JSON.stringify(e.cacheLastMissCauses),
    e.costUsd,
    e.apiDurationMs,
    e.durationMs,
    e.gitWorktree,
    e.invalid.length === 0 ? null : JSON.stringify(e.invalid),
  );
  return Number(info.changes) > 0;
}

function ingestLine(s: Statements, file: string, offset: number, bytes: Uint8Array, result: IngestResult): void {
  let text: string;
  try {
    text = utf8.decode(bytes);
  } catch {
    result.skipped++;
    return;
  }
  const event = parseEventLine(text);
  if (event === null) {
    result.skipped++;
    return;
  }
  const projectId = resolveProject(s, event);
  s.upsertSession.run(event.sessionId, projectId, event.receivedAt, event.receivedAt, event.modelId, event.gitWorktree, event.worktree);
  if (insertEvent(s, file, offset, projectId, event)) result.inserted++;
  else result.duplicates++;
}

/**
 * Reads complete lines from the saved position, one chunk per transaction. The position
 * is re-read inside the transaction, and every event is unique by file and byte offset,
 * so concurrent readers never create duplicates.
 */
function ingestFile(db: DatabaseSync, s: Statements, eventsDir: string, name: string, chunkBytes: number, uid: number, result: IngestResult): void {
  const path = join(eventsDir, name);
  let resyncing = false;
  for (;;) {
    const more = transaction(db, () => {
      const head = readRangeChecked(path, true, 0, HEAD_BYTES, uid);
      if (head === null) return false;
      const firstNewline = head.bytes.indexOf(NEWLINE);
      const firstLineSha = firstNewline === -1 ? "" : sha256(head.bytes.subarray(0, firstNewline + 1));

      const row = one<FileRow>(s.getFile, name);
      let offset = row === undefined ? 0 : Number(row.read_offset);
      const replaced =
        row !== undefined &&
        (Number(row.dev) !== head.dev ||
          Number(row.ino) !== head.ino ||
          head.size < offset ||
          (row.first_line_sha256 !== "" && row.first_line_sha256 !== firstLineSha));
      if (replaced) {
        s.deleteFileEvents.run(name);
        offset = 0;
        resyncing = false;
        if (!result.resetFiles.includes(name)) result.resetFiles.push(name);
      }

      const chunk = readRangeChecked(path, true, offset, chunkBytes, uid);
      if (chunk === null) return false;
      let position = 0;
      for (let end = chunk.bytes.indexOf(NEWLINE); end !== -1; end = chunk.bytes.indexOf(NEWLINE, position)) {
        // The tail of a line longer than a chunk was already counted as skipped.
        if (resyncing) resyncing = false;
        else ingestLine(s, name, offset + position, chunk.bytes.subarray(position, end), result);
        position = end + 1;
      }
      const full = chunk.bytes.length === chunkBytes;
      if (position === 0 && full) {
        if (!resyncing) result.skipped++;
        resyncing = true;
        position = chunk.bytes.length;
      }
      s.putFile.run(name, head.dev, head.ino, offset + position, firstLineSha);
      return full;
    });
    if (!more) return;
  }
}

function removeOrphans(db: DatabaseSync): void {
  transaction(db, () => {
    db.exec(`
      DELETE FROM sessions WHERE session_id NOT IN (SELECT session_id FROM events);
      UPDATE sessions SET
        first_at = (SELECT MIN(received_at) FROM events WHERE events.session_id = sessions.session_id),
        last_at = (SELECT MAX(received_at) FROM events WHERE events.session_id = sessions.session_id);
      DELETE FROM project_dirs WHERE project_id NOT IN (
        SELECT project_id FROM events WHERE project_id IS NOT NULL
        UNION SELECT project_id FROM sessions WHERE project_id IS NOT NULL);
      DELETE FROM projects WHERE id NOT IN (
        SELECT project_id FROM events WHERE project_id IS NOT NULL
        UNION SELECT project_id FROM sessions WHERE project_id IS NOT NULL);
    `);
  });
}

/** Reads new lines from every monthly event file into the index. */
export function ingest(db: DatabaseSync, home: string, options: IngestOptions = {}): IngestResult {
  const uid = options.uid ?? currentUid();
  const chunkBytes = options.chunkBytes ?? DEFAULT_CHUNK_BYTES;
  const eventsDir = join(home, "events");
  assertPrivateDir(eventsDir, uid);

  const s = prepare(db);
  const result: IngestResult = { files: 0, inserted: 0, duplicates: 0, skipped: 0, resetFiles: [] };
  for (const name of readdirSync(eventsDir).filter((n) => MONTH_FILE.test(n)).sort()) {
    result.files++;
    ingestFile(db, s, eventsDir, name, chunkBytes, uid, result);
  }
  if (result.resetFiles.length > 0) removeOrphans(db);
  return result;
}
