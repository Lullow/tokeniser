import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { initStore, storeLayout } from "../../src/collector/store.ts";
import { collectorLayout, statusLineCommand } from "../../src/connect/plan.ts";

const bundle = fileURLToPath(new URL("../../dist/collector.js", import.meta.url));
const fixture = (name: string): string =>
  readFileSync(new URL(`../fixtures/statusline/${name}`, import.meta.url), "utf8");

function tempHome(): string {
  const home = join(mkdtempSync(join(tmpdir(), "tokeniser-e2e-")), ".tokeniser");
  initStore(home);
  return home;
}

function run(input: string, home: string, args: string[] = []) {
  return spawnSync(process.execPath, [bundle, `--home=${home}`, ...args], { input, encoding: "utf8", timeout: 5000 });
}

function events(home: string): string {
  const dir = storeLayout(home).events;
  return existsSync(dir) ? readdirSync(dir).map((f) => readFileSync(join(dir, f), "utf8")).join("") : "";
}

/** Installs a collector file where the real command expects it and returns that command. */
function installForCommand(home: string, source: string | Buffer): string {
  const layout = collectorLayout(home);
  mkdirSync(layout.bin, { mode: 0o700 });
  writeFileSync(layout.collector, source, { mode: 0o600 });
  return statusLineCommand(process.execPath, layout);
}

const runCommand = (command: string, input: string) =>
  spawnSync("/bin/sh", ["-c", command], { input, encoding: "utf8", timeout: 5000 });

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
  const kinds = readFileSync(storeLayout(home).problems, "utf8").trim().split("\n").map((l) => JSON.parse(l).kind);
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

test("osäker eller saknad lagring stoppar aldrig statusraden", () => {
  const cwd = mkdtempSync(join(tmpdir(), "tokeniser-cwd-"));
  for (const args of [[`--home=${join(cwd, "saknas", ".tokeniser")}`], ["--home=relativ/.tokeniser"]]) {
    const result = spawnSync(process.execPath, [bundle, ...args], { input: fixture("full.json"), encoding: "utf8", cwd, timeout: 5000 });
    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");
    assert.match(result.stdout, /ktx 21%/);
  }
  assert.deepEqual(readdirSync(cwd), []);

  const home = tempHome();
  const elsewhere = join(home, "..", "elsewhere");
  mkdirSync(elsewhere, { mode: 0o700 });
  rmSync(storeLayout(home).events, { recursive: true });
  symlinkSync(elsewhere, storeLayout(home).events);
  const result = run(fixture("full.json"), home);
  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  assert.match(result.stdout, /ktx 21%/);
  assert.deepEqual(readdirSync(elsewhere), []);
  assert.match(readFileSync(storeLayout(home).problems, "utf8"), /"unsafe_path"/);
});

test("stänger stdin aldrig: avslutas efter spärren med kod 0 och utan utdata", { timeout: 10_000 }, async () => {
  const home = tempHome();
  const child = spawn(process.execPath, [bundle, `--home=${home}`], { stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const start = performance.now();
  const code = await new Promise<number | null>((resolve) => child.on("exit", resolve));
  const elapsed = performance.now() - start;
  assert.equal(code, 0);
  assert.equal(stdout, "");
  assert.equal(stderr, "");
  assert.ok(elapsed >= 1900 && elapsed < 4000, `${elapsed.toFixed(0)} ms`);
});

test("det exakta statusradskommandot fungerar med behörighetsmodellen", () => {
  const home = tempHome();
  const result = runCommand(installForCommand(home, readFileSync(bundle)), fixture("full.json"));
  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  assert.match(result.stdout, /ktx 21%/);
  assert.equal(events(home).trim().split("\n").length, 1);
});

const HOSTILE = `
const fs = require("node:fs");
const path = require("node:path");
const home = process.argv.find((a) => a.startsWith("--home=")).slice(7);
const attempt = (fn) => { try { fn(); return "allowed"; } catch (e) { return e.code || e.message; } };
process.stdout.write(JSON.stringify({
  overwriteSelf: attempt(() => fs.writeFileSync(path.join(home, "bin", "collector.cjs"), "x")),
  writeConnection: attempt(() => fs.writeFileSync(path.join(home, "connection.json"), "x")),
  readBackup: attempt(() => fs.readFileSync(path.join(home, "backup", "settings.json"))),
  writeOutside: attempt(() => fs.writeFileSync(path.join(home, "..", "outside.txt"), "x")),
  symlinkOutside: attempt(() => fs.symlinkSync(path.join(home, "..", "outside.txt"), path.join(home, "events", "outside"))),
  symlinkToSelf: attempt(() => fs.symlinkSync("../bin/collector.cjs", path.join(home, "events", "self"))),
  hardLinkToSelf: attempt(() => fs.linkSync(path.join(home, "bin", "collector.cjs"), path.join(home, "events", "self-hard"))),
  spawn: attempt(() => require("node:child_process").spawnSync("/bin/true")),
  environment: Object.keys(process.env).length,
  appendEvents: attempt(() => fs.appendFileSync(path.join(home, "events", "probe.jsonl"), "x\\n")),
}));
`;

test("behörighetsmodellen stoppar en ändrad insamlare från det viktigaste (skydd på djupet)", () => {
  const home = tempHome();
  mkdirSync(join(home, "backup"), { mode: 0o700 });
  writeFileSync(join(home, "backup", "settings.json"), "{}", { mode: 0o600 });
  const result = runCommand(installForCommand(home, HOSTILE), "");
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    overwriteSelf: "ERR_ACCESS_DENIED",
    writeConnection: "ERR_ACCESS_DENIED",
    readBackup: "ERR_ACCESS_DENIED",
    writeOutside: "ERR_ACCESS_DENIED",
    symlinkOutside: "ERR_ACCESS_DENIED",
    symlinkToSelf: "ERR_ACCESS_DENIED",
    hardLinkToSelf: "ERR_ACCESS_DENIED",
    spawn: "ERR_ACCESS_DENIED",
    environment: 0,
    appendEvents: "allowed",
  });
  assert.ok(!existsSync(join(home, "..", "outside.txt")));
  assert.deepEqual(readdirSync(join(home, "events")), ["probe.jsonl"]);
});

test("bundlen använder bara tillåtna Node-moduler, ingen miljö och ingen dynamisk kod", () => {
  const code = readFileSync(bundle, "utf8");
  const modules = [...new Set([...code.matchAll(/require\("([^"]+)"\)/g)].map((m) => m[1]))].sort();
  assert.deepEqual(modules, ["node:crypto", "node:fs", "node:os", "node:path"]);
  for (const forbidden of [/\beval\(/, /new Function\b/, /\bimport\(/, /process\.env/, /process\.binding/, /child_process/, /node:(net|http|https|http2|dns|tls|dgram)/, /\bfetch\(/, /WebSocket/]) {
    assert.doesNotMatch(code, forbidden);
  }
});

test("körtid", (t) => {
  const home = tempHome();
  const input = fixture("full.json");
  const command = installForCommand(home, readFileSync(bundle));
  const times: number[] = [];
  for (let i = 0; i < 20; i++) {
    const start = performance.now();
    runCommand(command, input);
    times.push(performance.now() - start);
  }
  times.sort((a, b) => a - b);
  t.diagnostic(`med behörighetsmodellen: median ${times[10]!.toFixed(0)} ms, p95 ${times[18]!.toFixed(0)} ms`);
});
