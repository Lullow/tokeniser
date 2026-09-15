import { duration, moment } from "../status/format.ts";
import type { HealthCheck, HealthMark, HealthModel } from "../view/types.ts";

/** The only command the health check offers to copy. Nothing is ever run. */
export const DISCONNECT_COMMAND = "npm run connect -- --disconnect";
/** Rejected runs and invalid fields count for this long. */
export const RECENT_MS = 24 * 60 * 60 * 1000;

export type Outcome<T> = { ok: true; value: T } | { ok: false; error: string };

export interface LatestEvent {
  at: number;
  sessionId: string;
  projectLabel: string | null;
  version: string | null;
  /** Usage or context is present, so the session has had its first response. */
  responded: boolean;
  fiveHour: boolean;
  week: boolean;
  context: boolean;
}

export interface DataFacts {
  latest: LatestEvent | null;
  /** The latest resets_at seen for each window, in epoch milliseconds. */
  lastResets: { fiveHour: number | null; week: number | null };
  invalid: { events: number; fields: string[] };
}

export interface ProblemCount {
  kind: string;
  count: number;
  lastAt: number;
}

export interface CollectorFacts {
  connectedAt: number;
  expectedSha256: string;
  actualSha256: string;
}

export type ExecutableCheck =
  | { file: string; status: "ok" }
  | { file: string; status: "missing" }
  | { file: string; status: "not-executable" }
  | { file: string; status: "unsafe"; reason: string };

export interface RuntimeFacts {
  /** The saved command is exactly the one Tokeniser builds for this Node file and ~/.tokeniser. */
  commandMatches: boolean;
  /** Null when the command names no Node file. */
  node: ExecutableCheck | null;
  env: ExecutableCheck;
}

export interface SettingsFile {
  /** As shown to the user, for example ~/.claude/settings.json. */
  file: string;
  statusLine: "none" | "tokeniser" | "other";
  disableAllHooks: boolean | null;
  allowManagedHooksOnly: boolean | null;
}

export interface FolderSettings {
  name: string;
  local: SettingsFile | null;
  project: SettingsFile | null;
}

export interface SettingsFacts {
  managed: SettingsFile[];
  /** A missing file has no statusLine. */
  user: SettingsFile;
  folders: FolderSettings[];
  unreadable: { file: string; error: string }[];
}

export interface HealthFacts {
  checkedAt: number;
  data: Outcome<DataFacts>;
  /** Null when there is no session at all. */
  inWindowProject: boolean | null;
  problems: Outcome<ProblemCount[]>;
  collector: Outcome<CollectorFacts>;
  directories: Outcome<null>;
  runtime: Outcome<RuntimeFacts>;
  settings: Outcome<SettingsFacts>;
}

const STATE: Record<HealthMark, string> = {
  ok: "I ordning",
  warning: "Varning",
  unknown: "Kan inte kontrolleras",
  unchecked: "Kontrolleras inte",
};

const PROBLEM_WORDS: Record<string, string> = {
  empty: "tom indata",
  too_large: "för stor indata",
  not_json: "ogiltig JSON",
  not_object: "inte ett JSON-objekt",
  session_id: "ogiltigt sessions-id",
  unsafe_path: "osäker lagring",
  write_failed: "kunde inte skriva",
};

const LIMITS = [
  { key: "fiveHour", field: "rate_limits.five_hour", name: "5-timmarsgränsen" },
  { key: "week", field: "rate_limits.seven_day", name: "Veckogränsen" },
] as const;

const COMPARE_WITH_USAGE = "Jämför med `/usage`. Tokeniser visar det som saknas som Saknas, aldrig som 0.";

const OUT_OF_REACH =
  "Om mappen är betrodd i Claude Code, `--settings`, inställningar från claude.ai, Windows-policy och sessioner som startas i en undermapp. " +
  "Betrodda mappar står i `~/.claude.json`, som också innehåller din inloggning, så den filen läser Tokeniser inte.";

