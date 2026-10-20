// Trigger UI: the "Triggers" tab in the bottom bar + the per-position stop cell
// in the Positions table. Enabling (sign in → key → registration) is driven by
// the ticket's big button and TriggerSetup.tsx; this tab shows the state of it
// in one status strip and offers the same actions for people who look here first.
//
// Copy is deliberately blunt: a trigger fires a *market* order when price
// crosses the level; the fill price is whatever the queue gives and is NOT
// guaranteed. A stop is a best-effort market close fired from this tab, so the
// word "protected" is never used for one.

import { useEffect, useState, useSyncExternalStore } from "react";
import { useWalletClient, useWriteContract } from "wagmi";
import { SESSION_KEY_MANAGER_ABI } from "../shared/contracts";
import {
  STALE_MS,
  STOP_BUST_MIN_BUFFER,
  TRIGGER_ERROR_KEYS,
  attachedStopLevel,
  attachedStopProblem,
  attachedTpLevel,
  attachedTpProblem,
  exitOf,
  isTerminal,
  stopHit,
  type AttachedStop,
  type ExitKind,
  type PriceSample,
  type StopLoss,
  type TriggerEntry,
  type TriggerStatus,
  type WalletPolicy,
} from "../shared/triggerLogic";
import { CONTRACTS, hyperevm } from "./chain";
import { MARKETS } from "./feed";
import { useI18n, type Key as I18nKey } from "./i18n";
import type { LivePosition } from "./liveAccount";
import { fmtPrice, fmtUsd, timeAgo } from "./protocol";
import type { ApiResult, RemoteTriggerStore as TriggerStore } from "./triggerApi";
import { TriggerSetupModal, apiErrorText, isUserRejection, triggerPhase, type TFn } from "./TriggerSetup";

export { apiErrorText } from "./TriggerSetup";

const SYMBOL: Record<number, string> = Object.fromEntries(
  Object.entries(MARKETS).map(([k, v]) => [v.id, k])
);
const symbolOf = (instrumentId: number) => SYMBOL[instrumentId] ?? `#${instrumentId}`;
const cmpOf = (cross: "down-to" | "up-to") => (cross === "down-to" ? "≤" : "≥");
/** a long stop fires at/below its price, a short stop at/above; a take-profit is the mirror */
const stopCmp = (isLong: boolean, exit: ExitKind = "stop") => ((exit === "tp") !== isLong ? "≤" : "≥");
const typeKey = (item: StopLoss | TriggerEntry, isEntry: boolean): I18nKey =>
  isEntry ? "trig.type.entry" : exitOf(item as StopLoss) === "tp" ? "trig.type.tp" : (item as StopLoss).trail ? "trig.type.trail" : "trig.type.stop";
const typeClass = (item: StopLoss | TriggerEntry, isEntry: boolean) => (isEntry ? "muted" : exitOf(item as StopLoss) === "tp" ? "trig-type-tp" : "trig-type-stop");

const LIVE: ReadonlySet<TriggerStatus> = new Set(["armed", "confirming", "firing"]);
const isLive = (s: TriggerStatus) => LIVE.has(s);
/** grace after arming before a missing heartbeat feed entry counts as "stale" */
const FEED_WARMUP_MS = 20_000;

function errText(t: TFn, error?: string): string | null {
  if (!error) return null;
  const key = TRIGGER_ERROR_KEYS[error];
  return key ? t(key as I18nKey) : error;
}

/** signed PnL if a position were closed at `price` (estimate, ignores fees) */
function pnlAt(p: LivePosition, price: number): number {
  return (price - p.entryPrice) * (p.isLong ? 1 : -1) * ((p.margin * p.leverage) / p.entryPrice);
}

/** Subscribe to a store that may not exist yet (hooks can't be conditional). */
const noSub = () => () => {};
const noVersion = () => 0;
export function useTriggerStore(store: TriggerStore | null): number {
  return useSyncExternalStore(store?.subscribe ?? noSub, store?.getVersion ?? noVersion);
}

/** Badge counts for the Orders tab label. */
export function triggerCounts(store: TriggerStore | null): { live: number; attention: number } {
  if (!store) return { live: 0, attention: 0 };
  const all = [...store.entries, ...store.stops];
  return {
    live: all.filter((x) => isLive(x.status)).length,
    // only states that still sit in the Orders tab (unreconciled is terminal → History)
    attention: all.filter((x) => x.status === "attention" || x.status === "unknown").length,
  };
}

function Chip({ status }: { status: TriggerStatus }) {
  const { t } = useI18n();
  return <span className={`trig-chip ${status}`}>{t(`trig.status.${status}` as I18nKey)}</span>;
}

// ---------------------------------------------------------------------------
// Positions table: the stop cell
// ---------------------------------------------------------------------------

/**
 * One cell in the open-positions row. Collapsed it is either the armed exit or
 * a "+ Stop" / "+ TP" button; expanded it is a price box. Arming when price is
 * already past the level needs a second click (it closes the position
 * immediately). `exit` picks the side: a stop lives on the loss side and is
 * checked against the bust price; a take-profit lives on the profit side and
 * only has to be past the entry.
 */
