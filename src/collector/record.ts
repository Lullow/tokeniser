export interface LimitWindow {
  used_percentage: number;
  resets_at: number;
}

export interface CurrentUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}

export interface MissCause {
  causes: string[];
  tools_added?: number;
  tools_removed?: number;
  system_char_delta?: number;
}

/**
 * One line in ~/.tokeniser/events/*.jsonl. Mirrors the field names of Claude Code's
 * status line JSON, but only the allowlisted fields. Conversation-derived fields
 * (session_name, transcript_path, prompt_id) are never read.
 */
export interface EventRecord {
  v: 1;
  received_at: number;
  session_id: string;
  version?: string;
  model?: { id?: string; display_name?: string };
  effort?: string;
  fast_mode?: boolean;
  workspace?: {
    project_dir?: string;
    git_worktree?: string;
    repo?: { host: string; owner: string; name: string };
  };
  worktree?: { name: string };
  context_window?: {
    context_window_size?: number;
    used_percentage?: number;
    total_input_tokens?: number;
    total_output_tokens?: number;
    current_usage?: CurrentUsage | null;
  };
  exceeds_200k_tokens?: boolean;
  rate_limits?: {
    five_hour?: LimitWindow;
    seven_day?: LimitWindow;
    spend_limit?: LimitWindow;
  };
  prompt_cache?: {
    warm?: boolean;
    ttl?: string;
    expires_at?: number;
    requests?: number;
    misses?: number;
    hit_ratio?: number;
    cache_write_tokens?: number;
    miss_recache_tokens?: number;
    last_miss_at?: number;
    last_miss_cause?: MissCause | null;
    recache_tokens_if_cold?: number;
  };
  cost?: {
    total_cost_usd?: number;
    total_duration_ms?: number;
    total_api_duration_ms?: number;
  };
  /** Paths of fields that were present but had an unexpected shape. */
  invalid?: string[];
}

export type ParseFailure = "empty" | "too_large" | "not_json" | "not_object" | "session_id";

export type ParseResult =
  | { ok: true; record: EventRecord }
  | { ok: false; reason: ParseFailure };

type Json = Record<string, unknown>;

const MAX_INPUT_CHARS = 1_000_000;
const SESSION_ID = /^[A-Za-z0-9._-]{1,128}$/;
const EPOCH_MIN_S = 1_500_000_000;
const EPOCH_MAX_S = 10_000_000_000;
const MAX_INT = Number.MAX_SAFE_INTEGER;

const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

function compact<T extends Json>(o: T): T | undefined {
  for (const key of Object.keys(o)) {
    if (o[key] === undefined) delete o[key];
  }
  return Object.keys(o).length > 0 ? o : undefined;
}

/** Reads loosely typed values; absent and null become undefined, wrong shapes are recorded. */
class Reader {
  readonly invalid: string[] = [];

  bad(path: string): undefined {
    if (!this.invalid.includes(path)) this.invalid.push(path);
    return undefined;
  }

  obj(v: unknown, path: string): Json | undefined {
    if (v === undefined || v === null) return undefined;
    return isObj(v) ? v : this.bad(path);
  }

  num(v: unknown, path: string, min = 0, max = MAX_INT): number | undefined {
    if (v === undefined || v === null) return undefined;
    return typeof v === "number" && Number.isFinite(v) && v >= min && v <= max ? v : this.bad(path);
  }

  str(v: unknown, path: string, maxLength = 4096): string | undefined {
    if (v === undefined || v === null) return undefined;
    return typeof v === "string" && v.length <= maxLength ? v : this.bad(path);
  }

  bool(v: unknown, path: string): boolean | undefined {
    if (v === undefined || v === null) return undefined;
    return typeof v === "boolean" ? v : this.bad(path);
  }

  epoch(v: unknown, path: string): number | undefined {
    return this.num(v, path, EPOCH_MIN_S, EPOCH_MAX_S);
  }
}

function limitWindow(r: Reader, v: unknown, path: string, maxPercentage: number): LimitWindow | undefined {
  const o = r.obj(v, path);
  if (!o) return undefined;
  const used = r.num(o.used_percentage, `${path}.used_percentage`, 0, maxPercentage);
  const resets = r.epoch(o.resets_at, `${path}.resets_at`);
  if (used === undefined || resets === undefined) {
    if (!r.invalid.some((p) => p.startsWith(path))) r.bad(path);
    return undefined;
  }
  return { used_percentage: used, resets_at: resets };
}

function currentUsage(r: Reader, v: unknown): CurrentUsage | null | undefined {
  if (v === null) return null;
  const path = "context_window.current_usage";
  const o = r.obj(v, path);
  if (!o) return undefined;
  const usage = {
    input_tokens: r.num(o.input_tokens, `${path}.input_tokens`),
    output_tokens: r.num(o.output_tokens, `${path}.output_tokens`),
    cache_creation_input_tokens: r.num(o.cache_creation_input_tokens, `${path}.cache_creation_input_tokens`),
    cache_read_input_tokens: r.num(o.cache_read_input_tokens, `${path}.cache_read_input_tokens`),
  };
  if (Object.values(usage).some((n) => n === undefined)) return r.bad(path);
  return usage as CurrentUsage;
}

