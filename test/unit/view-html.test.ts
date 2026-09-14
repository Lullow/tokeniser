import assert from "node:assert/strict";
import { test } from "node:test";
import { contentSecurityPolicy, viewHtml } from "../../src/view/html.ts";

const OPTIONS = {
  cspSource: "https://webview.example",
  scriptUri: "https://webview.example/dist/view.js",
  styleUri: "https://webview.example/dist/view.css",
  nonce: "abc123",
};

test("strikta säkerhetsregler utan externa resurser eller inline-kod", () => {
  assert.equal(
    contentSecurityPolicy(OPTIONS.cspSource, OPTIONS.nonce),
    "default-src 'none'; style-src https://webview.example; font-src https://webview.example; script-src 'nonce-abc123'",
  );
  const html = viewHtml(OPTIONS);
  assert.ok(html.includes('<script nonce="abc123" src="https://webview.example/dist/view.js"></script>'));
  assert.equal(html.match(/<script/g)?.length, 1);
  assert.doesNotMatch(html, /unsafe-inline|unsafe-eval|<style|style="/);
});

test("sökvägar kan inte bryta sig ut ur attributen", () => {
  const html = viewHtml({ ...OPTIONS, styleUri: 'x" onload="alert(1)' });
  assert.ok(html.includes('href="x&quot; onload=&quot;alert(1)"'));
  assert.doesNotMatch(html, /" onload="/);
});
