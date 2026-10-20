// Protocol-level reads from papertrade's public endpoints (via the /pt proxy)
// plus shared formatting helpers. All shapes decoded from their frontend.

import { tr, type Key as I18nKey } from "./i18n";

const PT = "/pt";
const C = 1e18; // collateral scale

// ---- instruments (/state/trading) -------------------------------------------
// Row tuple (anchored by maxLeverage=1000 at index 14):
// [0] id, [1] symbol, [2] assetIndex, [3] priceScaleRaw, [4] active, [5] paused,
// [6..8] lifecycle flags, [9..11] terminal (frozenBid/Ask, pausedAt),
// [12] rateMultiplierRaw, [13] positionMultiplierRaw, [14] maxLeverage,
// [15] maxPositionNotionalRaw, [16] bustBufferRaw, [17] baseRateRaw,
// [18] referenceNotionalRaw, [19] longOiRaw, [20] shortOiRaw,
// [21] longCapRaw, [22] shortCapRaw

export interface Instrument {
  id: number;
  symbol: string;
  priceScale: number;
  active: boolean;
  paused: boolean;
  maxLeverage: number;
  maxPositionNotional: number; // USD
  /** bust buffer as a fraction (e.g. 0.00048 = 0.048%) applied on top of 1/leverage */
  bustBuffer: number;
  /** open interest in asset units (multiply by price for USD) */
  longOi: number;
  shortOi: number;
  /** OI caps in asset units; 0 / absurdly large = uncapped */
  longCap: number;
  shortCap: number;
}

/**
 * papertrade's bust price, exactly as their ticket computes it:
 *   d = price / leverage;  a = long ? price - d : price + d
 *   long:  a + a·buffer      short: a - a·buffer
 */
export function bustPrice(price: number, leverage: number, isLong: boolean, buffer = 0): number {
  const d = price / leverage;
  const a = isLong ? price - d : price + d;
  return isLong ? a + a * buffer : a - a * buffer;
}

/** OI headroom on one side in USD (null when that side is uncapped). */
export function oiHeadroomUsd(inst: Instrument, isLong: boolean, mark: number | null): number | null {
  const cap = isLong ? inst.longCap : inst.shortCap;
  const oi = isLong ? inst.longOi : inst.shortOi;
  if (!cap || cap > 1e30 || !mark) return null;
  return Math.max(0, cap - oi) * mark;
}

export interface TradingState {
  tradingPaused: boolean;
  minimumTradeUsdc: number;
  minimumOpenNotionalUsdc: number;
  instruments: Instrument[];
  /** relayer intake controls: minimum PAPER stake + actions currently paused */
  intake: { minimumPaperStake: number; paused: string[] };
}

function parseIntake(raw: unknown): TradingState["intake"] {
  // tuple [revision, minimumPaperStakeRaw, pausedActions[]] (or an object with the same fields)
  if (Array.isArray(raw)) {
    return {
      minimumPaperStake: Number(raw[1] ?? "0") / C,
      paused: Array.isArray(raw[2]) ? raw[2].map(String) : [],
    };
  }
  if (raw && typeof raw === "object") {
    const o = raw as any;
    return {
      minimumPaperStake: Number(o.minimumPaperStakeRaw ?? "0") / C,
      paused: Array.isArray(o.paused) ? o.paused.map(String) : [],
    };
  }
  return { minimumPaperStake: 0, paused: [] };
}

export async function fetchTradingState(): Promise<TradingState> {
  const res = await fetch(`${PT}/state/trading`);
  if (!res.ok) throw new Error(`state/trading ${res.status}`);
  const j = await res.json();
  return {
    tradingPaused: !!j.tradingPaused,
    minimumTradeUsdc: Number(j.minimumTradeSizeRaw ?? "0") / C,
    minimumOpenNotionalUsdc: Number(j.minimumOpenNotionalRaw ?? "0") / C,
    intake: parseIntake(j.intakeControls ?? j.intake),
    instruments: (j.instruments ?? []).map((r: any[]) => ({
      id: Number(r[0]),
      symbol: String(r[1]),
      priceScale: Number(r[3]),
      active: !!r[4],
      paused: !!r[5],
      maxLeverage: Number(r[14] ?? 1000),
      maxPositionNotional: Number(r[15] ?? "0") / C,
      bustBuffer: Number(r[16] ?? "0") / C,
      longOi: Number(r[19] ?? "0") / C,
      shortOi: Number(r[20] ?? "0") / C,
      longCap: Number(r[21] ?? "0") / C,
      shortCap: Number(r[22] ?? "0") / C,
    })),
  };
}

