// Development tool until the extension reads events on its own.
//   node scripts/index.ts                 read new events into ~/.tokeniser/index.sqlite and summarize
//   node scripts/index.ts --rebuild       delete the index and read every event again
//   node scripts/index.ts --json          print the result as JSON
//   node scripts/index.ts --home=<dir>    use another Tokeniser directory (tests)
//   node scripts/index.ts --no-lock       skip the lock file (tests of concurrent readers)
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { deleteIndex, indexPaths, openIndex } from "../src/index/db.ts";
import { ingest, type IngestResult } from "../src/index/ingest.ts";
import { tryAcquireLock } from "../src/index/lock.ts";
import { assertPrivateDir, assertTrustedAncestors } from "../src/secure/fs.ts";

interface Options {
  home: string;
  rebuild: boolean;
  json: boolean;
  lock: boolean;
}

interface Summary {
  events: number;
  sessions: number;
  projects: { label: string; kind: string; sessions: number; events: number; lastAt: number }[];
  limits: { receivedAt: number; fiveUsed: number | null; fiveResets: number | null; weekUsed: number | null; weekResets: number | null } | null;
}

function parseArgs(args: string[]): Options {
  const options: Options = { home: join(homedir(), ".tokeniser"), rebuild: false, json: false, lock: true };
  for (const arg of args) {
    if (arg === "--rebuild") options.rebuild = true;
    else if (arg === "--json") options.json = true;
    else if (arg === "--no-lock") options.lock = false;
    else if (arg.startsWith("--home=") && isAbsolute(arg.slice("--home=".length))) options.home = arg.slice("--home=".length);
    else throw new Error(`Okänt argument: ${arg}`);
  }
  return options;
}

function run(options: Options): { status: "ingested" | "locked"; result: IngestResult | null } {
  assertTrustedAncestors(options.home);
  assertPrivateDir(options.home);
  const lock = options.lock ? tryAcquireLock(indexPaths(options.home).lock) : null;
  if (options.lock && lock === null) return { status: "locked", result: null };
  try {
    if (options.rebuild) deleteIndex(options.home);
    const db = openIndex(options.home);
    try {
      return { status: "ingested", result: ingest(db, options.home) };
    } finally {
      db.close();
    }
  } finally {
    lock?.release();
  }
}

function summarize(db: DatabaseSync): Summary {
  const count = (sql: string): number => Number((db.prepare(sql).get() as { n: number }).n);
  const projects = db
    .prepare(
      `SELECT p.label, p.kind, COUNT(DISTINCT e.session_id) AS sessions, COUNT(e.id) AS events, MAX(e.received_at) AS lastAt
       FROM projects p JOIN events e ON e.project_id = p.id GROUP BY p.id ORDER BY lastAt DESC`,
    )
    .all() as unknown as Summary["projects"];
  const limits = db
    .prepare(
      `SELECT received_at AS receivedAt, five_used AS fiveUsed, five_resets AS fiveResets, week_used AS weekUsed, week_resets AS weekResets
       FROM events WHERE five_used IS NOT NULL OR week_used IS NOT NULL ORDER BY received_at DESC LIMIT 1`,
    )
    .get() as unknown as Summary["limits"] | undefined;
  return {
    events: count("SELECT COUNT(*) AS n FROM events"),
    sessions: count("SELECT COUNT(*) AS n FROM sessions"),
    projects: projects.map((p) => ({ ...p, sessions: Number(p.sessions), events: Number(p.events), lastAt: Number(p.lastAt) })),
    limits: limits ?? null,
  };
}

const time = (ms: number): string => new Date(ms).toLocaleString("sv-SE", { dateStyle: "short", timeStyle: "short" });
const limitText = (used: number | null, resets: number | null): string =>
  used === null || resets === null ? "saknas" : `${Math.round(used)} %, återställs ${time(resets * 1000)}`;

const quantity = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

function print(status: "ingested" | "locked", result: IngestResult | null, summary: Summary): void {
  if (status === "locked" || result === null) {
    console.log("En annan process läser in just nu. Visar indexet som det är.");
  } else {
    const inserted = quantity(result.inserted, "ny händelse", "nya händelser");
    const duplicates = quantity(result.duplicates, "dubblett", "dubbletter");
    const skipped = quantity(result.skipped, "ogiltig rad", "ogiltiga rader");
    console.log(`Inläsning: ${inserted}, ${duplicates}, ${skipped} i ${quantity(result.files, "fil", "filer")}.`);
    if (result.resetFiles.length > 0) console.log(`Lästes om från början: ${result.resetFiles.join(", ")}`);
  }
  const events = quantity(summary.events, "händelse", "händelser");
  console.log(`Index: ${events}, ${quantity(summary.sessions, "session", "sessioner")}, ${summary.projects.length} projekt.`);
  console.log("\nProjekt, senast aktiv först");
  for (const p of summary.projects) {
    const counts = `${quantity(p.sessions, "session", "sessioner")}, ${quantity(p.events, "händelse", "händelser")}`;
    console.log(`  ${p.label} (${p.kind === "repo" ? "repo" : "mapp"}): ${counts}, senast ${time(p.lastAt)}`);
  }
  console.log("\nSenaste gränser, från vilken session som helst");
  if (summary.limits === null) {
    console.log("  saknas");
  } else {
    console.log(`  5 timmar: ${limitText(summary.limits.fiveUsed, summary.limits.fiveResets)}`);
    console.log(`  vecka: ${limitText(summary.limits.weekUsed, summary.limits.weekResets)}`);
    console.log(`  mätt ${time(summary.limits.receivedAt)}`);
  }
}

try {
  const options = parseArgs(process.argv.slice(2));
  const { status, result } = run(options);
  const db = openIndex(options.home);
  let summary: Summary;
  try {
    summary = summarize(db);
  } finally {
    db.close();
  }
  if (options.json) console.log(JSON.stringify({ status, result, summary }));
  else print(status, result, summary);
} catch (error) {
  console.error(`Avbrutet: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
