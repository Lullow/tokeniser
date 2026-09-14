import assert from "node:assert/strict";
import { test } from "node:test";
import { openIndex } from "../../src/index/db.ts";
import { ingest } from "../../src/index/ingest.ts";
import type { Snapshot } from "../../src/status/model.ts";
import { folderMatches, readSnapshot } from "../../src/status/snapshot.ts";
import { appendEvents, eventLine, makeStore } from "../helpers/events.ts";

const T0 = 1_789_391_280_000;
const MIN = 60_000;

function snapshotFor(lines: string[], folders: string[], now: number): Snapshot {
  const home = makeStore();
  if (lines.length > 0) appendEvents(home, "2026-09", lines);
  const db = openIndex(home);
  try {
    ingest(db, home);
    return readSnapshot(db, folders, now);
  } finally {
    db.close();
  }
}

const twoProjects = [
  eventLine({ at: T0, session: "mine", dir: "/p/alpha", context: 21 }),
  eventLine({ at: T0 + MIN, session: "other", dir: "/p/beta", context: 60, five: 12, week: 7 }),
];

test("gränserna kommer från senaste mätningen i vilken session som helst", () => {
  const s = snapshotFor(twoProjects, ["/p/alpha"], T0 + 2 * MIN);
  assert.deepEqual(s.fiveHour.latest, { used: 12, resetsAt: 1_789_428_600_000, measuredAt: T0 + MIN });
  assert.equal(s.week.latest?.used, 7);
  assert.equal(s.hasEvents, true);
});

test("prognospunkter tas bara från samma gränsfönster", () => {
  const s = snapshotFor(
    [
      eventLine({ at: T0, five: 90, fiveResets: 1_789_400_000 }),
      eventLine({ at: T0 + MIN, five: 10 }),
      eventLine({ at: T0 + 2 * MIN, five: 11 }),
    ],
    [],
    T0 + 3 * MIN,
  );
  assert.deepEqual(s.fiveHour.points, [
    { at: T0 + MIN, used: 10 },
    { at: T0 + 2 * MIN, used: 11 },
  ]);
});

test("kontext och modell kommer från fönstrets projekt även när en annan session är nyare", () => {
  const s = snapshotFor(twoProjects, ["/p/alpha"], T0 + 2 * MIN);
  assert.equal(s.session?.label, "alpha");
  assert.equal(s.session?.inWindowProject, true);
  assert.deepEqual(s.session?.context, { usedPct: 21, size: 1_000_000, tokens: 200_000, measuredAt: T0 });
  assert.equal(s.session?.modelId, "claude-opus-5");
  assert.equal(s.session?.effort, "xhigh");
  assert.equal(s.otherActiveSessions, 1);
});

test("utan matchande projekt används den senaste sessionen totalt", () => {
  const s = snapshotFor(twoProjects, ["/p/gamma/"], T0 + 2 * MIN);
  assert.equal(s.session?.label, "beta");
  assert.equal(s.session?.inWindowProject, false);
  assert.equal(s.session?.context.usedPct, 60);
});

test("bara sessioner från de senaste 15 minuterna räknas som aktiva", () => {
  const s = snapshotFor(
    [eventLine({ at: T0, session: "old", dir: "/p/beta" }), eventLine({ at: T0 + 30 * MIN, session: "mine", dir: "/p/alpha" })],
    ["/p/alpha"],
    T0 + 31 * MIN,
  );
  assert.equal(s.otherActiveSessions, 0);
});

test("en överordnad mapp räknas bara när den är ett repo", () => {
  assert.equal(folderMatches("/p/alpha", "dir", "/p/alpha/"), true);
  assert.equal(folderMatches("/p/alpha/pkg", "dir", "/p/alpha"), true);
  assert.equal(folderMatches("/home/user", "dir", "/home/user/projects/x"), false);
  assert.equal(folderMatches("/p/mono", "repo", "/p/mono/packages/app"), true);
  assert.equal(folderMatches("/p/alphabet", "dir", "/p/alpha"), false);

  const s = snapshotFor(
    [
      eventLine({ at: T0, session: "repo", dir: "/p/mono", repo: { host: "github.com", owner: "example", name: "mono" } }),
      eventLine({ at: T0 + MIN, session: "home", dir: "/home/user" }),
    ],
    ["/p/mono/packages/app"],
    T0 + 2 * MIN,
  );
  assert.equal(s.session?.label, "example/mono");
  assert.equal(s.session?.inWindowProject, true);
});

test("ett tomt index ger inga mätningar och ingen session", () => {
  const s = snapshotFor([], ["/p/alpha"], T0);
  assert.equal(s.hasEvents, false);
  assert.equal(s.session, null);
  assert.equal(s.fiveHour.latest, null);
  assert.equal(s.week.latest, null);
});
