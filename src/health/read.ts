import { accessSync, constants, lstatSync, readdirSync, type Stats } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  collectorLayout,
  ENV_PATH,
  parseConnectionState,
  statusLineCommand,
  type CollectorLayout,
  type ConnectionState,
} from "../connect/plan.ts";
import {
  assertPrivateDir,
  assertTrustedAncestors,
  currentUid,
  readFileChecked,
  readRangeChecked,
  readRegularFile,
  sha256,
  UnsafePathError,
} from "../secure/fs.ts";
import {
  RECENT_MS,
  type CollectorFacts,
  type DataFacts,
  type ExecutableCheck,
  type HealthFacts,
  type Outcome,
  type ProblemCount,
  type RuntimeFacts,
  type SettingsFacts,
  type SettingsFile,
} from "./model.ts";

/** Where Claude Code reads managed settings on Linux and WSL. */
export const MANAGED_DIR = "/etc/claude-code";

const KIB = 1024;
const MIB = 1024 * KIB;
const SETTINGS_MAX_BYTES = MIB;
const MAX_DROP_INS = 64;
const MAX_FOLDERS = 32;
const MAX_INVALID_EVENTS = 1000;
const PROBLEMS_TAIL_BYTES = 64 * KIB;
const FIELD_PATH = /^[a-z0-9_.]{1,256}$/;
const PROBLEM_KIND = /^[a-z_]{1,32}$/;
const utf8 = new TextDecoder("utf-8", { fatal: true });

type Row = Record<string, unknown>;
type Json = Record<string, unknown>;

const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const numberOrNull = (v: unknown): number | null => (typeof v === "number" || typeof v === "bigint" ? Number(v) : null);
const errnoCode = (error: unknown): string | undefined => (error as NodeJS.ErrnoException | null)?.code;

export type HealthIndex = { db: DatabaseSync } | { error: string };

export interface HealthInput {
  home: string;
  claudeDir: string;
  managedDir: string;
  workspaceFolders: readonly string[];
  index: HealthIndex;
  inWindowProject: boolean | null;
  now: number;
  uid?: number;
}

/** A settings file that exists but cannot be inspected; the message completes "<file> …". */
class SettingsError extends Error {}

