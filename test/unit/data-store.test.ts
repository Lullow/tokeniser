import assert from "node:assert/strict";
import { chmodSync, existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { deleteData, deleteScope, exportDays, exportEvents, readStorage } from "../../src/data/store.ts";
import { indexPaths, openIndex } from "../../src/index/db.ts";
import { ingest } from "../../src/index/ingest.ts";
import { tryAcquireLock } from "../../src/index/lock.ts";
import { ensurePrivateDir } from "../../src/secure/fs.ts";
import { appendEvents, eventLine, makeStore } from "../helpers/events.ts";

const MIN = 60_000;
const T0 = Date.UTC(2026, 8, 14, 21, 0);
const EARLY = T0 - 20 * 24 * 60 * MIN;

/** A Tokeniser directory with events in two months, state, summaries, an index, a collector and a backup. */
function populated(connected: boolean): string {
  const home = makeStore();
  ensurePrivateDir(join(home, "bin"));
  ensurePrivateDir(join(home, "backup"));
  writeFileSync(join(home, "bin", "collector.cjs"), "kod", { mode: 0o600 });
  writeFileSync(join(home, "backup", "settings.0123456789abcdef.json"), "{}", { mode: 0o600 });
  if (connected) writeFileSync(join(home, "connection.json"), "{}", { mode: 0o600 });
  appendEvents(home, "2026-08", [eventLine({ at: EARLY })]);
  appendEvents(home, "2026-09", [eventLine({ at: T0 }), eventLine({ at: T0 + MIN })]);
  writeFileSync(join(home, "state", "session-a.last"), "x".repeat(64), { mode: 0o600 });
  writeFileSync(join(home, "state", "problems.jsonl"), '{"at":1,"kind":"not_json"}\n', { mode: 0o600 });
  writeFileSync(join(home, "days.jsonl"), '{"v":1,"date":"2026-08-25"}\n{"v":1,"date":"2026-09-14"}\n', { mode: 0o600 });
  writeFileSync(join(home, ".days.jsonl.0123456789abcdef.tmp"), "", { mode: 0o600 });
  const db = openIndex(home);
  try {
    ingest(db, home);
  } finally {
    db.close();
  }
  return home;
}

test("dataraden räknar händelser, första händelsen och storleken", () => {
  const home = populated(true);
  const db = openIndex(home);
  try {
    const storage = readStorage(home, db);
    assert.equal(storage?.events, 3);
    assert.equal(storage?.firstAt, EARLY);
    assert.equal(storage?.days, 2);
    assert.equal(storage?.firstDay, new Date(2026, 7, 25).getTime());
    assert.ok((storage?.bytes ?? 0) > 1000);
  } finally {
    db.close();
  }
  assert.deepEqual(readStorage(home, null)?.events, 0);
  assert.equal(readStorage(join(home, "saknas"), null), null);
});

test("exporten tar alla hela rader i månadsordning, med 0600 och utan att följa en symbolisk länk", () => {
  const home = populated(true);
  appendEvents(home, "2026-09", '{"v":1,"halv');
  const out = mkdtempSync(join(tmpdir(), "tokeniser-export-"));
  const target = join(out, "export.jsonl");
  const other = join(out, "annan.txt");
  writeFileSync(other, "orörd");
  symlinkSync(other, target);

  const result = exportEvents(home, target);
  assert.deepEqual(result, { path: target, lines: 3, mode: 0o600 });
  assert.ok(lstatSync(target).isFile(), "länken ersattes av en vanlig fil");
  assert.equal(readFileSync(other, "utf8"), "orörd");
  const times = readFileSync(target, "utf8")
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line).received_at);
  assert.deepEqual(times, [EARLY, T0, T0 + MIN]);

  assert.throws(() => exportEvents(home, join(home, "export.jsonl")), /kan inte sparas i ~\/\.tokeniser/);
});

test("dagssummeringarna exporteras som de är, med 0600, och en fil som inte går att läsa stoppar exporten", () => {
  const home = populated(true);
  const out = mkdtempSync(join(tmpdir(), "tokeniser-export-"));
  const target = join(out, "dagar.jsonl");
  assert.deepEqual(exportDays(home, target), { path: target, lines: 2, mode: 0o600 });
  assert.equal(readFileSync(target, "utf8"), readFileSync(join(home, "days.jsonl"), "utf8"));
  assert.throws(() => exportDays(home, join(home, "state", "dagar.jsonl")), /kan inte sparas i ~\/\.tokeniser/);

  chmodSync(join(home, "days.jsonl"), 0o644);
  assert.throws(() => exportDays(home, join(out, "annan.jsonl")), /rättigheterna 0644/);
  assert.equal(readStorage(home, null)?.days, null, "dataraden visar inga dagar när filen inte går att läsa");
});

test("ansluten: insamlad data raderas, men mappar, anslutning och okända filer finns kvar", () => {
  const home = populated(true);
  writeFileSync(join(home, "events", "anteckning.txt"), "min", { mode: 0o600 });
  assert.equal(deleteScope(home), "collected");

  const result = deleteData(home, "collected");
  assert.deepEqual(result.remaining, [join(home, "events", "anteckning.txt")]);
  assert.deepEqual(readdirSync(join(home, "events")), ["anteckning.txt"]);
  assert.deepEqual(readdirSync(join(home, "state")), []);
  assert.ok(!existsSync(join(home, "index.sqlite")));
  assert.ok(!existsSync(join(home, "days.jsonl")), "dagssummeringarna raderas");
  assert.ok(!existsSync(join(home, ".days.jsonl.0123456789abcdef.tmp")));
  assert.ok(!existsSync(indexPaths(home).lock), "låset släpps");
  for (const kept of ["connection.json", "bin/collector.cjs", "backup/settings.0123456789abcdef.json"]) {
    assert.ok(existsSync(join(home, kept)), kept);
  }
});

test("inte ansluten: hela ~/.tokeniser tas bort, men en okänd fil lämnas kvar med sin mapp", () => {
  const home = populated(false);
  assert.equal(deleteScope(home), "everything");
  assert.deepEqual(deleteData(home, "everything"), { remaining: [] });
  assert.ok(!existsSync(home));
  assert.equal(deleteScope(home), null);

  const other = populated(false);
  writeFileSync(join(other, "backup", "egen.json"), "{}", { mode: 0o600 });
  assert.deepEqual(deleteData(other, "everything"), { remaining: [join(other, "backup", "egen.json")] });
  assert.deepEqual(readdirSync(other), ["backup"]);
});

test("raderingen avbryts utan ändringar när ett annat fönster läser in eller anslutningen har ändrats", () => {
  const home = populated(true);
  const lock = tryAcquireLock(indexPaths(home).lock);
  assert.ok(lock);
  try {
    assert.throws(() => deleteData(home, "collected"), /annat VS Code-fönster läser in/);
  } finally {
    lock.release();
  }
  assert.throws(() => deleteData(home, "everything"), /Anslutningen ändrades/);
  assert.equal(readdirSync(join(home, "events")).length, 2);
  assert.ok(existsSync(join(home, "index.sqlite")));
  assert.ok(existsSync(join(home, "state", "session-a.last")));
});
