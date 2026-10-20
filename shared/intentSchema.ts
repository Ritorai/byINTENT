// The EIP-712 intent schema for Papertrade's relayer.
//
// CAPTURED 2026-10-14 from their app's typed-data chunk
// (assets/typed-data-MuKdbS29.js) — these are the exact structs their own
// frontend signs. Trading actions verify against the Exchange contract;
// note the exchange domain name is literally the string "String" (a
// deploy-time placeholder their contract is stuck with).
//
// Still unverified by a live round-trip (needs a funded account):
//  - feeAddress semantics in RegisterSessionKey (builder-code slot; we send
//    the zero address until confirmed)
//  - size/leverage scaling in OpenPosition (size appears to be 1e18-scaled
//    USDC margin, consistent with minimumTradeSizeRaw = 10e18 = their
//    documented 10 USDC minimum; leverage appears to be a plain integer)
//  - nonce source (we use the ms timestamp; if the relayer expects an
//    account nonce it will reject harmlessly and tell us)
// A wrong value here cannot move funds anywhere except into a trade on your
// own account, and the relayer rejects malformed intents outright — but
// still: make your first live trade a minimum-size one.

import { CONTRACTS } from "./contracts";

export type IntentAction =
  | "registerSessionKey"
  | "openPosition"
  | "closePositions"
  | "withdrawToCore"
  | "cancelIntent"
  | "paperStake"
  | "paperUnstake"
  | "paperClaim";

export interface TypedField {
  name: string;
  type: string;
}

interface ActionSchema {
  primaryType: string;
  fields: TypedField[];
  domain: { name: string; version: string; verifyingContract: `0x${string}` };
  /** false = struct known but target domain not yet confirmed end-to-end */
  verified: boolean;
}

const EXCHANGE_DOMAIN = {
  name: "String", // yes, really — see header comment
  version: "1",
  verifyingContract: CONTRACTS.exchange as `0x${string}`,
};

const STAKING_DOMAIN = {
  name: "PaperStaking",
  version: "1",
  verifyingContract: CONTRACTS.paperStaking as `0x${string}`,
};

// Cancellations use their own domain (same Exchange verifying contract);
// their frontend signs CancelIntent and POSTs to /intents/{id}/cancel.
const CANCEL_DOMAIN = {
  name: "PaperTrade Intent Cancel",
  version: "2",
  verifyingContract: CONTRACTS.exchange as `0x${string}`,
};

const u = (name: string, type: string): TypedField => ({ name, type });

export const INTENT_SCHEMAS: Record<IntentAction, ActionSchema> = {
  registerSessionKey: {
    primaryType: "RegisterSessionKey",
    fields: [
      u("user", "address"),
      u("key", "address"),
      u("expiry", "uint64"),
      u("feeAddress", "address"),
      u("nonce", "uint256"),
      u("deadline", "uint64"),
    ],
    domain: EXCHANGE_DOMAIN,
    verified: true,
  },
  openPosition: {
    primaryType: "OpenPosition",
    fields: [
      u("user", "address"),
      u("instrumentId", "uint32"),
      u("isLong", "bool"),
      u("size", "uint128"),
      u("leverage", "uint32"),
      u("useDebt", "bool"),
      u("nonce", "uint256"),
      u("deadline", "uint64"),
    ],
    domain: EXCHANGE_DOMAIN,
    verified: true,
  },
  closePositions: {
    primaryType: "Close",
    fields: [
      u("user", "address"),
      u("positionIds", "uint256[]"),
      u("nonce", "uint256"),
      u("deadline", "uint64"),
    ],
    domain: EXCHANGE_DOMAIN,
    verified: true,
  },
  withdrawToCore: {
    primaryType: "WithdrawToCore",
    fields: [
      u("user", "address"),
      u("amount", "uint256"),
      u("nonce", "uint256"),
      u("deadline", "uint64"),
    ],
    domain: EXCHANGE_DOMAIN,
    verified: true,
  },
  cancelIntent: {
    primaryType: "CancelIntent",
    fields: [u("user", "address"), u("intentId", "bytes32"), u("deadline", "uint256")],
    domain: CANCEL_DOMAIN,
    verified: true,
  },
  // Staking: domain {name "PaperStaking", version "1"} verifying against the
  // PaperStaking proxy — confirmed 2026-10-15 against their wire config chunk
  // (contracts.paperStaking = 0xaad6…f016) and typed-data chunk. Their session
  // keys refuse these, so the MASTER wallet signs each one.
  paperStake: {
    primaryType: "Stake",
    fields: [u("user", "address"), u("amount", "uint256"), u("nonce", "uint256"), u("deadline", "uint64")],
    domain: STAKING_DOMAIN,
    verified: true,
  },
  paperUnstake: {
    primaryType: "Unstake",
    fields: [u("user", "address"), u("amount", "uint256"), u("nonce", "uint256"), u("deadline", "uint64")],
    domain: STAKING_DOMAIN,
    verified: true,
  },
  paperClaim: {
    primaryType: "Claim",
    fields: [u("user", "address"), u("nonce", "uint256"), u("deadline", "uint64")],
    domain: STAKING_DOMAIN,
    verified: true,
  },
};

export function schemaReady(action: IntentAction): boolean {
  return INTENT_SCHEMAS[action].verified;
}

export class SchemaPendingError extends Error {
  constructor(action: IntentAction) {
    super(`The schema for "${action}" has not been verified end-to-end yet.`);
    this.name = "SchemaPendingError";
  }
}
