import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildHealth,
  DISCONNECT_COMMAND,
  type CollectorFacts,
  type DataFacts,
  type HealthFacts,
  type LatestEvent,
  type ProblemCount,
  type SettingsFacts,
  type SettingsFile,
} from "../../src/health/model.ts";
import type { HealthCheck } from "../../src/view/types.ts";

const MIN = 60_000;
const HOUR = 60 * MIN;
const NOW = Date.UTC(2026, 8, 15, 13, 0);
const HASH = `3f9a${"0".repeat(56)}c21e`;
const CHANGED = `8b02${"1".repeat(56)}77d1`;

const file = (o: Partial<SettingsFile> = {}): SettingsFile => ({
  file: "~/.claude/settings.json",
  statusLine: "tokeniser",
  disableAllHooks: null,
  allowManagedHooksOnly: null,
  ...o,
});
const plainFile = (name: string, o: Partial<SettingsFile> = {}): SettingsFile => file({ file: name, statusLine: "none", ...o });

interface Options {
  latest?: Partial<LatestEvent>;
  lastResets?: Partial<DataFacts["lastResets"]>;
  invalid?: DataFacts["invalid"];
  problems?: ProblemCount[];
  collector?: Partial<CollectorFacts>;
  settings?: Partial<SettingsFacts>;
  inWindowProject?: boolean | null;
}

function facts(o: Options = {}): HealthFacts {
  return {
    checkedAt: NOW,
    data: {
      ok: true,
      value: {
        latest: {
          at: NOW - MIN,
          sessionId: "344a3a30-80ce-4d76",
          projectLabel: "Lullow/tokeniser",
          version: "2.1.270",
          responded: true,
          fiveHour: true,
          week: true,
          context: true,
          ...o.latest,
        },
        lastResets: { fiveHour: NOW + 2 * HOUR, week: NOW + 72 * HOUR, ...o.lastResets },
        invalid: o.invalid ?? { events: 0, fields: [] },
      },
    },
    inWindowProject: o.inWindowProject === undefined ? true : o.inWindowProject,
    problems: { ok: true, value: o.problems ?? [] },
    collector: { ok: true, value: { connectedAt: NOW - 14 * HOUR, expectedSha256: HASH, actualSha256: HASH, ...o.collector } },
    directories: { ok: true, value: null },
    settings: { ok: true, value: { managed: [], user: file(), folders: [{ name: "tokeniser", local: null, project: null }], unreadable: [], ...o.settings } },
  };
}

function check(f: HealthFacts, id: string): HealthCheck {
  const found = buildHealth(f, NOW).checks.find((c) => c.id === id);
  assert.ok(found, id);
  return found;
}

test("allt i ordning: sju kontroller i fast ordning, och varje läge står i ord", () => {
  const health = buildHealth(facts(), NOW);
  assert.equal(health.level, "ok");
  assert.equal(health.title, "Allt i ordning");
  assert.match(health.summary, /^5 kontroller i ordning · kontrollerat kl\.\s\d{2}:\d{2}$/u);
  assert.deepEqual(
    health.checks.map((c) => [c.id, c.mark, c.state]),
    [
      ["latest", "ok", "I ordning"],
      ["fields", "ok", "I ordning"],
      ["collector", "ok", "I ordning"],
      ["directories", "ok", "I ordning"],
      ["statusline", "ok", "I ordning"],
      ["node", "unchecked", "Kontrolleras inte"],
      ["out-of-reach", "unknown", "Kan inte kontrolleras"],
    ],
  );
  assert.match(health.checks[0]?.detail ?? "", /^kl\.\s\d{2}:\d{2}, för 1 min sedan · session `344a3a30` · Lullow\/tokeniser · Claude Code 2\.1\.270\.$/u);
  assert.equal(health.checks[1]?.detail, "Alla fält finns i senaste svaret. Inga avvisade körningar senaste dygnet.");
  assert.match(health.checks[6]?.detail ?? "", /`~\/\.claude\.json`, som också innehåller din inloggning/);
  assert.deepEqual(JSON.parse(JSON.stringify(health)), health);

  assert.match(check(facts({ inWindowProject: false }), "latest").detail, /Ingen session från fönstrets mappar\.$/);
  assert.match(check(facts({ latest: { projectLabel: "a`b`c" } }), "latest").detail, / · a'b'c · /);
});

