import type { EventRecord, LimitWindow } from "./record.ts";

function limitText(label: string, window: LimitWindow | undefined, nowMs: number): string {
  if (window === undefined) return `${label} –`;
  if (window.resets_at * 1000 <= nowMs) return `${label} ↺`;
  return `${label} ${Math.round(window.used_percentage)}%`;
}

/** The short line Claude Code shows in the terminal, e.g. `5h 64% · v 31% · ktx 21%`. */
export function formatLine(record: EventRecord, nowMs: number): string {
  const context = record.context_window?.used_percentage;
  return [
    limitText("5h", record.rate_limits?.five_hour, nowMs),
    limitText("v", record.rate_limits?.seven_day, nowMs),
    context === undefined ? "ktx –" : `ktx ${Math.round(context)}%`,
  ].join(" · ");
}