// ---- market stats (/query/protocol/market-stats) -----------------------------

/** 24h volume in USD per market id. */
export async function fetchMarketStats(): Promise<Record<number, number>> {
  const res = await fetch(`${PT}/query/protocol/market-stats`);
  if (!res.ok) throw new Error(`market-stats ${res.status}`);
  const j = await res.json();
  const out: Record<number, number> = {};
  for (const [id, m] of Object.entries(j.markets ?? {})) {
    out[Number(id)] = Number((m as any).volume_24h ?? "0") / C;
  }
  return out;
}

// ---- queue rank (/queue-rank/accounts/:addr) ---------------------------------

/** intentId → position in the execution queue. */
export async function fetchQueueRank(wallet: string): Promise<Record<string, number>> {
  const res = await fetch(`${PT}/queue-rank/accounts/${wallet.toLowerCase()}`);
  if (!res.ok) return {};
  const j = await res.json();
  const out: Record<string, number> = {};
  for (const e of j.entries ?? []) out[String(e.intentId)] = Number(e.position);
  return out;
}

// ---- trade history (/query/accounts/:addr/trades) ----------------------------

export interface TradeHistoryItem {
  timestampMs: number;
  positionId: string;
  instrumentId: number;
  symbol: string;
  isLong: boolean;
  entryPrice: number;
  exitPrice: number;
  margin: number;
  leverage: number;
  liquidated: boolean;
  netPnl: number; // USD, signed, after fees
  feePaid: number;
  txHash: string;
  openedAtMs: number | null;
}

function parseTrade(it: any): TradeHistoryItem {
  const scale = Number(it.priceScaleRaw ?? 1);
  return {
    timestampMs: Number(it.timestampMs),
    positionId: String(it.positionId),
    instrumentId: Number(it.instrumentId),
    symbol: String(it.symbol),
    isLong: !!it.isLong,
    entryPrice: Number(it.entryPriceRaw) / scale,
    exitPrice: Number(it.exitPriceRaw) / scale,
    margin: Number(it.marginRaw) / C,
    leverage: Number(it.leverage),
    liquidated: it.kind === "Liquidated",
    netPnl: Number(it.adjustedPnlRaw) / C,
    feePaid: Number(it.userPaidFeeRaw) / C,
    txHash: String(it.txHash),
    openedAtMs: it.openedAtMs != null ? Number(it.openedAtMs) : null,
  };
}

/** Raw trade rows. Their server insists on the canonical query order (filter before limit). */
async function rawTrades(wallet: string): Promise<any[]> {
  const res = await fetch(`${PT}/query/accounts/${wallet.toLowerCase()}/trades?filter=all&limit=75`);
  if (!res.ok) throw new Error(`trades ${res.status}`);
  const j = await res.json();
  return j.items ?? [];
}

export async function fetchTradeHistory(wallet: string): Promise<TradeHistoryItem[]> {
  return (await rawTrades(wallet)).map(parseTrade);
}

// ---- protocol summary (/query/protocol/summary) ------------------------------

export interface PaperParams {
  /** PAPER minted per $1 loss while LP is below the threshold */
  flatRate: number;
  /** LP balance (USD) above which minting decays */
  threshold: number;
  decayScale: number;
  tailProgress: number;
  trackedLp: number;
  stakerCap: number;
  currentLp: number;
}

export interface ProtocolSummary {
  block: number;
  atMs: number;
  genesisMs: number;
  tvl: number;
  margin: number;
  lp: number;
  reserve: number;
  queue: number;
  volume: number;
  openPositions: number;
  feesPending: number;
  feesLifetime: number;
  paper: {
    supplyRaw: bigint;
    stakedRaw: bigint;
    accumulatorRaw: bigint;
    /** USDC waiting to be distributed to stakers */
    pendingRewards: number;
    reserve: number;
    params: PaperParams;
  };
}

