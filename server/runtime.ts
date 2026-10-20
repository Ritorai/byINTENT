// Wires repo + feeds + signer + engine into a running watcher with a leader
// lease and heartbeat (SPEC.md §7). Used by watcher.ts (own process) and by
// apiEntry.ts (WATCHER_MODE=inline).

import { hostname } from "node:os";
import { MARKETS } from "../shared/markets";
import { loadKek } from "./crypto";
import { Engine } from "./engine";
import type { Env } from "./env";
import { log } from "./log";
import { PriceFeeds } from "./priceFeed";
import { RelayerClient } from "./relayer";
import type { Repo } from "./repo";
import { Signer } from "./signer";
import { WalletWatch } from "./walletWatch";

export const LEASE_NAME = "engine";
export const LEASE_TTL_MS = 10_000;
const LEASE_RENEW_MS = 2_000;
const HEARTBEAT_MS = 2_000;

export interface WatcherHandle {
  holder: string;
  isLeader: () => boolean;
  engine: Engine;
  stop: () => Promise<void>;
}

export function startWatcher(repo: Repo, env: Env, opts: { now?: () => number } = {}): WatcherHandle {
  if (!env.keyKek) throw new Error("KEY_KEK missing — the watcher cannot start without its key-encryption key");
  const now = opts.now ?? Date.now;
  const holder = `${hostname()}:${process.pid}:${Math.random().toString(36).slice(2, 8)}`;
  let leader = false;
  let leaderSince = 0;
  const isLeader = () => leader;

  const relayer = new RelayerClient(env.exchangeUrl);
  const feeds = new PriceFeeds(env.exchangeUrl, env.priceMs, fetch, now);
  const wallets = new WalletWatch(env.exchangeUrl, fetch, now);
  const signer = new Signer({
    repo,
    relayer,
    kek: loadKek(env.keyKek),
    kekPrev: env.keyKekPrev ? loadKek(env.keyKekPrev) : null,
    isLeader,
    envKill: () => env.envKill,
    limits: { walletFiresPerHour: env.breakerWalletFiresPerHour, globalFiresPerMin: env.breakerGlobalFiresPerMin },
    now,
  });
  const engine = new Engine({
    repo,
    feeds,
    wallets,
    signer,
    relayer,
    instruments: new Set(Object.values(MARKETS).map((m) => m.id)),
    envKill: () => env.envKill,
    now,
    holder,
    isLeader,
  });
  engine.keyTtlDays = env.keyTtlDays;

  let stopped = false;
  let passing = false;

  // ---- lease -----------------------------------------------------------------------
  const renewLease = async () => {
    try {
      const got = await repo.acquireLease(LEASE_NAME, holder, LEASE_TTL_MS, now());
      if (got && !leader) {
        leaderSince = now();
        log.info(`leader acquired (${holder})`);
      } else if (!got && leader) {
        log.warn("leader lost — standing by");
      }
      leader = got;
    } catch (e) {
      // DB unreachable: assume the lease is gone. The engine stops signing
      // immediately (signer re-checks isLeader) even though the row may still
      // name us; a stale row is safer than two leaders.
      if (leader) log.warn("lease renew failed — dropping leadership:", e instanceof Error ? e.message : String(e));
      leader = false;
    }
  };

  // ---- heartbeat (leader only; standbys stay silent so the UI reflects the engine) ----
  const beat = async () => {
    if (!leader) return;
    const feedsAge: Record<string, number> = {};
    for (const s of feeds.statuses()) feedsAge[String(s.instrumentId)] = Math.round(Number.isFinite(s.ageMs) ? s.ageMs : -1);
    try {
      await repo.putHeartbeat({ holder, at: now(), feeds: feedsAge, leader });
    } catch (e) {
      log.warn("heartbeat failed:", e instanceof Error ? e.message : String(e));
    }
  };

  // ---- engine loop -------------------------------------------------------------------
  const tick = async () => {
    if (stopped || passing || !leader) return;
    passing = true;
    try {
      await engine.pass();
    } catch (e) {
      log.error("engine pass failed:", e instanceof Error ? e.stack ?? e.message : String(e));
    } finally {
      passing = false;
    }
  };

  const timers: ReturnType<typeof setInterval>[] = [];
  void renewLease().then(beat);
  timers.push(setInterval(() => void renewLease(), LEASE_RENEW_MS));
  timers.push(setInterval(() => void beat(), HEARTBEAT_MS));
  timers.push(setInterval(() => void tick(), env.tickMs));
  for (const t of timers) t.unref?.();

  log.info(`watcher started holder=${holder} tick=${env.tickMs}ms price=${env.priceMs}ms kill=${env.envKill ? "ON" : "off"} ttl=${env.keyTtlDays}d`);

  const stop = async () => {
    if (stopped) return;
    stopped = true;
    for (const t of timers) clearInterval(t);
    // let an in-flight pass finish so no fire is left half-settled
    const until = Date.now() + 8_000;
    while (passing && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
    feeds.stopAll();
    wallets.stopAll();
    if (leader) {
      leader = false;
      try {
        await repo.releaseLease(LEASE_NAME, holder);
      } catch {
        /* lease expires on its own */
      }
    }
    log.info(`watcher stopped (${holder}, led for ${leaderSince ? Math.round((now() - leaderSince) / 1000) : 0}s)`);
  };

  return { holder, isLeader, engine, stop };
}
