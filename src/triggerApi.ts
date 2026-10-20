// Browser side of server-side triggers (server/SPEC.md §4–5).
//
// The engine lives on the server; this file is a thin, polled mirror of the
// wallet's trigger rows plus the calls that mutate them. It keeps the shape
// the UI already consumes (entries / stops / enabled / subscribe / getVersion /
// stopFor / cancel / rearm / armStop / armEntry / markCancelRequested /
// setEnabled / lastGapAt) so TriggerOrders.tsx, TradeBar.tsx and Ticket.tsx
// did not have to change their contract when the local engine went away.
//
// Nothing here can sign a trade. Arming is a JSON POST behind a wallet-signed
// session cookie; the trade itself is signed by the watcher's key, which this
// browser never sees.

import type { WalletClient } from "viem";
import type { ArmEntrySpec, ArmStopSpec, AttachedStop, StopLoss, TriggerEntry, TriggerStatus } from "../shared/triggerLogic";
import { registerSessionKey } from "./session";

export type { ArmEntrySpec, ArmStopSpec, AttachedStop, CrossDirection, PriceSample, StopLoss, TriggerEntry, TriggerStatus } from "../shared/triggerLogic";

export interface KeyInfo {
  address: string;
  status: "pending" | "active" | "revoked" | "expired";
  expiresAt: number;
  registeredAt: number | null;
  revokedAt: number | null;
  revokeReason: string | null;
}

export interface WatcherInfo {
  alive: boolean;
  lastBeatAt: number | null;
  /** instrumentId → sample age ms at the last heartbeat (-1 = no sample yet) */
  feeds: Record<string, number>;
  leader: boolean;
}

export interface MeState {
  wallet: string;
  key: KeyInfo | null;
  enabled: boolean;
  watcher: WatcherInfo;
  kill: { on: boolean; reason: string; at: number | null } | null;
}

/** what the status-diff watcher reports so the app can toast it */
export type TriggerEvent =
  | { type: "entry-queued" | "entry-failed" | "entry-expired" | "entry-executed" | "entry-unknown" | "entry-unreconciled"; entry: TriggerEntry }
  | { type: "stop-queued" | "stop-failed" | "stop-executed" | "stop-unknown" | "stop-expired" | "stop-done"; stop: StopLoss };

export interface ApiResult<T = unknown> {
  ok: boolean;
  status: number;
  data?: T;
  error?: string;
  message?: string;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message?: string
  ) {
    super(message ?? code);
  }
}

const POLL_MS = 1500;
const ME_MS = 5000;

const REG_KEY = "byintent.trig.reg.v1";
type RegSubmissions = Record<string, { key: string; at: number }>;
let regMem: RegSubmissions | null = null;
function readRegSubmissions(): RegSubmissions {
  if (regMem) return regMem;
  try {
    const parsed = JSON.parse(localStorage.getItem(REG_KEY) ?? "{}");
    regMem = parsed && typeof parsed === "object" ? (parsed as RegSubmissions) : {};
  } catch {
    regMem = {};
  }
  return regMem;
}

async function call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<ApiResult<T>> {
  try {
    const res = await fetch(path, {
      method,
      credentials: "same-origin",
      headers: body !== undefined ? { "content-type": "application/json", accept: "application/json" } : { accept: "application/json" },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      cache: "no-store",
    });
    const text = await res.text();
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    if (!res.ok) {
      const d = (data ?? {}) as { error?: string; message?: string };
      return { ok: false, status: res.status, error: d.error ?? `http_${res.status}`, message: d.message };
    }
    return { ok: true, status: res.status, data: data as T };
  } catch (e) {
    return { ok: false, status: 0, error: "network", message: e instanceof Error ? e.message : String(e) };
  }
}

