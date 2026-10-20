// Trigger orders — the pure core, shared by the watcher (server/engine.ts,
// which makes every fire decision) and the browser (display, arm-time
// validation). No I/O, no clock of its own, no persistence.
//
// Papertrade's Exchange accepts exactly two trading intents and neither has a
// price field (shared/intentSchema.ts): an intent fills later, at whatever
// price the relayer's queue gives it. So a "limit order" is impossible — what
// lives here is a *trigger*: when live price crosses the user's level, the
// watcher submits the ordinary market intent. The fill price is NOT the
// trigger price, and the UI copy says so.
//
// Fire rules (unchanged from the client engine this replaces):
//  - a cross must be confirmed by a sample with a strictly NEWER tick
//    timestamp than the crossing print; re-reading the same print on a timer
//    confirms nothing. Entries additionally wait CONFIRM_MS.
//  - a retreat back across the level resets to armed (wick skipped).
//  - a sample older than STALE_MS (by receipt time) cannot fire anything.
//  - expiry beats a same-tick cross.

export type TriggerStatus =
  | "armed"
  | "confirming"
  | "firing"
  | "queued"
  | "executed"
  | "unknown"
  | "unreconciled"
  | "expired"
  | "failed"
  | "cancelled"
  | "done"
  | "attention";

export type CrossDirection = "down-to" | "up-to";

export interface TriggerEntry {
  id: string;
  wallet: string;
  instrumentId: number;
  isLong: boolean;
  marginUsdc: number;
  leverage: number;
  useDebt: boolean;
  triggerPrice: number;
  cross: CrossDirection;
  expiresAt: number | null;
  status: TriggerStatus;
  createdAt: number;
  firedAt?: number;
  intentId?: string;
  error?: string;
  /** ms epoch when the crossing sample was seen (while confirming) */
  confirmingSince?: number | null;
  /** tick timestamp of the crossing sample — confirmation needs a newer one */
  crossSampleTs?: number | null;
  /** position ids open for this instrument at submit time (executed-effect detection) */
  prePositionIds?: string[];
  /** consecutive evaluations where the queued intent was absent from the
   *  snapshot's operations with no visible effect (reconcile grace, N-2) */
  absentEvals?: number;
  /** entry price of the position this entry became, once executed */
  executedPrice?: number;
  /** user asked to cancel the queued intent */
  cancelRequested?: boolean;
  /** watcher sent the cancelIntent (one attempt) */
  cancelSentAt?: number;
  lastCancelError?: string;
  /** set by a re-arm: the engine re-baselines on the next fresh sample instead of trusting history */
  rebaseline?: boolean;
  /** stop to create for the position this entry becomes, the moment the fill is seen */
  attachedStop?: AttachedStop | null;
  /** id of the stop row spawned from `attachedStop` (set once, at execution) */
  spawnedStopId?: string;
  /** how the spawned stop differed from what was asked */
  spawnNote?: "clamped";
}

/**
 * A stop that does not exist yet: it is created for the position a trigger
 * entry turns into. `pct` is the adverse distance from the FILL price as a
 * fraction (0.02 = 2 % — long: fill × 0.98, short: fill × 1.02); `price` is
 * a fixed level.
 */
export interface AttachedStop {
  mode: "pct" | "price";
  value: number;
}

export interface StopLoss {
  id: string;
  wallet: string;
  positionId: string;
  instrumentId: number;
  isLong: boolean;
  stopPrice: number;
  status: TriggerStatus;
  createdAt: number;
  firedAt?: number;
  intentId?: string;
  /** terminal failure reason (definitive class only) */
  error?: string;
  /** most recent transient failure — shown in the UI, cleared on success */
  lastError?: string;
  confirmingSince?: number | null;
  crossSampleTs?: number | null;
  /** set when this stop was spawned by a trigger entry's attached stop */
  fromEntryId?: string;
  /** consecutive evaluations where the position was absent from the snapshot */
  absentEvals?: number;
  /** consecutive evaluations where the queued intent had left operations while
   *  the position was still open — no visible effect (reconcile grace, N-2) */
  missedEvals?: number;
  /** last fire attempt (drives the re-fire cooldown after transient failures) */
  lastAttemptAt?: number;
  cancelRequested?: boolean;
  cancelSentAt?: number;
  lastCancelError?: string;
  rebaseline?: boolean;
}

