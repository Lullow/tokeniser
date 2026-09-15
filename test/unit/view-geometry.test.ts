import assert from "node:assert/strict";
import { test } from "node:test";
import { axisTokens, CURVE_HEIGHT, curveGeometry, niceMax, ringDash, shortTokens } from "../../src/view/geometry.ts";

/** Labels keep the number and its unit together with a hard space. */
const nb = (text: string): string => text.replaceAll(" ", " ");
const DAYS = ["ons", "tor", "fre", "lör", "sön", "mån", "i dag"];

test("korta tokenbelopp", () => {
  assert.equal(shortTokens(0), "0");
  assert.equal(shortTokens(850), "850");
  assert.equal(shortTokens(214_800), nb("215 k"));
  assert.equal(shortTokens(12_700_000), nb("12,7 M"));
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
    ["0", nb("25 M"), nb("50 M")],
  );
  assert.equal(geometry.labels.at(-1)?.text, "i dag");

  const empty = curveGeometry([], []);
  assert.deepEqual([empty.line, empty.today, empty.area], ["", "", ""]);
});

test("axelns etiketter har inga onödiga decimaler", () => {
  assert.deepEqual(
    [0, 5, 500, 2_500, 500_000, 2_500_000, 50_000_000, 100_000_000].map(axisTokens),
    ["0", "5", "500", nb("2,5 k"), nb("500 k"), nb("2,5 M"), nb("50 M"), nb("100 M")],
  );
});

test("axelns etiketter får plats, och texten växer inte med kolumnens bredd", () => {
  const values = [0, 0, 0, 0, 0, 30e6, 56.3e6];
  const narrow = curveGeometry(values, DAYS, 340);
  const wide = curveGeometry(values, DAYS, 700);
  assert.deepEqual(
    wide.gridlines.map((line) => line.label),
    ["0", nb("50 M"), nb("100 M")],
  );
  for (const geometry of [narrow, wide]) {
    const longest = Math.max(...geometry.gridlines.map((line) => line.label.length));
    assert.ok(geometry.axisX - longest * 6.5 >= 0, "y-axelns längsta etikett börjar innanför ytan");
    assert.ok(geometry.axisX < geometry.plotLeft, "etiketterna slutar före kurvan");
    assert.ok(geometry.plotRight + ("i dag".length * 6.5) / 2 <= geometry.width, "sista dagen får plats");
    assert.equal(geometry.height, CURVE_HEIGHT);
  }
  assert.equal(narrow.width, 340);
  assert.equal(wide.width, 700);
  assert.equal(narrow.plotLeft, wide.plotLeft, "vänstermarginalen beror på etiketterna, inte på bredden");
  assert.equal(curveGeometry(values, DAYS, 40).width, 160);
});

test("ringens streck motsvarar förbrukad andel", () => {
  const quarter = ringDash(25, 36);
  assert.ok(Math.abs(quarter.offset - quarter.circumference * 0.75) < 1e-9);
  assert.equal(ringDash(150, 36).offset, 0);
});
