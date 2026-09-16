import assert from "node:assert/strict";
import { test } from "node:test";
import type { DatabaseSync } from "node:sqlite";
import { nextDayStart, summarizeDay, type DaySummary } from "../../src/history/summary.ts";
import { openIndex } from "../../src/index/db.ts";
import { ingest } from "../../src/index/ingest.ts";
import { tokensOf } from "../../src/index/usage.ts";
import { dayStarts, readViewData } from "../../src/view/data.ts";
import { appendEvents, eventLine, makeStore, type EventOptions } from "../helpers/events.ts";

const at = (day: number, hour: number, minute = 0, second = 0): number => new Date(2026, 8, day, hour, minute, second).getTime();
const dayOf = (day: number): [number, number] => [at(day, 0), nextDayStart(at(day, 0))];
const MINUTE = 60_000;
const BETA = { host: "github.com", owner: "Example", name: "beta" };

function withEvents<T>(events: EventOptions[], fn: (db: DatabaseSync) => T): T {
  const home = makeStore();
  appendEvents(home, "2026-09", events.map((event) => eventLine(event)));
  const db = openIndex(home);
  try {
    ingest(db, home);
    return fn(db);
  } finally {
    db.close();
  }
}

const summary = (events: EventOptions[], day: number): DaySummary | null => withEvents(events, (db) => summarizeDay(db, ...dayOf(day)));

test("en dag summeras per projekt och modell, med sessioner och aktiv tid per projekt", () => {
  const alpha = { session: "a", dir: "/p/alpha" };
  const beta = { session: "b", repo: BETA, model: "claude-opus-5" };
  const result = summary(
    [
      { ...alpha, at: at(15, 9, 0, 0), usage: { input: 2, output: 3, cacheCreation: 100, cacheRead: 1_000 }, cost: 1, five: 30, week: 10 },
      { ...alpha, at: at(15, 9, 0, 5), usage: { input: 2, output: 300, cacheCreation: 100, cacheRead: 1_000 }, cost: 1.5 },
      { ...alpha, at: at(15, 9, 5), model: "claude-sonnet-5", usage: { input: 2, output: 50, cacheCreation: 10, cacheRead: 1_100 }, cost: 1.7 },
      { ...beta, at: at(15, 10, 0), usage: { input: 1, output: 10, cacheCreation: 0, cacheRead: 500 }, cost: 0 },
      { ...beta, at: at(15, 10, 20), usage: { input: 1, output: 20, cacheCreation: 0, cacheRead: 510 }, cost: 0.4, five: 35, week: 12 },
    ],
    15,
  );
  assert.deepEqual(result, {
    v: 1,
    date: "2026-09-15",
    start: at(15, 0),
    end: dayOf(15)[1],
    events: 5,
    fiveHourPeak: 35,
    weekPeak: 12,
    projects: [
      {
        key: "dir:/p/alpha",
        kind: "dir",
        label: "alpha",
        sessions: 1,
        activeMs: 5 * MINUTE,
        models: [
          { model: "claude-opus-5", calls: 1, input: 2, output: 300, cacheCreation: 100, cacheRead: 1_000, costUsd: 0.5 },
          { model: "claude-sonnet-5", calls: 1, input: 2, output: 50, cacheCreation: 10, cacheRead: 1_100, costUsd: 0.2 },
        ],
      },
      {
        key: "repo:github.com/example/beta",
        kind: "repo",
        label: "Example/beta",
        sessions: 1,
        activeMs: 0,
        models: [{ model: "claude-opus-5", calls: 2, input: 2, output: 30, cacheCreation: 0, cacheRead: 1_010, costUsd: 0.4 }],
      },
    ],
  });
});

test("ett anrop över midnatt hör till dagen det började, och kostnaden till dagen den växte", () => {
  const events: EventOptions[] = [
    { at: at(14, 23, 59, 58), session: "s", usage: { input: 2, output: 3, cacheCreation: 100, cacheRead: 1_000 }, cost: 2 },
    { at: at(15, 0, 0, 3), session: "s", usage: { input: 2, output: 400, cacheCreation: 100, cacheRead: 1_000 }, cost: 2.6 },
    { at: at(15, 8, 0), session: "s", usage: { input: 2, output: 10, cacheCreation: 50, cacheRead: 1_500 }, cost: 2.8 },
  ];
  withEvents(events, (db) => {
    const models = (day: number) => summarizeDay(db, ...dayOf(day))?.projects[0]?.models;
    assert.deepEqual(models(14), [{ model: "claude-opus-5", calls: 1, input: 2, output: 400, cacheCreation: 100, cacheRead: 1_000, costUsd: 0 }]);
    assert.deepEqual(models(15), [{ model: "claude-opus-5", calls: 1, input: 2, output: 10, cacheCreation: 50, cacheRead: 1_500, costUsd: 0.8 }]);
  });
});

test("kostnad räknas från sessionens första värde, börjar om när den sjunker och saknas utan värden", () => {
  const resumed = summary(
    [
      { at: at(15, 9, 0), session: "s", cost: 15.85 },
      { at: at(15, 9, 1), session: "s", cost: 16 },
      { at: at(15, 9, 2), session: "s", cost: 0.1 },
      { at: at(15, 9, 3), session: "s", cost: 0.3 },
    ],
    15,
  );
  assert.equal(resumed?.projects[0]?.models[0]?.costUsd, 0.35);

  const withoutCost = summary([{ at: at(15, 9, 0), session: "s", cost: null }], 15);
  assert.equal(withoutCost?.projects[0]?.models[0]?.costUsd, null);
});

test("händelser utan projekt hamnar sist, och en dag utan händelser ger ingen summering", () => {
  const result = summary(
    [
      { at: at(15, 9, 0), session: "a", dir: null },
      { at: at(15, 9, 1), session: "b", dir: "/p/alpha" },
    ],
    15,
  );
  assert.deepEqual(
    result?.projects.map((p) => [p.key, p.kind, p.label]),
    [
      ["dir:/p/alpha", "dir", "alpha"],
      [null, null, null],
    ],
  );
  assert.equal(summary([{ at: at(15, 9, 0) }], 14), null);
});

test("summeringarna ger samma tokens per dag som kurvan i vyn", () => {
  const events: EventOptions[] = [];
  for (let day = 10; day <= 15; day++) {
    for (let i = 0; i < 4; i++) {
      const usage = { input: day, output: 3, cacheCreation: 10 * i, cacheRead: 1_000 * day + i };
      events.push({ at: at(day, 23, 50 + i * 3), session: `s${i % 2}`, usage });
      events.push({ at: at(day, 23, 51 + i * 3), session: `s${i % 2}`, usage: { ...usage, output: 90 + i } });
    }
  }
  withEvents(events, (db) => {
    const now = at(16, 12);
    const curve = readViewData(db, null, now).days.map((day) => day.tokens);
    const summed = dayStarts(now).map((start) => {
      const day = summarizeDay(db, start, nextDayStart(start));
      return (day?.projects ?? []).flatMap((p) => p.models).reduce((sum, m) => sum + tokensOf({ ...m, sessionId: "", at: 0 }), 0);
    });
    assert.deepEqual(summed, curve);
    assert.ok(curve.some((tokens) => tokens > 0));
  });
});
