import { useEffect, useRef } from "react";
import { TF_INTERVAL_MS, type Candle, type TickFeed, type Timeframe } from "./feed";
import type { Position } from "./position";
import { tr } from "./i18n";
import { cssVar } from "./theme";
import { contrastOn, newId, type Anchor, type DrawTool, type Drawing, type TrendLine } from "./drawings";

/** Hypothetical trade from the ticket (shown while the user hovers/edits it). */
export interface TradePreview {
  bust: number;
  isLong: boolean;
}

/** A trigger order waiting on the server, drawn as a level on the chart. */
export interface TriggerLine {
  id: string;
  kind: "entry" | "stop";
  price: number;
  isLong: boolean;
  /** entries only */
  leverage?: number;
  /** fired / in the queue — drawn faded, it is no longer waiting on price */
  pending?: boolean;
  /** parked after a restart or feed gap — needs a re-arm */
  attention?: boolean;
  /** does not exist yet: the stop an armed entry will spawn when it fills (estimated level) */
  ghost?: boolean;
}

/** Everything the render loop reads each frame, owned by App and mutated in place. */
export interface ChartState {
  feed: TickFeed;
  candles: Candle[];
  timeframe: Timeframe;
  /** all open positions on this market — every entry/liq is drawn */
  positions: Position[];
  /** pending trigger levels on this market (armed entries + stops) — dotted, accent colour */
  triggers?: TriggerLine[];
  /** preview LIQ line for the trade currently being set up in the ticket */
  preview: TradePreview | null;
  /** set by the chart: resets zoom/pan and re-follows the live edge */
  resetView?: () => void;
  /** chart → app: the view's left edge is near the oldest loaded candle — page in bars before `beforeT` */
  onNeedHistory?: (beforeT: number) => void;
  /** app → chart: true once the exchange has no candles before the oldest one we hold */
  historyExhausted?: boolean;
  /** chart → app: LIQ tool click — the user wants a trade that busts at this price */
  onLiqPick?: (price: number) => void;
  /** app → chart: leverage a trade opened now would need to bust at `price` (null = unreachable) */
  liqLeverageAt?: (price: number) => { leverage: number; isLong: boolean } | null;

  // ---- drawing tools ----
  drawings: Drawing[];
  tool: DrawTool;
  magnet: boolean;
  /** colour for newly placed lines (resolved from the theme by App) */
  drawColor: string;
  /** chart → app: the list changed (add / move / delete) */
  onDrawingsChange?: (next: Drawing[]) => void;
  /** chart → app: a drawing was placed (or placement cancelled) — app clears the tool */
  onToolDone?: () => void;
  /** chart → app: double-click on a drawing — app opens the style popup */
  onEditDrawing?: (id: string, at: { x: number; y: number }) => void;
}

const HIT_PX = 6; // hit-test tolerance for lines
const HANDLE_PX = 8; // and for endpoint handles
const EXTEND_PX = 6000; // "infinite" extension, clipped to the plot

// Chart palette comes from the active theme's CSS tokens (see styles.css);
// re-read whenever <html data-theme> changes.
interface Palette {
  bg: string;
  grid: string;
  ink: string;
  muted: string;
  axisText: string;
  red: string;
  green: string;
  entry: string;
  trigger: string;
  onChip: string;
  watermark: string;
  priceLine: string;
}
let paletteTheme = "";
let palette: Palette | null = null;
function currentPalette(): Palette {
  const t = document.documentElement.dataset.theme ?? "";
  if (palette && paletteTheme === t) return palette;
  paletteTheme = t;
  palette = {
    bg: cssVar("--chart-bg"),
    grid: cssVar("--chart-grid"),
    ink: cssVar("--chart-ink"),
    muted: cssVar("--chart-muted"),
    axisText: cssVar("--chart-muted"),
    red: cssVar("--neg"),
    green: cssVar("--pos"),
    entry: cssVar("--chart-muted"),
    trigger: cssVar("--accent"),
    onChip: cssVar("--chart-on-chip"),
    watermark: cssVar("--chart-watermark"),
    priceLine: cssVar("--chart-price-line"),
  };
  return palette;
}

export const AXIS_W = 92; // right price axis
export const TIME_AXIS_H = 20; // bottom time axis
const DATA_FRAC = 0.86; // latest data sits at this fraction of the plot; the rest is right-hand margin

const TF_MS = TF_INTERVAL_MS;
/** How many bars the chart may show at once; history is paged in from the right as the user zooms/pans. */
const MAX_BARS = 2000;
/** Ask for more history when the left edge is within this many bars of the oldest loaded candle. */
const HISTORY_MARGIN_BARS = 40;

function defaultSpan(tf: Timeframe): number {
  return tf === "Tick" ? 90_000 : 72 * TF_MS[tf];
}

function spanLimits(tf: Timeframe): [number, number] {
  // ticks: feed keeps ~5 min; candles: paged history up to MAX_BARS
  return tf === "Tick" ? [8_000, 310_000] : [8 * TF_MS[tf], MAX_BARS * TF_MS[tf]];
}

function niceStep(range: number): number {
  const raw = range / 6;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  for (const m of [1, 2, 2.5, 5, 10]) if (raw <= m * mag) return m * mag;
  return 10 * mag;
}

const DAY = 86_400_000;
const TIME_STEPS = [
  1_000, 2_000, 5_000, 10_000, 15_000, 30_000,
  60_000, 2 * 60_000, 5 * 60_000, 10 * 60_000, 15 * 60_000, 30 * 60_000,
  3_600_000, 2 * 3_600_000, 4 * 3_600_000, 6 * 3_600_000, 12 * 3_600_000,
  DAY, 2 * DAY, 7 * DAY, 14 * DAY, 30 * DAY, 61 * DAY, 91 * DAY, 182 * DAY, 365 * DAY, 730 * DAY,
];

