// Key custody primitives (SPEC.md §3).
//
// Session private keys are encrypted at rest with AES-256-GCM under a
// key-encryption key (KEK) that exists only in the watcher's environment.
// The lowercase wallet address is the GCM additional-authenticated-data, so
// a ciphertext cannot be re-homed onto another wallet's row. Layout:
// nonce(12) || tag(16) || ciphertext(32).

import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";

const NONCE_LEN = 12;
const TAG_LEN = 16;

export interface Kek {
  id: string; // first 8 hex of sha256(kek) — identifies which KEK encrypted a row
  key: Buffer;
}

export function loadKek(hex: string): Kek {
  const key = Buffer.from(hex, "hex");
  if (key.length !== 32) throw new Error("KEK must be exactly 32 bytes (64 hex chars)");
  return { id: createHash("sha256").update(key).digest("hex").slice(0, 8), key };
}

/** AES-256-GCM seal. `aad` binds the ciphertext to its row (the wallet). */
export function seal(kek: Kek, plaintext: Buffer, aad: string): Buffer {
  const nonce = randomBytes(NONCE_LEN);
  const c = createCipheriv("aes-256-gcm", kek.key, nonce);
  c.setAAD(Buffer.from(aad.toLowerCase(), "utf8"));
  const ct = Buffer.concat([c.update(plaintext), c.final()]);
  return Buffer.concat([nonce, c.getAuthTag(), ct]);
}

/** Throws on tampering / wrong KEK / wrong AAD — callers treat any throw as "no key". */
export function open(kek: Kek, blob: Buffer, aad: string): Buffer {
  if (blob.length < NONCE_LEN + TAG_LEN + 1) throw new Error("ciphertext too short");
  const nonce = blob.subarray(0, NONCE_LEN);
  const tag = blob.subarray(NONCE_LEN, NONCE_LEN + TAG_LEN);
  const ct = blob.subarray(NONCE_LEN + TAG_LEN);
  const d = createDecipheriv("aes-256-gcm", kek.key, nonce);
  d.setAAD(Buffer.from(aad.toLowerCase(), "utf8"));
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]);
}

/** Best-effort memory hygiene: overwrite a buffer that held key material. */
export function wipe(b: Buffer | undefined | null): void {
  if (b) b.fill(0);
}

/** Constant-time string compare for tokens/cookies. */
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

export function randomHex(bytes: number): string {
  return randomBytes(bytes).toString("hex");
}
