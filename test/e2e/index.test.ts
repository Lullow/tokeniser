import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { openIndex } from "../../src/index/db.ts";
import { appendEvents, dumpIndex, eventLine, makeStore } from "../helpers/events.ts";

const script = fileURLToPath(new URL("../../scripts/index.ts", import.meta.url));
const WARNINGS = ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", "--disable-warning=ExperimentalWarning"];
const NODE_ARGS = [...WARNINGS, script];
const dbModule = new URL("../../src/index/db.ts", import.meta.url).href;
const T0 = 1_789_391_280_000;
const DAY = 24 * 60 * 60 * 1000;

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

const runIndex = (home: string, ...args: string[]) =>
  spawnSync(process.execPath, [...NODE_ARGS, `--home=${home}`, ...args], { encoding: "utf8", timeout: 60_000 });

const runIndexAsync = (home: string, ...args: string[]): Promise<Run> => runNodeAsync([script, `--home=${home}`, ...args]);

function runNodeAsync(args: string[]): Promise<Run> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [...WARNINGS, ...args]);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function many(month: string, total: number, start: number): string[] {
  return Array.from({ length: total }, (_, i) =>
    eventLine({ at: start + i * 1000, session: `s-${month}-${i % 7}`, dir: `/p/${i % 3}`, five: i % 100 }),
  );
}

function storeWith3000Events(): string {
  const home = makeStore();
  appendEvents(home, "2026-09", many("09", 1500, T0));
  appendEvents(home, "2026-10", many("10", 1500, T0 + 30 * DAY));
  return home;
}

function indexedEvents(home: string): number {
  const db = openIndex(home);
  try {
    return Number((db.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n);
  } finally {
    db.close();
  }
}

test("samtidiga inläsningar utan lås ger inga dubbletter", { timeout: 120_000 }, async () => {
  const home = storeWith3000Events();
  const runs = await Promise.all([1, 2, 3].map(() => runIndexAsync(home, "--no-lock", "--json")));
  for (const run of runs) assert.equal(run.code, 0, run.stderr);
  const inserted = runs.map((run) => JSON.parse(run.stdout).result.inserted as number);
  assert.equal(inserted.reduce((sum, n) => sum + n, 0), 3000);
  assert.equal(indexedEvents(home), 3000);
});

test("med lås läser en process in och de andra visar indexet som det är", { timeout: 120_000 }, async () => {
  const home = storeWith3000Events();
  const runs = await Promise.all([1, 2].map(() => runIndexAsync(home, "--json")));
  for (const run of runs) assert.equal(run.code, 0, run.stderr);
  for (const run of runs) assert.ok(["ingested", "locked"].includes(JSON.parse(run.stdout).status));
  assert.equal(indexedEvents(home), 3000);
});

/** Opens and closes the index many times, like a VS Code window refreshing. */
const CHURN = `import { openIndex } from ${JSON.stringify(dbModule)};
for (let i = 0; i < 40; i++) {
  const db = openIndex(process.argv[1]);
  db.prepare("SELECT COUNT(*) AS n FROM events").get();
  db.close();
}`;

test("fönster som öppnar och stänger samma index samtidigt får inga falsklarm", { timeout: 120_000 }, async () => {
  for (let round = 1; round <= 20; round++) {
    const home = makeStore();
    appendEvents(home, "2026-09", many("09", 200, T0));
    assert.equal(runIndex(home).status, 0);
    const runs = await Promise.all([1, 2, 3].map(() => runNodeAsync(["--input-type=module", "-e", CHURN, home])));
    for (const run of runs) assert.equal(run.code, 0, `omgång ${round}: ${run.stderr}`);
  }
});

test("--rebuild ger samma index som stegvis inläsning", { timeout: 60_000 }, () => {
  const home = makeStore();
  appendEvents(home, "2026-09", many("09", 200, T0));
  assert.equal(runIndex(home).status, 0);
  appendEvents(home, "2026-09", many("09b", 100, T0 + DAY));
  appendEvents(home, "2026-10", many("10", 100, T0 + 30 * DAY));
  assert.equal(runIndex(home).status, 0);

  const read = (): string => {
    const db = openIndex(home);
    try {
      return dumpIndex(db);
    } finally {
      db.close();
    }
  };
  const stepwise = read();
  const rebuilt = runIndex(home, "--rebuild", "--json");
  assert.equal(rebuilt.status, 0, rebuilt.stderr);
  assert.equal(JSON.parse(rebuilt.stdout).result.inserted, 400);
  assert.equal(read(), stepwise);
});

test("inspelad riktig data läses in utan ogiltiga rader", { timeout: 60_000 }, () => {
  const text = readFileSync(new URL("../fixtures/events/real-2026-09.jsonl", import.meta.url), "utf8");
  const lines = text.trim().split("\n");
  const home = makeStore();
  appendEvents(home, "2026-09", text);

  const run = runIndex(home, "--json");
  assert.equal(run.status, 0, run.stderr);
  const { result, summary } = JSON.parse(run.stdout);
  assert.deepEqual(result, { files: 1, inserted: lines.length, duplicates: 0, skipped: 0, resetFiles: [], removedFiles: [] });
  assert.equal(summary.sessions, new Set(lines.map((line) => JSON.parse(line).session_id)).size);
  assert.equal(summary.projects.length, 3);
  assert.notEqual(summary.limits, null);

  const human = runIndex(home);
  assert.equal(human.status, 0, human.stderr);
  assert.match(human.stdout, /Index: \d+ händelser, \d+ sessioner, 3 projekt\./);
});
