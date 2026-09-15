import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { buildHealth, type HealthFacts } from "../../src/health/model.ts";
import { readHealthFacts } from "../../src/health/read.ts";
import { openIndex } from "../../src/index/db.ts";
import { ingest } from "../../src/index/ingest.ts";
import { ensurePrivateDir, sha256 } from "../../src/secure/fs.ts";
import { appendEvents, eventLine, makeStore } from "../helpers/events.ts";

const MIN = 60_000;
const NOW = Date.UTC(2026, 8, 15, 11, 0);
const COMMAND = "/usr/bin/env -i /usr/bin/node --permission /home/user/.tokeniser/bin/collector.cjs --home=/home/user/.tokeniser";
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

function setup(collector = COLLECTOR): Setup {
  const home = makeStore();
  const root = dirname(home);
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

test("utan anslutning är insamlaren en varning och inställningarna kan inte kontrolleras", () => {
  const s = setup();
  writeFileSync(join(s.home, "connection.json"), "{}", { mode: 0o600 });
  const health = buildHealth(read(s), NOW);
  const byId = new Map(health.checks.map((c) => [c.id, c]));
  assert.equal(byId.get("collector")?.mark, "warning");
  assert.match(byId.get("collector")?.detail ?? "", /connection\.json har ett ogiltigt fält/);
  assert.equal(byId.get("statusline")?.mark, "unknown");
});
