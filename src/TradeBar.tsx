// Bottom bar: Positions (open + queued intents with live queue rank + Cancel,
// plus each position's stop-loss), Triggers (server-side trigger entries + stops,
// see triggerApi.ts), History (closed trades), Status (protocol/queue).

import { useEffect, useState, type Ref } from "react";
import { useAccount } from "wagmi";
import type { WalletSnapshot, LivePosition, QueuedIntent } from "./liveAccount";
import {
  fetchQueueRank,
  fetchTradeHistory,
  fmtPrice,
  fmtUsd,
  timeAgo,
  relayerError,
  type TradeHistoryItem,
  type TradingState,
} from "./protocol";
import { useI18n, tr } from "./i18n";
import { cancelQueuedIntent, closePositionsIntent, sessionStatus } from "./session";
import { OrdersTab, StopCell, TriggerHistory, triggerCounts, useTriggerStore } from "./TriggerOrders";
import type { PriceSample, RemoteTriggerStore as TriggerStore } from "./triggerApi";

const SYMBOL: Record<number, string> = { 0: "BTC", 1: "ETH" };

type Tab = "positions" | "orders" | "history" | "status";

interface TradeBarProps {
  snapshot: WalletSnapshot | null;
  proto: TradingState | null;
  marks: Record<number, number>; // instrumentId → mark price
  onAction: (msg: string) => void;
  /** server-side trigger mirror for the connected wallet (null when disconnected) */
  trigStore?: TriggerStore | null;
  /** live samples for display (distance column, stop cell) — the server decides fires */
  trigSamples?: Record<number, PriceSample | undefined>;
  /** signed in + active key + watcher alive + not killed, so armed triggers can actually fire */
  sessionHealthy?: boolean;
  /** realized PnL by positionId, for executed stops */
  closedPnl?: Record<string, number>;
  /** explicit height once the user has dragged the divider (null = auto) */
  height?: number | null;
  barRef?: Ref<HTMLElement>;
}

function pnlOf(p: LivePosition, mark: number | undefined): number | null {
  if (!mark) return null;
  return (mark - p.entryPrice) * (p.isLong ? 1 : -1) * ((p.margin * p.leverage) / p.entryPrice);
}

/** 0 = at entry, 100 = at bust (their "{percent}% of the distance to bust"). */
function riskOf(p: LivePosition, mark: number | undefined): number | null {
  if (!mark) return null;
  const span = p.entryPrice - p.bustPrice;
  if (!span) return null;
  const travelled = (p.entryPrice - mark) / span; // >0 moving toward bust
  return Math.max(0, Math.min(1, travelled)) * 100;
}

function RiskCell({ p, mark }: { p: LivePosition; mark: number | undefined }) {
  const r = riskOf(p, mark);
  if (r == null) return <span className="muted">—</span>;
  const inBust = p.isLong ? mark! <= p.bustPrice : mark! >= p.bustPrice;
  return (
    <span
      className="risk"
      title={inBust ? tr("tb.riskBust") : tr("tb.riskPct", { p: r.toFixed(0) })}
    >
      <span className="risk-bar">
        <span className="risk-fill" style={{ width: `${inBust ? 100 : r}%` }} />
      </span>
      <i className={inBust || r > 80 ? "down" : undefined}>{inBust ? tr("tb.bustTag") : `${r.toFixed(0)}%`}</i>
    </span>
  );
}

function duration(ms: number): string {
  const s = Math.max(0, ms / 1000);
  if (s < 60) return `${Math.floor(s)}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${Math.floor(s % 60)}s`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
}

