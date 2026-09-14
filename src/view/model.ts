import { duration, moment, percent, tokenCount } from "../status/format.ts";
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
} from "../status/model.ts";
import { dayStarts, type ViewData } from "./data.ts";
import { buildSuggestions, type SuggestionSettings } from "./suggestions.ts";
import type { ContextModel, ForecastModel, Level, RingModel, ViewModel } from "./types.ts";

export interface ViewSettings {
  status: StatusSettings;
  suggestions: SuggestionSettings;
}

const WEEKDAYS = ["sön", "mån", "tis", "ons", "tor", "fre", "lör"];

/** R4 is not validated yet, so the view says so instead of showing a number. */
const OUTSIDE = {
  title: "Utanför VS Code (app, webb, andra enheter)",
  text: "Går inte att särskilja än. Gränserna ovan räknar all användning, och Tokeniser behöver några dagars data innan appens del kan uppskattas.",
};

const levelOf = (used: number, settings: StatusSettings): Level =>
  used >= settings.errorAt ? "error" : used >= settings.warningAt ? "warning" : "normal";

function ring(key: RingModel["key"], label: string, state: LimitState, settings: StatusSettings, now: number): RingModel {
  switch (state.kind) {
    case "current":
    case "stale":
      return {
        key,
        label,
        kind: state.kind,
        value: state.used,
        level: levelOf(state.used, settings),
        center: percent(state.used),
        lines: [`återställs ${moment(state.resetsAt, now)}`, `om ${duration(state.resetsAt - now)}`],
        pill: state.kind === "current" ? "Aktuell" : `Äldre · ${duration(state.age)}`,
        note: null,
      };
    case "reset":
      return { key, label, kind: "reset", value: null, level: "normal", center: "Återställd", lines: ["ny siffra vid nästa svar"], pill: "Återställd", note: null };
    case "missing":
      return { key, label, kind: "missing", value: null, level: "normal", center: "Saknas", lines: [], pill: "Saknas", note: state.reason };
  }
}

function forecastModel(label: string, result: Forecast, now: number): ForecastModel {
  switch (result.kind) {
    case "reaches":
      return { label, text: `Når gränsen cirka ${moment(result.at, now)}`, estimated: true };
    case "lasts":
      return { label, text: `Räcker till återställningen ${moment(result.resetsAt, now)}`, estimated: true };
    case "reached":
      return { label, text: `Gränsen är nådd, återställs ${moment(result.resetsAt, now)}`, estimated: false };
    case "hidden":
      return { label, text: `Prognos döljs: ${result.reason}.`, estimated: false };
  }
}

function contextModel(state: ContextState, settings: SuggestionSettings): ContextModel {
  if (state.kind === "missing") return { kind: "missing", value: null, summary: "Saknas", ticks: [], note: state.reason };
  let amount: string | null = null;
  if (state.tokens !== null && state.size !== null) amount = `${tokenCount(state.tokens)} av ${tokenCount(state.size)} tokens`;
  else if (state.tokens !== null) amount = `${tokenCount(state.tokens)} tokens`;
  const age = state.kind === "stale" ? `för ${duration(state.age)} sedan` : null;
  const ticks: ContextModel["ticks"] = [];
  if (state.size !== null && settings.contextTokens < state.size) {
    ticks.push({ at: (settings.contextTokens / state.size) * 100, label: `${Math.round(settings.contextTokens / 1000)} k` });
  }
  ticks.push({ at: settings.contextPercent, label: percent(settings.contextPercent) });
  return {
    kind: state.kind,
    value: state.usedPct,
    summary: [amount, percent(state.usedPct), age].filter((part): part is string => part !== null).join(" · "),
    ticks,
    note: null,
  };
}

export function buildViewModel(snapshot: Snapshot, data: ViewData, settings: ViewSettings, now: number): ViewModel {
  const five = limitState(snapshot, "fiveHour", now);
  const week = limitState(snapshot, "week", now);
  const context = contextState(snapshot, now);
  const session = snapshot.session;

  const detail = [session?.modelId, session?.effort].filter((part): part is string => Boolean(part));
  if (session !== null && !session.inWindowProject) detail.push("senaste sessionen, inte från fönstrets projekt");
  const others = snapshot.otherActiveSessions;
  if (others > 0) detail.push(`+${others} ${others === 1 ? "annan aktiv session" : "andra aktiva sessioner"}`);

  const measured = [five, week].flatMap((s) => (s.kind === "current" || s.kind === "stale" ? [s.measuredAt] : []));
  if (context.kind !== "missing") measured.push(context.measuredAt);

  const totals = data.sessionTotals;
  const days = data.days.length > 0 ? data.days : dayStarts(now).map((start) => ({ start, tokens: 0 }));

  return {
    unavailable: snapshot.unavailable,
    updated: measured.length > 0 ? `Senaste mätning ${moment(Math.max(...measured), now)}` : null,
    limits: {
      rings: [ring("fiveHour", "5 timmar", five, settings.status, now), ring("week", "Vecka", week, settings.status, now)],
      forecasts: [
        forecastModel("5 h", forecast(five, snapshot.fiveHour.points, FORECAST.fiveHour, now), now),
        forecastModel("Vecka", forecast(week, snapshot.week.points, FORECAST.week, now), now),
      ],
      outside: OUTSIDE,
    },
    session: {
      title: session?.label ?? "Ingen session",
      detail: detail.join(" · "),
      context: contextModel(context, settings.suggestions),
      tiles: [
        { label: "Input", value: totals?.input ?? null },
        { label: "Output", value: totals?.output ?? null },
        { label: "Cache skapad", value: totals?.cacheCreation ?? null },
        { label: "Cache läst", value: totals?.cacheRead ?? null },
      ],
      tilesNote: totals === null ? "Inga mätta anrop i sessionen ännu." : `Summa av ${totals.calls} mätta anrop · uppskattning`,
    },
    history: {
      total: days.reduce((sum, day) => sum + day.tokens, 0),
      days: days.map((day, i) => {
        const today = i === days.length - 1;
        return { label: today ? "i dag" : (WEEKDAYS[new Date(day.start).getDay()] ?? ""), tokens: day.tokens, today };
      }),
      projects: data.projectsToday.map((project) => ({
        label: project.label,
        detail: `${project.sessions} ${project.sessions === 1 ? "session" : "sessioner"} · ${
          project.activeMs < 60_000 ? "kort aktivitet" : `aktiv cirka ${duration(project.activeMs)}`
        }`,
        tokens: project.tokens,
      })),
    },
    suggestions: buildSuggestions(context, data.cacheMiss, settings.suggestions, now),
  };
}
