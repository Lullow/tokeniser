import assert from "node:assert/strict";
import { test } from "node:test";
import { clockTime, duration, moment, percent, tokenCount } from "../../src/status/format.ts";

const MIN = 60_000;

test("procent och tokens skrivs med hårt mellanslag", () => {
  assert.equal(percent(63.6), "64 %");
  assert.match(tokenCount(214_800), /^214\s800$/u);
});

test("tidsrymder avrundas nedåt till läsbara enheter", () => {
  assert.equal(duration(30_000), "under 1 min");
  assert.equal(duration(-5), "under 1 min");
  assert.equal(duration(40 * MIN), "40 min");
  assert.equal(duration(112 * MIN), "1 h 52 min");
  assert.equal(duration(120 * MIN), "2 h");
  assert.equal(duration((2 * 24 + 18) * 60 * MIN + 59 * MIN), "2 d 18 h");
  assert.equal(duration(48 * 60 * MIN), "2 d");
});

test("klockslag samma dag, annars med veckodag och datum", () => {
  const now = new Date(2026, 8, 14, 15, 8).getTime();
  assert.equal(moment(new Date(2026, 8, 14, 17, 0).getTime(), now), "kl. 17:00");
  assert.equal(moment(new Date(2026, 8, 17, 1, 0).getTime(), now), "tor 17 sep kl. 01:00");
  assert.equal(clockTime(new Date(2026, 8, 14, 9, 5).getTime()), "09:05");
});
