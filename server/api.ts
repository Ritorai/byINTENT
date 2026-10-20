// Trigger API mounted into server.mjs (SPEC.md §4–5). Express router; the
// body parser is the app-level express.json({limit: "64kb"}).
//
// Every authed route derives the wallet from the cookie. Request bodies
// never name a wallet. Every mutation needs a same-origin witness and a
// JSON content type. All inputs pass the shared validators before they
// become rows the engine will trust.

import { randomUUID } from "node:crypto";
import type { Express, NextFunction, Request, Response } from "express";
import { Router } from "express";
import { MARKETS } from "../shared/markets";
import {
  ADDRESS_RE,
  MAX_LIVE_TRIGGERS_PER_WALLET,
  attachedStopProblem,
  attachedTpProblem,
  exitOf,
  validateArmEntrySpec,
  validateArmStopSpec,
  validateAttachedStop,
  validateAttachedTp,
  type StopLoss,
  type TriggerEntry,
} from "../shared/triggerLogic";
import {
  RateLimiter,
  SESSION_TTL_MS,
  clearSessionCookie,
  clientIp,
  issueChallenge,
  readSession,
  sameOrigin,
  setSessionCookie,
  signSessionCookie,
  verifyChallenge,
} from "./auth";
import type { Env } from "./env";
import { log } from "./log";
import type { KeyRow, Repo, TriggerRecord } from "./repo";

export interface ApiDeps {
  repo: Repo;
  env: Env;
  /** server.mjs's admin-cookie reader: admin wallet or null */
  isAdmin: (req: Request) => string | null;
  now?: () => number;
}

const INSTRUMENTS: ReadonlySet<number> = new Set(Object.values(MARKETS).map((m) => m.id));
const HEARTBEAT_ALIVE_MS = 10_000;
const KEY_REQUEST_WAIT_MS = 6_000;
const KEY_REQUEST_POLL_MS = 250;

type Authed = Request & { wallet: string };

const err = (res: Response, status: number, code: string, message?: string) =>
  res.status(status).set("cache-control", "no-store").json({ error: code, ...(message ? { message } : {}) });

function publicKey(k: KeyRow | null) {
  if (!k) return null;
  return { address: k.keyAddress, status: k.status, expiresAt: k.expiryS * 1000, registeredAt: k.registeredAt, revokedAt: k.revokedAt, revokeReason: k.revokeReason };
}

/** strip server-only fields before a record goes to the browser */
function publicRecord(r: TriggerRecord): TriggerEntry | StopLoss {
  const { version: _v, kind: _k, ...rest } = r as TriggerRecord & { version: number };
  return rest as TriggerEntry | StopLoss;
}

