// The watcher engine (SPEC.md §6). One pass every tick on the leader:
// housekeeping → reconcile → stops → entries → heartbeat.
//
// This is the client engine's state machine (src/triggers.ts, now deleted)
// with its browser concerns removed: localStorage became Postgres rows with
// optimistic versions, cross-tab claim leases became one atomic CAS
// (repo.casFire), the hidden-tab gap handling became "a pass was late".
// The lettered/numbered rule names (R1–R5, M1–M6, N-1/N-2/N5, A, C, D, F,
// H) are kept from the original review so the two can be compared.
//
// Invariants:
//  - fire decisions consume ONLY PriceFeeds samples (live, server-received);
//  - a trigger fires at most once (casFire), on the leader only;
//  - the engine never resizes or re-prices anything the user armed (veto-only);
//  - entries never auto-resubmit; stops re-arm after transient failures;
//  - every status write is optimistic — a user's cancel landing mid-pass wins.

import {
  FIRING_GRACE_MS,
  INTENT_TTL_MS,
  STOP_RETRY_COOLDOWN_MS,
  freshSample,
  isLive,
  nextEntryState,
  nextStopState,
  pastLevel,
  resolveAttachedStop,
  stopHit,
  type PriceSample,
} from "../shared/triggerLogic";
import type { LivePosition, WalletSnapshot } from "../shared/walletFrames";
import { randomUUID } from "node:crypto";
import { log } from "./log";
import type { PriceFeeds } from "./priceFeed";
import type { ProtoState, RelayerClient } from "./relayer";
import type { KeyRow, Repo, TriggerRecord } from "./repo";
import type { ExecuteResult, Signer } from "./signer";
import type { WalletWatch } from "./walletWatch";

export const GAP_MS = 5_000;
const EPSILON = 1e-9;
const MATCH_EPSILON = 0.01;
const PROTO_CACHE_MS = 5_000;
/** an active key must be this old before "missing from the on-chain list" counts as revoked */
const KEY_MISSING_GRACE_MS = 120_000;
/** a wallet stream frame older than this means we don't trust its sessionKeys for revocation decisions */
const STREAM_FRESH_MS = 60_000;
/** a trigger armed this recently is not a restart survivor — it evaluates normally without quarantine */
const FRESH_ARM_MS = 15_000;

export interface EngineDeps {
  repo: Repo;
  feeds: PriceFeeds;
  wallets: WalletWatch;
  signer: Signer;
  relayer: RelayerClient;
  instruments: ReadonlySet<number>;
  envKill: () => boolean;
  now?: () => number;
  holder: string;
  isLeader: () => boolean;
}

type Entry = TriggerRecord & { kind: "entry" };
type Stop = TriggerRecord & { kind: "stop" };

interface WalletCtx {
  wallet: string;
  snap: WalletSnapshot | null;
  samples: Record<number, PriceSample | undefined>;
  now: number;
  enabled: boolean;
  keyOk: boolean;
  key: KeyRow | null;
  proto: ProtoState | null;
}

const BLOCK_CODES: ReadonlySet<string> = new Set(["session", "key-revoked", "key-expired", "trading-paused"]);

function keyBlockCode(key: KeyRow | null, nowMs: number): string {
  if (!key) return "session";
  if (key.status === "revoked") return "key-revoked";
  if (key.status === "expired" || key.expiryS <= Math.floor(nowMs / 1000) + 5) return "key-expired";
  return "session";
}

export class Engine {
  private now: () => number;
  /** ids this engine instance has evaluated at least once; unknown ids re-baseline (M5 restart quarantine) */
  private known = new Set<string>();
  private quarantine = new Set<string>();
  /** fires this process initiated and hasn't settled yet (the 60 s unknown rule skips them) */
  private ownedFiring = new Set<string>();
  private prevSamples = new Map<number, PriceSample>();
  private lastPassAt = 0;
  lastGapAt: number | null = null;
  private proto: { state: ProtoState | null; at: number } = { state: null, at: 0 };
  /** pending/active keys by wallet, refreshed every pass */
  private keys = new Map<string, KeyRow>();

