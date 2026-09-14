export interface RepoIdentity {
  host: string;
  owner: string;
  name: string;
}

export interface Usage {
  input: number;
  output: number;
  cacheCreation: number;
  cacheRead: number;
}

/** One validated line from events/*.jsonl, flattened for the index. Unknown values are null, never 0. */
export interface IndexedEvent {
  receivedAt: number;
  sessionId: string;
  version: string | null;
  modelId: string | null;
  effort: string | null;
  projectDir: string | null;
  gitWorktree: string | null;
  worktree: string | null;
  repo: RepoIdentity | null;
  fiveUsed: number | null;
  fiveResets: number | null;
  weekUsed: number | null;
  weekResets: number | null;
  spendUsed: number | null;
  spendResets: number | null;
  contextSize: number | null;
  contextUsedPct: number | null;
  totalInput: number | null;
  totalOutput: number | null;
  usage: Usage | null;
  exceeds200k: boolean | null;
  cacheWarm: boolean | null;
  cacheTtl: string | null;
  cacheExpiresAt: number | null;
  cacheRequests: number | null;
  cacheMisses: number | null;
  cacheHitRatio: number | null;
  cacheLastMissAt: number | null;
  cacheLastMissCauses: string[] | null;
  costUsd: number | null;
  apiDurationMs: number | null;
  durationMs: number | null;
  /** Fields the collector or the index rejected. */
  invalid: string[];
}

type Json = Record<string, unknown>;

const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

const SESSION_ID = /^[A-Za-z0-9._-]{1,128}$/;
/**
 * Control, zero-width and bidirectional characters are never stored, since text is shown later.
 * Built from a string: Node's type stripping turns   and   escapes inside a regex
 * literal into real line terminators, which breaks the module.
 */
const UNSAFE_TEXT = new RegExp("[\\u0000-\\u001f\\u007f-\\u009f\\u200b-\\u200f\\u2028\\u2029\\u202a-\\u202e\\u2066-\\u2069\\ufeff]");
const MISS_CAUSE = /^[a-z0-9_]{1,64}$/;
const COLLECTOR_PATH = /^[A-Za-z0-9_.]{1,256}$/;
const EPOCH_S_MIN = 1_500_000_000;
const EPOCH_S_MAX = 10_000_000_000;
const MAX_INT = Number.MAX_SAFE_INTEGER;

/** The event files are written by the collector but read as untrusted input. */
class Fields {
  readonly invalid: string[] = [];

  bad(path: string): null {
    this.invalid.push(path);
    return null;
  }

  obj(v: unknown, path: string): Json | null {
    if (v === undefined || v === null) return null;
    return isObj(v) ? v : this.bad(path);
  }

  int(v: unknown, path: string, min = 0, max = MAX_INT): number | null {
    if (v === undefined || v === null) return null;
    return typeof v === "number" && Number.isSafeInteger(v) && v >= min && v <= max ? v : this.bad(path);
  }

  num(v: unknown, path: string, min = 0, max = MAX_INT): number | null {
    if (v === undefined || v === null) return null;
    return typeof v === "number" && Number.isFinite(v) && v >= min && v <= max ? v : this.bad(path);
  }

  text(v: unknown, path: string, maxLength = 4096): string | null {
    if (v === undefined || v === null) return null;
    return typeof v === "string" && v.length > 0 && v.length <= maxLength && !UNSAFE_TEXT.test(v) ? v : this.bad(path);
  }

  bool(v: unknown, path: string): boolean | null {
    if (v === undefined || v === null) return null;
    return typeof v === "boolean" ? v : this.bad(path);
  }
}

function limitWindow(f: Fields, limits: Json | null, key: string, maxPercentage: number): [number | null, number | null] {
  const path = `rate_limits.${key}`;
  const window = limits === null ? null : f.obj(limits[key], path);
  if (window === null) return [null, null];
  const used = f.num(window.used_percentage, `${path}.used_percentage`, 0, maxPercentage);
  const resets = f.int(window.resets_at, `${path}.resets_at`, EPOCH_S_MIN, EPOCH_S_MAX);
  return used === null || resets === null ? [null, null] : [used, resets];
}

function usage(f: Fields, v: unknown): Usage | null {
  const path = "context_window.current_usage";
  const o = f.obj(v, path);
  if (o === null) return null;
  const input = f.int(o.input_tokens, `${path}.input_tokens`);
  const output = f.int(o.output_tokens, `${path}.output_tokens`);
  const cacheCreation = f.int(o.cache_creation_input_tokens, `${path}.cache_creation_input_tokens`);
  const cacheRead = f.int(o.cache_read_input_tokens, `${path}.cache_read_input_tokens`);
  if (input === null || output === null || cacheCreation === null || cacheRead === null) return null;
  return { input, output, cacheCreation, cacheRead };
}