const ENTRY_EVENTS: Partial<Record<TriggerStatus, TriggerEvent["type"]>> = {
  queued: "entry-queued",
  failed: "entry-failed",
  expired: "entry-expired",
  executed: "entry-executed",
  unknown: "entry-unknown",
  unreconciled: "entry-unreconciled",
};
const STOP_EVENTS: Partial<Record<TriggerStatus, TriggerEvent["type"]>> = {
  queued: "stop-queued",
  failed: "stop-failed",
  executed: "stop-executed",
  unknown: "stop-unknown",
  expired: "stop-expired",
  done: "stop-done",
};

export class RemoteTriggerStore {
  entries: TriggerEntry[] = [];
  stops: StopLoss[] = [];
  enabled = true;
  me: MeState | null = null;
  /** null until the first /api/me answer; false = 401 (sign-in needed) */
  authed: boolean | null = null;
  /** the trigger API itself is unreachable / disabled (503, network) */
  apiDown = false;
  /** kept for the Orders tab banner contract; the server reports gaps through the heartbeat instead */
  lastGapAt: number | null = null;
  onEvent: ((ev: TriggerEvent) => void) | null = null;

  private version = 0;
  private listeners = new Set<() => void>();
  private listVersion = "";
  private statusById = new Map<string, TriggerStatus>();
  private primed = false;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private meTimer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private inflight = false;

  constructor(readonly wallet: string) {}

  // ---- external-store contract -------------------------------------------------
  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  getVersion = (): number => this.version;
  private bump() {
    this.version++;
    for (const l of this.listeners) l();
  }

  stopFor(positionId: string): StopLoss | undefined {
    return this.stops.find((s) => s.positionId === positionId && s.status !== "cancelled" && s.status !== "done" && s.status !== "executed" && s.status !== "failed" && s.status !== "expired");
  }

  // ---- lifecycle --------------------------------------------------------------------
  start() {
    if (this.pollTimer) return;
    void this.refreshMe();
    void this.refresh();
    this.pollTimer = setInterval(() => void this.refresh(), POLL_MS);
    this.meTimer = setInterval(() => void this.refreshMe(), ME_MS);
    const onVis = () => {
      if (document.visibilityState === "visible") {
        void this.refreshMe();
        void this.refresh();
      }
    };
    document.addEventListener("visibilitychange", onVis);
    this.detachVis = () => document.removeEventListener("visibilitychange", onVis);
  }
  private detachVis: (() => void) | null = null;

