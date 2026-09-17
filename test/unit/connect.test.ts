import assert from "node:assert/strict";
import { test } from "node:test";
import {
  backupFileName,
  canonicalJson,
  collectorArgv,
  collectorLayout,
  nodeVersionSupported,
  parseConnectionState,
  planHash,
  statusLineCommand,
  type ConnectionState,
  type ConnectPlan,
} from "../../src/connect/plan.ts";
import { lineDiff, planConnect, planSettingsDisconnect } from "../../src/connect/settings.ts";
import { sha256 } from "../../src/secure/fs.ts";

const LAYOUT = collectorLayout("/home/lullo/.tokeniser");
const COMMAND = statusLineCommand("/usr/bin/node", LAYOUT);
const SETTINGS = `{
  "model": "opus",
  "theme": "dark",
  "attribution": {
    "commit": ""
  }
}
`;

function connected(before: string | null): string {
  const plan = planConnect(before, COMMAND);
  assert.equal(plan.kind, "connect");
  return plan.kind === "connect" ? plan.after : "";
}

function state(after: string, before: string | null = SETTINGS): ConnectionState {
  const beforeSha256 = before === null ? null : sha256(before);
  return {
    format: 1,
    command: COMMAND,
    settingsBeforeSha256: beforeSha256,
    settingsAfterSha256: sha256(after),
    backupFile: beforeSha256 === null ? null : backupFileName(beforeSha256),
    collectorSha256: sha256("collector"),
    connectedAt: 1,
  };
}

// ---------- settings.json ----------

test("lägger till statusLine utan att röra befintliga bytes", () => {
  const after = connected(SETTINGS);
  const head = SETTINGS.slice(0, SETTINGS.lastIndexOf("}")).trimEnd();
  assert.ok(after.startsWith(head));
  assert.ok(after.endsWith("}\n"));
  assert.deepEqual(JSON.parse(after), { ...JSON.parse(SETTINGS), statusLine: { type: "command", command: COMMAND } });
});

test("fungerar med saknad, tom och tom-objekt-fil", () => {
  for (const before of [null, "", "{}\n"]) {
    assert.deepEqual(JSON.parse(connected(before)), { statusLine: { type: "command", command: COMMAND } });
  }
});

test("rör inte en befintlig statusrad", () => {
  const withOther = `{\n  "statusLine": { "type": "command", "command": "~/.claude/statusline.sh" }\n}\n`;
  assert.deepEqual(planConnect(withOther, COMMAND), {
    kind: "occupied",
    existing: { type: "command", command: "~/.claude/statusline.sh" },
  });
  assert.deepEqual(planConnect(connected(SETTINGS), COMMAND), { kind: "already-connected" });
});

test("ogiltig JSON avbryter utan plan", () => {
  assert.throws(() => planConnect('{ "model": ', COMMAND), SyntaxError);
  assert.throws(() => planConnect("[]", COMMAND), /JSON-objekt/);
});

test("diffen visar bara det tillagda", () => {
  const changed = lineDiff(SETTINGS, connected(SETTINGS))
    .split("\n")
    .filter((line) => line.startsWith("+") || line.startsWith("-"));
  assert.deepEqual(changed, ["+   },", '+   "statusLine": {', '+     "type": "command",', `+     "command": "${COMMAND}"`]);
});

test("frånkoppling återställer backupen när filen är orörd", () => {
  const after = connected(SETTINGS);
  assert.deepEqual(planSettingsDisconnect(after, state(after), SETTINGS), { change: "restore-backup", after: SETTINGS });
});

test("frånkoppling tar bort filen om den inte fanns före", () => {
  const after = connected(null);
  assert.deepEqual(planSettingsDisconnect(after, state(after, null), null), { change: "delete" });
});

test("frånkoppling avbryts om backupen inte stämmer", () => {
  const after = connected(SETTINGS);
  assert.throws(() => planSettingsDisconnect(after, state(after), SETTINGS + " "), /Backupen stämmer inte/);
});

test("frånkoppling tar bara bort statusLine när filen har ändrats sedan dess", () => {
  const after = connected(SETTINGS);
  const edited = after.replace('"theme": "dark"', '"theme": "light"');
  const plan = planSettingsDisconnect(edited, state(after), SETTINGS);
  assert.equal(plan.change, "remove-entry");
  assert.deepEqual(JSON.parse(plan.change === "remove-entry" ? plan.after : ""), { ...JSON.parse(SETTINGS), theme: "light" });
});

test("frånkoppling rör inte en statusrad som någon annan har satt", () => {
  const after = connected(SETTINGS);
  const replaced = after.replace(COMMAND, "~/.claude/statusline.sh");
  assert.deepEqual(planSettingsDisconnect(replaced, state(after), SETTINGS), { change: "none" });
  assert.deepEqual(planSettingsDisconnect(null, state(after), SETTINGS), { change: "none" });
});

// ---------- connection.json ----------

