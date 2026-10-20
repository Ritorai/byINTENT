// Client for Papertrade's relayer and public state endpoints (via the /pt
// same-origin proxy; their edge rejects foreign Origin headers).

const PT = "/pt";

export interface RelayerResult {
  ok: boolean;
  intentId?: string;
  queueRevision?: number;
  error?: string;
  /** the admission check that failed on a 409 admission_rejected (alreadyQueued, funding, …) */
  reason?: string;
  message?: string;
}

/**
 * Submit a signed intent to the relayer.
 * Mirrors their frontend: POST /intents {action, signed, ...extras}, JSON,
 * cookies included (the proxy forwards them).
 */
export async function submitIntent(
  action: string,
  signed: Record<string, unknown>,
  extras: Record<string, unknown> = {}
): Promise<RelayerResult> {
  const res = await fetch(`${PT}/intents`, {
    method: "POST",
    credentials: "include",
    cache: "no-store",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, signed, ...extras }),
    signal: AbortSignal.timeout(8000),
  });
  let body: any = null;
  try {
    body = await res.json();
  } catch {
    /* non-JSON error body */
  }
  if (!res.ok || body?.error || body?.code || body?.ok === false) {
    // Observed relayer error shapes: {"code": "unauthorized_intent"} with 403 (signature
    // rejected), bare 400 (malformed body), and 409 {"code": "admission_rejected", "reason": R}
    // where R names the admission check that failed — their frontend maps: tradingPaused,
    // marketPaused, inactiveInstrument, belowMinimum, belowMinimumNotional, leverageTooHigh,
    // leverageTooLow, positionTooLarge, openInterest, funding, noOpenPositions, paperBalance,
    // stakedBalance, sessionKeyLimit, noDeposit, noRewards, alreadyQueued.
    const code = body?.error ?? body?.code ?? `http_${res.status}`;
    const reason = typeof body?.reason === "string" ? body.reason : undefined;
    console.warn(`[relayer] ${action} → ${res.status}`, body); // the full body, for digging into rejections
    return {
      ok: false,
      error: code,
      reason,
      message: body?.message ?? `Relayer returned ${res.status} (${code}${reason ? `: ${reason}` : ""}).`,
    };
  }
  return { ok: true, ...body };
}

/** Cancel a queued intent: POST /intents/{id}/cancel with the signed body. */
export async function submitCancel(
  intentId: string,
  signedBody: Record<string, unknown>
): Promise<RelayerResult> {
  const res = await fetch(`${PT}/intents/${intentId}/cancel`, {
    method: "POST",
    credentials: "include",
    cache: "no-store",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(signedBody),
    signal: AbortSignal.timeout(8000),
  });
  let body: any = null;
  try {
    body = await res.json();
  } catch {
    /* non-JSON */
  }
  if (!res.ok || body?.error || body?.code || body?.ok === false) {
    return {
      ok: false,
      error: body?.error ?? body?.code ?? `http_${res.status}`,
      message: body?.message ?? `Cancel returned ${res.status}${body?.code ? ` (${body.code})` : ""}.`,
    };
  }
  return { ok: true, ...body };
}

export interface ProtocolTradingState {
  tradingPaused: boolean;
  minimumTradeUsdc: number;
  instruments: { id: number; symbol: string; maxLeverage: number }[];
}

/** Public protocol state: markets, pause flag, minimum trade size. */
export async function fetchTradingState(): Promise<ProtocolTradingState> {
  const res = await fetch(`${PT}/state/trading`);
  if (!res.ok) throw new Error(`state/trading ${res.status}`);
  const j = await res.json();
  return {
    tradingPaused: !!j.tradingPaused,
    minimumTradeUsdc: Number(BigInt(j.minimumTradeSizeRaw ?? "0") / 10n ** 18n),
    instruments: (j.instruments ?? []).map((row: any[]) => ({
      id: row[0],
      symbol: row[1],
      maxLeverage: Number(row[15] ?? 1000),
    })),
  };
}

/** Lightweight reachability check for the relayer host. */
export async function relayerReachable(): Promise<boolean> {
  try {
    const res = await fetch(`${PT}/query/notices`, { signal: AbortSignal.timeout(4000) });
    return res.ok;
  } catch {
    return false;
  }
}
