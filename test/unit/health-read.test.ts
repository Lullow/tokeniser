import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { collectorLayout, statusLineCommand } from "../../src/connect/plan.ts";
import { buildHealth, type HealthFacts, type RuntimeFacts } from "../../src/health/model.ts";
import { readHealthFacts } from "../../src/health/read.ts";
import { openIndex } from "../../src/index/db.ts";
import { ingest } from "../../src/index/ingest.ts";
import { ensurePrivateDir, sha256 } from "../../src/secure/fs.ts";
import { appendEvents, eventLine, makeStore } from "../helpers/events.ts";

const MIN = 60_000;
const NOW = Date.UTC(2026, 8, 15, 11, 0);
const COLLECTOR = "insamlarens kod";

interface Setup {
  home: string;
  root: string;
  claudeDir: string;
  managedDir: string;
  folder: string;
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
}

/** A Node file of the test's own, so the checks do not depend on where the machine keeps Node. */
function fakeNode(): string {
  const dir = join(mkdtempSync(join(tmpdir(), "tokeniser-node-")), "bin");
  mkdirSync(dir);
  const node = join(dir, "node");
  writeFileSync(node, "#!/bin/sh\n", { mode: 0o755 });
  return node;
}

function setup(collector = COLLECTOR, nodePath = fakeNode()): Setup {
  const home = makeStore();
  const root = dirname(home);
  const COMMAND = statusLineCommand(nodePath, collectorLayout(home));
  ensurePrivateDir(join(home, "bin"));
  ensurePrivateDir(join(home, "backup"));
  writeFileSync(join(home, "bin", "collector.cjs"), collector, { mode: 0o600 });
  const connection = {
    format: 1,
    command: COMMAND,
    settingsBeforeSha256: null,
    settingsAfterSha256: sha256("efter"),
    backupFile: null,
    collectorSha256: sha256(COLLECTOR),
    connectedAt: NOW - 12 * 60 * MIN,
  };
  writeFileSync(join(home, "connection.json"), JSON.stringify(connection), { mode: 0o600 });
  const claudeDir = join(root, ".claude");
  writeJson(join(claudeDir, "settings.json"), { model: "opus", statusLine: { type: "command", command: COMMAND } });
  const folder = join(root, "tokeniser");
  mkdirSync(folder);
  return { home, root, claudeDir, managedDir: join(root, "etc-claude-code"), folder };
}

function read(s: Setup, options: { events?: string[]; folders?: string[] } = {}): HealthFacts {
  if (options.events !== undefined) appendEvents(s.home, "2026-09", options.events);
  const db = openIndex(s.home);
  try {
    ingest(db, s.home);
    return readHealthFacts({
      home: s.home,
      claudeDir: s.claudeDir,
      managedDir: s.managedDir,
      workspaceFolders: options.folders ?? [s.folder],
      index: { db },
      inWindowProject: true,
      now: NOW,
    });
  } finally {
    db.close();
  }
}

test("hälsokontrollen läser insamlaren, mapparna, inställningarna och indexet utan varningar", () => {
  const s = setup();
  const f = read(s, { events: [eventLine({ at: NOW - 2 * MIN, session: "344a3a30-80ce" })] });
  assert.deepEqual(f.collector, {
    ok: true,
    value: { connectedAt: NOW - 12 * 60 * MIN, expectedSha256: sha256(COLLECTOR), actualSha256: sha256(COLLECTOR) },
  });
  assert.deepEqual(f.directories, { ok: true, value: null });
  if (!f.settings.ok) assert.fail(f.settings.error);
  assert.equal(f.settings.value.user.statusLine, "tokeniser");
  assert.deepEqual(f.settings.value.managed, []);
  assert.deepEqual(f.settings.value.folders, [{ name: "tokeniser", local: null, project: null }]);
  if (!f.data.ok) assert.fail(f.data.error);
  assert.equal(f.data.value.latest?.sessionId, "344a3a30-80ce");
  assert.deepEqual(f.problems, { ok: true, value: [] });
  if (!f.runtime.ok) assert.fail(f.runtime.error);
  assert.equal(f.runtime.value.commandMatches, true);
  assert.equal(f.runtime.value.node?.status, "ok");
  assert.deepEqual(f.runtime.value.env, { file: "/usr/bin/env", status: "ok" });

  const health = buildHealth(f, NOW);
  assert.equal(health.level, "ok", JSON.stringify(health.checks, null, 2));
});

test("en ändrad insamlare och en mapp som andra kan läsa upptäcks", () => {
  const s = setup("ändrad kod");
  chmodSync(join(s.home, "state"), 0o755);
  const health = buildHealth(read(s), NOW);
  assert.equal(health.level, "warning");
  assert.equal(health.title, "Insamlaren har ändrats sedan anslutningen");
  const byId = new Map(health.checks.map((c) => [c.id, c]));
  assert.equal(byId.get("collector")?.mark, "warning");
  assert.equal(byId.get("directories")?.mark, "warning");
  assert.match(byId.get("directories")?.detail ?? "", /state har rättigheterna 0755 i stället för 0700/);
});