function repoIdentity(f: Fields, v: unknown): RepoIdentity | null {
  const o = f.obj(v, "workspace.repo");
  if (o === null) return null;
  const host = f.text(o.host, "workspace.repo.host", 256);
  const owner = f.text(o.owner, "workspace.repo.owner", 512);
  const name = f.text(o.name, "workspace.repo.name", 256);
  return host === null || owner === null || name === null ? null : { host, owner, name };
}

function missCauses(f: Fields, cache: Json | null): string[] | null {
  const cause = cache === null ? null : f.obj(cache.last_miss_cause, "prompt_cache.last_miss_cause");
  if (cause === null) return null;
  const causes = cause.causes;
  if (!Array.isArray(causes) || causes.length > 32 || !causes.every((c) => typeof c === "string" && MISS_CAUSE.test(c))) {
    return f.bad("prompt_cache.last_miss_cause.causes");
  }
  return causes as string[];
}

function collectorInvalid(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((p): p is string => typeof p === "string" && COLLECTOR_PATH.test(p)).map((p) => `insamlaren:${p}`);
}

/** Returns null for lines that cannot be used at all: not JSON, wrong format, time or session. */
export function parseEventLine(line: string): IndexedEvent | null {
  let data: unknown;
  try {
    data = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isObj(data) || data.v !== 1) return null;
  const receivedAt = data.received_at;
  if (typeof receivedAt !== "number" || !Number.isSafeInteger(receivedAt) || receivedAt < EPOCH_S_MIN * 1000 || receivedAt > EPOCH_S_MAX * 1000) {
    return null;
  }
  if (typeof data.session_id !== "string" || !SESSION_ID.test(data.session_id)) return null;

  const f = new Fields();
  const model = f.obj(data.model, "model");
  const workspace = f.obj(data.workspace, "workspace");
  const worktree = f.obj(data.worktree, "worktree");
  const context = f.obj(data.context_window, "context_window");
  const limits = f.obj(data.rate_limits, "rate_limits");
  const cache = f.obj(data.prompt_cache, "prompt_cache");
  const cost = f.obj(data.cost, "cost");
  const [fiveUsed, fiveResets] = limitWindow(f, limits, "five_hour", 100);
  const [weekUsed, weekResets] = limitWindow(f, limits, "seven_day", 100);
  const [spendUsed, spendResets] = limitWindow(f, limits, "spend_limit", 100_000);

  const event: IndexedEvent = {
    receivedAt,
    sessionId: data.session_id,
    version: f.text(data.version, "version", 64),
    modelId: model === null ? null : f.text(model.id, "model.id", 256),
    effort: f.text(data.effort, "effort", 32),
    projectDir: workspace === null ? null : f.text(workspace.project_dir, "workspace.project_dir"),
    gitWorktree: workspace === null ? null : f.text(workspace.git_worktree, "workspace.git_worktree", 256),
    worktree: worktree === null ? null : f.text(worktree.name, "worktree.name", 256),
    repo: workspace === null ? null : repoIdentity(f, workspace.repo),
    fiveUsed,
    fiveResets,
    weekUsed,
    weekResets,
    spendUsed,
    spendResets,
    contextSize: context === null ? null : f.int(context.context_window_size, "context_window.context_window_size"),
    contextUsedPct: context === null ? null : f.num(context.used_percentage, "context_window.used_percentage", 0, 100),
    totalInput: context === null ? null : f.int(context.total_input_tokens, "context_window.total_input_tokens"),
    totalOutput: context === null ? null : f.int(context.total_output_tokens, "context_window.total_output_tokens"),
    usage: context === null ? null : usage(f, context.current_usage),
    exceeds200k: f.bool(data.exceeds_200k_tokens, "exceeds_200k_tokens"),
    cacheWarm: cache === null ? null : f.bool(cache.warm, "prompt_cache.warm"),
    cacheTtl: cache === null ? null : f.text(cache.ttl, "prompt_cache.ttl", 16),
    cacheExpiresAt: cache === null ? null : f.int(cache.expires_at, "prompt_cache.expires_at", EPOCH_S_MIN, EPOCH_S_MAX),
    cacheRequests: cache === null ? null : f.int(cache.requests, "prompt_cache.requests"),
    cacheMisses: cache === null ? null : f.int(cache.misses, "prompt_cache.misses"),
    cacheHitRatio: cache === null ? null : f.num(cache.hit_ratio, "prompt_cache.hit_ratio", 0, 1),
    cacheLastMissAt: cache === null ? null : f.int(cache.last_miss_at, "prompt_cache.last_miss_at", EPOCH_S_MIN, EPOCH_S_MAX),
    cacheLastMissCauses: missCauses(f, cache),
    costUsd: cost === null ? null : f.num(cost.total_cost_usd, "cost.total_cost_usd", 0, 1_000_000),
    apiDurationMs: cost === null ? null : f.num(cost.total_api_duration_ms, "cost.total_api_duration_ms"),
    durationMs: cost === null ? null : f.num(cost.total_duration_ms, "cost.total_duration_ms"),
    invalid: [],
  };
  event.invalid = [...collectorInvalid(data.invalid), ...f.invalid];
  return event;
}
