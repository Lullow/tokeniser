import assert from "node:assert/strict";
import { test } from "node:test";
import { buildHover, escapeMarkdown, ringsSvg } from "../../src/status/hover.ts";
import { limitState } from "../../src/status/model.ts";
import { HEALTH_WARNING, NOW, reading, rising, SETTINGS, snap } from "../helpers/status.ts";

const svgOf = (markdown: string): string => {
  const match = /base64,([^"]+)"/.exec(markdown);
  assert.ok(match);
  return Buffer.from(match[1]!, "base64").toString("utf8");
};

test("snabbkortet visar värden, en statisk bild och prognos märkt uppskattning", () => {
  const md = buildHover(snap({ fivePoints: rising(58, [16, 11, 6, 1]) }), SETTINGS, NOW, "dark");
  assert.match(md, /^\*\*Tokeniser\*\* · tokeniser\n\n/);
  assert.match(md, /<img src="data:image\/svg\+xml;base64,[A-Za-z0-9+/=]+" width="104" height="52" alt="">/);
  assert.match(md, /5 h \*\*64\s%\*\* · återställs kl\.\s\d{2}:\d{2} \(om 2 h\)/);
  assert.match(md, /Vecka \*\*31\s%\*\*/);
  assert.match(md, /Kontext \*\*21\s%\*\* · 214\s800 av 1\s000\s000 tokens/);
  assert.match(md, /claude\\-opus\\-5 · xhigh/);
  assert.match(md, /Prognos 5 h: når gränsen cirka kl\.\s\d{2}:\d{2} · \*uppskattning\*/);
  assert.match(md, /Prognos vecka döljs: den kräver minst 3 mätningar under minst 20 h\./);
  assert.match(md, /\*Uppdateras vid nästa svar i Claude Code\.\* · \[Öppna Tokeniser\]\(command:tokeniser\.openView\)$/);
  assert.ok(!md.includes("<script"));
});

test("äldre data visar åldern och döljer prognosen", () => {
  const md = buildHover(snap({ five: reading(64, 40), fivePoints: rising(58, [16, 11, 6, 1]) }), SETTINGS, NOW, "dark");
  assert.match(md, /5 h \*\*64\s%\*\* · för 40 min sedan/);
  assert.match(md, /Prognos 5 h döljs: senaste värdet är 40 min gammalt\./);
  assert.doesNotMatch(md, /Prognos 5 h: /);
});

test("en återställd gräns visas aldrig som 0 %", () => {
  const s = snap({ five: reading(88, 1, NOW - 1) });
  const md = buildHover(s, SETTINGS, NOW, "dark");
  assert.match(md, /5 h: \*\*återställd\*\* · ny siffra vid nästa svar/);
  assert.doesNotMatch(md, /\b0\s%/);
  const svg = ringsSvg(limitState(s, "fiveHour", NOW), limitState(s, "week", NOW), "dark", SETTINGS);
  assert.ok(svg.includes(">↺</text>"));
  assert.ok(!svg.includes(">0%<"));
});

test("projektnamn och modell visas som text, aldrig som HTML eller markdown", () => {
  const s = snap();
  s.session!.label = '<img src=x onerror="alert(1)"> **fet** [länk](https://example.com)';
  s.session!.modelId = "<b>modell</b>";
  const md = buildHover(s, SETTINGS, NOW, "dark");
  assert.equal(md.split("<img").length - 1, 1, "bara bilden Tokeniser själv ritar får vara HTML");
  assert.ok(md.includes('&lt;img src=x onerror="alert\\(1\\)"&gt;'));
  assert.ok(md.includes("\\*\\*fet\\*\\*"));
  assert.ok(md.includes("\\[länk\\]\\(https://example\\.com\\)"));
  assert.ok(md.includes("&lt;b&gt;modell&lt;/b&gt;"));
  assert.equal(escapeMarkdown("a_b|c"), "a\\_b\\|c");
});

test("bilden följer temat och tröskelfärgerna", () => {
  const light = svgOf(buildHover(snap({ five: reading(85) }), SETTINGS, NOW, "light"));
  assert.ok(light.includes('stroke="#C27400"'), "varningsfärg för 5 h");
  assert.ok(light.includes('stroke="#652D90"'), "veckans färg i ljust tema");
  const dark = svgOf(buildHover(snap({ five: reading(96, 20) }), SETTINGS, NOW, "dark"));
  assert.ok(dark.includes('stroke="#F14C4C"'), "felfärg för 5 h");
  assert.ok(dark.includes('opacity="0.55"'), "äldre data ritas svagare");
});

test("snabbkortet visar en hälsovarning med en länk till vyn, men inget när allt är i ordning", () => {
  const line = "$(warning) **Hälsa:** Insamlaren har ändrats sedan anslutningen · [Visa hälsa](command:tokeniser.openView)";
  assert.ok(buildHover(snap(), SETTINGS, NOW, "dark", HEALTH_WARNING).includes(`\n\n${line}\n\n`));
  assert.ok(buildHover(snap({ unavailable: "Kan inte läsa." }), SETTINGS, NOW, "dark", HEALTH_WARNING).endsWith(`\n\n${line}`));
  assert.doesNotMatch(buildHover(snap(), SETTINGS, NOW, "dark", { ...HEALTH_WARNING, level: "ok", title: "Allt i ordning" }), /Hälsa/);
});

test("utan data visar snabbkortet bara orsaken", () => {
  const md = buildHover(snap({ unavailable: "Tokeniser är inte ansluten <än>." }), SETTINGS, NOW, "dark");
  assert.equal(md, "**Tokeniser**\n\nTokeniser är inte ansluten &lt;än&gt;\\.");
});
