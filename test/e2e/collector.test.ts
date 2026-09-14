import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const collector = fileURLToPath(new URL("../../dist/collector.js", import.meta.url));
const fixture = (name: string): string =>
  readFileSync(new URL(`../fixtures/statusline/${name}`, import.meta.url), "utf8");
const tempHome = (): string => join(mkdtempSync(join(tmpdir(), "tokeniser-e2e-")), ".tokeniser");

function run(input: string, home: string, args: string[] = []) {
  return spawnSync(process.execPath, [collector, ...args], {
    input,
    encoding: "utf8",
    env: { ...process.env, TOKENISER_HOME: home },
    timeout: 5000,
  });
}

function events(home: string): string {
  const dir = join(home, "events");
  return existsSync(dir) ? readdirSync(dir).map((f) => readFileSync(join(dir, f), "utf8")).join("") : "";
}

test("skriver statusraden och en händelse", () => {
  const home = tempHome();
  const result = run(fixture("full.json"), home);
  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  assert.match(result.stdout, /^5h (64%|↺) · v (31%|↺) · ktx 21%\n$/);
  assert.equal(events(home).trim().split("\n").length, 1);
});

test("samma data två gånger ger en händelse", () => {
  const home = tempHome();
  run(fixture("full.json"), home);
  run(fixture("full.json"), home);
  assert.equal(events(home).trim().split("\n").length, 1);
});

test("trasig JSON avbryter aldrig och skriver inget i terminalen", () => {
  const home = tempHome();
  for (const input of [fixture("broken.txt"), "", "null", "{}"]) {
    const result = run(input, home);
    assert.equal(result.status, 0);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
  }
  assert.equal(events(home), "");
  const kinds = readFileSync(join(home, "problems.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l).kind);
  assert.deepEqual(kinds, ["not_json", "empty", "not_object", "session_id"]);
});

test("--no-line sparar men skriver ingen rad", () => {
  const home = tempHome();
  const result = run(fixture("full.json"), home, ["--no-line"]);
  assert.equal(result.stdout, "");
  assert.notEqual(events(home), "");
});

test("sparar inget innehåll från konversationen", () => {
  const home = tempHome();
  run(fixture("full.json"), home);
  const saved = events(home);
  for (const forbidden of ["session_name", "Bygg insamlaren", "transcript_path", "prompt_id"]) {
    assert.ok(!saved.includes(forbidden), `${forbidden} får inte sparas`);
  }
});

test("körtid", (t) => {
  const home = tempHome();
  const input = fixture("full.json");
  const times: number[] = [];
  for (let i = 0; i < 20; i++) {
    const start = performance.now();
    run(input, home);
    times.push(performance.now() - start);
  }
  times.sort((a, b) => a - b);
  t.diagnostic(`median ${times[10]!.toFixed(0)} ms, p95 ${times[18]!.toFixed(0)} ms`);
});
