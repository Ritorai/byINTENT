// User drawings on the chart (horizontal lines + trend lines), persisted per market.

/** "liq" isn't a drawing: it picks a bust price on the chart and sets the ticket's leverage. */
export type DrawTool = "hline" | "trend" | "liq" | null;

export type LineWidth = 1 | 2 | 3;

export interface DrawingStyle {
  width: LineWidth;
  dashed: boolean;
  color: string; // hex
}

export interface Anchor {
  t: number; // ms epoch
  p: number; // price
}

export interface HLine {
  id: string;
  kind: "hline";
  price: number;
  style: DrawingStyle;
}

export interface TrendLine {
  id: string;
  kind: "trend";
  a: Anchor;
  b: Anchor;
  extendLeft: boolean;
  extendRight: boolean;
  style: DrawingStyle;
}

export type Drawing = HLine | TrendLine;

export const SWATCHES = ["#5b8def", "#e6e9ef", "#ef4444", "#22c55e", "#f2b544", "#8b5cf6", "#ec4899", "#8a93a3"];

const KEY = "byintent.drawings.v1";

type Store = Record<string, Drawing[]>;

function readStore(): Store {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    const j = JSON.parse(raw);
    return j && typeof j === "object" ? (j as Store) : {};
  } catch {
    return {};
  }
}

export function loadDrawings(market: string): Drawing[] {
  const list = readStore()[market];
  return Array.isArray(list) ? list : [];
}

export function saveDrawings(market: string, drawings: Drawing[]) {
  try {
    const s = readStore();
    s[market] = drawings;
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* storage full / private mode */
  }
}

export function newId(): string {
  return Math.random().toString(36).slice(2, 10);
}

/** Pick dark/light text for a chip drawn in the given colour. */
export function contrastOn(hex: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return "#ffffff";
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return lum > 0.62 ? "#0f1419" : "#ffffff";
}
