import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { EventRecord } from "./record.ts";

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

export function tokeniserHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.TOKENISER_HOME || join(homedir(), ".tokeniser");
}

/** Event files rotate monthly, named by UTC month. */
export function monthFile(home: string, epochMs: number): string {
  const d = new Date(epochMs);
  const month = String(d.getUTCMonth() + 1).padStart(2, "0");
  return join(home, "events", `${d.getUTCFullYear()}-${month}.jsonl`);
}

/**
 * Identifies the measured values of a record. Excludes what changes on every run
 * without new data: the receive time and the session's wall-clock duration.
 */
export function fingerprint(record: EventRecord): string {
  const { received_at: _receivedAt, cost, ...rest } = record;
  const stable = { ...rest, cost: cost && { ...cost, total_duration_ms: undefined } };
  return createHash("sha256").update(JSON.stringify(stable)).digest("hex");
}

export type WriteResult = "appended" | "unchanged";

export function writeRecord(home: string, record: EventRecord): WriteResult {
  const stateDir = join(home, "state");
  const statePath = join(stateDir, `${record.session_id}.last`);
  const print = fingerprint(record);

  let last: string | undefined;
  try {
    last = readFileSync(statePath, "utf8");
  } catch {
    last = undefined;
  }
  if (last === print) return "unchanged";

  mkdirSync(join(home, "events"), { recursive: true, mode: DIR_MODE });
  mkdirSync(stateDir, { recursive: true, mode: DIR_MODE });
  appendFileSync(monthFile(home, record.received_at), JSON.stringify(record) + "\n", { mode: FILE_MODE });
  writeFileSync(statePath, print, { mode: FILE_MODE });
  return "appended";
}

/** Records that a run was rejected, without any of the input. Never throws. */
export function logProblem(home: string, kind: string, epochMs: number): void {
  try {
    mkdirSync(home, { recursive: true, mode: DIR_MODE });
    appendFileSync(join(home, "problems.jsonl"), JSON.stringify({ at: epochMs, kind }) + "\n", { mode: FILE_MODE });
  } catch {
    // The status line must never fail because of Tokeniser.
  }
}
