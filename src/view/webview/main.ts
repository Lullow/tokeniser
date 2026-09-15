import { curveGeometry, ringDash, shortTokens } from "../geometry.ts";
import type { ContextModel, DayModel, HealthMark, HealthModel, RingModel, Suggestion, ToWebview, ViewModel } from "../types.ts";

interface VsCodeApi {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

const vscode = acquireVsCodeApi();
const root = document.getElementById("root") as HTMLElement;
const SVG_NS = "http://www.w3.org/2000/svg";
const NBSP = " ";
const RING_SIZE = 88;
const RING_RADIUS = 36;
const TWEEN_MS = 500;
const grouped = new Intl.NumberFormat("sv-SE", { maximumFractionDigits: 0 });

interface UiState {
  open: Record<string, boolean>;
}

function loadState(): UiState {
  const saved = vscode.getState() as Partial<UiState> | null | undefined;
  return { open: typeof saved?.open === "object" && saved.open !== null ? { ...saved.open } : {} };
}

const ui = loadState();
let previous: ViewModel | null = null;

const reduceMotion = (): boolean =>
  document.body.classList.contains("vscode-reduce-motion") || window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** All data becomes text nodes; nothing from the model is ever parsed as HTML. */
function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className !== "") node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function svgEl<K extends keyof SVGElementTagNameMap>(tag: K, attributes: Record<string, string | number> = {}): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, String(value));
  return node;
}