test("ett fält som saknas av en dokumenterad orsak räknas som i ordning", () => {
  const before = check(facts({ latest: { responded: false, fiveHour: false, week: false, context: false } }), "fields");
  assert.equal(before.mark, "ok");
  assert.match(before.detail, /^`rate_limits\.five_hour`, `rate_limits\.seven_day` och kontextens användning saknas: sessionen har inte fått något svar än\./);

  const reset = check(facts({ latest: { fiveHour: false }, lastResets: { fiveHour: NOW - 30 * MIN } }), "fields");
  assert.equal(reset.mark, "ok");
  assert.match(reset.detail, /^`rate_limits\.five_hour` saknas: fönstret återställdes kl\.\s\d{2}:\d{2}, och fältet kommer tillbaka vid nästa svar\./u);

  const neverSeen = check(facts({ latest: { fiveHour: false, week: false }, lastResets: { fiveHour: null, week: null } }), "fields");
  assert.equal(neverSeen.mark, "ok");
  assert.match(neverSeen.detail, /Gränserna finns bara för Pro och Max\./);
});

test("en gräns som saknas fast fönstret inte har återställts är en varning (R1)", () => {
  const health = buildHealth(facts({ latest: { week: false } }), NOW);
  assert.equal(health.level, "warning");
  assert.equal(health.title, "Veckogränsen saknas i Claude Codes data");
  assert.match(health.summary, /^1 varning · kontrollerat /);
  const fields = health.checks[1];
  assert.equal(fields?.mark, "warning");
  assert.match(fields?.detail ?? "", /^`rate_limits\.seven_day` saknas fast fönstret inte återställs förrän .+ Claude Code kan ha ändrat formatet\./u);
  assert.match(fields?.action ?? "", /`\/usage`/);

  assert.equal(check(facts({ latest: { context: false } }), "fields").mark, "warning");
});

test("avvisade körningar och ogiltiga fält senaste dygnet är varningar", () => {
  const f = facts({
    problems: [{ kind: "not_json", count: 2, lastAt: NOW - 5 * MIN }],
    invalid: { events: 1, fields: ["rate_limits.seven_day.used_percentage"] },
  });
  const health = buildHealth(f, NOW);
  assert.equal(health.title, "Fält i Claude Codes data klarar inte valideringen");
  const fields = health.checks[1];
  assert.equal(fields?.mark, "warning");
  assert.match(fields?.detail ?? "", /1 händelse senaste dygnet hade fält som inte klarade valideringen: `rate_limits\.seven_day\.used_percentage`\./);
  assert.match(fields?.detail ?? "", /2 körningar avvisades senaste dygnet \(ogiltig JSON: 2\), senast kl\.\s\d{2}:\d{2}\./u);
  assert.equal(fields?.action, null);
});

test("en ändrad insamlare ger en varning med kopierbart kommando och säger att kontrollen inte skyddar", () => {
  const health = buildHealth(facts({ collector: { actualSha256: CHANGED } }), NOW);
  assert.equal(health.level, "warning");
  assert.equal(health.title, "Insamlaren har ändrats sedan anslutningen");
  const collector = health.checks[2];
  assert.match(collector?.detail ?? "", /väntad `3f9a…c21e`, nu `8b02…77d1`\. Kontrollen upptäcker ändringen men kan inte hindra den\.$/);
  assert.match(collector?.action ?? "", /något annat har ändrat filen/);
  assert.equal(collector?.command, DISCONNECT_COMMAND);
  assert.equal(check(facts(), "collector").command, null);
});

