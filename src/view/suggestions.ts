import { clockTime, duration, percent, tokenCount } from "../status/format.ts";
import type { ContextState } from "../status/model.ts";
import type { CacheMiss } from "./data.ts";
import type { Suggestion } from "./types.ts";

/** The only text the view may put on the clipboard. Nothing is ever run. */
export const COPYABLE_COMMANDS: readonly string[] = ["/compact", "/clear"];

/** A cache miss older than this is no longer suggested. */
export const RECENT_MISS_MS = 60 * 60 * 1000;

export interface SuggestionSettings {
  contextPercent: number;
  contextTokens: number;
}

/** Decision Q25: shown at whichever comes first of a share of the window or a number of tokens. */
export function contextSuggestion(context: ContextState, settings: SuggestionSettings): Suggestion | null {
  if (context.kind === "missing") return null;
  const tokensReached = context.tokens !== null && context.tokens >= settings.contextTokens;
  const percentReached = context.usedPct >= settings.contextPercent;
  if (!tokensReached && !percentReached) return null;

  const amount =
    context.tokens === null ? `${percent(context.usedPct)} av fönstret` : `${tokenCount(context.tokens)} tokens, ${percent(context.usedPct)} av fönstret`;
  return {
    id: "context",
    title: tokensReached
      ? `Kontexten har passerat ${tokenCount(settings.contextTokens)} tokens`
      : `Kontexten har passerat ${percent(settings.contextPercent)} av fönstret`,
    observed: `Sessionen använder ${amount}. Förslaget visas vid ${tokenCount(settings.contextTokens)} tokens eller ${percent(settings.contextPercent)}, det som kommer först.`,
    why: "Hela kontexten skickas med varje svar, så varje svar drar mer av gränsen ju större kontexten är.",
    action: "Sammanfatta med /compact, eller börja om med /clear om du har bytt uppgift.",
    effect:
      context.tokens === null
        ? "/clear tömmer kontexten. Effekten av /compact är okänd."
        : `/clear frigör ${tokenCount(context.tokens)} tokens. Effekten av /compact är okänd.`,
    certainty: context.kind === "stale" ? `Säker, men kontexten mättes för ${duration(context.age)} sedan.` : "Säker: bygger på uppmätt kontext.",
    estimated: false,
    commands: ["/compact", "/clear"],
  };
}

interface CauseInfo {
  text: string;
  action: string | null;
  command: string | null;
}

const AFTER_PAUSE = "Byter du uppgift efter en paus, börja om med /clear så att mindre behöver skrivas om.";

const CAUSES: Record<string, CauseInfo> = {
  ttl_expired_5m: { text: "cachen hann gå ut efter mer än 5 minuters paus", action: AFTER_PAUSE, command: "/clear" },
  ttl_expired_1h: { text: "cachen hann gå ut efter mer än en timmes paus", action: AFTER_PAUSE, command: "/clear" },
  tools_changed: {
    text: "verktygen ändrades, till exempel en MCP-server som lades till eller togs bort",
    action: "Ändra helst inte verktyg eller MCP-servrar mitt i en session.",
    command: null,
  },
  system_prompt_changed: {
    text: "systemprompten ändrades, till exempel CLAUDE.md eller inställningar",
    action: "Gör sådana ändringar helst mellan sessioner.",
    command: null,
  },
  likely_server_side: { text: "troligen något på Anthropics sida", action: null, command: null },
};

/** Decision Q13: a cache miss whose cause Claude Code reported. */
export function cacheMissSuggestion(miss: CacheMiss | null, context: ContextState, now: number): Suggestion | null {
  if (miss === null || miss.causes.length === 0 || now - miss.at > RECENT_MISS_MS || miss.at > now + 60_000) return null;
  const infos = miss.causes.map((cause) => CAUSES[cause] ?? { text: `orsaken ${cause.replaceAll("_", " ")}`, action: null, command: null });
  const commands = [...new Set(infos.flatMap((info) => (info.command === null ? [] : [info.command])))];
  const actions = [...new Set(infos.flatMap((info) => (info.action === null ? [] : [info.action])))];
  const tokens = context.kind === "missing" ? null : context.tokens;
  const serverSide = miss.causes.includes("likely_server_side");
  return {
    id: "cache-miss",
    title: "Senaste svaret kunde inte läsa från cachen",
    observed: `Cachemiss kl. ${clockTime(miss.at)}: ${infos.map((info) => info.text).join(", ")}.`,
    why: "Det som inte kunde läsas från cachen skrevs till den igen, och det drar mer av gränsen än att läsa.",
    action: actions.length > 0 ? actions.join(" ") : "Inget att göra.",
    effect:
      commands.includes("/clear") && tokens !== null
        ? `Med /clear behöver ${tokenCount(tokens)} färre tokens skrivas om efter nästa paus.`
        : "Går inte att beräkna.",
    certainty: serverSide ? "Uppskattad: Claude Code anger orsaken som trolig." : "Säker: orsaken rapporteras av Claude Code.",
    estimated: serverSide,
    commands,
  };
}

export function buildSuggestions(context: ContextState, miss: CacheMiss | null, settings: SuggestionSettings, now: number): Suggestion[] {
  return [contextSuggestion(context, settings), cacheMissSuggestion(miss, context, now)].filter((s): s is Suggestion => s !== null);
}