  constructor(private d: EngineDeps) {
    this.now = d.now ?? Date.now;
  }

  // ---------------------------------------------------------------------------
  async pass(): Promise<void> {
    const now = this.now();
    const killed = this.d.envKill() || (await this.d.repo.getKill())?.on === true;

    const rows = await this.d.repo.listActiveTriggers();
    await this.refreshKeys();

    // which feeds / streams this pass needs
    const liveInstruments = new Set<number>();
    const wallets = new Set<string>();
    for (const r of rows) {
      wallets.add(r.wallet);
      if (isLive(r.status)) liveInstruments.add(r.instrumentId);
    }
    for (const k of this.keys.values()) wallets.add(k.wallet);
    this.d.feeds.ensure(liveInstruments);
    this.d.wallets.ensure(wallets);

    await this.processKeyRequests();
    await this.trackKeyActivation();

    if (killed) {
      // nothing evaluates, nothing signs — but a kill must not look like a
      // long gap when it lifts, so keep the clock moving
      this.lastPassAt = now;
      return;
    }

    // gap handling (H): a late pass means the previous-sample baseline is stale
    const gapMs = this.lastPassAt > 0 ? now - this.lastPassAt : 0;
    this.lastPassAt = now;
    const samples = this.d.feeds.samples();
    if (gapMs > GAP_MS) {
      this.lastGapAt = now;
      log.warn(`pass gap ${gapMs} ms — re-baselining`);
      await this.handleGap(rows, samples);
    }

    const byWallet = new Map<string, TriggerRecord[]>();
    for (const r of rows) {
      const list = byWallet.get(r.wallet) ?? [];
      list.push(r);
      byWallet.set(r.wallet, list);
    }

    const protoNow = await this.protoState(false);
    for (const [wallet, items] of byWallet) {
      const snap = this.d.wallets.get(wallet)?.snapshot ?? null;
      const settings = await this.d.repo.getWalletSettings(wallet);
      const key = this.keys.get(wallet) ?? null;
      const keyOk = !!key && key.status === "active" && key.expiryS > Math.floor(now / 1000) + 5;
      const ctx: WalletCtx = { wallet, snap, samples, now, enabled: settings.enabled, keyOk, key, proto: protoNow };

      await this.reconcile(items, ctx);

      // reservation base (D): margin of entries in flight that the snapshot can't see yet
      const visibleIntents = new Set((snap?.operations ?? []).map((o) => o.intentId));
      let reserved = 0;
      for (const r of items) {
        if (r.kind !== "entry") continue;
        if (r.status === "firing" || r.status === "unknown") reserved += r.marginUsdc;
        else if (r.status === "queued" && (r.intentId == null || !visibleIntents.has(r.intentId))) reserved += r.marginUsdc;
      }

      // stops first (C)
      for (const r of items) if (r.kind === "stop") await this.evaluateStop(r, ctx);
      // then entries, oldest first (D)
      const entries = items.filter((r): r is Entry => r.kind === "entry").sort((a, b) => a.createdAt - b.createdAt);
      for (const e of entries) reserved += await this.evaluateEntry(e, ctx, reserved);

      // user-requested cancels of queued intents (one attempt each)
      for (const r of items) if (r.status === "queued" && r.cancelRequested && !r.cancelSentAt && r.intentId) await this.sendCancel(r, ctx);
    }

    for (const r of rows) this.known.add(r.id);
    for (const [k, s] of Object.entries(samples)) if (s && s.live && Number.isFinite(s.price)) this.prevSamples.set(Number(k), s);
  }

  // ---------------------------------------------------------------------------
  // keys
  private async refreshKeys() {
    const list = await this.d.repo.listKeys(["pending", "active"]);
    this.keys = new Map(list.map((k) => [k.wallet, k]));
  }

