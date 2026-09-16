import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { openIndex } from "../../src/index/db.ts";
import { ingest } from "../../src/index/ingest.ts";
import { dayStarts, readViewData, type ViewData } from "../../src/view/data.ts";
import { appendEvents, eventLine, makeStore, type EventOptions } from "../helpers/events.ts";

const at = (day: number, hour: number, minute = 0): number => new Date(2026, 8, day, hour, minute).getTime();
const NOW = at(15, 12);
const MINUTE = 60_000;
const usage = (input: number) => ({ input, output: 0, cacheCreation: 0, cacheRead: 0 });

function dataFor(events: EventOptions[], sessionId: string | null): ViewData {
  const home = makeStore();
  if (events.length > 0) appendEvents(home, "2026-09", events.map((event) => eventLine(event)));
  const db = openIndex(home);
  try {
    ingest(db, home);
    return readViewData(db, sessionId, NOW);
  } finally {
    db.close();
  }
}

test("tokens per dag räknar varje anrop en gång och bara de senaste 7 dagarna", () => {
  const data = dataFor(
    [
      { at: at(7, 10), session: "a", usage: usage(999) },
      { at: at(14, 10), session: "a", usage: usage(100) },
      { at: at(15, 9, 0), session: "a", usage: usage(200) },
      { at: at(15, 9, 1), session: "a", usage: usage(200), five: 30 },
      { at: at(15, 9, 2), session: "a", usage: usage(300) },
    ],
    null,
  );
  assert.deepEqual(
    data.days.map((day) => day.start),
    dayStarts(NOW),
  );
  assert.deepEqual(
    data.days.map((day) => day.tokens),
    [0, 0, 0, 0, 0, 100, 500],
  );
});

test("ett anrop som syns både när svaret börjar och när det är klart räknas en gång, med högsta output", () => {
  const call = (output: number, cacheRead: number) => ({ input: 2, output, cacheCreation: 600, cacheRead });
  const data = dataFor(
    [
      { at: at(14, 23, 59), session: "a", usage: call(3, 135_000) },
      { at: at(15, 0, 0), session: "b", usage: usage(50) },
      { at: at(15, 0, 1), session: "a", usage: call(328, 135_000) },
      { at: at(15, 9, 0), session: "a", usage: call(328, 136_000) },
      { at: at(15, 9, 1), session: "a", usage: call(5, 136_000), five: 30 },
    ],
    "a",
  );
  assert.deepEqual(data.sessionTotals, { input: 4, output: 656, cacheCreation: 1_200, cacheRead: 271_000, calls: 2 });
  assert.deepEqual(
    data.days.slice(-2).map((day) => day.tokens),
    [2 + 328 + 600 + 135_000, 50 + 2 + 328 + 600 + 136_000],
  );
});

test("inspelad riktig data: tio anrop i stället för sexton", () => {
  const text = readFileSync(new URL("../fixtures/events/real-2026-09.jsonl", import.meta.url), "utf8");
  const home = makeStore();
  appendEvents(home, "2026-09", text);
  const db = openIndex(home);
  try {
    ingest(db, home);
    const data = readViewData(db, "00000000-0000-4000-8000-000000000001", 1_789_421_829_093 + MINUTE);
    assert.deepEqual(data.sessionTotals, { input: 202, output: 16_385, cacheCreation: 17_866, cacheRead: 3_773_579, calls: 10 });
  } finally {
    db.close();
  }
});

test("dagens projekt har sessioner, aktiv tid utan pauser och tokens", () => {
  const data = dataFor(
    [
      { at: at(15, 9, 0), session: "a", dir: "/p/alpha", usage: usage(1_000) },
      { at: at(15, 9, 5), session: "a", dir: "/p/alpha", usage: usage(2_000) },
      { at: at(15, 9, 30), session: "a", dir: "/p/alpha", usage: usage(3_000) },
      { at: at(15, 9, 34), session: "a", dir: "/p/alpha", usage: usage(4_000) },
      { at: at(15, 10, 0), session: "b", dir: "/p/alpha", usage: usage(500) },
      { at: at(15, 11, 0), session: "c", dir: "/p/beta", usage: usage(100) },
      { at: at(15, 11, 2), session: "c", dir: "/p/beta", usage: usage(200) },
      { at: at(14, 23, 0), session: "d", dir: "/p/gamma", usage: usage(9_000) },
    ],
    null,
  );
  assert.deepEqual(data.projectsToday, [
    { label: "alpha", kind: "dir", sessions: 2, activeMs: 9 * MINUTE, tokens: 10_500 },
    { label: "beta", kind: "dir", sessions: 1, activeMs: 2 * MINUTE, tokens: 300 },
  ]);
});

test("sessionens summa räknar varje anrop en gång, och senaste cachemiss läses", () => {
  const missAt = Math.floor(at(15, 9, 2) / 1000);
  const data = dataFor(
    [
      { at: at(15, 9, 0), session: "a", usage: { input: 10, output: 20, cacheCreation: 30, cacheRead: 40 } },
      { at: at(15, 9, 1), session: "a", usage: { input: 10, output: 20, cacheCreation: 30, cacheRead: 40 }, five: 40 },
      { at: at(15, 9, 2), session: "a", usage: { input: 1, output: 2, cacheCreation: 3, cacheRead: 4 }, missCauses: ["ttl_expired_5m"], missAt },
      { at: at(15, 9, 3), session: "b", usage: usage(5) },
    ],
    "a",
  );
  assert.deepEqual(data.sessionTotals, { input: 11, output: 22, cacheCreation: 33, cacheRead: 44, calls: 2 });
  assert.deepEqual(data.cacheMiss, { causes: ["ttl_expired_5m"], at: missAt * 1000 });
  assert.equal(dataFor([{ at: at(15, 9, 0), session: "a" }], "a").cacheMiss, null);
  assert.equal(dataFor([], null).sessionTotals, null);
});
