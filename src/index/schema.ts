/** Bump when the schema changes; an index with another version is deleted and rebuilt from JSONL. */
export const SCHEMA_VERSION = 1;

export const EVENT_COLUMNS = [
  "source_file",
  "source_offset",
  "received_at",
  "session_id",
  "project_id",
  "version",
  "model_id",
  "effort",
  "five_used",
  "five_resets",
  "week_used",
  "week_resets",
  "spend_used",
  "spend_resets",
  "context_size",
  "context_used_pct",
  "total_input",
  "total_output",
  "usage_input",
  "usage_output",
  "usage_cache_creation",
  "usage_cache_read",
  "exceeds_200k",
  "cache_warm",
  "cache_ttl",
  "cache_expires_at",
  "cache_requests",
  "cache_misses",
  "cache_hit_ratio",
  "cache_last_miss_at",
  "cache_last_miss_causes",
  "cost_usd",
  "api_duration_ms",
  "duration_ms",
  "git_worktree",
  "invalid_fields",
] as const;

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS source_files (
  name TEXT PRIMARY KEY,
  dev INTEGER NOT NULL,
  ino INTEGER NOT NULL,
  read_offset INTEGER NOT NULL,
  first_line_sha256 TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('repo', 'dir')),
  label TEXT NOT NULL,
  repo_host TEXT,
  repo_owner TEXT,
  repo_name TEXT,
  dir TEXT
) STRICT;

CREATE TABLE IF NOT EXISTS project_dirs (
  dir TEXT PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id)
) STRICT;

CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY,
  project_id INTEGER REFERENCES projects(id),
  first_at INTEGER NOT NULL,
  last_at INTEGER NOT NULL,
  model_id TEXT,
  git_worktree TEXT,
  worktree TEXT
) STRICT;

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY,
  source_file TEXT NOT NULL,
  source_offset INTEGER NOT NULL,
  received_at INTEGER NOT NULL,
  session_id TEXT NOT NULL REFERENCES sessions(session_id),
  project_id INTEGER REFERENCES projects(id),
  version TEXT,
  model_id TEXT,
  effort TEXT,
  five_used REAL,
  five_resets INTEGER,
  week_used REAL,
  week_resets INTEGER,
  spend_used REAL,
  spend_resets INTEGER,
  context_size INTEGER,
  context_used_pct REAL,
  total_input INTEGER,
  total_output INTEGER,
  usage_input INTEGER,
  usage_output INTEGER,
  usage_cache_creation INTEGER,
  usage_cache_read INTEGER,
  exceeds_200k INTEGER,
  cache_warm INTEGER,
  cache_ttl TEXT,
  cache_expires_at INTEGER,
  cache_requests INTEGER,
  cache_misses INTEGER,
  cache_hit_ratio REAL,
  cache_last_miss_at INTEGER,
  cache_last_miss_causes TEXT,
  cost_usd REAL,
  api_duration_ms REAL,
  duration_ms REAL,
  git_worktree TEXT,
  invalid_fields TEXT,
  UNIQUE (source_file, source_offset)
) STRICT;

CREATE INDEX IF NOT EXISTS events_received ON events(received_at);
CREATE INDEX IF NOT EXISTS events_session ON events(session_id, received_at);
CREATE INDEX IF NOT EXISTS events_project ON events(project_id, received_at);
`;
