import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));

function testFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? testFiles(join(dir, entry.name)) : entry.name.endsWith(".test.ts") ? [join(dir, entry.name)] : [],
  );
}

test("varje löfte i säkerhetskontraktet har tester som finns", () => {
  const doc = readFileSync(join(root, "docs", "insamlarens-sakerhetskontrakt.md"), "utf8");
  const rows = doc.split("\n").filter((line) => /^\| \d+ \|/.test(line));
  assert.ok(rows.length >= 13, "kontraktets tabell ska ha minst 13 löften");

  const tests = testFiles(join(root, "test")).map((file) => readFileSync(file, "utf8")).join("\n");
  for (const row of rows) {
    const cells = row.split(" | ");
    const names = [...(cells.at(-1) ?? "").matchAll(/`([^`]+)`/g)].map((m) => m[1]!);
    assert.ok(names.length > 0, `löftet saknar test: ${cells[1]}`);
    for (const name of names) {
      assert.ok(tests.includes(`test("${name}"`), `testet finns inte: ${name}`);
    }
  }
});