  /** web → watcher key generation handshake (leader only; SPEC §3) */
  private async processKeyRequests() {
    if (!this.d.isLeader()) return;
    const pending = await this.d.repo.listPendingKeyRequests();
    for (const req of pending) {
      try {
        const existing = await this.d.repo.getKey(req.wallet);
        if (existing && (existing.status === "pending" || existing.status === "active")) {
          // one server key per wallet — hand back the one that exists
          await this.d.repo.finishKeyRequest(req.id, { keyAddress: existing.keyAddress });
          continue;
        }
        const expiryS = Math.floor(this.now() / 1000) + this.keyTtlDays * 86400;
        const row = this.d.signer.vault.generate(req.wallet, expiryS, this.now());
        await this.d.repo.putKey(row);
        await this.d.repo.finishKeyRequest(req.id, { keyAddress: row.keyAddress });
        await this.d.repo.audit({ at: this.now(), wallet: req.wallet, triggerId: null, event: "key.generated", detail: { keyAddress: row.keyAddress, expiryS } });
        this.keys.set(row.wallet, row);
      } catch (e) {
        await this.d.repo.finishKeyRequest(req.id, { error: e instanceof Error ? e.message : String(e) });
      }
    }
  }

  /** requested key lifetime in days (1–30); set by main from env */
  keyTtlDays = 30;

  /** pending → active when the key shows up on-chain; active → revoked when it disappears, → expired on expiry */
  private async trackKeyActivation() {
    const now = this.now();
    for (const key of [...this.keys.values()]) {
      if (key.status === "active" && key.expiryS <= Math.floor(now / 1000)) {
        await this.d.repo.setKeyStatus(key.wallet, "expired", now);
        await this.d.repo.audit({ at: now, wallet: key.wallet, triggerId: null, event: "key.expired", detail: {} });
        this.keys.delete(key.wallet);
        continue;
      }
      const st = this.d.wallets.get(key.wallet);
      const snap = st?.snapshot;
      if (!st || !snap || now - st.lastFrameAt > STREAM_FRESH_MS) continue;
      const onChain = snap.sessionKeys.includes(key.keyAddress);
      if (key.status === "pending" && onChain) {
        await this.d.repo.setKeyStatus(key.wallet, "active", now);
        await this.d.repo.audit({ at: now, wallet: key.wallet, triggerId: null, event: "key.active", detail: { keyAddress: key.keyAddress } });
        key.status = "active";
        key.registeredAt = now;
      } else if (key.status === "active" && !onChain && now - (key.registeredAt ?? key.createdAt) > KEY_MISSING_GRACE_MS) {
        await this.d.repo.revokeKey(key.wallet, "onchain-missing", now);
        await this.d.repo.audit({ at: now, wallet: key.wallet, triggerId: null, event: "key.revoked", detail: { reason: "onchain-missing", keyAddress: key.keyAddress } });
        log.warn(`key for ${key.wallet.slice(0, 10)}… vanished from the on-chain list — revoked server-side, triggers cancelled`);
        this.keys.delete(key.wallet);
      }
    }
  }

  private async protoState(fresh: boolean): Promise<ProtoState | null> {
    const now = this.now();
    if (!fresh && this.proto.state && now - this.proto.at < PROTO_CACHE_MS) return this.proto.state;
    const s = await this.d.relayer.fetchProtoState();
    if (s) this.proto = { state: s, at: now };
    return fresh ? s : (s ?? this.proto.state);
  }

  // ---------------------------------------------------------------------------
  private async save(r: TriggerRecord): Promise<boolean> {
    const ok = await this.d.repo.updateTrigger(r);
    if (!ok) log.info(`stale write dropped for ${r.id} (${r.status}) — someone else moved it`);
    return ok;
  }

