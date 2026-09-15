import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { ensureWal } from "../../src/index/db.ts";

const fresh = (): string => join(mkdtempSync(join(tmpdir(), "tokeniser-db-")), "index.sqlite");
const modeOf = (db: DatabaseSync): unknown => (db.prepare("PRAGMA journal_mode").get() as { journal_mode: unknown }).journal_mode;

const HOLDER = `const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.argv[1]);
db.exec("BEGIN IMMEDIATE");
db.exec("CREATE TABLE IF NOT EXISTS t (x)");
console.log("låst");
setTimeout(() => { db.exec("COMMIT"); db.close(); }, Number(process.argv[2]));`;

/** Another process holds a write lock on the database for the given time. */
function holdWriteLock(path: string, ms: number): Promise<ChildProcess> {
  const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "-e", HOLDER, path, String(ms)]);
  return new Promise((resolve, reject) => {
    child.stdout.once("data", () => resolve(child));
    child.once("exit", (code) => reject(new Error(`låsprocessen avslutades med ${code}`)));
  });
}

test("utan väntan ger bytet till WAL upp direkt, och väntan har en gräns", async () => {
  const path = fresh();
  const holder = await holdWriteLock(path, 3000);
  const db = new DatabaseSync(path);
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    const direct = Date.now();
    assert.throws(() => db.exec("PRAGMA journal_mode = WAL"), /database is locked/);
    assert.ok(Date.now() - direct < 1000, "SQLite väntar inte ut busy_timeout vid bytet till WAL");

    const retried = Date.now();
    assert.throws(() => ensureWal(db, 150), /database is locked/);
    assert.ok(Date.now() - retried >= 150, "ensureWal försöker igen tills tiden har gått");
  } finally {
    db.close();
    holder.kill();
  }
});

test("bytet till WAL väntar ut en annan process i stället för att ge upp direkt", async () => {
  const path = fresh();
  const holder = await holdWriteLock(path, 300);
  const exited = once(holder, "exit");
  const db = new DatabaseSync(path);
  try {
    const started = Date.now();
    ensureWal(db);
    assert.ok(Date.now() - started >= 150, `väntade ${Date.now() - started} ms`);
    assert.equal(modeOf(db), "wal");
  } finally {
    db.close();
  }
  await exited;
});

test("ett index som redan är i WAL-läge byts inte igen och påverkas inte av en skrivare", async () => {
  const path = fresh();
  const first = new DatabaseSync(path);
  ensureWal(first);
  first.close();

  const holder = await holdWriteLock(path, 1000);
  const db = new DatabaseSync(path);
  try {
    const started = Date.now();
    ensureWal(db, 0);
    assert.ok(Date.now() - started < 200, "ingen väntan behövs när läget redan är WAL");
    assert.equal(modeOf(db), "wal");
  } finally {
    db.close();
    holder.kill();
  }
});
