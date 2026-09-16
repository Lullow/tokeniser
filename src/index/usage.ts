/** A gap longer than this between two events in a session counts as a break. */
export const ACTIVE_GAP_MS = 10 * 60 * 1000;

/** The usage in one status line update; null when the update carried none. */
export interface CallRow {
  sessionId: string;
  at: number;
  input: number | null;
  output: number | null;
  cacheCreation: number | null;
  cacheRead: number | null;
}

export const tokensOf = (r: CallRow): number => (r.input ?? 0) + (r.output ?? 0) + (r.cacheCreation ?? 0) + (r.cacheRead ?? 0);

/**
 * The status line only carries the latest API call, and usually shows it twice: when the
 * response starts, with a few output tokens, and when it is done. Consecutive rows in a session
 * with the same input and cache tokens are therefore one call, counted once with its highest
 * output, at the time it first appeared. Calls between two status line updates are missed,
 * which makes every sum a lower bound (decision Q16: always marked as an estimate).
 */
export function newCalls<T extends CallRow>(rows: readonly T[]): T[] {
  const open = new Map<string, T>();
  const calls: T[] = [];
  for (const row of rows) {
    if (row.input === null && row.output === null && row.cacheCreation === null && row.cacheRead === null) continue;
    const call = open.get(row.sessionId);
    if (call !== undefined && call.input === row.input && call.cacheCreation === row.cacheCreation && call.cacheRead === row.cacheRead) {
      if ((row.output ?? 0) > (call.output ?? 0)) call.output = row.output;
      continue;
    }
    const next = { ...row };
    open.set(row.sessionId, next);
    calls.push(next);
  }
  return calls;
}

/** Calls fn with every gap between consecutive events in a session, leaving out breaks. */
export function forEachActiveGap<T extends { sessionId: string; at: number }>(rows: readonly T[], fn: (row: T, ms: number) => void): void {
  const last = new Map<string, number>();
  for (const row of rows) {
    const previous = last.get(row.sessionId);
    if (previous !== undefined && row.at - previous <= ACTIVE_GAP_MS) fn(row, row.at - previous);
    last.set(row.sessionId, row.at);
  }
}
