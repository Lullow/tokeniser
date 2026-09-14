import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseStatusline, type EventRecord } from "../../src/collector/record.ts";
import { logProblem, monthFile, writeRecord } from "../../src/collector/store.ts";

const NOW = 1_789_391_280_000;

function record(receivedAt: number, name = "full.json"): EventRecord {
  const text = readFileSync(new URL(`../fixtures/statusline/${name}`, import.meta.url), "utf8");
  const result = parseStatusline(text, receivedAt);
  assert.ok(result.ok);
  return result.record;
}

const tempHome = (): string => join(mkdtempSync(join(tmpdir(), "tokeniser-test-")), ".tokeniser");
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
  assert.equal(mode(home), 0o700);
  assert.equal(mode(join(home, "events")), 0o700);
  assert.equal(mode(join(home, "state")), 0o700);
  assert.equal(mode(monthFile(home, NOW)), 0o600);
  assert.equal(mode(join(home, "problems.jsonl")), 0o600);
});

test("händelsefiler roteras per UTC-månad", () => {
  assert.ok(monthFile("/h", Date.UTC(2026, 8, 30, 23, 30)).endsWith("events/2026-09.jsonl"));
  assert.ok(monthFile("/h", Date.UTC(2026, 9, 1, 0, 0)).endsWith("events/2026-10.jsonl"));
});
