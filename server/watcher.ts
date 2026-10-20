// Standalone watcher process (Railway service `watcher`; no inbound port).
//   node server-dist/watcher.mjs
// Needs DATABASE_URL + KEY_KEK. Never gets AUTH_SECRET.

import { createPool } from "./db";
import { readEnv } from "./env";
import { log } from "./log";
import { PgRepo } from "./repoPg";
import { startWatcher } from "./runtime";

async function main() {
  const env = readEnv();
  if (!env.databaseUrl) throw new Error("DATABASE_URL missing");
  if (!env.keyKek) throw new Error("KEY_KEK missing or not 64 hex chars");
  if (process.env.AUTH_SECRET) log.warn("AUTH_SECRET is set on the watcher — it does not need it; remove it to keep the processes separated");

  const pool = createPool(env.databaseUrl, 4);
  const repo = new PgRepo(pool);
  await repo.migrate();
  if (!(await repo.ping())) throw new Error("database ping failed");

  const handle = startWatcher(repo, env);

  let shuttingDown = false;
  const shutdown = async (sig: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`${sig} — shutting down`);
    const force = setTimeout(() => process.exit(1), 12_000);
    force.unref();
    await handle.stop();
    await pool.end().catch(() => {});
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("unhandledRejection", (e) => log.error("unhandledRejection:", e instanceof Error ? e.stack ?? e.message : String(e)));
  process.on("uncaughtException", (e) => {
    log.error("uncaughtException:", e.stack ?? e.message);
    void shutdown("uncaughtException");
  });
}

main().catch((e) => {
  log.error("fatal:", e instanceof Error ? e.message : String(e));
  process.exit(1);
});
