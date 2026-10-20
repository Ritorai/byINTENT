// Session keys + intent signing for Papertrade's relayer.
//
// The user's wallet signs ONE EIP-712 message registering a scoped key; after
// that the key (held here, in the browser) signs each open/close intent
// off-chain and the relayer submits it. A session key can never withdraw funds
// — worst case it can trade the balance. Revocation is a direct wallet call to
// SessionKeyManager.revokeSessionKey on HyperEVM.

import { zeroAddress } from "viem";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import type { WalletClient } from "viem";
import { SchemaPendingError, schemaReady, type IntentAction } from "../shared/intentSchema";
import { INTENT_TTL_S, buildIntent, marginToSize, splitSig } from "../shared/intentWire";
import { submitCancel, submitIntent, type RelayerResult } from "./relayer";

const STORAGE_KEY = "byintent.sessionKey.v1";
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000; // 30 days (per docs)

interface StoredSession {
  privateKey: `0x${string}`;
  wallet: string; // master wallet this key is scoped to
  createdAt: number;
  registered: boolean;
}

function load(): StoredSession | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as StoredSession) : null;
  } catch {
    return null;
  }
}

function save(s: StoredSession | null) {
  if (s) localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  else localStorage.removeItem(STORAGE_KEY);
}

export type SessionStatus =
  | { state: "none" }
  | { state: "unregistered"; address: string; createdAt: number }
  | { state: "active"; address: string; expiresAt: number }
  | { state: "expired"; address: string };

export function sessionStatus(wallet: string | undefined): SessionStatus {
  const s = load();
  if (!s || !wallet || s.wallet.toLowerCase() !== wallet.toLowerCase()) return { state: "none" };
  const addr = privateKeyToAccount(s.privateKey).address;
  const expiresAt = s.createdAt + SESSION_TTL_MS;
  if (Date.now() > expiresAt) return { state: "expired", address: addr };
  if (!s.registered) return { state: "unregistered", address: addr, createdAt: s.createdAt };
  return { state: "active", address: addr, expiresAt };
}

/** Create (or recreate) a local session key scoped to `wallet`. */
export function createSessionKey(wallet: string): string {
  const privateKey = generatePrivateKey();
  save({ privateKey, wallet, createdAt: Date.now(), registered: false });
  return privateKeyToAccount(privateKey).address;
}

export function clearSessionKey() {
  save(null);
}

/**
 * Mark the stored key registered when the on-chain wallet state (SSE stream)
 * confirms it — covers registrations done before the flag existed or from
 * another device.
 */
export function confirmSessionRegistered(onChainKeys: string[]) {
  const s = load();
  if (!s || s.registered) return;
  const addr = privateKeyToAccount(s.privateKey).address.toLowerCase();
  if (onChainKeys.includes(addr)) save({ ...s, registered: true });
}

function sessionAccount(): PrivateKeyAccount {
  const s = load();
  if (!s) throw new Error("No session key. Create one first.");
  return privateKeyToAccount(s.privateKey);
}

// ---- signing ----------------------------------------------------------------

/**
 * Sign an intent and produce the relayer wire format:
 * all fields serialized + {v, r, s} appended. The typed data and wire body
 * come from shared/intentWire.ts — the watcher signs the exact same bytes.
 */
async function signIntent(
  signer: PrivateKeyAccount | { walletClient: WalletClient; address: `0x${string}` },
  action: IntentAction,
  message: Record<string, unknown>
): Promise<Record<string, unknown>> {
  if (!schemaReady(action)) throw new SchemaPendingError(action);
  const { typedData, wire } = buildIntent(action, message);
  const sig =
    "walletClient" in signer
      ? await signer.walletClient.signTypedData({ ...(typedData as any), account: signer.address })
      : await signer.signTypedData(typedData as any);
  return { ...wire, ...splitSig(sig as `0x${string}`) };
}

const nowS = () => Math.floor(Date.now() / 1000);
const deadline = () => BigInt(nowS() + INTENT_TTL_S);

