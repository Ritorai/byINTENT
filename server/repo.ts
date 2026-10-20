// Persistence contract for the watcher + trigger API, and an in-memory
// implementation with identical semantics (used by the test harness and by
// local development without Postgres). server/repoPg.ts is the real one.
//
// Concurrency rules both implementations honour:
//  - every trigger row carries `version`; `updateTrigger` is optimistic
//    (write only if the version is unchanged) so an engine pass can never
//    overwrite a user's cancel that landed mid-pass;
//  - `casFire` is the single-fire gate: armed/confirming → firing exactly once;
//  - `revokeKey` is atomic across key + triggers.

import type { AttachedStop, ExitKind, StopLoss, TriggerEntry, TriggerStatus } from "../shared/triggerLogic";
import { exitOf, isLive, isTerminal } from "../shared/triggerLogic";

export type TriggerRecord =
  | ({ kind: "entry"; version: number } & TriggerEntry)
  | ({ kind: "stop"; version: number } & StopLoss);

export type KeyStatus = "pending" | "active" | "revoked" | "expired";

export interface KeyRow {
  wallet: string; // lowercase
  keyAddress: string; // lowercase
  /** AES-GCM blob; null once revoked */
  keyCipher: Buffer | null;
  kekId: string;
  expiryS: number;
  status: KeyStatus;
  createdAt: number;
  registeredAt: number | null;
  revokedAt: number | null;
  revokeReason: string | null;
  lastUsedAt: number | null;
}

export interface KeyRequest {
  id: string;
  wallet: string;
  status: "pending" | "done" | "failed";
  keyAddress: string | null;
  error: string | null;
  createdAt: number;
}

export interface KillState {
  on: boolean;
  reason: string;
  at: number;
}

export interface Heartbeat {
  holder: string;
  at: number;
  /** instrumentId → sample age ms at heartbeat time */
  feeds: Record<string, number>;
  leader: boolean;
}

export interface AuditEvent {
  at: number;
  wallet: string | null;
  triggerId: string | null;
  event: string; // key.generated | key.active | key.revoked | kill.on | kill.off | sign | breaker | …
  detail: Record<string, unknown>;
}

export interface WalletSettings {
  enabled: boolean;
}

export interface Repo {
  // ---- triggers
  /** all non-terminal triggers across wallets (engine) */
  listActiveTriggers(): Promise<TriggerRecord[]>;
  /** a wallet's triggers for display: all live/pending + the most recent terminal ones */
  listTriggersForWallet(wallet: string, terminalLimit?: number): Promise<TriggerRecord[]>;
  getTrigger(wallet: string, id: string): Promise<TriggerRecord | null>;
  insertTrigger(rec: TriggerRecord): Promise<void>;
  /** optimistic write; false = version moved (caller reloads next pass) */
  updateTrigger(rec: TriggerRecord): Promise<boolean>;
  /** atomic: optimistic update of `rec` + insert of `spawn` (the stop an executed entry asked for); false = stale, nothing written */
  updateTriggerAndSpawn(rec: TriggerRecord, spawns: TriggerRecord[]): Promise<boolean>;
  /** set / clear the stop or take-profit an armed entry will spawn on fill (entry must still be waiting) */
  setAttachedStop(wallet: string, id: string, stop: AttachedStop | null, which?: ExitKind): Promise<TriggerRecord | null>;
  /** armed/confirming → firing, exactly once. Returns the firing row or null. */
  casFire(id: string, firedAt: number, prePositionIds: string[] | null): Promise<TriggerRecord | null>;
  /** user mutations (wallet-scoped) — return the updated row or null when not applicable */
  cancelTrigger(wallet: string, id: string): Promise<TriggerRecord | null>;
  rearmTrigger(wallet: string, id: string): Promise<TriggerRecord | null>;
  requestCancelQueued(wallet: string, id: string): Promise<TriggerRecord | null>;
  /** armed/confirming stops on this position → cancelled (one live stop per position) */
  supersedeLiveStops(wallet: string, positionId: string, exit?: ExitKind): Promise<number>;
  countLiveTriggers(wallet: string): Promise<number>;
  /** cancel every live/attention trigger of a wallet (revoke path) */
  cancelAllLive(wallet: string, reason: string): Promise<number>;

