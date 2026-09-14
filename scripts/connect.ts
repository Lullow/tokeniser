// Development tool until the extension has its own "Anslut till Claude Code" button.
//   node scripts/connect.ts                     show what connecting would change
//   node scripts/connect.ts --apply             install the collector, back up and edit settings.json
//   node scripts/connect.ts --disconnect        show what disconnecting would change
//   node scripts/connect.ts --disconnect --apply
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { tokeniserHome } from "../src/collector/store.ts";
import {
  lineDiff,
  planConnect,
  planDisconnect,
  sha256,
  statusLineCommand,
  type ConnectionState,
} from "../src/connect/settings.ts";

const args = new Set(process.argv.slice(2));
const apply = args.has("--apply");
const home = tokeniserHome();
const settingsPath = join(homedir(), ".claude", "settings.json");
const statePath = join(home, "connection.json");
const collectorSource = resolve(import.meta.dirname, "..", "dist", "collector.js");
const collectorPath = join(home, "bin", "collector.js");

const read = (path: string): string | null => (existsSync(path) ? readFileSync(path, "utf8") : null);

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function installCollector(): string {
  mkdirSync(join(home, "bin"), { recursive: true, mode: 0o700 });
  chmodSync(home, 0o700);
  copyFileSync(collectorSource, collectorPath);
  chmodSync(collectorPath, 0o600);
  return sha256(readFileSync(collectorPath, "utf8"));
}

function connect(): void {
  if (!existsSync(collectorSource)) fail("dist/collector.js saknas. Kör npm run build först.");
  const command = statusLineCommand(process.execPath, collectorPath);
  const before = read(settingsPath);
  const plan = planConnect(before, command);

  if (plan.kind === "occupied") {
    fail(`settings.json har redan en statusLine, så inget ändras:\n${JSON.stringify(plan.existing, null, 2)}`);
  }

  console.log(`Insamlare: ${collectorPath}`);
  console.log(`Kommando:  ${command}`);

  if (plan.kind === "already-connected") {
    if (apply) console.log(`Redan ansluten. Insamlaren uppdaterad (sha256 ${installCollector()}).`);
    else console.log("Redan ansluten. Kör med --apply för att uppdatera insamlaren.");
    return;
  }

  console.log(`\nÄndring i ${settingsPath}:\n`);
  console.log(lineDiff(before ?? "", plan.after));

  if (!apply) {
    console.log("\nInget har ändrats. Kör igen med --apply för att installera insamlaren, spara en backup och skriva ändringen.");
    return;
  }

  const collectorSha256 = installCollector();
  let backupPath: string | null = null;
  if (before !== null) {
    mkdirSync(join(home, "backup"), { recursive: true, mode: 0o700 });
    backupPath = join(home, "backup", `settings.${new Date().toISOString().replaceAll(":", "-")}.json`);
    copyFileSync(settingsPath, backupPath);
    chmodSync(backupPath, 0o600);
  }
  writeFileSync(settingsPath, plan.after);

  const state: ConnectionState = {
    settingsPath,
    backupPath,
    writtenSha256: sha256(plan.after),
    command,
    collectorSha256,
    connectedAt: Date.now(),
  };
  writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
  console.log(`\nAnsluten. Backup: ${backupPath ?? "ingen, settings.json fanns inte"}`);
}

function disconnect(): void {
  const stateText = read(statePath);
  if (stateText === null) fail("Ingen sparad anslutning hittades, så inget ändras.");
  const state = JSON.parse(stateText) as ConnectionState;
  const current = read(state.settingsPath);
  const backup = state.backupPath === null ? null : read(state.backupPath);
  if (state.backupPath !== null && backup === null) fail(`Backupen saknas: ${state.backupPath}`);

  const plan = planDisconnect(current, state, backup);
  if (plan.kind === "not-connected") {
    console.log("settings.json har ingen statusLine från Tokeniser, så inget ändras.");
    return;
  }

  if (plan.kind === "remove-entry") {
    console.log("settings.json har ändrats sedan anslutningen, så bara statusLine tas bort.\n");
  }
  console.log(lineDiff(current ?? "", plan.after ?? ""));

  if (!apply) {
    console.log("\nInget har ändrats. Kör igen med --disconnect --apply.");
    return;
  }
  if (plan.kind === "restore-backup" && state.backupPath !== null) {
    copyFileSync(state.backupPath, state.settingsPath);
  } else if (plan.after === null) {
    rmSync(state.settingsPath);
  } else {
    writeFileSync(state.settingsPath, plan.after);
  }
  rmSync(statePath);
  console.log("\nFrånkopplad.");
}

if (args.has("--disconnect")) disconnect();
else connect();