function attempt<T>(read: () => T): Outcome<T> {
  try {
    return { ok: true, value: read() };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** "~/.claude/settings.json" rather than the full path, when under the home directory. */
function display(path: string): string {
  const home = homedir();
  return path.startsWith(`${home}/`) ? `~/${path.slice(home.length + 1)}` : path;
}

function reasonOf(error: unknown): string {
  if (error instanceof UnsafePathError) return error.message.slice(error.path.length + 1).replace(/\.$/, "");
  if (error instanceof SettingsError) return error.message;
  return `kan inte läsas (${errnoCode(error) ?? (error instanceof Error ? error.message : String(error))})`;
}

export function readDataFacts(db: DatabaseSync, now: number): DataFacts {
  const row = db
    .prepare(
      `SELECT e.received_at AS at, e.session_id AS sessionId, e.version, p.label, e.five_used AS five, e.week_used AS week,
         e.context_used_pct AS context, e.usage_input AS usage
       FROM events e LEFT JOIN projects p ON p.id = e.project_id ORDER BY e.received_at DESC, e.id DESC LIMIT 1`,
    )
    .get() as Row | undefined;

  const lastReset = (column: "five_resets" | "week_resets"): number | null => {
    const found = db.prepare(`SELECT ${column} AS resets FROM events WHERE ${column} IS NOT NULL ORDER BY received_at DESC, id DESC LIMIT 1`).get() as
      | Row
      | undefined;
    const seconds = numberOrNull(found?.resets);
    return seconds === null ? null : seconds * 1000;
  };

  const fields = new Set<string>();
  let events = 0;
  const invalidRows = db
    .prepare("SELECT invalid_fields AS fields FROM events WHERE invalid_fields IS NOT NULL AND received_at >= ? ORDER BY received_at DESC LIMIT ?")
    .all(now - RECENT_MS, MAX_INVALID_EVENTS) as Row[];
  for (const invalid of invalidRows) {
    events++;
    let paths: unknown;
    try {
      paths = typeof invalid.fields === "string" ? JSON.parse(invalid.fields) : null;
    } catch {
      continue;
    }
    if (!Array.isArray(paths)) continue;
    for (const path of paths) {
      if (typeof path !== "string") continue;
      const field = path.replace(/^insamlaren:/, "");
      if (FIELD_PATH.test(field)) fields.add(field);
    }
  }

  return {
    latest:
      row === undefined
        ? null
        : {
            at: Number(row.at),
            sessionId: String(row.sessionId),
            projectLabel: typeof row.label === "string" ? row.label : null,
            version: typeof row.version === "string" ? row.version : null,
            responded: row.usage !== null || row.context !== null,
            fiveHour: row.five !== null,
            week: row.week !== null,
            context: row.context !== null,
          },
    lastResets: { fiveHour: lastReset("five_resets"), week: lastReset("week_resets") },
    invalid: { events, fields: [...fields].sort() },
  };
}

/** Only the tail of problems.jsonl is read, since the file grows until every entry is 90 days old (known gap 6). */
export function readProblems(home: string, now: number, uid: number): ProblemCount[] {
  const path = join(home, "state", "problems.jsonl");
  const size = readRangeChecked(path, true, 0, 0, uid)?.size;
  if (size === undefined) return [];
  const offset = Math.max(0, size - PROBLEMS_TAIL_BYTES);
  const tail = readRangeChecked(path, true, offset, PROBLEMS_TAIL_BYTES, uid);
  if (tail === null) return [];
  const lines = tail.bytes.toString("utf8").split("\n");
  if (offset > 0) lines.shift();

  const counts = new Map<string, ProblemCount>();
  for (const line of lines) {
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isObj(entry) || typeof entry.kind !== "string" || !PROBLEM_KIND.test(entry.kind)) continue;
    const at = entry.at;
    if (typeof at !== "number" || !Number.isFinite(at) || at < now - RECENT_MS || at > now + 60_000) continue;
    const count = counts.get(entry.kind) ?? { kind: entry.kind, count: 0, lastAt: at };
    count.count++;
    count.lastAt = Math.max(count.lastAt, at);
    counts.set(entry.kind, count);
  }
  return [...counts.values()].sort((a, b) => b.count - a.count || a.kind.localeCompare(b.kind));
}

function readConnection(layout: CollectorLayout, uid: number): ConnectionState {
  const file = readFileChecked(layout.connection, { private: true, maxBytes: 64 * KIB }, uid);
  if (file === null) throw new Error("connection.json saknas, så Tokeniser vet inte vilken insamlare som anslöts.");
  let text: string;
  try {
    text = utf8.decode(file.bytes);
  } catch {
    throw new Error("connection.json är inte giltig UTF-8.");
  }
  return parseConnectionState(text);
}

function readCollector(layout: CollectorLayout, state: ConnectionState, uid: number): CollectorFacts {
  const file = readFileChecked(layout.collector, { private: true, maxBytes: 4 * MIB }, uid);
  if (file === null) throw new Error(`${display(layout.collector)} saknas.`);
  return { connectedAt: state.connectedAt, expectedSha256: state.collectorSha256, actualSha256: sha256(file.bytes) };
}

/** Known gap 2: the collector cannot lstat above events/ and state/, so this runs here instead. */
function checkDirectories(layout: CollectorLayout, uid: number): null {
  assertTrustedAncestors(layout.home, uid);
  for (const dir of [layout.home, layout.bin, layout.events, layout.state, layout.backup]) {
    try {
      assertPrivateDir(dir, uid);
    } catch (error) {
      if (errnoCode(error) !== "ENOENT") throw error;
      if (dir !== layout.backup) throw new Error(`${display(dir)} saknas.`);
    }
  }
  return null;
}

/** Error messages name full paths; the health row shows the home directory as ~, like its other text. */
const shorten = (text: string): string => text.replaceAll(`${homedir()}/`, "~/");

/** The same rules as when connecting: Node may belong to you, for example from nvm; env must belong to root. */
function checkExecutable(path: string, owners: "root" | "root-or-you", uid: number): ExecutableCheck {
  const file = display(path);
  let st: Stats;
  try {
    st = lstatSync(path);
  } catch (error) {
    if (errnoCode(error) === "ENOENT" || errnoCode(error) === "ENOTDIR") return { file, status: "missing" };
    throw error;
  }
  try {
    if (st.isSymbolicLink()) throw new UnsafePathError(path, "är en symbolisk länk");
    if (!st.isFile()) throw new UnsafePathError(path, "är inte en vanlig fil");
    if (st.uid !== 0 && (owners === "root" || st.uid !== uid)) throw new UnsafePathError(path, `ägs av uid ${st.uid}`);
    if ((st.mode & 0o022) !== 0) throw new UnsafePathError(path, `är skrivbar för andra (${(st.mode & 0o7777).toString(8).padStart(4, "0")})`);
    assertTrustedAncestors(path, uid);
  } catch (error) {
    if (error instanceof UnsafePathError) return { file, status: "unsafe", reason: shorten(error.message) };
    throw error;
  }
  try {
    accessSync(path, constants.X_OK);
  } catch {
    return { file, status: "not-executable" };
  }
  return { file, status: "ok" };
}

/** The Node file comes from the saved command, which must be exactly the one Tokeniser builds for it. */
function readRuntime(layout: CollectorLayout, state: ConnectionState, uid: number): RuntimeFacts {
  const parts = state.command.split(" ");
  const nodePath = parts[0] === ENV_PATH && parts[1] === "-i" && parts[2]?.startsWith("/") === true ? parts[2] : null;
  let commandMatches = false;
  if (nodePath !== null) {
    try {
      // With or without the line in the terminal (decision Q17b).
      commandMatches = [true, false].some((line) => statusLineCommand(nodePath, layout, { line }) === state.command);
    } catch {
      commandMatches = false;
    }
  }
  return {
    commandMatches,
    node: nodePath === null ? null : checkExecutable(nodePath, "root-or-you", uid),
    env: checkExecutable(ENV_PATH, "root", uid),
  };
}

/** Settings are untrusted input: only statusLine, disableAllHooks and allowManagedHooksOnly are looked at. */
function inspectSettings(path: string, shown: string, command: string): SettingsFile | null {
  const bytes = readRegularFile(path, SETTINGS_MAX_BYTES);
  if (bytes === null) return null;
  let text: string;
  try {
    text = utf8.decode(bytes);
  } catch {
    throw new SettingsError("är inte giltig UTF-8");
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new SettingsError("är inte giltig JSON");
  }
  if (!isObj(data)) throw new SettingsError("innehåller inte ett JSON-objekt");
  const statusLine = data.statusLine;
  return {
    file: shown,
    statusLine: statusLine === undefined || statusLine === null ? "none" : isObj(statusLine) && statusLine.command === command ? "tokeniser" : "other",
    disableAllHooks: typeof data.disableAllHooks === "boolean" ? data.disableAllHooks : null,
    allowManagedHooksOnly: typeof data.allowManagedHooksOnly === "boolean" ? data.allowManagedHooksOnly : null,
  };
}

function readSettings(input: HealthInput, command: string): SettingsFacts {
  const unreadable: SettingsFacts["unreadable"] = [];
  const read = (path: string, shown: string): SettingsFile | null => {
    try {
      return inspectSettings(path, shown, command);
    } catch (error) {
      unreadable.push({ file: shown, error: reasonOf(error) });
      return null;
    }
  };

  const managedPaths = [join(input.managedDir, "managed-settings.json")];
  const dropInDir = join(input.managedDir, "managed-settings.d");
  try {
    const names = readdirSync(dropInDir).filter((name) => name.endsWith(".json")).sort().slice(0, MAX_DROP_INS);
    managedPaths.push(...names.map((name) => join(dropInDir, name)));
  } catch (error) {
    if (errnoCode(error) !== "ENOENT" && errnoCode(error) !== "ENOTDIR") unreadable.push({ file: dropInDir, error: reasonOf(error) });
  }
  const managed = managedPaths.flatMap((path) => read(path, display(path)) ?? []);

  const userPath = join(input.claudeDir, "settings.json");
  const user = read(userPath, display(userPath)) ?? { file: display(userPath), statusLine: "none", disableAllHooks: null, allowManagedHooksOnly: null };

  const folders = input.workspaceFolders.slice(0, MAX_FOLDERS).map((folder) => {
    const name = basename(folder) || folder;
    const shared = join(folder, ".claude", "settings.json");
    return {
      name,
      local: read(join(folder, ".claude", "settings.local.json"), `${name}/.claude/settings.local.json`),
      // Opening the home directory makes its .claude/settings.json the user file, not a project file.
      project: shared === userPath ? null : read(shared, `${name}/.claude/settings.json`),
    };
  });

  return { managed, user, folders, unreadable };
}

function shortenPaths<T>(outcome: Outcome<T>): Outcome<T> {
  return outcome.ok ? outcome : { ok: false, error: shorten(outcome.error) };
}

/** Never throws: every part that cannot be read becomes an outcome with the reason. */
export function readHealthFacts(input: HealthInput): HealthFacts {
  const uid = input.uid ?? currentUid();
  const layout = collectorLayout(input.home);
  const connection = attempt(() => readConnection(layout, uid));
  const unknownCommand = { ok: false, error: `kommandot från anslutningen är okänt. ${connection.ok ? "" : connection.error}` } as const;
  const index = input.index;
  return {
    checkedAt: input.now,
    data: shortenPaths("db" in index ? attempt(() => readDataFacts(index.db, input.now)) : { ok: false, error: index.error }),
    inWindowProject: input.inWindowProject,
    problems: shortenPaths(attempt(() => readProblems(input.home, input.now, uid))),
    collector: shortenPaths(connection.ok ? attempt(() => readCollector(layout, connection.value, uid)) : connection),
    directories: shortenPaths(attempt(() => checkDirectories(layout, uid))),
    runtime: shortenPaths(connection.ok ? attempt(() => readRuntime(layout, connection.value, uid)) : unknownCommand),
    settings: shortenPaths(connection.ok ? attempt(() => readSettings(input, connection.value.command)) : unknownCommand),
  };
}