export function StopCell({
  store,
  position,
  mark,
  livePrice,
  onNote,
  exit = "stop",
}: {
  store: TriggerStore | null;
  position: LivePosition;
  mark: number | undefined;
  livePrice: number | undefined;
  onNote: (msg: string) => void;
  exit?: ExitKind;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [confirmPast, setConfirmPast] = useState(false);
  const [trailOn, setTrailOn] = useState(false);
  const isTp = exit === "tp";

  if (!store) return <span className="muted">—</span>;
  // every mutation is a round-trip now — a rejection must be said out loud, not swallowed
  const report = (p: Promise<ApiResult>) =>
    p.then((r) => {
      if (!r.ok) onNote(apiErrorText(t, r));
    });

  const current = store.stopFor(position.positionId, exit);
  const armed = current && current.status !== "attention" ? current : undefined;
  const attention = current?.status === "attention" ? current : undefined;
  const priceRef = livePrice ?? mark;
  const signed = (v: number) => `${v >= 0 ? "+" : "−"}${fmtUsd(Math.abs(v))}`;

  if (armed) {
    const pnl = pnlAt(position, armed.stopPrice);
    const bustBuffer = mark != null ? (Math.abs(armed.stopPrice - position.bustPrice) / mark) * 100 : null;
    const tight = !isTp && bustBuffer != null && bustBuffer < STOP_BUST_MIN_BUFFER * 100;
    return (
      <span className="stopcell">
        <b
          className={tight ? "stop-at warn-text" : isTp ? "stop-at tp-at" : "stop-at"}
          title={t(isTp ? "trig.gainAtTp" : "trig.lossAtStop", {
            pnl: signed(pnl),
            pct: ((pnl / position.margin) * 100).toFixed(1),
          })}
        >
          {armed.trail ? "T " : ""}
          {stopCmp(armed.isLong, exit)} {fmtPrice(armed.stopPrice)}
        </b>
        {armed.status !== "armed" && <Chip status={armed.status} />}
        <button className="xbtn" title={t("trig.cancel")} onClick={() => report(store.cancel(armed.id))}>
          ×
        </button>
      </span>
    );
  }

  if (attention) {
    const needsConfirm = priceRef != null && stopHit(priceRef, attention);
    return (
      <span className="stopcell">
        <b className="stop-at warn-text" title={t("trig.attentionNote")}>
          {stopCmp(attention.isLong, exit)} {fmtPrice(attention.stopPrice)}
        </b>
        <button
          className="close-btn warn"
          title={needsConfirm ? t("trig.confirmPast") : t("trig.attentionNote")}
          onClick={() => {
            if (needsConfirm && !confirmPast) {
              setConfirmPast(true);
              onNote(t("trig.confirmPast"));
              return;
            }
            report(store.rearm(attention.id));
            setConfirmPast(false);
          }}
        >
          {t("trig.rearm")}
        </button>
        <button className="xbtn" title={t("trig.cancel")} onClick={() => report(store.cancel(attention.id))}>
          ×
        </button>
      </span>
    );
  }

  if (!open)
    return (
      <span className="stopcell">
        <button className={isTp ? "addstop addtp" : "addstop"} onClick={() => setOpen(true)} title={t(isTp ? "trig.tpClosesEntire" : "trig.closesEntire")}>
          {t(isTp ? "trig.addTp" : "trig.addStop")}
        </button>
      </span>
    );

  const typed = Number(text);
  const trailPct = trailOn && !isTp;
  const stopPrice = trailPct && priceRef != null && typed > 0
    ? position.isLong ? priceRef * (1 - typed / 100) : priceRef * (1 + typed / 100)
    : typed;
  const valid = text.trim() !== "" && Number.isFinite(stopPrice) && stopPrice > 0 && (!trailPct || typed <= 50);
  const beyondBust = !isTp && valid && (position.isLong ? stopPrice < position.bustPrice : stopPrice > position.bustPrice);
  // a take-profit on the loss side of the entry would lock in a loss, not a profit
  const wrongSide = isTp && valid && (position.isLong ? stopPrice <= position.entryPrice : stopPrice >= position.entryPrice);
  const pastMarket = valid && priceRef != null && stopHit(priceRef, { isLong: position.isLong, stopPrice, exit });

  const warn = !valid
    ? null
    : isTp
      ? wrongSide
        ? t("trig.warn.tpWrongSide", { entry: fmtPrice(position.entryPrice) })
        : pastMarket
          ? t("trig.warn.pastMarket")
          : null
      : beyondBust
        ? t("trig.warn.bustFirst", { bust: fmtPrice(position.bustPrice) })
        : priceRef != null && Math.abs(stopPrice - position.bustPrice) / priceRef < STOP_BUST_MIN_BUFFER
          ? t("trig.warn.bustBuffer")
          : Math.abs(stopPrice - position.bustPrice) <= 0.1 * Math.abs(position.entryPrice - position.bustPrice)
            ? t("trig.warn.bustClose")
            : pastMarket
              ? t("trig.warn.pastMarket")
              : null;

  const arm = () => {
    if (!valid) return;
    // Anything risky (already past the level, beyond the bust price, or inside
    // the bust buffer) takes a second click. The cell is too narrow to show the
    // warning inline, so it goes out as a notice — never only as a tooltip.
    if (warn && !confirmPast) {
      setConfirmPast(true);
      onNote(pastMarket ? t("trig.confirmPast") : warn);
      return;
    }
    const pnl = pnlAt(position, stopPrice);
    void store
      .armStop({
        positionId: position.positionId,
        instrumentId: position.instrumentId,
        isLong: position.isLong,
        stopPrice,
        ...(isTp ? { exit: "tp" as const } : {}),
        ...(!isTp && trailOn ? { trail: { mode: "pct" as const, value: typed / 100 } } : {}),
      })
      .then((r) =>
        onNote(
          r.ok
            ? t(isTp ? "trig.noticeTpArmed" : "trig.noticeArmed", {
                market: symbolOf(position.instrumentId),
                cmp: stopCmp(position.isLong, exit),
                price: fmtPrice(stopPrice),
                pnl: signed(pnl),
              })
            : apiErrorText(t, r)
        )
      );
    setOpen(false);
    setText("");
    setConfirmPast(false);
  };

  return (
    <span className="stopcell open">
      {!isTp && (
        <button
          className={trailOn ? "addstop addtp" : "addstop"}
          title={t("trig.trailWhy")}
          onClick={() => {
            setTrailOn((v) => !v);
            setText((cur) => (cur.trim() === "" ? "2" : cur));
            setConfirmPast(false);
          }}
        >
          {t("trig.trail")}
        </button>
      )}
      <input
        type="number"
        inputMode="decimal"
        min={0}
        step="any"
        autoFocus
        className={warn ? "warn-input" : undefined}
        title={warn ?? t(isTp ? "trig.tpClosesEntire" : "trig.closesEntire")}
        aria-label={t(isTp ? "trig.tpPrice" : "trig.stopPrice")}
        placeholder={trailOn && !isTp ? t("trig.trailPct") : t(isTp ? "trig.tpPrice" : "trig.stopPrice")}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setConfirmPast(false);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") arm();
          if (e.key === "Escape") {
            setOpen(false);
            setText("");
            setConfirmPast(false);
          }
        }}
      />
      <button className={confirmPast ? "addstop warn" : "addstop"} disabled={!valid} onClick={arm}>
        {confirmPast ? t("trig.confirm") : t("trig.arm")}
      </button>
      <button
        className="xbtn"
        title={t("trig.cancel")}
        onClick={() => {
          setOpen(false);
          setText("");
          setConfirmPast(false);
        }}
      >
        ×
      </button>
    </span>
  );
}