/** Decision Q19: values glide to their new value, and change at once with reduced motion. */
function tween(node: Node, from: number, to: number, format: (value: number) => string): void {
  node.textContent = format(to);
  if (reduceMotion() || from === to) return;
  node.textContent = format(from);
  const start = performance.now();
  const step = (time: number): void => {
    const progress = Math.min(1, (time - start) / TWEEN_MS);
    node.textContent = format(from + (to - from) * (1 - (1 - progress) ** 3));
    if (progress < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/** Applies a style after the first frame, so a CSS transition runs from the old value. */
function afterFirstFrame(apply: () => void): void {
  requestAnimationFrame(() => requestAnimationFrame(apply));
}

const badge = (text: string): HTMLElement => el("span", "badge", text);

function heading(title: string, extra?: string | Node): HTMLElement {
  const node = el("h2", "heading");
  node.append(el("span", "", title));
  if (extra !== undefined) {
    const side = el("span", "heading-extra");
    side.append(extra);
    node.append(side);
  }
  return node;
}

function ringView(model: RingModel, before: RingModel | undefined): HTMLElement {
  const block = el("div", `ring-block ring-${model.key} kind-${model.kind} level-${model.level}`);
  if (before !== undefined && before.kind !== model.kind) block.classList.add("changed");
  block.setAttribute("role", "group");
  block.setAttribute(
    "aria-label",
    model.value === null ? `${model.label}: ${model.pill}` : `${model.label}: ${Math.round(model.value)} procent förbrukat`,
  );

  const center = RING_SIZE / 2;
  const graphic = svgEl("svg", { viewBox: `0 0 ${RING_SIZE} ${RING_SIZE}`, class: "ring", "aria-hidden": "true" });
  graphic.append(svgEl("circle", { cx: center, cy: center, r: RING_RADIUS, class: "ring-track" }));
  if (model.value !== null) {
    const target = ringDash(model.value, RING_RADIUS);
    const startValue = before?.value ?? model.value;
    const arc = svgEl("circle", { cx: center, cy: center, r: RING_RADIUS, class: "ring-arc", transform: `rotate(-90 ${center} ${center})` });
    arc.style.strokeDasharray = target.circumference.toFixed(2);
    arc.style.strokeDashoffset = ringDash(startValue, RING_RADIUS).offset.toFixed(2);
    graphic.append(arc);
    if (startValue !== model.value) {
      afterFirstFrame(() => {
        arc.style.strokeDashoffset = target.offset.toFixed(2);
      });
    }
    const number = svgEl("text", { x: center, y: center + 6, "text-anchor": "middle", class: "ring-number" });
    graphic.append(number);
    tween(number, startValue, model.value, (v) => `${Math.round(v)}${NBSP}%`);
  } else {
    const word = svgEl("text", { x: center, y: center + 4, "text-anchor": "middle", class: "ring-word" });
    word.textContent = model.center;
    graphic.append(word);
  }

  block.append(graphic, el("div", "ring-label", model.label));
  for (const line of model.lines) block.append(el("div", "ring-line", line));
  if (model.note !== null) block.append(el("div", "ring-note", model.note));
  block.append(el("span", `pill pill-${model.kind}`, model.pill));
  return block;
}

function limitsView(model: ViewModel, before: ViewModel | null): HTMLElement {
  const node = el("section", "section limits");
  node.append(heading("Gränser", "konto · alla appar"));
  const rings = el("div", "rings");
  model.limits.rings.forEach((ring, i) => rings.append(ringView(ring, before?.limits.rings[i])));

  const forecasts = el("div", "forecasts");
  for (const item of model.limits.forecasts) {
    const row = el("p", "forecast");
    row.append(el("span", "forecast-label", `${item.label}: `), item.text);
    if (item.estimated) row.append(" ", badge("uppskattning"));
    forecasts.append(row);
  }

  const outside = el("div", "outside");
  outside.append(el("div", "outside-title", model.limits.outside.title), el("div", "muted", model.limits.outside.text));
  node.append(rings, forecasts, outside);
  return node;
}

function contextView(model: ContextModel, before: ContextModel | undefined): HTMLElement {
  const clamp = (v: number): number => Math.min(100, Math.max(0, v));
  const wrap = el("div", `context kind-${model.kind}`);
  const row = el("div", "context-row");
  row.append(el("span", "", "Kontext"), el("span", "context-summary", model.summary));

  const bar = el("div", model.value === null ? "bar bar-missing" : "bar");
  if (model.value !== null) {
    const target = clamp(model.value);
    const start = clamp(before?.value ?? model.value);
    const fill = el("div", "bar-fill");
    fill.style.width = `${start}%`;
    bar.append(fill);
    if (start !== target) {
      afterFirstFrame(() => {
        fill.style.width = `${target}%`;
      });
    }
  }
  for (const tick of model.ticks) {
    const mark = el("i", "tick");
    mark.style.left = `${clamp(tick.at)}%`;
    mark.append(el("span", "tick-label", tick.label));
    bar.append(mark);
  }

  wrap.append(row, bar);
  if (model.note !== null) wrap.append(el("p", "muted small", model.note));
  return wrap;
}

function sessionView(model: ViewModel, before: ViewModel | null): HTMLElement {
  const node = el("section", "section session");
  node.append(heading("Session", model.session.title));
  if (model.session.detail !== "") node.append(el("p", "muted detail", model.session.detail));
  node.append(contextView(model.session.context, before?.session.context));

  const tiles = el("div", "tiles");
  model.session.tiles.forEach((tile, i) => {
    const box = el("div", "tile");
    const value = el("div", "tile-value");
    if (tile.value === null) value.textContent = "–";
    else tween(value, before?.session.tiles[i]?.value ?? tile.value, tile.value, (v) => grouped.format(Math.round(v)));
    box.append(el("div", "tile-label", tile.label), value);
    tiles.append(box);
  });
  node.append(tiles, el("p", "muted small", model.session.tilesNote));
  return node;
}

function curveView(days: readonly DayModel[], width: number): SVGSVGElement {
  const geometry = curveGeometry(
    days.map((day) => day.tokens),
    days.map((day) => day.label),
    width,
  );
  const chart = svgEl("svg", {
    viewBox: `0 0 ${geometry.width} ${geometry.height}`,
    width: geometry.width,
    height: geometry.height,
    class: "curve",
    role: "img",
    "aria-label": `Tokens per dag, uppskattning: ${days.map((day) => `${day.label} ${shortTokens(day.tokens)}`).join(", ")}`,
  });
  for (const line of geometry.gridlines) {
    chart.append(svgEl("line", { x1: geometry.plotLeft, x2: geometry.plotRight, y1: line.y, y2: line.y, class: "gridline" }));
    const label = svgEl("text", { x: geometry.axisX, y: line.y + 4, "text-anchor": "end", class: "axis" });
    label.textContent = line.label;
    chart.append(label);
  }
  if (geometry.area !== "") chart.append(svgEl("path", { d: geometry.area, class: "area" }));
  if (geometry.line !== "") chart.append(svgEl("path", { d: geometry.line, class: "line" }));
  if (geometry.today !== "") chart.append(svgEl("path", { d: geometry.today, class: "line today" }));
  const last = geometry.points.at(-1);
  if (last !== undefined) chart.append(svgEl("circle", { cx: last.x, cy: last.y, r: 3.2, class: "dot" }));
  for (const label of geometry.labels) {
    const text = svgEl("text", { x: label.x, y: geometry.height - 5, "text-anchor": "middle", class: "axis" });
    text.textContent = label.text;
    chart.append(text);
  }
  return chart;
}

function historyView(model: ViewModel): HTMLElement {
  const node = el("section", "section history");
  const total = el("span");
  total.append(`${shortTokens(model.history.total)} tokens `, badge("uppskattning"));
  const projectsHeading = heading("I dag per projekt");
  projectsHeading.classList.add("heading-sub");
  // Drawn by drawCurve once the box is in the document and has a width.
  node.append(heading("7 dagar", total), el("div", "curve-box"), projectsHeading);

  if (model.history.projects.length === 0) {
    node.append(el("p", "muted small", "Ingen användning i dag ännu."));
    return node;
  }
  const list = el("ul", "projects");
  for (const project of model.history.projects) {
    const item = el("li");
    const name = el("span", "project-name", project.label);
    name.append(el("span", "project-detail", project.detail));
    item.append(name, el("span", "project-tokens", shortTokens(project.tokens)));
    list.append(item);
  }
  node.append(list);
  return node;
}

function chevron(): SVGSVGElement {
  const icon = svgEl("svg", { viewBox: "0 0 12 12", class: "chevron", "aria-hidden": "true" });
  icon.append(svgEl("path", { d: "m4.5 2.5 3.5 3.5-3.5 3.5" }));
  return icon;
}

/** Decisions Q13 and Q25: a collapsible row with all five parts; a button copies, nothing runs. */
function suggestionsView(suggestions: readonly Suggestion[]): HTMLElement | null {
  if (suggestions.length === 0) return null;
  const wrap = el("div", "suggestions");
  for (const suggestion of suggestions) {
    const open = ui.open[suggestion.id] === true;
    const card = el("div", "suggestion");
    card.dataset.open = String(open);
    const bodyId = `suggestion-${suggestion.id}`;

    const body = el("div", "suggestion-body");
    body.id = bodyId;
    body.inert = !open;
    const inner = el("div", "suggestion-inner");
    const list = el("dl");
    const parts: [string, string][] = [
      ["Observerat", suggestion.observed],
      ["Varför", suggestion.why],
      ["Åtgärd", suggestion.action],
      ["Effekt", suggestion.effect],
      ["Säkerhet", suggestion.certainty],
    ];
    for (const [label, text] of parts) list.append(el("dt", "", label), el("dd", "", text));
    inner.append(list);
    if (suggestion.commands.length > 0) {
      const buttons = el("div", "buttons");
      suggestion.commands.forEach((command, i) => {
        const button = el("button", i === 0 ? "button" : "button secondary", `Kopiera ${command}`);
        button.type = "button";
        button.dataset.copy = command;
        button.dataset.focus = `copy:${suggestion.id}:${command}`;
        buttons.append(button);
      });
      inner.append(buttons);
    }
    body.append(inner);

    const toggle = el("button", "suggestion-head");
    toggle.type = "button";
    toggle.dataset.focus = `toggle:${suggestion.id}`;
    toggle.setAttribute("aria-expanded", String(open));
    toggle.setAttribute("aria-controls", bodyId);
    toggle.append(
      el("span", "suggestion-tag", "Förslag"),
      el("span", "suggestion-title", suggestion.title),
      badge(suggestion.estimated ? "uppskattad" : "säker"),
      chevron(),
    );
    toggle.addEventListener("click", () => {
      const next = card.dataset.open !== "true";
      card.dataset.open = String(next);
      body.inert = !next;
      toggle.setAttribute("aria-expanded", String(next));
      ui.open[suggestion.id] = next;
      vscode.setState(ui);
    });

    card.append(toggle, body);
    wrap.append(card);
  }
  return wrap;
}

const MARK_SHAPES: Record<HealthMark, [keyof SVGElementTagNameMap, Record<string, string | number>][]> = {
  ok: [
    ["circle", { cx: 8, cy: 8, r: 6.2 }],
    ["path", { d: "m5.2 8.2 1.9 1.9 3.7-4" }],
  ],
  warning: [
    ["path", { d: "M8 2.2 14.3 13.3H1.7z" }],
    ["path", { d: "M8 6.4v3.3M8 11.4v.1" }],
  ],
  unknown: [
    ["circle", { cx: 8, cy: 8, r: 6.2 }],
    ["path", { d: "M6.3 6.4a1.8 1.8 0 1 1 2.5 1.6c-.5.2-.8.6-.8 1.1v.3M8 11.4v.1" }],
  ],
  unchecked: [
    ["circle", { cx: 8, cy: 8, r: 6.2, class: "dashed" }],
    ["path", { d: "M5.5 8h5" }],
  ],
};

/** The mark has a shape of its own, and the state is also written out, so color is never the only cue. */
function markIcon(mark: HealthMark): SVGSVGElement {
  const icon = svgEl("svg", { viewBox: "0 0 16 16", class: "health-mark", "aria-hidden": "true" });
  for (const [tag, attributes] of MARK_SHAPES[mark]) icon.append(svgEl(tag, attributes));
  return icon;
}

/** Backticks mark code; every part is still a text node. */
function richText(text: string): Node[] {
  return text.split("`").map((part, i) => (i % 2 === 1 ? el("code", "", part) : document.createTextNode(part)));
}

/** Decision 2026-09-15: always first in the view, and open by default only when something is wrong. */
function healthView(health: HealthModel): HTMLElement {
  const key = `health:${health.level}:${health.title}`;
  const saved = ui.open[key];
  const open = typeof saved === "boolean" ? saved : health.level === "warning";
  const card = el("div", `health level-${health.level}`);
  card.dataset.open = String(open);

  const body = el("div", "health-body");
  body.id = "health-body";
  body.inert = !open;
  const list = el("ul", "health-list");
  for (const check of health.checks) {
    const item = el("li", `health-check mark-${check.mark}`);
    const label = el("span", "health-label", check.label);
    label.append(el("span", "health-state", check.state));
    const detail = el("div", "health-detail");
    detail.append(...richText(check.detail));
    if (check.action !== null) {
      const action = el("div", "health-action");
      action.append(el("span", "health-action-label", "Åtgärd: "), ...richText(check.action));
      detail.append(action);
    }
    if (check.command !== null) {
      const button = el("button", "button", `Kopiera ${check.command}`);
      button.type = "button";
      button.dataset.copy = check.command;
      button.dataset.focus = `copy:health:${check.id}`;
      const buttons = el("div", "health-buttons");
      buttons.append(button);
      detail.append(buttons);
    }
    item.append(markIcon(check.mark), label, detail);
    list.append(item);
  }
  const inner = el("div", "health-inner");
  inner.append(list);
  body.append(inner);

  const toggle = el("button", "health-head");
  toggle.type = "button";
  toggle.dataset.focus = "toggle:health";
  toggle.setAttribute("aria-expanded", String(open));
  toggle.setAttribute("aria-controls", body.id);
  const tag = el("span", "health-tag");
  tag.append(markIcon(health.level === "warning" ? "warning" : "ok"), "Hälsa");
  toggle.append(tag, el("span", "health-title", health.title), el("span", "health-summary", health.summary), chevron());
  toggle.addEventListener("click", () => {
    const next = card.dataset.open !== "true";
    card.dataset.open = String(next);
    body.inert = !next;
    toggle.setAttribute("aria-expanded", String(next));
    ui.open[key] = next;
    vscode.setState(ui);
  });

  card.append(toggle, body);
  return card;
}

function render(model: ViewModel): void {
  const before = previous;
  previous = model;
  const active = document.activeElement;
  const focusKey = active instanceof HTMLElement ? active.dataset.focus : undefined;
  const scroll = document.scrollingElement?.scrollTop ?? 0;
  const health = model.health === null ? [] : [healthView(model.health)];

  if (model.unavailable !== null) {
    const box = el("div", "unavailable");
    box.append(heading("Tokeniser"), el("p", "", model.unavailable));
    root.replaceChildren(...health, box);
    return;
  }

  const top = el("div", "topline");
  if (model.updated !== null) top.append(el("span", "muted small", model.updated));
  const grid = el("div", "grid");
  grid.append(limitsView(model, before));
  const suggestions = suggestionsView(model.suggestions);
  if (suggestions !== null) grid.append(suggestions);
  grid.append(sessionView(model, before), historyView(model));
  root.replaceChildren(top, ...health, grid);
  drawCurve();

  if (focusKey !== undefined) root.querySelector<HTMLElement>(`[data-focus="${CSS.escape(focusKey)}"]`)?.focus();
  if (document.scrollingElement !== null) document.scrollingElement.scrollTop = scroll;
}

function markCopied(command: string): void {
  for (const button of root.querySelectorAll<HTMLButtonElement>("button[data-copy]")) {
    if (button.dataset.copy !== command) continue;
    button.textContent = "Kopierat";
    setTimeout(() => {
      button.textContent = `Kopiera ${command}`;
    }, 1500);
  }
}

root.addEventListener("click", (event) => {
  const target = event.target instanceof Element ? event.target : null;
  const command = target?.closest<HTMLButtonElement>("button[data-copy]")?.dataset.copy;
  if (command !== undefined) vscode.postMessage({ type: "copy", command });
});

window.addEventListener("message", (event: MessageEvent<ToWebview>) => {
  const message = event.data;
  if (message.type === "model") render(message.model);
  else if (message.type === "copied") markCopied(message.command);
});

/** The chart is laid out in the box's real pixels, so its text keeps its size in a wide column. */
function drawCurve(): void {
  const box = root.querySelector<HTMLElement>(".curve-box");
  if (box === null || previous === null) return;
  const width = Math.floor(box.clientWidth);
  if (width <= 0 || box.dataset.width === String(width)) return;
  box.dataset.width = String(width);
  box.replaceChildren(curveView(previous.history.days, width));
}

new ResizeObserver(() => drawCurve()).observe(root);

vscode.postMessage({ type: "ready" });
