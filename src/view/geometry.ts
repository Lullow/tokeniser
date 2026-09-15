// Pure layout math shared by the webview and the tests.

const NBSP = " ";
const oneDecimal = new Intl.NumberFormat("sv-SE", { minimumFractionDigits: 1, maximumFractionDigits: 1 });

/** "0", "850", "215 k", "12,7 M". */
export function shortTokens(value: number): string {
  if (value >= 1_000_000) return `${oneDecimal.format(value / 1_000_000)}${NBSP}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}${NBSP}k`;
  return String(Math.round(value));
}

const upToOneDecimal = new Intl.NumberFormat("sv-SE", { maximumFractionDigits: 1 });

/** Axis labels without a trailing ",0": "0", "500 k", "2,5 M", "100 M". */
export function axisTokens(value: number): string {
  if (value >= 1_000_000) return `${upToOneDecimal.format(value / 1_000_000)}${NBSP}M`;
  if (value >= 1_000) return `${upToOneDecimal.format(value / 1_000)}${NBSP}k`;
  return upToOneDecimal.format(value);
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
  /** Where the right-aligned axis labels end. */
  axisX: number;
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

/** The chart height in pixels; the view reserves the same height before it is drawn. */
export const CURVE_HEIGHT = 128;
/** A generous width per character of 11 px axis text: digits, spaces, "k" and "M". */
const CHAR_PX = 6.5;
const AXIS_GAP = 6;
const EDGE = 2;

const textWidth = (text: string): number => Math.ceil(text.length * CHAR_PX);

/**
 * Laid out in the real pixels of its box, so the text keeps its size in a wide column. The
 * left margin fits the longest axis label and the right margin half of the last day label.
 */
export function curveGeometry(values: readonly number[], labels: readonly string[], boxWidth = 280, height = CURVE_HEIGHT): CurveGeometry {
  const width = Math.max(160, Math.floor(boxWidth));
  const max = niceMax(Math.max(0, ...values));
  const steps = [0, max / 2, max];
  const axisLabels = steps.map(axisTokens);
  const axisX = EDGE + Math.max(...axisLabels.map(textWidth));
  const plotLeft = axisX + AXIS_GAP;
  const plotRight = width - EDGE - Math.ceil(textWidth(labels.at(-1) ?? "") / 2);
  const top = 10;
  const baseline = height - 22;
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
    axisX,
    points,
    line: points.length >= 3 ? path(points.slice(0, -1)) : "",
    today: points.length >= 2 ? path(points.slice(-2)) : "",
    area: first !== undefined && last !== undefined ? `${path(points)} L${last.x} ${baseline} L${first.x} ${baseline} Z` : "",
    gridlines: steps.map((v, i) => ({ y: round1(y(v)), label: axisLabels[i] ?? "" })),
    labels: labels.map((text, i) => ({ x: round1(x(i)), text })),
  };
}