// Intent nonces must never repeat for a wallet (the relayer/exchange keys on
// (user, nonce)): Date.now() alone can collide across tabs or repeat after a
// clock step. Keep a persisted per-wallet high-water mark and go monotonic.
const NONCE_KEY = "byintent.nonce.v1";
const lastNonceByWallet = new Map<string, bigint>();
function freshNonce(user: string): bigint {
  const key = user.toLowerCase();
  // Re-read the persisted high-water mark on EVERY call and take the max of
  // (in-memory, persisted, now): two warm tabs share localStorage but not
  // this tab's in-memory map, so a mark cached at first use in one tab can
  // collide with a nonce the other tab has already consumed since.
  let persisted = 0n;
  try {
    persisted = BigInt(localStorage.getItem(`${NONCE_KEY}.${key}`) ?? "0");
  } catch {
    persisted = 0n;
  }
  const inMemory = lastNonceByWallet.get(key) ?? 0n;
  const last = inMemory > persisted ? inMemory : persisted;
  const nowMs = BigInt(Date.now());
  const next = nowMs > last ? nowMs : last + 1n;
  lastNonceByWallet.set(key, next);
  try {
    localStorage.setItem(`${NONCE_KEY}.${key}`, next.toString());
  } catch {
    /* private mode — in-memory mark still monotonic for this tab */
  }
  return next;
}

// ---- actions ----------------------------------------------------------------

/**
 * Register the local session key: the MASTER WALLET signs, the relayer
 * submits. One wallet popup, then 30 days of popup-free trading.
 */
export async function registerSessionKey(
  walletClient: WalletClient,
  wallet: `0x${string}`,
  /**
   * Register a key that is NOT this browser's — the watcher's server-held key
   * (server/SPEC.md §3). Only the address and expiry travel; the private key
   * never leaves the watcher process.
   */
  external?: { key: `0x${string}`; expiryS: number }
): Promise<RelayerResult> {
  const s = load();
  if (!external && (!s || s.wallet.toLowerCase() !== wallet.toLowerCase()))
    throw new Error("No session key for this wallet. Generate one first.");
  const key = external ? external.key : privateKeyToAccount(s!.privateKey).address;
  const expiry = external
    ? BigInt(Math.floor(external.expiryS))
    : BigInt(Math.floor((s!.createdAt + SESSION_TTL_MS) / 1000));
  const message = {
    user: wallet,
    key,
    expiry,
    // feeAddress is the (future) builder-code slot; their canonical frontend
    // populates its own. Zero address until the team confirms ours.
    feeAddress: zeroAddress,
    nonce: freshNonce(wallet),
    deadline: deadline(),
  };
  const signed = await signIntent({ walletClient, address: wallet }, "registerSessionKey", message);
  const result = await submitIntent("registerSessionKey", signed);
  if (result.ok && !external) save({ ...s!, registered: true });
  return result;
}

/**
 * Open a position, signed by the session key.
 * `marginUsdc` is 1e18-scaled on the wire (10 USDC minimum per protocol state).
 */
export async function openPositionIntent(params: {
  user: `0x${string}`;
  instrumentId: number;
  isLong: boolean;
  marginUsdc: number;
  leverage: number;
  useDebt?: boolean;
}): Promise<RelayerResult> {
  const message = {
    user: params.user,
    instrumentId: params.instrumentId,
    isLong: params.isLong,
    size: marginToSize(params.marginUsdc), // USDC → 1e18
    leverage: Math.round(params.leverage),
    useDebt: params.useDebt ?? false,
    nonce: freshNonce(params.user),
    deadline: deadline(),
  };
  const signed = await signIntent(sessionAccount(), "openPosition", message);
  return submitIntent("openPosition", signed);
}