/** "−2 %" / "+4 %" or "≤ 80,000" — how an attached exit reads in a cell */
function attachedStopText(a: AttachedStop, isLong: boolean, exit: ExitKind = "stop"): string {
  const core =
    a.mode === "pct"
      ? `${exit === "tp" ? "+" : "−"}${(a.value * 100).toFixed(a.value * 100 < 1 ? 2 : 1).replace(/\.0$/, "")} %`
      : `${stopCmp(isLong, exit)} ${fmtPrice(a.value)}`;
  return a.trail ? `T ${core}` : core;
}

/** default % offsets for a fresh attached exit: 2 % stop, 4 % take-profit (a 2R bracket) */
const DEFAULT_PCT: Record<ExitKind, string> = { stop: "2", tp: "4" };

/**
 * The stop / take-profit a WAITING entry will get the moment it fills. Same
 * shape as StopCell, but nothing exists on-chain yet: the server stores the
 * intent (% from fill or fixed price) and spawns the real exit at execution.
 */
function EntryStopCell({ store, entry, onNote, which = "stop" }: { store: TriggerStore; entry: TriggerEntry; onNote: (msg: string) => void; which?: ExitKind }) {
  const { t } = useI18n();
  const isTp = which === "tp";
  const a = (isTp ? entry.attachedTp : entry.attachedStop) ?? null;
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"pct" | "price">(a?.mode ?? "pct");
  const [text, setText] = useState("");
  const [trailOn, setTrailOn] = useState(!!a?.trail);
  const report = (p: Promise<ApiResult>) =>
    p.then((r) => {
      if (!r.ok) onNote(apiErrorText(t, r));
    });
  const editable = entry.status === "armed" || entry.status === "confirming" || entry.status === "attention";
  const levelOf = (x: AttachedStop) => (isTp ? attachedTpLevel(x, entry.isLong, entry.triggerPrice) : attachedStopLevel(x, entry.isLong, entry.triggerPrice));

  if (!editable) {
    // fired / queued: the server will spawn it at the fill; nothing to edit any more
    return a ? (
      <span className="stopcell" title={t(isTp ? "trig.tpOnFillPending" : "trig.stopOnFillPending")}>
        <b className="stop-at muted">{attachedStopText(a, entry.isLong, which)}</b>
      </span>
    ) : null;
  }

  if (!open) {
    return a ? (
      <span className="stopcell">
        <b
          className={isTp ? "stop-at tp-at" : "stop-at"}
          title={t(isTp ? "trig.tpOnFillLine" : "trig.stopOnFillLine", { level: fmtPrice(levelOf(a)) })}
          onClick={() => {
            setMode(a.mode);
            setText(a.mode === "pct" ? String(Math.round(a.value * 10000) / 100) : String(a.value));
            setOpen(true);
          }}
        >
          {attachedStopText(a, entry.isLong, which)}
        </b>
        <button className="xbtn" title={t("trig.cancel")} onClick={() => report(store.setEntryStop(entry.id, null, which))}>
          ×
        </button>
      </span>
    ) : (
      <span className="stopcell">
        <button
          className={isTp ? "addstop addtp" : "addstop"}
          title={t(isTp ? "ticket.tpOnFillWhy" : "ticket.stopOnFillWhy")}
          onClick={() => {
            setMode("pct");
            setText(DEFAULT_PCT[which]);
            setOpen(true);
          }}
        >
          {t(isTp ? "trig.addTp" : "trig.addStop")}
        </button>
      </span>
    );
  }

  const n = Number(text);
  const typed = text.trim() !== "" && Number.isFinite(n) && n > 0;
  const next: AttachedStop | null = typed ? { mode, value: mode === "pct" ? n / 100 : n, ...( !isTp && trailOn ? { trail: true } : {}) } : null;
  const problem = next ? (isTp ? attachedTpProblem(next, entry) : attachedStopProblem(next, entry)) : null;
  const warn =
    problem === "wrong-side" ? t(isTp ? "ticket.p.tpWrongSide" : "ticket.p.stopWrongSide") : problem === "beyond-bust" ? t("ticket.p.stopBeyondBust") : null;
  const close = () => {
    setOpen(false);
    setText("");
  };
  const save = () => {
    if (!next || warn) return;
    void store.setEntryStop(entry.id, next, which).then((r) => {
      if (!r.ok) onNote(apiErrorText(t, r));
      else onNote(t(isTp ? "trig.tpOnFillSet" : "trig.stopOnFillSet", { level: fmtPrice(levelOf(next)) }));
    });
    close();
  };

  return (
    <span className="stopcell open">
      <button
        className="qb"
        title={mode === "pct" ? t("trig.stopModePct") : t("trig.stopModePrice")}
        onClick={() => {
          // flipping the unit converts the current value instead of leaving "2" to be read as $2
          if (mode === "pct") {
            const pct = typed ? n / 100 : Number(DEFAULT_PCT[which]) / 100;
            const adverse = entry.isLong !== isTp; // stop on a long / TP on a short sit below the trigger
            setText(String(Math.round(entry.triggerPrice * (adverse ? 1 - pct : 1 + pct) * 10) / 10));
            setMode("price");
          } else {
            setText(DEFAULT_PCT[which]);
            setMode("pct");
          }
        }}
      >
        {mode === "pct" ? "%" : "$"}
      </button>
      {!isTp && (
        <button className={trailOn ? "addstop addtp" : "addstop"} title={t("trig.trailWhy")} onClick={() => setTrailOn((v) => !v)}>
          {t("trig.trail")}
        </button>
      )}
      <input
        type="number"
        inputMode="decimal"
        min={0}
        step="any"
        autoFocus
        className={warn ? "warn-input" : undefined}
        title={warn ?? t(isTp ? "ticket.tpOnFillWhy" : "ticket.stopOnFillWhy")}
        aria-label={t(isTp ? "ticket.tpOnFill" : "ticket.stopOnFill")}
        placeholder={mode === "pct" ? DEFAULT_PCT[which] : t(isTp ? "trig.tpPrice" : "trig.stopPrice")}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") save();
          if (e.key === "Escape") close();
        }}
      />
      <button className="addstop" disabled={!typed || !!warn} title={warn ?? undefined} onClick={save}>
        {t("trig.arm")}
      </button>
      <button className="xbtn" title={t("trig.cancel")} onClick={close}>
        ×
      </button>
    </span>
  );
}