  // ---- per-wallet settings
  getWalletSettings(wallet: string): Promise<WalletSettings>;
  setWalletEnabled(wallet: string, enabled: boolean): Promise<void>;

  // ---- keys
  getKey(wallet: string): Promise<KeyRow | null>;
  listKeys(statuses?: KeyStatus[]): Promise<KeyRow[]>;
  /** insert or replace the wallet's key row (a wallet has at most one server key) */
  putKey(row: KeyRow): Promise<void>;
  setKeyStatus(wallet: string, status: KeyStatus, at: number): Promise<void>;
  touchKey(wallet: string, at: number): Promise<void>;
  /** atomic: status=revoked, cipher wiped, live triggers cancelled */
  revokeKey(wallet: string, reason: string, at: number): Promise<KeyRow | null>;
  // key generation handshake (web → watcher)
  createKeyRequest(wallet: string): Promise<KeyRequest>;
  getKeyRequest(id: string): Promise<KeyRequest | null>;
  listPendingKeyRequests(): Promise<KeyRequest[]>;
  finishKeyRequest(id: string, result: { keyAddress: string } | { error: string }): Promise<void>;

  // ---- nonces
  nextNonce(wallet: string, nowMs: number): Promise<bigint>;

  // ---- global kill
  getKill(): Promise<KillState | null>;
  setKill(state: KillState): Promise<void>;

  // ---- leader lease + heartbeat
  acquireLease(name: string, holder: string, ttlMs: number, nowMs: number): Promise<boolean>;
  releaseLease(name: string, holder: string): Promise<void>;
  putHeartbeat(hb: Heartbeat): Promise<void>;
  getHeartbeat(): Promise<Heartbeat | null>;

  // ---- audit + breaker counters
  audit(ev: AuditEvent): Promise<void>;
  listAudit(limit: number): Promise<AuditEvent[]>;
  countSignatures(wallet: string | null, sinceMs: number): Promise<number>;
  countEvents(wallet: string, event: string, sinceMs: number): Promise<number>;

  // ---- auth nonces (single use)
  putAuthNonce(nonce: string, payload: string, expiresAt: number): Promise<void>;
  /** the stored payload exactly once, while unexpired; null otherwise. The nonce is spent either way. */
  consumeAuthNonce(nonce: string, nowMs: number): Promise<string | null>;

  /** liveness probe (SELECT 1) */
  ping(): Promise<boolean>;
}

// ---------------------------------------------------------------------------

const clone = <T>(x: T): T => structuredClone(x);

export class MemoryRepo implements Repo {
  triggers = new Map<string, TriggerRecord>();
  keys = new Map<string, KeyRow>();
  keyRequests = new Map<string, KeyRequest>();
  settings = new Map<string, WalletSettings>();
  nonces = new Map<string, bigint>();
  kill: KillState | null = null;
  leases = new Map<string, { holder: string; until: number }>();
  heartbeat: Heartbeat | null = null;
  auditLog: AuditEvent[] = [];
  authNonces = new Map<string, { payload: string; expiresAt: number }>();
  private seq = 0;

