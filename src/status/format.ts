const NBSP = " ";
const WEEKDAYS = ["sön", "mån", "tis", "ons", "tor", "fre", "lör"];
const MONTHS = ["jan", "feb", "mar", "apr", "maj", "jun", "jul", "aug", "sep", "okt", "nov", "dec"];
const grouped = new Intl.NumberFormat("sv-SE", { maximumFractionDigits: 0 });

const pad = (n: number): string => String(n).padStart(2, "0");

export const percent = (value: number): string => `${Math.round(value)}${NBSP}%`;

export const tokenCount = (value: number): string => grouped.format(Math.round(value));

export function clockTime(ms: number): string {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** "kl. 17:00" the same day, otherwise "tor 17 sep kl. 01:00". */
export function moment(ms: number, now: number): string {
  const d = new Date(ms);
  const today = new Date(now);
  const sameDay = d.getFullYear() === today.getFullYear() && d.getMonth() === today.getMonth() && d.getDate() === today.getDate();
  const time = `kl. ${clockTime(ms)}`;
  return sameDay ? time : `${WEEKDAYS[d.getDay()] ?? ""} ${d.getDate()} ${MONTHS[d.getMonth()] ?? ""} ${time}`;
}

/** Rounded down: "under 1 min", "40 min", "1 h 52 min", "2 d 18 h". */
export function duration(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) return "under 1 min";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 === 0 ? `${hours} h` : `${hours} h ${minutes % 60} min`;
  const days = Math.floor(hours / 24);
  return hours % 24 === 0 ? `${days} d` : `${days} d ${hours % 24} h`;
}
