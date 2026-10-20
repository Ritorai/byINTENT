// The only code in the system that touches a session private key.
// (SPEC.md §3, §6.4)
//
// Every signature passes the same gate, in this order, immediately before
// the key is decrypted:
//   1. global kill off (DB flag or WATCHER_KILL env)
//   2. we still hold the leader lease
//   3. the wallet's key row is `active`, unexpired, and decryptable
//   4. breakers: per-wallet signatures/hour, global signatures/minute
// Then: decrypt → sign → wipe → submit → audit. Only three actions exist
// here — openPosition, closePositions, cancelIntent — there is no code path
// that could sign a withdrawal, a key registration or a staking intent.

import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { INTENT_TTL_S, buildIntent, marginToSize, splitSig } from "../shared/intentWire";
import type { StopLoss, TriggerEntry } from "../shared/triggerLogic";
import { open as kekOpen, seal as kekSeal, wipe, type Kek } from "./crypto";
import { log } from "./log";
import type { RelayerClient, RelayerResult } from "./relayer";
import type { KeyRow, Repo } from "./repo";

export interface ExecuteResult {
  ok: boolean;
  intentId?: string;
  /** raw relayer error code (classification) */
  code?: string;
  reason?: string;
  /** relayer 5xx / network — the intent may or may not have landed */
  transient?: boolean;
  /** our own gate refused before anything was signed */
  gate?: "kill" | "lease" | "key-revoked" | "key-expired" | "key-missing" | "breaker";
}

export interface SignerDeps {
  repo: Repo;
  relayer: RelayerClient;
  kek: Kek;
  kekPrev: Kek | null;
  /** true while this process holds the engine lease (re-checked per signature) */
  isLeader: () => boolean;
  envKill: () => boolean;
  limits: { walletFiresPerHour: number; globalFiresPerMin: number };
  now?: () => number;
}

export class KeyVault {
  constructor(private repo: Repo, private kek: Kek, private kekPrev: Kek | null) {}

  /** Generate a fresh session key for a wallet; only the sealed form is returned. */
  generate(wallet: string, expiryS: number, now: number): KeyRow {
    const pk = generatePrivateKey();
    const address = privateKeyToAccount(pk).address.toLowerCase();
    const raw = Buffer.from(pk.slice(2), "hex");
    const cipher = kekSeal(this.kek, raw, wallet.toLowerCase());
    wipe(raw);
    return {
      wallet: wallet.toLowerCase(),
      keyAddress: address,
      keyCipher: cipher,
      kekId: this.kek.id,
      expiryS,
      status: "pending",
      createdAt: now,
      registeredAt: null,
      revokedAt: null,
      revokeReason: null,
      lastUsedAt: null,
    };
  }

  /** Decrypt for the duration of `fn` only. Throws if the row can't be opened. */
  async withKey<T>(row: KeyRow, fn: (account: ReturnType<typeof privateKeyToAccount>) => Promise<T>): Promise<T> {
    if (!row.keyCipher) throw new Error("key wiped");
    const kek = row.kekId === this.kek.id ? this.kek : this.kekPrev && row.kekId === this.kekPrev.id ? this.kekPrev : null;
    if (!kek) throw new Error(`no KEK for kek_id ${row.kekId}`);
    const raw = kekOpen(kek, row.keyCipher, row.wallet);
    const hex = `0x${raw.toString("hex")}` as `0x${string}`;
    wipe(raw);
    try {
      const account = privateKeyToAccount(hex);
      if (account.address.toLowerCase() !== row.keyAddress.toLowerCase()) throw new Error("key/address mismatch");
      return await fn(account);
    } finally {
      // the hex string is immutable; the account object holds the key until GC —
      // this is the best JS can do, which is why the KEK never leaves this process
    }
  }
}

const nowS = () => Math.floor(Date.now() / 1000);

export class Signer {
  readonly vault: KeyVault;
  private now: () => number;
  constructor(private d: SignerDeps) {
    this.vault = new KeyVault(d.repo, d.kek, d.kekPrev);
    this.now = d.now ?? Date.now;
  }

  // ---- the gate ----------------------------------------------------------------
  private async gate(wallet: string): Promise<{ ok: true; key: KeyRow } | { ok: false; res: ExecuteResult }> {
    const now = this.now();
    if (this.d.envKill()) return { ok: false, res: { ok: false, gate: "kill", code: "killed" } };
    const kill = await this.d.repo.getKill();
    if (kill?.on) return { ok: false, res: { ok: false, gate: "kill", code: "killed" } };
    if (!this.d.isLeader()) return { ok: false, res: { ok: false, gate: "lease", code: "not-leader" } };

    const key = await this.d.repo.getKey(wallet);
    if (!key) return { ok: false, res: { ok: false, gate: "key-missing", code: "key-missing" } };
    if (key.status === "revoked") return { ok: false, res: { ok: false, gate: "key-revoked", code: "key-revoked" } };
    if (key.status !== "active") return { ok: false, res: { ok: false, gate: "key-missing", code: "key-inactive" } };
    if (key.expiryS <= nowS() + 5) {
      await this.d.repo.setKeyStatus(wallet, "expired", now);
      await this.d.repo.audit({ at: now, wallet, triggerId: null, event: "key.expired", detail: {} });
      return { ok: false, res: { ok: false, gate: "key-expired", code: "key-expired" } };
    }

    // breakers (SPEC §3): counted from the append-only audit log
    const perWallet = await this.d.repo.countSignatures(wallet, now - 3_600_000);
    if (perWallet >= this.d.limits.walletFiresPerHour) {
      await this.d.repo.revokeKey(wallet, "breaker:wallet-rate", now);
      await this.d.repo.audit({ at: now, wallet, triggerId: null, event: "breaker", detail: { kind: "wallet-rate", count: perWallet } });
      log.error(`BREAKER wallet-rate tripped for ${wallet.slice(0, 10)}… (${perWallet}/h) — key revoked`);
      return { ok: false, res: { ok: false, gate: "breaker", code: "breaker" } };
    }
    const global = await this.d.repo.countSignatures(null, now - 60_000);
    if (global >= this.d.limits.globalFiresPerMin) {
      await this.d.repo.setKill({ on: true, reason: `breaker:global-rate (${global}/min)`, at: now });
      await this.d.repo.audit({ at: now, wallet: null, triggerId: null, event: "breaker", detail: { kind: "global-rate", count: global } });
      log.error(`BREAKER global-rate tripped (${global}/min) — kill switch ON`);
      return { ok: false, res: { ok: false, gate: "breaker", code: "breaker" } };
    }
    return { ok: true, key };
  }