export function mountTriggerApi(app: Express, deps: ApiDeps): void {
  const { repo, env } = deps;
  const now = deps.now ?? Date.now;
  const secret = env.authSecret;
  const r = Router();

  r.use((_req, res, next) => {
    res.set("cache-control", "no-store");
    next();
  });

  if (!secret) {
    log.api("AUTH_SECRET missing or shorter than 32 chars — /api is disabled (503)");
    r.use((_req, res) => err(res, 503, "api_disabled", "AUTH_SECRET is not configured."));
    app.use("/api", r);
    return;
  }

  // ---- limits ------------------------------------------------------------------
  const authIp = new RateLimiter(10, 60_000, now);
  const readW = new RateLimiter(240, 60_000, now);
  const writeW = new RateLimiter(60, 60_000, now);
  const keyW = new RateLimiter(3, 60_000, now);
  const limited = (lim: RateLimiter, key: (req: Request) => string) => (req: Request, res: Response, next: NextFunction) =>
    lim.take(key(req)) ? next() : err(res, 429, "rate_limited");

  // ---- guards ------------------------------------------------------------------
  const requireAuth = (req: Request, res: Response, next: NextFunction) => {
    const wallet = readSession(req, secret, now());
    if (!wallet) return err(res, 401, "unauthorized");
    (req as Authed).wallet = wallet;
    next();
  };
  const requireMutation = (req: Request, res: Response, next: NextFunction) => {
    if (!sameOrigin(req, env.allowedOrigins)) return err(res, 403, "bad_origin");
    if (!/^application\/json\b/i.test(String(req.headers["content-type"] ?? ""))) return err(res, 415, "json_required");
    next();
  };
  const wallet = (req: Request) => (req as Authed).wallet;

  // ---- auth ----------------------------------------------------------------------
  r.post("/auth/challenge", limited(authIp, clientIp), requireMutation, async (req, res) => {
    const address = String(req.body?.address ?? "").toLowerCase();
    if (!ADDRESS_RE.test(address)) return err(res, 400, "bad_address");
    const c = await issueChallenge(repo, address, now());
    res.json(c);
  });

  r.post("/auth/verify", limited(authIp, clientIp), requireMutation, async (req, res) => {
    const address = String(req.body?.address ?? "").toLowerCase();
    const nonce = String(req.body?.nonce ?? "");
    const signature = String(req.body?.signature ?? "");
    if (!ADDRESS_RE.test(address)) return err(res, 400, "bad_address");
    const ok = await verifyChallenge(repo, address, nonce, signature, now());
    if (!ok) return err(res, 401, "bad_signature");
    const exp = now() + SESSION_TTL_MS;
    setSessionCookie(req, res, signSessionCookie(secret, address, exp), Math.floor(SESSION_TTL_MS / 1000));
    res.json({ wallet: address, expiresAt: exp });
  });

  r.post("/auth/logout", requireMutation, (req, res) => {
    clearSessionCookie(req, res);
    res.json({ ok: true });
  });

  // ---- me --------------------------------------------------------------------------
  r.get("/me", requireAuth, limited(readW, wallet), async (req, res) => {
    const w = wallet(req);
    const [key, hb, kill, settings] = await Promise.all([repo.getKey(w), repo.getHeartbeat(), repo.getKill(), repo.getWalletSettings(w)]);
    res.json({
      wallet: w,
      key: publicKey(key),
      enabled: settings.enabled,
      watcher: hb ? { alive: now() - hb.at < HEARTBEAT_ALIVE_MS, lastBeatAt: hb.at, feeds: hb.feeds, leader: hb.leader } : { alive: false, lastBeatAt: null, feeds: {}, leader: false },
      kill: kill?.on || env.envKill ? { on: true, reason: kill?.reason ?? "env", at: kill?.at ?? null } : null,
    });
  });

  // ---- watcher key -------------------------------------------------------------------
  r.post("/watcher/key", requireAuth, requireMutation, limited(keyW, wallet), async (req, res) => {
    const w = wallet(req);
    const existing = await repo.getKey(w);
    if (existing && (existing.status === "pending" || existing.status === "active"))
      return res.json({ keyAddress: existing.keyAddress, expiryS: existing.expiryS, status: existing.status });
    // the watcher generates (SPEC §3): queue a request and wait for it
    const request = await repo.createKeyRequest(w);
    const deadline = now() + KEY_REQUEST_WAIT_MS;
    while (now() < deadline) {
      await new Promise((r) => setTimeout(r, KEY_REQUEST_POLL_MS));
      const kr = await repo.getKeyRequest(request.id);
      if (!kr) break;
      if (kr.status === "failed") return err(res, 500, "key_generation_failed");
      if (kr.status === "done") {
        const k = await repo.getKey(w);
        if (!k || k.keyAddress !== kr.keyAddress) return err(res, 500, "key_mismatch");
        return res.json({ keyAddress: k.keyAddress, expiryS: k.expiryS, status: k.status });
      }
    }
    return err(res, 503, "watcher_unavailable", "The watcher did not answer. Server-side triggers are offline right now.");
  });

  r.post("/watcher/key/registered", requireAuth, requireMutation, limited(writeW, wallet), async (req, res) => {
    const w = wallet(req);
    const intentId = typeof req.body?.intentId === "string" && /^0x[0-9a-fA-F]{1,128}$/.test(req.body.intentId) ? req.body.intentId : null;
    await repo.audit({ at: now(), wallet: w, triggerId: null, event: "key.register-submitted", detail: { intentId } });
    res.json({ ok: true });
  });

  r.post("/watcher/key/revoke", requireAuth, requireMutation, limited(writeW, wallet), async (req, res) => {
    const w = wallet(req);
    const k = await repo.revokeKey(w, "user", now());
    if (!k) {
      const cur = await repo.getKey(w);
      if (cur?.status === "revoked") return res.json({ keyAddress: cur.keyAddress, already: true }); // idempotent
      return err(res, 404, "no_key");
    }
    await repo.audit({ at: now(), wallet: w, triggerId: null, event: "key.revoked", detail: { reason: "user", keyAddress: k.keyAddress } });
    log.api(`key revoked by user for ${w.slice(0, 10)}…`);
    res.json({ keyAddress: k.keyAddress });
  });

  // ---- triggers ------------------------------------------------------------------------
  r.get("/triggers", requireAuth, limited(readW, wallet), async (req, res) => {
    const w = wallet(req);
    const [rows, settings] = await Promise.all([repo.listTriggersForWallet(w, 50), repo.getWalletSettings(w)]);
    const entries: TriggerEntry[] = [];
    const stops: StopLoss[] = [];
    for (const row of rows) (row.kind === "entry" ? entries : (stops as unknown[])).push(publicRecord(row) as never);
    // a cheap change token so the client can skip re-rendering identical state
    const version = rows.map((x) => `${x.id}:${x.status}:${x.version}`).join("|");
    res.json({ version, enabled: settings.enabled, entries, stops });
  });

  const requireActiveKey = async (w: string, res: Response): Promise<boolean> => {
    const k = await repo.getKey(w);
    if (!k || k.status !== "active") {
      err(res, 409, "no_active_key", "Enable server-side triggers first (one wallet signature).");
      return false;
    }
    if (k.expiryS * 1000 <= now()) {
      err(res, 409, "key_expired", "Your watcher key has expired. Renew it (one wallet signature).");
      return false;
    }
    return true;
  };

  r.post("/triggers/entry", requireAuth, requireMutation, limited(writeW, wallet), async (req, res) => {
    const w = wallet(req);
    const spec = validateArmEntrySpec(req.body, INSTRUMENTS);
    if (!spec) return err(res, 400, "bad_spec");
    // arm-time rules beyond the shape check: no debt-funded triggers (the watcher
    // only ever spends available collateral), and an expiry must lie in the future
    if (spec.useDebt) return err(res, 400, "bad_spec", "useDebt is not supported for triggers.");
    if (spec.expiresAt != null && spec.expiresAt <= now() + 30_000) return err(res, 400, "bad_spec", "expiresAt is in the past.");
    if (!(await requireActiveKey(w, res))) return;
    if ((await repo.countLiveTriggers(w)) >= MAX_LIVE_TRIGGERS_PER_WALLET) return err(res, 409, "too_many_triggers");
    const rec: TriggerRecord = {
      kind: "entry",
      version: 1,
      id: randomUUID(),
      wallet: w,
      ...spec,
      status: "armed",
      createdAt: now(),
      confirmingSince: null,
      crossSampleTs: null,
    };
    await repo.insertTrigger(rec);
    await repo.audit({ at: now(), wallet: w, triggerId: rec.id, event: "arm.entry", detail: { instrumentId: spec.instrumentId, isLong: spec.isLong, marginUsdc: spec.marginUsdc, leverage: spec.leverage, triggerPrice: spec.triggerPrice, cross: spec.cross, attachedStop: spec.attachedStop ?? null, attachedTp: spec.attachedTp ?? null } });
    res.status(201).json(publicRecord(rec));
  });

  /**
   * set / replace / clear the exit a waiting entry will spawn when it fills —
   * body `{ stop: AttachedStop | null, which?: "stop" | "tp" }` (default stop)
   */
  r.post("/triggers/:id/stop", requireAuth, requireMutation, limited(writeW, wallet), async (req, res) => {
    if (!idOk(req.params.id)) return err(res, 400, "bad_id");
    const w = wallet(req);
    const which = req.body?.which;
    if (!(which === undefined || which === "stop" || which === "tp")) return err(res, 400, "bad_spec");
    const isTp = which === "tp";
    const stop = isTp ? validateAttachedTp(req.body?.stop) : validateAttachedStop(req.body?.stop);
    if (stop === undefined) return err(res, 400, "bad_spec");
    const cur = await repo.getTrigger(w, req.params.id);
    if (!cur || cur.kind !== "entry") return err(res, 404, "not_found");
    if (stop && isTp) {
      if (attachedTpProblem(stop, cur)) return err(res, 400, "bad_spec", "The take-profit must sit on the profit side of the trigger price.");
    } else if (stop) {
      const problem = attachedStopProblem(stop, cur);
      if (problem) return err(res, 400, "bad_spec", problem === "wrong-side" ? "The stop must sit on the loss side of the trigger price." : "The stop would already be past the bust price.");
    }
    const row = await repo.setAttachedStop(w, cur.id, stop, isTp ? "tp" : "stop");
    if (!row) return err(res, 404, "not_waiting");
    await repo.audit({
      at: now(),
      wallet: w,
      triggerId: row.id,
      event: isTp ? (stop ? "entry.tp.set" : "entry.tp.clear") : stop ? "entry.stop.set" : "entry.stop.clear",
      detail: isTp ? { attachedTp: stop } : { attachedStop: stop },
    });
    res.json(publicRecord(row));
  });

  r.post("/triggers/stop", requireAuth, requireMutation, limited(writeW, wallet), async (req, res) => {
    const w = wallet(req);
    const spec = validateArmStopSpec(req.body, INSTRUMENTS);
    if (!spec) return err(res, 400, "bad_spec");
    if (!(await requireActiveKey(w, res))) return;
    // one live stop and one live take-profit per position: replacing an existing one must not be blocked by the cap
    const exit = exitOf(spec);
    const rows = await repo.listTriggersForWallet(w, 0);
    const replacing = rows.filter((r) => r.kind === "stop" && r.positionId === spec.positionId && exitOf(r) === exit && (r.status === "armed" || r.status === "confirming")).length;
    if ((await repo.countLiveTriggers(w)) - replacing >= MAX_LIVE_TRIGGERS_PER_WALLET) return err(res, 409, "too_many_triggers");
    await repo.supersedeLiveStops(w, spec.positionId, exit);
    const rec: TriggerRecord = {
      kind: "stop",
      version: 1,
      id: randomUUID(),
      wallet: w,
      ...spec,
      status: "armed",
      createdAt: now(),
      confirmingSince: null,
      crossSampleTs: null,
      absentEvals: 0,
    };
    await repo.insertTrigger(rec);
    await repo.audit({ at: now(), wallet: w, triggerId: rec.id, event: "arm.stop", detail: { positionId: spec.positionId, instrumentId: spec.instrumentId, isLong: spec.isLong, stopPrice: spec.stopPrice, exit } });
    res.status(201).json(publicRecord(rec));
  });

  const idOk = (id: unknown): id is string => typeof id === "string" && /^[0-9a-f-]{36}$/i.test(id);

  r.post("/triggers/:id/cancel", requireAuth, requireMutation, limited(writeW, wallet), async (req, res) => {
    if (!idOk(req.params.id)) return err(res, 400, "bad_id");
    const row = await repo.cancelTrigger(wallet(req), req.params.id);
    if (!row) return err(res, 404, "not_cancellable");
    await repo.audit({ at: now(), wallet: wallet(req), triggerId: row.id, event: "cancel", detail: {} });
    res.json(publicRecord(row));
  });

  r.post("/triggers/:id/rearm", requireAuth, requireMutation, limited(writeW, wallet), async (req, res) => {
    if (!idOk(req.params.id)) return err(res, 400, "bad_id");
    if (!(await requireActiveKey(wallet(req), res))) return;
    const row = await repo.rearmTrigger(wallet(req), req.params.id);
    if (!row) return err(res, 404, "not_rearmable");
    await repo.audit({ at: now(), wallet: wallet(req), triggerId: row.id, event: "rearm", detail: {} });
    res.json(publicRecord(row));
  });

  r.post("/triggers/:id/cancel-queued", requireAuth, requireMutation, limited(writeW, wallet), async (req, res) => {
    if (!idOk(req.params.id)) return err(res, 400, "bad_id");
    const row = await repo.requestCancelQueued(wallet(req), req.params.id);
    if (!row) return err(res, 404, "not_queued");
    res.json(publicRecord(row));
  });

  r.post("/triggers/enabled", requireAuth, requireMutation, limited(writeW, wallet), async (req, res) => {
    if (typeof req.body?.enabled !== "boolean") return err(res, 400, "bad_spec");
    await repo.setWalletEnabled(wallet(req), req.body.enabled);
    await repo.audit({ at: now(), wallet: wallet(req), triggerId: null, event: req.body.enabled ? "wallet.enabled" : "wallet.disabled", detail: {} });
    res.json({ enabled: req.body.enabled });
  });

  r.use((_req, res) => err(res, 404, "not_found"));
  // a thrown error must never leak internals
  r.use((e: unknown, _req: Request, res: Response, _next: NextFunction) => {
    log.api("unhandled:", e instanceof Error ? e.message : String(e));
    err(res, 500, "internal");
  });

  app.use("/api", r);

  // ---- admin (reuses server.mjs's admin cookie) ----------------------------------------
  app.get("/admin/watcher", async (req, res) => {
    res.set("cache-control", "no-store");
    if (!deps.isAdmin(req)) return err(res, 401, "unauthorized");
    const [hb, kill, audit, active, keys] = await Promise.all([repo.getHeartbeat(), repo.getKill(), repo.listAudit(100), repo.listActiveTriggers(), repo.listKeys()]);
    res.json({
      watcher: hb ? { ...hb, alive: now() - hb.at < HEARTBEAT_ALIVE_MS } : null,
      kill: kill ?? null,
      envKill: env.envKill,
      active: active.map((t) => ({ id: t.id, wallet: t.wallet, kind: t.kind, status: t.status, instrumentId: t.instrumentId, createdAt: t.createdAt })),
      keys: keys.map((k) => ({ wallet: k.wallet, status: k.status, keyAddress: k.keyAddress, expiresAt: k.expiryS * 1000, lastUsedAt: k.lastUsedAt })),
      audit,
    });
  });

  app.post("/admin/watcher/kill", async (req, res) => {
    res.set("cache-control", "no-store");
    const admin = deps.isAdmin(req);
    if (!admin) return err(res, 401, "unauthorized");
    if (!sameOrigin(req, env.allowedOrigins)) return err(res, 403, "bad_origin");
    const on = req.body?.on === true;
    const reason = String(req.body?.reason ?? (on ? "admin" : "")).slice(0, 200);
    await repo.setKill({ on, reason, at: now() });
    await repo.audit({ at: now(), wallet: admin, triggerId: null, event: on ? "kill.on" : "kill.off", detail: { reason } });
    log.api(`KILL ${on ? "ON" : "OFF"} by ${admin.slice(0, 10)}… (${reason})`);
    res.json({ on, reason });
  });
}