// ---------------------------------------------------------------------------
// Orders tab
// ---------------------------------------------------------------------------

type Row =
  | { kind: "entry"; item: TriggerEntry }
  | { kind: "stop"; item: StopLoss };

/** live items first, then most recent */
function sortRows(a: Row, b: Row): number {
  const al = isLive(a.item.status) ? 0 : 1;
  const bl = isLive(b.item.status) ? 0 : 1;
  return al !== bl ? al - bl : b.item.createdAt - a.item.createdAt;
}

function OrderRow({
  row,
  store,
  samples,
  marks,
  ranks,
  closedPnl,
  sessionHealthy,
  onCancelQueued,
  onNote,
}: {
  row: Row;
  store: TriggerStore;
  samples: Record<number, PriceSample | undefined>;
  marks: Record<number, number>;
  ranks: Record<string, number>;
  closedPnl: Record<string, number>;
  sessionHealthy: boolean;
  onCancelQueued: (itemId: string, intentId: string) => void;
  onNote: (msg: string) => void;
}) {
  const { t } = useI18n();
  const report = (p: Promise<ApiResult>) =>
    p.then((r) => {
      if (!r.ok) onNote(apiErrorText(t, r));
    });
  const isEntry = row.kind === "entry";
  const item = row.item;
  const live = isLive(item.status);
  const level = isEntry ? (item as TriggerEntry).triggerPrice : (item as StopLoss).stopPrice;
  const cmp = isEntry ? cmpOf((item as TriggerEntry).cross) : stopCmp((item as StopLoss).isLong, exitOf(item as StopLoss));
  const price = samples[item.instrumentId]?.price ?? marks[item.instrumentId];
  const distance = price != null && level > 0 ? ((price - level) / price) * 100 : null;

  const entry = isEntry ? (item as TriggerEntry) : null;
  const stop = isEntry ? null : (item as StopLoss);
  const err =
    item.status === "failed"
      ? errText(t, isEntry ? entry!.error : stop!.error)
      : live && stop?.lastError
        ? t("trig.lastError", { error: errText(t, stop.lastError) ?? stop.lastError })
        : null;

  const note =
    item.status === "unknown"
      ? t("trig.unknownNote")
      : item.status === "unreconciled"
        ? t("trig.unreconciledNote")
        : item.status === "attention"
          ? t("trig.attentionNote")
          : entry?.status === "executed" && entry.executedPrice != null
            ? t("trig.slippage", {
                exec: fmtPrice(entry.executedPrice),
                trig: fmtPrice(entry.triggerPrice),
                pct: `${entry.executedPrice >= entry.triggerPrice ? "+" : ""}${(
                  ((entry.executedPrice - entry.triggerPrice) / entry.triggerPrice) *
                  100
                ).toFixed(2)}%`,
              })
            : stop?.status === "executed" && closedPnl[stop.positionId] != null
              ? t("trig.stopPnl", {
                  pnl: `${closedPnl[stop.positionId] >= 0 ? "+" : ""}${fmtUsd(closedPnl[stop.positionId])}`,
                })
              : live && !sessionHealthy
                ? t("trig.unprotected")
                : null;

  const rank = item.status === "queued" && item.intentId ? ranks[item.intentId] : undefined;

  return (
    <div className="tb-row tb-orders">
      <span>
        <b>{symbolOf(item.instrumentId)}</b>{" "}
        <i className={item.isLong ? "up" : "down"}>
          {entry ? `${entry.leverage}× ` : ""}
          {t(item.isLong ? "house.long" : "house.short").toUpperCase()}
        </i>
      </span>
      <span className={typeClass(item, isEntry)}>{t(typeKey(item, isEntry))}</span>
      <span>
        {cmp} {fmtPrice(level)}
      </span>
      <span>{entry ? fmtUsd(entry.marginUsdc) : "—"}</span>
      <span className={distance != null && Math.abs(distance) < 0.25 ? "warn-text" : undefined}>
        {live && distance != null ? `${distance >= 0 ? "" : "+"}${Math.abs(distance).toFixed(2)}%` : "—"}
      </span>
      <span className="muted">
        {entry?.expiresAt != null && live
          ? new Date(entry.expiresAt).toLocaleTimeString()
          : item.status === "queued" && rank != null
            ? t("trig.queueRank", { n: rank })
            : "—"}
      </span>
      <span>
        <Chip status={item.status} />
        {(err || note) && <em className={err ? "trig-err" : "muted"}> {err ?? note}</em>}
      </span>
      <span className="trig-actions">
        {entry && <EntryStopCell store={store} entry={entry} onNote={onNote} which="stop" />}
        {entry && <EntryStopCell store={store} entry={entry} onNote={onNote} which="tp" />}
        {entry?.groupId && live && (
          <button
            className="close-btn"
            title={t("ladder.cancelRest")}
            onClick={() =>
              void store.cancelGroup(entry.groupId!).then((r) => onNote(r.ok ? t("ladder.cancelled") : apiErrorText(t, r)))
            }
          >
            {t("ladder.cancelRest")}
          </button>
        )}
        {live && (
          <button className="close-btn" onClick={() => report(store.cancel(item.id))}>
            {t("trig.cancel")}
          </button>
        )}
        {item.status === "attention" && (
          <button className="close-btn warn" onClick={() => report(store.rearm(item.id))}>
            {t("trig.rearm")}
          </button>
        )}
        {item.status === "queued" && item.intentId && (
          <button className="close-btn" onClick={() => onCancelQueued(item.id, item.intentId!)}>
            {t("trig.cancelQueued")}
          </button>
        )}
      </span>
    </div>
  );
}