  private async handleGap(rows: TriggerRecord[], samples: Record<number, PriceSample | undefined>) {
    for (const r of rows) {
      if (r.status !== "armed" && r.status !== "confirming") continue;
      const sample = samples[r.instrumentId];
      const before = r.status;
      r.confirmingSince = null;
      r.crossSampleTs = null;
      r.status = "armed";
      // price already past the level after a gap: no phantom cross — a human re-arms it (M5 posture)
      if (r.kind === "entry" && sample && sample.live && pastLevel(sample.price, r.triggerPrice, r.cross)) r.status = "attention";
      if (r.status !== before) await this.save(r);
    }
  }

  /**
   * M5 restart quarantine: an item this engine instance hasn't seen before
   * (new leader, restart) or one explicitly re-armed waits for its first
   * fresh sample; already past the level → attention. Returns true while it
   * owns the item. The baseline sample itself never fires anything.
   */
  private async quarantineCheck(r: TriggerRecord, ctx: WalletCtx, isPast: (s: PriceSample) => boolean): Promise<boolean> {
    const unseen = !this.known.has(r.id) && !this.quarantine.has(r.id);
    if (unseen && !r.rebaseline && ctx.now - r.createdAt < FRESH_ARM_MS) return false; // freshly armed: normal path
    if (!unseen && !this.quarantine.has(r.id) && !r.rebaseline) return false;
    this.quarantine.add(r.id);
    const sample = ctx.samples[r.instrumentId];
    if (!freshSample(sample, ctx.now)) return true; // wait for a fresh sample
    this.quarantine.delete(r.id);
    if (r.rebaseline) {
      // explicit re-arm from attention: the baseline sample counts as the cross (client parity)
      r.rebaseline = false;
      if (isPast(sample)) {
        r.status = "confirming";
        r.confirmingSince = ctx.now;
        r.crossSampleTs = sample.ts;
      }
      await this.save(r);
      return true;
    }
    if (isPast(sample) && (r.status === "armed" || r.status === "confirming")) {
      r.status = "attention";
      r.confirmingSince = null;
      r.crossSampleTs = null;
      await this.save(r);
    }
    return true;
  }

  // -- stops ---------------------------------------------------------------------
  private async evaluateStop(stop: Stop, ctx: WalletCtx): Promise<void> {
    if (stop.status !== "armed" && stop.status !== "confirming") return;
    const snap = ctx.snap;

    // position-gone bookkeeping (F): two consecutive absent evaluations
    if (snap) {
      const present = snap.openPositions.some((p) => p.positionId === stop.positionId);
      if (!present) {
        stop.absentEvals = (stop.absentEvals ?? 0) + 1;
        if (stop.absentEvals >= 2) stop.status = "done";
        await this.save(stop);
        return;
      }
      if (stop.absentEvals) {
        stop.absentEvals = 0;
        await this.save(stop);
      }
    }

    if (await this.quarantineCheck(stop, ctx, (s) => stopHit(s.price, stop))) return;
    if (!ctx.enabled) return;

    // R4: a close for this position is already queued — stand down and let it land
    if (snap?.operations.some((o) => o.action === "closePositions" && (o.closeIds ?? []).includes(stop.positionId))) return;

    // R3 pre-checks that would only re-arm: hold at armed with the reason on the
    // row (the UI shows UNPROTECTED) instead of cycling armed ↔ confirming every
    // pass. Cleared when the block lifts.
    const block = !ctx.keyOk ? keyBlockCode(ctx.key, ctx.now) : ctx.proto?.tradingPaused ? "trading-paused" : null;
    if (block) {
      if (stop.status !== "armed" || stop.lastError !== block) {
        stop.status = "armed";
        stop.confirmingSince = null;
        stop.crossSampleTs = null;
        stop.lastError = block;
        await this.save(stop);
      }
      return;
    }
    if (stop.lastError && BLOCK_CODES.has(stop.lastError)) {
      stop.lastError = undefined;
      await this.save(stop);
    }

    const sample = ctx.samples[stop.instrumentId];
    if (!freshSample(sample, ctx.now)) return; // stale price: the stop waits for a fresh print (B)
    const step = nextStopState(stop, sample, ctx.now);
    if (step.fire) return this.initiateStopFire(stop, ctx);
    if (step.status !== stop.status || step.crossSampleTs !== (stop.crossSampleTs ?? null)) {
      stop.status = step.status;
      stop.confirmingSince = step.confirmingSince;
      stop.crossSampleTs = step.crossSampleTs;
      await this.save(stop);
    }
  }

