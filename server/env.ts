// Environment for the watcher / trigger API. Everything is read once, here.
// SPEC.md §10 lists what each process needs.

const flag = (v: string | undefined, dflt = false): boolean =>
  v == null || v === "" ? dflt : /^(1|true|yes|on)$/i.test(v.trim());

const int = (v: string | undefined, dflt: number, min: number, max: number): number => {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, Math.floor(n)));
};

const HEX32 = /^(0x)?[0-9a-fA-F]{64}$/;

export interface Env {
  databaseUrl: string | null;
  authSecret: string | null;
  /** 32-byte key-encryption key (hex) — the watcher's only secret */
  keyKek: string | null;
  keyKekPrev: string | null;
  watcherMode: "off" | "inline";
  envKill: boolean;
  keyTtlDays: number;
  breakerWalletFiresPerHour: number;
  breakerGlobalFiresPerMin: number;
  /** engine pass interval */
  tickMs: number;
  /** price poll interval per instrument */
  priceMs: number;
  exchangeUrl: string;
  /** which Origin values are acceptable on mutating API calls (comma-separated; empty = same-host only) */
  allowedOrigins: string[];
  nodeEnv: string;
}

export function readEnv(e: NodeJS.ProcessEnv = process.env): Env {
  const kek = (e.KEY_KEK ?? "").trim();
  const kekPrev = (e.KEY_KEK_PREV ?? "").trim();
  return {
    databaseUrl: e.DATABASE_URL?.trim() || null,
    authSecret: e.AUTH_SECRET && e.AUTH_SECRET.trim().length >= 32 ? e.AUTH_SECRET.trim() : null,
    keyKek: HEX32.test(kek) ? kek.replace(/^0x/, "") : null,
    keyKekPrev: HEX32.test(kekPrev) ? kekPrev.replace(/^0x/, "") : null,
    watcherMode: (e.WATCHER_MODE ?? "off").trim().toLowerCase() === "inline" ? "inline" : "off",
    envKill: flag(e.WATCHER_KILL),
    keyTtlDays: int(e.WATCHER_KEY_TTL_DAYS, 30, 1, 30),
    breakerWalletFiresPerHour: int(e.BREAKER_WALLET_FIRES_PER_HOUR, 20, 1, 10_000),
    breakerGlobalFiresPerMin: int(e.BREAKER_GLOBAL_FIRES_PER_MIN, 60, 1, 100_000),
    tickMs: int(e.WATCHER_TICK_MS, 500, 200, 5000),
    priceMs: int(e.WATCHER_PRICE_MS, 400, 200, 5000),
    exchangeUrl: (e.EXCHANGE_URL ?? "https://exchange.papertrade.xyz").replace(/\/$/, ""),
    allowedOrigins: (e.API_ALLOWED_ORIGINS ?? "")
      .split(/[,\s]+/)
      .map((s) => s.trim().toLowerCase().replace(/\/$/, ""))
      .filter(Boolean),
    nodeEnv: e.NODE_ENV ?? "production",
  };
}
