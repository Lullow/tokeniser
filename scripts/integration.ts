// Runs the integration tests in real VS Code, against a temporary home directory with made-up data.
//   npm run test:integration      needs a display; CI runs it through xvfb-run
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runTests } from "@vscode/test-electron";
import { build } from "esbuild";
import { initStore } from "../src/collector/store.ts";
import { collectorLayout, statusLineCommand } from "../src/connect/plan.ts";
import { ensurePrivateDir, sha256 } from "../src/secure/fs.ts";
import { appendEvents, eventLine } from "../test/helpers/events.ts";

/** The lowest version in engines.vscode. */
const VSCODE_VERSION = "1.137.0";
const MIN = 60_000;
const root = resolve(import.meta.dirname, "..");
const suite = join(root, "dist", "integration", "suite.cjs");

/** A connected Tokeniser with three recent events: 5 h at 17 % and the week at 5 %, both resetting later. */
function fixtureHome(): string {
  const home = mkdtempSync(join(tmpdir(), "tokeniser-integration-"));
  const layout = collectorLayout(join(home, ".tokeniser"));
  initStore(layout.home);
  ensurePrivateDir(layout.bin);
  ensurePrivateDir(layout.backup);

  const collector = readFileSync(join(root, "dist", "collector.js"));
  writeFileSync(layout.collector, collector, { mode: 0o600 });
  const command = statusLineCommand(realpathSync(process.execPath), layout);
  const settings = `${JSON.stringify({ statusLine: { type: "command", command } }, null, 2)}\n`;
  mkdirSync(join(home, ".claude"), { mode: 0o700 });
  writeFileSync(join(home, ".claude", "settings.json"), settings, { mode: 0o600 });
  const connection = {
    format: 1,
    command,
    settingsBeforeSha256: null,
    settingsAfterSha256: sha256(settings),
    backupFile: null,
    collectorSha256: sha256(collector),
    connectedAt: Date.now(),
  };
  writeFileSync(layout.connection, JSON.stringify(connection), { mode: 0o600 });

  const now = Date.now();
  const seconds = (ms: number): number => Math.floor(ms / 1000);
  const events = [15, 16, 17].map((five, i) =>
    eventLine({ at: now - (3 - i) * MIN, five, fiveResets: seconds(now + 120 * MIN), week: 5, weekResets: seconds(now + 72 * 60 * MIN) }),
  );
  appendEvents(layout.home, new Date(now).toISOString().slice(0, 7), events);
  return home;
}

async function main(): Promise<void> {
  await build({
    entryPoints: [join(root, "test", "integration", "suite.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
    external: ["vscode"],
    outfile: suite,
    logLevel: "warning",
  });
  const home = fixtureHome();
  try {
    await runTests({
      version: VSCODE_VERSION,
      extensionDevelopmentPath: root,
      extensionTestsPath: suite,
      extensionTestsEnv: { HOME: home },
      launchArgs: ["--disable-extensions", "--disable-workspace-trust", "--skip-welcome", "--skip-release-notes"],
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error(`Integrationstesterna föll: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