  stop() {
    this.stopped = true;
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.meTimer) clearInterval(this.meTimer);
    this.pollTimer = this.meTimer = null;
    this.detachVis?.();
    this.listeners.clear();
  }

  // ---- reads ------------------------------------------------------------------------------
  async refreshMe(): Promise<void> {
    if (this.stopped) return;
    const r = await call<MeState>("GET", "/api/me");
    if (this.stopped) return;
    if (r.ok && r.data) {
      // a cookie for another wallet is not our session
      if (r.data.wallet.toLowerCase() !== this.wallet.toLowerCase()) {
        this.setAuthed(false);
        return;
      }
      this.me = r.data;
      this.enabled = r.data.enabled;
      this.apiDown = false;
      this.setAuthed(true);
      this.bump();
    } else if (r.status === 401) {
      this.setAuthed(false);
    } else if (r.status === 503 || r.status === 0) {
      if (!this.apiDown) {
        this.apiDown = true;
        this.bump();
      }
    }
  }

  private setAuthed(v: boolean) {
    if (this.authed === v) return;
    this.authed = v;
    if (!v) {
      this.me = null;
      this.entries = [];
      this.stops = [];
      this.listVersion = "";
      this.primed = false;
      this.statusById.clear();
    }
    this.bump();
  }

  async refresh(): Promise<void> {
    if (this.stopped || this.inflight || this.authed === false) return;
    this.inflight = true;
    try {
      const r = await call<{ version: string; enabled: boolean; entries: TriggerEntry[]; stops: StopLoss[] }>("GET", "/api/triggers");
      if (this.stopped) return;
      if (!r.ok) {
        if (r.status === 401) this.setAuthed(false);
        else if (r.status === 503 || r.status === 0) {
          if (!this.apiDown) {
            this.apiDown = true;
            this.bump();
          }
        }
        return;
      }
      const d = r.data!;
      this.apiDown = false;
      if (d.version === this.listVersion && d.enabled === this.enabled) return;
      this.listVersion = d.version;
      this.enabled = d.enabled;
      this.entries = d.entries;
      this.stops = d.stops;
      this.diffStatuses();
      this.bump();
    } finally {
      this.inflight = false;
    }
  }

  /** emit one event per observed status change (not on the first load — those already happened) */
  private diffStatuses() {
    const next = new Map<string, TriggerStatus>();
    for (const e of this.entries) {
      next.set(e.id, e.status);
      if (this.primed && this.statusById.get(e.id) !== e.status) {
        const type = ENTRY_EVENTS[e.status];
        if (type && this.onEvent) this.onEvent({ type, entry: e } as TriggerEvent);
      }
    }
    for (const s of this.stops) {
      next.set(s.id, s.status);
      if (this.primed && this.statusById.get(s.id) !== s.status) {
        const type = STOP_EVENTS[s.status];
        if (type && this.onEvent) this.onEvent({ type, stop: s } as TriggerEvent);
      }
    }
    this.statusById = next;
    this.primed = true;
  }

  // ---- auth / key ---------------------------------------------------------------------------
  /** one personal_sign → session cookie */
  async signIn(walletClient: WalletClient): Promise<ApiResult> {
    const c = await call<{ message: string; nonce: string }>("POST", "/api/auth/challenge", { address: this.wallet });
    if (!c.ok || !c.data) return c;
    const account = walletClient.account?.address ?? (this.wallet as `0x${string}`);
    const signature = await walletClient.signMessage({ account, message: c.data.message });
    const v = await call("POST", "/api/auth/verify", { address: this.wallet, nonce: c.data.nonce, signature });
    if (v.ok) {
      await this.refreshMe();
      await this.refresh();
    }
    return v;
  }

  async signOut(): Promise<void> {
    await call("POST", "/api/auth/logout", {});
    this.setAuthed(false);
  }

  /**
   * Enabling server-side triggers is two steps the UI drives one button at a
   * time: mintKey() asks the watcher for a key (no signature; the private key
   * never reaches this browser), registerKey() has the wallet sign one EIP-712
   * message that registers the key's *address* on-chain. The key turns active
   * once the watcher sees it on-chain (a few seconds).
   */
  async mintKey(): Promise<ApiResult<{ keyAddress: string; expiryS: number; status: string }>> {
    const k = await call<{ keyAddress: string; expiryS: number; status: string }>("POST", "/api/watcher/key", {});
    if (k.ok) await this.refreshMe();
    return k;
  }

  async registerKey(walletClient: WalletClient): Promise<ApiResult> {
    const key = this.me?.key;
    if (!key || key.status !== "pending") return { ok: false, status: 409, error: "no_pending_key" };
    const reg = await registerSessionKey(walletClient, this.wallet as `0x${string}`, {
      key: key.address as `0x${string}`,
      expiryS: Math.floor(key.expiresAt / 1000),
    });
    if (!reg.ok) return { ok: false, status: 400, error: reg.error ?? "register_failed", message: reg.message ?? reg.reason ?? undefined };
    this.markRegistrationSubmitted(key.address);
    await call("POST", "/api/watcher/key/registered", { intentId: reg.intentId ?? null });
    await this.refreshMe();
    return { ok: true, status: 200, data: reg };
  }

  /** both steps in one go (kept for callers that do not care about the intermediate state) */
  async setupKey(walletClient: WalletClient): Promise<ApiResult> {
    const k = await this.mintKey();
    if (!k.ok || !k.data) return k;
    if (k.data.status === "active") return { ok: true, status: 200 };
    return this.registerKey(walletClient);
  }

  /**
   * When the registration signature for the current pending key went out. The
   * server only learns that the key is active once it shows up on-chain, so this
   * is what lets the UI say "registering…" instead of asking for the signature
   * again. Kept per wallet+key in localStorage so a reload does not lose it.
   */
  get registrationSubmittedAt(): number | null {
    const key = this.me?.key;
    if (!key || key.status !== "pending") return null;
    const rec = readRegSubmissions()[this.wallet.toLowerCase()];
    return rec && rec.key.toLowerCase() === key.address.toLowerCase() ? rec.at : null;
  }

  private markRegistrationSubmitted(keyAddress: string) {
    const all = readRegSubmissions();
    all[this.wallet.toLowerCase()] = { key: keyAddress, at: Date.now() };
    try {
      localStorage.setItem(REG_KEY, JSON.stringify(all));
    } catch {
      /* private mode — the in-memory copy below still covers this session */
    }
    regMem = all;
    this.bump();
  }

  /** server-side revoke: cipher wiped, live triggers cancelled. The on-chain revoke is a separate wallet tx. */
  async revoke(): Promise<ApiResult> {
    const r = await call("POST", "/api/watcher/key/revoke", {});
    await this.refreshMe();
    await this.refresh();
    return r;
  }

  // ---- mutations ----------------------------------------------------------------------------
  private async mutate<T>(path: string, body: unknown): Promise<ApiResult<T>> {
    const r = await call<T>("POST", path, body);
    if (r.status === 401) this.setAuthed(false);
    // pull the authoritative state right away rather than waiting for the next tick
    this.listVersion = "";
    void this.refresh();
    // the heartbeat picks up newly needed price feeds within ~3 s; fetch it then
    setTimeout(() => void this.refreshMe(), 3000);
    return r;
  }

  armEntry(spec: ArmEntrySpec): Promise<ApiResult<TriggerEntry>> {
    return this.mutate<TriggerEntry>("/api/triggers/entry", spec);
  }
  /** set / replace / clear the stop a waiting entry spawns when it fills */
  setEntryStop(id: string, stop: AttachedStop | null): Promise<ApiResult<TriggerEntry>> {
    return this.mutate<TriggerEntry>(`/api/triggers/${encodeURIComponent(id)}/stop`, { stop });
  }
  armStop(spec: ArmStopSpec): Promise<ApiResult<StopLoss>> {
    return this.mutate<StopLoss>("/api/triggers/stop", spec);
  }
  cancel(id: string): Promise<ApiResult> {
    return this.mutate(`/api/triggers/${encodeURIComponent(id)}/cancel`, {});
  }
  rearm(id: string): Promise<ApiResult> {
    return this.mutate(`/api/triggers/${encodeURIComponent(id)}/rearm`, {});
  }
  /** the user cancelled the queued intent (or asked us to): the watcher sends cancelIntent once */
  markCancelRequested(id: string): Promise<ApiResult> {
    return this.mutate(`/api/triggers/${encodeURIComponent(id)}/cancel-queued`, {});
  }
  setEnabled(enabled: boolean): Promise<ApiResult> {
    this.enabled = enabled; // optimistic; refresh() corrects it
    this.bump();
    return this.mutate("/api/triggers/enabled", { enabled });
  }

  // ---- derived ---------------------------------------------------------------------------------
  /** true when armed triggers can actually fire: signed in, active unexpired key, watcher alive, not killed */
  get healthy(): boolean {
    const m = this.me;
    if (!m || !m.key || m.key.status !== "active" || m.key.expiresAt <= Date.now()) return false;
    if (m.kill?.on) return false;
    return m.watcher.alive;
  }
  liveInstruments(): number[] {
    const ids = new Set<number>();
    for (const x of [...this.entries, ...this.stops]) if (x.status === "armed" || x.status === "confirming" || x.status === "firing") ids.add(x.instrumentId);
    return [...ids];
  }
}
