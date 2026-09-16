import assert from "node:assert/strict";
import { test } from "node:test";
import { deleteDialog, deleteDone, exportChoices, exportDone, exportTitle, storageSummary } from "../../src/data/text.ts";
import { fileSize, shortDate } from "../../src/status/format.ts";

const NB = " ";
const NOW = new Date(2026, 8, 15, 12, 0).getTime();
const STORAGE = { events: 1842, firstAt: new Date(2026, 8, 14, 23, 16).getTime(), days: 3, firstDay: new Date(2026, 8, 12).getTime(), bytes: 2.1 * 1024 * 1024 };
const EMPTY = { events: 0, firstAt: null, days: 0, firstDay: null, bytes: 900 };

test("storlek och datum i dataraden", () => {
  assert.deepEqual([0, 850, 2048, 2.1 * 1024 * 1024, 3 * 1024 ** 3].map(fileSize), [`0${NB}B`, `850${NB}B`, `2${NB}kB`, `2,1${NB}MB`, `3${NB}GB`]);
  assert.equal(shortDate(STORAGE.firstAt, NOW), `14${NB}sep`);
  assert.equal(shortDate(new Date(2025, 11, 31).getTime(), NOW), `31${NB}dec${NB}2025`);
  assert.equal(storageSummary(STORAGE, NOW), `1${NB}842 händelser sedan 14${NB}sep · 3 dagar summerade · 2,1${NB}MB i \`~/.tokeniser\``);
  assert.equal(storageSummary({ ...STORAGE, days: 1 }, NOW), `1${NB}842 händelser sedan 14${NB}sep · 1 dag summerad · 2,1${NB}MB i \`~/.tokeniser\``);
  assert.equal(storageSummary({ ...STORAGE, days: null }, NOW), `1${NB}842 händelser sedan 14${NB}sep · 2,1${NB}MB i \`~/.tokeniser\``);
  assert.equal(storageSummary(EMPTY, NOW), `Ingen insamlad data · 900${NB}B i \`~/.tokeniser\``);
  assert.equal(storageSummary({ ...EMPTY, days: 40, firstDay: STORAGE.firstDay }, NOW), `Ingen insamlad data · 40 dagar summerade · 900${NB}B i \`~/.tokeniser\``);
  assert.equal(exportTitle("events", STORAGE), `Exportera 1${NB}842 händelser · filen innehåller projektnamn, sökvägar och tider`);
  assert.equal(exportTitle("days", STORAGE), "Exportera 3 dagssummeringar · filen innehåller projektnamn, sökvägar och tider");
});

test("exporten erbjuder bara det som finns", () => {
  assert.deepEqual(
    exportChoices(STORAGE, NOW).map((c) => [c.content, c.label, c.description]),
    [
      ["events", "Händelser", `1${NB}842 händelser sedan 14${NB}sep`],
      ["days", "Dagssummeringar", `3 dagssummeringar sedan 12${NB}sep`],
    ],
  );
  assert.equal(exportChoices(STORAGE, NOW)[1]?.detail, "Tokens och kostnad per dag, projekt och modell. Sparas tills du raderar dem.");
  assert.deepEqual(exportChoices({ ...STORAGE, days: null }, NOW).map((c) => c.content), ["events"]);
  assert.deepEqual(exportChoices({ ...EMPTY, days: 2, firstDay: STORAGE.firstDay }, NOW).map((c) => c.content), ["days"]);
  assert.deepEqual(exportChoices(EMPTY, NOW), []);
});

test("raderingsdialogen räknar upp exakt vad som tas bort i båda lägena", () => {
  const collected = deleteDialog("collected", STORAGE, NOW);
  assert.equal(collected.message, "Radera all insamlad data?");
  assert.equal(collected.confirm, "Radera data");
  assert.ok(
    collected.detail.startsWith(
      `Det här tas bort ur ~/.tokeniser:\n• events/ – 1${NB}842 händelser sedan 14${NB}sep\n• days.jsonl – 3 dagssummeringar sedan 12${NB}sep, även för dagar vars händelser redan är rensade\n• index.sqlite`,
    ),
  );
  assert.match(collected.detail, /Anslutningen finns kvar, så nya svar i Claude Code samlas in igen\./);
  assert.match(collected.detail, /Det går inte att ångra\.$/);

  const everything = deleteDialog("everything", null, NOW);
  assert.equal(everything.message, "Radera allt som Tokeniser har sparat?");
  assert.equal(everything.confirm, "Radera allt");
  assert.match(everything.detail, /hela ~\/\.tokeniser tas bort/);
  assert.match(everything.detail, /events\/, days\.jsonl, index\.sqlite och state\/ – insamlad data, inga händelser och dagssummeringarna\n/);
  assert.match(deleteDialog("everything", EMPTY, NOW).detail, /insamlad data, inga händelser och inga dagssummeringar\n/);
  assert.match(everything.detail, /backup\/ – kopian av settings\.json från anslutningen, som kan innehålla hemligheter/);

  assert.equal(deleteDone("collected", { remaining: [] }), "Insamlad data är raderad. Nya svar i Claude Code samlas in igen.");
  assert.equal(
    deleteDone("everything", { remaining: ["/x/a", "/x/b"] }),
    "Allt som Tokeniser har sparat är raderat. Kvar, eftersom Tokeniser inte skapade dem: /x/a, /x/b.",
  );
});

test("aviseringen efter exporten säger vem som kan läsa filen, och påstår aldrig mer än rättigheterna ger", () => {
  const content = "Filen innehåller projektnamn, sökvägar och tider, men inget från konversationer.";
  assert.equal(
    exportDone("events", { path: "/tmp/export.jsonl", lines: 1, mode: 0o600 }),
    `Exporterade 1 händelse till /tmp/export.jsonl. ${content} Bara du kan läsa den.`,
  );
  assert.equal(
    exportDone("days", { path: "/tmp/dagar.jsonl", lines: 3, mode: 0o600 }),
    `Exporterade 3 dagssummeringar till /tmp/dagar.jsonl. ${content} Tokens och kostnad är uppskattningar. Bara du kan läsa den.`,
  );
  assert.match(exportDone("events", { path: "/mnt/c/Users/lullo/export.jsonl", lines: 2, mode: 0o600 }), /Den ligger på en Windows-disk, där Linux-rättigheter inte hindrar/);
  assert.match(exportDone("days", { path: "/tmp/export.jsonl", lines: 2, mode: 0o644 }), /Den fick rättigheterna 0644, så andra kan kanske läsa den\.$/);
  assert.doesNotMatch(exportDone("events", { path: "/mnt/data/export.jsonl", lines: 2, mode: 0o600 }), /Windows/);
});
