import { duration, moment, percent, tokenCount } from "./format.ts";
import {
  contextState,
  FORECAST,
  forecast,
  limitState,
  type ContextState,
  type Forecast,
  type LimitState,
  type Snapshot,
  type StatusSettings,
} from "./model.ts";

export type ThemeKind = "dark" | "light" | "highContrast" | "highContrastLight";

interface Palette {
  fiveHour: string;
  week: string;
  warning: string;
  error: string;
  track: string;
  text: string;
  muted: string;
}

/** An image in a hover cannot read theme variables, so each theme kind has fixed colors. */
const PALETTES: Record<ThemeKind, Palette> = {
  dark: { fiveHour: "#3794FF", week: "#B180D7", warning: "#D18616", error: "#F14C4C", track: "#3C3C3C", text: "#CCCCCC", muted: "#9D9D9D" },
  light: { fiveHour: "#1A85FF", week: "#652D90", warning: "#C27400", error: "#E51400", track: "#E5E5E5", text: "#3B3B3B", muted: "#676767" },
  highContrast: { fiveHour: "#3794FF", week: "#C99BE8", warning: "#F38518", error: "#F48771", track: "#6FC3DF", text: "#FFFFFF", muted: "#FFFFFF" },
  highContrastLight: { fiveHour: "#0F4A85", week: "#652D90", warning: "#895503", error: "#B5200D", track: "#0F4A85", text: "#292929", muted: "#292929" },
};

const HTML_ENTITIES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;" };

/** Text from the index is shown as text: no HTML, no markdown. */
export function escapeMarkdown(text: string): string {
  return text.replace(/[&<>]/g, (c) => HTML_ENTITIES[c] ?? c).replace(/[\\`*_{}[\]()#+\-.!|~]/g, "\\$&");
}

function ringMarkup(cx: number, state: LimitState, color: string, palette: Palette, settings: StatusSettings): string {
  const radius = 20;
  const circumference = 2 * Math.PI * radius;
  const track = `<circle cx="${cx}" cy="26" r="${radius}" fill="none" stroke="${palette.track}" stroke-width="5"/>`;
  const label = (text: string, fill: string): string =>
    `<text x="${cx}" y="30" text-anchor="middle" font-family="sans-serif" font-size="11" font-weight="600" fill="${fill}">${text}</text>`;
  if (state.kind !== "current" && state.kind !== "stale") {
    return track + label(state.kind === "reset" ? "↺" : "–", palette.muted);
  }
  const used = Math.min(100, Math.max(0, state.used));
  const stroke = used >= settings.errorAt ? palette.error : used >= settings.warningAt ? palette.warning : color;
  const arc =
    `<circle cx="${cx}" cy="26" r="${radius}" fill="none" stroke="${stroke}" stroke-width="5" stroke-linecap="round"` +
    ` stroke-dasharray="${circumference.toFixed(2)}" stroke-dashoffset="${(circumference * (1 - used / 100)).toFixed(2)}"` +
    ` transform="rotate(-90 ${cx} 26)"${state.kind === "stale" ? ' opacity="0.55"' : ""}/>`;
  return track + arc + label(`${Math.round(used)}%`, palette.text);
}

export function ringsSvg(five: LimitState, week: LimitState, theme: ThemeKind, settings: StatusSettings): string {
  const palette = PALETTES[theme];
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="104" height="52" viewBox="0 0 104 52">` +
    ringMarkup(26, five, palette.fiveHour, palette, settings) +
    ringMarkup(78, week, palette.week, palette, settings) +
    `</svg>`
  );
}

function limitLine(name: string, state: LimitState, now: number): string {
  switch (state.kind) {
    case "current":
      return `${name} **${percent(state.used)}** · återställs ${moment(state.resetsAt, now)} (om ${duration(state.resetsAt - now)})`;
    case "stale":
      return `${name} **${percent(state.used)}** · för ${duration(state.age)} sedan · återställs ${moment(state.resetsAt, now)}`;
    case "reset":
      return `${name}: **återställd** · ny siffra vid nästa svar`;
    case "missing":
      return `${name}: **saknas** · ${escapeMarkdown(state.reason)}`;
  }
}

function contextLine(state: ContextState): string {
  if (state.kind === "missing") return `Kontext: **saknas** · ${escapeMarkdown(state.reason)}`;
  let amount = "";
  if (state.tokens !== null && state.size !== null) amount = ` · ${tokenCount(state.tokens)} av ${tokenCount(state.size)} tokens`;
  else if (state.tokens !== null) amount = ` · ${tokenCount(state.tokens)} tokens`;
  const age = state.kind === "stale" ? ` · för ${duration(state.age)} sedan` : "";
  return `Kontext **${percent(state.usedPct)}**${amount}${age}`;
}

function forecastLine(name: string, result: Forecast, now: number): string {
  switch (result.kind) {
    case "reaches":
      return `Prognos ${name}: når gränsen cirka ${moment(result.at, now)} · *uppskattning*`;
    case "lasts":
      return `Prognos ${name}: räcker till återställningen ${moment(result.resetsAt, now)} · *uppskattning*`;
    case "reached":
      return `Prognos ${name}: gränsen är nådd, återställs ${moment(result.resetsAt, now)}`;
    case "hidden":
      return `Prognos ${name} döljs: ${result.reason}.`;
  }
}

/** Decision Q18: the quick card shown when hovering the status bar item. Static by design. */
export function buildHover(snapshot: Snapshot, settings: StatusSettings, now: number, theme: ThemeKind): string {
  if (snapshot.unavailable !== null) {
    return ["**Tokeniser**", escapeMarkdown(snapshot.unavailable)].join("\n\n");
  }

  const five = limitState(snapshot, "fiveHour", now);
  const week = limitState(snapshot, "week", now);
  const svg = ringsSvg(five, week, theme, settings);
  const image = `<img src="data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}" width="104" height="52" alt="">`;

  const session = snapshot.session;
  const title = session?.label ? `**Tokeniser** · ${escapeMarkdown(session.label)}` : "**Tokeniser**";

  const values = [limitLine("5 h", five, now), limitLine("Vecka", week, now), contextLine(contextState(snapshot, now))];
  const sessionParts = [session?.modelId, session?.effort].filter((part): part is string => Boolean(part)).map(escapeMarkdown);
  if (session !== null && !session.inWindowProject) sessionParts.push("senaste sessionen, inte från fönstrets projekt");
  const others = snapshot.otherActiveSessions;
  if (others > 0) sessionParts.push(`+${others} ${others === 1 ? "annan aktiv session" : "andra aktiva sessioner"}`);
  if (sessionParts.length > 0) values.push(sessionParts.join(" · "));

  const forecasts = [
    forecastLine("5 h", forecast(five, snapshot.fiveHour.points, FORECAST.fiveHour, now), now),
    forecastLine("vecka", forecast(week, snapshot.week.points, FORECAST.week, now), now),
  ];

  return [title, image, values.join("  \n"), forecasts.join("  \n"), "*Uppdateras vid nästa svar i Claude Code.*"].join("\n\n");
}
