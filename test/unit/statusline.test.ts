import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parseStatusline, type EventRecord } from "../../src/collector/record.ts";
import { formatLine } from "../../src/collector/statusline.ts";

const NOW = 1_789_391_280_000;
const FIVE_HOUR_RESET_MS = 1_789_398_000_000;

function record(name: string): EventRecord {
  const text = readFileSync(new URL(`../fixtures/statusline/${name}`, import.meta.url), "utf8");
  const result = parseStatusline(text, NOW);
  assert.ok(result.ok);
  return result.record;
}

test("visar förbrukat för båda gränserna och kontexten", () => {
  assert.equal(formatLine(record("full.json"), NOW), "5h 64% · v 31% · ktx 21%");
});

test("en passerad återställning visas som återställd, aldrig 0 %", () => {
  assert.equal(formatLine(record("full.json"), FIVE_HOUR_RESET_MS), "5h ↺ · v 31% · ktx 21%");
});

test("saknade värden visas som streck", () => {
  assert.equal(formatLine(record("new-session.json"), NOW), "5h – · v – · ktx –");
  assert.equal(formatLine(record("window-dropped.json"), NOW), "5h – · v 31% · ktx 9%");
});
