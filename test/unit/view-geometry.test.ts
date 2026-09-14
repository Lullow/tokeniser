import assert from "node:assert/strict";
import { test } from "node:test";
import { curveGeometry, niceMax, ringDash, shortTokens } from "../../src/view/geometry.ts";

test("korta tokenbelopp", () => {
  assert.equal(shortTokens(0), "0");
  assert.equal(shortTokens(850), "850");
  assert.equal(shortTokens(214_800), "215 k");
  assert.equal(shortTokens(12_700_000), "12,7 M");
});

test("jämn skala uppåt", () => {
  assert.equal(niceMax(0), 1);
  assert.equal(niceMax(7), 10);
  assert.equal(niceMax(20), 20);
  assert.equal(niceMax(31.5), 50);
  assert.equal(niceMax(12_700_000), 20_000_000);
});

test("kurvan håller sig inom ytan och ritar i dag för sig", () => {
  const geometry = curveGeometry(
    [18.4e6, 26.1e6, 9.8e6, 31.5e6, 22e6, 4.2e6, 12.7e6],
    ["tis", "ons", "tor", "fre", "lör", "sön", "i dag"],
  );
  assert.equal(geometry.points.length, 7);
  for (const point of geometry.points) {
    assert.ok(point.x >= geometry.plotLeft && point.x <= geometry.plotRight, `x ${point.x}`);
    assert.ok(point.y >= 8 && point.y <= geometry.height - 20, `y ${point.y}`);
  }
  assert.equal(geometry.line.split("L").length, 6);
  assert.equal(geometry.today.split("L").length, 2);
  assert.deepEqual(
    geometry.gridlines.map((line) => line.label),
    ["0", "25,0 M", "50,0 M"],
  );
  assert.equal(geometry.labels.at(-1)?.text, "i dag");

  const empty = curveGeometry([], []);
  assert.deepEqual([empty.line, empty.today, empty.area], ["", "", ""]);
});

test("ringens streck motsvarar förbrukad andel", () => {
  const quarter = ringDash(25, 36);
  assert.ok(Math.abs(quarter.offset - quarter.circumference * 0.75) < 1e-9);
  assert.equal(ringDash(150, 36).offset, 0);
});