// ---------------------------------------------------------------------------
// Setup / health panel: sign-in → enable key → status, plus revoke
// ---------------------------------------------------------------------------

function fmtAge(ms: number): string {
  if (ms < 60_000) return `${Math.max(0, Math.round(ms / 1000))}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h`;
  return `${Math.round(ms / 86_400_000)}d`;
}

/**
 * One status strip above the table. Left: where enabling stands — or, once the
 * key is active, the live / paused switch — with the single action that moves
 * it on. Right: the key and its revoke links. Real problems (watcher offline,
 * operator pause, expiring key) are one-line banners under it; nothing else.
 */
function PolicyLimits({ store, onNote }: { store: TriggerStore; onNote: (msg: string) => void }) {
  const { t } = useI18n();
  const me = store.me;
  const policy = me?.policy ?? {};
  const day = me?.day;
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [maxNotional, setMaxNotional] = useState("");
  const [maxExposure, setMaxExposure] = useState("");
  const [dailyLoss, setDailyLoss] = useState("");
  const [maxFires, setMaxFires] = useState("");
  const [maxLev, setMaxLev] = useState("");
  const [btc, setBtc] = useState(true);
  const [eth, setEth] = useState(true);

  useEffect(() => {
    if (!me) return;
    const p = me.policy ?? {};
    setMaxNotional(p.maxNotionalPerFire != null ? String(p.maxNotionalPerFire) : "");
    setMaxExposure(p.maxTriggerExposure != null ? String(p.maxTriggerExposure) : "");
    setDailyLoss(p.dailyLossStop != null ? String(p.dailyLossStop) : "");
    setMaxFires(p.maxFiresPerDay != null ? String(p.maxFiresPerDay) : "");
    setMaxLev(p.maxLeverage != null ? String(p.maxLeverage) : "");
    const allow = p.allowedInstruments;
    setBtc(!allow || allow.includes(MARKETS.BTC.id));
    setEth(!allow || allow.includes(MARKETS.ETH.id));
  }, [me, open]);

  const num = (s: string): number | null => {
    const n = Number(s);
    return s.trim() === "" ? null : Number.isFinite(n) && n > 0 ? n : null;
  };

  const save = async () => {
    const next: WalletPolicy = {};
    const a = num(maxNotional);
    const b = num(maxExposure);
    const c = num(dailyLoss);
    const d = num(maxFires);
    const e = num(maxLev);
    if (maxNotional.trim() && a == null) return onNote(t("policy.bad"));
    if (maxExposure.trim() && b == null) return onNote(t("policy.bad"));
    if (dailyLoss.trim() && c == null) return onNote(t("policy.bad"));
    if (maxFires.trim() && (d == null || !Number.isInteger(d))) return onNote(t("policy.bad"));
    if (maxLev.trim() && (e == null || !Number.isInteger(e))) return onNote(t("policy.bad"));
    if (a != null) next.maxNotionalPerFire = a;
    if (b != null) next.maxTriggerExposure = b;
    if (c != null) next.dailyLossStop = c;
    if (d != null) next.maxFiresPerDay = d;
    if (e != null) next.maxLeverage = e;
    if (btc !== eth) next.allowedInstruments = [btc ? MARKETS.BTC.id : MARKETS.ETH.id];
    setBusy(true);
    const r = await store.setPolicy(next);
    setBusy(false);
    if (!r.ok) onNote(apiErrorText(t, r));
    else {
      onNote(t("policy.saved"));
      setOpen(false);
    }
  };

  const tripped = day?.tripped;
  const caps = [policy.maxNotionalPerFire, policy.maxTriggerExposure, policy.dailyLossStop, policy.maxFiresPerDay, policy.maxLeverage].filter((x) => x != null).length;

  return (
    <div className="policy">
      <button className="linklike policy-toggle" onClick={() => setOpen((v) => !v)}>
        {t("policy.title")}
        {caps ? ` · ${caps}` : ""}
        {tripped ? ` · ${t("policy.tripped")}` : ""}
      </button>
      {tripped && (
        <span className="policy-trip">
          {t("policy.tripLine", { pnl: fmtUsd(Math.abs(day?.realizedPnl ?? 0)) })}
          <button
            className="linklike"
            onClick={() =>
              void store.clearPolicyTrip().then((r) => {
                if (!r.ok) onNote(apiErrorText(t, r));
                else onNote(t("policy.cleared"));
              })
            }
          >
            {t("policy.clear")}
          </button>
        </span>
      )}
      {open && (
        <div className="policy-form">
          <label>
            {t("policy.maxNotional")}
            <input inputMode="decimal" value={maxNotional} onChange={(e) => setMaxNotional(e.target.value)} placeholder="—" />
          </label>
          <label>
            {t("policy.maxExposure")}
            <input inputMode="decimal" value={maxExposure} onChange={(e) => setMaxExposure(e.target.value)} placeholder="—" />
          </label>
          <label>
            {t("policy.dailyLoss")}
            <input inputMode="decimal" value={dailyLoss} onChange={(e) => setDailyLoss(e.target.value)} placeholder="—" />
          </label>
          <label>
            {t("policy.maxFires")}
            <input inputMode="decimal" value={maxFires} onChange={(e) => setMaxFires(e.target.value)} placeholder="—" />
          </label>
          <label>
            {t("policy.maxLev")}
            <input inputMode="decimal" value={maxLev} onChange={(e) => setMaxLev(e.target.value)} placeholder="—" />
          </label>
          <div className="policy-mkts">
            <button className={btc ? "preset on" : "preset"} onClick={() => setBtc((v) => !v)}>
              BTC
            </button>
            <button className={eth ? "preset on" : "preset"} onClick={() => setEth((v) => !v)}>
              ETH
            </button>
          </div>
          <div className="policy-today muted">
            {t("policy.today", {
              pnl: `${(day?.realizedPnl ?? 0) >= 0 ? "+" : ""}${fmtUsd(day?.realizedPnl ?? 0)}`,
              fires: String(day?.fires ?? 0),
              exp: fmtUsd(me?.exposure ?? 0),
            })}
          </div>
          <button className="addstop" disabled={busy || (!btc && !eth)} onClick={() => void save()}>
            {busy ? "…" : t("policy.save")}
          </button>
        </div>
      )}
    </div>
  );
}