/** What the ticket sends when the user arms a trigger entry. */
export interface ArmEntrySpec {
  instrumentId: number;
  isLong: boolean;
  marginUsdc: number;
  leverage: number;
  useDebt: boolean;
  triggerPrice: number;
  cross: CrossDirection;
  expiresAt: number | null;
  /** optional stop to spawn on fill (absent / null = none) */
  attachedStop?: AttachedStop | null;
}

export interface ArmStopSpec {
  positionId: string;
  instrumentId: number;
  isLong: boolean;
  stopPrice: number;
}

/** One live price observation. `ts` is the feed's tick timestamp; `live`
 *  asserts the sample came from a live (never simulated) feed. */
export interface PriceSample {
  price: number;
  ts: number;
  receivedAt: number;
  live: boolean;
}

/** validation/fire failure codes → i18n keys (data only; this module stays i18n-free) */
export const TRIGGER_ERROR_KEYS: Record<string, string> = {
  session: "trig.err.session",
  "session-inactive": "trig.err.session",
  "wallet-mismatch": "trig.err.session",
  "key-revoked": "trig.err.keyRevoked",
  "key-expired": "trig.err.keyExpired",
  "trading-paused": "trig.err.tradingPaused",
  "no-snapshot": "trig.err.noSnapshot",
  "no-proto": "trig.err.noProto",
  "market-unavailable": "trig.err.marketUnavailable",
  "lev-too-high": "trig.err.levTooHigh",
  "insufficient-available": "trig.err.insufficient",
  "below-min-trade": "trig.err.belowMinTrade",
  "below-min-notional": "trig.err.belowMinNotional",
  interrupted: "trig.err.interrupted",
  killed: "trig.err.killed",
  breaker: "trig.err.killed",
  "not-leader": "trig.err.interrupted",
  network: "trig.err.interrupted",
};

/** entries must still be past the level on a newer-timestamp sample at least this long after the crossing sample */
export const CONFIRM_MS = 600;
/** a sample older than this (by receipt time) cannot fire anything */
export const STALE_MS = 10_000;
/** a "firing" with no recorded result for this long is an unknown outcome */
export const FIRING_GRACE_MS = 60_000;
/** intent deadline after submission (shared/intentWire INTENT_TTL_S = 3600) */
export const INTENT_TTL_MS = 3_600_000;
/** stops wait this long between fire attempts after a transient failure */
export const STOP_RETRY_COOLDOWN_MS = 5_000;
/** an armed stop closer than this (fraction of price) to the bust price is "too close" */
export const STOP_BUST_MIN_BUFFER = 0.01;
/** server-side caps (SPEC §5) */
export const MAX_LIVE_TRIGGERS_PER_WALLET = 25;
export const MAX_TRIGGER_MARGIN_USDC = 1_000_000;

export const LIVE_STATUSES: ReadonlySet<TriggerStatus> = new Set(["armed", "confirming", "firing"]);
export const TERMINAL_STATUSES: ReadonlySet<TriggerStatus> = new Set([
  "executed",
  "unreconciled",
  "expired",
  "failed",
  "cancelled",
  "done",
]);
export const isLive = (s: TriggerStatus): boolean => LIVE_STATUSES.has(s);
export const isTerminal = (s: TriggerStatus): boolean => TERMINAL_STATUSES.has(s);

// ---------------------------------------------------------------------------
// Pure price logic
// ---------------------------------------------------------------------------

/** Is `price` at or past `level` in the `cross` direction? */
export function pastLevel(price: number, level: number, cross: CrossDirection): boolean {
  if (!Number.isFinite(price)) return false;
  return cross === "down-to" ? price <= level : price >= level;
}

/**
 * Did price cross `level` in the `cross` direction between the previous sample
 * and this one? A missing previous sample counts as a cross when the price is
 * already past the level — used only for in-session arming (restart/gap paths
 * re-baseline or quarantine instead, so a stale baseline can't fabricate one).
 */
