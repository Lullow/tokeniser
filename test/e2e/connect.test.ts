import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { backupFileName, collectorLayout, statusLineCommand } from "../../src/connect/plan.ts";
import { sha256 } from "../../src/secure/fs.ts";

const script = fileURLToPath(new URL("../../scripts/connect.ts", import.meta.url));
const SETTINGS = `{\n  "model": "opus",\n  "theme": "dark"\n}\n`;

const settingsOf = (home: string): string => join(home, ".claude", "settings.json");
const layoutOf = (home: string) => collectorLayout(join(home, ".tokeniser"));
const mode = (path: string): number => statSync(path).mode & 0o7777;

function setup(settings: string | null = SETTINGS): string {
  const home = mkdtempSync(join(tmpdir(), "tokeniser-connect-"));
  mkdirSync(join(home, ".claude"), { mode: 0o700 });
  if (settings !== null) {
    writeFileSync(settingsOf(home), settings);
    chmodSync(settingsOf(home), 0o644);
  }
  return home;
}

function connect(home: string, ...args: string[]) {
  return spawnSync(process.execPath, ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", script, ...args], {
    encoding: "utf8",
    env: { ...process.env, HOME: home },
    timeout: 60_000,
  });
}

function hashFrom(output: string): string {
  const match = /Planens hash: ([0-9a-f]{64})/.exec(output);
  assert.ok(match, output);
  return match[1]!;
}

function connectFully(home: string): void {
  const dry = connect(home);
  assert.equal(dry.status, 0, dry.stderr);
  const applied = connect(home, `--apply=${hashFrom(dry.stdout)}`);
  assert.equal(applied.status, 0, applied.stderr);
}

test("anslut och koppla från: rätt rättigheter, fungerande kommando och byte för byte tillbaka", () => {
  const home = setup();
  const dry = connect(home);
  assert.equal(dry.status, 0, dry.stderr);
  assert.ok(!existsSync(join(home, ".tokeniser")), "torrkörningen får inte skapa något");
  assert.equal(readFileSync(settingsOf(home), "utf8"), SETTINGS);

  const applied = connect(home, `--apply=${hashFrom(dry.stdout)}`);
  assert.equal(applied.status, 0, applied.stderr);

  const layout = layoutOf(home);
  const backup = join(layout.backup, backupFileName(sha256(SETTINGS)));
  const settings = JSON.parse(readFileSync(settingsOf(home), "utf8"));
  assert.equal(settings.statusLine.command, statusLineCommand(realpathSync(process.execPath), layout));
  for (const dir of [layout.home, layout.bin, layout.events, layout.state, layout.backup]) assert.equal(mode(dir), 0o700, dir);
  for (const file of [layout.collector, layout.connection, backup]) assert.equal(mode(file), 0o600, file);
  assert.equal(mode(settingsOf(home)), 0o644);
  assert.equal(readFileSync(backup, "utf8"), SETTINGS);

  const input = readFileSync(new URL("../fixtures/statusline/full.json", import.meta.url), "utf8");
  const run = spawnSync("/bin/sh", ["-c", settings.statusLine.command], { input, encoding: "utf8", timeout: 5000 });
  assert.equal(run.status, 0);
  assert.equal(run.stderr, "");
  assert.match(run.stdout, /ktx 21%/);

  const dryOff = connect(home, "--disconnect");
  assert.equal(dryOff.status, 0, dryOff.stderr);
  assert.match(dryOff.stdout, /återställs byte för byte/);
  const off = connect(home, "--disconnect", `--apply=${hashFrom(dryOff.stdout)}`);
  assert.equal(off.status, 0, off.stderr);
  assert.equal(readFileSync(settingsOf(home), "utf8"), SETTINGS);
  assert.equal(mode(settingsOf(home)), 0o644);
  assert.ok(!existsSync(layout.collector));
  assert.ok(!existsSync(layout.connection));
});

test("--apply utan hash eller med fel hash ändrar ingenting", () => {
  const home = setup();
  for (const arg of ["--apply", "--apply=abc", `--apply=${"0".repeat(64)}`]) {
    const result = connect(home, arg);
    assert.equal(result.status, 1, arg);
    assert.equal(readFileSync(settingsOf(home), "utf8"), SETTINGS);
    assert.ok(!existsSync(join(home, ".tokeniser")));
  }
});

test("en ändring i settings.json efter granskningen avbryter", () => {
  const home = setup();
  const hash = hashFrom(connect(home).stdout);
  const edited = SETTINGS.replace('"dark"', '"light"');
  writeFileSync(settingsOf(home), edited);
  const result = connect(home, `--apply=${hash}`);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /stämmer inte med hashen/);
  assert.equal(readFileSync(settingsOf(home), "utf8"), edited);
  assert.ok(!existsSync(join(home, ".tokeniser")));
});

test("manipulerad connection.json avbryter frånkopplingen", () => {
  const home = setup();
  connectFully(home);
  const { connection } = layoutOf(home);
  const state = JSON.parse(readFileSync(connection, "utf8"));
  writeFileSync(connection, JSON.stringify({ ...state, backupFile: "../../.bashrc" }));
  const result = connect(home, "--disconnect");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /ogiltigt fält: backupFile/);
});

test("symlänkad ~/.tokeniser avvisas innan något skrivs", () => {
  const home = setup();
  const elsewhere = join(home, "elsewhere");
  mkdirSync(elsewhere, { mode: 0o700 });
  symlinkSync(elsewhere, join(home, ".tokeniser"));
  const result = connect(home);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /symbolisk länk/);
});

test("settings.json som andra kan skriva till avvisas", () => {
  const home = setup();
  chmodSync(settingsOf(home), 0o666);
  const result = connect(home);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /0666/);
});

test("en befintlig statusLine rörs inte", () => {
  const home = setup(`{\n  "statusLine": { "type": "command", "command": "~/.claude/statusline.sh" }\n}\n`);
  const result = connect(home);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /redan en statusLine/);
});

test("saknad settings.json skapas och tas bort igen vid frånkoppling", () => {
  const home = setup(null);
  connectFully(home);
  assert.equal(mode(settingsOf(home)), 0o600);
  const dryOff = connect(home, "--disconnect");
  assert.match(dryOff.stdout, /tas bort/);
  const off = connect(home, "--disconnect", `--apply=${hashFrom(dryOff.stdout)}`);
  assert.equal(off.status, 0, off.stderr);
  assert.ok(!existsSync(settingsOf(home)));
});
