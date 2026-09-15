import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const dist = (file: string): string => readFileSync(fileURLToPath(new URL(`../../dist/${file}`, import.meta.url)), "utf8");

/** Every module the built extension may load. A new one is a deliberate change to this list. */
const ALLOWED_MODULES = ["node:crypto", "node:fs", "node:os", "node:path", "node:sqlite", "vscode"];

/**
 * Acceptance criterion 12: zero network calls. A static check of the built extension; it cannot
 * see network access that would go through VS Code itself, and the webview has its own test.
 */
test("extensionens bundle laddar bara tillåtna moduler och har inget nätverk, inga länkar och ingen dynamisk kod", () => {
  const script = dist("extension.js");
  const literal = [...script.matchAll(/\brequire\(\s*["']([^"']+)["']\s*\)/g)].map((match) => match[1] ?? "");
  assert.equal(script.match(/\brequire\(/g)?.length ?? 0, literal.length, "varje require har en fast sträng");
  assert.deepEqual([...new Set(literal)].sort(), ALLOWED_MODULES);
  for (const pattern of [/\bfetch\(/, /openExternal/, /XMLHttpRequest/, /WebSocket/, /\bimport\(/, /\beval\(/, /new Function\b/]) {
    assert.doesNotMatch(script, pattern);
  }
  const urls = new Set([...script.matchAll(/https?:\/\/[^\s"'`)<>]+/g)].map((match) => match[0]));
  assert.deepEqual([...urls], ["http://www.w3.org/2000/svg"], "den enda adressen är SVG:s namnrymd i snabbkortets bild, som aldrig hämtas");
});
