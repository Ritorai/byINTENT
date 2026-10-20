// byINTENT — one screen: chart, ticket, positions bar. Market and trigger orders on
// Papertrade (HyperEVM). Triggers are evaluated and fired by the watcher process
// (server/SPEC.md); this app only arms, lists and cancels them.

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useAccount } from "wagmi";
import Chart, { type ChartState, type TradePreview, type TriggerLine } from "./Chart";
import DrawingPopup from "./DrawingPopup";
import { loadDrawings, saveDrawings, type DrawTool, type Drawing } from "./drawings";
import { MARKETS, TIMEFRAMES, TickFeed, fetchCandles, fetchLatestPrice, type MarketKey, type Timeframe } from "./feed";
import Funding, { type FundingMode } from "./Funding";
import { useI18n, type Key as I18nKey } from "./i18n";
import { useWalletStream, type ClosedPosition } from "./liveAccount";
import type { Position } from "./position";
import { fetchMarketStats, fetchTradingState, fmtPrice, fmtUsd, type TradingState } from "./protocol";
import { cssVar, useTheme } from "./theme";
import Ticket from "./Ticket";
import TradeBar from "./TradeBar";
import { TRIGGER_ERROR_KEYS, attachedStopLevel, attachedTpLevel, exitOf } from "../shared/triggerLogic";
import { RemoteTriggerStore, type ApiResult, type ArmEntrySpec, type PriceSample, type TriggerEntry, type TriggerEvent } from "./triggerApi";
import { useCandleHistory } from "./useCandles";
import { ConnectControls } from "./wallet";

const noSubscribe = () => () => {};
const zeroVersion = () => 0;

// ---- resizable layout (right panel width / bottom bar height), persisted ----
const LAYOUT_KEY = "byintent.layout.v1";
const BAR_MIN = 150; // = .tradebar min-height
const MAIN_MIN = 395; // chart-wrap min-height + borders — the middle row never gets smaller
const PANEL_MIN = 300; // ticket must stay wide enough for every field (ladder, size, lev)
const panelMin = () => Math.max(PANEL_MIN, Math.min(320, window.innerWidth * 0.22));
interface Layout {
  panelW: number | null;
  barH: number | null;
}
function readLayout(): Layout {
  try {
    const j = JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? "{}");
    return {
      panelW: typeof j.panelW === "number" ? Math.max(j.panelW, PANEL_MIN) : null,
      barH: typeof j.barH === "number" ? j.barH : null,
    };
  } catch {
    return { panelW: null, barH: null };
  }
}
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

