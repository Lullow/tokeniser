import assert from "node:assert/strict";
import { test } from "node:test";
import {
  contextState,
  FORECAST,
  forecast,
  limitState,
  NO_CONTEXT,
  NO_EVENTS,
  NO_LIMIT,
  statusView,
  type LimitState,
  type Point,
  type Snapshot,
  type StatusSettings,
} from "../../src/status/model.ts";
import { HEALTH_WARNING, MIN, NOW, reading, RESET, rising, SETTINGS, snap } from "../helpers/status.ts";

const HOUR = 60 * MIN;
const view = (s: Snapshot, settings: Partial<StatusSettings> = {}) => statusView(s, { ...SETTINGS, ...settings }, NOW);
const fiveHour = (s: Snapshot): LimitState => limitState(s, "fiveHour", NOW);
const predict = (state: LimitState, points: Point[]) => forecast(state, points, FORECAST.fiveHour, NOW);

test("statusraden visar förbrukat för båda gränserna", () => {
  assert.equal(view(snap()).text, "$(dashboard) 5h 64% · v 31%");
  assert.equal(view(snap()).level, null);
  assert.equal(view(snap()).accessibleLabel, "Tokeniser. 5 timmar: 64 procent förbrukat. Vecka: 31 procent förbrukat.");
});

test("en hälsovarning ger statusraden en ikon men ingen bakgrundsfärg", () => {
  const warned = statusView(snap(), SETTINGS, NOW, HEALTH_WARNING);
  assert.equal(warned.text, "$(dashboard) $(warning) 5h 64% · v 31%");
  assert.equal(warned.level, null);
  assert.equal(
    warned.accessibleLabel,
    "Tokeniser. Hälsovarning: Insamlaren har ändrats sedan anslutningen. 5 timmar: 64 procent förbrukat. Vecka: 31 procent förbrukat.",
  );
  assert.equal(statusView(snap({ five: reading(64, 40) }), { ...SETTINGS, mode: "context" }, NOW, HEALTH_WARNING).text, "$(dashboard) $(warning) ktx 21%");
  assert.equal(statusView(snap(), SETTINGS, NOW, { ...HEALTH_WARNING, level: "ok", title: "Allt i ordning" }).text, "$(dashboard) 5h 64% · v 31%");
});

test("data äldre än 5 minuter får en klocka och behåller värdet", () => {
  assert.equal(view(snap({ five: reading(64, 5) })).text, "$(dashboard) 5h 64% · v 31%");
  assert.equal(view(snap({ five: reading(64, 6) })).text, "$(dashboard) $(history) 5h 64% · v 31%");
  assert.equal(fiveHour(snap({ five: reading(64, 40) })).kind, "stale");
  assert.match(view(snap({ five: reading(64, 40) })).accessibleLabel, /mätt för 40 min sedan/);
});

test("en passerad återställning visas som ↺, aldrig 0 %", () => {
  const s = snap({ five: reading(88, 1, NOW - 1) });
  assert.deepEqual(fiveHour(s), { kind: "reset", resetsAt: NOW - 1 });
  assert.equal(view(s).text, "$(dashboard) 5h ↺ · v 31%");
  assert.equal(view(s).level, null);
});

test("saknade värden visas som streck med en konkret orsak", () => {
  assert.deepEqual(fiveHour(snap({ five: null })), { kind: "missing", reason: NO_LIMIT });
  assert.deepEqual(fiveHour(snap({ five: null, hasEvents: false })), { kind: "missing", reason: NO_EVENTS });
  const unavailable = snap({ unavailable: "Inte ansluten." });
  assert.equal(view(unavailable).text, "$(dashboard) 5h – · v –");
  assert.deepEqual(limitState(unavailable, "week", NOW), { kind: "missing", reason: "Inte ansluten." });
  assert.deepEqual(contextState(snap({ context: null }), NOW), { kind: "missing", reason: NO_CONTEXT });
});

