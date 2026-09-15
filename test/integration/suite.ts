// Runs inside the VS Code extension host, started by scripts/integration.ts.
import assert from "node:assert/strict";
import * as vscode from "vscode";
import type { TestApi } from "../../src/extension.ts";

const TIMEOUT_MS = 20_000;
const COMMANDS = ["tokeniser.openView", "tokeniser.toggleView", "tokeniser.exportData", "tokeniser.deleteData", "tokeniser.openSettings"];

/** Refreshes are debounced and the webview loads on its own, so tests wait for the state they expect. */
async function waitFor<T>(describe: () => string, read: () => T | null): Promise<T> {
  const deadline = Date.now() + TIMEOUT_MS;
  for (;;) {
    const value = read();
    if (value !== null) return value;
    if (Date.now() > deadline) throw new Error(`Väntade förgäves: ${describe()}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

const tests: [string, (api: TestApi) => Promise<void>][] = [
  [
    "alla kommandon finns i VS Code",
    async () => {
      const commands = await vscode.commands.getCommands(true);
      for (const command of COMMANDS) assert.ok(commands.includes(command), command);
    },
  ],
  [
    "statusraden visar gränserna från den insamlade datan",
    async (api) => {
      await waitFor(
        () => `statusraden visar "${api.statusText()}"`,
        () => (/ 5h 17% · v 5%$/.test(api.statusText()) ? true : null),
      );
    },
  ],
  [
    "vyn öppnas, webbvyns skript laddas under säkerhetsreglerna och vyn visar hälsoraden och dataraden",
    async (api) => {
      await vscode.commands.executeCommand("tokeniser.openView");
      await waitFor(
        () => "webbvyns skript skickade aldrig ready",
        () => (api.webviewReady() ? true : null),
      );
      const model = await waitFor(
        () => `vyns modell är ${JSON.stringify(api.viewModel()?.data ?? null)}`,
        () => {
          const current = api.viewModel();
          return current?.data?.summary.startsWith("3 händelser") === true ? current : null;
        },
      );
      assert.equal(model.unavailable, null);
      assert.equal(model.limits.rings[0].value, 17);
      assert.equal(model.limits.rings[1].value, 5);
      assert.equal(model.health?.checks.length, 7);
      assert.equal(model.health?.checks.find((check) => check.id === "collector")?.mark, "ok");
    },
  ],
];

export async function run(): Promise<void> {
  const extension = vscode.extensions.getExtension<TestApi | undefined>("lullo.tokeniser");
  assert.ok(extension, "extensionen lullo.tokeniser finns inte");
  const api = await extension.activate();
  assert.ok(api, "extensionen gav inget API i testläget");

  const failures: string[] = [];
  for (const [name, test] of tests) {
    try {
      await test(api);
      console.log(`✔ ${name}`);
    } catch (error) {
      failures.push(name);
      console.error(`✖ ${name}\n${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    }
  }
  if (failures.length > 0) throw new Error(`${failures.length} av ${tests.length} integrationstester föll: ${failures.join("; ")}`);
}