export function WatcherPanel({
  store,
  nowTick,
  onNote,
}: {
  store: TriggerStore;
  nowTick: number;
  onNote: (msg: string) => void;
}) {
  const { t } = useI18n();
  const { data: walletClient } = useWalletClient();
  const { writeContractAsync, isPending: txPending } = useWriteContract();
  const [busy, setBusy] = useState<null | "register" | "revoke" | "toggle">(null);
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const [setupOpen, setSetupOpen] = useState(false);

  const phase = triggerPhase(store, nowTick);
  const me = store.me;
  const key = me?.key ?? null;

  const run = async (what: "register" | "revoke" | "toggle", fn: () => Promise<ApiResult | void>) => {
    if (busy) return;
    setBusy(what);
    try {
      const r = await fn();
      if (r && !r.ok) onNote(apiErrorText(t, r));
    } catch (e: any) {
      if (!isUserRejection(e)) onNote(e?.shortMessage ?? e?.message ?? String(e));
    } finally {
      setBusy(null);
    }
  };

  if (phase.id === "offline") return <div className="trig-banner">{t("trig.api.offline")}</div>;
  if (phase.id === "loading") return null;

  // the operator pause shows whatever the key state is — nothing fires while it is on
  const killBanner = me?.kill?.on ? (
    <div className="trig-banner" key="kill">
      {t("trig.watcherKilled")}
    </div>
  ) : null;

  if (phase.id === "enable")
    return (
      <>
        {killBanner}
        <div className="trig-strip">
          <span className="trig-state off">
            <i className="trig-dot" aria-hidden />
            {phase.reason === "revoked" ? t("trig.strip.revoked") : phase.reason === "expired" ? t("trig.strip.expired") : t("trig.strip.none")}
          </span>
          <span className="trig-strip-why hint small">{t("trig.empty.enable")}</span>
          <button className="qb on trig-cta" disabled={!walletClient} onClick={() => setSetupOpen(true)}>
            {t("trig.setup.enable")}
          </button>
        </div>
        {setupOpen && <TriggerSetupModal store={store} walletClient={walletClient} onClose={() => setSetupOpen(false)} />}
      </>
    );

  if (phase.id === "register" || phase.id === "registering")
    return (
      <>
        {killBanner}
        <div className="trig-strip">
          <span className="trig-state pend">
            <i className="trig-dot" aria-hidden />
            {phase.id === "registering" ? t("trig.strip.registering") : t("trig.strip.pending")}
          </span>
          <span className="trig-strip-why hint small">
            {phase.id === "registering" ? t("ticket.registeringHint") : phase.again ? t("ticket.registerAgainHint") : t("ticket.registerHint")}
          </span>
          {phase.id === "register" && (
            <button
              className="qb on trig-cta"
              disabled={!walletClient || busy != null}
              onClick={() => run("register", () => store.registerKey(walletClient!))}
            >
              {busy === "register" ? t("ticket.waitingSig") : phase.again ? t("ticket.signRegistrationAgain") : t("trig.setup.signAgain")}
            </button>
          )}
        </div>
      </>
    );

  // ready: active key
  const onChainRevoke = async () => {
    const hash = await writeContractAsync({
      address: CONTRACTS.sessionKeyManager as `0x${string}`,
      abi: SESSION_KEY_MANAGER_ABI,
      functionName: "revokeSessionKey",
      args: [key!.address as `0x${string}`],
      chainId: hyperevm.id,
    });
    onNote(t("trig.setup.onChainSent", { hash: `${hash.slice(0, 10)}…` }));
  };

  const banners: JSX.Element[] = [];
  if (killBanner) banners.push(killBanner);
  if (!me!.watcher.alive)
    banners.push(
      <div className="trig-banner" key="offline">
        {me!.watcher.lastBeatAt ? t("trig.watcherOffline", { age: fmtAge(nowTick - me!.watcher.lastBeatAt) }) : t("trig.watcherNever")}
      </div>
    );
  if (phase.expiring)
    banners.push(
      <div className="trig-banner" key="expiring">
        {t("trig.setup.expiring", { age: fmtAge(phase.expiresIn) })}
      </div>
    );

  return (
    <>
      {banners}
      <div className="trig-strip">
        <button
          className={store.enabled ? "trig-state on trig-switch" : "trig-state paused trig-switch"}
          role="switch"
          aria-checked={store.enabled}
          disabled={busy != null}
          title={store.enabled ? t("trig.strip.liveWhy") : t("trig.strip.pausedWhy")}
          onClick={() => run("toggle", () => store.setEnabled(!store.enabled))}
        >
          <i className="trig-dot" aria-hidden />
          {store.enabled ? t("trig.strip.live") : t("trig.strip.paused")}
        </button>
        <span className="trig-strip-key hint small">
          {t("trig.strip.key", { key: `${key!.address.slice(0, 6)}…${key!.address.slice(-4)}`, age: fmtAge(Math.max(0, phase.expiresIn)) })}
          {" · "}
          {!confirmRevoke ? (
            <button className="linklike" onClick={() => setConfirmRevoke(true)}>
              {t("trig.setup.revoke")}
            </button>
          ) : (
            <>
              <button
                className="linklike warn-text"
                disabled={busy != null}
                onClick={() =>
                  run("revoke", async () => {
                    const r = await store.revoke();
                    setConfirmRevoke(false);
                    if (r.ok) onNote(t("trig.setup.revoked"));
                    return r;
                  })
                }
              >
                {busy === "revoke" ? "…" : t("trig.setup.revokeConfirm")}
              </button>{" "}
              <button className="linklike" onClick={() => setConfirmRevoke(false)}>
                {t("trig.cancel")}
              </button>
              {" · "}
              <button
                className="linklike"
                disabled={txPending}
                title={t("trig.setup.onChainWhy")}
                onClick={() => void onChainRevoke().catch((e: any) => !isUserRejection(e) && onNote(e?.shortMessage ?? e?.message ?? String(e)))}
              >
                {txPending ? "…" : t("trig.setup.onChain")}
              </button>
            </>
          )}
        </span>
      </div>
      <PolicyLimits store={store} onNote={onNote} />
    </>
  );
}

