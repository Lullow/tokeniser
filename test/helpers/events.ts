import { appendFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { initStore } from "../../src/collector/store.ts";

export interface EventOptions {
  at: number;
  session?: string;
  dir?: string | null;
  repo?: { host: string; owner: string; name: string } | null;
  gitWorktree?: string;
  five?: number;
  fiveResets?: number;
  /** Null leaves out rate_limits.seven_day. */
  week?: number | null;
  /** Epoch seconds. */
  weekResets?: number;
  context?: number;
  model?: string;
  /** Null leaves out cost. */
  cost?: number | null;
  usage?: { input: number; output: number; cacheCreation: number; cacheRead: number };
  missCauses?: string[];
  /** Epoch seconds. */
  missAt?: number;
}

/** One line in the collector's stored format. */
export function eventLine(o: EventOptions): string {
  const workspace: Record<string, unknown> = {};
  if (o.dir !== null) workspace.project_dir = o.dir ?? "/home/user/projects/alpha";
  if (o.repo) workspace.repo = o.repo;
  if (o.gitWorktree) workspace.git_worktree = o.gitWorktree;
  const usage = o.usage ?? { input: 10, output: 1_500, cacheCreation: 2_000, cacheRead: 197_990 };
  const record: Record<string, unknown> = {
    v: 1,
    received_at: o.at,
    session_id: o.session ?? "session-a",
    version: "2.1.270",
    model: { id: o.model ?? "claude-opus-5", display_name: "Opus 5" },
    effort: "xhigh",
    fast_mode: false,
    workspace,
    context_window: {
      context_window_size: 1_000_000,
      used_percentage: o.context ?? 20,
      total_input_tokens: 200_000,
      total_output_tokens: 1_500,
      current_usage: {
        input_tokens: usage.input,
        output_tokens: usage.output,
        cache_creation_input_tokens: usage.cacheCreation,
        cache_read_input_tokens: usage.cacheRead,
      },
    },
    exceeds_200k_tokens: false,
    rate_limits: {
      five_hour: { used_percentage: o.five ?? 17, resets_at: o.fiveResets ?? 1_789_428_600 },
      ...(o.week === null ? {} : { seven_day: { used_percentage: o.week ?? 5, resets_at: o.weekResets ?? 1_789_600_000 } }),
    },
  };
  if (o.cost !== null) record.cost = { total_cost_usd: o.cost ?? 1.5, total_duration_ms: 60_000, total_api_duration_ms: 20_000 };
  if (o.missCauses !== undefined) {
    record.prompt_cache = { warm: true, ttl: "1h", last_miss_at: o.missAt ?? Math.floor(o.at / 1000), last_miss_cause: { causes: o.missCauses } };
  }
  return JSON.stringify(record) + "\n";
}

export function makeStore(): string {
  const home = join(mkdtempSync(join(tmpdir(), "tokeniser-index-")), ".tokeniser");
  initStore(home);
  return home;
}

export function appendEvents(home: string, month: string, lines: string | string[]): void {
  appendFileSync(join(home, "events", `${month}.jsonl`), Array.isArray(lines) ? lines.join("") : lines, { mode: 0o600 });
}

/** Everything in the index except generated ids, in a stable order. */
export function dumpIndex(db: DatabaseSync): string {
  const rows = (sql: string) => db.prepare(sql).all();
  return JSON.stringify({
    events: rows(
      "SELECT e.*, p.key AS project_key FROM events e LEFT JOIN projects p ON p.id = e.project_id ORDER BY e.source_file, e.source_offset",
    ).map(({ id: _id, project_id: _projectId, ...rest }) => rest),
    sessions: rows(
      "SELECT s.session_id, s.first_at, s.last_at, s.model_id, s.git_worktree, s.worktree, p.key AS project_key FROM sessions s LEFT JOIN projects p ON p.id = s.project_id ORDER BY s.session_id",
    ),
    projects: rows("SELECT key, kind, label FROM projects ORDER BY key"),
    dirs: rows("SELECT d.dir, p.key FROM project_dirs d JOIN projects p ON p.id = d.project_id ORDER BY d.dir"),
  });
}