export async function fetchProtocolSummary(): Promise<ProtocolSummary> {
  const res = await fetch(`${PT}/query/protocol/summary`);
  if (!res.ok) throw new Error(`summary ${res.status}`);
  const j = await res.json();
  const b = j.balances ?? {};
  const p = j.paper ?? {};
  const n = (v: unknown) => Number(v ?? "0") / C;
  const lpNow = n(b.lp) + n(b.reserve) - n(b.queue);
  return {
    block: Number(j.source?.block ?? 0),
    atMs: Number(j.source?.at ?? Date.now()),
    genesisMs: Number(j.source?.genesis ?? 0),
    tvl: n(b.tvl),
    margin: n(b.margin),
    lp: n(b.lp),
    reserve: n(b.reserve),
    queue: n(b.queue),
    volume: n(j.activity?.volume),
    openPositions: Number(j.activity?.open ?? 0),
    feesPending: n(j.fees?.pending),
    feesLifetime: n(j.fees?.lifetime),
    paper: {
      supplyRaw: BigInt(p.supply ?? "0"),
      stakedRaw: BigInt(p.staked ?? "0"),
      accumulatorRaw: BigInt(p.accumulator ?? "0"),
      pendingRewards: n(p.pendingRewards),
      reserve: n(p.reserve),
      params: {
        flatRate: n(p.rate),
        threshold: n(p.cliff),
        decayScale: n(p.decay),
        tailProgress: n(p.tailProgress),
        trackedLp: n(p.trackedLp),
        stakerCap: n(p.cap),
        currentLp: lpNow,
      },
    },
  };
}

/** PAPER minted per $1 of realized loss at a given LP balance — their `U(lp, params)`. */
export function mintRate(lp: number, p: PaperParams): number {
  if (lp < p.threshold) return p.flatRate;
  if (p.decayScale <= 0) return 0;
  const n = p.tailProgress + Math.max(0, lp - Math.max(p.trackedLp, p.threshold));
  const r = p.decayScale / (p.decayScale + n);
  return p.flatRate * r * r;
}

/** Staker reward tier (their copy shows 0% / 1% / 99%): LP<0 → 0, LP ≥ cap → 99, else 1. */
export function rewardTier(s: ProtocolSummary): 0 | 1 | 99 {
  const lp = s.lp + s.reserve - s.queue;
  const cap = s.paper.params.stakerCap;
  return lp < 0 ? 0 : cap > 0 && lp >= cap ? 99 : 1;
}

const ACC_SCALE = 10n ** 27n;

/**
 * Claimable USDC for a staker, exactly as their portfolio computes it:
 * pendingBase + max(0, staked·accumulator/1e27 − rewardDebt).
 */
export function claimableRewards(
  paper: { staked: bigint; pendingBase: bigint; rewardDebt: bigint },
  accumulatorRaw: bigint
): number {
  const accrued = (paper.staked * accumulatorRaw) / ACC_SCALE - paper.rewardDebt;
  const raw = paper.pendingBase + (accrued > 0n ? accrued : 0n);
  return Number(raw) / C;
}

export function paperAmount(raw: bigint): number {
  return Number(raw) / C;
}

// ---- protocol history (/query/protocol/history?interval=) --------------------

export type HistoryInterval = "1m" | "1h" | "1d";

export interface ProtocolHistory {
  startMs: number;
  intervalMs: number;
  asOfMs: number;
  columns: Record<string, (number | null)[]>;
  totals: Record<string, number>;
}

export async function fetchProtocolHistory(interval: HistoryInterval): Promise<ProtocolHistory> {
  const res = await fetch(`${PT}/query/protocol/history?interval=${interval}`);
  if (!res.ok) throw new Error(`history ${res.status}`);
  const j = await res.json();
  const columns: Record<string, (number | null)[]> = {};
  for (const [k, v] of Object.entries(j.columns ?? {}))
    columns[k] = (v as unknown[]).map((x) => (x == null ? null : Number(x)));
  const totals: Record<string, number> = {};
  for (const [k, v] of Object.entries(j.totals ?? {})) totals[k] = Number(v);
  return {
    startMs: Number(j.startMs),
    intervalMs: Number(j.intervalMs),
    asOfMs: Number(j.source?.asOfMs ?? Date.now()),
    columns,
    totals,
  };
}

// ---- PAPER activity (/query/protocol/paper/activity) ------------------------

