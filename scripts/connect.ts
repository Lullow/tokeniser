// Development tool until the extension has its own "Anslut till Claude Code" button.
//   node scripts/connect.ts                                 show the connect plan and its hash
//   node scripts/connect.ts --apply=<hash>                  carry out exactly that plan
//   node scripts/connect.ts --no-line [--apply=<hash>]      the same, without the line in Claude Code's status line
//   node scripts/connect.ts --disconnect                    show the disconnect plan and its hash
//   node scripts/connect.ts --disconnect --apply=<hash>
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  backupFileName,
  collectorLayout,
  ENV_PATH,
  NODE_REQUIREMENT,
  nodeVersionSupported,
  parseConnectionState,
  planHash,
  statusLineCommand,
  type ConnectionState,
  type ConnectPlan,
  type DisconnectPlan,
} from "../src/connect/plan.ts";
import { lineDiff, planConnect, planSettingsDisconnect } from "../src/connect/settings.ts";
import {
  assertPrivateDir,
  assertTrustedAncestors,
  currentUid,
  ensurePrivateDir,
  readFileChecked,
  removeFileChecked,
  replaceFileAtomic,
  sha256,
  writeNewPrivateFile,
  type FilePolicy,
} from "../src/secure/fs.ts";

const KIB = 1024;
const MIB = 1024 * KIB;
const SETTINGS_POLICY: FilePolicy = { private: false, maxBytes: MIB };
const PRIVATE_POLICY: FilePolicy = { private: true, maxBytes: 4 * MIB };
const CONNECTION_POLICY: FilePolicy = { private: true, maxBytes: 64 * KIB };
const MISMATCH =
  "Planen stämmer inte med hashen du godkände, så ingenting har ändrats. Något har ändrats sedan granskningen. Kör kommandot utan --apply för att se den aktuella planen.";

const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const uid = currentUid();
const claudeDir = join(homedir(), ".claude");
const settingsPath = join(claudeDir, "settings.json");
const layout = collectorLayout(join(homedir(), ".tokeniser"));
const collectorSource = resolve(import.meta.dirname, "..", "dist", "collector.js");

class Abort extends Error {}

function fail(message: string): never {
  throw new Abort(message);
}

const octal = (mode: number): string => (mode & 0o7777).toString(8).padStart(4, "0");

function section(title: string, lines: string[]): void {
  console.log(`\n${title}`);
  for (const line of lines) console.log(`  ${line}`);
}

function exists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function decode(bytes: Uint8Array, path: string): string {
  try {
    return utf8.decode(bytes);
  } catch {
    return fail(`${path} är inte giltig UTF-8.`);
  }
}

/** Checks the ancestors of ~/.tokeniser and every Tokeniser directory that exists. */
function verifyTokeniserTree(): string[] {
  assertTrustedAncestors(layout.home, uid);
  const directories = [layout.home, layout.bin, layout.events, layout.state, layout.backup];
  for (const dir of directories) if (exists(dir)) assertPrivateDir(dir, uid);
  return directories;
}

interface Settings {
  bytes: Buffer;
  text: string;
  mode: number;
}

function readSettings(): Settings | null {
  if (!exists(claudeDir)) fail(`${claudeDir} saknas. Starta Claude Code en gång först.`);
  assertTrustedAncestors(settingsPath, uid);
  const file = readFileChecked(settingsPath, SETTINGS_POLICY, uid);
  return file === null ? null : { bytes: file.bytes, text: decode(file.bytes, settingsPath), mode: file.mode };
}

function verifyEnvBinary(): void {
  if (!exists(ENV_PATH)) fail(`${ENV_PATH} saknas.`);
  const st = lstatSync(ENV_PATH);
  if (!st.isFile() || st.uid !== 0 || (st.mode & 0o022) !== 0) {
    fail(`${ENV_PATH} måste vara en vanlig fil som ägs av root och inte kan skrivas av andra.`);
  }
  assertTrustedAncestors(ENV_PATH, uid);
}

// ---------- Connect ----------

interface ConnectWork {
  plan: ConnectPlan;
  collectorBytes: Buffer;
  settingsBefore: Buffer | null;
  settingsAfter: string;
  nodeUserWritable: boolean;
}

