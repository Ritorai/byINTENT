// Papertrade's per-wallet live state (`/state/user/live?wallet=…`, SSE) —
// the wire parsing and the frame reducer, with no transport attached. The
// browser wraps it in an EventSource (src/liveAccount.ts); the watcher feeds
// it from a fetch() body (server/walletWatch.ts). One parser, so a tuple
// index that changes upstream is fixed in exactly one place.
//
// Wire format (decoded from their frontend's hooks chunk):
//  - event `liveness`  → {heartbeatIntervalMs}
//  - event `heartbeat` → null
//  - event `wallet`    → either a FULL frame {…state, openPositions: tuple[],
//    accountRevision} or a PATCH {baseAccountRevision, accountRevision,
//    state?: partial, addedPositions, removedPositionIds, closedPositions?}.
//
// Position tuple: [positionId, instrumentId, isLong, useDebt, entryPriceRaw,
//   marginRaw, leverage, bustPriceRaw, openedAtMs, intentId]
// Closed tuple:   [positionId, instrumentId, isLong, marginRaw, leverage,
//   liquidated, netPnlRaw, paperMintedRaw]
//
// Scales: collateral (balance/margin/pnl) is 1e18; prices are raw / the
// instrument's price scale (shared/markets.ts).

import { PRICE_SCALE } from "./markets";

const COLLATERAL = 1e18;

export interface LivePosition {
  positionId: string;
  instrumentId: number;
  isLong: boolean;
  useDebt: boolean;
  entryPrice: number;
  margin: number; // USDC
  leverage: number;
  bustPrice: number;
  openedAtMs: number;
  /** the openPosition intent this position came from (tuple index 9), when the
   *  stream provides it — lets a fired trigger claim exactly its own fill */
  intentId: string | null;
}

export interface ClosedPosition {
  positionId: string;
  instrumentId: number;
  isLong: boolean;
  margin: number;
  leverage: number;
  liquidated: boolean;
  netPnl: number; // USDC, signed
}

export interface QueuedIntent {
  intentId: string;
  action: string; // openPosition | closePositions | withdrawToCore | …
  instrumentId: number | null;
  isLong: boolean | null;
  useDebt: boolean | null;
  amount: number | null; // USDC (margin for opens, amount for withdrawals)
  leverage: number | null;
  timeMs: number;
  deadlineS: number;
  closeIds: string[] | null;
}

/** PAPER token position, raw 1e18 units (BigInt — the reward math needs the precision). */
export interface PaperState {
  balance: bigint;
  staked: bigint;
  pendingBase: bigint;
  rewardDebt: bigint;
}

/** Lifetime account totals (USDC). */
export interface LifetimeStats {
  deposited: number;
  withdrawn: number;
  realizedPnl: number;
  feesPaid: number;
  tradedNotional: number;
  paperRewardsClaimed: number;
}

export interface WalletSnapshot {
  /** Trading balance inside the Exchange contract (USDC). */
  balance: number;
  paper: PaperState;
  lifetime: LifetimeStats;
  /** chain block this snapshot is indexed through (for claimable-reward estimates) */
  indexedThroughBlock: number;
  /** Balance not reserved by open positions / queued intents (USDC). */
  available: number;
  /** Balance committed to intents waiting in the queue (USDC). */
  queued: number;
  /** Margin locked in open positions (USDC). */
  locked: number;
  openPositions: LivePosition[];
  /** Intents waiting in the execution queue. */
  operations: QueuedIntent[];
  /** Session key addresses registered on-chain for this wallet (lowercase). */
  sessionKeys: string[];
  /** Session key expiries (unix seconds) by lowercase address, when the stream carries them. */
  sessionKeyExpiry: Record<string, number>;
}

function big(v: unknown): bigint {
  try {
    return v == null ? 0n : BigInt(String(v));
  } catch {
    return 0n;
  }
}

export function parsePosition(t: unknown[]): LivePosition {
  const scale = PRICE_SCALE[Number(t[1])] ?? 1;
  return {
    positionId: String(t[0]),
    instrumentId: Number(t[1]),
    isLong: Boolean(t[2]),
    useDebt: Boolean(t[3]),
    entryPrice: Number(t[4]) / scale,
    margin: Number(t[5]) / COLLATERAL,
    leverage: Number(t[6]),
    bustPrice: Number(t[7]) / scale,
    openedAtMs: Number(t[8]),
    // only trust it when it looks like an intent hash — the field is optional
    // in their tuple and callers fall back to heuristics when it's missing
    intentId: typeof t[9] === "string" && /^0x[0-9a-fA-F]+$/.test(t[9]) ? t[9] : null,
  };
}