test("projektets och organisationens inställningar läses, men symlänkar, FIFO och trasig JSON följs aldrig", () => {
  const s = setup();
  writeJson(join(s.folder, ".claude", "settings.local.json"), { statusLine: { type: "command", command: "~/.claude/statusline.sh" } });
  writeJson(join(s.managedDir, "managed-settings.d", "10-policy.json"), { disableAllHooks: true });

  const linked = join(s.root, "länkad");
  mkdirSync(join(linked, ".claude"), { recursive: true });
  symlinkSync(join(s.claudeDir, "settings.json"), join(linked, ".claude", "settings.json"));
  const fifo = join(s.root, "fifo");
  mkdirSync(join(fifo, ".claude"), { recursive: true });
  execFileSync("mkfifo", [join(fifo, ".claude", "settings.json")]);
  const broken = join(s.root, "trasig");
  mkdirSync(join(broken, ".claude"), { recursive: true });
  writeFileSync(join(broken, ".claude", "settings.local.json"), "{ inte json");

  const f = read(s, { folders: [s.folder, linked, fifo, broken] });
  if (!f.settings.ok) assert.fail(f.settings.error);
  const { managed, folders, unreadable } = f.settings.value;
  assert.deepEqual(
    managed.map((m) => [m.file, m.disableAllHooks]),
    [[join(s.managedDir, "managed-settings.d", "10-policy.json"), true]],
  );
  assert.equal(folders[0]?.local?.statusLine, "other");
  assert.deepEqual(unreadable, [
    { file: "länkad/.claude/settings.json", error: "är en symbolisk länk" },
    { file: "fifo/.claude/settings.json", error: "är inte en vanlig fil" },
    { file: "trasig/.claude/settings.local.json", error: "är inte giltig JSON" },
  ]);

  const health = buildHealth(f, NOW);
  assert.equal(health.title, "Organisationens inställningar stänger av statusraden");
  const statusLine = health.checks.find((c) => c.id === "statusline");
  assert.equal(statusLine?.mark, "warning");
  assert.match(statusLine?.detail ?? "", /`tokeniser\/\.claude\/settings\.local\.json` sätter en egen `statusLine`/);
  assert.match(statusLine?.detail ?? "", /`länkad\/\.claude\/settings\.json` är en symbolisk länk\./);
});

test("avvisade körningar räknas bara för senaste dygnet, och trasiga rader hoppas över", () => {
  const s = setup();
  const lines = [
    { at: NOW - 30 * 60 * MIN, kind: "not_json" },
    { at: NOW - 3 * MIN, kind: "not_json" },
    { at: NOW - 2 * MIN, kind: "not_json" },
    { at: NOW - MIN, kind: "unsafe_path" },
    { at: NOW - MIN, kind: "<script>" },
  ].map((line) => JSON.stringify(line));
  writeFileSync(join(s.home, "state", "problems.jsonl"), `${lines.join("\n")}\ninte json\n`, { mode: 0o600 });
  assert.deepEqual(read(s).problems, {
    ok: true,
    value: [
      { kind: "not_json", count: 2, lastAt: NOW - 2 * MIN },
      { kind: "unsafe_path", count: 1, lastAt: NOW - MIN },
    ],
  });
});

test("ogiltiga fält och en gräns som saknas läses från indexet", () => {
  const s = setup();
  const invalid = JSON.parse(eventLine({ at: NOW - 3 * MIN, session: "a" }));
  invalid.rate_limits.seven_day.used_percentage = "mycket";
  const f = read(s, {
    events: [eventLine({ at: NOW - 5 * MIN, session: "a" }), `${JSON.stringify(invalid)}\n`, eventLine({ at: NOW - MIN, session: "a", week: null })],
  });
  if (!f.data.ok) assert.fail(f.data.error);
  assert.deepEqual(f.data.value.invalid, { events: 1, fields: ["rate_limits.seven_day.used_percentage"] });
  assert.equal(f.data.value.latest?.week, false);
  assert.equal(f.data.value.latest?.responded, true);
  assert.equal(f.data.value.lastResets.week, 1_789_600_000 * 1000);

  const fields = buildHealth(f, NOW).checks.find((c) => c.id === "fields");
  assert.equal(fields?.mark, "warning");
});

test("en Node-fil som kan skrivas av andra, inte är körbar eller saknas upptäcks, liksom ett främmande kommando", () => {
  const node = fakeNode();
  const s = setup(COLLECTOR, node);
  const runtime = (): RuntimeFacts => {
    const f = read(s);
    if (!f.runtime.ok) assert.fail(f.runtime.error);
    return f.runtime.value;
  };

  assert.deepEqual(runtime().node, { file: node, status: "ok" });
  chmodSync(node, 0o775);
  assert.deepEqual(runtime().node, { file: node, status: "unsafe", reason: `${node} är skrivbar för andra (0775).` });
  chmodSync(node, 0o644);
  assert.deepEqual(runtime().node, { file: node, status: "not-executable" });
  unlinkSync(node);
  assert.deepEqual(runtime().node, { file: node, status: "missing" });
  assert.equal(buildHealth(read(s), NOW).checks.find((c) => c.id === "runtime")?.mark, "warning");

  const connection = join(s.home, "connection.json");
  const state = JSON.parse(readFileSync(connection, "utf8"));
  writeFileSync(connection, JSON.stringify({ ...state, command: `${state.command} --no-line` }));
  assert.equal(runtime().commandMatches, true, "utan terminalrad är kommandot fortfarande Tokenisers");
  writeFileSync(connection, JSON.stringify({ ...state, command: `${state.command} --allow-child-process` }));
  assert.equal(runtime().commandMatches, false);
});

test("utan anslutning är insamlaren en varning och inställningarna kan inte kontrolleras", () => {
  const s = setup();
  writeFileSync(join(s.home, "connection.json"), "{}", { mode: 0o600 });
  const health = buildHealth(read(s), NOW);
  const byId = new Map(health.checks.map((c) => [c.id, c]));
  assert.equal(byId.get("collector")?.mark, "warning");
  assert.match(byId.get("collector")?.detail ?? "", /connection\.json har ett ogiltigt fält/);
  assert.equal(byId.get("statusline")?.mark, "unknown");
  assert.equal(byId.get("runtime")?.mark, "unknown");
});