export function crossed(prev: number | null | undefined, now: number, level: number, cross: CrossDirection): boolean {
  if (!pastLevel(now, level, cross)) return false;
  if (prev == null || !Number.isFinite(prev)) return true;
  return !pastLevel(prev, level, cross);
}

/** Stop-loss hit test: long stops fire at/below the stop, shorts at/above. */
export function stopHit(price: number | null | undefined, stop: Pick<StopLoss, "isLong" | "stopPrice">): boolean {
  if (price == null || !Number.isFinite(price)) return false;
  return stop.isLong ? price <= stop.stopPrice : price >= stop.stopPrice;
}

export interface EntryStep {
  status: TriggerStatus;
  confirmingSince: number | null;
  crossSampleTs: number | null;
  fire: boolean;
  expired: boolean;
}

/**
 * One evaluation step for a trigger entry.
 *
 * armed ──crossing sample──▶ confirming ──newer-ts sample ≥600 ms later, still
 * past──▶ fire. Confirming ──price retreats back across──▶ armed (wick skipped).
 * Expiry beats a same-tick cross.
 */
export function nextEntryState(
  entry: Pick<TriggerEntry, "status" | "cross" | "triggerPrice" | "expiresAt" | "confirmingSince" | "crossSampleTs">,
  prevSample: PriceSample | undefined,
  sample: PriceSample | undefined,
  nowMs: number
): EntryStep {
  const idle: EntryStep = {
    status: entry.status,
    confirmingSince: entry.confirmingSince ?? null,
    crossSampleTs: entry.crossSampleTs ?? null,
    fire: false,
    expired: false,
  };
  if (entry.status !== "armed" && entry.status !== "confirming") return idle;
  if (entry.expiresAt != null && nowMs >= entry.expiresAt)
    return { status: "expired", confirmingSince: null, crossSampleTs: null, fire: false, expired: true };
  if (!sample || !Number.isFinite(sample.price)) return idle;

  if (entry.status === "armed") {
    if (crossed(prevSample?.price, sample.price, entry.triggerPrice, entry.cross))
      return { status: "confirming", confirmingSince: nowMs, crossSampleTs: sample.ts, fire: false, expired: false };
    return idle;
  }

  // confirming
  const since = entry.confirmingSince ?? nowMs;
  const crossTs = entry.crossSampleTs ?? Number.NEGATIVE_INFINITY;
  if (!pastLevel(sample.price, entry.triggerPrice, entry.cross))
    return { status: "armed", confirmingSince: null, crossSampleTs: null, fire: false, expired: false };
  if (sample.ts > crossTs && nowMs - since >= CONFIRM_MS)
    return { status: "firing", confirmingSince: null, crossSampleTs: null, fire: true, expired: false };
  return { status: "confirming", confirmingSince: since, crossSampleTs: entry.crossSampleTs ?? null, fire: false, expired: false };
}

export interface StopStep {
  status: TriggerStatus;
  confirmingSince: number | null;
  crossSampleTs: number | null;
  fire: boolean;
}

/**
 * One evaluation step for a stop-loss: two consecutive samples with DISTINCT
 * timestamps at/past the stop. A sample back inside the level resets to armed
 * — a single bad print never fires a stop.
 */
export function nextStopState(
  stop: Pick<StopLoss, "status" | "isLong" | "stopPrice" | "confirmingSince" | "crossSampleTs">,
  sample: PriceSample | undefined,
  nowMs: number
): StopStep {
  const idle: StopStep = {
    status: stop.status,
    confirmingSince: stop.confirmingSince ?? null,
    crossSampleTs: stop.crossSampleTs ?? null,
    fire: false,
  };
  if (stop.status !== "armed" && stop.status !== "confirming") return idle;
  if (!sample || !Number.isFinite(sample.price)) return idle;

  if (stop.status === "armed") {
    if (stopHit(sample.price, stop)) return { status: "confirming", confirmingSince: nowMs, crossSampleTs: sample.ts, fire: false };
    return idle;
  }

  const crossTs = stop.crossSampleTs ?? Number.NEGATIVE_INFINITY;
  if (!stopHit(sample.price, stop)) return { status: "armed", confirmingSince: null, crossSampleTs: null, fire: false };
  if (sample.ts > crossTs) return { status: "firing", confirmingSince: null, crossSampleTs: null, fire: true };
  return idle;
}