// Operation tuple: [intentId, action, instrumentId?, isLong?, useDebt?,
//   amountRaw?, leverage?, timeMs, deadline, closeIds?]
export function parseOperation(t: unknown[]): QueuedIntent {
  return {
    intentId: String(t[0]),
    action: String(t[1]),
    instrumentId: t[2] == null ? null : Number(t[2]),
    isLong: t[3] == null ? null : Boolean(t[3]),
    useDebt: t[4] == null ? null : Boolean(t[4]),
    // withdrawals are queued in collateral units (USDC 6 dp); everything else is 1e18
    amount: t[5] == null ? null : Number(t[5]) / (t[1] === "withdrawToCore" ? 1e6 : COLLATERAL),
    leverage: t[6] == null ? null : Number(t[6]),
    timeMs: Number(t[7]),
    deadlineS: Number(t[8]),
    closeIds: t[9] == null ? null : (t[9] as unknown[]).map(String),
  };
}

export function parseClosed(t: unknown[]): ClosedPosition {
  return {
    positionId: String(t[0]),
    instrumentId: Number(t[1]),
    isLong: Boolean(t[2]),
    margin: Number(t[3]) / COLLATERAL,
    leverage: Number(t[4]),
    liquidated: Boolean(t[5]),
    netPnl: Number(t[6]) / COLLATERAL,
  };
}

export type FrameResult =
  | { kind: "applied"; closed: ClosedPosition[] }
  | { kind: "resync" } // patch against a revision we don't hold — reconnect for a full frame
  | { kind: "ignored" };

/**
 * Reduces `wallet` frames into a snapshot. Transport-agnostic: feed it parsed
 * JSON, read `snapshot()`. `resync` means the caller must reconnect.
 */
export class WalletFrameReducer {
  private positions = new Map<string, LivePosition>();
  private operations = new Map<string, QueuedIntent>();
  private accountRevision = 0;
  private balance = 0;
  private available = 0;
  private queued = 0;
  private locked = 0;
  private paper: PaperState = { balance: 0n, staked: 0n, pendingBase: 0n, rewardDebt: 0n };
  private lifetime: LifetimeStats = {
    deposited: 0,
    withdrawn: 0,
    realizedPnl: 0,
    feesPaid: 0,
    tradedNotional: 0,
    paperRewardsClaimed: 0,
  };
  private indexedThroughBlock = 0;
  private sessionKeys: string[] = [];
  private sessionKeyExpiry: Record<string, number> = {};
  /** true once a full frame has been applied */
  primed = false;

  /** Drop everything (before reconnecting for a fresh full frame). */
  reset() {
    this.positions.clear();
    this.operations.clear();
    this.accountRevision = 0;
    this.primed = false;
  }

  apply(f: any): FrameResult {
    if (!f || typeof f !== "object") return { kind: "ignored" };
    if (Array.isArray(f.openPositions)) {
      // full frame — state fields at top level
      this.positions = new Map(
        f.openPositions.map((t: unknown[]) => {
          const p = parsePosition(t);
          return [p.positionId, p] as const;
        })
      );
      this.operations = new Map(
        (f.operations ?? []).map((t: unknown[]) => {
          const o = parseOperation(t);
          return [o.intentId, o] as const;
        })
      );
      this.applyState(f);
      this.accountRevision = Number(f.accountRevision ?? 0);
      this.primed = true;
      return { kind: "applied", closed: [] };
    }
    if (
      Array.isArray(f.addedPositions) ||
      Array.isArray(f.removedPositionIds) ||
      Array.isArray(f.addedOperations) ||
      Array.isArray(f.removedOperationIds)
    ) {
      // patch frame
      if (!this.primed) return { kind: "resync" };
      if (f.baseAccountRevision != null && Number(f.baseAccountRevision) !== this.accountRevision)
        return { kind: "resync" };
      for (const id of f.removedPositionIds ?? []) this.positions.delete(String(id));
      for (const t of f.addedPositions ?? []) {
        const p = parsePosition(t);
        this.positions.set(p.positionId, p);
      }
      for (const id of f.removedOperationIds ?? []) this.operations.delete(String(id));
      for (const t of f.addedOperations ?? []) {
        const o = parseOperation(t);
        this.operations.set(o.intentId, o);
      }
      if (f.state) this.applyState(f.state);
      this.accountRevision = Number(f.accountRevision ?? this.accountRevision);
      return { kind: "applied", closed: (f.closedPositions ?? []).map(parseClosed) };
    }
    return { kind: "ignored" };
  }

