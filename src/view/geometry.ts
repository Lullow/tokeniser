// Pure layout math shared by the webview and the tests.

const NBSP = " ";
const oneDecimal = new Intl.NumberFormat("sv-SE", { minimumFractionDigits: 1, maximumFractionDigits: 1 });

/** "0", "850", "215 k", "12,7 M". */
export function shortTokens(value: number): string {
  if (value >= 1_000_000) return `${oneDecimal.format(value / 1_000_000)}${NBSP}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}${NBSP}k`;
  return String(Math.round(value));
}

/** The smallest 1, 2 or 5 times a power of ten that is at least max. */
export function niceMax(max: number): number {
  if (!(max > 0)) return 1;
  const power = 10 ** Math.floor(Math.log10(max));
  for (const step of [1, 2, 5, 10]) {
    if (step * power >= max) return step * power;
  }
  return 10 * power;
}

export function ringDash(percent: number, radius: number): { circumference: number; offset: number } {
  const circumference = 2 * Math.PI * radius;
  const clamped = Math.min(100, Math.max(0, percent));
  return { circumference, offset: circumference * (1 - clamped / 100) };
}

export interface CurveGeometry {
  width: number;
  height: number;
  plotLeft: number;
  plotRight: number;
  points: { x: number; y: number }[];
  /** Every day but today. */
  line: string;
  /** The last segment, drawn dashed because today is not over. */
  today: string;
  area: string;
  gridlines: { y: number; label: string }[];
  labels: { x: number; text: string }[];
}

const round1 = (n: number): number => Math.round(n * 10) / 10;

export function curveGeometry(values: readonly number[], labels: readonly string[], width = 280, height = 112): CurveGeometry {
  const plotLeft = 34;
  const plotRight = width - 16;
  const top = 8;
  const baseline = height - 20;
  const max = niceMax(Math.max(0, ...values));
  const x = (i: number): number => (values.length <= 1 ? plotRight : plotLeft + (i * (plotRight - plotLeft)) / (values.length - 1));
  const y = (v: number): number => top + (baseline - top) * (1 - Math.max(0, v) / max);
  const points = values.map((v, i) => ({ x: round1(x(i)), y: round1(y(v)) }));
  const path = (ps: readonly { x: number; y: number }[]): string => ps.map((p, i) => `${i === 0 ? "M" : "L"}${p.x} ${p.y}`).join(" ");
  const first = points[0];
  const last = points.at(-1);

  return {
    width,
    height,
    plotLeft,
    plotRight,
    points,
    line: points.length >= 3 ? path(points.slice(0, -1)) : "",
    today: points.length >= 2 ? path(points.slice(-2)) : "",
    area: first !== undefined && last !== undefined ? `${path(points)} L${last.x} ${baseline} L${first.x} ${baseline} Z` : "",
    gridlines: [0, max / 2, max].map((v) => ({ y: round1(y(v)), label: shortTokens(v) })),
    labels: labels.map((text, i) => ({ x: round1(x(i)), text })),
  };
}
