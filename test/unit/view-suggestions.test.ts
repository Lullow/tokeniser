import assert from "node:assert/strict";
import { test } from "node:test";
import type { ContextState } from "../../src/status/model.ts";
import { buildSuggestions, cacheMissSuggestion, contextSuggestion, COPYABLE_COMMANDS, RECENT_MISS_MS } from "../../src/view/suggestions.ts";
import { MIN, NOW } from "../helpers/status.ts";

const SETTINGS = { contextPercent: 60, contextTokens: 200_000 };
const FIVE_PARTS = ["observed", "why", "action", "effect", "certainty"] as const;

function context(usedPct: number, tokens: number | null, size = 1_000_000, ageMinutes = 1): ContextState {
  const measuredAt = NOW - ageMinutes * MIN;
  return ageMinutes > 5
    ? { kind: "stale", usedPct, tokens, size, measuredAt, age: ageMinutes * MIN }
    : { kind: "current", usedPct, tokens, size, measuredAt };
}

test("inget förslag under båda trösklarna eller utan mätning", () => {
  assert.equal(contextSuggestion(context(19, 190_000), SETTINGS), null);
  assert.equal(contextSuggestion({ kind: "missing", reason: "saknas" }, SETTINGS), null);
});

test("stor kontext: antalet tokens kommer först med ett stort fönster", () => {
  const s = contextSuggestion(context(21, 214_800), SETTINGS);
  assert.ok(s);
  assert.match(s.title, /^Kontexten har passerat 200\s000 tokens$/u);
  for (const part of FIVE_PARTS) assert.ok(s[part].length > 0, part);
  assert.match(s.observed, /^Sessionen använder 214\s800 tokens, 21\s% av fönstret\./u);
  assert.match(s.effect, /^\/clear frigör 214\s800 tokens\. Effekten av \/compact är okänd\.$/u);
  assert.equal(s.certainty, "Säker: bygger på uppmätt kontext.");
  assert.deepEqual(s.commands, ["/compact", "/clear"]);
  assert.equal(s.estimated, false);
});

test("stor kontext: andelen kommer först med ett litet fönster, och trösklarna går att ändra", () => {
  assert.match(contextSuggestion(context(65, 130_000, 200_000), SETTINGS)?.title ?? "", /^Kontexten har passerat 60\s% av fönstret$/u);
  assert.equal(contextSuggestion(context(21, 214_800), { contextPercent: 60, contextTokens: 300_000 }), null);
  assert.ok(contextSuggestion(context(21, 214_800), { contextPercent: 20, contextTokens: 300_000 }));
});

test("gammal kontext syns i säkerheten", () => {
  assert.equal(contextSuggestion(context(21, 214_800, 1_000_000, 40), SETTINGS)?.certainty, "Säker, men kontexten mättes för 40 min sedan.");
});

test("cachemiss efter en paus föreslår /clear med beräknad effekt", () => {
  const s = cacheMissSuggestion({ causes: ["ttl_expired_5m"], at: NOW - 10 * MIN }, context(21, 214_800), NOW);
  assert.ok(s);
  for (const part of FIVE_PARTS) assert.ok(s[part].length > 0, part);
  assert.match(s.observed, /^Cachemiss kl\. \d{2}:\d{2}: cachen hann gå ut efter mer än 5 minuters paus\.$/);
  assert.deepEqual(s.commands, ["/clear"]);
  assert.match(s.effect, /214\s800 färre tokens/u);
  assert.equal(s.certainty, "Säker: orsaken rapporteras av Claude Code.");
});

test("cachemiss: gamla visas inte, vissa orsaker saknar kommando, och serverorsaker är uppskattade", () => {
  assert.equal(cacheMissSuggestion({ causes: ["ttl_expired_5m"], at: NOW - RECENT_MISS_MS - MIN }, context(21, 1), NOW), null);

  const tools = cacheMissSuggestion({ causes: ["tools_changed"], at: NOW - MIN }, context(21, 1), NOW);
  assert.deepEqual(tools?.commands, []);
  assert.equal(tools?.effect, "Går inte att beräkna.");

  const server = cacheMissSuggestion({ causes: ["likely_server_side"], at: NOW - MIN }, context(21, 1), NOW);
  assert.equal(server?.estimated, true);
  assert.equal(server?.action, "Inget att göra.");
  assert.match(server?.certainty ?? "", /^Uppskattad/);

  assert.match(cacheMissSuggestion({ causes: ["new_cause_name"], at: NOW - MIN }, context(21, 1), NOW)?.observed ?? "", /orsaken new cause name/);
});

test("vyn får bara kopiera /compact och /clear", () => {
  assert.deepEqual([...COPYABLE_COMMANDS], ["/compact", "/clear"]);
  const all = buildSuggestions(context(80, 800_000), { causes: ["ttl_expired_1h", "tools_changed"], at: NOW - MIN }, SETTINGS, NOW);
  assert.deepEqual(
    all.map((s) => s.id),
    ["context", "cache-miss"],
  );
  for (const suggestion of all) {
    for (const command of suggestion.commands) assert.ok(COPYABLE_COMMANDS.includes(command), command);
  }
});