interface Finding {
  check: HealthCheck;
  /** The health row's title when this is the first warning. */
  title: string | null;
}

interface Issue {
  title: string;
  text: string;
}

function finding(id: string, label: string, mark: HealthMark, detail: string, extra: { title?: string; action?: string; command?: string } = {}): Finding {
  return {
    check: { id, label, mark, state: STATE[mark], detail, action: extra.action ?? null, command: extra.command ?? null },
    title: mark === "warning" ? (extra.title ?? label) : null,
  };
}

/** Backticks mark code in the view, so text from data never adds its own. */
const plain = (text: string): string => text.replaceAll("`", "'");
const shortHash = (hash: string): string => `${hash.slice(0, 4)}…${hash.slice(-4)}`;
const list = (items: readonly string[]): string =>
  items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} och ${items.at(-1) ?? ""}`;

function latestCheck(facts: HealthFacts, now: number): Finding {
  const label = "Senaste data";
  if (!facts.data.ok) return finding("latest", label, "unknown", `Indexet kan inte läsas: ${plain(facts.data.error)}`);
  const latest = facts.data.value.latest;
  if (latest === null) return finding("latest", label, "unknown", "Ingen data från Claude Code ännu. Den kommer när en session startar eller svarar.");
  const parts = [
    `${moment(latest.at, now)}, för ${duration(now - latest.at)} sedan`,
    `session \`${latest.sessionId.slice(0, 8)}\``,
    plain(latest.projectLabel ?? "okänt projekt"),
  ];
  if (latest.version !== null) parts.push(`Claude Code ${plain(latest.version)}`);
  const window = facts.inWindowProject === false ? " Ingen session från fönstrets mappar." : "";
  return finding("latest", label, "ok", `${parts.join(" · ")}.${window}`);
}

/** Point 7: which fields are missing and why. A documented reason is not a problem. */
function fieldsCheck(facts: HealthFacts, now: number): Finding {
  const label = "Fält i datan";
  if (!facts.data.ok) return finding("fields", label, "unknown", "Indexet kan inte läsas, så fälten kan inte kontrolleras.");
  const { latest, lastResets, invalid } = facts.data.value;
  const issues: Issue[] = [];
  const notes: string[] = [];
  let missingData = false;

  if (latest === null) {
    notes.push("Ingen data från Claude Code ännu.");
  } else if (!latest.responded) {
    const missing = [...LIMITS.filter((limit) => !latest[limit.key]).map((limit) => `\`${limit.field}\``), "kontextens användning"];
    notes.push(`${list(missing)} saknas: sessionen har inte fått något svar än.`);
  } else {
    for (const limit of LIMITS) {
      if (latest[limit.key]) continue;
      const resets = lastResets[limit.key];
      if (resets === null) {
        notes.push(`\`${limit.field}\` saknas. Gränserna finns bara för Pro och Max.`);
      } else if (resets <= latest.at) {
        notes.push(`\`${limit.field}\` saknas: fönstret återställdes ${moment(resets, now)}, och fältet kommer tillbaka vid nästa svar.`);
      } else {
        missingData = true;
        issues.push({
          title: `${limit.name} saknas i Claude Codes data`,
          text: `\`${limit.field}\` saknas fast fönstret inte återställs förrän ${moment(resets, now)}. Ingen dokumenterad orsak passar, så Claude Code kan ha ändrat formatet.`,
        });
      }
    }
    if (!latest.context) {
      missingData = true;
      issues.push({ title: "Kontexten saknas i Claude Codes data", text: "`context_window.used_percentage` saknas efter ett svar. Ingen dokumenterad orsak passar." });
    }
    if (issues.length === 0 && notes.length === 0) notes.push("Alla fält finns i senaste svaret.");
  }

  if (invalid.events > 0) {
    const shown = invalid.fields.slice(0, 6).map((field) => `\`${plain(field)}\``);
    const more = invalid.fields.length > shown.length ? " med flera" : "";
    issues.push({
      title: "Fält i Claude Codes data klarar inte valideringen",
      text: `${invalid.events} ${invalid.events === 1 ? "händelse" : "händelser"} senaste dygnet hade fält som inte klarade valideringen: ${shown.join(", ")}${more}.`,
    });
  }

  let problemsUnknown = false;
  if (!facts.problems.ok) {
    problemsUnknown = true;
    notes.push(`Avvisade körningar kan inte läsas: ${plain(facts.problems.error)}`);
  } else if (facts.problems.value.length > 0) {
    const problems = facts.problems.value;
    const total = problems.reduce((sum, p) => sum + p.count, 0);
    const kinds = problems.map((p) => `${PROBLEM_WORDS[p.kind] ?? p.kind.replaceAll("_", " ")}: ${p.count}`).join(", ");
    issues.push({
      title: "Insamlaren avvisade körningar",
      text: `${total} ${total === 1 ? "körning" : "körningar"} avvisades senaste dygnet (${kinds}), senast ${moment(Math.max(...problems.map((p) => p.lastAt)), now)}.`,
    });
  } else {
    notes.push("Inga avvisade körningar senaste dygnet.");
  }

  const detail = [...issues.map((issue) => issue.text), ...notes].join(" ");
  const first = issues[0];
  if (first !== undefined) {
    return finding("fields", label, "warning", detail, missingData ? { title: first.title, action: COMPARE_WITH_USAGE } : { title: first.title });
  }
  return finding("fields", label, problemsUnknown || latest === null ? "unknown" : "ok", detail);
}

