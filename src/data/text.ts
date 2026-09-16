import { homedir } from "node:os";
import { fileSize, shortDate, tokenCount } from "../status/format.ts";
import type { DeleteResult, DeleteScope, ExportResult, StorageSummary } from "./store.ts";

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

/** The data row, for example "1 842 händelser sedan 14 sep · 2,1 MB i `~/.tokeniser`". */
export function storageSummary(storage: StorageSummary, now: number): string {
  const size = `${fileSize(storage.bytes)} i \`~/.tokeniser\``;
  return storage.events === 0 || storage.firstAt === null ? `Ingen insamlad data · ${size}` : `${eventsSince(storage, now)} · ${size}`;
}

export function exportTitle(storage: StorageSummary): string {
  return `Exportera ${plural(storage.events, "händelse", "händelser")} · filen innehåller projektnamn, sökvägar och tider`;
}

/** The title of the save dialog is easy to miss and ignored on some systems, so the notice says it all again. */
export function exportDone(result: ExportResult): string {
  const content = "Filen innehåller projektnamn, sökvägar och tider, men inget från konversationer.";
  let access: string;
  if (WINDOWS_DRIVE.test(result.path)) {
    access = "Den ligger på en Windows-disk, där Linux-rättigheter inte hindrar andra program i Windows från att läsa den.";
  } else if ((result.mode & 0o077) === 0) {
    access = "Bara du kan läsa den.";
  } else {
    access = `Den fick rättigheterna ${octal(result.mode)}, så andra kan kanske läsa den.`;
  }
  return `Exporterade ${plural(result.events, "händelse", "händelser")} till ${displayPath(result.path)}. ${content} ${access}`;
}

export interface DeleteDialog {
  message: string;
  detail: string;
  confirm: string;
}

/** The texts approved in the sketch 2026-09-15; the detail is plain text, as VS Code's modal dialog shows it. */
export function deleteDialog(scope: DeleteScope, storage: StorageSummary | null, now: number): DeleteDialog {
  const events = eventsSince(storage, now);
  if (scope === "collected") {
    return {
      message: "Radera all insamlad data?",
      detail: [
        "Det här tas bort ur ~/.tokeniser:",
        `• events/ – ${events}`,
        "• days.jsonl – dagssummeringarna, även för dagar vars händelser redan är rensade",
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
      `• events/, days.jsonl, index.sqlite och state/ – insamlad data och dagssummeringar, ${events}`,
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
