// Relayer wire format for signed intents — shared by src/session.ts (browser
// keys, master wallet) and server/signer.ts (watcher keys) so both produce
// byte-identical typed data and bodies. No I/O, no signing here.

import { HYPEREVM_CHAIN_ID } from "./contracts";
import { INTENT_SCHEMAS, type IntentAction } from "./intentSchema";

/** intents are valid for this long after signing (their documented default) */
export const INTENT_TTL_S = 3600;

/**
 * Serialize message values the way their relayer expects
 * (verified from their bundle): uints as decimal strings, hex lowercased.
 */
export function wireValue(type: string, v: unknown): unknown {
  if (type === "uint256[]") return (v as (bigint | number | string)[]).map((x) => BigInt(x as any).toString());
  if (type.startsWith("uint")) return BigInt(v as any).toString();
  if (type === "address" || type.startsWith("bytes")) return String(v).toLowerCase();
  return v;
}

export function splitSig(sig: `0x${string}`): { v: string; r: string; s: string } {
  const r = `0x${sig.slice(2, 66)}`.toLowerCase();
  const s = `0x${sig.slice(66, 130)}`.toLowerCase();
  const vRaw = parseInt(sig.slice(130, 132), 16);
  const v = vRaw < 27 ? vRaw + 27 : vRaw;
  return { v: String(v), r, s };
}

export interface TypedIntent {
  /** EIP-712 payload for signTypedData */
  typedData: {
    domain: { name: string; version: string; verifyingContract: `0x${string}`; chainId: number };
    types: Record<string, { name: string; type: string }[]>;
    primaryType: string;
    message: Record<string, unknown>;
  };
  /** the serialized fields the relayer wants in the POST body (before v/r/s) */
  wire: Record<string, unknown>;
}

/**
 * Build the typed data + wire body for an intent. Throws if a schema field is
 * missing from `message` — a half-built intent must never reach a signer.
 */
export function buildIntent(action: IntentAction, message: Record<string, unknown>): TypedIntent {
  const schema = INTENT_SCHEMAS[action];
  const wire: Record<string, unknown> = {};
  for (const { name, type } of schema.fields) {
    if (!(name in message)) throw new Error(`Intent "${action}" is missing field "${name}".`);
    wire[name] = wireValue(type, message[name]);
  }
  return {
    typedData: {
      domain: { ...schema.domain, chainId: HYPEREVM_CHAIN_ID },
      types: { [schema.primaryType]: schema.fields },
      primaryType: schema.primaryType,
      message,
    },
    wire,
  };
}

/** USDC margin → the 1e18-scaled `size` field of OpenPosition. */
export function marginToSize(marginUsdc: number): bigint {
  return BigInt(Math.round(marginUsdc * 1e6)) * 10n ** 12n;
}