test("ett projekts statusLine går före användarfilen, och en lokal fil går före projektets", () => {
  const taken = buildHealth(
    facts({ settings: { folders: [{ name: "tokeniser", local: null, project: file({ file: "tokeniser/.claude/settings.json", statusLine: "other" }) }] } }),
    NOW,
  );
  assert.equal(taken.title, "Projektet tokeniser har en egen statusrad");
  const statusLine = taken.checks[4];
  assert.match(statusLine?.detail ?? "", /^`tokeniser\/\.claude\/settings\.json` sätter en egen `statusLine`\. Den går före din användarfil/);
  assert.equal(statusLine?.action, "Ta bort `statusLine` ur filen om projektet ska mätas.");

  const localWins = facts({
    settings: {
      folders: [
        {
          name: "tokeniser",
          local: file({ file: "tokeniser/.claude/settings.local.json" }),
          project: file({ file: "tokeniser/.claude/settings.json", statusLine: "other" }),
        },
      ],
    },
  });
  assert.equal(check(localWins, "statusline").mark, "ok");
});

test("disableAllHooks följer inställningarnas ordning", () => {
  assert.equal(buildHealth(facts({ settings: { user: file({ disableAllHooks: true }) } }), NOW).title, "Statusraden är avstängd");

  const localOn = facts({
    settings: {
      user: file({ disableAllHooks: true }),
      folders: [{ name: "tokeniser", local: plainFile("tokeniser/.claude/settings.local.json", { disableAllHooks: false }), project: null }],
    },
  });
  assert.equal(check(localOn, "statusline").mark, "ok");

  const projectOff = facts({
    settings: { folders: [{ name: "tokeniser", local: null, project: plainFile("tokeniser/.claude/settings.json", { disableAllHooks: true }) }] },
  });
  assert.equal(buildHealth(projectOff, NOW).title, "Statusraden är avstängd i tokeniser");
});

test("organisationens inställningar och en statusrad som inte är ansluten ger varning", () => {
  const managedFile = "/etc/claude-code/managed-settings.json";
  const titleFor = (settings: Partial<SettingsFacts>): string => buildHealth(facts({ settings }), NOW).title;
  assert.equal(titleFor({ managed: [plainFile(managedFile, { statusLine: "other" })] }), "Organisationens inställningar har en egen statusrad");
  assert.equal(titleFor({ managed: [plainFile(managedFile, { allowManagedHooksOnly: true })] }), "Organisationens inställningar stänger av statusraden");
  assert.equal(titleFor({ managed: [plainFile(managedFile, { disableAllHooks: true })] }), "Organisationens inställningar stänger av statusraden");
  assert.equal(titleFor({ managed: [plainFile(managedFile)] }), "Allt i ordning");
  assert.equal(titleFor({ user: plainFile("~/.claude/settings.json") }), "Statusraden är inte ansluten");
  assert.equal(titleFor({ user: file({ statusLine: "other" }) }), "En annan statusrad har ersatt Tokenisers");
});

test("det som inte går att läsa visas aldrig som i ordning", () => {
  const f = facts();
  f.data = { ok: false, error: "databasen är låst" };
  f.problems = { ok: false, error: "nekad" };
  f.settings = { ok: false, error: "kommandot från anslutningen är okänt." };
  f.collector = { ok: false, error: "connection.json saknas." };
  f.directories = { ok: false, error: "/home/user/.tokeniser/state har rättigheterna 0755 i stället för 0700." };
  const health = buildHealth(f, NOW);
  assert.deepEqual(
    health.checks.map((c) => c.mark),
    ["unknown", "unknown", "warning", "warning", "unknown", "unchecked", "unknown"],
  );
  assert.equal(health.checks[2]?.command, DISCONNECT_COMMAND);
  assert.match(health.summary, /^2 varningar · /);

  const unreadable = check(facts({ settings: { unreadable: [{ file: "länkad/.claude/settings.json", error: "är en symbolisk länk" }] } }), "statusline");
  assert.equal(unreadable.mark, "unknown");
  assert.equal(unreadable.detail, "`länkad/.claude/settings.json` är en symbolisk länk.");
});