/** A sample the engine may act on: live, finite, and received within STALE_MS. */
export function freshSample(sample: PriceSample | undefined, nowMs: number): sample is PriceSample {
  return !!sample && sample.live && Number.isFinite(sample.price) && nowMs - sample.receivedAt <= STALE_MS;
}

// ---------------------------------------------------------------------------
// Record validation — persisted / client-supplied data is untrusted input
// ---------------------------------------------------------------------------

export const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const DECIMAL_RE = /^\d{1,78}$/;
const STATUSES: ReadonlySet<string> = new Set([
  "armed", "confirming", "firing", "queued", "executed", "unknown",
  "unreconciled", "expired", "failed", "cancelled", "done", "attention",
]);

const isPosFinite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;

/** instrument ids the engine will act on — injected so the market table stays the single source */
export type InstrumentSet = ReadonlySet<number>;

export function validateArmEntrySpec(x: unknown, instruments: InstrumentSet): ArmEntrySpec | null {
  if (!x || typeof x !== "object") return null;
  const e = x as Record<string, unknown>;
  if (typeof e.instrumentId !== "number" || !instruments.has(e.instrumentId)) return null;
  if (typeof e.isLong !== "boolean") return null;
  if (!isPosFinite(e.marginUsdc) || e.marginUsdc > MAX_TRIGGER_MARGIN_USDC) return null;
  if (typeof e.leverage !== "number" || !Number.isInteger(e.leverage) || e.leverage < 1 || e.leverage > 10_000) return null;
  if (!isPosFinite(e.triggerPrice) || e.triggerPrice > 1e12) return null;
  if (e.cross !== "down-to" && e.cross !== "up-to") return null;
  if (!(e.expiresAt === null || (isPosFinite(e.expiresAt) && e.expiresAt < 4e12))) return null;
  if (typeof e.useDebt !== "boolean") return null;
  const attachedStop = validateAttachedStop(e.attachedStop);
  if (attachedStop === undefined) return null;
  if (attachedStop && attachedStopProblem(attachedStop, { isLong: e.isLong, leverage: e.leverage, triggerPrice: e.triggerPrice })) return null;
  return {
    instrumentId: e.instrumentId,
    isLong: e.isLong,
    marginUsdc: e.marginUsdc,
    leverage: e.leverage,
    useDebt: e.useDebt,
    triggerPrice: e.triggerPrice,
    cross: e.cross,
    expiresAt: e.expiresAt as number | null,
    attachedStop,
  };
}

/** absent/null → null (no stop); valid → the stop; anything else → undefined (reject) */
export function validateAttachedStop(x: unknown): AttachedStop | null | undefined {
  if (x == null) return null;
  if (typeof x !== "object") return undefined;
  const a = x as Record<string, unknown>;
  if (a.mode === "pct") {
    // 0 < pct ≤ 50 % — anything larger is past the bust price of every leverage ≥ 2
    if (!isPosFinite(a.value) || a.value > 0.5) return undefined;
    return { mode: "pct", value: a.value };
  }
  if (a.mode === "price") {
    if (!isPosFinite(a.value) || a.value > 1e12) return undefined;
    return { mode: "price", value: a.value };
  }
  return undefined;
}

/**
 * Arm-time sanity of an attached stop against the entry it hangs on, before a
 * fill exists. Returns a reason code or null. The bust check uses the
 * leverage-only approximation (fill × (1 ∓ 1/lev)); fees move it slightly, so
 * the fill-time clamp in `resolveAttachedStop` is still the authority.
 */
export function attachedStopProblem(
  a: AttachedStop,
  entry: { isLong: boolean; leverage: number; triggerPrice: number }
): "beyond-bust" | "wrong-side" | null {
  const bustFrac = 1 / entry.leverage;
  if (a.mode === "pct") return a.value >= bustFrac ? "beyond-bust" : null;
  // fixed price: must sit on the loss side of the trigger price, above the approximate bust
  if (entry.isLong ? a.value >= entry.triggerPrice : a.value <= entry.triggerPrice) return "wrong-side";
  const approxBust = entry.isLong ? entry.triggerPrice * (1 - bustFrac) : entry.triggerPrice * (1 + bustFrac);
  if (entry.isLong ? a.value <= approxBust : a.value >= approxBust) return "beyond-bust";
  return null;
}

