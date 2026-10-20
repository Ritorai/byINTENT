// Papertrade's `/query/markets/{id}/price-history` response → ticks.
// Shared by the chart feed (src/feed.ts) and the watcher's price poller.

export interface Tick {
  t: number; // ms epoch
  p: number; // price
}

export const TICK_INTERVAL_MS = 125;
export const MINUTE_MS = 60_000;

/** URL path (relative to the exchange host or the /pt proxy) for one minute window. */
export function tickWindowPath(marketId: number, fromMs: number): string {
  return `/query/markets/${marketId}/price-history?fromMs=${fromMs}&intervalMs=${TICK_INTERVAL_MS}&toMs=${fromMs + MINUTE_MS}`;
}

/**
 * Columnar response: {baseTimeMs, timeOffsetsMs[], columns: {price[]}}.
 * Non-finite / null prices are skipped. Defensive against a malformed body —
 * this feeds a decision that signs an intent.
 */
export function parseTickWindow(j: any): Tick[] {
  const base = Number(j?.baseTimeMs);
  const offsets: unknown[] = Array.isArray(j?.timeOffsetsMs) ? j.timeOffsetsMs : [];
  const prices: unknown[] = Array.isArray(j?.columns?.price) ? j.columns.price : [];
  if (!Number.isFinite(base)) return [];
  const out: Tick[] = [];
  const n = Math.min(offsets.length, prices.length);
  for (let i = 0; i < n; i++) {
    const p = prices[i];
    const o = offsets[i];
    if (typeof p === "number" && Number.isFinite(p) && p > 0 && typeof o === "number" && Number.isFinite(o))
      out.push({ t: base + o, p });
  }
  return out;
}