export interface PaperActivityItem {
  timestampMs: number;
  txHash: string;
  amount: number; // PAPER
  kind: "minted" | "staked" | "unstaked";
  user: string;
}

export async function fetchPaperActivity(): Promise<{ items: PaperActivityItem[]; latestDistributionMs: number | null }> {
  const res = await fetch(`${PT}/query/protocol/paper/activity`);
  if (!res.ok) throw new Error(`paper/activity ${res.status}`);
  const j = await res.json();
  return {
    items: (j.items ?? []).map((it: any) => ({
      timestampMs: Number(it.timestampMs),
      txHash: String(it.txHash),
      amount: Number(it.amountRaw) / C,
      kind: it.kind,
      user: String(it.userAddress ?? ""),
    })),
    latestDistributionMs: j.latestDistribution ? Number(j.latestDistribution.timestampMs) : null,
  };
}

// ---- portfolio history (/query/accounts/:addr/portfolio-history?range=) -----

export type PortfolioRange = "1d" | "1w" | "all";

export interface PortfolioHistory {
  fromMs: number;
  toMs: number;
  points: { t: number; equity: number | null; pnl: number | null; stakingRewards: number | null }[];
}

export async function fetchPortfolioHistory(wallet: string, range: PortfolioRange): Promise<PortfolioHistory> {
  const res = await fetch(`${PT}/query/accounts/${wallet.toLowerCase()}/portfolio-history?range=${range}`);
  if (!res.ok) throw new Error(`portfolio-history ${res.status}`);
  const j = await res.json();
  const base = Number(j.baseTimeMs ?? j.fromMs ?? 0);
  const offs: number[] = j.timeOffsetsMs ?? [];
  const col = (k: string): unknown[] => j.columns?.[k] ?? [];
  const eq = col("equity");
  const pnl = col("pnl");
  const sr = col("stakingRewards");
  const num = (v: unknown) => (v == null ? null : Number(v));
  return {
    fromMs: Number(j.fromMs ?? base),
    toMs: Number(j.toMs ?? Date.now()),
    points: offs.map((o, i) => ({ t: base + o, equity: num(eq[i]), pnl: num(pnl[i]), stakingRewards: num(sr[i]) })),
  };
}

// ---- account history tabs (/query/accounts/:addr/{cashflows|staking|queue}) --

export interface CashflowItem {
  timestampMs: number;
  txHash: string;
  kind: "Deposit" | "Withdrawal";
  amount: number;
  recipientAmount: number | null;
  route: string | null;
  status: string | null;
}

export interface StakingItem {
  timestampMs: number;
  txHash: string;
  kind: "staked" | "unstaked" | "claimed";
  amount: number; // PAPER for stake/unstake, USDC for claim
}

export interface QueueHistoryItem {
  timestampMs: number;
  txHash: string;
  kind: "enqueued" | "harvested" | "debt_consumed";
  amount: number;
  eventCount: number;
}

async function accountList(wallet: string, kind: string): Promise<any[]> {
  const res = await fetch(`${PT}/query/accounts/${wallet.toLowerCase()}/${kind}?limit=75`);
  if (!res.ok) throw new Error(`${kind} ${res.status}`);
  const j = await res.json();
  return j.items ?? [];
}

export async function fetchCashflows(wallet: string): Promise<CashflowItem[]> {
  return (await accountList(wallet, "cashflows")).map((it) => ({
    timestampMs: Number(it.timestampMs),
    txHash: String(it.txHash),
    kind: it.kind,
    amount: Number(it.amountRaw) / C,
    recipientAmount: it.recipientAmountRaw != null ? Number(it.recipientAmountRaw) / C : null,
    route: it.route ?? null,
    status: it.withdrawalStatus ?? null,
  }));
}

export async function fetchStakingHistory(wallet: string): Promise<StakingItem[]> {
  return (await accountList(wallet, "staking")).map((it) => ({
    timestampMs: Number(it.timestampMs),
    txHash: String(it.txHash),
    kind: it.kind,
    amount: Number(it.amountRaw) / C,
  }));
}

export async function fetchQueueHistory(wallet: string): Promise<QueueHistoryItem[]> {
  return (await accountList(wallet, "queue")).map((it) => ({
    timestampMs: Number(it.timestampMs),
    txHash: String(it.txHash),
    kind: it.kind,
    amount: Number(it.amountRaw) / C,
    eventCount: Number(it.eventCount ?? 1),
  }));
}

