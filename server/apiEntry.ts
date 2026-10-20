// Entry point bundled to server-dist/api.mjs and imported by server.mjs.
//
//   const { attachTriggerApi } = await import("./server-dist/api.mjs");
//   await attachTriggerApi(app, { isAdmin });
//
// Mounts /api (+ /admin/watcher) when DATABASE_URL and AUTH_SECRET are set.
// With WATCHER_MODE=inline it also runs the engine in this process (dev / single
// service deployments) — that requires KEY_KEK here, which the SPEC advises
// against for production.

import type { Express, Request } from "express";
import { mountTriggerApi } from "./api";
import { createPool } from "./db";
import { readEnv } from "./env";
import { log } from "./log";
import { PgRepo } from "./repoPg";
import { startWatcher, type WatcherHandle } from "./runtime";

export interface AttachOptions {
  isAdmin: (req: Request) => string | null;
}

export interface AttachResult {
  enabled: boolean;
  inline: boolean;
  stop: () => Promise<void>;
}

export async function attachTriggerApi(app: Express, opts: AttachOptions): Promise<AttachResult> {
  const env = readEnv();
  if (!env.databaseUrl) {
    log.api("DATABASE_URL missing — trigger API not mounted");
    return { enabled: false, inline: false, stop: async () => {} };
  }
  const pool = createPool(env.databaseUrl, 6);
  const repo = new PgRepo(pool);
  await repo.migrate();
  mountTriggerApi(app, { repo, env, isAdmin: opts.isAdmin });
  log.api(`trigger API mounted at /api (auth ${env.authSecret ? "on" : "DISABLED: AUTH_SECRET missing"})`);

  let watcher: WatcherHandle | null = null;
  if (env.watcherMode === "inline") {
    if (!env.keyKek) log.api("WATCHER_MODE=inline but KEY_KEK missing — engine not started");
    else {
      watcher = startWatcher(repo, env);
      log.api("inline watcher running in the web process (dev mode)");
    }
  }

  return {
    enabled: true,
    inline: !!watcher,
    stop: async () => {
      await watcher?.stop();
      await pool.end().catch(() => {});
    },
  };
}
