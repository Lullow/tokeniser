import { homedir } from "node:os";
import { join } from "node:path";
import {
  appendPrivateFile,
  assertPrivateDir,
  currentUid,
  ensurePrivateDir,
  readFileChecked,
  replaceFileAtomic,
  sha256,
} from "../secure/fs.ts";
import type { EventRecord } from "./record.ts";

export const defaultHome = (): string => join(homedir(), ".tokeniser");

export interface StoreLayout {
  events: string;
  state: string;
  problems: string;
}

/** The collector writes only inside events/ and state/. */
export function storeLayout(home: string): StoreLayout {
  return {
    events: join(home, "events"),
    state: join(home, "state"),
    problems: join(home, "state", "problems.jsonl"),
  };
}

/** Creates the store. Done by the connect step; the collector itself never creates directories. */
export function initStore(home: string, uid = currentUid()): void {
  const store = storeLayout(home);
  ensurePrivateDir(home, uid);
  ensurePrivateDir(store.events, uid);
  ensurePrivateDir(store.state, uid);
}

/** Event files rotate monthly, named by UTC month. */
export function monthFile(home: string, epochMs: number): string {
  const d = new Date(epochMs);
  const month = String(d.getUTCMonth() + 1).padStart(2, "0");
  return join(storeLayout(home).events, `${d.getUTCFullYear()}-${month}.jsonl`);
}

/**
 * Identifies the measured values of a record. Excludes what changes on every run
 * without new data: the receive time and the session's wall-clock duration.
 */
export function fingerprint(record: EventRecord): string {
  const { received_at: _receivedAt, cost, ...rest } = record;
  return sha256(JSON.stringify({ ...rest, cost: cost && { ...cost, total_duration_ms: undefined } }));
}

export type WriteResult = "appended" | "unchanged";

export function writeRecord(home: string, record: EventRecord, uid = currentUid()): WriteResult {
  const store = storeLayout(home);
  assertPrivateDir(store.events, uid);
  assertPrivateDir(store.state, uid);

  const statePath = join(store.state, `${record.session_id}.last`);
  const print = fingerprint(record);
  const last = readFileChecked(statePath, { private: true, maxBytes: 256 }, uid);
  if (last !== null && last.bytes.toString("utf8") === print) return "unchanged";

  appendPrivateFile(monthFile(home, record.received_at), JSON.stringify(record) + "\n", uid);
  replaceFileAtomic(statePath, Buffer.from(print), { mode: 0o600 }, uid);
  return "appended";
}

/** Records that a run was rejected, without any of the input. Never throws. */
export function logProblem(home: string, kind: string, epochMs: number): void {
  try {
    const store = storeLayout(home);
    assertPrivateDir(store.state);
    appendPrivateFile(store.problems, JSON.stringify({ at: epochMs, kind }) + "\n");
  } catch {
    // The status line must never fail because of Tokeniser.
  }
}