/** Threat model: the checksum detects a replaced collector but cannot prevent it. */
function collectorCheck(facts: HealthFacts, now: number): Finding {
  const label = "Insamlaren";
  if (!facts.collector.ok) {
    return finding("collector", label, "warning", `Insamlaren kan inte kontrolleras: ${plain(facts.collector.error)}`, {
      title: "Insamlaren kan inte kontrolleras",
      action: "Koppla från och anslut igen.",
      command: DISCONNECT_COMMAND,
    });
  }
  const { connectedAt, expectedSha256, actualSha256 } = facts.collector.value;
  if (expectedSha256 === actualSha256) {
    return finding(
      "collector",
      label,
      "ok",
      `Oförändrad sedan anslutningen ${moment(connectedAt, now)} (\`${shortHash(actualSha256)}\`). Ingen symbolisk länk, en hård länk och bara du har rättigheter till den.`,
    );
  }
  return finding(
    "collector",
    label,
    "warning",
    `Kontrollsumman har ändrats sedan anslutningen ${moment(connectedAt, now)}: väntad \`${shortHash(expectedSha256)}\`, nu \`${shortHash(actualSha256)}\`. Kontrollen upptäcker ändringen men kan inte hindra den.`,
    {
      title: "Insamlaren har ändrats sedan anslutningen",
      action: "Tokeniser byter bara insamlaren vid anslutning, så något annat har ändrat filen. Ta reda på vad innan du kopplar från och ansluter igen.",
      command: DISCONNECT_COMMAND,
    },
  );
}

/** Known gap 2 in the collector's contract: the directory chain is checked again while running. */
function directoriesCheck(facts: HealthFacts): Finding {
  const label = "Mappar";
  if (facts.directories.ok) {
    return finding(
      "directories",
      label,
      "ok",
      "`~/.tokeniser` och undermapparna är privata, så bara du har åtkomst. Mapparna ovanför har inga symboliska länkar, och ingen annan kan skriva i dem.",
    );
  }
  return finding("directories", label, "warning", plain(facts.directories.error), {
    title: "Tokenisers mappar är inte skyddade",
    action: "Rätta ägare och rättigheter, eller koppla från och anslut igen.",
  });
}

/**
 * Known gap 7, accepted: the content of Node and env is not compared. Only code running as you can
 * change it, which is outside the threat model and could rewrite connection.json as well. What
 * other users could do is checked: the files exist, run, and nobody else can write to them.
 */
