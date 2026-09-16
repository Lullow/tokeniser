import assert from "node:assert/strict";
import { lstatSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { daysPath, readDays, setDay, writeDays } from "../../src/history/days-file.ts";
import type { DaySummary } from "../../src/history/summary.ts";
import { ChangedSinceReviewError, sha256, UnsafePathError } from "../../src/secure/fs.ts";
import { makeStore } from "../helpers/events.ts";

const day = (date: string, v = 1): DaySummary => ({ v, date, start: 0, end: 1, events: 1, fiveHourPeak: null, weekPeak: null, projects: [] });
const line = (date: string, v = 1): string => JSON.stringify(day(date, v));

test("utan fil finns inga dagar, och skrivningen sorterar dagarna med 0600", () => {
  const home = makeStore();
  const file = readDays(home);
  assert.equal(file.sha256, null);
  assert.equal(file.days.size, 0);

  setDay(file, day("2026-09-15"));
  setDay(file, day("2026-09-14"));
  writeDays(home, file);
  const text = readFileSync(daysPath(home), "utf8");
  assert.equal(text, `${line("2026-09-14")}\n${line("2026-09-15")}\n`);
  assert.equal(lstatSync(daysPath(home)).mode & 0o777, 0o600);
  assert.equal(file.sha256, sha256(text));

  const again = readDays(home);
  assert.deepEqual([...again.days.keys()], ["2026-09-14", "2026-09-15"]);
  assert.equal(again.sha256, sha256(text));
  writeDays(home, again);
  assert.equal(readFileSync(daysPath(home), "utf8"), text, "en omskrivning utan ändringar ger samma fil");
});

test("rader som inte går att läsa och en äldre rad för samma dag finns kvar oförändrade", () => {
  const home = makeStore();
  const lines = [line("2026-09-15"), "inte json", '{"v":1}', line("2026-09-15", 2), line("2026-09-14"), line("2026-13-01")];
  writeFileSync(daysPath(home), lines.join("\n") + "\n", { mode: 0o600 });

  const file = readDays(home);
  assert.deepEqual([...file.days.values()].map((d) => [d.date, d.v]), [["2026-09-15", 2], ["2026-09-14", 1]]);
  assert.deepEqual(file.other, ["inte json", '{"v":1}', line("2026-09-15"), line("2026-13-01")]);

  writeDays(home, file);
  assert.deepEqual(readFileSync(daysPath(home), "utf8").trimEnd().split("\n"), [
    line("2026-09-14"),
    line("2026-09-15", 2),
    "inte json",
    '{"v":1}',
    line("2026-09-15"),
    line("2026-13-01"),
  ]);
});

test("en ändring efter läsningen stoppar skrivningen, och en symbolisk länk läses aldrig", () => {
  const home = makeStore();
  const missing = readDays(home);
  writeFileSync(daysPath(home), `${line("2026-09-01")}\n`, { mode: 0o600 });
  setDay(missing, day("2026-09-14"));
  assert.throws(() => writeDays(home, missing), ChangedSinceReviewError);

  const read = readDays(home);
  writeFileSync(daysPath(home), `${line("2026-09-02")}\n`, { mode: 0o600 });
  setDay(read, day("2026-09-14"));
  assert.throws(() => writeDays(home, read), ChangedSinceReviewError);
  assert.equal(readFileSync(daysPath(home), "utf8"), `${line("2026-09-02")}\n`);

  const other = makeStore();
  const target = join(other, "annan.jsonl");
  writeFileSync(target, `${line("2026-09-03")}\n`, { mode: 0o600 });
  symlinkSync(target, daysPath(other));
  assert.throws(() => readDays(other), UnsafePathError);
});
