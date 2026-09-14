import assert from "node:assert/strict";
import { appendFileSync, renameSync, statSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { DatabaseSync } from "node:sqlite";
import { deleteIndex, indexPaths, openIndex } from "../../src/index/db.ts";
import { ingest } from "../../src/index/ingest.ts";
import { UnsafePathError } from "../../src/secure/fs.ts";
import { appendEvents, dumpIndex, eventLine, makeStore } from "../helpers/events.ts";

const T0 = 1_789_391_280_000;
const MIN = 60_000;
const REPO = { host: "github.com", owner: "Example", name: "alpha" };
const DIR = "/home/user/projects/alpha";

const count = (db: DatabaseSync, sql: string): number => Number((db.prepare(sql).get() as { n: number }).n);
const eventCount = (db: DatabaseSync): number => count(db, "SELECT COUNT(*) AS n FROM events");
// node:sqlite returns rows without a prototype, which strict deep equality treats as different.
const projects = (db: DatabaseSync) => db.prepare("SELECT key, kind, label FROM projects ORDER BY key").all().map((row) => ({ ...row }));
const eventFile = (home: string, month = "2026-09"): string => join(home, "events", `${month}.jsonl`);

function withIndex(home: string, fn: (db: DatabaseSync) => void): void {
  const db = openIndex(home);
  try {
    fn(db);
  } finally {
    db.close();
  }
}

test("läser in alla händelser och bara nya vid nästa körning", () => {
  const home = makeStore();
  appendEvents(home, "2026-09", [0, 1, 2].map((i) => eventLine({ at: T0 + i * MIN })));
  withIndex(home, (db) => {
    assert.deepEqual(ingest(db, home), { files: 1, inserted: 3, duplicates: 0, skipped: 0, resetFiles: [] });
    assert.deepEqual(ingest(db, home), { files: 1, inserted: 0, duplicates: 0, skipped: 0, resetFiles: [] });
    appendEvents(home, "2026-09", [3, 4].map((i) => eventLine({ at: T0 + i * MIN })));
    assert.equal(ingest(db, home).inserted, 2);
    assert.equal(eventCount(db), 5);
  });
});

test("en halv rad väntar tills den är klar", () => {
  const home = makeStore();
  const line = eventLine({ at: T0 });
  appendEvents(home, "2026-09", line.slice(0, 300));
  withIndex(home, (db) => {
    assert.deepEqual(ingest(db, home), { files: 1, inserted: 0, duplicates: 0, skipped: 0, resetFiles: [] });
    appendEvents(home, "2026-09", line.slice(300));
    assert.equal(ingest(db, home).inserted, 1);
  });
});

test("ny månadsfil läses och den gamla läses klart", () => {
  const home = makeStore();
  appendEvents(home, "2026-09", [eventLine({ at: T0 }), eventLine({ at: T0 + MIN })]);
  withIndex(home, (db) => {
    ingest(db, home);
    appendEvents(home, "2026-09", eventLine({ at: T0 + 2 * MIN }));
    appendEvents(home, "2026-10", eventLine({ at: T0 + 30 * 24 * 60 * MIN }));
    assert.deepEqual(ingest(db, home), { files: 2, inserted: 2, duplicates: 0, skipped: 0, resetFiles: [] });
  });
});

test("ersatt eller trunkerad fil läses om från början utan dubbletter", () => {
  const home = makeStore();
  appendEvents(home, "2026-09", [0, 1, 2].map((i) => eventLine({ at: T0 + i * MIN, session: `old-${i}` })));
  withIndex(home, (db) => {
    assert.equal(ingest(db, home).inserted, 3);

    const temp = join(home, "events", "ny.tmp");
    writeFileSync(temp, [5, 6].map((i) => eventLine({ at: T0 + i * MIN, session: "new", five: 40 })).join(""), { mode: 0o600 });
    renameSync(temp, eventFile(home));
    assert.deepEqual(ingest(db, home), { files: 1, inserted: 2, duplicates: 0, skipped: 0, resetFiles: ["2026-09.jsonl"] });
    assert.equal(eventCount(db), 2);
    assert.equal(count(db, "SELECT COUNT(*) AS n FROM sessions"), 1);

    truncateSync(eventFile(home), 0);
    appendEvents(home, "2026-09", eventLine({ at: T0 + 9 * MIN, session: "newest" }));
    assert.deepEqual(ingest(db, home), { files: 1, inserted: 1, duplicates: 0, skipped: 0, resetFiles: ["2026-09.jsonl"] });
    assert.equal(eventCount(db), 1);
  });
});

test("ogiltiga rader hoppas över och räknas", () => {
  const home = makeStore();
  appendEvents(home, "2026-09", ["inte json\n", "{}\n", JSON.stringify({ v: 2, received_at: T0, session_id: "s" }) + "\n", eventLine({ at: T0 })]);
  appendFileSync(eventFile(home), Buffer.from([0xff, 0xfe, 0x0a]));
  withIndex(home, (db) => {
    assert.deepEqual(ingest(db, home), { files: 1, inserted: 1, duplicates: 0, skipped: 4, resetFiles: [] });
  });
});

test("en rad längre än ett läsblock hoppas över och läsningen fortsätter", () => {
  const home = makeStore();
  appendEvents(home, "2026-09", ["x".repeat(5000) + "\n", eventLine({ at: T0 })]);
  withIndex(home, (db) => {
    assert.deepEqual(ingest(db, home, { chunkBytes: 2048 }), { files: 1, inserted: 1, duplicates: 0, skipped: 1, resetFiles: [] });
  });
});

test("en mapp utan repo slås ihop med repot när repo-identiteten dyker upp", () => {
  const home = makeStore();
  appendEvents(home, "2026-09", eventLine({ at: T0, session: "old", dir: DIR }));
  withIndex(home, (db) => {
    ingest(db, home);
    assert.deepEqual(projects(db), [{ key: `dir:${DIR}`, kind: "dir", label: "alpha" }]);
    appendEvents(home, "2026-09", eventLine({ at: T0 + MIN, session: "new", dir: DIR, repo: REPO }));
    ingest(db, home);
    assert.deepEqual(projects(db), [{ key: "repo:github.com/example/alpha", kind: "repo", label: "Example/alpha" }]);
    assert.equal(count(db, "SELECT COUNT(DISTINCT project_id) AS n FROM events"), 1);
    assert.equal(count(db, "SELECT COUNT(*) AS n FROM sessions WHERE project_id IS NULL"), 0);
  });
});

test("när repot redan är känt hamnar senare händelser utan repo i samma mapp på repot", () => {
  const home = makeStore();
  appendEvents(home, "2026-09", [eventLine({ at: T0, session: "new", dir: DIR, repo: REPO }), eventLine({ at: T0 + MIN, session: "old", dir: DIR })]);
  withIndex(home, (db) => {
    ingest(db, home);
    assert.deepEqual(projects(db), [{ key: "repo:github.com/example/alpha", kind: "repo", label: "Example/alpha" }]);
    assert.equal(count(db, "SELECT COUNT(DISTINCT project_id) AS n FROM events"), 1);
  });
});

test("olika repon i samma mapp slås inte ihop", () => {
  const home = makeStore();
  const other = { host: "github.com", owner: "Example", name: "beta" };
  appendEvents(home, "2026-09", [eventLine({ at: T0, session: "a", dir: DIR, repo: REPO }), eventLine({ at: T0 + MIN, session: "b", dir: DIR, repo: other })]);
  withIndex(home, (db) => {
    ingest(db, home);
    assert.equal(projects(db).length, 2);
    assert.equal(count(db, "SELECT COUNT(DISTINCT project_id) AS n FROM events"), 2);
  });
});

test("samma repo med olika skiftläge blir ett projekt", () => {
  const home = makeStore();
  appendEvents(home, "2026-09", [
    eventLine({ at: T0, session: "a", repo: { host: "github.com", owner: "Lullow", name: "tokeniser" } }),
    eventLine({ at: T0 + MIN, session: "b", repo: { host: "github.com", owner: "lullow", name: "Tokeniser" } }),
  ]);
  withIndex(home, (db) => {
    ingest(db, home);
    assert.equal(projects(db).length, 1);
  });
});

test("en sökväg med kontrolltecken sparas inte och ger inget projekt", () => {
  const home = makeStore();
  appendEvents(home, "2026-09", eventLine({ at: T0, dir: "/home/user/[31mred" }));
  withIndex(home, (db) => {
    assert.equal(ingest(db, home).inserted, 1);
    assert.equal(projects(db).length, 0);
    const row = db.prepare("SELECT project_id, invalid_fields FROM events").get() as { project_id: number | null; invalid_fields: string };
    assert.equal(row.project_id, null);
    assert.deepEqual(JSON.parse(row.invalid_fields), ["workspace.project_dir"]);
  });
});

test("en ombyggnad ger exakt samma index", () => {
  const home = makeStore();
  appendEvents(home, "2026-09", [
    eventLine({ at: T0, session: "a", dir: "/p/alpha" }),
    eventLine({ at: T0 + MIN, session: "b", dir: "/p/alpha", repo: REPO }),
    eventLine({ at: T0 + 2 * MIN, session: "c", dir: "/p/beta", gitWorktree: "wt" }),
  ]);
  appendEvents(home, "2026-10", eventLine({ at: T0 + 3 * MIN, session: "c", dir: "/p/beta", five: 50 }));
  let before = "";
  withIndex(home, (db) => {
    ingest(db, home);
    before = dumpIndex(db);
  });
  deleteIndex(home);
  withIndex(home, (db) => {
    ingest(db, home);
    assert.equal(dumpIndex(db), before);
  });
});

test("indexfilerna är privata, fel schemaversion byggs om och symlänkar avvisas", () => {
  const home = makeStore();
  const { db: path } = indexPaths(home);
  appendEvents(home, "2026-09", eventLine({ at: T0 }));
  withIndex(home, (db) => {
    ingest(db, home);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal(statSync(`${path}-wal`).mode & 0o777, 0o600);
    db.exec("PRAGMA user_version = 99");
  });
  withIndex(home, (db) => {
    assert.equal(eventCount(db), 0);
    assert.equal(ingest(db, home).inserted, 1);
  });

  deleteIndex(home);
  symlinkSync(join(home, "..", "annan.sqlite"), path);
  assert.throws(() => openIndex(home), UnsafePathError);
});
