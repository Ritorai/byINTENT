// Papertrade's published contract addresses and endpoints — shared by the
// browser (src/) and the watcher (server/). Keep this file dependency-free.
// Source: https://docs.papertrade.xyz/#/dev/contract-addresses (2026-10-06)

export const HYPEREVM_CHAIN_ID = 999;

/** Papertrade protocol contracts on HyperEVM mainnet (all proxies; call these). */
export const CONTRACTS = {
  exchange: "0x6cd5661646289FB6E65EA5C032310fDEd797D0a2",
  batchExecutor: "0x233Ff29b239abc1D7748605dA9b205C3e008626E",
  priceOracle: "0xa9B4c7b7Ca5835652d81E25739c870D49F39cC2e",
  sessionKeyManager: "0x8326Eb8896e358717f10502Ec73CE8D28E37B108",
  depositProxyFactory: "0x1629b7D46bef6E13FF754174FC9F32dEa309b38F",
  paperToken: "0xe40f17915DAa230324030003A197cdAEf2261C0e",
  paperStaking: "0xAAd6c7b0CC3014FC80FfEDAe0Ed7Ce5967b0F016",
  paperTokenomics: "0x75174549dbBD44497D31a47E2E2D7406408d63D9",
  usdc: "0xb88339CB7199b77E23DB6E890353E22632Ba630f", // native Circle USDC on HyperEVM
  /**
   * CoreDepositWallet — the contract papertrade's own HyperEVM deposit route calls
   * (`collateral.address` in their app config, verified 2026-10-17: EIP-1967 proxy,
   * implementation 0x7537…0DA3 exposes depositFor(address,uint256,uint32)). It pulls
   * approved USDC on HyperEVM and bridges it to the recipient's HyperCore spot balance.
   * Papertrade only credits USDC that arrives on the HyperCore side of the deposit
   * address; a plain ERC-20 transfer on HyperEVM is NOT credited.
   */
  coreDepositWallet: "0x6b9e773128f453f5c2c60935ee2de2cbc5390a24",
} as const;

/**
 * SessionKeyManager — the one call a wallet needs to cut a session key off
 * for good. `revokeSessionKey(address)` = selector 0x84f4fc6a, verified
 * against the implementation bytecode at 0x8a50…e558 (2026-10-20); msg.sender
 * is the wallet whose key is revoked.
 */
export const SESSION_KEY_MANAGER_ABI = [
  {
    type: "function",
    name: "revokeSessionKey",
    stateMutability: "nonpayable",
    inputs: [{ name: "key", type: "address" }],
    outputs: [],
  },
] as const;

/** Papertrade's exchange / relayer host (server-to-server; browsers go via the /pt proxy). */
export const EXCHANGE_URL = "https://exchange.papertrade.xyz";
