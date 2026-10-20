// Production server: serves the built app and proxies /pt/* to papertrade.xyz.
// The proxy exists because papertrade's edge rejects browser requests that carry
// a foreign Origin header; server-to-server requests are fine.
//
// Password gate (Railway → Variables):
//   PW_GATED=1 (default)  every request — page, assets, /pt proxy — needs a cookie that
//                         only the gate form hands out; SITE_PASSWORD is required, and if
//                         it's missing the server serves nothing but a "locked" notice.
//   PW_GATED=0            public launch: no password, SITE_PASSWORD is ignored.
// MAINTENANCE=1 overrides both (see below).
import express from "express";
import { createHmac, timingSafeEqual } from "node:crypto";
import path from "node:path";
import { Readable, pipeline } from "node:stream";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { recoverMessageAddress } from "viem";

const { Pool } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPSTREAM = "https://exchange.papertrade.xyz";
const app = express();

app.use(express.json({ limit: "64kb" }));

// ---- password gate ----
// gated unless PW_GATED is explicitly "0"/"false"/"off" — missing means gated
const PW_GATED = !/^(0|false|no|off)$/i.test((process.env.PW_GATED ?? "1").trim());
const GATE_PASSWORD = process.env.SITE_PASSWORD || "";
const GATE_COOKIE = "bi_gate";
const GATE_MAX_AGE = 60 * 60 * 24 * 30; // 30 days
// the cookie value is an HMAC of the password; changing the password logs everyone out
const gateToken = () =>
  createHmac("sha256", process.env.GATE_SECRET || `byintent:${GATE_PASSWORD}`).update(GATE_PASSWORD).digest("hex");
const safeEqual = (a, b) => {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && timingSafeEqual(ba, bb);
};
const readCookie = (header, name) => {
  if (!header) return "";
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return "";
};
const stripCookie = (header, name) =>
  header
    .split(";")
    .filter((p) => p.split("=")[0].trim() !== name)
    .join(";")
    .trim();