function gatherConnect(noLine: boolean): ConnectWork {
  const directories = verifyTokeniserTree();
  if (exists(layout.connection)) {
    fail(`Tokeniser är redan ansluten enligt ${layout.connection}. Koppla från först med --disconnect.`);
  }
  verifyEnvBinary();

  // The command runs this very Node binary, so its version is the one that matters.
  const nodeVersion = process.versions.node;
  if (!nodeVersionSupported(nodeVersion)) {
    fail(`Node ${nodeVersion} stöds inte. Insamlaren kräver ${NODE_REQUIREMENT}, där behörighetsmodellen nekar att skapa symboliska länkar (CVE-2025-55130).`);
  }
  const nodePath = realpathSync(process.execPath);
  const nodeStat = lstatSync(nodePath);
  let collectorBytes: Buffer;
  try {
    collectorBytes = readFileSync(collectorSource);
  } catch {
    return fail("dist/collector.js saknas. Kör npm run build först.");
  }

  const command = statusLineCommand(nodePath, layout, { line: !noLine });
  const settings = readSettings();
  const change = planConnect(settings?.text ?? null, command);
  if (change.kind === "occupied") {
    fail(`settings.json har redan en statusLine, så inget ändras:\n${JSON.stringify(change.existing, null, 2)}`);
  }
  if (change.kind === "already-connected") {
    fail("settings.json pekar redan på Tokenisers insamlare men connection.json saknas. Ta bort statusLine för hand och anslut igen.");
  }

  const existingCollector = readFileChecked(layout.collector, PRIVATE_POLICY, uid);
  const beforeSha256 = settings === null ? null : sha256(settings.bytes);
  const plan: ConnectPlan = {
    tool: "tokeniser-connect",
    format: 1,
    action: "connect",
    uid,
    env: ENV_PATH,
    node: { path: nodePath, version: nodeVersion, sha256: sha256(readFileSync(nodePath)) },
    command,
    directories: directories.map((path) => ({ path, mode: 0o700 })),
    collector: {
      path: layout.collector,
      mode: 0o600,
      sha256: sha256(collectorBytes),
      replacesSha256: existingCollector === null ? null : sha256(existingCollector.bytes),
    },
    backup: beforeSha256 === null ? null : { path: join(layout.backup, backupFileName(beforeSha256)), mode: 0o600, sha256: beforeSha256 },
    connection: { path: layout.connection, mode: 0o600 },
    settings: {
      path: settingsPath,
      mode: settings?.mode ?? 0o600,
      beforeSha256,
      afterSha256: sha256(change.after),
      diff: lineDiff(settings?.text ?? "", change.after),
    },
  };
  return {
    plan,
    collectorBytes,
    settingsBefore: settings?.bytes ?? null,
    settingsAfter: change.after,
    nodeUserWritable: nodeStat.uid !== 0 || (nodeStat.mode & 0o022) !== 0,
  };
}

function printConnect(work: ConnectWork, hash: string): void {
  const { plan } = work;
  console.log("Plan: anslut Tokeniser till Claude Code");
  section("Kontrollerat", [
    `Mappkedjan till ${layout.home}: inga symboliska länkar, rätt ägare, ingen annan kan skriva.`,
    `${plan.settings.path}: vanlig fil, en hård länk, rätt ägare, ingen annan kan skriva.`,
    `${ENV_PATH} ägs av root.`,
  ]);
  section("Mappar som skapas eller redan är privata (0700)", plan.directories.map((d) => d.path));
  section("Insamlare", [
    `${plan.collector.path} (${octal(plan.collector.mode)})`,
    `sha256 ${plan.collector.sha256}`,
    plan.collector.replacesSha256 === null ? "ny fil" : `ersätter fil med sha256 ${plan.collector.replacesSha256}`,
  ]);
  section("Node", [
    plan.node.path,
    `version ${plan.node.version}`,
    `sha256 ${plan.node.sha256}`,
    ...(work.nodeUserWritable ? ["Obs: filen kan ändras av din användare, till exempel av nvm."] : []),
  ]);
  section("Terminalrad", [
    plan.command.endsWith(" --no-line")
      ? "av: insamlaren sparar men skriver ingen rad i Claude Codes statusrad"
      : "på: insamlaren skriver en rad som 5h 64% · v 31% · ktx 42% i Claude Codes statusrad",
  ]);
  if (plan.backup) section("Backup av settings.json", [`${plan.backup.path} (${octal(plan.backup.mode)})`, `sha256 ${plan.backup.sha256}`]);
  section("Anslutningsuppgifter", [`${plan.connection.path} (${octal(plan.connection.mode)})`]);
  const modeNote = plan.settings.beforeSha256 === null ? `ny fil, ${octal(plan.settings.mode)}` : `behåller ${octal(plan.settings.mode)}`;
  section(`Ändring i ${plan.settings.path} (${modeNote})`, plan.settings.diff.split("\n"));
  console.log(`\nPlanens hash: ${hash}`);
  console.log(`\nInget har ändrats. Godkänn exakt den här planen med:\n  npm run connect -- --apply=${hash}`);
}

