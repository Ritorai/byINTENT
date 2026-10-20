// Postgres implementation of Repo (SPEC.md §6–8). Schema is created on
// start with CREATE … IF NOT EXISTS; the trigger record itself is stored as
// jsonb with the hot fields (wallet, kind, status, version, created_at)
// extracted into columns for indexing and atomic transitions.

import type { Pool, PoolClient } from "pg";
import type { AttachedStop, ExitKind, WalletDay, WalletPolicy } from "../shared/triggerLogic";
import type {
  AuditEvent,
  Heartbeat,
  KeyRequest,
  KeyRow,
  KeyStatus,
  KillState,
  Repo,
  TriggerRecord,
  WalletSettings,
} from "./repo";
import { emptySettings } from "./repo";

const TERMINAL_SQL = `('executed','unreconciled','expired','failed','cancelled','done')`;

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS triggers (
  id          text PRIMARY KEY,
  wallet      text NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('entry','stop')),
  status      text NOT NULL,
  version     integer NOT NULL DEFAULT 1,
  created_at  bigint NOT NULL,
  data        jsonb NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS triggers_wallet_created ON triggers (wallet, created_at DESC);
CREATE INDEX IF NOT EXISTS triggers_active ON triggers (status) WHERE status NOT IN ${TERMINAL_SQL};