export interface QueueBalances {
  accountTotal: number;
  accountCount: number;
  protocolTotal: number;
  protocolCount: number;
  items: { amount: number; rank: number | null; raw: any }[];
}

export async function fetchQueueBalances(wallet: string): Promise<QueueBalances> {
  const res = await fetch(`${PT}/query/accounts/${wallet.toLowerCase()}/queue-balances?limit=75`);
  if (!res.ok) throw new Error(`queue-balances ${res.status}`);
  const j = await res.json();
  return {
    accountTotal: Number(j.account?.total ?? "0") / C,
    accountCount: Number(j.account?.count ?? 0),
    protocolTotal: Number(j.total ?? "0") / C,
    protocolCount: Number(j.count ?? 0),
    items: (j.items ?? []).map((it: any) => ({
      amount: Number(it.amountRaw ?? it.amount ?? "0") / C,
      rank: it.position != null ? Number(it.position) : it.rank != null ? Number(it.rank) : null,
      raw: it,
    })),
  };
}

/** Trades that minted PAPER (their "PAPER Emissions" tab). */
export interface EmissionItem extends TradeHistoryItem {
  paperMinted: number;
  eligibleLoss: number;
}

export async function fetchEmissions(wallet: string): Promise<EmissionItem[]> {
  const out: EmissionItem[] = [];
  for (const it of await rawTrades(wallet)) {
    const minted = Number(it.paperMintedRaw ?? "0") / C;
    if (!(minted > 0)) continue;
    out.push({
      ...parseTrade(it),
      paperMinted: minted,
      eligibleLoss: Number(it.paperMintBasisRaw ?? "0") / C,
    });
  }
  return out;
}

// ---- relayer error codes → human messages (their own copy) -------------------

const RELAYER_ERROR_CODES = new Set([
  "unauthorized_intent",
  "deadline_expired",
  "rate_limited",
  "invalid_intent",
  "below_minimum_withdrawal",
  // admission_rejected reasons (the relayer's per-intent checks)
  "alreadyQueued",
  "sessionKeyLimit",
  "tradingPaused",
  "marketPaused",
  "inactiveInstrument",
  "belowMinimum",
  "belowMinimumNotional",
  "leverageTooHigh",
  "leverageTooLow",
  "positionTooLarge",
  "openInterest",
  "funding",
  "noOpenPositions",
  "noDeposit",
]);

/**
 * Localised message for a known relayer error; undefined for unknown ones. A 409
 * `admission_rejected` carries the failed check in `reason` — that is what gets explained.
 */
export function relayerError(code: string | undefined | null, reason?: string | null): string | undefined {
  const key = code === "admission_rejected" ? reason : code;
  if (!key || !RELAYER_ERROR_CODES.has(key)) return undefined;
  return tr(`err.${key}` as I18nKey);
}

// ---- formatting --------------------------------------------------------------

export function fmtUsd(v: number, digits = 2): string {
  if (!Number.isFinite(v)) return "—";
  const a = Math.abs(v);
  if (a >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
  if (a >= 1e4) return `$${(v / 1e3).toFixed(1)}K`;
  return `$${v.toLocaleString("en-US", { maximumFractionDigits: digits })}`;
}

export function fmtPrice(v: number): string {
  if (!Number.isFinite(v)) return "—";
  return v.toLocaleString("en-US", {
    minimumFractionDigits: v >= 1000 ? 1 : 2,
    maximumFractionDigits: v >= 1000 ? 1 : 4,
  });
}

export function fmtPaper(v: number): string {
  if (!Number.isFinite(v)) return "—";
  return v.toLocaleString("en-US", { maximumFractionDigits: v >= 1000 ? 2 : 4 });
}

/** "15 Oct 2026 13:51:07" — their activity-table format. */
export function fmtDateTime(ms: number): string {
  const d = new Date(ms);
  const date = d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
  const time = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
  return `${date} ${time}`;
}

export function timeAgo(ms: number): string {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return tr("ago.s", { n: Math.floor(s) });
  if (s < 3600) return tr("ago.m", { n: Math.floor(s / 60) });
  if (s < 86400) return tr("ago.h", { n: Math.floor(s / 3600) });
  return tr("ago.d", { n: Math.floor(s / 86400) });
}