function applyConnect(work: ConnectWork): void {
  const { plan } = work;
  const done: string[] = [];
  try {
    for (const dir of plan.directories) ensurePrivateDir(dir.path, uid);
    replaceFileAtomic(
      plan.collector.path,
      work.collectorBytes,
      { mode: plan.collector.mode, exactMode: true, durable: true, expectedSha256: plan.collector.replacesSha256, currentPolicy: PRIVATE_POLICY },
      uid,
    );
    done.push(`installerade ${plan.collector.path}`);

    if (plan.backup !== null && work.settingsBefore !== null) {
      writeNewPrivateFile(plan.backup.path, work.settingsBefore, uid);
      done.push(`sparade ${plan.backup.path}`);
    }

    // Written before settings.json, so a failed settings write can still be cleaned up with --disconnect.
    const state: ConnectionState = {
      format: 1,
      command: plan.command,
      settingsBeforeSha256: plan.settings.beforeSha256,
      settingsAfterSha256: plan.settings.afterSha256,
      backupFile: plan.settings.beforeSha256 === null ? null : backupFileName(plan.settings.beforeSha256),
      collectorSha256: plan.collector.sha256,
      connectedAt: Date.now(),
    };
    writeNewPrivateFile(plan.connection.path, Buffer.from(JSON.stringify(state, null, 2) + "\n"), uid);
    done.push(`sparade ${plan.connection.path}`);

    replaceFileAtomic(
      plan.settings.path,
      Buffer.from(work.settingsAfter),
      { mode: plan.settings.mode, exactMode: true, durable: true, expectedSha256: plan.settings.beforeSha256, currentPolicy: SETTINGS_POLICY },
      uid,
    );
    const written = readFileChecked(plan.settings.path, SETTINGS_POLICY, uid);
    if (written === null || sha256(written.bytes) !== plan.settings.afterSha256) {
      throw new Error(`${plan.settings.path} innehåller inte det som skrevs.`);
    }
    done.push(`skrev ${plan.settings.path}`);
  } catch (error) {
    if (done.length > 0) console.error(`Hann utföra:\n${done.map((d) => `  ${d}`).join("\n")}\nKör --disconnect för att städa upp.`);
    throw error;
  }
  console.log(`Planens hash stämmer. Ansluten:\n${done.map((d) => `  ${d}`).join("\n")}`);
}

// ---------- Disconnect ----------

interface DisconnectWork {
  plan: DisconnectPlan;
  settingsAfter: Buffer | null;
}

function gatherDisconnect(): DisconnectWork {
  verifyTokeniserTree();
  const connection = readFileChecked(layout.connection, CONNECTION_POLICY, uid);
  if (connection === null) fail("Ingen connection.json hittades, så det finns inget att koppla från.");
  const state = parseConnectionState(decode(connection.bytes, layout.connection));

  const settings = readSettings();
  const backupPath = state.backupFile === null ? null : join(layout.backup, state.backupFile);
  const backup = backupPath === null ? null : readFileChecked(backupPath, PRIVATE_POLICY, uid);
  if (backupPath !== null && backup === null) fail(`Backupen ${backupPath} saknas, så settings.json kan inte återställas.`);

  const change = planSettingsDisconnect(settings?.text ?? null, state, backup === null ? null : decode(backup.bytes, backupPath ?? ""));
  const collector = readFileChecked(layout.collector, PRIVATE_POLICY, uid);

  let diff = "";
  let settingsAfter: Buffer | null = null;
  if (change.change === "restore-backup" && backup !== null) {
    diff = lineDiff(settings?.text ?? "", change.after);
    settingsAfter = backup.bytes;
  } else if (change.change === "remove-entry") {
    diff = lineDiff(settings?.text ?? "", change.after);
    settingsAfter = Buffer.from(change.after);
  } else if (change.change === "delete") {
    diff = "(settings.json tas bort, eftersom filen inte fanns före anslutningen)";
  }

  const plan: DisconnectPlan = {
    tool: "tokeniser-connect",
    format: 1,
    action: "disconnect",
    uid,
    connection: { path: layout.connection, sha256: sha256(connection.bytes) },
    settings: {
      path: settingsPath,
      mode: settings?.mode ?? null,
      change: change.change,
      beforeSha256: settings === null ? null : sha256(settings.bytes),
      afterSha256: settingsAfter === null ? null : sha256(settingsAfter),
      diff,
    },
    backup: backupPath === null || backup === null ? null : { path: backupPath, sha256: sha256(backup.bytes) },
    collector: collector === null ? null : { path: layout.collector, sha256: sha256(collector.bytes) },
  };
  return { plan, settingsAfter };
}

