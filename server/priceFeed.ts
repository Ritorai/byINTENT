// One price poller per instrument (SPEC.md §6). Polls papertrade's
// price-history for the current minute (plus the previous one right after a
// rollover), keeps the latest tick as a PriceSample. Every user with a
// trigger on BTC shares this one BTC poller.
//
// Safety properties the engine relies on:
//  - `receivedAt` is OUR clock at the moment the tick arrived — staleness is
//    judged on receipt, never on the tick's own timestamp;
//  - `ts` is the feed's tick timestamp — confirmation needs a strictly newer one;
//  - a tick whose timestamp is more than CLOCK_SKEW_MS from our clock marks
//    the feed "skewed": nothing fires until it recovers (a clock problem on
//    either side must never look like a price move).

import { MINUTE_MS, parseTickWindow, tickWindowPath, type Tick } from "../shared/priceHistory";
import type { PriceSample } from "../shared/triggerLogic";
import { log } from "./log";

export const CLOCK_SKEW_MS = 30_000;

export interface FeedStatus {
  instrumentId: number;
  sample: PriceSample | null;
  /** ms since the latest sample was received; Infinity when none */
  ageMs: number;
  skewed: boolean;
  consecutiveErrors: number;
}

export class PricePoller {
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastSeen = 0;
  private sample: PriceSample | null = null;
  private inFlight = false;
  consecutiveErrors = 0;
  skewed = false;
  /** the sample before the latest one (per-instrument cross baseline) */
  prev: PriceSample | null = null;

  constructor(
    readonly instrumentId: number,
    private base: string,
    private intervalMs: number,
    private fetchImpl: typeof fetch = fetch,
    private now: () => number = Date.now
  ) {}

  start() {
    if (this.timer) return;
    void this.poll();
    this.timer = setInterval(() => void this.poll(), this.intervalMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  latest(): PriceSample | null {
    return this.sample;
  }

  status(): FeedStatus {
    const now = this.now();
    return {
      instrumentId: this.instrumentId,
      sample: this.sample,
      ageMs: this.sample ? now - this.sample.receivedAt : Number.POSITIVE_INFINITY,
      skewed: this.skewed,
      consecutiveErrors: this.consecutiveErrors,
    };
  }

  private async window(fromMs: number): Promise<Tick[]> {
    const res = await this.fetchImpl(`${this.base}${tickWindowPath(this.instrumentId, fromMs)}`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(4000),
    });
    if (res.status === 429) throw new Error("rate_limited");
    if (!res.ok) throw new Error(`price-history ${res.status}`);
    return parseTickWindow(await res.json());
  }

  private async poll() {
    if (this.inFlight) return; // a slow response must not stack requests
    this.inFlight = true;
    try {
      const nowMin = Math.floor(this.now() / MINUTE_MS) * MINUTE_MS;
      let ticks = await this.window(nowMin);
      // right after a minute rollover the fresh window may still be empty
      if (ticks.length < 4) ticks = [...(await this.window(nowMin - MINUTE_MS)), ...ticks];
      this.ingest(ticks);
      this.consecutiveErrors = 0;
    } catch (e) {
      this.consecutiveErrors += 1;
      if (this.consecutiveErrors === 3 || this.consecutiveErrors % 50 === 0)
        log.warn(`price feed #${this.instrumentId}: ${this.consecutiveErrors} consecutive errors (${e instanceof Error ? e.message : e})`);
    } finally {
      this.inFlight = false;
    }
  }

  /** test hook / shared ingest: newest tick with a timestamp we haven't seen becomes the sample */
  ingest(ticks: Tick[]) {
    const now = this.now();
    let newest: Tick | null = null;
    for (const tk of ticks) if (tk.t > this.lastSeen && (!newest || tk.t > newest.t)) newest = tk;
    if (!newest) return;
    this.lastSeen = newest.t;
    const skew = Math.abs(now - newest.t);
    this.skewed = skew > CLOCK_SKEW_MS;
    if (this.skewed) {
      log.warn(`price feed #${this.instrumentId}: tick ts ${skew} ms from server clock — feed marked skewed`);
      return; // keep the previous sample; it will age out
    }
    this.prev = this.sample;
    this.sample = { price: newest.p, ts: newest.t, receivedAt: now, live: true };
  }
}

/** Set of pollers keyed by instrument; the engine asks for the instruments it needs each pass. */
export class PriceFeeds {
  private pollers = new Map<number, PricePoller>();
  constructor(private base: string, private intervalMs: number, private fetchImpl: typeof fetch = fetch, private now: () => number = Date.now) {}

  ensure(instrumentIds: Iterable<number>) {
    const want = new Set(instrumentIds);
    for (const [id, p] of this.pollers) {
      if (!want.has(id)) {
        p.stop();
        this.pollers.delete(id);
      }
    }
    for (const id of want) {
      if (this.pollers.has(id)) continue;
      const p = new PricePoller(id, this.base, this.intervalMs, this.fetchImpl, this.now);
      this.pollers.set(id, p);
      p.start();
    }
  }

  get(instrumentId: number): PricePoller | undefined {
    return this.pollers.get(instrumentId);
  }

  samples(): Record<number, PriceSample | undefined> {
    const out: Record<number, PriceSample | undefined> = {};
    for (const [id, p] of this.pollers) out[id] = p.skewed ? undefined : (p.latest() ?? undefined);
    return out;
  }

  statuses(): FeedStatus[] {
    return [...this.pollers.values()].map((p) => p.status());
  }

  stopAll() {
    for (const p of this.pollers.values()) p.stop();
    this.pollers.clear();
  }
}
