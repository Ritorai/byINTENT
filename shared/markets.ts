// Papertrade's listed markets. Shared: the browser draws them, the watcher
// validates trigger instruments against them and polls their prices.

export type MarketKey = "BTC" | "ETH";
export const MARKETS: Record<MarketKey, { id: number; hlCoin: string }> = {
  BTC: { id: 0, hlCoin: "BTC" },
  ETH: { id: 1, hlCoin: "ETH" },
};

/** instrumentId → symbol, for copy and logs */
export function marketSymbol(instrumentId: number): string {
  for (const [k, v] of Object.entries(MARKETS)) if (v.id === instrumentId) return k;
  return `#${instrumentId}`;
}

/**
 * Raw oracle prices are integers scaled per instrument (the Hyperliquid
 * 10^(6−szDecimals) factor): BTC 10, ETH 100. Matches `priceScaleRaw` in
 * /state/trading.
 */
export const PRICE_SCALE: Record<number, number> = { 0: 10, 1: 100 };
