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

const LINE = /^5h (\d{1,3}%|↺|–) · v (\d{1,3}%|↺|–) · ktx (\d{1,3}%|–)$/;

test("terminalraden innehåller bara fasta etiketter och siffror", () => {
  const hostile = JSON.stringify({
    session_id: "hostile",
    model: { id: "]52;c;cm0gLXJmIH4=", display_name: "[2J‮evil" },
    workspace: { project_dir: "/tmp/[31mred", repo: { host: "h", owner: "o", name: "<script>" } },
    context_window: { used_percentage: 42 },
    rate_limits: { five_hour: { used_percentage: 99.6, resets_at: 1789398000 } },
  });
  const fixtures = ["full.json", "new-session.json", "window-dropped.json", "invalid-values.json"].map((name) =>
    readFileSync(new URL(`../fixtures/statusline/${name}`, import.meta.url), "utf8"),
  );
  for (const text of [...fixtures, hostile]) {
    const result = parseStatusline(text, NOW);
    assert.ok(result.ok);
    for (const now of [NOW, FIVE_HOUR_RESET_MS, FIVE_HOUR_RESET_MS * 2]) {
      assert.match(formatLine(result.record, now), LINE);
    }
  }
});
