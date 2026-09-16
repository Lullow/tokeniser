import assert from "node:assert/strict";
import { chmodSync, existsSync, lstatSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { DatabaseSync } from "node:sqlite";
import { daysPath } from "../../src/history/days-file.ts";
import { maintain, type MaintenanceOptions, type MaintenanceResult } from "../../src/history/maintain.ts";
import { openIndex } from "../../src/index/db.ts";
import { ingest } from "../../src/index/ingest.ts";
import { appendEvents, eventLine, makeStore } from "../helpers/events.ts";

const DAY = 24 * 60 * 60 * 1000;
const local = (month: number, day: number, hour = 12, minute = 0): number => new Date(2026, month - 1, day, hour, minute).getTime();
/** Late enough that September 2026 is 90 days past, but not October. */
const JANUARY = new Date(2027, 0, 5, 12).getTime();

const count = (db: DatabaseSync, table: string): number => Number((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n);
const daysInFile = (home: string): [string, number][] =>
  readFileSync(daysPath(home), "utf8")
    .trimEnd()
    .split("\n")
    .map((text) => JSON.parse(text) as { date: string; v: number })
    .map((d) => [d.date, d.v]);

function withIndex<T>(home: string, fn: (db: DatabaseSync) => T): T {
  const db = openIndex(home);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

/** Like the extension: new events are read in first. */
const pass = (home: string, now: number, options: MaintenanceOptions = {}): MaintenanceResult =>
  withIndex(home, (db) => {
    ingest(db, home);
    return maintain(db, home, now, options);
  });

test("avslutade dagar summeras, och en månadsfil tas bort 90 dagar efter månadens slut, även ur indexet", () => {
  const home = makeStore();
  appendEvents(home, "2026-09", [
    eventLine({ at: local(9, 14), session: "old", dir: "/p/old" }),
    eventLine({ at: local(9, 15), session: "old", dir: "/p/old" }),
  ]);
  appendEvents(home, "2026-10", eventLine({ at: local(10, 20), session: "new", dir: "/p/new" }));

  assert.deepEqual(pass(home, JANUARY), {
    summarized: ["2026-09-14", "2026-09-15", "2026-10-20"],
    pending: false,
    removedMonths: ["2026-09.jsonl"],
    removedStateFiles: 0,
    removedProblems: false,
  });
  assert.deepEqual(readdirSync(join(home, "events")), ["2026-10.jsonl"]);
  assert.deepEqual(daysInFile(home), [["2026-09-14", 1], ["2026-09-15", 1], ["2026-10-20", 1]]);
  assert.equal(lstatSync(daysPath(home)).mode & 0o777, 0o600);
  withIndex(home, (db) => {
    assert.equal(count(db, "events"), 1);
    assert.equal(count(db, "sessions"), 1);
    assert.deepEqual(db.prepare("SELECT key FROM projects").all().map((row) => ({ ...row })), [{ key: "dir:/p/new" }]);
  });

  const before = readFileSync(daysPath(home), "utf8");
  assert.deepEqual(pass(home, JANUARY), { summarized: [], pending: false, removedMonths: [], removedStateFiles: 0, removedProblems: false });
  assert.equal(readFileSync(daysPath(home), "utf8"), before);
});

test("en dag summeras först en timme efter midnatt, och i dag aldrig", () => {
  const home = makeStore();
  appendEvents(home, "2026-09", [eventLine({ at: local(9, 15, 10) }), eventLine({ at: local(9, 16, 0, 20) })]);
  assert.deepEqual(pass(home, local(9, 16, 0, 59)).summarized, []);
  assert.equal(existsSync(daysPath(home)), false, "ingen fil skrivs utan summeringar");
  assert.deepEqual(pass(home, local(9, 16, 1, 0)).summarized, ["2026-09-15"]);
});

test("högst sju dagar per varv, och månadsfilen finns kvar tills alla dess dagar är summerade", () => {
  const home = makeStore();
  appendEvents(home, "2026-09", Array.from({ length: 10 }, (_, i) => eventLine({ at: local(9, i + 1) })));

  const first = pass(home, JANUARY);
  assert.equal(first.summarized.length, 7);
  assert.equal(first.pending, true);
  assert.deepEqual(first.removedMonths, []);

  const second = pass(home, JANUARY);
  assert.deepEqual(second.summarized, ["2026-09-08", "2026-09-09", "2026-09-10"]);
  assert.equal(second.pending, false);
  assert.deepEqual(second.removedMonths, ["2026-09.jsonl"]);
  assert.equal(daysInFile(home).length, 10);
});

test("i svensk tid summeras 1 september, som börjar i augusti enligt UTC, innan septemberfilen tas bort", () => {
  const zone = process.env.TZ;
  process.env.TZ = "Europe/Stockholm";
  try {
    const home = makeStore();
    appendEvents(home, "2026-09", [eventLine({ at: local(9, 1, 12) }), eventLine({ at: local(9, 2, 12) })]);
    const result = pass(home, JANUARY);
    assert.deepEqual(result.summarized, ["2026-09-01", "2026-09-02"]);
    assert.deepEqual(result.removedMonths, ["2026-09.jsonl"]);
  } finally {
    if (zone === undefined) delete process.env.TZ;
    else process.env.TZ = zone;
  }
});

test("en ny version räknar om dagar vars rådata finns kvar, men inte dagar vars månadsfil är borttagen", () => {
  const home = makeStore();
  appendEvents(home, "2026-09", eventLine({ at: local(9, 14) }));
  appendEvents(home, "2026-10", eventLine({ at: local(10, 20) }));
  assert.deepEqual(pass(home, JANUARY).removedMonths, ["2026-09.jsonl"]);

  assert.deepEqual(pass(home, JANUARY, { version: 2 }).summarized, ["2026-10-20"]);
  assert.deepEqual(daysInFile(home), [["2026-09-14", 1], ["2026-10-20", 2]]);
});

test("en månadsfil med olästa rader finns kvar, men en halv rad sist hindrar inte att den tas bort", () => {
  const home = makeStore();
  appendEvents(home, "2026-09", eventLine({ at: local(9, 14) }));
  withIndex(home, (db) => {
    ingest(db, home);
    appendEvents(home, "2026-09", eventLine({ at: local(9, 14, 13) }));
    assert.deepEqual(maintain(db, home, JANUARY).removedMonths, []);
  });
  assert.deepEqual(pass(home, JANUARY).removedMonths, ["2026-09.jsonl"]);

  const half = makeStore();
  appendEvents(half, "2026-09", [eventLine({ at: local(9, 14) }), '{"v":1,"received_at":']);
  assert.deepEqual(pass(half, JANUARY).removedMonths, ["2026-09.jsonl"]);
});

test("gamla filer i state/ tas bort, och problems.jsonl först när alla rader är äldre än 90 dagar", () => {
  const home = makeStore();
  appendEvents(home, "2026-10", eventLine({ at: local(10, 20) }));
  const state = (name: string, ageDays: number, content = "x") => {
    const path = join(home, "state", name);
    writeFileSync(path, content, { mode: 0o600 });
    const seconds = (JANUARY - ageDays * DAY) / 1000;
    utimesSync(path, seconds, seconds);
  };
  state("gammal.last", 100);
  state("ny.last", 1);
  state(".gammal.last.0123456789abcdef.tmp", 100);
  state("anteckning.txt", 100);
  const problems = (...ageDays: number[]) => ageDays.map((age) => JSON.stringify({ at: JANUARY - age * DAY, kind: "not_json" }) + "\n").join("");
  state("problems.jsonl", 100, problems(100, 95) + "trasig rad\n");

  const result = pass(home, JANUARY);
  assert.equal(result.removedStateFiles, 2);
  assert.equal(result.removedProblems, true);
  assert.deepEqual(readdirSync(join(home, "state")).sort(), ["anteckning.txt", "ny.last"]);

  state("problems.jsonl", 100, problems(100, 10));
  assert.equal(pass(home, JANUARY).removedProblems, false);
  assert.ok(existsSync(join(home, "state", "problems.jsonl")));
});

test("om dagssummeringarna inte kan sparas tas ingen rådata bort", () => {
  const home = makeStore();
  appendEvents(home, "2026-09", eventLine({ at: local(9, 14) }));
  withIndex(home, (db) => {
    ingest(db, home);
    chmodSync(home, 0o500);
    try {
      assert.throws(() => maintain(db, home, JANUARY), { code: "EACCES" });
    } finally {
      chmodSync(home, 0o700);
    }
  });
  assert.deepEqual(readdirSync(join(home, "events")), ["2026-09.jsonl"]);
  assert.equal(existsSync(daysPath(home)), false);
});
