import assert from "node:assert/strict";
import { linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseStatusline, type EventRecord } from "../../src/collector/record.ts";
import { initStore, logProblem, monthFile, storeLayout, writeRecord } from "../../src/collector/store.ts";
import { UnsafePathError } from "../../src/secure/fs.ts";

const NOW = 1_789_391_280_000;

function record(receivedAt: number, name = "full.json"): EventRecord {
  const text = readFileSync(new URL(`../fixtures/statusline/${name}`, import.meta.url), "utf8");
  const result = parseStatusline(text, receivedAt);
  assert.ok(result.ok);
  return result.record;
}

function tempHome(): string {
  const home = join(mkdtempSync(join(tmpdir(), "tokeniser-test-")), ".tokeniser");
  initStore(home);
  return home;
}

const lines = (home: string): string[] => readFileSync(monthFile(home, NOW), "utf8").trim().split("\n");

test("sparar bara när mätvärdena ändras", () => {
  const home = tempHome();
  assert.equal(writeRecord(home, record(NOW)), "appended");

  const rerun = record(NOW + 60_000);
  rerun.cost!.total_duration_ms = 5_472_000;
  assert.equal(writeRecord(home, rerun), "unchanged");

  const newReply = record(NOW + 120_000);
  newReply.rate_limits!.five_hour!.used_percentage = 70;
  assert.equal(writeRecord(home, newReply), "appended");

  assert.equal(lines(home).length, 2);
  assert.equal(JSON.parse(lines(home)[1]!).rate_limits.five_hour.used_percentage, 70);
});

test("olika sessioner jämförs var för sig", () => {
  const home = tempHome();
  const other = record(NOW);
  other.session_id = "another-session";
  assert.equal(writeRecord(home, record(NOW)), "appended");
  assert.equal(writeRecord(home, other), "appended");
});

test("mappar får 0700 och filer 0600", () => {
  const home = tempHome();
  writeRecord(home, record(NOW));
  logProblem(home, "not_json", NOW);
  const mode = (path: string): number => statSync(path).mode & 0o777;
  const store = storeLayout(home);
  assert.equal(mode(home), 0o700);
  assert.equal(mode(store.events), 0o700);
  assert.equal(mode(store.state), 0o700);
  assert.equal(mode(monthFile(home, NOW)), 0o600);
  assert.equal(mode(store.problems), 0o600);
});

test("insamlaren skapar inga mappar själv", () => {
  const home = join(mkdtempSync(join(tmpdir(), "tokeniser-test-")), ".tokeniser");
  assert.throws(() => writeRecord(home, record(NOW)), /ENOENT/);
});

test("symlänkad events-mapp avvisas och målet lämnas orört", () => {
  const home = tempHome();
  const elsewhere = join(home, "..", "elsewhere");
  mkdirSync(elsewhere, { mode: 0o700 });
  const events = storeLayout(home).events;
  rmSync(events, { recursive: true });
  symlinkSync(elsewhere, events);
  assert.throws(() => writeRecord(home, record(NOW)), UnsafePathError);
});

test("hårt länkad månadsfil avvisas och målet lämnas orört", () => {
  const home = tempHome();
  const outside = join(home, "..", "bashrc");
  writeFileSync(outside, "original\n", { mode: 0o600 });
  linkSync(outside, monthFile(home, NOW));
  assert.throws(() => writeRecord(home, record(NOW)), /hårda länkar/);
  assert.equal(readFileSync(outside, "utf8"), "original\n");
});

test("händelsefiler roteras per UTC-månad", () => {
  assert.ok(monthFile("/h", Date.UTC(2026, 8, 30, 23, 30)).endsWith("events/2026-09.jsonl"));
  assert.ok(monthFile("/h", Date.UTC(2026, 9, 1, 0, 0)).endsWith("events/2026-10.jsonl"));
});