function missCause(r: Reader, v: unknown): MissCause | null | undefined {
  if (v === null) return null;
  const path = "prompt_cache.last_miss_cause";
  const o = r.obj(v, path);
  if (!o) return undefined;
  const causes = o.causes;
  if (!Array.isArray(causes) || causes.length > 32 || !causes.every((c) => typeof c === "string" && c.length <= 64)) {
    return r.bad(`${path}.causes`);
  }
  return compact({
    causes: causes as string[],
    tools_added: r.num(o.tools_added, `${path}.tools_added`),
    tools_removed: r.num(o.tools_removed, `${path}.tools_removed`),
    system_char_delta: r.num(o.system_char_delta, `${path}.system_char_delta`, -MAX_INT),
  }) as MissCause;
}

function repoIdentity(r: Reader, v: unknown): { host: string; owner: string; name: string } | undefined {
  const o = r.obj(v, "workspace.repo");
  if (!o) return undefined;
  const host = r.str(o.host, "workspace.repo.host", 256);
  const owner = r.str(o.owner, "workspace.repo.owner", 512);
  const name = r.str(o.name, "workspace.repo.name", 256);
  if (host === undefined || owner === undefined || name === undefined) return r.bad("workspace.repo");
  return { host, owner, name };
}

export function parseStatusline(text: string, receivedAt: number): ParseResult {
  if (text.trim() === "") return { ok: false, reason: "empty" };
  if (text.length > MAX_INPUT_CHARS) return { ok: false, reason: "too_large" };

  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, reason: "not_json" };
  }
  if (!isObj(data)) return { ok: false, reason: "not_object" };
  if (typeof data.session_id !== "string" || !SESSION_ID.test(data.session_id)) {
    return { ok: false, reason: "session_id" };
  }

  const r = new Reader();
  const model = r.obj(data.model, "model");
  const effort = r.obj(data.effort, "effort");
  const workspace = r.obj(data.workspace, "workspace");
  const worktree = r.obj(data.worktree, "worktree");
  const context = r.obj(data.context_window, "context_window");
  const limits = r.obj(data.rate_limits, "rate_limits");
  const cache = r.obj(data.prompt_cache, "prompt_cache");
  const cost = r.obj(data.cost, "cost");

  const record: Json = {
    v: 1,
    received_at: receivedAt,
    session_id: data.session_id,
    version: r.str(data.version, "version", 64),
    model: model && compact({
      id: r.str(model.id, "model.id", 256),
      display_name: r.str(model.display_name, "model.display_name", 256),
    }),
    effort: effort && r.str(effort.level, "effort.level", 32),
    fast_mode: r.bool(data.fast_mode, "fast_mode"),
    workspace: workspace && compact({
      project_dir: r.str(workspace.project_dir, "workspace.project_dir"),
      git_worktree: r.str(workspace.git_worktree, "workspace.git_worktree", 256),
      repo: repoIdentity(r, workspace.repo),
    }),
    worktree: worktree && compact({ name: r.str(worktree.name, "worktree.name", 256) }),
    context_window: context && compact({
      context_window_size: r.num(context.context_window_size, "context_window.context_window_size"),
      used_percentage: r.num(context.used_percentage, "context_window.used_percentage", 0, 100),
      total_input_tokens: r.num(context.total_input_tokens, "context_window.total_input_tokens"),
      total_output_tokens: r.num(context.total_output_tokens, "context_window.total_output_tokens"),
      current_usage: currentUsage(r, context.current_usage),
    }),
    exceeds_200k_tokens: r.bool(data.exceeds_200k_tokens, "exceeds_200k_tokens"),
    rate_limits: limits && compact({
      five_hour: limitWindow(r, limits.five_hour, "rate_limits.five_hour", 100),
      seven_day: limitWindow(r, limits.seven_day, "rate_limits.seven_day", 100),
      spend_limit: limitWindow(r, limits.spend_limit, "rate_limits.spend_limit", 100_000),
    }),
    prompt_cache: cache && compact({
      warm: r.bool(cache.warm, "prompt_cache.warm"),
      ttl: r.str(cache.ttl, "prompt_cache.ttl", 16),
      expires_at: r.epoch(cache.expires_at, "prompt_cache.expires_at"),
      requests: r.num(cache.requests, "prompt_cache.requests"),
      misses: r.num(cache.misses, "prompt_cache.misses"),
      hit_ratio: r.num(cache.hit_ratio, "prompt_cache.hit_ratio", 0, 1),
      cache_write_tokens: r.num(cache.cache_write_tokens, "prompt_cache.cache_write_tokens"),
      miss_recache_tokens: r.num(cache.miss_recache_tokens, "prompt_cache.miss_recache_tokens"),
      last_miss_at: r.epoch(cache.last_miss_at, "prompt_cache.last_miss_at"),
      last_miss_cause: missCause(r, cache.last_miss_cause),
      recache_tokens_if_cold: r.num(cache.recache_tokens_if_cold, "prompt_cache.recache_tokens_if_cold"),
    }),
    cost: cost && compact({
      total_cost_usd: r.num(cost.total_cost_usd, "cost.total_cost_usd", 0, 1_000_000),
      total_duration_ms: r.num(cost.total_duration_ms, "cost.total_duration_ms"),
      total_api_duration_ms: r.num(cost.total_api_duration_ms, "cost.total_api_duration_ms"),
    }),
    invalid: r.invalid.length > 0 ? r.invalid : undefined,
  };

  return { ok: true, record: compact(record) as unknown as EventRecord };
}