/** the stop level an attached stop implies for a given reference (fill or trigger) price — no clamping */
export function attachedStopLevel(a: AttachedStop, isLong: boolean, refPrice: number): number {
  if (a.mode === "price") return a.value;
  return isLong ? refPrice * (1 - a.value) : refPrice * (1 + a.value);
}

/**
 * Fill-time resolution. The one hard rule: the stop must be on the live side
 * of the real bust price (a stop beyond bust can never fire — the bust comes
 * first). Such a stop is clamped to just inside bust (10 % of the entry→bust
 * distance) and flagged, rather than dropped. A level already past the current
 * price is NOT touched: that is a gap-through and the stop should fire.
 */
export function resolveAttachedStop(
  a: AttachedStop,
  fill: { isLong: boolean; entryPrice: number; bustPrice: number }
): { stopPrice: number; clamped: boolean } | null {
  if (!isPosFinite(fill.entryPrice) || !isPosFinite(fill.bustPrice)) return null;
  const raw = attachedStopLevel(a, fill.isLong, fill.entryPrice);
  if (!isPosFinite(raw)) return null;
  const span = Math.abs(fill.entryPrice - fill.bustPrice);
  if (span <= 0) return null;
  const inside = fill.isLong ? fill.bustPrice + span * 0.1 : fill.bustPrice - span * 0.1;
  const beyond = fill.isLong ? raw <= fill.bustPrice : raw >= fill.bustPrice;
  return beyond ? { stopPrice: inside, clamped: true } : { stopPrice: raw, clamped: false };
}

export function validateArmStopSpec(x: unknown, instruments: InstrumentSet): ArmStopSpec | null {
  if (!x || typeof x !== "object") return null;
  const s = x as Record<string, unknown>;
  if (typeof s.positionId !== "string" || !DECIMAL_RE.test(s.positionId)) return null;
  if (typeof s.instrumentId !== "number" || !instruments.has(s.instrumentId)) return null;
  if (typeof s.isLong !== "boolean") return null;
  if (!isPosFinite(s.stopPrice) || s.stopPrice > 1e12) return null;
  return { positionId: s.positionId, instrumentId: s.instrumentId, isLong: s.isLong, stopPrice: s.stopPrice };
}

export function validateTriggerEntry(x: unknown, instruments: InstrumentSet): TriggerEntry | null {
  if (!x || typeof x !== "object") return null;
  const e = x as Record<string, unknown>;
  if (typeof e.id !== "string" || !e.id) return null;
  if (typeof e.wallet !== "string" || !ADDRESS_RE.test(e.wallet)) return null;
  const spec = validateArmEntrySpec(e, instruments);
  if (!spec) return null;
  // "filled" is admitted here ONLY so the legacy remap below can run
  if (typeof e.status !== "string" || !(STATUSES.has(e.status) || e.status === "filled")) return null;
  if (!isPosFinite(e.createdAt)) return null;
  const out = { ...(e as unknown as TriggerEntry), ...spec };
  if ((e.status as string) === "filled") out.status = "queued";
  return out;
}

export function validateStopLoss(x: unknown, instruments: InstrumentSet): StopLoss | null {
  if (!x || typeof x !== "object") return null;
  const s = x as Record<string, unknown>;
  if (typeof s.id !== "string" || !s.id) return null;
  if (typeof s.wallet !== "string" || !ADDRESS_RE.test(s.wallet)) return null;
  const spec = validateArmStopSpec(s, instruments);
  if (!spec) return null;
  if (typeof s.status !== "string" || !(STATUSES.has(s.status) || s.status === "filled")) return null;
  if (!isPosFinite(s.createdAt)) return null;
  const out = { ...(s as unknown as StopLoss), ...spec };
  if ((s.status as string) === "filled") out.status = "queued";
  return out;
}