  private applyState(s: any) {
    if (s.balance != null) this.balance = Number(s.balance) / COLLATERAL;
    if (s.queued != null) this.queued = Number(s.queued) / COLLATERAL;
    if (s.locked != null) this.locked = Number(s.locked) / COLLATERAL;
    if (s.funds?.availableBalance != null) this.available = Number(s.funds.availableBalance) / COLLATERAL;
    if (s.paper && typeof s.paper === "object") {
      const p = s.paper;
      this.paper = {
        balance: big(p.balance ?? p.paper_balance),
        staked: big(p.staked ?? p.paper_staked),
        pendingBase: big(p.pendingBase ?? p.paper_pending),
        rewardDebt: big(p.rewardDebt ?? p.paper_debt),
      };
    }
    if (s.lifetime && typeof s.lifetime === "object") {
      const l = s.lifetime;
      this.lifetime = {
        deposited: Number(l.depositedRaw ?? 0) / COLLATERAL,
        withdrawn: Number(l.withdrawnRaw ?? 0) / COLLATERAL,
        realizedPnl: Number(l.realizedPnlRaw ?? 0) / COLLATERAL,
        feesPaid: Number(l.feesPaidRaw ?? 0) / COLLATERAL,
        tradedNotional: Number(l.tradedNotionalRaw ?? 0) / COLLATERAL,
        paperRewardsClaimed: Number(l.paperRewardsClaimedRaw ?? 0) / COLLATERAL,
      };
    }
    if (s.indexedThroughBlock != null) this.indexedThroughBlock = Number(s.indexedThroughBlock);
    if (Array.isArray(s.sessionKeys)) {
      // tuple: [address, expiryUnixS]
      this.sessionKeys = s.sessionKeys.map((k: unknown[]) => String(k[0]).toLowerCase());
      const exp: Record<string, number> = {};
      for (const k of s.sessionKeys as unknown[][]) {
        const e = Number(k[1]);
        if (Number.isFinite(e)) exp[String(k[0]).toLowerCase()] = e;
      }
      this.sessionKeyExpiry = exp;
    }
    if (Array.isArray(s.operations))
      this.operations = new Map(
        s.operations.map((t: unknown[]) => {
          const o = parseOperation(t);
          return [o.intentId, o] as const;
        })
      );
  }

  snapshot(): WalletSnapshot {
    return {
      balance: this.balance,
      paper: this.paper,
      lifetime: this.lifetime,
      indexedThroughBlock: this.indexedThroughBlock,
      available: this.available,
      queued: this.queued,
      locked: this.locked,
      openPositions: [...this.positions.values()].sort((a, b) => b.openedAtMs - a.openedAtMs),
      operations: [...this.operations.values()].sort((a, b) => b.timeMs - a.timeMs),
      sessionKeys: this.sessionKeys,
      sessionKeyExpiry: this.sessionKeyExpiry,
    };
  }
}

/**
 * Minimal SSE line parser for fetch() bodies (Node has no EventSource).
 * Feed it decoded text chunks; it yields {event, data} per blank-line-terminated block.
 */
export class SseParser {
  private buf = "";
  push(text: string, onEvent: (ev: { event: string; data: string }) => void): void {
    this.buf += text.replace(/\r\n/g, "\n");
    let i: number;
    while ((i = this.buf.indexOf("\n\n")) >= 0) {
      const block = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 2);
      let event = "message";
      const data: string[] = [];
      for (const line of block.split("\n")) {
        if (line.startsWith(":")) continue; // comment / keepalive
        const c = line.indexOf(":");
        const field = c < 0 ? line : line.slice(0, c);
        const value = c < 0 ? "" : line.slice(c + 1).replace(/^ /, "");
        if (field === "event") event = value;
        else if (field === "data") data.push(value);
      }
      if (data.length) onEvent({ event, data: data.join("\n") });
    }
    // guard against a runaway block that never terminates
    if (this.buf.length > 4_000_000) this.buf = "";
  }
}