export default function TradeBar({
  snapshot,
  proto,
  marks,
  onAction,
  trigStore = null,
  trigSamples = {},
  sessionHealthy = false,
  closedPnl = {},
  height = null,
  barRef,
}: TradeBarProps) {
  const { t } = useI18n();
  const { address, isConnected } = useAccount();
  const [tab, setTab] = useState<Tab>("positions");
  // re-render this bar whenever the trigger store changes (arm/fire/cancel)
  useTriggerStore(trigStore);
  const trig = triggerCounts(trigStore);
  const [ranks, setRanks] = useState<Record<string, number>>({});
  const [history, setHistory] = useState<TradeHistoryItem[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const positions = snapshot?.openPositions ?? [];
  const queued = (snapshot?.operations ?? []).filter((o) => o.action === "openPosition");
  const closes = (snapshot?.operations ?? []).filter((o) => o.action === "closePositions");
  const closingIds = new Set(closes.flatMap((c) => c.closeIds ?? []));
  const count = positions.length + queued.length;

  // queue rank polling while anything is queued
  useEffect(() => {
    if (!address || !snapshot?.operations.length) {
      setRanks({});
      return;
    }
    let dead = false;
    const load = () => fetchQueueRank(address).then((r) => !dead && setRanks(r)).catch(() => {});
    load();
    const t = setInterval(load, 2500);
    return () => {
      dead = true;
      clearInterval(t);
    };
  }, [address, snapshot?.operations.length]);

  // history on demand
  useEffect(() => {
    if (tab !== "history" || !address) return;
    let dead = false;
    const load = () =>
      fetchTradeHistory(address).then((h) => !dead && setHistory(h)).catch(() => !dead && setHistory([]));
    load();
    const t = setInterval(load, 30_000);
    return () => {
      dead = true;
      clearInterval(t);
    };
  }, [tab, address, snapshot?.openPositions.length]);

  const session = address ? sessionStatus(address) : { state: "none" as const };
  const canAct = session.state === "active" || session.state === "unregistered";

  const doCancel = async (op: QueuedIntent) => {
    if (!address) return;
    setBusyId(op.intentId);
    try {
      const r = await cancelQueuedIntent(address, op.intentId);
      onAction(r.ok ? t("tb.cancelled") : relayerError(r.error, r.reason) ?? r.message ?? t("tb.cancelFailed"));
    } catch (e: any) {
      onAction(e?.shortMessage ?? e?.message ?? String(e));
    } finally {
      setBusyId(null);
    }
  };

  /** Cancel the queued intent a trigger produced, and mark the trigger with it. */
  const doCancelTrigger = async (itemId: string, intentId: string) => {
    if (!address) return;
    setBusyId(intentId);
    try {
      // the browser key can cancel it directly (same as the Positions tab); the
      // server marks the row so the watcher doesn't later read "left the queue" as executed
      const r = await cancelQueuedIntent(address, intentId);
      if (r.ok) void trigStore?.markCancelRequested(itemId);
      onAction(r.ok ? t("tb.cancelled") : relayerError(r.error, r.reason) ?? r.message ?? t("tb.cancelFailed"));
    } catch (e: any) {
      onAction(e?.shortMessage ?? e?.message ?? String(e));
    } finally {
      setBusyId(null);
    }
  };

  const doClose = async (ids: string[]) => {
    if (!address || !ids.length) return;
    setBusyId(ids[0]);
    try {
      const r = await closePositionsIntent(address, ids.map(BigInt));
      onAction(r.ok ? t("tb.closeQueued", { n: ids.length }) : relayerError(r.error, r.reason) ?? r.message ?? t("tb.closeFailed"));
    } catch (e: any) {
      onAction(e?.shortMessage ?? e?.message ?? String(e));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <section
      className={height != null ? "tradebar sized" : "tradebar"}
      ref={barRef}
      style={height != null ? { height } : undefined}
    >
      <div className="tradebar-head">
        <div className="tradebar-tabs">
          <button className={tab === "positions" ? "tbtab on" : "tbtab"} onClick={() => setTab("positions")}>
            {t("tb.positions")}{count ? ` ${count}` : ""}
          </button>
          <button
            className={tab === "orders" ? "tbtab on" : "tbtab"}
            onClick={() => setTab("orders")}
          >
            {t("tb.orders")}
            {trig.live ? ` ${trig.live}` : ""}
            {trig.attention > 0 && <i className="tbtab-dot" aria-hidden />}
          </button>
          <button className={tab === "history" ? "tbtab on" : "tbtab"} onClick={() => setTab("history")}>
            {t("tb.history")}
          </button>
          <button className={tab === "status" ? "tbtab on" : "tbtab"} onClick={() => setTab("status")}>
            {t("tb.status")}
          </button>
        </div>
        {tab === "positions" && (
          <div className="open-pos-row">
            <span className="open-pos-label">
              {t("tb.openPositions")} — <b className="numeric">{isConnected ? positions.length : "–"}</b>
            </span>
            <button
              className="close-btn"
              disabled={!canAct || busyId != null || positions.length === 0}
              onClick={() => doClose(positions.filter((p) => !closingIds.has(p.positionId)).map((p) => p.positionId))}
            >
              {t("tb.closeAll")}
            </button>
          </div>
        )}
      </div>

      {tab === "positions" && (
        <div className="tb-table">
          <div className="tb-row tb-pos tb-header">
            <span>{t("tb.asset")}</span>
            <span>{t("tb.notional")}</span>
            <span>{t("tb.entry")}</span>
            <span>{t("tb.mark")}</span>
            <span>{t("tb.pnl")}</span>
            <span>{t("tb.bust")}</span>
            <span>{t("tb.risk")}</span>
            <span>{t("tb.margin")}</span>
            <span>{t("tb.stopCol")}</span>
            <span>{t("tb.when")}</span>
            <span />
          </div>

          {!isConnected && <div className="tb-empty">{t("tb.connectPositions")}</div>}
          {isConnected && count === 0 && <div className="tb-empty">{t("tb.noOpen")}</div>}

          {queued.map((op) => {
            const rank = ranks[op.intentId];
            const mark = op.instrumentId != null ? marks[op.instrumentId] : undefined;
            return (
              <div className="tb-row tb-pos queued" key={op.intentId}>
                <span>
                  <b>{op.instrumentId != null ? SYMBOL[op.instrumentId] ?? `#${op.instrumentId}` : "—"}</b>{" "}
                  <i className={op.isLong ? "up" : "down"}>
                    {op.leverage ? `${op.leverage}× ` : ""}
                    {op.isLong == null ? "" : t(op.isLong ? "house.long" : "house.short").toUpperCase()}
                  </i>{" "}
                  <em className="queue-tag">{rank != null ? t("tb.queueN", { n: rank }) : t("tb.queued")}</em>
                </span>
                <span>{op.amount != null && op.leverage ? fmtUsd(op.amount * op.leverage) : "—"}</span>
                <span>—</span>
                <span>{mark ? fmtPrice(mark) : "—"}</span>
                <span className="muted">{t("tb.queuedDots")}</span>
                <span>—</span>
                <span>—</span>
                <span>{op.amount != null ? op.amount.toFixed(2) : "—"}</span>
                <span className="muted">—</span>
                <span>{timeAgo(op.timeMs)}</span>
                <span>
                  <button className="close-btn" disabled={!canAct || busyId === op.intentId} onClick={() => doCancel(op)}>
                    {busyId === op.intentId ? t("tb.cancelling") : t("tb.cancel")}
                  </button>
                </span>
              </div>
            );
          })}

          {positions.map((p) => {
            const mark = marks[p.instrumentId];
            const pnl = pnlOf(p, mark);
            const pct = pnl != null ? (pnl / p.margin) * 100 : null;
            const closing = closingIds.has(p.positionId);
            return (
              <div className="tb-row tb-pos" key={p.positionId}>
                <span>
                  <b>{SYMBOL[p.instrumentId] ?? `#${p.instrumentId}`}</b>{" "}
                  <i className={p.isLong ? "up" : "down"}>
                    {p.leverage}× {t(p.isLong ? "house.long" : "house.short").toUpperCase()}
                  </i>
                </span>
                <span>{fmtUsd(p.margin * p.leverage)}</span>
                <span>{fmtPrice(p.entryPrice)}</span>
                <span>{mark ? fmtPrice(mark) : "—"}</span>
                <span className={pnl != null && pnl < 0 ? "down" : "up"}>
                  {pnl != null ? `${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)} (${pct!.toFixed(1)}%)` : "—"}
                </span>
                <span className="down">{fmtPrice(p.bustPrice)}</span>
                <RiskCell p={p} mark={mark} />
                <span>{p.margin.toFixed(2)}</span>
                <span>
                  <StopCell
                    store={trigStore}
                    position={p}
                    mark={mark}
                    livePrice={trigSamples[p.instrumentId]?.price}
                    onNote={onAction}
                  />
                </span>
                <span title={new Date(p.openedAtMs).toLocaleString()}>{timeAgo(p.openedAtMs)}</span>
                <span>
                  <button
                    className="close-btn"
                    disabled={!canAct || closing || busyId === p.positionId}
                    onClick={() => doClose([p.positionId])}
                  >
                    {closing ? t("tb.closing") : busyId === p.positionId ? "…" : t("tb.close")}
                  </button>
                </span>
              </div>
            );
          })}
        </div>
      )}

      {tab === "orders" && (
        <OrdersTab
          store={trigStore}
          samples={trigSamples}
          marks={marks}
          ranks={ranks}
          closedPnl={closedPnl}
          sessionHealthy={sessionHealthy}
          isConnected={isConnected}
          onCancelQueued={doCancelTrigger}
          onNote={onAction}
        />
      )}

      {tab === "history" && (
        <div className="tb-table">
          <div className="tb-row tb-history tb-header">
            <span>{t("tb.asset")}</span>
            <span>{t("tb.notional")}</span>
            <span>{t("tb.entryExit")}</span>
            <span>{t("tb.pnl")}</span>
            <span>{t("tb.fee")}</span>
            <span>{t("tb.margin")}</span>
            <span>{t("tb.duration")}</span>
            <span>{t("tb.outcome")}</span>
            <span>{t("tb.when")}</span>
          </div>
          {!isConnected && <div className="tb-empty">{t("tb.connectHistory")}</div>}
          {isConnected && history == null && <div className="tb-empty">{t("tb.loadingHistory")}</div>}
          {isConnected && history != null && history.length === 0 && (
            <div className="tb-empty">{t("tb.noHistory")}</div>
          )}
          {(history ?? []).map((h) => (
            <div className="tb-row tb-history" key={`${h.positionId}-${h.timestampMs}`}>
              <span>
                <b>{h.symbol}</b>{" "}
                <i className={h.isLong ? "up" : "down"}>
                  {h.leverage}× {t(h.isLong ? "house.long" : "house.short").toUpperCase()}
                </i>
              </span>
              <span>{fmtUsd(h.margin * h.leverage)}</span>
              <span>
                {fmtPrice(h.entryPrice)} <span className="muted">→</span> {fmtPrice(h.exitPrice)}
              </span>
              <span className={h.netPnl < 0 ? "down" : "up"}>
                {h.netPnl >= 0 ? "+" : ""}${h.netPnl.toFixed(2)}{" "}
                <small>({((h.netPnl / h.margin) * 100).toFixed(1)}%)</small>
              </span>
              <span>${h.feePaid.toFixed(2)}</span>
              <span>{h.margin.toFixed(2)}</span>
              <span>{h.openedAtMs ? duration(h.timestampMs - h.openedAtMs) : "—"}</span>
              <span>
                <em className={h.liquidated ? "outcome liq" : "outcome"}>{h.liquidated ? t("tb.liquidated") : t("tb.closed")}</em>
              </span>
              <span title={new Date(h.timestampMs).toLocaleString()}>{timeAgo(h.timestampMs)}</span>
            </div>
          ))}
          {isConnected && <TriggerHistory store={trigStore} closedPnl={closedPnl} />}
        </div>
      )}

      {tab === "status" && (
        <div className="tb-status">
          <div className="kv">
            <span>{t("tb.protocol")}</span>
            <b>{proto ? (proto.tradingPaused ? t("tb.tradingPaused") : t("tb.tradingLive")) : "…"}</b>
          </div>
          <div className="kv">
            <span>{t("tb.minTrade")}</span>
            <b>{proto ? t("tb.minTradeVal", { m: proto.minimumTradeUsdc, n: fmtUsd(proto.minimumOpenNotionalUsdc) }) : "…"}</b>
          </div>
          {(proto?.instruments ?? []).map((i) => (
            <div className="kv" key={i.id}>
              <span>{t("tb.openInterestOf", { sym: i.symbol })}</span>
              <b>
                {marks[i.id]
                  ? `▲ ${fmtUsd(i.longOi * marks[i.id])} / ▼ ${fmtUsd(i.shortOi * marks[i.id])}`
                  : "…"}
              </b>
            </div>
          ))}
          <div className="hint small">
            {t("tb.disclaimer")}
          </div>
        </div>
      )}
    </section>
  );
}