// ---------------------------------------------------------------------------
// Orders tab
// ---------------------------------------------------------------------------

export function OrdersTab({
  store,
  samples,
  marks,
  ranks,
  closedPnl,
  sessionHealthy,
  isConnected,
  onCancelQueued,
  onNote,
}: {
  store: TriggerStore | null;
  /** live samples for the distance column (display only — the server decides fires) */
  samples: Record<number, PriceSample | undefined>;
  marks: Record<number, number>;
  ranks: Record<string, number>;
  closedPnl: Record<string, number>;
  /** store.healthy, passed in so the bar re-renders on its own schedule */
  sessionHealthy: boolean;
  isConnected: boolean;
  onCancelQueued: (itemId: string, intentId: string) => void;
  onNote: (msg: string) => void;
}) {
  const { t } = useI18n();
  // freshness is a function of wall-clock time, not of store state — tick it
  const [nowTick, setNowTick] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  if (!isConnected || !store)
    return <div className="tb-empty">{t("trig.connectOrders")}</div>;

  // Orders = what is still waiting or in flight. Once a trigger has executed (it is a
  // position now), failed, expired or was cancelled it moves to the History tab.
  const rows: Row[] = [
    ...store.entries.map((item) => ({ kind: "entry" as const, item })),
    ...store.stops.map((item) => ({ kind: "stop" as const, item })),
  ]
    .filter((r) => !isTerminal(r.item.status))
    .sort(sortRows);

  const liveRows = rows.filter((r) => isLive(r.item.status));
  // server-side feed health comes with the heartbeat: any instrument with a live
  // trigger whose last sample was older than STALE_MS when the watcher last reported.
  // The watcher only starts polling an instrument once a live trigger exists for it,
  // and the heartbeat (2 s) + our /api/me poll (5 s) lag behind — so a trigger armed
  // in the last FEED_WARMUP_MS has no feed entry yet and must not count as stale.
  const hb = store.me?.watcher;
  const feedStale =
    !!hb?.alive &&
    liveRows.some((r) => {
      if (nowTick - r.item.createdAt < FEED_WARMUP_MS) return false;
      const age = hb.feeds[String(r.item.instrumentId)];
      return age == null || age < 0 || age > STALE_MS;
    });
  const unprotected = liveRows.length > 0 && store.authed === true && !sessionHealthy && !store.me?.kill?.on && !!store.me?.watcher.alive;

  return (
    <div className="tb-table">
      <WatcherPanel store={store} nowTick={nowTick} onNote={onNote} />
      {feedStale && <div className="trig-banner">{t("trig.watcherStale")}</div>}
      {unprotected && <div className="trig-banner">{t("trig.unprotected")}</div>}

      <div className="tb-row tb-orders tb-header">
        <span>{t("tb.asset")}</span>
        <span>{t("tb.type")}</span>
        <span>{t("tb.level")}</span>
        <span>{t("tb.margin")}</span>
        <span>{t("tb.distance")}</span>
        <span>{t("tb.expires")}</span>
        <span>{t("tb.statusCol")}</span>
        <span />
      </div>

      {rows.length === 0 ? (
        <div className="tb-empty">{store.authed === true ? t("trig.noOrders") : t("trig.setup.signInFirstList")}</div>
      ) : (
        rows.map((row) => (
          <OrderRow
            key={row.item.id}
            row={row}
            store={store}
            samples={samples}
            marks={marks}
            ranks={ranks}
            closedPnl={closedPnl}
            sessionHealthy={sessionHealthy}
            onCancelQueued={onCancelQueued}
            onNote={onNote}
          />
        ))
      )}

      <div className="hint small trig-foot" title={`${t("trig.disclaimer")} ${t("trig.confirmDelay")} ${t("trig.closesEntire")}`}>
        {t("trig.footShort")}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// History tab section: finished triggers (executed / failed / expired / cancelled)
// ---------------------------------------------------------------------------

const MAX_HISTORY_ROWS = 50;

export function TriggerHistory({ store, closedPnl }: { store: TriggerStore | null; closedPnl: Record<string, number> }) {
  const { t } = useI18n();
  if (!store) return null;
  const rows: Row[] = [
    ...store.entries.map((item) => ({ kind: "entry" as const, item })),
    ...store.stops.map((item) => ({ kind: "stop" as const, item })),
  ]
    .filter((r) => isTerminal(r.item.status))
    .sort((a, b) => (b.item.firedAt ?? b.item.createdAt) - (a.item.firedAt ?? a.item.createdAt))
    .slice(0, MAX_HISTORY_ROWS);
  if (rows.length === 0) return null;

  return (
    <>
      <div className="tb-section">{t("trig.historyTitle")}</div>
      <div className="tb-row tb-trighist tb-header">
        <span>{t("tb.asset")}</span>
        <span>{t("tb.type")}</span>
        <span>{t("tb.level")}</span>
        <span>{t("tb.margin")}</span>
        <span>{t("trig.filled")}</span>
        <span>{t("tb.outcome")}</span>
        <span>{t("tb.when")}</span>
      </div>
      {rows.map(({ kind, item }) => {
        const isEntry = kind === "entry";
        const entry = isEntry ? (item as TriggerEntry) : null;
        const stop = isEntry ? null : (item as StopLoss);
        const level = entry ? entry.triggerPrice : stop!.stopPrice;
        const cmp = entry ? cmpOf(entry.cross) : stopCmp(stop!.isLong, exitOf(stop!));
        const when = item.firedAt ?? item.createdAt;
        const err = item.status === "failed" ? errText(t, item.error) : null;
        // what became of the stop / take-profit the entry asked for
        const filled = entry?.status === "executed" || entry?.status === "unreconciled";
        const stopNote =
          entry?.attachedStop && filled
            ? entry.spawnedStopId
              ? entry.spawnNote === "clamped"
                ? t("trig.spawnedClamped")
                : t("trig.spawnedStop")
              : t("trig.spawnFailed")
            : null;
        const tpNote = entry?.attachedTp && filled ? (entry.spawnedTpId ? t("trig.spawnedTp") : t("trig.spawnTpFailed")) : null;
        const spawnNote = [stopNote, tpNote].filter(Boolean).join(" · ") || null;
        const spawnOk = (!entry?.attachedStop || !!entry.spawnedStopId) && (!entry?.attachedTp || !!entry.spawnedTpId);
        const fill =
          entry?.status === "executed" && entry.executedPrice != null ? (
            <>
              {fmtPrice(entry.executedPrice)}{" "}
              <small className={Math.abs(entry.executedPrice - entry.triggerPrice) / entry.triggerPrice > 0.001 ? "warn-text" : "muted"}>
                ({entry.executedPrice >= entry.triggerPrice ? "+" : ""}
                {(((entry.executedPrice - entry.triggerPrice) / entry.triggerPrice) * 100).toFixed(2)}%)
              </small>
            </>
          ) : stop?.status === "executed" && closedPnl[stop.positionId] != null ? (
            <span className={closedPnl[stop.positionId] >= 0 ? "up" : "down"}>
              {closedPnl[stop.positionId] >= 0 ? "+" : ""}
              {fmtUsd(closedPnl[stop.positionId])}
            </span>
          ) : (
            "—"
          );
        return (
          <div className="tb-row tb-trighist" key={item.id}>
            <span>
              <b>{symbolOf(item.instrumentId)}</b>{" "}
              <i className={item.isLong ? "up" : "down"}>
                {entry ? `${entry.leverage}× ` : ""}
                {t(item.isLong ? "house.long" : "house.short").toUpperCase()}
              </i>
            </span>
            <span className={typeClass(item, isEntry)}>{t(typeKey(item, isEntry))}</span>
            <span>
              {cmp} {fmtPrice(level)}
            </span>
            <span>{entry ? fmtUsd(entry.marginUsdc) : "—"}</span>
            <span>{fill}</span>
            <span>
              <Chip status={item.status} />
              {err && <em className="trig-err"> {err}</em>}
              {spawnNote && <em className={spawnOk ? "muted" : "trig-err"}> {spawnNote}</em>}
            </span>
            <span className="muted" title={new Date(when).toLocaleString()}>
              {timeAgo(when)}
            </span>
          </div>
        );
      })}
    </>
  );
}
