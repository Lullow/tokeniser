import assert from "node:assert/strict";
import { test } from "node:test";
import { NO_LIMIT } from "../../src/status/model.ts";
import type { ViewData } from "../../src/view/data.ts";
import { buildViewModel, type ViewSettings } from "../../src/view/model.ts";
import { MIN, NOW, reading, rising, SETTINGS, snap } from "../helpers/status.ts";

const DAY = 24 * 60 * MIN;
const VIEW_SETTINGS: ViewSettings = { status: SETTINGS, suggestions: { contextPercent: 60, contextTokens: 200_000 } };
const DATA: ViewData = {
  days: [0, 1, 2, 3, 4, 5, 6].map((i) => ({ start: NOW - (6 - i) * DAY, tokens: (i + 1) * 1_000_000 })),
  projectsToday: [
    { label: "Lullow/tokeniser", kind: "repo", sessions: 2, activeMs: 9 * MIN, tokens: 3_000_000 },
    { label: "sound-bot", kind: "dir", sessions: 1, activeMs: 30_000, tokens: 1_000 },
  ],
  sessionTotals: { input: 38_412, output: 21_905, cacheCreation: 412_330, cacheRead: 3_184_900, calls: 48 },
  cacheMiss: null,
};

const model = (s = snap(), data = DATA, settings = VIEW_SETTINGS) => buildViewModel(s, data, settings, NOW);

test("ringarna visar förbrukat, tid till återställning och tillstånd", () => {
  const [five, week] = model().limits.rings;
  assert.equal(five.center, "64 %");
  assert.equal(five.value, 64);
  assert.equal(five.pill, "Aktuell");
  assert.equal(five.level, "normal");
  assert.match(five.lines[0] ?? "", /^återställs kl\. \d{2}:\d{2}$/);
  assert.equal(five.lines[1], "om 2 h");
  assert.equal(week.center, "31 %");
  assert.equal(model(snap({ five: reading(85) })).limits.rings[0].level, "warning");
  assert.equal(model(snap({ five: reading(96) })).limits.rings[0].level, "error");
});

test("äldre, återställd och saknad data får egna tillstånd, aldrig 0 %", () => {
  const stale = model(snap({ five: reading(64, 40) })).limits.rings[0];
  assert.equal(stale.kind, "stale");
  assert.equal(stale.pill, "Äldre · 40 min");
  assert.equal(stale.value, 64);

  const reset = model(snap({ five: reading(88, 1, NOW - 1) })).limits.rings[0];
  assert.deepEqual(
    { kind: reset.kind, value: reset.value, center: reset.center, lines: reset.lines },
    { kind: "reset", value: null, center: "Återställd", lines: ["ny siffra vid nästa svar"] },
  );
  assert.doesNotMatch(JSON.stringify(reset), /\b0\s%/u);

  const missing = model(snap({ five: null })).limits.rings[0];
  assert.equal(missing.center, "Saknas");
  assert.equal(missing.note, NO_LIMIT);
});

test("prognoser är märkta uppskattning när de visas, och posten utanför VS Code väntar på data", () => {
  const { forecasts, outside } = model(snap({ fivePoints: rising(58, [16, 11, 6, 1]) })).limits;
  assert.equal(forecasts[0]?.label, "Prognos 5 h");
  assert.match(forecasts[0]?.text ?? "", /^når gränsen cirka kl\. \d{2}:\d{2}$/);
  assert.equal(forecasts[0]?.estimated, true);
  assert.deepEqual(forecasts[1], {
    label: "Prognos vecka",
    text: "döljs – den kräver minst 3 mätningar under minst 20 h.",
    estimated: false,
  });
  assert.match(outside.text, /^Går inte att särskilja än/);
});

test("kontexten har stapel med båda trösklarna", () => {
  const { context } = model().session;
  assert.equal(context.value, 21);
  assert.match(context.summary, /^214\s800 av 1\s000\s000 tokens · 21\s%$/u);
  assert.deepEqual(context.ticks, [
    { at: 20, label: "200 k" },
    { at: 60, label: "60 %" },
  ]);
  assert.equal(model(snap({ context: null })).session.context.kind, "missing");
});

test("sessionens rutor summerar mätta anrop och är märkta uppskattning", () => {
  const { session } = model();
  assert.equal(session.title, "tokeniser");
  assert.equal(session.detail, "claude-opus-5 · xhigh");
  assert.deepEqual(
    session.tiles.map((tile) => tile.value),
    [38_412, 21_905, 412_330, 3_184_900],
  );
  assert.equal(session.tilesNote, "Summa av 48 mätta anrop · uppskattning");

  const empty = model(snap(), { ...DATA, sessionTotals: null }).session;
  assert.deepEqual(
    empty.tiles.map((tile) => tile.value),
    [null, null, null, null],
  );
  assert.equal(empty.tilesNote, "Inga mätta anrop i sessionen ännu.");

  const elsewhere = snap();
  elsewhere.otherActiveSessions = 2;
  elsewhere.session!.inWindowProject = false;
  assert.equal(model(elsewhere).session.detail, "claude-opus-5 · xhigh · senaste sessionen, inte från fönstrets projekt · +2 andra aktiva sessioner");
});

test("historiken har sju dagar med i dag sist och dagens projekt", () => {
  const { history } = model();
  assert.equal(history.days.length, 7);
  assert.deepEqual(history.days[6], { label: "i dag", tokens: 7_000_000, today: true });
  assert.equal(history.total, 28_000_000);
  assert.deepEqual(history.projects[0], { label: "Lullow/tokeniser", detail: "2 sessioner · aktiv cirka 9 min", tokens: 3_000_000 });
  assert.equal(history.projects[1]?.detail, "1 session · kort aktivitet");

  const noData = model(snap(), { ...DATA, days: [] }).history;
  assert.equal(noData.days.length, 7);
  assert.equal(noData.total, 0);
});

test("förslag, senaste mätning och en modell som går att skicka till vyn", () => {
  const m = model();
  assert.deepEqual(
    m.suggestions.map((s) => s.id),
    ["context"],
  );
  assert.match(m.updated ?? "", /^Senaste mätning kl\. \d{2}:\d{2}$/);
  assert.deepEqual(JSON.parse(JSON.stringify(m)), m);
  assert.equal(model(snap({ unavailable: "Inte ansluten." })).unavailable, "Inte ansluten.");
});