  async listActiveTriggers() {
    return [...this.triggers.values()].filter((t) => !isTerminal(t.status)).map(clone);
  }
  async listTriggersForWallet(wallet: string, terminalLimit = 50) {
    const w = wallet.toLowerCase();
    const all = [...this.triggers.values()].filter((t) => t.wallet === w);
    const live = all.filter((t) => !isTerminal(t.status));
    const term = all
      .filter((t) => isTerminal(t.status))
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, terminalLimit);
    return [...live, ...term].map(clone);
  }
  async getTrigger(wallet: string, id: string) {
    const t = this.triggers.get(id);
    return t && t.wallet === wallet.toLowerCase() ? clone(t) : null;
  }
  async insertTrigger(rec: TriggerRecord) {
    if (this.triggers.has(rec.id)) throw new Error("duplicate trigger id");
    this.triggers.set(rec.id, clone({ ...rec, version: 1 }));
  }
  async updateTrigger(rec: TriggerRecord) {
    const cur = this.triggers.get(rec.id);
    if (!cur || cur.version !== rec.version) return false;
    this.triggers.set(rec.id, clone({ ...rec, version: rec.version + 1 }));
    rec.version += 1;
    return true;
  }
  async updateTriggerAndSpawn(rec: TriggerRecord, spawns: TriggerRecord[]) {
    const cur = this.triggers.get(rec.id);
    if (!cur || cur.version !== rec.version) return false;
    for (const spawn of spawns) if (this.triggers.has(spawn.id)) throw new Error("duplicate trigger id");
    this.triggers.set(rec.id, clone({ ...rec, version: rec.version + 1 }));
    rec.version += 1;
    for (const spawn of spawns) this.triggers.set(spawn.id, clone({ ...spawn, version: 1 }));
    return true;
  }
  async setAttachedStop(wallet: string, id: string, stop: AttachedStop | null, which: ExitKind = "stop") {
    return this.mutate(wallet, id, ["armed", "confirming", "attention"], (t) => {
      if (t.kind !== "entry") return;
      if (which === "tp") t.attachedTp = stop;
      else t.attachedStop = stop;
    });
  }
  async casFire(id: string, firedAt: number, prePositionIds: string[] | null) {
    const cur = this.triggers.get(id);
    if (!cur || (cur.status !== "armed" && cur.status !== "confirming")) return null;
    const next: TriggerRecord = {
      ...cur,
      status: "firing",
      firedAt,
      confirmingSince: null,
      crossSampleTs: null,
      version: cur.version + 1,
    } as TriggerRecord;
    if (next.kind === "entry") next.prePositionIds = prePositionIds ?? [];
    if (next.kind === "stop") next.lastAttemptAt = firedAt;
    this.triggers.set(id, next);
    return clone(next);
  }
  private mutate(wallet: string, id: string, from: TriggerStatus[], apply: (t: TriggerRecord) => void) {
    const cur = this.triggers.get(id);
    if (!cur || cur.wallet !== wallet.toLowerCase() || !from.includes(cur.status)) return null;
    const next = clone(cur);
    apply(next);
    next.version += 1;
    this.triggers.set(id, next);
    return clone(next);
  }
  async cancelTrigger(wallet: string, id: string) {
    return this.mutate(wallet, id, ["armed", "confirming", "attention"], (t) => {
      t.status = "cancelled";
    });
  }
  async rearmTrigger(wallet: string, id: string) {
    return this.mutate(wallet, id, ["attention"], (t) => {
      t.status = "armed";
      t.confirmingSince = null;
      t.crossSampleTs = null;
      t.rebaseline = true;
    });
  }
  async requestCancelQueued(wallet: string, id: string) {
    return this.mutate(wallet, id, ["queued"], (t) => {
      t.cancelRequested = true;
    });
  }
  async supersedeLiveStops(wallet: string, positionId: string, exit: ExitKind = "stop") {
    let n = 0;
    for (const t of this.triggers.values()) {
      if (t.kind === "stop" && t.wallet === wallet.toLowerCase() && t.positionId === positionId && exitOf(t) === exit && (t.status === "armed" || t.status === "confirming")) {
        t.status = "cancelled";
        t.version += 1;
        n++;
      }
    }
    return n;
  }
  async countLiveTriggers(wallet: string) {
    let n = 0;
    for (const t of this.triggers.values()) if (t.wallet === wallet.toLowerCase() && (isLive(t.status) || t.status === "attention")) n++;
    return n;
  }
  async cancelAllLive(wallet: string, reason: string) {
    let n = 0;
    for (const t of this.triggers.values()) {
      if (t.wallet === wallet.toLowerCase() && (isLive(t.status) || t.status === "attention")) {
        t.status = "cancelled";
        t.error = reason;
        t.version += 1;
        n++;
      }
    }
    return n;
  }

  async getWalletSettings(wallet: string) {
    return this.settings.get(wallet.toLowerCase()) ?? { enabled: true };
  }
  async setWalletEnabled(wallet: string, enabled: boolean) {
    this.settings.set(wallet.toLowerCase(), { enabled });
  }

  async getKey(wallet: string) {
    const k = this.keys.get(wallet.toLowerCase());
    return k ? { ...k, keyCipher: k.keyCipher ? Buffer.from(k.keyCipher) : null } : null;
  }
  async listKeys(statuses?: KeyStatus[]) {
    return [...this.keys.values()].filter((k) => !statuses || statuses.includes(k.status)).map((k) => ({ ...k }));
  }
  async putKey(row: KeyRow) {
    this.keys.set(row.wallet.toLowerCase(), { ...row, wallet: row.wallet.toLowerCase(), keyAddress: row.keyAddress.toLowerCase() });
  }
  async setKeyStatus(wallet: string, status: KeyStatus, at: number) {
    const k = this.keys.get(wallet.toLowerCase());
    if (!k) return;
    k.status = status;
    if (status === "active" && !k.registeredAt) k.registeredAt = at;
  }
  async touchKey(wallet: string, at: number) {
    const k = this.keys.get(wallet.toLowerCase());
    if (k) k.lastUsedAt = at;
  }
  async revokeKey(wallet: string, reason: string, at: number) {
    const k = this.keys.get(wallet.toLowerCase());
    if (!k || k.status === "revoked") return null; // first revoke wins: reason/time are never overwritten
    k.status = "revoked";
    k.keyCipher = null;
    k.revokedAt = at;
    k.revokeReason = reason;
    await this.cancelAllLive(wallet, "key-revoked");
    return { ...k };
  }
  async createKeyRequest(wallet: string) {
    const r: KeyRequest = { id: `kr-${++this.seq}`, wallet: wallet.toLowerCase(), status: "pending", keyAddress: null, error: null, createdAt: Date.now() };
    this.keyRequests.set(r.id, r);
    return { ...r };
  }
  async getKeyRequest(id: string) {
    const r = this.keyRequests.get(id);
    return r ? { ...r } : null;
  }
  async listPendingKeyRequests() {
    return [...this.keyRequests.values()].filter((r) => r.status === "pending").map((r) => ({ ...r }));
  }
  async finishKeyRequest(id: string, result: { keyAddress: string } | { error: string }) {
    const r = this.keyRequests.get(id);
    if (!r) return;
    if ("keyAddress" in result) {
      r.status = "done";
      r.keyAddress = result.keyAddress.toLowerCase();
    } else {
      r.status = "failed";
      r.error = result.error;
    }
  }

  async nextNonce(wallet: string, nowMs: number) {
    const w = wallet.toLowerCase();
    const last = this.nonces.get(w) ?? 0n;
    const now = BigInt(nowMs);
    const next = now > last ? now : last + 1n;
    this.nonces.set(w, next);
    return next;
  }

  async getKill() {
    return this.kill ? { ...this.kill } : null;
  }
  async setKill(state: KillState) {
    this.kill = { ...state };
  }

  async acquireLease(name: string, holder: string, ttlMs: number, nowMs: number) {
    const cur = this.leases.get(name);
    if (cur && cur.holder !== holder && cur.until > nowMs) return false;
    this.leases.set(name, { holder, until: nowMs + ttlMs });
    return true;
  }
  async releaseLease(name: string, holder: string) {
    const cur = this.leases.get(name);
    if (cur && cur.holder === holder) this.leases.delete(name);
  }
  async putHeartbeat(hb: Heartbeat) {
    this.heartbeat = clone(hb);
  }
  async getHeartbeat() {
    return this.heartbeat ? clone(this.heartbeat) : null;
  }

  async audit(ev: AuditEvent) {
    this.auditLog.push(clone(ev));
  }
  async listAudit(limit: number) {
    return this.auditLog.slice(-limit).reverse().map(clone);
  }
  async countSignatures(wallet: string | null, sinceMs: number) {
    return this.auditLog.filter((e) => e.event === "sign" && e.at >= sinceMs && (wallet == null || e.wallet === wallet.toLowerCase())).length;
  }
  async countEvents(wallet: string, event: string, sinceMs: number) {
    return this.auditLog.filter((e) => e.event === event && e.at >= sinceMs && e.wallet === wallet.toLowerCase()).length;
  }

  async putAuthNonce(nonce: string, payload: string, expiresAt: number) {
    this.authNonces.set(nonce, { payload, expiresAt });
  }
  async consumeAuthNonce(nonce: string, nowMs: number) {
    const n = this.authNonces.get(nonce);
    if (!n) return null;
    this.authNonces.delete(nonce); // single use whether or not it is still valid
    return n.expiresAt > nowMs ? n.payload : null;
  }

  async ping() {
    return true;
  }
}
