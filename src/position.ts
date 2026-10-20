export type Side = "long" | "short";

/** An open position as the chart draws it (entry / liq lines). Built from the live wallet stream. */
export interface Position {
  /** protocol position id */
  id?: string;
  side: Side;
  margin: number; // USDC
  leverage: number;
  entry: number;
  liq: number;
  qty: number; // units of the asset
  openedAt: number;
}

export function pnl(pos: Position, price: number): number {
  const diff = (price - pos.entry) * (pos.side === "long" ? 1 : -1);
  return diff * pos.qty;
}

export function isBusted(pos: Position, price: number): boolean {
  return pos.side === "long" ? price <= pos.liq : price >= pos.liq;
}