function niceTimeStep(visSpan: number, plotW: number): number {
  for (const s of TIME_STEPS) if ((s / visSpan) * plotW >= 72) return s;
  return TIME_STEPS[TIME_STEPS.length - 1];
}

function fmtTime(t: number, step: number): string {
  const d = new Date(t);
  if (step < 60_000)
    return d.toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
  if (step < DAY)
    return d.toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit" });
  if (step < 30 * DAY) return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  if (step < 365 * DAY) return d.toLocaleDateString("en-US", { month: "short", year: "2-digit" });
  return d.toLocaleDateString("en-US", { year: "numeric" });
}

function fmtPrice(p: number): string {
  return p >= 1000
    ? p.toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 })
    : p.toFixed(2);
}

type Px = { x: number; y: number };

/** distance from point to segment ab */
function segDist(p: Px, a: Px, b: Px): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  let t = l2 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  const qx = a.x + t * dx;
  const qy = a.y + t * dy;
  return Math.hypot(p.x - qx, p.y - qy);
}

/** segment endpoints in pixels, extended "infinitely" when requested */
function trendSegment(a: Px, b: Px, extendLeft: boolean, extendRight: boolean): [Px, Px] {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len < 0.5) return [a, b];
  const ux = dx / len;
  const uy = dy / len;
  // "left" = toward the earlier anchor in screen x
  const aIsLeft = a.x <= b.x;
  const extA = aIsLeft ? extendLeft : extendRight;
  const extB = aIsLeft ? extendRight : extendLeft;
  const p = extA ? { x: a.x - ux * EXTEND_PX, y: a.y - uy * EXTEND_PX } : a;
  const q = extB ? { x: b.x + ux * EXTEND_PX, y: b.y + uy * EXTEND_PX } : b;
  return [p, q];
}

function dashFor(width: number): number[] {
  return [6 + width, 5 + width];
}

interface ChartProps {
  state: ChartState;
  /** fires when the viewport attaches to / detaches from the live edge */
  onFollowChange?: (follow: boolean) => void;
}

