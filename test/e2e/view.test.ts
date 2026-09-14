import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const dist = (file: string): string => readFileSync(fileURLToPath(new URL(`../../dist/${file}`, import.meta.url)), "utf8");

test("vyns bundle har inga externa resurser, ingen HTML från strängar och ingen dynamisk kod", () => {
  const script = dist("view.js");
  const forbidden = [/innerHTML/, /outerHTML/, /insertAdjacentHTML/, /document\.write/, /\beval\(/, /new Function\b/, /\bfetch\(/, /XMLHttpRequest/, /WebSocket/, /\bimport\(/];
  for (const pattern of forbidden) assert.doesNotMatch(script, pattern);
  const urls = new Set([...script.matchAll(/https?:\/\/[^\s"'`)]+/g)].map((match) => match[0]));
  assert.deepEqual([...urls], ["http://www.w3.org/2000/svg"]);
});

test("vyns stil laddar inget utifrån", () => {
  assert.doesNotMatch(dist("view.css"), /url\(|@import|https?:/);
});