CREATE TABLE IF NOT EXISTS wallet_settings (
  wallet      text PRIMARY KEY,
  enabled     boolean NOT NULL DEFAULT true,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS watcher_keys (
  wallet         text PRIMARY KEY,
  key_address    text NOT NULL,
  key_cipher     bytea,
  kek_id         text NOT NULL,
  expiry_s       bigint NOT NULL,
  status         text NOT NULL CHECK (status IN ('pending','active','revoked','expired')),
  created_at     bigint NOT NULL,
  registered_at  bigint,
  revoked_at     bigint,
  revoke_reason  text,
  last_used_at   bigint
);

CREATE TABLE IF NOT EXISTS key_requests (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet       text NOT NULL,
  status       text NOT NULL DEFAULT 'pending',
  key_address  text,
  error        text,
  created_at   bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS key_requests_pending ON key_requests (created_at) WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS watcher_nonces (
  wallet      text PRIMARY KEY,
  last_nonce  numeric(40,0) NOT NULL
);

CREATE TABLE IF NOT EXISTS watcher_settings (
  key         text PRIMARY KEY,
  value       jsonb NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS watcher_leases (
  name      text PRIMARY KEY,
  holder    text NOT NULL,
  until_ms  bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS watcher_audit (
  id          bigserial PRIMARY KEY,
  at          bigint NOT NULL,
  wallet      text,
  trigger_id  text,
  event       text NOT NULL,
  detail      jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS watcher_audit_event_at ON watcher_audit (event, at);
CREATE INDEX IF NOT EXISTS watcher_audit_wallet_at ON watcher_audit (wallet, at);

CREATE TABLE IF NOT EXISTS auth_nonces (
  nonce       text PRIMARY KEY,
  address     text NOT NULL,
  expires_at  bigint NOT NULL
);
`;

type Row = { data: any; version: number };

const fromRow = (r: Row): TriggerRecord => ({ ...r.data, version: Number(r.version) }) as TriggerRecord;

/** strip `version` (a column) before the json goes into `data` */
const toData = (rec: TriggerRecord): Record<string, unknown> => {
  const { version: _v, ...rest } = rec as TriggerRecord & { version: number };
  return rest;
};

const n = (v: unknown): number | null => (v == null ? null : Number(v));

const keyFromRow = (r: any): KeyRow => ({
  wallet: r.wallet,
  keyAddress: r.key_address,
  keyCipher: r.key_cipher ? Buffer.from(r.key_cipher) : null,
  kekId: r.kek_id,
  expiryS: Number(r.expiry_s),
  status: r.status,
  createdAt: Number(r.created_at),
  registeredAt: n(r.registered_at),
  revokedAt: n(r.revoked_at),
  revokeReason: r.revoke_reason ?? null,
  lastUsedAt: n(r.last_used_at),
});

const reqFromRow = (r: any): KeyRequest => ({
  id: String(r.id),
  wallet: r.wallet,
  status: r.status,
  keyAddress: r.key_address ?? null,
  error: r.error ?? null,
  createdAt: Number(r.created_at),
});

export class PgRepo implements Repo {
  constructor(private pool: Pool) {}

  async migrate(): Promise<void> {
    await this.pool.query(SCHEMA_SQL);
    await this.pool.query(`
      ALTER TABLE wallet_settings ADD COLUMN IF NOT EXISTS policy jsonb NOT NULL DEFAULT '{}'::jsonb;
      ALTER TABLE wallet_settings ADD COLUMN IF NOT EXISTS day jsonb NOT NULL DEFAULT '{}'::jsonb;
      ALTER TABLE wallet_settings ADD COLUMN IF NOT EXISTS exposure jsonb NOT NULL DEFAULT '{}'::jsonb;
    `);
  }

  private async tx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const c = await this.pool.connect();
    try {
      await c.query("BEGIN");
      const out = await fn(c);
      await c.query("COMMIT");
      return out;
    } catch (e) {
      try {
        await c.query("ROLLBACK");
      } catch {
        /* connection already gone */
      }
      throw e;
    } finally {
      c.release();
    }
  }

  // ---- triggers --------------------------------------------------------------
  async listActiveTriggers() {
    const r = await this.pool.query<Row>(`SELECT data, version FROM triggers WHERE status NOT IN ${TERMINAL_SQL} ORDER BY created_at`);
    return r.rows.map(fromRow);
  }
  async listTriggersForWallet(wallet: string, terminalLimit = 50) {
    const r = await this.pool.query<Row>(
      `(SELECT data, version FROM triggers WHERE wallet = $1 AND status NOT IN ${TERMINAL_SQL})
       UNION ALL
       (SELECT data, version FROM triggers WHERE wallet = $1 AND status IN ${TERMINAL_SQL} ORDER BY created_at DESC LIMIT $2)`,
      [wallet.toLowerCase(), terminalLimit]
    );
    return r.rows.map(fromRow);
  }
  async getTrigger(wallet: string, id: string) {
    const r = await this.pool.query<Row>(`SELECT data, version FROM triggers WHERE id = $1 AND wallet = $2`, [id, wallet.toLowerCase()]);
    return r.rows[0] ? fromRow(r.rows[0]) : null;
  }
  async insertTrigger(rec: TriggerRecord) {
    await this.pool.query(
      `INSERT INTO triggers (id, wallet, kind, status, version, created_at, data) VALUES ($1,$2,$3,$4,1,$5,$6)`,
      [rec.id, rec.wallet.toLowerCase(), rec.kind, rec.status, Math.floor(rec.createdAt), JSON.stringify(toData(rec))]
    );
  }
  async updateTrigger(rec: TriggerRecord) {
    const r = await this.pool.query(
      `UPDATE triggers SET status = $3, data = $4, version = version + 1, updated_at = now()
       WHERE id = $1 AND version = $2`,
      [rec.id, rec.version, rec.status, JSON.stringify(toData(rec))]
    );
    if (r.rowCount === 1) {
      rec.version += 1;
      return true;
    }
    return false;
  }
  async updateTriggerAndSpawn(rec: TriggerRecord, spawns: TriggerRecord[]) {
    return this.tx(async (c) => {
      const r = await c.query(
        `UPDATE triggers SET status = $3, data = $4, version = version + 1, updated_at = now()
         WHERE id = $1 AND version = $2`,
        [rec.id, rec.version, rec.status, JSON.stringify(toData(rec))]
      );
      if (r.rowCount !== 1) return false; // stale: nothing written, the commit is a no-op
      for (const spawn of spawns) {
        await c.query(
          `INSERT INTO triggers (id, wallet, kind, status, version, created_at, data) VALUES ($1,$2,$3,$4,1,$5,$6)`,
          [spawn.id, spawn.wallet.toLowerCase(), spawn.kind, spawn.status, Math.floor(spawn.createdAt), JSON.stringify(toData(spawn))]
        );
      }
      rec.version += 1;
      return true;
    });
  }
  async setAttachedStop(wallet: string, id: string, stop: AttachedStop | null, which: ExitKind = "stop") {
    const r = await this.pool.query<Row>(
      `UPDATE triggers SET data = data || $3::jsonb, version = version + 1, updated_at = now()
       WHERE id = $1 AND wallet = $2 AND kind = 'entry' AND status IN ('armed','confirming','attention')
       RETURNING data, version`,
      [id, wallet.toLowerCase(), JSON.stringify(which === "tp" ? { attachedTp: stop } : { attachedStop: stop })]
    );
    return r.rows[0] ? fromRow(r.rows[0]) : null;
  }
  async casFire(id: string, firedAt: number, prePositionIds: string[] | null) {
    const patch: Record<string, unknown> = { status: "firing", firedAt, confirmingSince: null, crossSampleTs: null };
    const r = await this.pool.query<Row>(
      `UPDATE triggers
         SET status = 'firing', version = version + 1, updated_at = now(),
             data = data || $2::jsonb
                  || CASE WHEN kind = 'entry' THEN jsonb_build_object('prePositionIds', $3::jsonb) ELSE '{}'::jsonb END
                  || CASE WHEN kind = 'stop'  THEN jsonb_build_object('lastAttemptAt', $4::bigint) ELSE '{}'::jsonb END
       WHERE id = $1 AND status IN ('armed','confirming')
       RETURNING data, version`,
      [id, JSON.stringify(patch), JSON.stringify(prePositionIds ?? []), Math.floor(firedAt)]
    );
    return r.rows[0] ? fromRow(r.rows[0]) : null;
  }
  private async transition(wallet: string, id: string, from: string[], patch: Record<string, unknown>) {
    const status = typeof patch.status === "string" ? patch.status : null;
    const r = await this.pool.query<Row>(
      `UPDATE triggers SET data = data || $3::jsonb, status = COALESCE($4, status), version = version + 1, updated_at = now()
       WHERE id = $1 AND wallet = $2 AND status = ANY($5::text[])
       RETURNING data, version`,
      [id, wallet.toLowerCase(), JSON.stringify(patch), status, from]
    );
    return r.rows[0] ? fromRow(r.rows[0]) : null;
  }
  async cancelTrigger(wallet: string, id: string) {
    return this.transition(wallet, id, ["armed", "confirming", "attention"], { status: "cancelled" });
  }
  async rearmTrigger(wallet: string, id: string) {
    return this.transition(wallet, id, ["attention"], { status: "armed", confirmingSince: null, crossSampleTs: null, rebaseline: true });
  }
  async requestCancelQueued(wallet: string, id: string) {
    return this.transition(wallet, id, ["queued"], { cancelRequested: true });
  }
  async supersedeLiveStops(wallet: string, positionId: string, exit: ExitKind = "stop") {
    const r = await this.pool.query(
      `UPDATE triggers SET status = 'cancelled', data = data || '{"status":"cancelled"}'::jsonb, version = version + 1, updated_at = now()
       WHERE wallet = $1 AND kind = 'stop' AND status IN ('armed','confirming') AND data->>'positionId' = $2
         AND coalesce(data->>'exit', 'stop') = $3`,
      [wallet.toLowerCase(), positionId, exit]
    );
    return r.rowCount ?? 0;
  }
  async countLiveTriggers(wallet: string) {
    const r = await this.pool.query<{ c: string }>(
      `SELECT count(*)::text AS c FROM triggers WHERE wallet = $1 AND status IN ('armed','confirming','firing','attention')`,
      [wallet.toLowerCase()]
    );
    return Number(r.rows[0]?.c ?? 0);
  }
  async cancelAllLive(wallet: string, reason: string) {
    return this.cancelAllLiveWith(this.pool, wallet, reason);
  }
  private async cancelAllLiveWith(c: Pool | PoolClient, wallet: string, reason: string) {
    const r = await c.query(
      `UPDATE triggers SET status = 'cancelled', data = data || $2::jsonb, version = version + 1, updated_at = now()
       WHERE wallet = $1 AND status IN ('armed','confirming','firing','attention')`,
      [wallet.toLowerCase(), JSON.stringify({ status: "cancelled", error: reason })]
    );
    return r.rowCount ?? 0;
  }

  // ---- settings ---------------------------------------------------------------
  private settingsFromRow(r: { enabled: boolean; policy: unknown; day: unknown; exposure: unknown } | undefined): WalletSettings {
    if (!r) return emptySettings();
    const policy = r.policy && typeof r.policy === "object" && !Array.isArray(r.policy) ? (r.policy as WalletPolicy) : {};
    const day = r.day && typeof r.day === "object" && !Array.isArray(r.day) ? (r.day as WalletDay) : emptySettings().day;
    const exposure = r.exposure && typeof r.exposure === "object" && !Array.isArray(r.exposure) ? (r.exposure as Record<string, number>) : {};
    return { enabled: !!r.enabled, policy, day, exposure };
  }
  async getWalletSettings(wallet: string): Promise<WalletSettings> {
    const r = await this.pool.query<{ enabled: boolean; policy: unknown; day: unknown; exposure: unknown }>(
      `SELECT enabled, policy, day, exposure FROM wallet_settings WHERE wallet = $1`,
      [wallet.toLowerCase()]
    );
    return this.settingsFromRow(r.rows[0]);
  }
  async setWalletEnabled(wallet: string, enabled: boolean) {
    await this.pool.query(
      `INSERT INTO wallet_settings (wallet, enabled) VALUES ($1, $2)
       ON CONFLICT (wallet) DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = now()`,
      [wallet.toLowerCase(), enabled]
    );
  }
  async setWalletPolicy(wallet: string, policy: WalletPolicy): Promise<WalletSettings> {
    const r = await this.pool.query<{ enabled: boolean; policy: unknown; day: unknown; exposure: unknown }>(
      `INSERT INTO wallet_settings (wallet, enabled, policy, day)
       VALUES ($1, true, $2::jsonb, '{}'::jsonb)
       ON CONFLICT (wallet) DO UPDATE SET
         policy = EXCLUDED.policy,
         day = COALESCE(wallet_settings.day, '{}'::jsonb) || '{"tripped":null}'::jsonb,
         updated_at = now()
       RETURNING enabled, policy, day, exposure`,
      [wallet.toLowerCase(), JSON.stringify(policy)]
    );
    return this.settingsFromRow(r.rows[0]);
  }
  async saveWalletRuntime(wallet: string, day: WalletDay, exposure: Record<string, number>) {
    await this.pool.query(
      `INSERT INTO wallet_settings (wallet, enabled, day, exposure) VALUES ($1, true, $2::jsonb, $3::jsonb)
       ON CONFLICT (wallet) DO UPDATE SET day = EXCLUDED.day, exposure = EXCLUDED.exposure, updated_at = now()`,
      [wallet.toLowerCase(), JSON.stringify(day), JSON.stringify(exposure)]
    );
  }
  async cancelLiveEntries(wallet: string, reason: string) {
    const r = await this.pool.query(
      `UPDATE triggers SET status = 'cancelled', data = data || $2::jsonb, version = version + 1, updated_at = now()
       WHERE wallet = $1 AND kind = 'entry' AND status IN ('armed','confirming','attention')`,
      [wallet.toLowerCase(), JSON.stringify({ status: "cancelled", error: reason })]
    );
    return r.rowCount ?? 0;
  }
  async cancelGroup(wallet: string, groupId: string) {
    const r = await this.pool.query(
      `UPDATE triggers SET status = 'cancelled', data = data || '{"status":"cancelled"}'::jsonb, version = version + 1, updated_at = now()
       WHERE wallet = $1 AND kind = 'entry' AND status IN ('armed','confirming','attention') AND data->>'groupId' = $2`,
      [wallet.toLowerCase(), groupId]
    );
    return r.rowCount ?? 0;
  }

  // ---- keys -------------------------------------------------------------------
  async getKey(wallet: string) {
    const r = await this.pool.query(`SELECT * FROM watcher_keys WHERE wallet = $1`, [wallet.toLowerCase()]);
    return r.rows[0] ? keyFromRow(r.rows[0]) : null;
  }
  async listKeys(statuses?: KeyStatus[]) {
    const r = statuses
      ? await this.pool.query(`SELECT * FROM watcher_keys WHERE status = ANY($1::text[])`, [statuses])
      : await this.pool.query(`SELECT * FROM watcher_keys`);
    return r.rows.map(keyFromRow);
  }
  async putKey(row: KeyRow) {
    await this.pool.query(
      `INSERT INTO watcher_keys (wallet, key_address, key_cipher, kek_id, expiry_s, status, created_at, registered_at, revoked_at, revoke_reason, last_used_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (wallet) DO UPDATE SET
         key_address = EXCLUDED.key_address, key_cipher = EXCLUDED.key_cipher, kek_id = EXCLUDED.kek_id,
         expiry_s = EXCLUDED.expiry_s, status = EXCLUDED.status, created_at = EXCLUDED.created_at,
         registered_at = EXCLUDED.registered_at, revoked_at = EXCLUDED.revoked_at,
         revoke_reason = EXCLUDED.revoke_reason, last_used_at = EXCLUDED.last_used_at`,
      [
        row.wallet.toLowerCase(),
        row.keyAddress.toLowerCase(),
        row.keyCipher,
        row.kekId,
        Math.floor(row.expiryS),
        row.status,
        Math.floor(row.createdAt),
        row.registeredAt == null ? null : Math.floor(row.registeredAt),
        row.revokedAt == null ? null : Math.floor(row.revokedAt),
        row.revokeReason,
        row.lastUsedAt == null ? null : Math.floor(row.lastUsedAt),
      ]
    );
  }
  async setKeyStatus(wallet: string, status: KeyStatus, at: number) {
    await this.pool.query(
      `UPDATE watcher_keys SET status = $2,
         registered_at = CASE WHEN $2 = 'active' THEN COALESCE(registered_at, $3::bigint) ELSE registered_at END
       WHERE wallet = $1`,
      [wallet.toLowerCase(), status, Math.floor(at)]
    );
  }
  async touchKey(wallet: string, at: number) {
    await this.pool.query(`UPDATE watcher_keys SET last_used_at = $2 WHERE wallet = $1`, [wallet.toLowerCase(), Math.floor(at)]);
  }
  async revokeKey(wallet: string, reason: string, at: number) {
    return this.tx(async (c) => {
      const r = await c.query(
        `UPDATE watcher_keys SET status = 'revoked', key_cipher = NULL, revoked_at = $2, revoke_reason = $3
         WHERE wallet = $1 AND status <> 'revoked' RETURNING *`,
        [wallet.toLowerCase(), Math.floor(at), reason]
      );
      await this.cancelAllLiveWith(c, wallet, "key-revoked");
      return r.rows[0] ? keyFromRow(r.rows[0]) : null;
    });
  }
  async createKeyRequest(wallet: string) {
    const r = await this.pool.query(`INSERT INTO key_requests (wallet, created_at) VALUES ($1, $2) RETURNING *`, [wallet.toLowerCase(), Date.now()]);
    return reqFromRow(r.rows[0]);
  }
  async getKeyRequest(id: string) {
    if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
    const r = await this.pool.query(`SELECT * FROM key_requests WHERE id = $1`, [id]);
    return r.rows[0] ? reqFromRow(r.rows[0]) : null;
  }
  async listPendingKeyRequests() {
    // requests older than 30 s are abandoned by their web request; skip them
    const r = await this.pool.query(`SELECT * FROM key_requests WHERE status = 'pending' AND created_at > $1 ORDER BY created_at LIMIT 20`, [Date.now() - 30_000]);
    return r.rows.map(reqFromRow);
  }
  async finishKeyRequest(id: string, result: { keyAddress: string } | { error: string }) {
    if ("keyAddress" in result)
      await this.pool.query(`UPDATE key_requests SET status = 'done', key_address = $2 WHERE id = $1`, [id, result.keyAddress.toLowerCase()]);
    else await this.pool.query(`UPDATE key_requests SET status = 'failed', error = $2 WHERE id = $1`, [id, result.error.slice(0, 200)]);
  }

  // ---- nonces -----------------------------------------------------------------
  async nextNonce(wallet: string, nowMs: number) {
    const r = await this.pool.query<{ last_nonce: string }>(
      `INSERT INTO watcher_nonces (wallet, last_nonce) VALUES ($1, $2::numeric)
       ON CONFLICT (wallet) DO UPDATE SET last_nonce = GREATEST(watcher_nonces.last_nonce + 1, EXCLUDED.last_nonce)
       RETURNING last_nonce::text`,
      [wallet.toLowerCase(), String(Math.floor(nowMs))]
    );
    return BigInt(r.rows[0].last_nonce);
  }

  // ---- kill -------------------------------------------------------------------
  async getKill(): Promise<KillState | null> {
    const r = await this.pool.query<{ value: KillState }>(`SELECT value FROM watcher_settings WHERE key = 'kill'`);
    return r.rows[0]?.value ?? null;
  }
  async setKill(state: KillState) {
    await this.pool.query(
      `INSERT INTO watcher_settings (key, value) VALUES ('kill', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [JSON.stringify(state)]
    );
  }

  // ---- lease + heartbeat (DB clock, so host clock skew can't steal a lease) ----
  async acquireLease(name: string, holder: string, ttlMs: number) {
    const r = await this.pool.query(
      `INSERT INTO watcher_leases (name, holder, until_ms)
       VALUES ($1, $2, (extract(epoch from now()) * 1000)::bigint + $3)
       ON CONFLICT (name) DO UPDATE SET holder = EXCLUDED.holder, until_ms = EXCLUDED.until_ms
         WHERE watcher_leases.holder = EXCLUDED.holder
            OR watcher_leases.until_ms < (extract(epoch from now()) * 1000)::bigint
       RETURNING holder`,
      [name, holder, Math.floor(ttlMs)]
    );
    return (r.rowCount ?? 0) === 1;
  }
  async releaseLease(name: string, holder: string) {
    await this.pool.query(`DELETE FROM watcher_leases WHERE name = $1 AND holder = $2`, [name, holder]);
  }
  async putHeartbeat(hb: Heartbeat) {
    await this.pool.query(
      `INSERT INTO watcher_settings (key, value) VALUES ('heartbeat', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [JSON.stringify(hb)]
    );
  }
  async getHeartbeat(): Promise<Heartbeat | null> {
    const r = await this.pool.query<{ value: Heartbeat }>(`SELECT value FROM watcher_settings WHERE key = 'heartbeat'`);
    return r.rows[0]?.value ?? null;
  }

  // ---- audit ------------------------------------------------------------------
  async audit(ev: AuditEvent) {
    await this.pool.query(`INSERT INTO watcher_audit (at, wallet, trigger_id, event, detail) VALUES ($1,$2,$3,$4,$5)`, [
      Math.floor(ev.at),
      ev.wallet?.toLowerCase() ?? null,
      ev.triggerId,
      ev.event,
      JSON.stringify(ev.detail ?? {}),
    ]);
  }
  async listAudit(limit: number) {
    const r = await this.pool.query(`SELECT at, wallet, trigger_id, event, detail FROM watcher_audit ORDER BY id DESC LIMIT $1`, [Math.min(500, Math.max(1, limit))]);
    return r.rows.map((x) => ({ at: Number(x.at), wallet: x.wallet, triggerId: x.trigger_id, event: x.event, detail: x.detail ?? {} }));
  }
  async countSignatures(wallet: string | null, sinceMs: number) {
    const r = wallet
      ? await this.pool.query<{ c: string }>(`SELECT count(*)::text AS c FROM watcher_audit WHERE event = 'sign' AND at >= $1 AND wallet = $2`, [Math.floor(sinceMs), wallet.toLowerCase()])
      : await this.pool.query<{ c: string }>(`SELECT count(*)::text AS c FROM watcher_audit WHERE event = 'sign' AND at >= $1`, [Math.floor(sinceMs)]);
    return Number(r.rows[0]?.c ?? 0);
  }
  async countEvents(wallet: string, event: string, sinceMs: number) {
    const r = await this.pool.query<{ c: string }>(`SELECT count(*)::text AS c FROM watcher_audit WHERE event = $1 AND at >= $2 AND wallet = $3`, [
      event,
      Math.floor(sinceMs),
      wallet.toLowerCase(),
    ]);
    return Number(r.rows[0]?.c ?? 0);
  }

  // ---- auth nonces -------------------------------------------------------------
  async putAuthNonce(nonce: string, payload: string, expiresAt: number) {
    await this.pool.query(`INSERT INTO auth_nonces (nonce, address, expires_at) VALUES ($1,$2,$3)`, [nonce, payload, Math.floor(expiresAt)]);
    // opportunistic cleanup
    if (Math.random() < 0.05) await this.pool.query(`DELETE FROM auth_nonces WHERE expires_at < $1`, [Date.now()]);
  }
  async consumeAuthNonce(nonce: string, nowMs: number) {
    const r = await this.pool.query<{ address: string; expires_at: string }>(`DELETE FROM auth_nonces WHERE nonce = $1 RETURNING address, expires_at`, [nonce]);
    const row = r.rows[0];
    return row && Number(row.expires_at) > nowMs ? row.address : null;
  }

  async ping() {
    try {
      await this.pool.query("SELECT 1");
      return true;
    } catch {
      return false;
    }
  }
}