  private async initiateStopFire(stop: Stop, ctx: WalletCtx): Promise<void> {
    if (ctx.now - (stop.lastAttemptAt ?? 0) < STOP_RETRY_COOLDOWN_MS && stop.lastError) {
      // transient-failure cooldown: stay armed, don't touch lastAttemptAt
      stop.status = "armed";
      stop.confirmingSince = null;
      stop.crossSampleTs = null;
      await this.save(stop);
      return;
    }
    const fired = await this.d.repo.casFire(stop.id, ctx.now, null);
    if (!fired || fired.kind !== "stop") return; // lost the race (cancel / other leader) — nothing signed
    this.ownedFiring.add(stop.id);
    void this.submitStop(fired);
  }

  private async submitStop(stop: Stop): Promise<void> {
    try {
      const r = await this.d.signer.close(stop);
      await this.settle(
        stop.wallet,
        stop.id,
        (cur) => {
          const s = cur as Stop;
          if (r.ok) {
            s.status = "queued";
            s.intentId = r.intentId;
            s.lastError = undefined;
          } else if (r.gate === "key-revoked" || r.code === "unauthorized_intent") {
            s.status = "failed";
            s.error = r.code ?? "unauthorized";
          } else {
            // N-1: anything else is not proof the close can never land — re-arm and keep protecting
            s.status = "armed";
            s.lastError = r.code ?? "rejected";
            s.lastAttemptAt = this.now();
          }
        },
        r
      );
    } finally {
      this.ownedFiring.delete(stop.id);
    }
  }

  // -- entries -------------------------------------------------------------------
  /** Returns the margin reserved by a fire initiated in this pass (0 = none). */
  private async evaluateEntry(entry: Entry, ctx: WalletCtx, reserved: number): Promise<number> {
    if (entry.status !== "armed" && entry.status !== "confirming") return 0;
    const now = ctx.now;

    if (await this.quarantineCheck(entry, ctx, (s) => pastLevel(s.price, entry.triggerPrice, entry.cross))) return 0;
    if (!ctx.enabled) {
      // expiry is housekeeping and still applies while the wallet's triggers are paused
      if (entry.expiresAt != null && now >= entry.expiresAt) {
        entry.status = "expired";
        await this.save(entry);
      }
      return 0;
    }

    const sample = ctx.samples[entry.instrumentId];
    const usable = freshSample(sample, now) ? sample : undefined;
    const step = nextEntryState(entry, this.prevSamples.get(entry.instrumentId), usable, now);
    if (step.expired) {
      entry.status = "expired";
      entry.confirmingSince = null;
      entry.crossSampleTs = null;
      await this.save(entry);
      return 0;
    }
    if (step.fire) return this.initiateEntryFire(entry, ctx, reserved);
    if (step.status !== entry.status || step.crossSampleTs !== (entry.crossSampleTs ?? null)) {
      entry.status = step.status;
      entry.confirmingSince = step.confirmingSince;
      entry.crossSampleTs = step.crossSampleTs;
      await this.save(entry);
    }
    return 0;
  }