test("alla lägen för statusraden", () => {
  const s = snap({ five: reading(40), week: reading(70) });
  assert.equal(view(s, { mode: "fiveHour" }).text, "$(dashboard) 5h 40%");
  assert.equal(view(s, { mode: "week" }).text, "$(dashboard) v 70%");
  assert.equal(view(s, { mode: "nearest" }).text, "$(dashboard) v 70%");
  assert.equal(view(snap({ five: reading(90), week: reading(70) }), { mode: "nearest" }).text, "$(dashboard) 5h 90%");
  assert.equal(view(snap({ five: reading(90, 1, NOW - 1), week: reading(70) }), { mode: "nearest" }).text, "$(dashboard) v 70%");
  assert.equal(view(s, { mode: "context" }).text, "$(dashboard) ktx 21%");
  assert.equal(view(snap({ contextAgeMinutes: 10 }), { mode: "context" }).text, "$(dashboard) $(history) ktx 21%");
  assert.equal(view(snap({ context: null }), { mode: "context" }).text, "$(dashboard) ktx –");
});

test("varningsfärg från 80 %, felfärg från 95 %, och trösklarna går att ändra", () => {
  assert.equal(view(snap({ five: reading(79) })).level, null);
  assert.equal(view(snap({ five: reading(80) })).level, "warning");
  assert.equal(view(snap({ week: reading(95) })).level, "error");
  assert.equal(view(snap({ five: reading(96, 30) })).level, "error");
  assert.equal(view(snap({ five: reading(96) }), { mode: "week" }).level, null);
  assert.equal(view(snap({ five: reading(96) }), { mode: "context" }).level, null);
  assert.equal(view(snap({ five: reading(55) }), { warningAt: 50 }).level, "warning");
});

test("prognosen räknar takten de senaste 30 minuterna och avrundar till 5 minuter", () => {
  assert.deepEqual(predict(fiveHour(snap()), rising(58, [16, 11, 6, 1])), { kind: "reaches", at: NOW + 90 * MIN });
});

test("prognosen säger att gränsen räcker när den nås först efter återställningen", () => {
  const soonReset = fiveHour(snap({ five: reading(64, 1, NOW + 60 * MIN) }));
  assert.deepEqual(predict(soonReset, rising(58, [16, 11, 6, 1])), { kind: "lasts", resetsAt: NOW + 60 * MIN });
  const flat = [16, 11, 6, 1].map((minutes) => ({ at: NOW - minutes * MIN, used: 64 }));
  assert.deepEqual(predict(fiveHour(snap()), flat), { kind: "lasts", resetsAt: RESET });
  assert.deepEqual(predict(fiveHour(snap({ five: reading(100) })), []), { kind: "reached", resetsAt: RESET });
});

test("prognosen döljs utan tillräckligt underlag och för gammal data", () => {
  const current = fiveHour(snap());
  assert.equal(predict(current, rising(60, [6, 1])).kind, "hidden");
  assert.equal(predict(current, rising(60, [9, 5, 1])).kind, "hidden");
  assert.equal(predict(current, rising(50, [45, 40, 35, 1])).kind, "hidden");
  assert.deepEqual(predict(fiveHour(snap({ five: reading(64, 40) })), rising(58, [16, 11, 6, 1])), {
    kind: "hidden",
    reason: "senaste värdet är 40 min gammalt",
  });
  assert.equal(predict(fiveHour(snap({ five: reading(88, 1, NOW - 1) })), rising(58, [16, 11, 6, 1])).kind, "hidden");
});

test("veckoprognosen räknar in tid utan användning och döljs för bara några timmars arbete", () => {
  const resetsAt = NOW + 60 * HOUR;
  const week = limitState(snap({ week: reading(5, 1, resetsAt) }), "week", NOW);
  const fewHoursOfWork = [3 * HOUR, 2.5 * HOUR, 2 * HOUR, 1.5 * HOUR, MIN].map((ago, i) => ({ at: NOW - ago, used: 1 + i }));
  assert.deepEqual(forecast(week, fewHoursOfWork, FORECAST.week, NOW), {
    kind: "hidden",
    reason: "den kräver minst 3 mätningar under minst 20 h",
  });

  const dayWithNight = [23 * HOUR, 22 * HOUR, 2 * HOUR, MIN].map((ago, i) => ({ at: NOW - ago, used: 2 + i }));
  assert.deepEqual(forecast(week, dayWithNight, FORECAST.week, NOW), { kind: "lasts", resetsAt });
});