function runtimeCheck(facts: HealthFacts): Finding {
  const label = "Node och env";
  if (!facts.runtime.ok) return finding("runtime", label, "unknown", `Kan inte kontrolleras: ${plain(facts.runtime.error)}`);
  const { commandMatches, node, env } = facts.runtime.value;
  const issues: Issue[] = [];
  const actions = new Set<string>();
  let disconnect = false;
  const reconnect = "Koppla från och anslut igen, så används den Node som kör anslutningen.";

  if (!commandMatches) {
    issues.push({
      title: "Kommandot i anslutningen är inte Tokenisers",
      text: "Kommandot i `connection.json` är inte det som Tokeniser skapar för Node och `~/.tokeniser`.",
    });
    actions.add(reconnect);
    disconnect = true;
  }
  for (const { check, name } of [
    { check: node, name: "Node-filen" },
    { check: env, name: "/usr/bin/env" },
  ]) {
    if (check === null || check.status === "ok") continue;
    const file = `\`${plain(check.file)}\``;
    if (check.status === "missing") {
      const nvm = name === "Node-filen" ? " Det händer till exempel när en Node-version avinstalleras med nvm." : "";
      issues.push({ title: `${name} saknas`, text: `${file} finns inte, så Claude Code kan inte köra insamlaren.${nvm}` });
      actions.add(reconnect);
      disconnect = true;
    } else if (check.status === "not-executable") {
      issues.push({ title: `${name} är inte körbar`, text: `${file} är inte körbar, så Claude Code kan inte köra insamlaren.` });
      actions.add("Gör filen körbar igen, eller koppla från och anslut igen.");
    } else {
      issues.push({ title: `${name} är inte skyddad`, text: `${plain(check.reason)} Andra användare skulle kunna byta ut det som Claude Code kör.` });
      actions.add("Rätta ägare och rättigheter.");
    }
  }

  const first = issues[0];
  if (first !== undefined) {
    const extra = { title: first.title, action: [...actions].join(" "), ...(disconnect ? { command: DISCONNECT_COMMAND } : {}) };
    return finding("runtime", label, "warning", issues.map((issue) => issue.text).join(" "), extra);
  }
  const nodeFile = node === null ? "Node" : `\`${plain(node.file)}\``;
  return finding(
    "runtime",
    label,
    "ok",
    `${nodeFile} och \`${plain(env.file)}\` finns och är körbara, och ingen annan än du eller root kan skriva i dem eller i mapparna ovanför. ` +
      "Innehållet jämförs inte: bara kod som körs som du kan ändra det, och den ligger utanför hotmodellen.",
  );
}

/**
 * Settings precedence in Claude Code: managed, command line, project local, shared project,
 * user. A higher level replaces statusLine and disableAllHooks from the levels below it.
 */