/** Close positions by id, signed by the session key. */
export async function closePositionsIntent(
  user: `0x${string}`,
  positionIds: bigint[]
): Promise<RelayerResult> {
  const message = { user, positionIds, nonce: freshNonce(user), deadline: deadline() };
  const signed = await signIntent(sessionAccount(), "closePositions", message);
  return submitIntent("closePositions", signed);
}

/**
 * Cancel a queued intent — signed by the session key, submitted to
 * POST /intents/{id}/cancel with the intentId omitted from the body
 * (it's in the URL), mirroring their frontend.
 */
export async function cancelQueuedIntent(
  user: `0x${string}`,
  intentId: string
): Promise<RelayerResult> {
  const message = {
    user,
    intentId: intentId as `0x${string}`,
    deadline: deadline(),
  };
  const signed = await signIntent(sessionAccount(), "cancelIntent", message);
  delete (signed as Record<string, unknown>).intentId;
  return submitCancel(intentId, signed);
}

/** Relayer minimum for a withdrawal (their `below_minimum_withdrawal`: "Withdraw at least 10 USDC"). */
export const WITHDRAW_MIN_USDC = 10;

/**
 * Withdraw to the user's HyperCore spot account — signed by the MASTER wallet.
 *
 * Verified against their app (2026-10-19): unlike trade sizes (1e18), the withdrawal
 * `amount` is in collateral units — USDC's 6 decimals (they compare it to the 1e18 balance
 * as `amount * 10n ** (18 - evmDecimals)`). The POST also carries a `withdrawal` block naming
 * the route; "hypercore" lands on the Hyperliquid spot account with no onward transfer.
 * A 1e18-scaled amount is rejected by the relayer as malformed (bare 400).
 */
export async function withdrawToCoreIntent(
  walletClient: WalletClient,
  wallet: `0x${string}`,
  amountUsdc: number
): Promise<RelayerResult> {
  const message = {
    user: wallet,
    amount: BigInt(Math.round(amountUsdc * 1e6)),
    nonce: freshNonce(wallet),
    deadline: deadline(),
  };
  const signed = await signIntent({ walletClient, address: wallet }, "withdrawToCore", message);
  return submitIntent("withdrawToCore", signed, { withdrawal: { route: "hypercore" } });
}

// ---- PAPER staking (MASTER wallet signs; session keys are refused by design) --

/** PAPER amount (18 decimals) → raw bigint, tolerant of long decimal strings. */
export function parsePaperAmount(text: string): bigint | null {
  const m = /^\s*(\d+)(?:\.(\d{0,18}))?\s*$/.exec(text);
  if (!m) return null;
  const whole = BigInt(m[1]);
  const frac = BigInt((m[2] ?? "").padEnd(18, "0"));
  const v = whole * 10n ** 18n + frac;
  return v > 0n ? v : null;
}

export async function stakePaperIntent(
  walletClient: WalletClient,
  wallet: `0x${string}`,
  amountRaw: bigint
): Promise<RelayerResult> {
  const message = { user: wallet, amount: amountRaw, nonce: freshNonce(wallet), deadline: deadline() };
  const signed = await signIntent({ walletClient, address: wallet }, "paperStake", message);
  return submitIntent("paperStake", signed);
}

export async function unstakePaperIntent(
  walletClient: WalletClient,
  wallet: `0x${string}`,
  amountRaw: bigint
): Promise<RelayerResult> {
  const message = { user: wallet, amount: amountRaw, nonce: freshNonce(wallet), deadline: deadline() };
  const signed = await signIntent({ walletClient, address: wallet }, "paperUnstake", message);
  return submitIntent("paperUnstake", signed);
}

/** Claim accrued USDC rewards into the available exchange balance. */
export async function claimPaperIntent(
  walletClient: WalletClient,
  wallet: `0x${string}`
): Promise<RelayerResult> {
  const message = { user: wallet, nonce: freshNonce(wallet), deadline: deadline() };
  const signed = await signIntent({ walletClient, address: wallet }, "paperClaim", message);
  return submitIntent("paperClaim", signed);
}
