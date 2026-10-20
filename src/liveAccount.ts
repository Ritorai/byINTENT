// Live account state from papertrade's per-wallet SSE stream
// (`/state/user/live?wallet=…`, via the /pt proxy).
//
// The wire parsing and frame reducer live in shared/walletFrames.ts (the
// watcher consumes the same stream server-side); this file only owns the
// browser transport (EventSource) and the React hook.

import { useEffect, useRef, useState } from "react";
import { WalletFrameReducer, type ClosedPosition, type WalletSnapshot } from "../shared/walletFrames";

export type {
  ClosedPosition,
  LifetimeStats,
  LivePosition,
  PaperState,
  QueuedIntent,
  WalletSnapshot,
} from "../shared/walletFrames";

const PT = "/pt";

export class WalletStream {
  private es: EventSource | null = null;
  private reducer = new WalletFrameReducer();
  private stopped = false;

  onUpdate?: (s: WalletSnapshot) => void;
  onClosed?: (closed: ClosedPosition[]) => void;

  constructor(private wallet: string) {}

  start() {
    this.stopped = false;
    this.open();
  }

  stop() {
    this.stopped = true;
    this.es?.close();
    this.es = null;
  }

  private open() {
    if (this.stopped) return;
    this.es?.close();
    const url = `${PT}/state/user/live?wallet=${encodeURIComponent(this.wallet.toLowerCase())}`;
    this.es = new EventSource(url, { withCredentials: true });
    this.es.addEventListener("wallet", (ev) => {
      let frame: unknown;
      try {
        frame = JSON.parse((ev as MessageEvent).data);
      } catch {
        this.resync();
        return;
      }
      const r = this.reducer.apply(frame);
      if (r.kind === "resync") {
        this.resync();
        return;
      }
      if (r.kind === "ignored") return;
      if (r.closed.length) this.onClosed?.(r.closed);
      this.onUpdate?.(this.reducer.snapshot());
    });
    // EventSource auto-reconnects on transient errors and the server replies
    // to a fresh connection with a full frame, so no manual retry logic.
  }

  /** Drop local state and reconnect for a fresh full frame. */
  private resync() {
    this.es?.close();
    this.es = null;
    this.reducer.reset();
    if (!this.stopped) setTimeout(() => this.open(), 1000);
  }
}

/** Subscribe to the wallet's live state while `wallet` is set. */
export function useWalletStream(
  wallet: string | undefined,
  onClosed?: (closed: ClosedPosition[]) => void
): WalletSnapshot | null {
  const [snap, setSnap] = useState<WalletSnapshot | null>(null);
  const onClosedRef = useRef(onClosed);
  onClosedRef.current = onClosed;

  useEffect(() => {
    if (!wallet) {
      setSnap(null);
      return;
    }
    const ws = new WalletStream(wallet);
    ws.onUpdate = setSnap;
    ws.onClosed = (c) => onClosedRef.current?.(c);
    ws.start();
    return () => {
      ws.stop();
      setSnap(null);
    };
  }, [wallet]);

  return snap;
}