// phone: chart pill collapses to a timeframe dropdown — must match styles.css
const PHONE_MQ = "(max-width: 760px)";
function useMediaQuery(query: string): boolean {
  const [match, setMatch] = useState(() => (typeof matchMedia === "function" ? matchMedia(query).matches : false));
  useEffect(() => {
    const mq = matchMedia(query);
    const on = () => setMatch(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [query]);
  return match;
}

const ToolIcon = {
  hline: (
    <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden>
      <path d="M2 10h16" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" fill="none" />
      <circle cx="10" cy="10" r="2.4" fill="var(--panel)" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  ),
  trend: (
    <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden>
      <path d="M4 16L16 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" fill="none" />
      <circle cx="4.5" cy="15.5" r="2.2" fill="var(--panel)" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="15.5" cy="4.5" r="2.2" fill="var(--panel)" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  ),
  magnet: (
    <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden>
      <path d="M5 3v7a5 5 0 0 0 10 0V3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" fill="none" />
      <path d="M3.6 3h3.2M13.2 3h3.2" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <path d="M5 7.5h3M12 7.5h3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  ),
  liq: <span className="dtool-text">LIQ</span>,
};

/**
 * Leverage a trade opened at `price` needs so that its bust price lands exactly on `target`
 * — the inverse of protocol.bustPrice(). Side is implied by where the target sits: below
 * the live price → long, above → short. Returns null when the target is unreachable.
 */
export function leverageForBust(
  price: number,
  target: number,
  buffer: number,
  maxLev: number
): { leverage: number; isLong: boolean } | null {
  if (!(price > 0) || !(target > 0) || target === price) return null;
  const isLong = target < price;
  const inv = isLong ? 1 - target / (price * (1 + buffer)) : target / (price * (1 - buffer)) - 1;
  if (!(inv > 0)) return null;
  const leverage = Math.round(1 / inv);
  if (!Number.isFinite(leverage)) return null;
  return { leverage: Math.max(1, Math.min(maxLev, leverage)), isLong };
}

export default function App() {
  const { address, isConnected } = useAccount();
  const [theme, setTheme] = useTheme();
  const { t } = useI18n();
  const phone = useMediaQuery(PHONE_MQ);
  const [tfMenu, setTfMenu] = useState(false);
  const tfRef = useRef<HTMLDivElement>(null);
  const [market, setMarket] = useState<MarketKey>("BTC");
  const [timeframe, setTimeframe] = useState<Timeframe>("Tick");
  const [proto, setProto] = useState<TradingState | null>(null);
  const [volumes, setVolumes] = useState<Record<number, number>>({});
  const [changes, setChanges] = useState<Record<number, number>>({});
  const [lastPrice, setLastPrice] = useState<number | null>(null);
  const [lastTickAt, setLastTickAt] = useState(0);
  const [marks, setMarks] = useState<Record<number, number>>({});
  const marksRef = useRef(marks);
  marksRef.current = marks;
  const [funding, setFunding] = useState<FundingMode>(null);
  const [notices, setNotices] = useState<{ id: number; msg: string }[]>([]);
  /** realized PnL by positionId from the live stream's closed frames (executed-stop display) */
  const [closedPnl, setClosedPnl] = useState<Record<string, number>>({});
  const [following, setFollowing] = useState(true);
  const [marketMenu, setMarketMenu] = useState(false);
  const change24h = changes[MARKETS[market].id] ?? null;
  const marketPillRef = useRef<HTMLDivElement>(null);

  // ---- drawing tools ----
  const [tool, setTool] = useState<DrawTool>(null);
  const [magnet, setMagnet] = useState(false);
  const [drawings, setDrawings] = useState<Drawing[]>(() => loadDrawings("BTC"));
  const [editing, setEditing] = useState<{ id: string; at: { x: number; y: number } } | null>(null);
  const chartBodyRef = useRef<HTMLDivElement>(null);

  // ---- resizable layout ----
  const [layout, setLayout] = useState<Layout>(readLayout);
  const [resizing, setResizing] = useState<"v" | "h" | null>(null);
  const mainRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const barRef = useRef<HTMLElement>(null);
  useEffect(() => {
    try {
      localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout));
    } catch {
      /* private mode */
    }
  }, [layout]);
  const startResize = (axis: "v" | "h") => (e: ReactPointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startY = e.clientY;
    let min: number;
    let max: number;
    let start: number;
    if (axis === "v") {
      start = panelRef.current?.offsetWidth ?? panelMin();
      min = panelMin();
      max = Math.max(min, window.innerWidth * 0.5);
    } else {
      start = barRef.current?.offsetHeight ?? BAR_MIN;
      min = BAR_MIN;
      const mainH = mainRef.current?.offsetHeight ?? MAIN_MIN;
      max = Math.max(min, start + (mainH - MAIN_MIN));
    }
    const onMove = (ev: PointerEvent) => {
      if (axis === "v") setLayout((l) => ({ ...l, panelW: Math.round(clamp(start + (startX - ev.clientX), min, max)) }));
      else setLayout((l) => ({ ...l, barH: Math.round(clamp(start + (startY - ev.clientY), min, max)) }));
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      setResizing(null);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    setResizing(axis);
  };
  useEffect(() => {
    if (!resizing) return;
    document.body.style.cursor = resizing === "h" ? "row-resize" : "col-resize";
    document.body.style.userSelect = "none";
    return () => {
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, [resizing]);

  // close the menus on any outside pointerdown / Escape
  useEffect(() => {
    if (!marketMenu && !tfMenu) return;
    const onDown = (e: PointerEvent) => {
      const tgt = e.target as Node | null;
      if (marketMenu && !marketPillRef.current?.contains(tgt)) setMarketMenu(false);
      if (tfMenu && !tfRef.current?.contains(tgt)) setTfMenu(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setMarketMenu(false);
      setTfMenu(false);
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [marketMenu, tfMenu]);

  const pushNotice = useCallback((msg: string) => {
    const id = Date.now() + Math.random();
    setNotices((n) => [...n, { id, msg }].slice(-4));
    setTimeout(() => setNotices((n) => n.filter((x) => x.id !== id)), 7000);
  }, []);

  // Mutable state bag read by the canvas render loop every frame.
  const chartState = useRef<ChartState>({
    feed: new TickFeed(MARKETS.BTC.id),
    candles: [],
    timeframe: "Tick",
    positions: [],
    preview: null,
    drawings: [],
    tool: null,
    magnet: false,
    drawColor: "#5b8def",
  });
  const setPreview = useCallback((p: TradePreview | null) => {
    chartState.current.preview = p;
  }, []);

  // drawings: React state is the source of truth; the canvas reads a mirror each frame
  const marketRef = useRef(market);
  marketRef.current = market;
  useEffect(() => {
    chartState.current.drawings = drawings;
    saveDrawings(marketRef.current, drawings);
  }, [drawings]);
  useEffect(() => {
    setDrawings(loadDrawings(market));
    setEditing(null);
  }, [market]);
  useEffect(() => {
    chartState.current.tool = tool;
    chartState.current.magnet = magnet;
  }, [tool, magnet]);
  useEffect(() => {
    chartState.current.drawColor = cssVar("--accent") || "#5b8def";
  }, [theme]);
  useEffect(() => {
    const cs = chartState.current;
    cs.onDrawingsChange = (next) => setDrawings(next);
    cs.onToolDone = () => setTool(null);
    cs.onEditDrawing = (id, at) => {
      const r = chartBodyRef.current?.getBoundingClientRect();
      setEditing({ id, at: { x: at.x - (r?.left ?? 0), y: at.y - (r?.top ?? 0) } });
    };
  }, []);
  // LIQ tool: click a price on the chart → leverage that busts exactly there → ticket
  const [liqSet, setLiqSet] = useState<{ leverage: number; isLong: boolean; nonce: number } | null>(null);
  const liqCtx = useRef<{ price: number | null; buffer: number; maxLev: number }>({ price: null, buffer: 0, maxLev: 1000 });
  useEffect(() => {
    const cs = chartState.current;
    cs.liqLeverageAt = (target) => {
      const { price, buffer, maxLev } = liqCtx.current;
      return price ? leverageForBust(price, target, buffer, maxLev) : null;
    };
    cs.onLiqPick = (target) => {
      const { price, buffer, maxLev } = liqCtx.current;
      const r = price ? leverageForBust(price, target, buffer, maxLev) : null;
      if (!r) {
        pushNotice(t("liq.cant"));
        return;
      }
      setLiqSet({ ...r, nonce: Date.now() });
      pushNotice(t("liq.set", { side: t(r.isLong ? "side.long" : "side.short"), lev: r.leverage, price: fmtPrice(target) }));
      setTool(null);
    };
  }, [pushNotice, t]);
  const editingDrawing = editing ? drawings.find((d) => d.id === editing.id) ?? null : null;
  const closeEditor = useCallback(() => setEditing(null), []);

  // ---- feed lifecycle ----
  useEffect(() => {
    const feed = new TickFeed(MARKETS[market].id);
    chartState.current.feed = feed;
    const known = marksRef.current[MARKETS[market].id];
    setLastPrice(known ?? null);
    if (known) document.title = `$${fmtPrice(known)} · ${market} · byINTENT`;
    feed.onTick = (tick) => {
      setLastPrice(tick.p);
      setLastTickAt(Date.now());
      setMarks((m) => (m[MARKETS[market].id] === tick.p ? m : { ...m, [MARKETS[market].id]: tick.p }));
      document.title = `$${fmtPrice(tick.p)} · ${market} · byINTENT`;
    };
    feed.start();
    return () => feed.stop();
  }, [market]);

  // ---- protocol state + volumes ----
  useEffect(() => {
    let dead = false;
    const load = () => {
      fetchTradingState().then((s) => !dead && setProto(s)).catch(() => {});
      fetchMarketStats().then((v) => !dead && setVolumes(v)).catch(() => {});
    };
    load();
    const id = setInterval(load, 10_000);
    return () => {
      dead = true;
      clearInterval(id);
    };
  }, []);

  // ---- 24h change + mark price for every market (feeds the market menu) ----
  useEffect(() => {
    let dead = false;
    const load = async () => {
      for (const m of Object.values(MARKETS)) {
        fetchCandles(m.hlCoin, "1h", 25)
          .then((cs) => {
            if (!dead && cs.length > 1) setChanges((c) => ({ ...c, [m.id]: cs[cs.length - 1].c / cs[0].o - 1 }));
          })
          .catch(() => {});
        fetchLatestPrice(m.id)
          .then((p) => {
            if (!dead && p != null) setMarks((mk) => (mk[m.id] === p ? mk : { ...mk, [m.id]: p }));
          })
          .catch(() => {});
      }
    };
    load();
    const id = setInterval(load, 60_000);
    return () => {
      dead = true;
      clearInterval(id);
    };
  }, []);

  // ---- candles for non-tick timeframes (see useCandles.ts) ----
  useCandleHistory(chartState.current, market, timeframe);

  // ---- live account stream ----
  const onLiveClosed = useCallback(
    (closed: ClosedPosition[]) => {
      for (const c of closed) {
        setClosedPnl((prev) => ({ ...prev, [c.positionId]: c.netPnl }));
        const side = t(c.isLong ? "side.long" : "side.short");
        pushNotice(
          c.liquidated
            ? t("notice.liquidated", { side, lev: c.leverage, margin: c.margin.toFixed(2) })
            : t("notice.closed", { side, pnl: `${c.netPnl >= 0 ? "+" : ""}$${c.netPnl.toFixed(2)}` })
        );
      }
    },
    [pushNotice, t]
  );
  const liveSnap = useWalletStream(isConnected ? address : undefined, onLiveClosed);

  // ---- server-side triggers (triggerApi.ts mirrors the watcher) ----
  const [trigStore, setTrigStore] = useState<RemoteTriggerStore | null>(null);
  useEffect(() => {
    if (!address) return setTrigStore(null);
    const store = new RemoteTriggerStore(address);
    store.start();
    setTrigStore(store);
    return () => store.stop();
  }, [address]);
  const trigVersion = useSyncExternalStore(trigStore?.subscribe ?? noSubscribe, trigStore?.getVersion ?? zeroVersion);
  // signed in + active key + watcher alive + not killed
  const sessionHealthy = useMemo(() => !!trigStore && trigStore.healthy, [trigStore, trigVersion]);

  // trigger levels on the selected market → chart overlay
  useEffect(() => {
    const lines: TriggerLine[] = [];
    if (trigStore) {
      const mid = MARKETS[market].id;
      const pendingOf = (s: string) => s === "firing" || s === "queued" || s === "unknown";
      for (const e of trigStore.entries) {
        if (e.instrumentId !== mid || !(e.status === "armed" || e.status === "confirming" || e.status === "attention" || pendingOf(e.status))) continue;
        lines.push({ id: e.id, kind: "entry", price: e.triggerPrice, isLong: e.isLong, leverage: e.leverage, pending: pendingOf(e.status), attention: e.status === "attention" });
        if (e.attachedStop && !pendingOf(e.status))
          lines.push({ id: `${e.id}:stop`, kind: "stop", price: attachedStopLevel(e.attachedStop, e.isLong, e.triggerPrice), isLong: e.isLong, ghost: true });
        if (e.attachedTp && !pendingOf(e.status))
          lines.push({ id: `${e.id}:tp`, kind: "tp", price: attachedTpLevel(e.attachedTp, e.isLong, e.triggerPrice), isLong: e.isLong, ghost: true });
      }
      for (const s of trigStore.stops) {
        if (s.instrumentId !== mid || !(s.status === "armed" || s.status === "confirming" || s.status === "attention" || pendingOf(s.status))) continue;
        lines.push({ id: s.id, kind: exitOf(s), price: s.stopPrice, isLong: s.isLong, pending: pendingOf(s.status), attention: s.status === "attention" });
      }
    }
    chartState.current.triggers = lines;
  }, [trigStore, trigVersion, market]);

  // display-only live samples for the instruments with live triggers
  const [trigSamples, setTrigSamples] = useState<Record<number, PriceSample | undefined>>({});
  const trigFeedsRef = useRef(new Map<number, TickFeed>());
  const trigInstruments = trigStore ? trigStore.liveInstruments().sort().join(",") : "";
  useEffect(() => {
    const wanted = new Set(trigInstruments ? trigInstruments.split(",").map(Number) : []);
    const feeds = trigFeedsRef.current;
    for (const [id, feed] of feeds) {
      if (!wanted.has(id)) {
        feed.stop();
        feeds.delete(id);
      }
    }
    for (const id of wanted) {
      if (feeds.has(id)) continue;
      const feed = new TickFeed(id);
      feeds.set(id, feed);
      feed.onTick = (tick) => {
        setTrigSamples((prev) =>
          prev[id]?.ts === tick.t ? prev : { ...prev, [id]: { price: tick.p, ts: tick.t, receivedAt: Date.now(), live: true } }
        );
      };
      void feed.start();
    }
  }, [trigInstruments]);
  useEffect(
    () => () => {
      for (const feed of trigFeedsRef.current.values()) feed.stop();
      trigFeedsRef.current.clear();
    },
    []
  );

  const trigSymbol = (id: number) => (Object.keys(MARKETS) as MarketKey[]).find((k) => MARKETS[k].id === id) ?? `#${id}`;
  const triggerNotice = useCallback(
    (ev: TriggerEvent): string | null => {
      const errOf = (error?: string) => {
        const key = error ? TRIGGER_ERROR_KEYS[error] : undefined;
        return key ? t(key as I18nKey) : (error ?? "");
      };
      switch (ev.type) {
        case "entry-queued":
          return t("trig.notice.entryQueued", {
            side: t(ev.entry.isLong ? "house.long" : "house.short").toUpperCase(),
            market: trigSymbol(ev.entry.instrumentId),
            lev: ev.entry.leverage,
            margin: fmtUsd(ev.entry.marginUsdc),
          });
        case "entry-failed":
          return t("trig.notice.entryFailed", {
            side: t(ev.entry.isLong ? "house.long" : "house.short").toUpperCase(),
            market: trigSymbol(ev.entry.instrumentId),
            error: errOf(ev.entry.error),
          });
        case "entry-expired":
          return t("trig.notice.entryExpired", {
            side: t(ev.entry.isLong ? "house.long" : "house.short").toUpperCase(),
            market: trigSymbol(ev.entry.instrumentId),
            lev: ev.entry.leverage,
          });
        case "entry-executed":
          return t("trig.notice.entryExecuted", {
            side: t(ev.entry.isLong ? "house.long" : "house.short").toUpperCase(),
            market: trigSymbol(ev.entry.instrumentId),
            lev: ev.entry.leverage,
            price: fmtPrice(ev.entry.executedPrice ?? 0),
          });
        case "entry-unknown":
          return t("trig.notice.entryUnknown", {
            side: t(ev.entry.isLong ? "house.long" : "house.short").toUpperCase(),
            market: trigSymbol(ev.entry.instrumentId),
          });
        case "entry-unreconciled":
          return t("trig.notice.unreconciled");
        case "stop-queued":
          return t(exitOf(ev.stop) === "tp" ? "trig.notice.tpQueued" : "trig.notice.stopQueued", { market: trigSymbol(ev.stop.instrumentId) });
        case "stop-failed":
          return t(exitOf(ev.stop) === "tp" ? "trig.notice.tpFailed" : "trig.notice.stopFailed", { market: trigSymbol(ev.stop.instrumentId), error: errOf(ev.stop.error) });
        case "stop-executed":
          return t(exitOf(ev.stop) === "tp" ? "trig.notice.tpExecuted" : "trig.notice.stopExecuted", { market: trigSymbol(ev.stop.instrumentId) });
        case "stop-unknown":
          return t(exitOf(ev.stop) === "tp" ? "trig.notice.tpUnknown" : "trig.notice.stopUnknown", { market: trigSymbol(ev.stop.instrumentId) });
        case "stop-expired":
          return t(exitOf(ev.stop) === "tp" ? "trig.notice.tpExpired" : "trig.notice.stopExpired", { market: trigSymbol(ev.stop.instrumentId) });
        case "stop-done":
          return t(exitOf(ev.stop) === "tp" ? "trig.notice.tpDone" : "trig.notice.stopDone", { market: trigSymbol(ev.stop.instrumentId) });
      }
    },
    [t]
  );
  useEffect(() => {
    if (!trigStore) return;
    trigStore.onEvent = (ev) => {
      const msg = triggerNotice(ev);
      if (msg) pushNotice(msg);
    };
    return () => {
      trigStore.onEvent = null;
    };
  }, [trigStore, triggerNotice, pushNotice]);

  const onArmEntry = useCallback(
    (spec: ArmEntrySpec) => {
      if (!trigStore) return Promise.resolve({ ok: false, status: 0, error: "network" } as ApiResult<TriggerEntry>);
      return trigStore.armEntry(spec);
    },
    [trigStore]
  );

  // ---- open positions on the selected market → chart lines ----
  useEffect(() => {
    const positions: Position[] = (liveSnap?.openPositions ?? [])
      .filter((p) => p.instrumentId === MARKETS[market].id)
      .map((lp) => ({
        id: lp.positionId,
        side: lp.isLong ? "long" : "short",
        margin: lp.margin,
        leverage: lp.leverage,
        entry: lp.entryPrice,
        liq: lp.bustPrice,
        qty: (lp.margin * lp.leverage) / lp.entryPrice,
        openedAt: lp.openedAtMs,
      }));
    chartState.current.positions = positions;
  }, [liveSnap, market]);

  // ---- mark prices for other markets with exposure ----
  useEffect(() => {
    const others = new Set<number>();
    for (const p of liveSnap?.openPositions ?? []) others.add(p.instrumentId);
    for (const o of liveSnap?.operations ?? []) if (o.instrumentId != null) others.add(o.instrumentId);
    others.delete(MARKETS[market].id);
    if (!others.size) return;
    let dead = false;
    const load = () => {
      for (const id of others) {
        fetchLatestPrice(id).then((p) => {
          if (!dead && p != null) setMarks((m) => ({ ...m, [id]: p }));
        });
      }
    };
    load();
    const id = setInterval(load, 10_000);
    return () => {
      dead = true;
      clearInterval(id);
    };
  }, [liveSnap, market]);

  // ---- derived ----
  const inst = proto?.instruments.find((i) => i.id === MARKETS[market].id) ?? null;
  liqCtx.current = { price: lastPrice, buffer: inst?.bustBuffer ?? 0, maxLev: inst?.maxLeverage ?? 1000 };
  const openPnl = (liveSnap?.openPositions ?? []).reduce((acc, p) => {
    const mark = marks[p.instrumentId];
    if (!mark) return acc;
    return acc + (mark - p.entryPrice) * (p.isLong ? 1 : -1) * ((p.margin * p.leverage) / p.entryPrice);
  }, 0);
  const free = liveSnap?.available ?? 0;
  const inUse = (liveSnap?.locked ?? 0) + (liveSnap?.queued ?? 0);
  const equity = free + inUse + openPnl;

  // ---- status line: is everything that can hurt me actually working? ----
  const [, forceTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => forceTick((n) => n + 1), 5000);
    return () => clearInterval(id);
  }, []);
  const feedOk = lastTickAt > 0 && Date.now() - lastTickAt < 15_000;
  const protoState: "live" | "paused" | "offline" = !proto ? "offline" : proto.tradingPaused ? "paused" : "live";
  const trigState: "live" | "paused" | "offline" | "off" = !trigStore
    ? "off"
    : trigStore.apiDown || !trigStore.me
      ? "offline"
      : trigStore.me.kill?.on
        ? "paused"
        : trigStore.me.watcher.alive
          ? "live"
          : "offline";

  const statsbar = (
    <div className="instbar">
      <div className="asset-pill" ref={marketPillRef}>
        <button className="asset-trigger" aria-haspopup="listbox" aria-expanded={marketMenu} onClick={() => setMarketMenu((o) => !o)}>
          <b className="asset-coin">{market}</b>
          <i className={marketMenu ? "chev open" : "chev"} />
        </button>
        <span className="price numeric">{lastPrice ? fmtPrice(lastPrice) : "…"}</span>
        {change24h != null && (
          <span className={change24h >= 0 ? "move up" : "move down"}>
            {change24h >= 0 ? "+" : ""}
            {(change24h * 100).toFixed(2)}%
          </span>
        )}
        {marketMenu && (
          <div className="market-menu" role="listbox">
            {(Object.keys(MARKETS) as MarketKey[]).map((k) => {
              const id = MARKETS[k].id;
              const mv = changes[id];
              return (
                <button
                  key={k}
                  role="option"
                  aria-selected={k === market}
                  className={k === market ? "market-option active" : "market-option"}
                  onClick={() => {
                    setMarket(k);
                    setMarketMenu(false);
                  }}
                >
                  <span className="market-option-symbol">{k}</span>
                  <span className="market-option-metrics">
                    <span className="numeric">{marks[id] ? `$${fmtPrice(marks[id])}` : "—"}</span>
                    {mv != null && (
                      <span className={mv >= 0 ? "move up" : "move down"}>
                        {mv >= 0 ? "+" : ""}
                        {(mv * 100).toFixed(2)}%
                      </span>
                    )}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>

      <div className="inst-stats">
        {phone ? (
          <div className="tf-dd" ref={tfRef}>
            <button className="tf-dd-trigger" aria-haspopup="listbox" aria-expanded={tfMenu} onClick={() => setTfMenu((o) => !o)}>
              {timeframe}
              <i className={tfMenu ? "chev open" : "chev"} />
            </button>
            {tfMenu && (
              <div className="tf-dd-menu" role="listbox">
                {TIMEFRAMES.map((tf) => (
                  <button
                    key={tf}
                    role="option"
                    aria-selected={tf === timeframe}
                    className={tf === timeframe ? "tf-dd-option on" : "tf-dd-option"}
                    onClick={() => {
                      setTimeframe(tf);
                      setTfMenu(false);
                    }}
                  >
                    {tf}
                  </button>
                ))}
              </div>
            )}
          </div>
        ) : (
          <>
            <span className="ms-cell">
              <i className="ms-label">{t("stats.vol24h")}</i>
              <span className="ms-value numeric">{volumes[MARKETS[market].id] != null ? fmtUsd(volumes[MARKETS[market].id], 0) : "—"}</span>
            </span>
            <span className="ms-cell">
              <i className="ms-label">{t("stats.oi")}</i>
              <span className="ms-value numeric">
                <em className="up">{inst && lastPrice ? fmtUsd(inst.longOi * lastPrice, 0) : "—"}</em>
                <em className="ms-slash">/</em>
                <em className="down">{inst && lastPrice ? fmtUsd(inst.shortOi * lastPrice, 0) : "—"}</em>
              </span>
            </span>
            <span className="spacer" />
            <span className="tfs">
              {TIMEFRAMES.map((tf) => (
                <button key={tf} className={tf === timeframe ? "tf on" : "tf"} onClick={() => setTimeframe(tf)}>
                  {tf}
                </button>
              ))}
            </span>
          </>
        )}
      </div>
    </div>
  );

  const Dot = ({ state }: { state: string }) => <i className={`dot ${state}`} aria-hidden />;
  const statusline = (
    <footer className="statusline">
      <span className="st">
        <Dot state={feedOk ? "live" : "stale"} />
        {t("status.feed")} <b>{t(feedOk ? "status.live" : "status.stale")}</b>
      </span>
      <span className="st">
        <Dot state={protoState} />
        {t("status.protocol")} <b>{t(`status.${protoState}` as I18nKey)}</b>
      </span>
      <span className="st">
        <Dot state={trigState} />
        {t("status.triggers")} <b>{t(`status.${trigState}` as I18nKey)}</b>
      </span>
      <span className="spacer" />
      <span className="st-note">{t("status.disclaimer")}</span>
    </footer>
  );

  const dark = theme === "dark";

  return (
    <div className="app">
      <header className="topbar">
        <div className="logo">
          by<span className="logo-accent">INTENT</span>
        </div>
        <div className="spacer" />
        {liveSnap && (
          <div className="acct">
            <span className="acct-cell">
              <i>{t("acct.equity")}</i>
              <b className="numeric">{fmtUsd(equity)}</b>
            </span>
            <span className="acct-cell">
              <i>{t("acct.free")}</i>
              <b className="numeric">{fmtUsd(free)}</b>
            </span>
            <span className="acct-cell">
              <i>{t("acct.pnl")}</i>
              <b className={`numeric ${openPnl >= 0 ? "up" : "down"}`}>
                {openPnl >= 0 ? "+" : ""}
                {fmtUsd(openPnl)}
              </b>
            </span>
          </div>
        )}
        <button className="topbtn" onClick={() => setFunding("deposit")}>
          {t("top.deposit")}
        </button>
        <button className="topbtn" onClick={() => setFunding("withdraw")}>
          {t("top.withdraw")}
        </button>
        <button
          className={dark ? "mode-toggle on" : "mode-toggle"}
          role="switch"
          aria-checked={dark}
          aria-label={t("top.darkMode")}
          title={dark ? t("top.toLight") : t("top.toDark")}
          onClick={() => setTheme(dark ? "light" : "dark")}
        >
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden>
            <path
              d="M12 3.2a6.3 6.3 0 0 0-3.6 11.4V16.8h7.2v-2.2A6.3 6.3 0 0 0 12 3.2Z"
              fill={dark ? "none" : "currentColor"}
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinejoin="round"
            />
            <path d="M10 19.2h4M10.6 21.2h2.8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>
        <ConnectControls />
      </header>

      <div
        className="main"
        ref={mainRef}
        style={{ "--panel-w": layout.panelW != null ? `${Math.max(layout.panelW, panelMin())}px` : undefined } as CSSProperties}
      >
        <section className="chart-card">
          {statsbar}
          <div className="chart-body" ref={chartBodyRef}>
            <div className="draw-tools" role="toolbar" aria-label={t("tools.label")}>
              <button
                className={tool === "hline" ? "dtool on" : "dtool"}
                title={t("tools.hline")}
                aria-pressed={tool === "hline"}
                onClick={() => setTool((cur) => (cur === "hline" ? null : "hline"))}
              >
                {ToolIcon.hline}
              </button>
              <button
                className={tool === "trend" ? "dtool on" : "dtool"}
                title={t("tools.trend")}
                aria-pressed={tool === "trend"}
                onClick={() => setTool((cur) => (cur === "trend" ? null : "trend"))}
              >
                {ToolIcon.trend}
              </button>
              <span className="dtool-sep" />
              <button className={magnet ? "dtool on" : "dtool"} title={t("tools.magnet")} aria-pressed={magnet} onClick={() => setMagnet((m) => !m)}>
                {ToolIcon.magnet}
              </button>
              <span className="dtool-sep" />
              <button
                className={tool === "liq" ? "dtool liq on" : "dtool liq"}
                title={t("tools.liq")}
                aria-pressed={tool === "liq"}
                onClick={() => {
                  const turningOn = tool !== "liq";
                  setTool(turningOn ? "liq" : null);
                  if (turningOn) setMagnet(false);
                }}
              >
                {ToolIcon.liq}
              </button>
            </div>
            <div className="chart-wrap">
              <Chart state={chartState.current} onFollowChange={setFollowing} />
              {!following && (
                <button className="chart-follow" title={t("stats.backToLive")} onClick={() => chartState.current.resetView?.()}>
                  <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden>
                    <path d="M3 8h8M8 4l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                    <path d="M13.5 3.5v9" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                  </svg>
                </button>
              )}
            </div>
            {editing && editingDrawing && (
              <DrawingPopup
                drawing={editingDrawing}
                at={editing.at}
                onChange={(d) => setDrawings((ds) => ds.map((x) => (x.id === d.id ? d : x)))}
                onDelete={() => {
                  setDrawings((ds) => ds.filter((x) => x.id !== editing.id));
                  setEditing(null);
                }}
                onClose={closeEditor}
              />
            )}
          </div>
        </section>

        <div
          className={resizing === "v" ? "divider divider-v active" : "divider divider-v"}
          role="separator"
          aria-orientation="vertical"
          title={t("tools.dragPanel")}
          onPointerDown={startResize("v")}
        />

        <aside className="panel" ref={panelRef}>
          <Ticket
            snapshot={liveSnap}
            proto={proto}
            market={market}
            lastPrice={lastPrice}
            openPnl={openPnl}
            onSubmitted={pushNotice}
            onPreview={setPreview}
            apply={liqSet}
            onArmEntry={onArmEntry}
            trigStore={trigStore}
          />
        </aside>
      </div>

      <div
        className={resizing === "h" ? "divider divider-h active" : "divider divider-h"}
        role="separator"
        aria-orientation="horizontal"
        title={t("tools.dragBar")}
        onPointerDown={startResize("h")}
      />

      <TradeBar
        snapshot={liveSnap}
        proto={proto}
        marks={marks}
        onAction={pushNotice}
        trigStore={trigStore}
        trigSamples={trigSamples}
        sessionHealthy={sessionHealthy}
        closedPnl={closedPnl}
        height={layout.barH != null ? Math.max(layout.barH, BAR_MIN) : null}
        barRef={barRef}
      />

      {statusline}

      <Funding mode={funding} snapshot={liveSnap} onClose={() => setFunding(null)} onAction={pushNotice} />

      {notices.length > 0 && (
        <div className="toasts">
          {notices.map((n) => (
            <div className="toast" key={n.id}>
              {n.msg}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
