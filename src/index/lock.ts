import {
  ChangedSinceReviewError,
  currentUid,
  readFileChecked,
  removeFileChecked,
  replaceFileAtomic,
  sha256,
  tryCreatePrivateFile,
} from "../secure/fs.ts";

/** A lock whose holder has not refreshed it for this long is taken over. */
export const STALE_AFTER_MS = 2 * 60 * 1000;

const POLICY = { private: true, maxBytes: 1024 };

export interface IndexLock {
  /** Returns false if another process has taken the lock over. */
  refresh(at?: number): boolean;
  release(): void;
}

export interface LockOptions {
  now?: number;
  uid?: number;
  isAlive?: (pid: number) => boolean;
}

export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

const lockContent = (at: number): Buffer => Buffer.from(JSON.stringify({ pid: process.pid, at }) + "\n");

function isStale(bytes: Buffer, now: number, isAlive: (pid: number) => boolean): boolean {
  try {
    const data = JSON.parse(bytes.toString("utf8")) as { pid?: unknown; at?: unknown };
    if (typeof data.pid !== "number" || !Number.isSafeInteger(data.pid) || data.pid <= 0 || typeof data.at !== "number") return true;
    return !isAlive(data.pid) || now - data.at > STALE_AFTER_MS;
  } catch {
    return true;
  }
}

/**
 * Lets one VS Code window at a time read events into the index. The lock only avoids
 * wasted work: correctness comes from transactions and unique source positions.
 */
export function tryAcquireLock(path: string, options: LockOptions = {}): IndexLock | null {
  const uid = options.uid ?? currentUid();
  const now = options.now ?? Date.now();
  const isAlive = options.isAlive ?? processAlive;
  let written = lockContent(now);

  if (!tryCreatePrivateFile(path, written, uid)) {
    const existing = readFileChecked(path, POLICY, uid);
    if (existing !== null) {
      if (!isStale(existing.bytes, now, isAlive)) return null;
      try {
        removeFileChecked(path, sha256(existing.bytes), POLICY, uid);
      } catch (error) {
        if (error instanceof ChangedSinceReviewError) return null;
        throw error;
      }
    }
    if (!tryCreatePrivateFile(path, written, uid)) return null;
  }

  return {
    refresh(at = Date.now()) {
      const next = lockContent(at);
      try {
        replaceFileAtomic(path, next, { mode: 0o600, expectedSha256: sha256(written), currentPolicy: POLICY }, uid);
      } catch (error) {
        if (error instanceof ChangedSinceReviewError) return false;
        throw error;
      }
      written = next;
      return true;
    },
    release() {
      try {
        removeFileChecked(path, sha256(written), POLICY, uid);
      } catch (error) {
        if (!(error instanceof ChangedSinceReviewError)) throw error;
      }
    },
  };
}
