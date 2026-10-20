// Live market data from papertrade.xyz (ticks, via the same-origin /pt proxy —
// their edge rejects foreign Origin headers) and Hyperliquid (candles, CORS-open).

// Market table + tick parsing are shared with the watcher (shared/).
import { MARKETS, type MarketKey } from "../shared/markets";
import { parseTickWindow, type Tick } from "../shared/priceHistory";
export { MARKETS, type MarketKey, type Tick };

export interface Candle {
  t: number; // open time ms
  o: number;
  h: number;
  l: number;
  c: number;
}

export type Timeframe = "Tick" | "1m" | "5m" | "15m" | "1h" | "4h" | "1D" | "1W";
export const TIMEFRAMES: Timeframe[] = ["Tick", "1m", "5m", "15m", "1h", "4h", "1D", "1W"];
export type CandleTimeframe = Exclude<Timeframe, "Tick">;

const PT_BASE = "/pt";
const HL_INFO = "https://api.hyperliquid.xyz/info";
const MINUTE = 60_000;

export const TF_INTERVAL_MS: Record<CandleTimeframe, number> = {
  "1m": MINUTE,
  "5m": 5 * MINUTE,
  "15m": 15 * MINUTE,
  "1h": 60 * MINUTE,
  "4h": 240 * MINUTE,
  "1D": 1440 * MINUTE,
  "1W": 7 * 1440 * MINUTE,
};

/** Hyperliquid's interval token for a timeframe. */
const HL_INTERVAL: Record<CandleTimeframe, string> = {
  "1m": "1m",
  "5m": "5m",
  "15m": "15m",
  "1h": "1h",
  "4h": "4h",
  "1D": "1d",
  "1W": "1w",
};

/** Fetch one minute-aligned window of 125ms ticks from papertrade. */
async function fetchTickWindow(marketId: number, fromMs: number): Promise<Tick[]> {
  const url = `${PT_BASE}/query/markets/${marketId}/price-history?fromMs=${fromMs}&intervalMs=125&toMs=${fromMs + MINUTE}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`price-history ${res.status}`);
  return parseTickWindow(await res.json());
}

/** Latest price for a market (one small window request). */
export async function fetchLatestPrice(marketId: number): Promise<number | null> {
  const nowMin = Math.floor(Date.now() / MINUTE) * MINUTE;
  for (const from of [nowMin, nowMin - MINUTE]) {
    try {
      const ticks = await fetchTickWindow(marketId, from);
      if (ticks.length) return ticks[ticks.length - 1].p;
    } catch {
      /* fall through */
    }
  }
  return null;
}

/** Most recent `bars` candles ending now. */
export async function fetchCandles(hlCoin: string, interval: CandleTimeframe, bars: number): Promise<Candle[]> {
  const now = Date.now();
  return fetchCandleRange(hlCoin, interval, now - bars * TF_INTERVAL_MS[interval], now);
}

/** Candles whose open time falls in [startTime, endTime]. Hyperliquid caps a snapshot at ~5000 bars. */
export async function fetchCandleRange(
  hlCoin: string,
  interval: CandleTimeframe,
  startTime: number,
  endTime: number
): Promise<Candle[]> {
  const body = {
    type: "candleSnapshot",
    req: { coin: hlCoin, interval: HL_INTERVAL[interval], startTime: Math.max(0, Math.floor(startTime)), endTime: Math.floor(endTime) },
  };
  const res = await fetch(HL_INFO, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`candleSnapshot ${res.status}`);
  const j = await res.json();
  return (j as any[]).map((k) => ({
    t: k.t,
    o: parseFloat(k.o),
    h: parseFloat(k.h),
    l: parseFloat(k.l),
    c: parseFloat(k.c),
  }));
}

/** Merge two candle arrays (both ascending by `t`), de-duplicating on open time; `b` wins on ties. */
export function mergeCandles(a: Candle[], b: Candle[]): Candle[] {
  if (!a.length) return b;
  if (!b.length) return a;
  const byT = new Map<number, Candle>();
  for (const c of a) byT.set(c.t, c);
  for (const c of b) byT.set(c.t, c);
  return [...byT.values()].sort((x, y) => x.t - y.t);
}

/**
 * Live tick feed: polls papertrade's price-history endpoint (current minute window,
 * ~600 ms cadence) and keeps the last ~5 minutes of 125 ms ticks.
 */
export class TickFeed {
  ticks: Tick[] = [];
  onTick: ((latest: Tick) => void) | null = null;

  private marketId: number;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private lastSeen = 0;
  // bumped by stop(): a start() whose backfill was still in flight when the feed was stopped
  // must not install its poll timer afterwards (that left zombie feeds ticking the wrong market)
  private gen = 0;

  constructor(marketId: number) {
    this.marketId = marketId;
  }

  get latest(): Tick | null {
    return this.ticks.length ? this.ticks[this.ticks.length - 1] : null;
  }

  async start() {
    this.stop();
    const gen = this.gen;
    this.ticks = [];
    this.lastSeen = 0;
    // Backfill the previous + current minute, then poll.
    const nowMin = Math.floor(Date.now() / MINUTE) * MINUTE;
    try {
      const windows = await Promise.all([
        fetchTickWindow(this.marketId, nowMin - MINUTE),
        fetchTickWindow(this.marketId, nowMin),
      ]);
      if (gen !== this.gen) return; // stopped (or restarted) while backfilling
      this.ingest(windows.flat());
    } catch {
      /* backfill is best-effort */
    }
    if (gen !== this.gen) return;
    this.pollTimer = setInterval(() => this.poll(), 600);
  }

  stop() {
    this.gen++;
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  private async poll() {
    const nowMin = Math.floor(Date.now() / MINUTE) * MINUTE;
    try {
      const cur = await fetchTickWindow(this.marketId, nowMin);
      // Just after a minute rollover the fresh window may still be empty; keep previous too.
      if (cur.length < 4) {
        const prev = await fetchTickWindow(this.marketId, nowMin - MINUTE);
        this.ingest(prev);
      }
      this.ingest(cur);
    } catch {
      /* transient network errors are fine; next poll retries */
    }
  }

  private ingest(incoming: Tick[]) {
    let appended: Tick | null = null;
    for (const tk of incoming) {
      if (tk.t > this.lastSeen) {
        this.ticks.push(tk);
        this.lastSeen = tk.t;
        appended = tk;
      }
    }
    // keep ~5 minutes
    const cutoff = Date.now() - 5 * MINUTE;
    while (this.ticks.length && this.ticks[0].t < cutoff) this.ticks.shift();
    if (appended && this.onTick) this.onTick(appended);
  }
}