export default function Chart({ state, onFollowChange }: ChartProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const yRangeRef = useRef<{ lo: number; hi: number } | null>(null);
  const ySmoothRef = useRef<{ price: number | null }>({ price: null });
  const followCb = useRef(onFollowChange);
  followCb.current = onFollowChange;

  useEffect(() => {
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext("2d")!;
    let raf = 0;
    let w = 0;
    let h = 0;

    // ---- time viewport (zoom/pan) ----
    const view = {
      tf: null as Timeframe | null,
      span: 90_000, // visible span of *data* time (end-t0); the stage extends it visually
      end: 0,
      follow: true, // glued to live edge
      yZoom: 1, // price-range multiplier vs auto-fit: >1 wider (drag scale down), <1 magnified (drag up)
      yShift: 0, // vertical pan: price offset added to the auto-fit range (drag the plot up/down)
    };
    const isLive = () => view.follow && view.yZoom === 1 && view.yShift === 0;

    const ro = new ResizeObserver(() => {
      const dpr = window.devicePixelRatio || 1;
      const rect = canvas.getBoundingClientRect();
      w = rect.width;
      h = rect.height;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    });
    ro.observe(canvas);

    // ---- interactions: wheel zoom, drag pan, double-click reset ----
    const plotWNow = () => Math.max(50, w - AXIS_W);

    // <1 = magnify (drag the scale up: entry ↔ liq spread out), >1 = compress (drag down)
    const Y_ZOOM_MIN = 0.04;
    const Y_ZOOM_MAX = 40;
    const overAxis = (clientX: number) => clientX - canvas.getBoundingClientRect().left > plotWNow();

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      // over the price scale: wheel zooms the price range instead of time
      if (overAxis(e.clientX)) {
        view.yZoom = Math.min(Y_ZOOM_MAX, Math.max(Y_ZOOM_MIN, view.yZoom * Math.exp(e.deltaY * 0.002)));
        return;
      }
      const plotW = plotWNow();
      const [minSpan, maxSpan] = spanLimits(state.timeframe);
      const factor = Math.exp(e.deltaY * 0.0016);
      const span2 = Math.min(maxSpan, Math.max(minSpan, view.span * factor));
      if (span2 === view.span) return;
      const rect = canvas.getBoundingClientRect();
      const fx = Math.min(1, Math.max(0, (e.clientX - rect.left) / plotW));
      const visSpan = view.span / DATA_FRAC;
      const t0 = view.end - view.span;
      const tCursor = t0 + fx * visSpan;
      const visSpan2 = span2 / DATA_FRAC;
      view.end = tCursor - fx * visSpan2 + span2;
      view.span = span2;
      const now = Date.now();
      if (view.end > now) view.end = now;
      view.follow = view.end >= now - 400;
      maybeLoadHistory();
    };

    // ---- history paging: keep the screen filled to the left ----
    let lastHistoryReq = { t: 0, at: 0 };
    const maybeLoadHistory = () => {
      if (state.timeframe === "Tick" || state.historyExhausted || !state.onNeedHistory) return;
      const cs = state.candles;
      if (!cs.length) return;
      const oldest = cs[0].t;
      const t0 = view.end - view.span;
      if (t0 > oldest + HISTORY_MARGIN_BARS * TF_MS[state.timeframe]) return;
      const now = performance.now();
      if (lastHistoryReq.t === oldest && now - lastHistoryReq.at < 4000) return;
      lastHistoryReq = { t: oldest, at: now };
      state.onNeedHistory(oldest);
    };

    // ---- last frame's transform so pointer handlers can map px ⇄ (time, price) ----
    const xf = { t0: 0, visSpan: 1, plotW: 1, plotH: 1, rLo: 0, rHi: 1, ready: false };
    const xOfT = (t: number) => ((t - xf.t0) / xf.visSpan) * xf.plotW;
    const yOfP = (p: number) => xf.plotH - ((p - xf.rLo) / (xf.rHi - xf.rLo)) * xf.plotH;
    const tOfX = (x: number) => xf.t0 + (x / xf.plotW) * xf.visSpan;
    const pOfY = (y: number) => xf.rLo + ((xf.plotH - y) / xf.plotH) * (xf.rHi - xf.rLo);
    const localPx = (e: { clientX: number; clientY: number }): Px => {
      const r = canvas.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    const inPlot = (px: Px) => px.x >= 0 && px.x <= xf.plotW && px.y >= 0 && px.y <= xf.plotH;

    // ---- drawings: snapping, hit-testing, placement ----
    /** cursor → (time, price); with the magnet on, snaps to the nearest candle's O/H/L/C (or tick) */
    const snapAnchor = (px: Px): Anchor => {
      const raw: Anchor = { t: tOfX(px.x), p: pOfY(px.y) };
      if (!state.magnet) return raw;
      if (state.timeframe === "Tick") {
        let best: Anchor | null = null;
        let bd = Infinity;
        for (const tk of state.feed.ticks) {
          const d = Math.abs(xOfT(tk.t) - px.x);
          if (d < bd) {
            bd = d;
            best = { t: tk.t, p: tk.p };
          }
        }
        return best && bd <= 30 ? best : raw;
      }
      const iv = TF_MS[state.timeframe];
      const cs = state.candles;
      let cd = cs.find((c) => raw.t >= c.t && raw.t < c.t + iv) ?? null;
      if (!cd) {
        // off the data: nearest candle within one slot
        let bd = Infinity;
        for (const c of cs) {
          const d = Math.abs(c.t + iv / 2 - raw.t);
          if (d < bd) {
            bd = d;
            cd = c;
          }
        }
        if (!cd || bd > iv) return raw;
      }
      const latest = state.feed.latest;
      if (latest && cs.length && cd.t === cs[cs.length - 1].t) cd = liveCandle(cd, latest.p);
      let bestP = cd.o;
      let bd = Infinity;
      for (const v of [cd.o, cd.h, cd.l, cd.c]) {
        const d = Math.abs(yOfP(v) - px.y);
        if (d < bd) {
          bd = d;
          bestP = v;
        }
      }
      return { t: cd.t + iv / 2, p: bestP };
    };

    const drawingPx = (d: Drawing): [Px, Px] => {
      if (d.kind === "hline") {
        const y = yOfP(d.price);
        return [
          { x: 0, y },
          { x: xf.plotW, y },
        ];
      }
      return trendSegment(
        { x: xOfT(d.a.t), y: yOfP(d.a.p) },
        { x: xOfT(d.b.t), y: yOfP(d.b.p) },
        d.extendLeft,
        d.extendRight
      );
    };

    type Hit = { id: string; part: "body" | "a" | "b" };
    const hitDrawing = (px: Px): Hit | null => {
      if (!xf.ready || !inPlot(px)) return null;
      const ds = state.drawings;
      // endpoint handles win over bodies; topmost (last drawn) wins
      for (let i = ds.length - 1; i >= 0; i--) {
        const d = ds[i];
        if (d.kind !== "trend") continue;
        if (Math.hypot(xOfT(d.a.t) - px.x, yOfP(d.a.p) - px.y) <= HANDLE_PX) return { id: d.id, part: "a" };
        if (Math.hypot(xOfT(d.b.t) - px.x, yOfP(d.b.p) - px.y) <= HANDLE_PX) return { id: d.id, part: "b" };
      }
      for (let i = ds.length - 1; i >= 0; i--) {
        const [p, q] = drawingPx(ds[i]);
        if (segDist(px, p, q) <= HIT_PX) return { id: ds[i].id, part: "body" };
      }
      return null;
    };

    let selectedId: string | null = null;
    let pending: Anchor | null = null; // first anchor of a trend line being placed
    let hoverPx: Px | null = null;
    let toolSeen: DrawTool = null;

    const addDrawing = (d: Drawing) => {
      state.drawings.push(d);
      selectedId = d.id;
      state.onDrawingsChange?.([...state.drawings]);
      state.onToolDone?.();
    };

    const hoverCursor = (e: { clientX: number; clientY: number }) => {
      if (state.tool) return "crosshair";
      if (overAxis(e.clientX)) return "ns-resize";
      const hit = hitDrawing(localPx(e));
      return hit ? (hit.part === "body" ? "pointer" : "grab") : "grab";
    };

    let dragging: "time" | "price" | "drawing" | null = null;
    let dragHit: Hit | null = null;
    let downPx: Px | null = null;
    let lastAnchor: Anchor = { t: 0, p: 0 };
    let lastX = 0;
    let lastY = 0;
    let lastTapAt = 0;

    // ---- touch: two-finger pinch (horizontal = time zoom, vertical = price zoom) + pan ----
    const pointers = new Map<number, { x: number; y: number }>();
    let pinch: { span: number; yZoom: number; dx: number; dy: number; tMid: number } | null = null;
    const pinchGeom = () => {
      const [a, b] = [...pointers.values()];
      const r = canvas.getBoundingClientRect();
      return { dx: Math.abs(a.x - b.x), dy: Math.abs(a.y - b.y), midX: (a.x + b.x) / 2 - r.left };
    };
    const startPinch = () => {
      const g = pinchGeom();
      const fx = Math.min(1, Math.max(0, g.midX / plotWNow()));
      pinch = { span: view.span, yZoom: view.yZoom, dx: g.dx, dy: g.dy, tMid: view.end - view.span + fx * (view.span / DATA_FRAC) };
      // a second finger cancels whatever the first one was doing (drag / tool placement)
      dragging = null;
      dragHit = null;
      downPx = null;
      hoverPx = null;
    };
    const movePinch = () => {
      if (!pinch) return;
      const g = pinchGeom();
      const plotW = plotWNow();
      // vertical spread → price zoom (fingers apart = magnify, i.e. smaller yZoom)
      if (pinch.dy > 40 && g.dy > 10) {
        view.yZoom = Math.min(Y_ZOOM_MAX, Math.max(Y_ZOOM_MIN, pinch.yZoom * (pinch.dy / g.dy)));
      }
      // horizontal spread → time zoom, keeping the time under the fingers' midpoint fixed
      const [minSpan, maxSpan] = spanLimits(state.timeframe);
      let span2 = view.span;
      if (pinch.dx > 40 && g.dx > 10) span2 = Math.min(maxSpan, Math.max(minSpan, pinch.span * (pinch.dx / g.dx)));
      const fx = Math.min(1, Math.max(0, g.midX / plotW));
      view.end = pinch.tMid - fx * (span2 / DATA_FRAC) + span2;
      view.span = span2;
      const now = Date.now();
      if (view.end > now) view.end = now;
      view.follow = view.end >= now - 400;
      maybeLoadHistory();
    };

    const onPointerDown = (e: PointerEvent) => {
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      try {
        canvas.setPointerCapture(e.pointerId);
      } catch {
        /* synthetic / already-released pointer */
      }
      if (pointers.size === 2) {
        startPinch();
        return;
      }
      if (pointers.size > 2) return;
      lastX = e.clientX;
      lastY = e.clientY;
      downPx = localPx(e);
      if (overAxis(e.clientX)) {
        // grab the price scale: drag down = see more range, drag up = less
        dragging = "price";
        canvas.style.cursor = "ns-resize";
        return;
      }
      const hit = state.tool ? null : hitDrawing(downPx);
      if (hit) {
        dragging = "drawing";
        dragHit = hit;
        selectedId = hit.id;
        lastAnchor = { t: tOfX(downPx.x), p: pOfY(downPx.y) };
        canvas.style.cursor = "grabbing";
        return;
      }
      if (!state.tool) selectedId = null;
      dragging = "time";
      canvas.style.cursor = "grabbing";
    };
    const onPointerMove = (e: PointerEvent) => {
      if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pinch) {
        if (pointers.size >= 2) movePinch();
        return;
      }
      hoverPx = localPx(e);
      if (!dragging) {
        canvas.style.cursor = hoverCursor(e);
        return;
      }
      if (dragging === "drawing" && dragHit) {
        const d = state.drawings.find((x) => x.id === dragHit!.id);
        if (!d) return;
        const px = hoverPx;
        const cur: Anchor = { t: tOfX(px.x), p: pOfY(px.y) };
        if (d.kind === "hline") {
          d.price = state.magnet ? snapAnchor(px).p : d.price + (cur.p - lastAnchor.p);
        } else if (dragHit.part === "body") {
          const dt = cur.t - lastAnchor.t;
          const dp = cur.p - lastAnchor.p;
          d.a = { t: d.a.t + dt, p: d.a.p + dp };
          d.b = { t: d.b.t + dt, p: d.b.p + dp };
        } else {
          d[dragHit.part] = snapAnchor(px);
        }
        lastAnchor = cur;
        return;
      }
      if (dragging === "price") {
        const dy = e.clientY - lastY;
        lastY = e.clientY;
        view.yZoom = Math.min(Y_ZOOM_MAX, Math.max(Y_ZOOM_MIN, view.yZoom * Math.exp(dy * 0.006)));
        return;
      }
      // free drag: horizontal pans time, vertical pans price (content follows the pointer)
      const dx = e.clientX - lastX;
      const dy = e.clientY - lastY;
      lastX = e.clientX;
      lastY = e.clientY;
      if (xf.ready && dy) view.yShift += dy * ((xf.rHi - xf.rLo) / xf.plotH);
      const plotW = plotWNow();
      const msPerPx = view.span / DATA_FRAC / plotW;
      view.end -= dx * msPerPx;
      const now = Date.now();
      if (view.end > now) view.end = now;
      // don't pan further back than available data; for candles, more history is paged in
      // while panning left, so the clamp only bites once the exchange has nothing older
      const oldest =
        state.timeframe === "Tick"
          ? state.feed.ticks[0]?.t ?? now
          : state.candles[0]?.t ?? now;
      const canExtend = state.timeframe !== "Tick" && !state.historyExhausted;
      const floor = canExtend ? oldest - view.span * 0.5 : oldest + view.span * 0.25;
      if (view.end < floor) view.end = floor;
      view.follow = view.end >= now - 400;
      maybeLoadHistory();
    };
    const onPointerUp = (e: PointerEvent) => {
      pointers.delete(e.pointerId);
      try {
        canvas.releasePointerCapture(e.pointerId);
      } catch {
        /* not captured */
      }
      if (pinch) {
        // pinch ends when fewer than two fingers remain; the leftover finger starts fresh on its next move
        if (pointers.size < 2) {
          pinch = null;
          if (pointers.size === 1) {
            const [p] = [...pointers.values()];
            lastX = p.x;
            lastY = p.y;
            dragging = "time";
          }
        }
        return;
      }
      if (e.pointerType === "touch") hoverPx = null;
      const px = localPx(e);
      const moved = downPx ? Math.hypot(px.x - downPx.x, px.y - downPx.y) > 4 : false;
      // touch: double-tap on the plot = reset view (dblclick is unreliable with touch-action: none)
      if (e.pointerType === "touch" && downPx && !moved && !state.tool) {
        const now = performance.now();
        if (now - lastTapAt < 320) {
          lastTapAt = 0;
          resetView();
        } else lastTapAt = now;
      }
      // a click (not a drag) with a tool active places a point
      if (state.tool && downPx && !moved && xf.ready && inPlot(px)) {
        const pt = snapAnchor(px);
        if (state.tool === "liq") {
          state.onLiqPick?.(pt.p);
        } else if (state.tool === "hline") {
          addDrawing({ id: newId(), kind: "hline", price: pt.p, style: { width: 1, dashed: false, color: state.drawColor } });
        } else if (!pending) {
          pending = pt;
        } else if (Math.abs(xOfT(pending.t) - px.x) > 2 || Math.abs(yOfP(pending.p) - px.y) > 2) {
          const line: TrendLine = {
            id: newId(),
            kind: "trend",
            a: pending,
            b: pt,
            extendLeft: false,
            extendRight: false,
            style: { width: 1, dashed: false, color: state.drawColor },
          };
          pending = null;
          addDrawing(line);
        }
      }
      if (dragging === "drawing") state.onDrawingsChange?.([...state.drawings]);
      dragging = null;
      dragHit = null;
      downPx = null;
      canvas.style.cursor = hoverCursor(e);
    };
    const onPointerLeave = () => {
      hoverPx = null;
    };
    const resetView = () => {
      view.span = defaultSpan(state.timeframe);
      view.follow = true;
      view.end = Date.now();
      view.yZoom = 1;
      view.yShift = 0;
    };
    const onDblClick = (e: MouseEvent) => {
      if (state.tool) return;
      const hit = hitDrawing(localPx(e));
      if (hit) {
        selectedId = hit.id;
        state.onEditDrawing?.(hit.id, { x: e.clientX, y: e.clientY });
        return;
      }
      resetView();
    };
    const onKey = (e: KeyboardEvent) => {
      const tgt = e.target as HTMLElement | null;
      if (tgt && (tgt.tagName === "INPUT" || tgt.tagName === "TEXTAREA" || tgt.tagName === "SELECT" || tgt.isContentEditable)) return;
      if (e.key === "Escape") {
        if (pending || state.tool) {
          pending = null;
          state.onToolDone?.();
        } else selectedId = null;
      } else if ((e.key === "Delete" || e.key === "Backspace") && selectedId) {
        const next = state.drawings.filter((d) => d.id !== selectedId);
        selectedId = null;
        state.onDrawingsChange?.(next);
      }
    };
    state.resetView = resetView;
    let followReported = true;

    canvas.style.cursor = "grab";
    canvas.style.touchAction = "none"; // fingers drive the chart, not the page
    canvas.addEventListener("wheel", onWheel, { passive: false });
    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerup", onPointerUp);
    canvas.addEventListener("pointercancel", onPointerUp);
    canvas.addEventListener("pointerleave", onPointerLeave);
    canvas.addEventListener("dblclick", onDblClick);
    document.addEventListener("keydown", onKey);

    const chip = (x: number, y: number, text: string, bg: string, fgIn?: string, label?: string) => {
      const fg = fgIn ?? currentPalette().onChip;
      ctx.font = "600 11px ui-sans-serif, system-ui, sans-serif";
      const tw = ctx.measureText(text).width;
      const ch = 17;
      if (label) {
        ctx.font = "700 10px ui-sans-serif, system-ui, sans-serif";
        const lw = ctx.measureText(label).width;
        ctx.fillStyle = bg;
        ctx.fillRect(x - lw - 12, y - ch / 2, lw + 8, ch);
        ctx.fillStyle = fg;
        ctx.fillText(label, x - lw - 8, y + 3.5);
      }
      ctx.fillStyle = bg;
      ctx.beginPath();
      ctx.roundRect(x - 2, y - ch / 2, tw + 12, ch, 2);
      ctx.fill();
      ctx.fillStyle = fg;
      ctx.font = "600 11px ui-sans-serif, system-ui, sans-serif";
      ctx.fillText(text, x + 3, y + 3.5);
    };

    const dashedLine = (y: number, color: string, plotW: number, dash: number[] = [5, 4]) => {
      ctx.save();
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.setLineDash(dash);
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(plotW, y);
      ctx.stroke();
      ctx.restore();
    };

    const draw = () => {
      raf = requestAnimationFrame(draw);
      if (!w || !h) return;
      const { feed, candles, timeframe, positions, preview } = state;
      const triggers = state.triggers ?? [];
      const C = currentPalette();
      const now = Date.now();
      // the position closest to its bust at the current price drives the price-chip colour
      const latestNow = feed.latest;
      const position = latestNow ? nearestToBust(positions, latestNow.p) : positions[0] ?? null;
      const plotW = w - AXIS_W;
      const plotH = h - TIME_AXIS_H;

      // reset viewport when the timeframe changes
      if (view.tf !== timeframe) {
        view.tf = timeframe;
        view.span = defaultSpan(timeframe);
        view.follow = true;
        view.end = now;
        view.yZoom = 1;
        view.yShift = 0;
      }
      if (view.follow) view.end = now;
      // a wide window on a fresh load (or after a resize) may already need older bars
      maybeLoadHistory();
      if (isLive() !== followReported) {
        followReported = isLive();
        followCb.current?.(followReported);
      }

      const span = view.span;
      const tEnd = view.end;
      const t0 = tEnd - span;
      const visSpan = span / DATA_FRAC; // time span across the whole plot width
      const tVisEnd = t0 + visSpan; // right edge of the plot in time
      const xOf = (t: number) => ((t - t0) / visSpan) * plotW;

      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = C.bg;
      ctx.fillRect(0, 0, w, h);

      // watermark
      ctx.fillStyle = C.watermark;
      ctx.font = "700 52px ui-sans-serif, system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("byINTENT", plotW / 2, plotH / 2 + 18);
      ctx.textAlign = "left";

      // ---- collect visible series & compute target y-range ----
      const ticks = feed.ticks;
      const latest = feed.latest;
      let lo = Infinity;
      let hi = -Infinity;
      type Pt = { x: number; y: number };
      let steps: { t: number; p: number }[] = [];
      let visCandles: Candle[] = [];
      const tfInterval = timeframe === "Tick" ? 0 : TF_MS[timeframe];

      // draw across the FULL plot width — when following, the region right of the
      // live edge is simply empty margin; when panned back it's data.
      if (timeframe === "Tick") {
        steps = ticks.filter((tk) => tk.t >= t0 && tk.t <= tVisEnd);
        for (const tk of steps) {
          if (tk.p < lo) lo = tk.p;
          if (tk.p > hi) hi = tk.p;
        }
      } else {
        visCandles = candles.filter((cd) => cd.t + tfInterval >= t0 && cd.t <= tVisEnd);
        for (const cd of visCandles) {
          if (cd.l < lo) lo = cd.l;
          if (cd.h > hi) hi = cd.h;
        }
      }
      if (latest && view.follow) {
        if (latest.p < lo) lo = latest.p;
        if (latest.p > hi) hi = latest.p;
      }
      if (!Number.isFinite(lo)) {
        // no data in view yet
        ctx.fillStyle = C.muted;
        ctx.font = "13px ui-sans-serif, system-ui, sans-serif";
        ctx.fillText(tr("chart.loading"), 24, 32);
        return;
      }

      // include entry/liq lines if they're not absurdly far (keeps sane zoom at low leverage).
      // The ticket's hypothetical LIQ preview is deliberately NOT part of the fit: it
      // appears/disappears as the pointer crosses the ticket, and rescaling the chart
      // for it made the price range jump every time. Off-screen previews are flagged
      // with a clamped chip on the axis instead.
      const dataSpan = Math.max(hi - lo, latest ? latest.p * 0.0004 : 1);
      const levels: number[] = [];
      for (const p of positions) levels.push(p.entry, p.liq);
      // waiting trigger levels count too (fired ones no longer matter to the fit)
      for (const tl of triggers) if (!tl.pending && !tl.ghost) levels.push(tl.price);
      for (const lvl of levels) {
        if (lvl > lo - dataSpan * 4 && lvl < hi + dataSpan * 4) {
          if (lvl < lo) lo = lvl;
          if (lvl > hi) hi = lvl;
        }
      }
      const pad = (hi - lo) * 0.18 + dataSpan * 0.05;
      let tLo = lo - pad;
      let tHi = hi + pad;
      // manual price-scale zoom. Compressing (>1) widens about the auto-fit centre;
      // magnifying (<1) drifts the centre toward the live price — or the midpoint
      // between it and the nearest entry/liq level in view — so what you're trying
      // to enlarge stays on screen instead of sliding off the edge.
      if (view.yZoom !== 1) {
        const mid = (tLo + tHi) / 2;
        let centre = mid;
        if (view.yZoom < 1 && latest) {
          let anchor = latest.p;
          const inView = levels.filter((l) => l >= lo && l <= hi);
          if (inView.length) {
            const nearest = inView.reduce((a, b) => (Math.abs(b - latest.p) < Math.abs(a - latest.p) ? b : a));
            anchor = (latest.p + nearest) / 2;
          }
          centre = mid + (anchor - mid) * (1 - view.yZoom);
        }
        const half = ((tHi - tLo) / 2) * view.yZoom;
        tLo = centre - half;
        tHi = centre + half;
      }
      // vertical pan (relative to the auto-fit range, so it keeps tracking the data while live)
      tLo += view.yShift;
      tHi += view.yShift;

      // smooth the range so rescaling doesn't jump — but track the pointer tightly while dragging
      const cur = yRangeRef.current;
      const ease = dragging || pinch ? 0.6 : 0.12;
      if (!cur) yRangeRef.current = { lo: tLo, hi: tHi };
      else {
        cur.lo += (tLo - cur.lo) * ease;
        cur.hi += (tHi - cur.hi) * ease;
      }
      const { lo: rLo, hi: rHi } = yRangeRef.current!;
      const yOf = (p: number) => plotH - ((p - rLo) / (rHi - rLo)) * plotH;
      // publish the transform for the pointer handlers
      xf.t0 = t0;
      xf.visSpan = visSpan;
      xf.plotW = plotW;
      xf.plotH = plotH;
      xf.rLo = rLo;
      xf.rHi = rHi;
      xf.ready = true;
      if (state.tool !== toolSeen) {
        toolSeen = state.tool;
        pending = null;
      }

      // ---- horizontal grid + price labels ----
      const step = niceStep(rHi - rLo);
      ctx.font = "11px ui-sans-serif, system-ui, sans-serif";
      for (let p = Math.ceil(rLo / step) * step; p <= rHi; p += step) {
        const y = yOf(p);
        dashedLine(y, C.grid, plotW, [2, 4]);
        ctx.fillStyle = C.axisText;
        ctx.fillText(fmtPrice(p), plotW + 8, y + 3.5);
      }

      // ---- vertical grid + time labels ----
      const tStep = niceTimeStep(visSpan, plotW);
      ctx.font = "10.5px ui-sans-serif, system-ui, sans-serif";
      ctx.textAlign = "center";
      for (let t = Math.ceil(t0 / tStep) * tStep; t <= t0 + visSpan; t += tStep) {
        const x = xOf(t);
        if (x < 2 || x > plotW - 2) continue;
        ctx.save();
        ctx.strokeStyle = C.grid;
        ctx.lineWidth = 1;
        ctx.setLineDash([2, 4]);
        ctx.beginPath();
        ctx.moveTo(x + 0.5, 0);
        ctx.lineTo(x + 0.5, plotH);
        ctx.stroke();
        ctx.restore();
        ctx.fillStyle = t > now ? C.grid : C.axisText;
        ctx.fillText(fmtTime(t, tStep), x, h - 6);
      }
      ctx.textAlign = "left";

      // ---- series ----
      if (timeframe === "Tick") {
        if (steps.length) {
          ctx.strokeStyle = C.ink;
          ctx.lineWidth = 1.6;
          ctx.beginPath();
          let prev: Pt | null = null;
          for (const tk of steps) {
            const x = xOf(tk.t);
            const y = yOf(tk.p);
            if (!prev) ctx.moveTo(x, y);
            else {
              ctx.lineTo(x, prev.y); // step line, like papertrade's tick chart
              ctx.lineTo(x, y);
            }
            prev = { x, y };
          }
          ctx.stroke();
          if (prev && view.follow) {
            ctx.fillStyle = C.ink;
            ctx.beginPath();
            ctx.arc(prev.x, prev.y, 3.5, 0, Math.PI * 2);
            ctx.fill();
          }
        }
      } else if (visCandles.length) {
        // bodies span the whole slot so neighbouring candles always touch
        const slot = (tfInterval / visSpan) * plotW;
        const bw = Math.max(1, slot);
        const lastT = candles.length ? candles[candles.length - 1].t : -1;
        ctx.lineWidth = 1;
        for (const cd0 of visCandles) {
          const cd = cd0.t === lastT && latest ? liveCandle(cd0, latest.p) : cd0;
          const x0 = xOf(cd.t);
          const cx = Math.round(x0 + bw / 2) + 0.5;
          const up = cd.c >= cd.o;
          ctx.strokeStyle = C.ink;
          ctx.beginPath();
          ctx.moveTo(cx, yOf(cd.h));
          ctx.lineTo(cx, yOf(cd.l));
          ctx.stroke();
          const yO = yOf(cd.o);
          const yC = yOf(cd.c);
          const top = Math.min(yO, yC);
          const bh = Math.max(1, Math.abs(yO - yC));
          const bx = Math.round(x0);
          const bwPx = Math.max(1, Math.round(x0 + bw) - bx);
          if (up) {
            ctx.fillStyle = C.bg;
            ctx.fillRect(bx, top, bwPx, bh);
            if (bwPx > 2) ctx.strokeRect(bx + 0.5, top + 0.5, bwPx - 1, Math.max(1, bh - 1));
            else {
              ctx.fillStyle = C.ink;
              ctx.fillRect(bx, top, bwPx, bh);
            }
          } else {
            ctx.fillStyle = C.ink;
            ctx.fillRect(bx, top, bwPx, bh);
          }
        }
      }

      // ---- user drawings ----
      const strokeSeg = (p: Px, q: Px, color: string, width: number, dashed: boolean, alpha = 1) => {
        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.strokeStyle = color;
        ctx.lineWidth = width;
        ctx.lineCap = "round";
        if (dashed) ctx.setLineDash(dashFor(width));
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(q.x, q.y);
        ctx.stroke();
        ctx.restore();
      };
      const handle = (p: Px, color: string) => {
        ctx.save();
        ctx.fillStyle = C.bg;
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        ctx.restore();
      };
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, plotW, plotH);
      ctx.clip();
      for (const d of state.drawings) {
        const [p, q] = drawingPx(d);
        const sel = d.id === selectedId;
        if (sel) strokeSeg(p, q, d.style.color, d.style.width + 6, false, 0.12);
        strokeSeg(p, q, d.style.color, d.style.width, d.style.dashed);
        if (sel) {
          if (d.kind === "hline") handle({ x: plotW / 2, y: p.y }, d.style.color);
          else {
            handle({ x: xOfT(d.a.t), y: yOfP(d.a.p) }, d.style.color);
            handle({ x: xOfT(d.b.t), y: yOfP(d.b.p) }, d.style.color);
          }
        }
      }
      // crosshair + snap marker while a tool is armed
      const toolHover = state.tool && hoverPx && inPlot(hoverPx) ? hoverPx : null;
      const snapPt = toolHover ? snapAnchor(toolHover) : null;
      const liqHover = state.tool === "liq" && snapPt ? state.liqLeverageAt?.(snapPt.p) ?? null : null;
      if (toolHover && snapPt) {
        const sx = xOfT(snapPt.t);
        const sy = yOfP(snapPt.p);
        ctx.save();
        ctx.strokeStyle = state.tool === "liq" ? C.red : C.muted;
        ctx.globalAlpha = state.tool === "liq" ? 0.7 : 0.5;
        ctx.lineWidth = 1;
        ctx.setLineDash(state.tool === "liq" ? [6, 8] : [3, 3]);
        ctx.beginPath();
        ctx.moveTo(0, Math.round(sy) + 0.5);
        ctx.lineTo(plotW, Math.round(sy) + 0.5);
        if (state.tool === "trend") {
          ctx.moveTo(Math.round(sx) + 0.5, 0);
          ctx.lineTo(Math.round(sx) + 0.5, plotH);
        }
        ctx.stroke();
        ctx.restore();
        if (state.magnet) handle({ x: sx, y: sy }, state.drawColor);
        // first anchor → cursor preview
        if (pending && state.tool === "trend") {
          const a = { x: xOfT(pending.t), y: yOfP(pending.p) };
          strokeSeg(a, { x: sx, y: sy }, state.drawColor, 1, true, 0.85);
          handle(a, state.drawColor);
        }
      } else if (pending && state.tool === "trend") {
        handle({ x: xOfT(pending.t), y: yOfP(pending.p) }, state.drawColor);
      }
      ctx.restore();
      // price labels on the axis for horizontal lines (and the armed crosshair)
      for (const d of state.drawings) {
        if (d.kind === "hline" && d.price > rLo && d.price < rHi)
          chip(plotW + 4, yOf(d.price), fmtPrice(d.price), d.style.color, contrastOn(d.style.color));
      }
      if (snapPt && state.tool === "liq") {
        chip(plotW + 4, yOf(snapPt.p), fmtPrice(snapPt.p), C.red, undefined, liqHover ? `${liqHover.isLong ? "LONG" : "SHORT"} ×${liqHover.leverage}` : "LIQ —");
      } else if (snapPt) chip(plotW + 4, yOf(snapPt.p), fmtPrice(snapPt.p), C.muted);

      // ---- preview LIQ line (hypothetical trade from the ticket) ----
      // pulses like papertrade's: alpha 0.3 + 0.2·sin(t/300), 1.5px, dash 6/8
      if (preview) {
        const inRange = preview.bust > rLo && preview.bust < rHi;
        ctx.save();
        if (inRange) {
          const yB = yOf(preview.bust);
          ctx.globalAlpha = 0.3 + 0.2 * Math.sin(now / 300);
          ctx.strokeStyle = C.red;
          ctx.lineWidth = 1.5;
          ctx.setLineDash([6, 8]);
          ctx.beginPath();
          ctx.moveTo(0, yB);
          ctx.lineTo(plotW, yB);
          ctx.stroke();
          ctx.globalAlpha = 0.9;
          chip(plotW + 4, yB, fmtPrice(preview.bust), C.red, undefined, "LIQ");
        } else {
          // bust is off-screen: pin the chip to the axis edge with an arrow instead of
          // rescaling the chart to reach it
          const below = preview.bust <= rLo;
          const yB = below ? plotH - 10 : 10;
          ctx.globalAlpha = 0.9;
          chip(plotW + 4, yB, `${below ? "▼" : "▲"} ${fmtPrice(preview.bust)}`, C.red, undefined, "LIQ");
        }
        ctx.restore();
      }

      // ---- position lines: every open position; the one nearest its bust at full strength,
      //      the rest slightly faded. With several, chips carry the leverage so they're tellable apart.
      if (positions.length) {
        const multi = positions.length > 1;
        // draw the focused one last so its chips sit on top
        const ordered = [...positions.filter((p) => p !== position), ...(position ? [position] : [])];
        for (const p of ordered) {
          const focus = p === position;
          const yE = yOf(p.entry);
          const yL = yOf(p.liq);
          const lev = multi ? ` ${p.leverage}×` : "";
          ctx.save();
          ctx.globalAlpha = focus ? 1 : 0.55;
          dashedLine(yE, C.muted, plotW, focus ? [6, 4] : [3, 4]);
          chip(plotW + 4, yE, fmtPrice(p.entry), C.entry, undefined, `ENTRY${lev}`);
          dashedLine(yL, C.red, plotW, focus ? [6, 4] : [3, 4]);
          chip(plotW + 4, yL, fmtPrice(p.liq), C.red, undefined, `LIQ${lev}`);
          ctx.restore();
        }
      }

      // ---- trigger lines: orders waiting on the server. Dotted in the accent colour so
      //      they read as "not a position yet" next to the dashed grey ENTRY / red LIQ.
      //      Off-screen levels get a pinned arrow chip on the axis (a far-away buy level
      //      is the normal case for an entry trigger).
      let pinnedAbove = 0;
      let pinnedBelow = 0;
      for (const tl of triggers) {
        const label =
          tl.kind === "stop"
            ? tl.ghost ? "STOP · ON FILL" : tl.attention ? "STOP !" : "STOP"
            : `${tl.attention ? "! " : ""}TRIG ${tl.isLong ? "⬈" : "⬊"}${tl.leverage ? ` ${tl.leverage}×` : ""}`;
        const inRange = tl.price > rLo && tl.price < rHi;
        ctx.save();
        ctx.globalAlpha = tl.pending || tl.ghost ? 0.4 : tl.attention ? 0.55 + 0.25 * Math.sin(now / 250) : 0.95;
        if (inRange) {
          const y = Math.round(yOf(tl.price)) + 0.5;
          ctx.strokeStyle = C.trigger;
          ctx.lineWidth = tl.pending || tl.ghost ? 1 : 1.5;
          ctx.setLineDash(tl.ghost ? [1, 5] : [2, 4]);
          ctx.lineCap = "round";
          ctx.beginPath();
          ctx.moveTo(0, y);
          ctx.lineTo(plotW, y);
          ctx.stroke();
          chip(plotW + 4, y, fmtPrice(tl.price), C.trigger, undefined, label);
        } else if (!tl.pending && !tl.ghost) {
          const below = tl.price <= rLo;
          // stack several pinned chips instead of painting them over each other
          const y = below ? plotH - 28 - 20 * pinnedBelow++ : 28 + 20 * pinnedAbove++;
          chip(plotW + 4, y, `${below ? "▼" : "▲"} ${fmtPrice(tl.price)}`, C.trigger, undefined, label);
        }
        ctx.restore();
      }

      // ---- current price line + chip ----
      if (latest) {
        const sm = ySmoothRef.current;
        const yTarget = yOf(latest.p);
        sm.price = sm.price == null ? yTarget : sm.price + (yTarget - sm.price) * 0.35;
        const yP = sm.price;
        dashedLine(yP, C.priceLine, plotW, [1, 3]);
        const inProfit = position
          ? (latest.p - position.entry) * (position.side === "long" ? 1 : -1) >= 0
          : true;
        chip(plotW + 4, yP, fmtPrice(latest.p), position ? (inProfit ? C.green : C.red) : C.ink);
      }

      // axis separator
      ctx.strokeStyle = C.grid;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(plotW + 0.5, 0);
      ctx.lineTo(plotW + 0.5, h);
      ctx.moveTo(0, plotH + 0.5);
      ctx.lineTo(plotW, plotH + 0.5);
      ctx.stroke();
    };

    raf = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      canvas.removeEventListener("wheel", onWheel);
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("pointercancel", onPointerUp);
      canvas.removeEventListener("pointerleave", onPointerLeave);
      canvas.removeEventListener("dblclick", onDblClick);
      document.removeEventListener("keydown", onKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <canvas ref={canvasRef} className="trade-chart-canvas" />;
}

function liveCandle(cd: Candle, price: number): Candle {
  return { ...cd, c: price, h: Math.max(cd.h, price), l: Math.min(cd.l, price) };
}

/** The open position whose bust price is nearest the current price (relative distance). */
function nearestToBust(positions: Position[], price: number): Position | null {
  if (!positions.length) return null;
  const dist = (p: Position) => Math.abs(price - p.liq) / Math.max(price, 1e-9);
  let best = positions[0];
  for (const p of positions) if (dist(p) < dist(best)) best = p;
  return best;
}
