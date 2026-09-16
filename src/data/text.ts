import { homedir } from "node:os";
import { fileSize, shortDate, tokenCount } from "../status/format.ts";
import type { DeleteResult, DeleteScope, ExportKind, ExportResult, StorageSummary } from "./store.ts";

/** WSL mounts Windows drives under /mnt/<letter>, where Linux permissions do not keep Windows programs out. */
const WINDOWS_DRIVE = /^\/mnt\/[a-z](?:\/|$)/;

const octal = (mode: number): string => (mode & 0o7777).toString(8).padStart(4, "0");
const plural = (n: number, one: string, many: string): string => `${tokenCount(n)} ${n === 1 ? one : many}`;

function displayPath(path: string): string {
  const home = homedir();
  return path.startsWith(`${home}/`) ? `~/${path.slice(home.length + 1)}` : path;
}

function eventsSince(storage: StorageSummary | null, now: number): string {
  if (storage === null || storage.events === 0 || storage.firstAt === null) return "inga händelser";
  return `${plural(storage.events, "händelse", "händelser")} sedan ${shortDate(storage.firstAt, now)}`;
}

/** "3 dagssummeringar sedan 14 sep"; null when days.jsonl cannot be read. */
function daysSince(storage: StorageSummary | null, now: number): string | null {
  if (storage === null || storage.days === null) return null;
  if (storage.days === 0 || storage.firstDay === null) return "inga dagssummeringar";
  return `${plural(storage.days, "dagssummering", "dagssummeringar")} sedan ${shortDate(storage.firstDay, now)}`;
}

/** The data row, for example "1 842 händelser sedan 14 sep · 3 dagar summerade · 2,1 MB i `~/.tokeniser`". */
export function storageSummary(storage: StorageSummary, now: number): string {
  const size = `${fileSize(storage.bytes)} i \`~/.tokeniser\``;
  const days = storage.days !== null && storage.days > 0 ? ` · ${plural(storage.days, "dag summerad", "dagar summerade")}` : "";
  return storage.events === 0 || storage.firstAt === null ? `Ingen insamlad data${days} · ${size}` : `${eventsSince(storage, now)}${days} · ${size}`;
}

export interface ExportChoice {
  /** Not "kind", which VS Code's quick pick uses for separators. */
  content: ExportKind;
  label: string;
  description: string;
  detail: string;
}

/** Only what there is to export; the command skips the choice when there is one. */
export function exportChoices(storage: StorageSummary, now: number): ExportChoice[] {
  const choices: ExportChoice[] = [];
  if (storage.events > 0) {
    choices.push({ content: "events", label: "Händelser", description: eventsSince(storage, now), detail: "Rådata från Claude Codes statusrad, som sparas i 90–121 dagar." });
  }
  if (storage.days !== null && storage.days > 0) {
    choices.push({
      content: "days",
      label: "Dagssummeringar",
      description: daysSince(storage, now) ?? "",
      detail: "Tokens och kostnad per dag, projekt och modell. Sparas tills du raderar dem.",
    });
  }
  return choices;
}

export function exportTitle(kind: ExportKind, storage: StorageSummary): string {
  const what = kind === "events" ? plural(storage.events, "händelse", "händelser") : plural(storage.days ?? 0, "dagssummering", "dagssummeringar");
  return `Exportera ${what} · filen innehåller projektnamn, sökvägar och tider`;
}

/** The title of the save dialog is easy to miss and ignored on some systems, so the notice says it all again. */
export function exportDone(kind: ExportKind, result: ExportResult): string {
  const content =
    kind === "events"
      ? "Filen innehåller projektnamn, sökvägar och tider, men inget från konversationer."
      : "Filen innehåller projektnamn, sökvägar och tider, men inget från konversationer. Tokens och kostnad är uppskattningar.";
  let access: string;
  if (WINDOWS_DRIVE.test(result.path)) {
    access = "Den ligger på en Windows-disk, där Linux-rättigheter inte hindrar andra program i Windows från att läsa den.";
  } else if ((result.mode & 0o077) === 0) {
    access = "Bara du kan läsa den.";
  } else {
    access = `Den fick rättigheterna ${octal(result.mode)}, så andra kan kanske läsa den.`;
  }
  const what = kind === "events" ? plural(result.lines, "händelse", "händelser") : plural(result.lines, "dagssummering", "dagssummeringar");
  return `Exporterade ${what} till ${displayPath(result.path)}. ${content} ${access}`;
}

export interface DeleteDialog {
  message: string;
  detail: string;
  confirm: string;
}

/** The texts approved in the sketch 2026-09-15; the detail is plain text, as VS Code's modal dialog shows it. */
export function deleteDialog(scope: DeleteScope, storage: StorageSummary | null, now: number): DeleteDialog {
  const events = eventsSince(storage, now);
  const days = daysSince(storage, now);
  if (scope === "collected") {
    return {
      message: "Radera all insamlad data?",
      detail: [
        "Det här tas bort ur ~/.tokeniser:",
        `• events/ – ${events}`,
        `• days.jsonl – ${days ?? "dagssummeringarna"}, även för dagar vars händelser redan är rensade`,
        "• index.sqlite – indexet som vyn läser",
        "• state/ – senaste mätvärden per session och avvisade körningar",
        "",
        "Anslutningen finns kvar, så nya svar i Claude Code samlas in igen. Koppla från först om inget mer ska samlas in. Det går inte att ångra.",
      ].join("\n"),
      confirm: "Radera data",
    };
  }
  return {
    message: "Radera allt som Tokeniser har sparat?",
    detail: [
      "Tokeniser är inte ansluten, så hela ~/.tokeniser tas bort:",
      `• events/, days.jsonl, index.sqlite och state/ – insamlad data, ${events} och ${days ?? "dagssummeringarna"}`,
      "• backup/ – kopian av settings.json från anslutningen, som kan innehålla hemligheter",
      "• bin/ – mappen efter insamlaren",
      "",
      "Claude Code och dina inställningar påverkas inte. Det går inte att ångra.",
    ].join("\n"),
    confirm: "Radera allt",
  };
}

export function deleteDone(scope: DeleteScope, result: DeleteResult): string {
  const done = scope === "collected" ? "Insamlad data är raderad. Nya svar i Claude Code samlas in igen." : "Allt som Tokeniser har sparat är raderat.";
  if (result.remaining.length === 0) return done;
  const shown = result.remaining.slice(0, 5).join(", ");
  return `${done} Kvar, eftersom Tokeniser inte skapade dem: ${shown}${result.remaining.length > 5 ? " med flera" : ""}.`;
}