  private async signAndSubmit(
    key: KeyRow,
    triggerId: string | null,
    action: "openPosition" | "closePositions" | "cancelIntent",
    message: Record<string, unknown>,
    submit: (signed: Record<string, unknown>) => Promise<RelayerResult>
  ): Promise<ExecuteResult> {
    const now = this.now();
    let signed: Record<string, unknown>;
    try {
      signed = await this.vault.withKey(key, async (account) => {
        const { typedData, wire } = buildIntent(action, message);
        const sig = await account.signTypedData(typedData as any);
        return { ...wire, ...splitSig(sig) };
      });
    } catch (e) {
      log.error(`sign ${action} for ${key.wallet.slice(0, 10)}… failed before submit: ${e instanceof Error ? e.message : e}`);
      return { ok: false, code: "sign-failed" };
    }
    // the signature itself exists now — audit BEFORE the network call so a
    // crash mid-submit still counts toward the breakers
    await this.d.repo.audit({ at: now, wallet: key.wallet, triggerId, event: "sign", detail: { action } });
    await this.d.repo.touchKey(key.wallet, now);

    let r: RelayerResult;
    try {
      r = await submit(signed);
    } catch (e) {
      // thrown = network/abort: the intent may or may not have landed
      await this.d.repo.audit({ at: this.now(), wallet: key.wallet, triggerId, event: "submit", detail: { action, outcome: "thrown", error: e instanceof Error ? e.message : String(e) } });
      return { ok: false, transient: true, code: "network" };
    }
    await this.d.repo.audit({
      at: this.now(),
      wallet: key.wallet,
      triggerId,
      event: "submit",
      detail: { action, ok: r.ok, intentId: r.intentId ?? null, code: r.error ?? null, reason: r.reason ?? null, http: r.httpStatus ?? null },
    });
    if (r.ok) return { ok: true, intentId: r.intentId };
    if (r.error === "unauthorized_intent") {
      // 3 in 5 min = the key is being refused: revoked under us, or something is replaying
      const n = await this.d.repo.countEvents(key.wallet, "unauthorized", this.now() - 300_000);
      await this.d.repo.audit({ at: this.now(), wallet: key.wallet, triggerId, event: "unauthorized", detail: { action } });
      if (n + 1 >= 3) {
        await this.d.repo.revokeKey(key.wallet, "breaker:unauthorized", this.now());
        await this.d.repo.audit({ at: this.now(), wallet: key.wallet, triggerId: null, event: "breaker", detail: { kind: "unauthorized", count: n + 1 } });
        log.error(`BREAKER unauthorized_intent ×${n + 1} for ${key.wallet.slice(0, 10)}… — key revoked`);
      }
    }
    return { ok: false, code: r.error, reason: r.reason, transient: !!r.error && /^http_5/.test(r.error) };
  }

  // ---- the three actions ---------------------------------------------------------
  async open(entry: TriggerEntry): Promise<ExecuteResult> {
    const g = await this.gate(entry.wallet);
    if (!g.ok) return g.res;
    const nonce = await this.d.repo.nextNonce(entry.wallet, this.now());
    const message = {
      user: entry.wallet,
      instrumentId: entry.instrumentId,
      isLong: entry.isLong,
      size: marginToSize(entry.marginUsdc),
      leverage: Math.round(entry.leverage),
      useDebt: entry.useDebt,
      nonce,
      deadline: BigInt(nowS() + INTENT_TTL_S),
    };
    return this.signAndSubmit(g.key, entry.id, "openPosition", message, (signed) => this.d.relayer.submitIntent("openPosition", signed));
  }

  async close(stop: StopLoss): Promise<ExecuteResult> {
    const g = await this.gate(stop.wallet);
    if (!g.ok) return g.res;
    const nonce = await this.d.repo.nextNonce(stop.wallet, this.now());
    const message = { user: stop.wallet, positionIds: [BigInt(stop.positionId)], nonce, deadline: BigInt(nowS() + INTENT_TTL_S) };
    return this.signAndSubmit(g.key, stop.id, "closePositions", message, (signed) => this.d.relayer.submitIntent("closePositions", signed));
  }

  async cancel(wallet: string, triggerId: string, intentId: string): Promise<ExecuteResult> {
    const g = await this.gate(wallet);
    if (!g.ok) return g.res;
    const message = { user: wallet, intentId: intentId as `0x${string}`, deadline: BigInt(nowS() + INTENT_TTL_S) };
    return this.signAndSubmit(g.key, triggerId, "cancelIntent", message, (signed) => {
      const body = { ...signed };
      delete body.intentId; // in the URL, like their frontend
      return this.d.relayer.submitCancel(intentId, body);
    });
  }
}
