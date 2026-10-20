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
  isTerminal,
  stopHit,
  type AttachedStop,
  type PriceSample,
  type StopLoss,
  type TriggerEntry,
  type TriggerStatus,
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
/** a long stop fires at/below its price, a short stop at/above */
const stopCmp = (isLong: boolean) => (isLong ? "≤" : "≥");

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
 * One cell in the open-positions row. Collapsed it is either the armed stop or
 * a "+ Stop" button; expanded it is a price box. Arming when price is already
 * past the level needs a second click (it closes the position immediately).
 */
export function StopCell({
  store,
  position,
  mark,
  livePrice,
  onNote,
}: {
  store: TriggerStore | null;
  position: LivePosition;
  mark: number | undefined;
  livePrice: number | undefined;
  onNote: (msg: string) => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [confirmPast, setConfirmPast] = useState(false);

  if (!store) return <span className="muted">—</span>;
  // every mutation is a round-trip now — a rejection must be said out loud, not swallowed
  const report = (p: Promise<ApiResult>) =>
    p.then((r) => {
      if (!r.ok) onNote(apiErrorText(t, r));
    });

  const current = store.stopFor(position.positionId);
  const armed = current && current.status !== "attention" ? current : undefined;
  const attention = current?.status === "attention" ? current : undefined;
  const priceRef = livePrice ?? mark;

  if (armed) {
    const loss = pnlAt(position, armed.stopPrice);
    const bustBuffer = mark != null ? (Math.abs(armed.stopPrice - position.bustPrice) / mark) * 100 : null;
    const tight = bustBuffer != null && bustBuffer < STOP_BUST_MIN_BUFFER * 100;
    return (
      <span className="stopcell">
        <b
          className={tight ? "stop-at warn-text" : "stop-at"}
          title={t("trig.lossAtStop", {
            pnl: `${loss >= 0 ? "+" : "−"}${fmtUsd(Math.abs(loss))}`,
            pct: ((loss / position.margin) * 100).toFixed(1),
          })}
        >
          {stopCmp(armed.isLong)} {fmtPrice(armed.stopPrice)}
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
          {stopCmp(attention.isLong)} {fmtPrice(attention.stopPrice)}
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
        <button className="addstop" onClick={() => setOpen(true)} title={t("trig.closesEntire")}>
          {t("trig.addStop")}
        </button>
      </span>
    );

  const stopPrice = Number(text);
  const valid = text.trim() !== "" && Number.isFinite(stopPrice) && stopPrice > 0;
  const beyondBust = valid && (position.isLong ? stopPrice < position.bustPrice : stopPrice > position.bustPrice);
  const pastMarket = valid && priceRef != null && stopHit(priceRef, { isLong: position.isLong, stopPrice });

  const warn = !valid
    ? null
    : beyondBust
      ? t("trig.warn.bustFirst", { bust: fmtPrice(position.bustPrice) })
      : priceRef != null && Math.abs(stopPrice - position.bustPrice) / priceRef < STOP_BUST_MIN_BUFFER
        ? t("trig.warn.bustBuffer")
        : Math.abs(stopPrice - position.bustPrice) <=
            0.1 * Math.abs(position.entryPrice - position.bustPrice)
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
    const loss = pnlAt(position, stopPrice);
    void store
      .armStop({
        positionId: position.positionId,
        instrumentId: position.instrumentId,
        isLong: position.isLong,
        stopPrice,
      })
      .then((r) =>
        onNote(
          r.ok
            ? t("trig.noticeArmed", {
                market: symbolOf(position.instrumentId),
                cmp: stopCmp(position.isLong),
                price: fmtPrice(stopPrice),
                pnl: `${loss >= 0 ? "+" : "−"}${fmtUsd(Math.abs(loss))}`,
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
      <input
        type="number"
        inputMode="decimal"
        min={0}
        step="any"
        autoFocus
        className={warn ? "warn-input" : undefined}
        title={warn ?? t("trig.closesEntire")}
        aria-label={t("trig.stopPrice")}
        placeholder={t("trig.stopPrice")}
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

/** "−2 %" or "≤ 80,000" — how an attached stop reads in a cell */
function attachedStopText(a: AttachedStop, isLong: boolean): string {
  return a.mode === "pct" ? `−${(a.value * 100).toFixed(a.value * 100 < 1 ? 2 : 1).replace(/\.0$/, "")} %` : `${stopCmp(isLong)} ${fmtPrice(a.value)}`;
}

/**
 * The stop a WAITING entry will get the moment it fills. Same shape as
 * StopCell, but nothing exists on-chain yet: the server stores the intent
 * (% from fill or fixed price) and spawns the real stop at execution.
 */
function EntryStopCell({ store, entry, onNote }: { store: TriggerStore; entry: TriggerEntry; onNote: (msg: string) => void }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"pct" | "price">(entry.attachedStop?.mode ?? "pct");
  const [text, setText] = useState("");
  const report = (p: Promise<ApiResult>) =>
    p.then((r) => {
      if (!r.ok) onNote(apiErrorText(t, r));
    });
  const editable = entry.status === "armed" || entry.status === "confirming" || entry.status === "attention";
  const a = entry.attachedStop ?? null;

  if (!editable) {
    // fired / queued: the server will spawn it at the fill; nothing to edit any more
    return a ? (
      <span className="stopcell" title={t("trig.stopOnFillPending")}>
        <b className="stop-at muted">{attachedStopText(a, entry.isLong)}</b>
      </span>
    ) : null;
  }

  if (!open) {
    return a ? (
      <span className="stopcell">
        <b
          className="stop-at"
          title={t("trig.stopOnFillLine", { level: fmtPrice(attachedStopLevel(a, entry.isLong, entry.triggerPrice)) })}
          onClick={() => {
            setMode(a.mode);
            setText(a.mode === "pct" ? String(Math.round(a.value * 10000) / 100) : String(a.value));
            setOpen(true);
          }}
        >
          {attachedStopText(a, entry.isLong)}
        </b>
        <button className="xbtn" title={t("trig.cancel")} onClick={() => report(store.setEntryStop(entry.id, null))}>
          ×
        </button>
      </span>
    ) : (
      <span className="stopcell">
        <button
          className="addstop"
          title={t("ticket.stopOnFillWhy")}
          onClick={() => {
            setMode("pct");
            setText("2");
            setOpen(true);
          }}
        >
          {t("trig.addStop")}
        </button>
      </span>
    );
  }

  const n = Number(text);
  const typed = text.trim() !== "" && Number.isFinite(n) && n > 0;
  const next: AttachedStop | null = typed ? { mode, value: mode === "pct" ? n / 100 : n } : null;
  const problem = next ? attachedStopProblem(next, entry) : null;
  const warn = problem === "wrong-side" ? t("ticket.p.stopWrongSide") : problem === "beyond-bust" ? t("ticket.p.stopBeyondBust") : null;
  const close = () => {
    setOpen(false);
    setText("");
  };
  const save = () => {
    if (!next || warn) return;
    void store.setEntryStop(entry.id, next).then((r) => {
      if (!r.ok) onNote(apiErrorText(t, r));
      else onNote(t("trig.stopOnFillSet", { level: fmtPrice(attachedStopLevel(next, entry.isLong, entry.triggerPrice)) }));
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
            const pct = typed ? n / 100 : 0.02;
            setText(String(Math.round(entry.triggerPrice * (entry.isLong ? 1 - pct : 1 + pct) * 10) / 10));
            setMode("price");
          } else {
            setText("2");
            setMode("pct");
          }
        }}
      >
        {mode === "pct" ? "%" : "$"}
      </button>
      <input
        type="number"
        inputMode="decimal"
        min={0}
        step="any"
        autoFocus
        className={warn ? "warn-input" : undefined}
        title={warn ?? t("ticket.stopOnFillWhy")}
        aria-label={t("ticket.stopOnFill")}
        placeholder={mode === "pct" ? "2" : t("trig.stopPrice")}
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
  const cmp = isEntry ? cmpOf((item as TriggerEntry).cross) : stopCmp((item as StopLoss).isLong);
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
      <span className={isEntry ? "muted" : "trig-type-stop"}>
        {t(isEntry ? "trig.type.entry" : "trig.type.stop")}
      </span>
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
        {entry && <EntryStopCell store={store} entry={entry} onNote={onNote} />}
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
        const cmp = entry ? cmpOf(entry.cross) : stopCmp(stop!.isLong);
        const when = item.firedAt ?? item.createdAt;
        const err = item.status === "failed" ? errText(t, item.error) : null;
        // what became of the stop the entry asked for
        const spawnNote =
          entry?.attachedStop && (entry.status === "executed" || entry.status === "unreconciled")
            ? entry.spawnedStopId
              ? entry.spawnNote === "clamped"
                ? t("trig.spawnedClamped")
                : t("trig.spawnedStop")
              : t("trig.spawnFailed")
            : null;
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
            <span className={isEntry ? "muted" : "trig-type-stop"}>{t(isEntry ? "trig.type.entry" : "trig.type.stop")}</span>
            <span>
              {cmp} {fmtPrice(level)}
            </span>
            <span>{entry ? fmtUsd(entry.marginUsdc) : "—"}</span>
            <span>{fill}</span>
            <span>
              <Chip status={item.status} />
              {err && <em className="trig-err"> {err}</em>}
              {spawnNote && <em className={entry?.spawnedStopId ? "muted" : "trig-err"}> {spawnNote}</em>}
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
