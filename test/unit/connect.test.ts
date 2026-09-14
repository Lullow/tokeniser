import assert from "node:assert/strict";
import { test } from "node:test";
import {
  lineDiff,
  planConnect,
  planDisconnect,
  sha256,
  statusLineCommand,
  type ConnectionState,
} from "../../src/connect/settings.ts";

const COMMAND = "/usr/bin/node /home/lullo/.tokeniser/bin/collector.js";
const SETTINGS = `{
  "model": "opus",
  "theme": "dark",
  "attribution": {
    "commit": ""
  }
}
`;

function state(after: string, backupPath: string | null = "/backup.json"): ConnectionState {
  return { settingsPath: "/settings.json", backupPath, writtenSha256: sha256(after), command: COMMAND, collectorSha256: "x", connectedAt: 0 };
}

function connected(before: string | null): string {
  const plan = planConnect(before, COMMAND);
  assert.equal(plan.kind, "connect");
  return plan.kind === "connect" ? plan.after : "";
}

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
  assert.throws(() => planConnect("{ \"model\": ", COMMAND), SyntaxError);
  assert.throws(() => planConnect("[]", COMMAND), /JSON-objekt/);
});

test("frånkoppling återställer backupen när filen är orörd", () => {
  const after = connected(SETTINGS);
  assert.deepEqual(planDisconnect(after, state(after), SETTINGS), { kind: "restore-backup", after: SETTINGS });
});

test("frånkoppling tar bara bort statusLine när filen har ändrats sedan dess", () => {
  const after = connected(SETTINGS);
  const edited = after.replace('"theme": "dark"', '"theme": "light"');
  const plan = planDisconnect(edited, state(after), SETTINGS);
  assert.equal(plan.kind, "remove-entry");
  assert.deepEqual(JSON.parse(plan.kind === "remove-entry" ? plan.after : ""), { ...JSON.parse(SETTINGS), theme: "light" });
});

test("frånkoppling rör inte en statusrad som någon annan har satt", () => {
  const after = connected(SETTINGS);
  const replaced = after.replace(COMMAND, "~/.claude/statusline.sh");
  assert.deepEqual(planDisconnect(replaced, state(after), SETTINGS), { kind: "not-connected" });
  assert.deepEqual(planDisconnect(null, state(after), SETTINGS), { kind: "not-connected" });
});

test("diffen visar bara det tillagda", () => {
  const diff = lineDiff(SETTINGS, connected(SETTINGS));
  const changed = diff.split("\n").filter((line) => line.startsWith("+") || line.startsWith("-"));
  assert.deepEqual(changed, [
    "+   },",
    '+   "statusLine": {',
    '+     "type": "command",',
    `+     "command": "${COMMAND}"`,
  ]);
});

test("kommandot citeras när sökvägen har mellanslag", () => {
  assert.equal(statusLineCommand("/usr/bin/node", "/home/a b/collector.js"), "/usr/bin/node '/home/a b/collector.js'");
});
