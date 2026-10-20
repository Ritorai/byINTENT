// Per-wallet live account state for the engine, from papertrade's SSE
// stream consumed with fetch() (Node has no EventSource). One stream per
// wallet that has a non-terminal trigger; closed when none remain.
//
// Reconnect policy: exponential backoff 1 s → 30 s; any parse error or a
// patch against an unknown revision drops local state and reconnects for a
// full frame (the server always answers a new connection with one).

import { SseParser, WalletFrameReducer, type WalletSnapshot } from "../shared/walletFrames";
import { log } from "./log";

export interface WalletState {
  snapshot: WalletSnapshot | null;
  /** ms epoch of the last applied frame (any kind), 0 when never */
  lastFrameAt: number;
  connected: boolean;
}

export class WalletStream {
  private reducer = new WalletFrameReducer();
  private ac: AbortController | null = null;
  private stopped = false;
  private backoffMs = 1000;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  lastFrameAt = 0;
  connected = false;
  snapshot: WalletSnapshot | null = null;

  constructor(
    readonly wallet: string,
    private base: string,
    private fetchImpl: typeof fetch = fetch,
    private now: () => number = Date.now
  ) {}

  start() {
    this.stopped = false;
    void this.connect();
  }

  stop() {
    this.stopped = true;
    this.ac?.abort();
    this.ac = null;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.connected = false;
  }

  state(): WalletState {
    return { snapshot: this.snapshot, lastFrameAt: this.lastFrameAt, connected: this.connected };
  }

  private scheduleReconnect() {
    if (this.stopped) return;
    this.connected = false;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => void this.connect(), this.backoffMs);
    this.backoffMs = Math.min(30_000, this.backoffMs * 2);
  }

  private async connect() {
    if (this.stopped) return;
    this.ac?.abort();
    const ac = new AbortController();
    this.ac = ac;
    this.reducer.reset();
    try {
      const res = await this.fetchImpl(`${this.base}/state/user/live?wallet=${encodeURIComponent(this.wallet.toLowerCase())}`, {
        headers: { accept: "text/event-stream" },
        signal: ac.signal,
      });
      if (!res.ok || !res.body) throw new Error(`sse ${res.status}`);
      this.connected = true;
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      const parser = new SseParser();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        let resync = false;
        parser.push(dec.decode(value, { stream: true }), (ev) => {
          if (ev.event !== "wallet") return;
          let frame: unknown;
          try {
            frame = JSON.parse(ev.data);
          } catch {
            resync = true;
            return;
          }
          const r = this.reducer.apply(frame);
          if (r.kind === "resync") resync = true;
          else if (r.kind === "applied") {
            this.snapshot = this.reducer.snapshot();
            this.lastFrameAt = this.now();
            this.backoffMs = 1000; // a healthy frame resets the backoff
          }
        });
        if (resync) {
          ac.abort();
          break;
        }
      }
    } catch (e) {
      if (!ac.signal.aborted) log.warn(`wallet stream ${this.wallet.slice(0, 8)}…: ${e instanceof Error ? e.message : e}`);
    }
    if (this.ac === ac) this.scheduleReconnect();
  }
}

export class WalletWatch {
  private streams = new Map<string, WalletStream>();
  constructor(private base: string, private fetchImpl: typeof fetch = fetch, private now: () => number = Date.now) {}

  ensure(wallets: Iterable<string>) {
    const want = new Set([...wallets].map((w) => w.toLowerCase()));
    for (const [w, s] of this.streams) {
      if (!want.has(w)) {
        s.stop();
        this.streams.delete(w);
      }
    }
    for (const w of want) {
      if (this.streams.has(w)) continue;
      const s = new WalletStream(w, this.base, this.fetchImpl, this.now);
      this.streams.set(w, s);
      s.start();
    }
  }

  get(wallet: string): WalletState | null {
    return this.streams.get(wallet.toLowerCase())?.state() ?? null;
  }

  size() {
    return this.streams.size;
  }

  stopAll() {
    for (const s of this.streams.values()) s.stop();
    this.streams.clear();
  }
}