const isHttps = (req) => req.secure || req.headers["x-forwarded-proto"] === "https";
const gatePage = (error) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>byINTENT</title><link rel="icon" href="/favicon.svg">
<style>
  html,body{height:100%;margin:0;background:#0b0d10;color:#e6e9ef;font:15px/1.4 Inter,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
  body{display:grid;place-items:center}
  form{width:min(320px,88vw);display:grid;gap:14px;text-align:center}
  .logo{font-weight:800;font-size:28px;letter-spacing:-.02em}
  .logo span{color:#5b8def}
  p{margin:0;color:#8a93a3;font-size:13px}
  input{width:100%;box-sizing:border-box;padding:11px 13px;border-radius:8px;border:1px solid #232932;background:#161a20;color:#e6e9ef;font-size:15px;outline:none}
  input:focus{border-color:#5b8def}
  button{padding:11px;border:0;border-radius:8px;background:#5b8def;color:#fff;font-weight:700;font-size:15px;cursor:pointer}
  button:hover{filter:brightness(1.08)}
  .err{color:#ef4444}
</style></head><body>
<form method="post" action="/__gate" autocomplete="off">
  <div class="logo">by<span>INTENT</span></div>
  <p>Private preview — enter the password to continue.</p>
  <input type="password" name="password" placeholder="password" autofocus required>
  ${error ? '<p class="err">Wrong password.</p>' : ""}
  <button type="submit">Enter</button>
</form></body></html>`;

// ---- kill switch ----
// MAINTENANCE=1 (Railway → Variables) takes the whole site down behind a "back soon"
// page for everyone, password or not. Optional MAINTENANCE_MESSAGE replaces the text.
const MAINTENANCE = /^(1|true|yes|on)$/i.test(process.env.MAINTENANCE || "");
if (MAINTENANCE) {
  const msg = process.env.MAINTENANCE_MESSAGE || "We're doing some maintenance. Back soon.";
  const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const page = gatePage(false)
    .replace("Private preview — enter the password to continue.", esc(msg))
    .replace(/<input[^>]*>|<button[^>]*>Enter<\/button>/g, "");
  console.warn("MAINTENANCE is set — serving the maintenance page only");
  app.use((req, res) => {
    if (req.path === "/favicon.svg" || req.path === "/favicon-32.png") return res.sendFile(path.join(__dirname, "dist", req.path));
    res.status(503).set("cache-control", "no-store").set("retry-after", "600");
    if ((req.headers.accept ?? "").includes("text/html")) return res.type("html").send(page);
    res.json({ error: "maintenance" });
  });
}

if (!PW_GATED) {
  console.log("PW_GATED=0 — site is public, no password");
} else if (!GATE_PASSWORD) {
  // fail closed: gated but no password configured → nothing is served (not a public fallback)
  console.error("SITE_PASSWORD is not set — refusing to serve the site");
  app.use((_req, res) =>
    res.status(503).set("cache-control", "no-store").type("html").send(gatePage(false).replace("Private preview — enter the password to continue.", "Locked — SITE_PASSWORD is not configured on the server.").replace(/<input[^>]*>|<button[^>]*>Enter<\/button>/g, ""))
  );
} else {
  app.post("/__gate", express.urlencoded({ extended: false, limit: "4kb" }), (req, res) => {
    const given = String(req.body?.password ?? "");
    if (!safeEqual(given, GATE_PASSWORD)) return res.status(401).type("html").send(gatePage(true));
    res.append(
      "set-cookie",
      `${GATE_COOKIE}=${gateToken()}; Path=/; Max-Age=${GATE_MAX_AGE}; HttpOnly; SameSite=Lax${isHttps(req) ? "; Secure" : ""}`
    );
    res.redirect(303, "/");
  });
  app.use((req, res, next) => {
    if (req.path === "/favicon.svg" || req.path === "/favicon-32.png") return next(); // the gate page's own icon
    if (safeEqual(readCookie(req.headers.cookie, GATE_COOKIE), gateToken())) return next();
    const wantsPage = req.method === "GET" && (req.headers.accept ?? "").includes("text/html");
    if (wantsPage) return res.status(401).set("cache-control", "no-store").type("html").send(gatePage(false));
    res.status(401).set("cache-control", "no-store").json({ error: "locked" });
  });
}

// ---- volume log (Postgres) ----
// Every intent that passes through this proxy came from our UI, so logging them here is exact
// per-frontend attribution. Set DATABASE_URL (Railway → Postgres plugin → reference variable)
// and each POST /pt/intents (+ cancels) is stored: wallet, action, market, margin, leverage,
// notional = margin × leverage, the relayer's verdict and intent id, plus the raw request/response
// (signature stripped). Without DATABASE_URL nothing is logged and nothing else changes. A DB
// failure is logged to the console and never affects the trade itself.
const INTENT_PATH = /^\/intents(\/[^/]+\/cancel)?\/?$/;
const PRICE_UNITS = 1e18; // size/amount fields are 1e18-scaled USDC
let pool = null;
if (process.env.DATABASE_URL) {
  const url = process.env.DATABASE_URL;
  const ssl = process.env.PGSSL === "0" ? false : /sslmode=require|\.proxy\.rlwy\.net|amazonaws|neon\.tech|supabase/.test(url) ? { rejectUnauthorized: false } : false;
  pool = new Pool({ connectionString: url, ssl, max: 3, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 5_000 });
  pool.on("error", (e) => console.warn("[volume-log] pool error", e.message));
  pool
    .query(`
      CREATE TABLE IF NOT EXISTS intents (
        id            bigserial PRIMARY KEY,
        at            timestamptz NOT NULL DEFAULT now(),
        wallet        text NOT NULL,
        action        text NOT NULL,
        instrument_id integer,
        is_long       boolean,
        margin_usdc   numeric(24, 6),
        leverage      integer,
        notional_usdc numeric(24, 6),
        position_ids  text[],
        accepted      boolean NOT NULL,
        http_status   integer,
        intent_id     text,
        request       jsonb,
        response      jsonb
      );
      CREATE INDEX IF NOT EXISTS intents_wallet_at ON intents (wallet, at);
      CREATE INDEX IF NOT EXISTS intents_at ON intents (at);
    `)
    .then(() => console.log("[volume-log] Postgres ready"))
    .catch((e) => console.warn("[volume-log] schema setup failed:", e.message));
} else {
  console.log("[volume-log] DATABASE_URL not set — intents are not logged");
}
const usdc = (raw, units = PRICE_UNITS) => {
  try {
    return raw == null ? null : Number(BigInt(String(raw))) / units;
  } catch {
    return null;
  }
};
const logIntent = (req, status, text) => {
  if (!pool) return;
  try {
    const body = req.body ?? {};
    const cancel = INTENT_PATH.exec(req.path)?.[1];
    const signed = { ...(body.signed ?? body) };
    delete signed.v;
    delete signed.r;
    delete signed.s;
    delete signed.signature;
    const wallet = String(signed.user ?? "").toLowerCase();
    if (!wallet) return;
    const action = cancel ? "cancelIntent" : String(body.action ?? "unknown");
    let response = null;
    try {
      response = JSON.parse(text);
    } catch {
      response = text ? { raw: text.slice(0, 2000) } : null;
    }
    const accepted = status >= 200 && status < 300 && !(response && (response.error || response.code || response.ok === false));
    // opens: 1e18-scaled margin; withdrawals: collateral units (USDC 6 dp)
    const margin = action === "openPosition" ? usdc(signed.size) : action === "withdrawToCore" ? usdc(signed.amount, 1e6) : null;
    const leverage = action === "openPosition" && signed.leverage != null ? Number(signed.leverage) : null;
    const notional = margin != null && leverage != null ? margin * leverage : null;
    const positionIds = Array.isArray(signed.positionIds) ? signed.positionIds.map(String) : null;
    const intentId = cancel ? String(cancel.split("/")[1]) : response?.intentId != null ? String(response.intentId) : null;
    pool
      .query(
        `INSERT INTO intents (wallet, action, instrument_id, is_long, margin_usdc, leverage, notional_usdc,
                              position_ids, accepted, http_status, intent_id, request, response)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [
          wallet,
          action,
          signed.instrumentId != null ? Number(signed.instrumentId) : null,
          signed.isLong != null ? Boolean(signed.isLong) : null,
          margin,
          leverage,
          notional,
          positionIds,
          accepted,
          status,
          intentId,
          body.signed ? { ...body, signed } : signed, // cancels post the signed struct bare
          response,
        ]
      )
      .catch((e) => console.warn("[volume-log] insert failed:", e.message));
  } catch (e) {
    console.warn("[volume-log] skipped:", e.message);
  }
};

// ---- admin dashboard ----
// The page is hidden unless a whitelist wallet is connected; these routes also
// require a personal_sign from that wallet (cookie lasts 7 days). Extra admins:
// Railway → ADMIN_WALLETS=0xabc,0xdef
const ADMIN_COOKIE = "bi_admin";
const ADMIN_MAX_AGE = 60 * 60 * 24 * 7;
// The whitelist lives only in the environment (ADMIN_WALLETS) — nothing in the shipped bundle
// names an admin and nothing is hard-coded here.
const ADMIN_BUILTIN = [];
const ADMIN_WINDOWS = { "24h": 86400000, "7d": 604800000, "30d": 2592000000, all: null };
const adminSecret = () => process.env.ADMIN_SECRET || process.env.GATE_SECRET || process.env.SITE_PASSWORD || "byintent-admin";
const adminList = () =>
  new Set([
    ...ADMIN_BUILTIN,
    ...(process.env.ADMIN_WALLETS || "")
      .split(/[,;\s]+/)
      .filter(Boolean)
      .map((a) => a.toLowerCase()),
  ]);
const isAdminAddr = (addr) => adminList().has(String(addr || "").toLowerCase());
const adminUnlockMessage = (address, ts) =>
  [
    "byINTENT admin",
    `Address: ${address.toLowerCase()}`,
    `Timestamp: ${ts}`,
    "",
    "This signature only unlocks the byINTENT admin dashboard. It cannot trade or move funds.",
  ].join("\n");
const signAdminCookie = (addr, exp) => {
  const a = addr.toLowerCase();
  const mac = createHmac("sha256", adminSecret()).update(`${a}:${exp}`).digest("hex");
  return `${a}.${exp}.${mac}`;
};
const readAdmin = (req) => {
  const raw = readCookie(req.headers.cookie, ADMIN_COOKIE);
  const [addr, exp, mac] = raw.split(".");
  if (!addr || !exp || !mac) return null;
  const expect = createHmac("sha256", adminSecret()).update(`${addr}:${exp}`).digest("hex");
  if (!safeEqual(mac, expect)) return null;
  if (Number(exp) < Date.now()) return null;
  if (!isAdminAddr(addr)) return null;
  return addr;
};
const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

app.get("/admin/allowed", (req, res) => {
  res.set("cache-control", "no-store");
  res.json({ admin: isAdminAddr(req.query.address) });
});

app.post("/admin/auth", async (req, res) => {
  res.set("cache-control", "no-store");
  const address = String(req.body?.address || "").toLowerCase();
  const signature = String(req.body?.signature || "");
  const signedAtMs = Number(req.body?.signedAtMs);
  if (!isAdminAddr(address)) return res.status(403).json({ error: "forbidden" });
  if (!signature || !Number.isFinite(signedAtMs)) return res.status(400).json({ error: "bad_request" });
  if (Math.abs(Date.now() - signedAtMs) > 10 * 60 * 1000) return res.status(400).json({ error: "stale" });
  try {
    const recovered = await recoverMessageAddress({ message: adminUnlockMessage(address, signedAtMs), signature });
    if (recovered.toLowerCase() !== address) return res.status(401).json({ error: "bad_sig" });
  } catch {
    return res.status(401).json({ error: "bad_sig" });
  }
  const exp = Date.now() + ADMIN_MAX_AGE * 1000;
  res.append(
    "set-cookie",
    `${ADMIN_COOKIE}=${signAdminCookie(address, exp)}; Path=/; Max-Age=${ADMIN_MAX_AGE}; HttpOnly; SameSite=Lax${isHttps(req) ? "; Secure" : ""}`
  );
  res.json({ ok: true, address });
});

const liqCache = new Map(); // wallet -> { at, items }
const LIQ_TTL = 5 * 60 * 1000;
const fetchWalletTrades = async (wallet) => {
  const hit = liqCache.get(wallet);
  if (hit && Date.now() - hit.at < LIQ_TTL) return hit.items;
  try {
    const r = await fetch(`${UPSTREAM}/query/accounts/${wallet}/trades?filter=all&limit=75`, {
      headers: { accept: "application/json" },
    });
    if (!r.ok) return hit?.items ?? [];
    const j = await r.json();
    const items = (j.items ?? []).map((it) => ({
      timestampMs: Number(it.timestampMs),
      liquidated: it.kind === "Liquidated",
      margin: Number(it.marginRaw ?? 0) / PRICE_UNITS,
      leverage: Number(it.leverage ?? 0),
    }));
    liqCache.set(wallet, { at: Date.now(), items });
    return items;
  } catch {
    return hit?.items ?? [];
  }
};
const sampleLiq = async (wallets, sinceMs) => {
  const take = wallets.slice(0, 200);
  const rows = [];
  let i = 0;
  const workers = Array.from({ length: Math.min(6, take.length) }, async () => {
    while (i < take.length) {
      const w = take[i++];
      const items = await fetchWalletTrades(w);
      let trades = 0;
      let margin = 0;
      let notional = 0;
      for (const it of items) {
        if (!it.liquidated) continue;
        if (sinceMs && it.timestampMs < sinceMs) continue;
        trades++;
        margin += it.margin;
        notional += it.margin * (it.leverage || 0);
      }
      if (trades) rows.push({ trades, margin, notional });
    }
  });
  await Promise.all(workers);
  return {
    trades: rows.reduce((a, r) => a + r.trades, 0),
    wallets: rows.length,
    margin: rows.reduce((a, r) => a + r.margin, 0),
    notional: rows.reduce((a, r) => a + r.notional, 0),
    sampled: wallets.length > 200,
  };
};

app.get("/admin/stats", async (req, res) => {
  res.set("cache-control", "no-store");
  if (!readAdmin(req)) return res.status(401).json({ error: "unauthorized" });
  if (!pool) return res.status(503).json({ error: "no_db" });
  const window = ADMIN_WINDOWS[req.query.window] !== undefined ? req.query.window : "24h";
  const span = ADMIN_WINDOWS[window];
  const since = span == null ? null : new Date(Date.now() - span);
  const sinceMs = since ? since.getTime() : null;
  try {
    const [tot, split, wallets, series, recent] = await Promise.all([
      pool.query(
        `SELECT
           count(*)::int AS intents,
           count(*) FILTER (WHERE accepted)::int AS accepted,
           count(*) FILTER (WHERE NOT accepted)::int AS rejected,
           count(DISTINCT wallet)::int AS wallets,
           count(*) FILTER (WHERE accepted AND action = 'openPosition')::int AS opens,
           count(*) FILTER (WHERE accepted AND action = 'closePositions')::int AS closes,
           count(*) FILTER (WHERE accepted AND action = 'cancelIntent')::int AS cancels,
           count(*) FILTER (WHERE accepted AND action = 'withdrawToCore')::int AS withdraws,
           coalesce(sum(notional_usdc) FILTER (WHERE accepted AND action = 'openPosition'), 0) AS volume,
           coalesce(sum(margin_usdc) FILTER (WHERE accepted AND action = 'openPosition'), 0) AS margin,
           coalesce(sum(margin_usdc) FILTER (WHERE accepted AND action = 'withdrawToCore'), 0) AS withdraw_volume
         FROM intents
         WHERE $1::timestamptz IS NULL OR at >= $1`,
        [since]
      ),
      pool.query(
        `SELECT
           coalesce(sum(notional_usdc) FILTER (WHERE accepted AND action = 'openPosition' AND instrument_id = 0), 0) AS btc,
           coalesce(sum(notional_usdc) FILTER (WHERE accepted AND action = 'openPosition' AND instrument_id = 1), 0) AS eth,
           coalesce(sum(notional_usdc) FILTER (WHERE accepted AND action = 'openPosition' AND is_long IS TRUE), 0) AS longs,
           coalesce(sum(notional_usdc) FILTER (WHERE accepted AND action = 'openPosition' AND is_long IS FALSE), 0) AS shorts
         FROM intents
         WHERE $1::timestamptz IS NULL OR at >= $1`,
        [since]
      ),
      pool.query(
        `SELECT wallet,
            count(*) FILTER (WHERE accepted AND action = 'openPosition')::int AS opens,
            count(*) FILTER (WHERE accepted AND action = 'closePositions')::int AS closes,
            coalesce(sum(notional_usdc) FILTER (WHERE accepted AND action = 'openPosition'), 0) AS volume,
            coalesce(sum(margin_usdc) FILTER (WHERE accepted AND action = 'openPosition'), 0) AS margin,
            max(at) AS last_at
         FROM intents
         WHERE $1::timestamptz IS NULL OR at >= $1
         GROUP BY wallet
         ORDER BY volume DESC
         LIMIT 200`,
        [since]
      ),
      pool.query(
        `SELECT date_trunc('${window === "24h" ? "hour" : "day"}', at) AS bucket,
            coalesce(sum(notional_usdc) FILTER (WHERE accepted AND action = 'openPosition'), 0) AS volume,
            count(DISTINCT wallet)::int AS wallets,
            count(*) FILTER (WHERE accepted AND action = 'openPosition')::int AS opens
         FROM intents
         WHERE $1::timestamptz IS NULL OR at >= $1
         GROUP BY 1
         ORDER BY 1`,
        [since]
      ),
      pool.query(
        `SELECT at, wallet, action, instrument_id, is_long, margin_usdc, leverage, notional_usdc, accepted
         FROM intents
         WHERE $1::timestamptz IS NULL OR at >= $1
         ORDER BY at DESC
         LIMIT 40`,
        [since]
      ),
    ]);
    const t = tot.rows[0] ?? {};
    const s = split.rows[0] ?? {};
    const walletRows = wallets.rows.map((r) => ({
      wallet: r.wallet,
      opens: num(r.opens),
      closes: num(r.closes),
      volume: num(r.volume),
      margin: num(r.margin),
      lastAt: r.last_at instanceof Date ? r.last_at.toISOString() : String(r.last_at),
    }));
    let liq = null;
    try {
      liq = await sampleLiq(walletRows.map((w) => w.wallet), sinceMs);
    } catch (e) {
      console.warn("[admin] liq sample failed:", e.message);
    }
    res.json({
      window,
      since: since ? since.toISOString() : null,
      logging: true,
      totals: {
        intents: num(t.intents),
        accepted: num(t.accepted),
        rejected: num(t.rejected),
        wallets: num(t.wallets),
        opens: num(t.opens),
        closes: num(t.closes),
        cancels: num(t.cancels),
        withdraws: num(t.withdraws),
        volume: num(t.volume),
        margin: num(t.margin),
        withdrawVolume: num(t.withdraw_volume),
      },
      split: {
        btcVolume: num(s.btc),
        ethVolume: num(s.eth),
        longVolume: num(s.longs),
        shortVolume: num(s.shorts),
      },
      wallets: walletRows,
      series: series.rows.map((r) => {
        const d = r.bucket instanceof Date ? r.bucket : new Date(r.bucket);
        const label = window === "24h"
          ? `${String(d.getUTCHours()).padStart(2, "0")}:00`
          : d.toISOString().slice(0, 10);
        return { day: label, volume: num(r.volume), wallets: num(r.wallets), opens: num(r.opens) };
      }),
      recent: recent.rows.map((r) => ({
        at: r.at instanceof Date ? r.at.toISOString() : String(r.at),
        wallet: r.wallet,
        action: r.action,
        instrumentId: r.instrument_id == null ? null : Number(r.instrument_id),
        isLong: r.is_long,
        margin: r.margin_usdc == null ? null : num(r.margin_usdc),
        leverage: r.leverage == null ? null : Number(r.leverage),
        notional: r.notional_usdc == null ? null : num(r.notional_usdc),
        accepted: !!r.accepted,
      })),
      liq,
    });
  } catch (e) {
    console.warn("[admin] stats failed:", e.message);
    res.status(500).json({ error: "query_failed" });
  }
});

app.use("/pt", async (req, res) => {
  const isIntent = req.method === "POST" && INTENT_PATH.test(req.path);
  // when the browser goes away, drop the upstream request too — otherwise every abandoned
  // SSE feed stays open against the relayer until it decides to hang up. Intents are exempt:
  // they must run to completion so the verdict gets logged even if the tab closes mid-flight.
  const ac = new AbortController();
  if (!isIntent) res.on("close", () => ac.abort());
  try {
    const headers = { accept: req.headers.accept ?? "application/json" };
    // forward the relayer session cookie both ways (their /intents endpoint
    // uses credentials: include) — minus our own gate cookie
    const cookie = req.headers.cookie
      ? stripCookie(stripCookie(req.headers.cookie, GATE_COOKIE), "bi_admin")
      : "";
    if (cookie) headers.cookie = cookie;
    const init = { method: req.method, headers, redirect: "manual", signal: ac.signal };
    if (req.method !== "GET" && req.method !== "HEAD" && req.body && Object.keys(req.body).length) {
      headers["content-type"] = "application/json";
      init.body = JSON.stringify(req.body);
    }
    const upstream = await fetch(UPSTREAM + req.url, init);
    res.status(upstream.status);
    const setCookie = upstream.headers.getSetCookie?.() ?? [];
    for (const c of setCookie) res.append("set-cookie", c);
    res.set("content-type", upstream.headers.get("content-type") ?? "application/json");
    res.set("cache-control", "no-store");
    // Intents (trades, closes, cancels…) are small JSON round-trips: buffer the reply so the
    // relayer's verdict + intent id can be logged, then forward it unchanged.
    if (isIntent) {
      const text = await upstream.text();
      res.send(text);
      logIntent(req, upstream.status, text);
      return;
    }
    // Stream the body through (required for the /state/user/live SSE feed;
    // buffering would hold the response open forever). pipeline(), not pipe(): pipe() leaves
    // the source's 'error' event unhandled, and an upstream socket closing mid-stream then
    // takes the whole process down. Here it just ends our response; EventSource reconnects.
    if (upstream.body) {
      res.flushHeaders();
      pipeline(Readable.fromWeb(upstream.body), res, (err) => {
        if (err && err.name !== "AbortError" && err.code !== "ERR_STREAM_PREMATURE_CLOSE") {
          console.warn(`[pt] stream ${req.method} ${req.url} ended: ${err.code ?? err.name}: ${err.message}`);
        }
        if (!res.writableEnded) res.end();
      });
    } else {
      res.end();
    }
  } catch (err) {
    if (res.headersSent || res.destroyed) return; // client already gone or reply already under way
    res.status(502).json({ error: String(err) });
  }
});

// Last line of defence: a proxy must not die because one upstream socket misbehaved. Log it
// and keep serving; Railway restarts us on a real crash anyway, but every restart drops every
// open SSE feed and takes the site down for a few seconds.
process.on("uncaughtException", (err) => console.error("[fatal?] uncaught exception, continuing:", err));
process.on("unhandledRejection", (err) => console.error("[fatal?] unhandled rejection, continuing:", err));

// ---- server-side trigger orders (server/SPEC.md) ----
// Mounted from the esbuild bundle so this file stays plain JS. Needs DATABASE_URL +
// AUTH_SECRET; the engine itself runs in the separate `watcher` service (or here with
// WATCHER_MODE=inline for dev). If the bundle is missing or fails, /api answers 503 and
// the rest of the site is unaffected.
let triggerApi = null;
try {
  const mod = await import("./server-dist/api.mjs");
  triggerApi = await mod.attachTriggerApi(app, { isAdmin: readAdmin });
} catch (e) {
  console.error("[api] trigger API failed to start:", e?.message ?? e);
}
// not configured (no DATABASE_URL) or failed: answer 503 JSON instead of letting /api
// fall through to the SPA's index.html
if (!triggerApi?.enabled) {
  app.use("/api", (_req, res) => res.status(503).set("cache-control", "no-store").json({ error: "api_unavailable" }));
}

app.use(express.static(path.join(__dirname, "dist")));
app.get("*", (_req, res) => res.sendFile(path.join(__dirname, "dist", "index.html")));

const port = Number(process.env.PORT) || 3000;
const server = app.listen(port, "0.0.0.0", () => console.log(`byINTENT listening on :${port}`));

// Railway sends SIGTERM on redeploy: release the engine lease (inline mode) so the next
// instance takes over within one renew interval instead of waiting out the TTL.
for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    const force = setTimeout(() => process.exit(0), 10_000);
    force.unref();
    server.close();
    Promise.resolve(triggerApi?.stop?.()).finally(() => process.exit(0));
  });
}
