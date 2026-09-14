import type { LimitReading, Point, Snapshot, StatusSettings } from "../../src/status/model.ts";

export const MIN = 60_000;
/** 13:00 UTC, on a five-minute boundary in every time zone with whole-hour offsets. */
export const NOW = Date.UTC(2026, 8, 14, 13, 0);
export const RESET = NOW + 2 * 60 * MIN;
export const SETTINGS: StatusSettings = { mode: "both", warningAt: 80, errorAt: 95 };

export const reading = (used: number, ageMinutes = 1, resetsAt = RESET): LimitReading => ({
  used,
  resetsAt,
  measuredAt: NOW - ageMinutes * MIN,
});

/** Points measured the given minutes ago, rising by 2 percentage points each. */
export const rising = (from: number, minutesAgo: number[]): Point[] =>
  minutesAgo.map((minutes, i) => ({ at: NOW - minutes * MIN, used: from + i * 2 }));

export interface SnapOptions {
  five?: LimitReading | null;
  week?: LimitReading | null;
  fivePoints?: Point[];
  context?: number | null;
  contextAgeMinutes?: number;
  hasEvents?: boolean;
  unavailable?: string | null;
}

export function snap(o: SnapOptions = {}): Snapshot {
  return {
    unavailable: o.unavailable ?? null,
    hasEvents: o.hasEvents ?? true,
    fiveHour: { latest: o.five === undefined ? reading(64) : o.five, points: o.fivePoints ?? [] },
    week: { latest: o.week === undefined ? reading(31) : o.week, points: [] },
    session: {
      id: "session-a",
      label: "tokeniser",
      inWindowProject: true,
      modelId: "claude-opus-5",
      effort: "xhigh",
      context: {
        usedPct: o.context === undefined ? 21 : o.context,
        size: 1_000_000,
        tokens: 214_800,
        measuredAt: NOW - (o.contextAgeMinutes ?? 1) * MIN,
      },
    },
    otherActiveSessions: 0,
  };
}