  private async initiateEntryFire(entry: Entry, ctx: WalletCtx, reserved: number): Promise<number> {
    const fail = async (code: string) => {
      entry.status = "failed";
      entry.error = code;
      entry.firedAt = ctx.now;
      await this.save(entry);
      return 0;
    };
    // fire-time revalidation — veto only; the armed fields are never altered
    if (!ctx.keyOk) return fail(keyBlockCode(ctx.key, ctx.now));
    if (!ctx.proto) return fail("no-proto");
    if (ctx.proto.tradingPaused) return fail("trading-paused");
    if (!ctx.snap) return fail("no-snapshot");
    const available = ctx.snap.available - reserved;
    if (entry.marginUsdc > available + EPSILON) return fail("insufficient-available");
    if (entry.marginUsdc < ctx.proto.minTrade) return fail("below-min-trade");
    if (entry.marginUsdc * entry.leverage < ctx.proto.minNotional) return fail("below-min-notional");

    const pre = ctx.snap.openPositions.filter((p) => p.instrumentId === entry.instrumentId).map((p) => p.positionId);
    const fired = await this.d.repo.casFire(entry.id, ctx.now, pre);
    if (!fired || fired.kind !== "entry") return 0; // lost the race — nothing signed
    this.ownedFiring.add(entry.id);
    void this.submitEntry(fired);
    return entry.marginUsdc;
  }

  private async submitEntry(entry: Entry): Promise<void> {
    try {
      // M4: fresh protocol state fetched NOW — the pass's cached copy is not trusted here
      const fresh = await this.protoState(true);
      let veto: string | null = null;
      if (!fresh) veto = "no-proto";
      else if (fresh.tradingPaused) veto = "trading-paused";
      else {
        const inst = fresh.instruments.find((i) => i.id === entry.instrumentId);
        if (!inst || inst.paused || !inst.active) veto = "market-unavailable";
        else if (entry.leverage > inst.maxLeverage) veto = "lev-too-high";
        else if (entry.marginUsdc < fresh.minTrade) veto = "below-min-trade";
        else if (entry.marginUsdc * entry.leverage < fresh.minNotional) veto = "below-min-notional";
      }
      if (veto) {
        const code = veto;
        await this.settle(entry.wallet, entry.id, (cur) => {
          cur.status = "failed";
          cur.error = code;
        });
        return;
      }
      const r = await this.d.signer.open(entry);
      await this.settle(
        entry.wallet,
        entry.id,
        (cur) => {
          if (r.ok) {
            cur.status = "queued";
            cur.intentId = r.intentId;
          } else if (r.transient) {
            // N5: the intent may or may not have been accepted — unknown, never resent
            cur.status = "unknown";
            cur.error = r.code ?? "network";
          } else if (r.gate === "kill" || r.gate === "lease") {
            // our own gate refused before anything was signed: back to armed, nothing happened
            cur.status = "armed";
            cur.error = undefined;
          } else {
            cur.status = "failed";
            cur.error = r.code ?? "rejected";
          }
        },
        r
      );
    } finally {
      this.ownedFiring.delete(entry.id);
    }
  }

  private async sendCancel(r: TriggerRecord, ctx: WalletCtx) {
    const res = await this.d.signer.cancel(ctx.wallet, r.id, r.intentId!);
    r.cancelSentAt = ctx.now;
    if (!res.ok) r.lastCancelError = res.code ?? "rejected";
    await this.save(r);
  }

