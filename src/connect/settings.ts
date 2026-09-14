import { sha256 } from "../secure/fs.ts";

export type ConnectChange =
  | { kind: "connect"; after: string }
  | { kind: "already-connected" }
  | { kind: "occupied"; existing: unknown };

export type SettingsDisconnect =
  /** settings.json is exactly what Tokeniser wrote: put the backup back byte for byte. */
  | { change: "restore-backup"; after: string }
  /** settings.json did not exist before connecting and is unchanged since. */
  | { change: "delete" }
  /** settings.json changed after connecting: remove only Tokeniser's statusLine. */
  | { change: "remove-entry"; after: string }
  | { change: "none" };

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

function detectIndent(text: string): string {
  return /\n([ \t]+)"/.exec(text)?.[1] ?? "  ";
}

function parseSettings(text: string): Json {
  const settings: unknown = JSON.parse(text);
  if (!isObj(settings)) throw new Error("settings.json innehåller inte ett JSON-objekt.");
  return settings;
}

/**
 * Adds a statusLine entry by inserting text before the closing brace, so every
 * existing byte of settings.json stays as it was.
 */
export function planConnect(before: string | null, command: string): ConnectChange {
  const entry = { type: "command", command };
  if (before === null || before.trim() === "") {
    return { kind: "connect", after: JSON.stringify({ statusLine: entry }, null, 2) + "\n" };
  }

  const settings = parseSettings(before);
  if (settings.statusLine !== undefined) {
    return isObj(settings.statusLine) && settings.statusLine.command === command
      ? { kind: "already-connected" }
      : { kind: "occupied", existing: settings.statusLine };
  }

  const close = before.lastIndexOf("}");
  const head = before.slice(0, close).trimEnd();
  const unit = detectIndent(before);
  const member = `${unit}"statusLine": ${JSON.stringify(entry, null, unit).replaceAll("\n", `\n${unit}`)}`;
  const after = `${head}${head.endsWith("{") ? "" : ","}\n${member}\n${before.slice(close)}`;

  const check = parseSettings(after);
  if (!isObj(check.statusLine) || check.statusLine.command !== command) {
    throw new Error("Kunde inte lägga till statusLine utan att ändra resten av settings.json.");
  }
  return { kind: "connect", after };
}

export function planSettingsDisconnect(
  current: string | null,
  state: { command: string; settingsBeforeSha256: string | null; settingsAfterSha256: string },
  backup: string | null,
): SettingsDisconnect {
  if (current === null) return { change: "none" };

  if (sha256(current) === state.settingsAfterSha256) {
    if (state.settingsBeforeSha256 === null) return { change: "delete" };
    if (backup === null || sha256(backup) !== state.settingsBeforeSha256) {
      throw new Error("Backupen stämmer inte med settings.json från före anslutningen.");
    }
    return { change: "restore-backup", after: backup };
  }

  const settings = parseSettings(current);
  if (!isObj(settings.statusLine) || settings.statusLine.command !== state.command) return { change: "none" };
  const { statusLine: _statusLine, ...rest } = settings;
  return { change: "remove-entry", after: JSON.stringify(rest, null, detectIndent(current)) + "\n" };
}

/** A single-hunk line diff; enough for one inserted or removed entry. */
export function lineDiff(before: string, after: string, context = 3): string {
  const a = before.split("\n");
  const b = after.split("\n");
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const out: string[] = [];
  for (let i = Math.max(0, start - context); i < start; i++) out.push(`  ${a[i]}`);
  for (let i = start; i < endA; i++) out.push(`- ${a[i]}`);
  for (let i = start; i < endB; i++) out.push(`+ ${b[i]}`);
  for (let i = endA; i < Math.min(a.length, endA + context); i++) out.push(`  ${a[i]}`);
  return out.join("\n");
}
