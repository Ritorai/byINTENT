// Postgres pool factory shared by the web process and the watcher.

import pg from "pg";

export function createPool(url: string, max = 4): pg.Pool {
  const ssl =
    process.env.PGSSL === "0"
      ? false
      : /sslmode=require|\.proxy\.rlwy\.net|amazonaws|neon\.tech|supabase/.test(url)
        ? { rejectUnauthorized: false }
        : false;
  const pool = new pg.Pool({ connectionString: url, ssl, max, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 5_000 });
  pool.on("error", (e) => console.warn("[pg] pool error", e.message));
  return pool;
}