function statusLineCheck(facts: HealthFacts): Finding {
  const label = "Statusraden i Claude Code";
  if (!facts.settings.ok) return finding("statusline", label, "unknown", `Inställningarna kan inte kontrolleras: ${plain(facts.settings.error)}`);
  const { managed, user, folders, unreadable } = facts.settings.value;
  const issues = new Map<string, Issue>();
  const actions = new Set<string>();
  const add = (issue: Issue, action?: string): void => {
    issues.set(issue.text, issue);
    if (action !== undefined) actions.add(action);
  };

  for (const file of managed) {
    const where = `\`${plain(file.file)}\``;
    if (file.statusLine === "other") {
      add({ title: "Organisationens inställningar har en egen statusrad", text: `${where} sätter en egen \`statusLine\`, och den går före alla andra inställningar.` });
    }
    if (file.allowManagedHooksOnly === true) {
      add({ title: "Organisationens inställningar stänger av statusraden", text: `${where} sätter \`allowManagedHooksOnly\`, så bara organisationens statusrad körs.` });
    }
    if (file.disableAllHooks === true) {
      add({ title: "Organisationens inställningar stänger av statusraden", text: `${where} sätter \`disableAllHooks\`.` });
    }
  }

  const reconnect = "Anslut igen med `npm run connect`.";
  const userFile = `\`${plain(user.file)}\``;
  if (user.statusLine === "none") {
    add({ title: "Statusraden är inte ansluten", text: `${userFile} har ingen \`statusLine\`, så Claude Code kör inte insamlaren.` }, reconnect);
  } else if (user.statusLine === "other") {
    add({ title: "En annan statusrad har ersatt Tokenisers", text: `\`statusLine\` i ${userFile} är inte kommandot från anslutningen, så Claude Code kör inte insamlaren.` }, reconnect);
  }

  for (const folder of folders) {
    const name = plain(folder.name);
    const override = [folder.local, folder.project].find((file): file is SettingsFile => file !== null && file.statusLine !== "none");
    if (override?.statusLine === "other") {
      add(
        {
          title: `Projektet ${name} har en egen statusrad`,
          text: `\`${plain(override.file)}\` sätter en egen \`statusLine\`. Den går före din användarfil, så sessioner som startas i mappen skickar ingen data till Tokeniser.`,
        },
        "Ta bort `statusLine` ur filen om projektet ska mätas.",
      );
    }
  }

  for (const folder of folders.length > 0 ? folders : [null]) {
    const source = [folder?.local ?? null, folder?.project ?? null, user].find((file): file is SettingsFile => file !== null && file.disableAllHooks !== null);
    if (source?.disableAllHooks !== true) continue;
    if (source === user) {
      add({ title: "Statusraden är avstängd", text: `\`disableAllHooks\` i ${userFile} stänger av statusraden.` });
    } else {
      add({
        title: `Statusraden är avstängd i ${plain(folder?.name ?? "")}`,
        text: `\`disableAllHooks\` i \`${plain(source.file)}\` stänger av statusraden för sessioner som startas i mappen.`,
      });
    }
  }

  const unread = unreadable.map((entry) => `\`${plain(entry.file)}\` ${plain(entry.error)}.`);
  const found = [...issues.values()];
  const first = found[0];
  if (first !== undefined) {
    const detail = [...found.map((issue) => issue.text), ...unread].join(" ");
    return finding("statusline", label, "warning", detail, actions.size > 0 ? { title: first.title, action: [...actions].join(" ") } : { title: first.title });
  }
  if (unread.length > 0) return finding("statusline", label, "unknown", unread.join(" "));
  return finding(
    "statusline",
    label,
    "ok",
    `${userFile} kör Tokenisers insamlare. Ingen annan \`statusLine\` och inget \`disableAllHooks\` i organisationens inställningar eller i fönstrets \`.claude\`-filer.`,
  );
}

/** Decision point 7 and 2026-09-15: one row per check, first in the view, open only when something is wrong. */
export function buildHealth(facts: HealthFacts, now: number): HealthModel {
  const findings = [
    latestCheck(facts, now),
    fieldsCheck(facts, now),
    collectorCheck(facts, now),
    directoriesCheck(facts),
    statusLineCheck(facts),
    runtimeCheck(facts),
    finding("out-of-reach", "Utom räckhåll", "unknown", OUT_OF_REACH),
  ];
  const warnings = findings.filter((f) => f.check.mark === "warning");
  const oks = findings.filter((f) => f.check.mark === "ok").length;
  const checked = `kontrollerat ${moment(facts.checkedAt, now)}`;
  const first = warnings[0];
  return {
    level: first === undefined ? "ok" : "warning",
    title: first?.title ?? "Allt i ordning",
    summary:
      first === undefined
        ? `${oks} ${oks === 1 ? "kontroll" : "kontroller"} i ordning · ${checked}`
        : `${warnings.length} ${warnings.length === 1 ? "varning" : "varningar"} · ${checked}`,
    checks: findings.map((f) => f.check),
  };
}