const CHANGE_TEXT: Record<DisconnectPlan["settings"]["change"], string> = {
  "restore-backup": "återställs byte för byte från backupen",
  "remove-entry": "har ändrats sedan anslutningen, så bara statusLine tas bort",
  delete: "tas bort, eftersom den inte fanns före anslutningen",
  none: "har ingen statusLine från Tokeniser och lämnas orörd",
};

function printDisconnect(plan: DisconnectPlan, hash: string): void {
  console.log("Plan: koppla från Tokeniser");
  section(`${plan.settings.path} ${CHANGE_TEXT[plan.settings.change]}`, plan.settings.diff === "" ? [] : plan.settings.diff.split("\n"));
  section("Tas bort", [
    ...(plan.collector === null ? [] : [`${plan.collector.path} (sha256 ${plan.collector.sha256})`]),
    `${plan.connection.path} (sha256 ${plan.connection.sha256})`,
  ]);
  section("Lämnas kvar", [
    ...(plan.backup === null ? [] : [`${plan.backup.path}`]),
    "insamlad data i events/ och state/",
  ]);
  console.log(`\nPlanens hash: ${hash}`);
  console.log(`\nInget har ändrats. Godkänn exakt den här planen med:\n  npm run connect -- --disconnect --apply=${hash}`);
}

function applyDisconnect(work: DisconnectWork): void {
  const { plan } = work;
  const { settings } = plan;
  if ((settings.change === "restore-backup" || settings.change === "remove-entry") && work.settingsAfter !== null && settings.mode !== null) {
    replaceFileAtomic(
      settings.path,
      work.settingsAfter,
      { mode: settings.mode, exactMode: true, durable: true, expectedSha256: settings.beforeSha256, currentPolicy: SETTINGS_POLICY },
      uid,
    );
  } else if (settings.change === "delete" && settings.beforeSha256 !== null) {
    removeFileChecked(settings.path, settings.beforeSha256, SETTINGS_POLICY, uid);
  }
  if (plan.collector !== null) removeFileChecked(plan.collector.path, plan.collector.sha256, PRIVATE_POLICY, uid);
  removeFileChecked(plan.connection.path, plan.connection.sha256, CONNECTION_POLICY, uid);
  console.log(`Planens hash stämmer. Frånkopplad: ${settings.path} ${CHANGE_TEXT[settings.change]}.`);
}

// ---------- Main ----------

function parseArgs(args: string[]): { disconnect: boolean; approved: string | null; noLine: boolean } {
  let disconnect = false;
  let approved: string | null = null;
  let noLine = false;
  for (const arg of args) {
    if (arg === "--disconnect") {
      disconnect = true;
    } else if (arg === "--no-line") {
      noLine = true;
    } else if (arg.startsWith("--apply")) {
      const match = /^--apply=([0-9a-f]{64})$/.exec(arg);
      if (match === null) fail("--apply kräver planens fullständiga hash: --apply=<64 hexadecimala tecken>.");
      approved = match[1] ?? null;
    } else {
      fail(`Okänt argument: ${arg}`);
    }
  }
  if (disconnect && noLine) fail("--no-line gäller bara anslutning.");
  return { disconnect, approved, noLine };
}

function main(): void {
  const { disconnect, approved, noLine } = parseArgs(process.argv.slice(2));
  if (disconnect) {
    const work = gatherDisconnect();
    const hash = planHash(work.plan);
    if (approved === null) return printDisconnect(work.plan, hash);
    if (hash !== approved) fail(MISMATCH);
    return applyDisconnect(work);
  }
  const work = gatherConnect(noLine);
  const hash = planHash(work.plan);
  if (approved === null) return printConnect(work, hash);
  if (hash !== approved) fail(MISMATCH);
  applyConnect(work);
}

try {
  main();
} catch (error) {
  console.error(`Avbrutet: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