test("connection.json läses bara med strikt schema och utan sökvägar", () => {
  const valid = state(connected(SETTINGS));
  assert.deepEqual(parseConnectionState(JSON.stringify(valid)), valid);

  const reject = (patch: Record<string, unknown>, field: RegExp): void => {
    assert.throws(() => parseConnectionState(JSON.stringify({ ...valid, ...patch })), field);
  };
  reject({ backupFile: "../../.ssh/authorized_keys" }, /backupFile/);
  reject({ backupFile: "settings.0000000000000000.json" }, /backupFile/);
  reject({ backupFile: null }, /backupFile/);
  reject({ settingsPath: "/home/lullo/.bashrc" }, /settingsPath/);
  reject({ collectorSha256: "abc" }, /collectorSha256/);
  reject({ command: "node x\nrm -rf ~" }, /command/);
  reject({ format: 2 }, /format/);
  assert.throws(() => parseConnectionState("[]"), /rot/);
  assert.throws(() => parseConnectionState("{"), /giltig JSON/);
});

// ---------- Command and plan hash ----------

test("insamlaren körs med tom miljö och snäva rättigheter", () => {
  const argv = collectorArgv("/usr/bin/node", LAYOUT);
  assert.deepEqual(argv, [
    "/usr/bin/env",
    "-i",
    "/usr/bin/node",
    "--permission",
    "--allow-fs-read=/home/lullo/.tokeniser/bin/collector.cjs",
    "--allow-fs-read=/home/lullo/.tokeniser/events/",
    "--allow-fs-read=/home/lullo/.tokeniser/state/",
    "--allow-fs-write=/home/lullo/.tokeniser/events/",
    "--allow-fs-write=/home/lullo/.tokeniser/state/",
    "/home/lullo/.tokeniser/bin/collector.cjs",
    "--home=/home/lullo/.tokeniser",
  ]);
  assert.ok(!argv.some((a) => /allow-(child-process|worker|addons|wasi|inspector)/.test(a)));
  assert.ok(!argv.some((a) => a === "--allow-fs-read=/home/lullo/.tokeniser" || a === "--allow-fs-write=/home/lullo/.tokeniser/"));
  assert.equal(statusLineCommand("/usr/bin/node", LAYOUT, { line: false }), `${COMMAND} --no-line`);
  assert.equal(statusLineCommand("/usr/bin/node", LAYOUT, { line: true }), COMMAND);
});

test("anslutning kräver en Node där behörighetsmodellen nekar att skapa symlänkar", () => {
  for (const version of ["24.13.0", "24.14.1", "v24.14.1", "25.3.0", "26.0.0", "30.1.2"]) {
    assert.equal(nodeVersionSupported(version), true, version);
  }
  for (const version of ["20.20.0", "22.22.0", "23.11.1", "24.0.0", "24.12.9", "25.2.1", "", "24", "24.13", "24.13.0-pre", "x24.13.0"]) {
    assert.equal(nodeVersionSupported(version), false, version);
  }
});

test("sökvägar med skaltecken eller .. avvisas", () => {
  for (const home of ["/home/a b/.tokeniser", "/home/x'y/.tokeniser", "/home/$USER/.tokeniser", "/home/lullo/../root/.tokeniser", "relative/.tokeniser"]) {
    assert.throws(() => collectorArgv("/usr/bin/node", collectorLayout(home)), /inte är tillåtna/);
  }
});

const PLAN: ConnectPlan = {
  tool: "tokeniser-connect",
  format: 1,
  action: "connect",
  uid: 1000,
  env: "/usr/bin/env",
  node: { path: "/usr/bin/node", version: "24.14.1", sha256: sha256("node") },
  command: COMMAND,
  directories: [{ path: LAYOUT.home, mode: 0o700 }],
  collector: { path: LAYOUT.collector, mode: 0o600, sha256: sha256("collector"), replacesSha256: null },
  backup: { path: `${LAYOUT.backup}/${backupFileName(sha256(SETTINGS))}`, mode: 0o600, sha256: sha256(SETTINGS) },
  connection: { path: LAYOUT.connection, mode: 0o600 },
  settings: { path: "/home/lullo/.claude/settings.json", mode: 0o644, beforeSha256: sha256(SETTINGS), afterSha256: sha256("after"), diff: "+ x" },
};

test("kanonisk JSON beror inte på nyckelordning", () => {
  assert.equal(canonicalJson({ b: 1, a: { d: [2, { f: 3, e: 4 }], c: null } }), '{"a":{"c":null,"d":[2,{"e":4,"f":3}]},"b":1}');
});

test("planens hash ändras när diff, hash, sökväg eller rättigheter ändras", () => {
  const base = planHash(PLAN);
  assert.match(base, /^[0-9a-f]{64}$/);
  assert.equal(planHash(structuredClone(PLAN)), base);
  const variants: Array<(p: ConnectPlan) => void> = [
    (p) => { p.settings.diff = "+ y"; },
    (p) => { p.settings.mode = 0o600; },
    (p) => { p.settings.path = "/home/lullo/.claude/settings.local.json"; },
    (p) => { p.collector.sha256 = sha256("other"); },
    (p) => { p.collector.path = "/home/lullo/.tokeniser/bin/other.cjs"; },
    (p) => { p.collector.mode = 0o644; },
    (p) => { p.directories[0]!.mode = 0o755; },
    (p) => { p.backup = null; },
    (p) => { p.node.sha256 = sha256("other node"); },
    (p) => { p.node.version = "24.13.0"; },
    (p) => { p.command = `${p.command} --no-line`; },
    (p) => { p.uid = 0; },
  ];
  for (const change of variants) {
    const copy = structuredClone(PLAN);
    change(copy);
    assert.notEqual(planHash(copy), base);
  }
});