  /**
   * Apply a settle mutation to the CURRENT row. If the row is no longer
   * `firing` (a revoke cancelled it mid-flight) the status write is dropped,
   * but an accepted intent id is still recorded so the UI can point at it.
   */
  private async settle(wallet: string, id: string, apply: (cur: TriggerRecord) => void, r?: ExecuteResult): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const cur = await this.d.repo.getTrigger(wallet, id);
      if (!cur) return;
      if (cur.status !== "firing") {
        if (r?.ok && r.intentId && !cur.intentId) {
          cur.intentId = r.intentId;
          if (await this.d.repo.updateTrigger(cur)) return;
          continue;
        }
        return;
      }
      apply(cur);
      if (await this.d.repo.updateTrigger(cur)) return;
      // version moved under us — reload and retry
    }
    log.warn(`settle for ${id} gave up after 3 version conflicts`);
  }

  // -- reconciliation (R2/G/M6) ------------------------------------------------------
  private async reconcile(items: TriggerRecord[], ctx: WalletCtx): Promise<void> {
    const ops = ctx.snap?.operations ?? [];
    for (const r of items) {
      if (r.kind === "entry") await this.reconcileEntry(r, ops, ctx.snap, ctx.now);
      else await this.reconcileStop(r, ops, ctx.snap, ctx.now);
    }
  }

  private matchOpen(entry: Entry, ops: WalletSnapshot["operations"]) {
    return ops.find(
      (o) =>
        o.action === "openPosition" &&
        o.instrumentId === entry.instrumentId &&
        o.isLong === entry.isLong &&
        o.amount != null &&
        Math.abs(o.amount - entry.marginUsdc) < MATCH_EPSILON &&
        o.timeMs >= (entry.firedAt ?? entry.createdAt) - 5000
    );
  }

  private async reconcileEntry(entry: Entry, ops: WalletSnapshot["operations"], snap: WalletSnapshot | null, now: number) {
    if (entry.status === "firing") {
      const match = this.matchOpen(entry, ops);
      if (match) {
        entry.status = "queued";
        entry.intentId = match.intentId;
        entry.error = undefined;
        await this.save(entry);
        return;
      }
      // our own in-flight submission settles via its promise; anyone else's
      // (a previous leader's) with no result after the grace is unknown
      if (!this.ownedFiring.has(entry.id) && now - (entry.firedAt ?? entry.createdAt) > FIRING_GRACE_MS) {
        entry.status = "unknown";
        entry.error = entry.error ?? "interrupted";
        await this.save(entry);
      }
      return;
    }
    if (entry.status === "unknown") {
      const match = this.matchOpen(entry, ops);
      if (match) {
        entry.status = "queued";
        entry.intentId = match.intentId;
        entry.error = undefined;
        await this.save(entry);
      }
      return; // unmatched unknown stays unknown — loudly, never resent
    }
    if (entry.status === "queued" && snap) {
      const inOps = entry.intentId != null && ops.some((o) => o.intentId === entry.intentId);
      if (inOps) {
        let dirty = false;
        if (entry.absentEvals) {
          entry.absentEvals = 0;
          dirty = true;
        }
        if (now > (entry.firedAt ?? entry.createdAt) + INTENT_TTL_MS) {
          entry.status = "expired";
          dirty = true;
        }
        if (dirty) await this.save(entry);
        return;
      }
      if (entry.cancelRequested) {
        entry.status = "cancelled";
        await this.save(entry);
        return;
      }
      // exact match on the position's own openPosition intent id first; the
      // before/after comparison only over positions of unknown provenance
      const pre = new Set(entry.prePositionIds ?? []);
      const byIntent = entry.intentId != null ? snap.openPositions.find((p) => p.intentId === entry.intentId) : undefined;
      const effect =
        byIntent ?? snap.openPositions.find((p) => p.instrumentId === entry.instrumentId && !pre.has(p.positionId) && p.intentId == null);
      if (effect) {
        entry.status = "executed";
        entry.executedPrice = effect.entryPrice;
        await this.executeWithAttachedStop(entry, effect, now);
      } else {
        // N-2 reconcile grace: two consecutive no-effect observations
        entry.absentEvals = (entry.absentEvals ?? 0) + 1;
        if (entry.absentEvals >= 2) entry.status = "unreconciled";
        await this.save(entry);
      }
    }
  }

  /**
   * Entry → executed, plus the stop it asked for, in one write. The stop is an
   * ordinary stop row from here on (its own confirm, retry, cancel); `fromEntryId`
   * only links it back for display. A level the real bust price makes unreachable
   * is clamped just inside bust and flagged — the user asked for protection, so
   * they get the closest thing to it rather than nothing. A level the market
   * already gapped through is left alone: a fresh stop that is hit on its first
   * samples fires, which is what a stop means.
   */
  private async executeWithAttachedStop(entry: Entry, position: LivePosition, now: number) {
    const a = entry.attachedStop;
    if (!a || entry.spawnedStopId) {
      await this.save(entry);
      return;
    }
    const resolved = resolveAttachedStop(a, { isLong: position.isLong, entryPrice: position.entryPrice, bustPrice: position.bustPrice });
    if (!resolved) {
      log.warn(`attached stop for ${entry.id} could not be resolved (entry ${position.entryPrice}, bust ${position.bustPrice}) — not created`);
      await this.save(entry);
      return;
    }
    const stop: Stop = {
      kind: "stop",
      version: 1,
      id: randomUUID(),
      wallet: entry.wallet,
      positionId: position.positionId,
      instrumentId: entry.instrumentId,
      isLong: entry.isLong,
      stopPrice: resolved.stopPrice,
      status: "armed",
      createdAt: now,
      confirmingSince: null,
      crossSampleTs: null,
      absentEvals: 0,
      fromEntryId: entry.id,
    };
    entry.spawnedStopId = stop.id;
    if (resolved.clamped) entry.spawnNote = "clamped";
    const ok = await this.d.repo.updateTriggerAndSpawn(entry, stop);
    if (!ok) {
      log.info(`stale write dropped for ${entry.id} (executed + spawn) — someone else moved it`);
      return;
    }
    await this.d.repo.audit({
      at: now,
      wallet: entry.wallet,
      triggerId: stop.id,
      event: "spawn.stop",
      detail: { fromEntryId: entry.id, positionId: position.positionId, stopPrice: resolved.stopPrice, clamped: resolved.clamped, mode: a.mode, value: a.value },
    });
    log.info(`entry ${entry.id} filled @ ${position.entryPrice} → stop ${stop.id} armed @ ${resolved.stopPrice}${resolved.clamped ? " (clamped to bust)" : ""}`);
  }

  private matchClose(stop: Stop, ops: WalletSnapshot["operations"]) {
    return ops.find(
      (o) => o.action === "closePositions" && (o.closeIds ?? []).includes(stop.positionId) && o.timeMs >= (stop.firedAt ?? stop.createdAt) - 5000
    );
  }

  private async reconcileStop(stop: Stop, ops: WalletSnapshot["operations"], snap: WalletSnapshot | null, now: number) {
    if (stop.status === "firing") {
      const match = this.matchClose(stop, ops);
      if (match) {
        stop.status = "queued";
        stop.intentId = match.intentId;
        await this.save(stop);
        return;
      }
      if (!this.ownedFiring.has(stop.id) && now - (stop.firedAt ?? stop.createdAt) > FIRING_GRACE_MS) {
        stop.status = "unknown";
        stop.lastError = "interrupted";
        await this.save(stop);
      }
      return;
    }
    if (stop.status === "unknown") {
      const match = this.matchClose(stop, ops);
      if (match) {
        stop.status = "queued";
        stop.intentId = match.intentId;
        await this.save(stop);
      }
      return;
    }
    if (stop.status === "queued" && snap) {
      const present = snap.openPositions.some((p) => p.positionId === stop.positionId);
      const before = { a: stop.absentEvals ?? 0, m: stop.missedEvals ?? 0, s: stop.status };
      stop.absentEvals = present ? 0 : (stop.absentEvals ?? 0) + 1;
      const inOps = stop.intentId != null && ops.some((o) => o.intentId === stop.intentId);
      if (inOps) {
        stop.missedEvals = 0;
        if (now > (stop.firedAt ?? stop.createdAt) + INTENT_TTL_MS) stop.status = "expired";
      } else if (!present && (stop.absentEvals ?? 0) >= 2) {
        stop.status = "executed";
      } else if (!present) {
        stop.missedEvals = 0; // position gone: the no-effect streak is broken
      } else if (stop.cancelRequested) {
        stop.status = "cancelled";
      } else {
        // N-2: the intent left operations while the position is still open
        stop.missedEvals = (stop.missedEvals ?? 0) + 1;
        if (stop.missedEvals >= 2) stop.status = "unreconciled";
      }
      if (before.a !== (stop.absentEvals ?? 0) || before.m !== (stop.missedEvals ?? 0) || before.s !== stop.status) await this.save(stop);
    }
  }
}
