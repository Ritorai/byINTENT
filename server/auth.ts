// Browser ↔ web authentication for the trigger API (SPEC.md §4).
// One personal_sign → 7-day HttpOnly cookie. The wallet on every authed
// request comes from the cookie and nowhere else.

import { createHmac } from "node:crypto";
import type { Request, Response } from "express";
import { recoverMessageAddress } from "viem";
import { ADDRESS_RE } from "../shared/triggerLogic";
import { randomHex, safeEqual } from "./crypto";
import type { Repo } from "./repo";

export const SESSION_COOKIE = "bi_sess";
export const SESSION_TTL_MS = 7 * 24 * 3600 * 1000;
export const CHALLENGE_TTL_MS = 10 * 60 * 1000;

export function challengeMessage(address: string, nonce: string, issuedAt: string): string {
  return [
    "byINTENT wants you to sign in with your wallet.",
    "",
    `Address: ${address.toLowerCase()}`,
    `Nonce: ${nonce}`,
    `Issued At: ${issuedAt}`,
    "",
    "This signature only signs you in to manage trigger orders on byINTENT.",
    "It cannot trade or move funds by itself.",
  ].join("\n");
}

// ---- cookie ---------------------------------------------------------------------

function mac(secret: string, addr: string, exp: number): string {
  return createHmac("sha256", secret).update(`${addr}:${exp}`).digest("hex");
}

export function signSessionCookie(secret: string, address: string, exp: number): string {
  const a = address.toLowerCase();
  return `${a}.${exp}.${mac(secret, a, exp)}`;
}

export function readCookie(header: string | undefined, name: string): string {
  if (!header) return "";
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return "";
}

/** wallet (lowercase) from a valid, unexpired cookie — or null */
export function readSession(req: Request, secret: string, now = Date.now()): string | null {
  const raw = readCookie(req.headers.cookie, SESSION_COOKIE);
  const [addr, expS, m] = raw.split(".");
  if (!addr || !expS || !m) return null;
  if (!ADDRESS_RE.test(addr) || addr !== addr.toLowerCase()) return null;
  const exp = Number(expS);
  if (!Number.isFinite(exp) || exp < now) return null;
  if (!safeEqual(m, mac(secret, addr, exp))) return null;
  return addr;
}

export const isHttps = (req: Request): boolean => req.secure || req.headers["x-forwarded-proto"] === "https";

export function setSessionCookie(req: Request, res: Response, value: string, maxAgeS: number): void {
  res.append(
    "set-cookie",
    `${SESSION_COOKIE}=${value}; Path=/api; Max-Age=${maxAgeS}; HttpOnly; SameSite=Strict${isHttps(req) ? "; Secure" : ""}`
  );
}

export function clearSessionCookie(req: Request, res: Response): void {
  setSessionCookie(req, res, "", 0);
}

// ---- origin check (CSRF defence in depth; SameSite=Strict is the first layer) ----

function hostOf(url: string): string | null {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Mutating requests must come from our own origin. Browsers always send
 * `Origin` on cross-site and same-site POSTs; `Sec-Fetch-Site` is a second
 * witness. A request with neither header is not a browser form or fetch we
 * issued — reject it.
 */
export function sameOrigin(req: Request, allowedOrigins: string[]): boolean {
  const sfs = String(req.headers["sec-fetch-site"] ?? "").toLowerCase();
  const origin = String(req.headers.origin ?? "").toLowerCase();
  const reqHost = String(req.headers["x-forwarded-host"] ?? req.headers.host ?? "").toLowerCase();
  if (origin) {
    const oh = hostOf(origin);
    if (oh && oh === reqHost) return true;
    if (allowedOrigins.includes(origin.replace(/\/$/, ""))) return true;
    return false;
  }
  return sfs === "same-origin";
}

// ---- rate limiting (per process, token bucket) --------------------------------------

export class RateLimiter {
  private buckets = new Map<string, { tokens: number; at: number }>();
  private lastSweep = 0;
  constructor(
    private limit: number,
    private windowMs: number,
    private now: () => number = Date.now
  ) {}

  /** true = allowed */
  take(key: string): boolean {
    const now = this.now();
    if (now - this.lastSweep > 60_000) this.sweep(now);
    const b = this.buckets.get(key) ?? { tokens: this.limit, at: now };
    const refill = ((now - b.at) / this.windowMs) * this.limit;
    b.tokens = Math.min(this.limit, b.tokens + refill);
    b.at = now;
    if (b.tokens < 1) {
      this.buckets.set(key, b);
      return false;
    }
    b.tokens -= 1;
    this.buckets.set(key, b);
    return true;
  }

  private sweep(now: number) {
    this.lastSweep = now;
    for (const [k, b] of this.buckets) if (now - b.at > this.windowMs * 2) this.buckets.delete(k);
  }
}

export function clientIp(req: Request): string {
  const xf = String(req.headers["x-forwarded-for"] ?? "");
  return (xf.split(",")[0] || req.socket.remoteAddress || "?").trim();
}

// ---- challenge / verify ---------------------------------------------------------------

export async function issueChallenge(repo: Repo, address: string, now = Date.now()): Promise<{ message: string; nonce: string }> {
  const nonce = randomHex(16);
  const issuedAt = new Date(now).toISOString();
  // the nonce row also pins the issuedAt so the message can be rebuilt byte-for-byte at verify time
  await repo.putAuthNonce(nonce, `${address.toLowerCase()}|${issuedAt}`, now + CHALLENGE_TTL_MS);
  return { message: challengeMessage(address, nonce, issuedAt), nonce };
}

/** true when `signature` is `address`'s personal_sign over the challenge for `nonce` (single use) */
export async function verifyChallenge(
  repo: Repo,
  address: string,
  nonce: string,
  signature: string,
  now = Date.now()
): Promise<boolean> {
  if (!/^[0-9a-f]{32}$/.test(nonce) || !/^0x[0-9a-fA-F]{130}$/.test(signature)) return false;
  // consume first — whatever happens next, this nonce is spent
  const stored = await repo.consumeAuthNonce(nonce, now);
  if (!stored) return false;
  const [addr, issuedAt] = stored.split("|");
  if (addr !== address.toLowerCase() || !issuedAt) return false; // challenge issued for a different address
  try {
    const recovered = await recoverMessageAddress({ message: challengeMessage(address, nonce, issuedAt), signature: signature as `0x${string}` });
    return recovered.toLowerCase() === address.toLowerCase();
  } catch {
    return false;
  }
}
