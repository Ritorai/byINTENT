// Server-side client for papertrade's relayer and public state endpoints.
// Server-to-server requests carry no Origin header, so this talks to the
// exchange host directly (no /pt proxy). Mirrors src/relayer.ts.

import { log } from "./log";

export interface RelayerResult {
  ok: boolean;
  intentId?: string;
  queueRevision?: number;
  error?: string;
  reason?: string;
  message?: string;
  httpStatus?: number;
}

export interface ProtoState {
  tradingPaused: boolean;
  minTrade: number;
  minNotional: number;
  instruments: { id: number; paused: boolean; active: boolean; maxLeverage: number }[];
}

const C = 1e18;

/** Minimal cookie jar: their /intents endpoint is called with credentials in the browser; keep parity. */
class Jar {
  private cookies = new Map<string, string>();
  header(): string | undefined {
    if (!this.cookies.size) return undefined;
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  }
  absorb(res: Response) {
    const set = (res.headers as any).getSetCookie?.() as string[] | undefined;
    for (const c of set ?? []) {
      const kv = c.split(";")[0];
      const i = kv.indexOf("=");
      if (i > 0) this.cookies.set(kv.slice(0, i).trim(), kv.slice(i + 1).trim());
    }
  }
}

export class RelayerClient {
  private jar = new Jar();
  constructor(private base: string, private fetchImpl: typeof fetch = fetch) {}

  private async post(path: string, body: unknown, timeoutMs: number): Promise<RelayerResult> {
    const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json" };
    const cookie = this.jar.header();
    if (cookie) headers.cookie = cookie;
    const res = await this.fetchImpl(`${this.base}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    this.jar.absorb(res);
    let parsed: any = null;
    try {
      parsed = await res.json();
    } catch {
      /* non-JSON body */
    }
    if (!res.ok || parsed?.error || parsed?.code || parsed?.ok === false) {
      // Observed shapes: 403 {"code":"unauthorized_intent"}, bare 400, 409 {"code":"admission_rejected","reason":R}
      const code = parsed?.error ?? parsed?.code ?? `http_${res.status}`;
      const reason = typeof parsed?.reason === "string" ? parsed.reason : undefined;
      log.warn(`relayer ${path} → ${res.status} ${code}${reason ? `:${reason}` : ""}`);
      return { ok: false, error: String(code), reason, message: parsed?.message, httpStatus: res.status };
    }
    return { ok: true, intentId: parsed?.intentId != null ? String(parsed.intentId) : undefined, queueRevision: parsed?.queueRevision, httpStatus: res.status };
  }

  /** POST /intents {action, signed} */
  submitIntent(action: string, signed: Record<string, unknown>): Promise<RelayerResult> {
    return this.post("/intents", { action, signed }, 8000);
  }

  /** POST /intents/{id}/cancel — signed body WITHOUT intentId (it's in the URL), like their frontend */
  submitCancel(intentId: string, signedBody: Record<string, unknown>): Promise<RelayerResult> {
    if (!/^0x[0-9a-fA-F]{1,128}$/.test(intentId)) return Promise.resolve({ ok: false, error: "bad_intent_id" });
    return this.post(`/intents/${intentId}/cancel`, signedBody, 8000);
  }

  /** /state/trading → the subset the engine's veto checks need */
  async fetchProtoState(): Promise<ProtoState | null> {
    try {
      const res = await this.fetchImpl(`${this.base}/state/trading`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(5000) });
      if (!res.ok) return null;
      const j: any = await res.json();
      return {
        tradingPaused: !!j.tradingPaused,
        minTrade: Number(j.minimumTradeSizeRaw ?? "0") / C,
        minNotional: Number(j.minimumOpenNotionalRaw ?? "0") / C,
        instruments: (Array.isArray(j.instruments) ? j.instruments : []).map((r: any[]) => ({
          id: Number(r[0]),
          active: !!r[4],
          paused: !!r[5],
          maxLeverage: Number(r[14] ?? 1000),
        })),
      };
    } catch {
      return null;
    }
  }
}
