// Right panel: the order ticket. Side → size → leverage → (trigger, stop, expiry)
// → risk summary → one execute button labelled with what it does. Validation
// rules, max-margin limits, bust formula and slider curve follow papertrade's.

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useAccount, useConnect, useSwitchChain, useWalletClient } from "wagmi";
import type { TradePreview } from "./Chart";
import { explorerAddress, hyperevm, shortAddr, CONTRACTS } from "./chain";
import type { MarketKey } from "./feed";
import { MARKETS } from "./feed";
import type { WalletSnapshot } from "./liveAccount";
import { useI18n, type Key as I18nKey } from "./i18n";
import type { Side } from "./position";
import {
  bustPrice,
  fmtPrice,
  fmtUsd,
  oiHeadroomUsd,
  relayerError,
  type TradingState,
} from "./protocol";
import {
  clearSessionKey,
  createSessionKey,
  openPositionIntent,
  registerSessionKey,
  sessionStatus,
} from "./session";
import type { ApiResult, ArmEntrySpec, AttachedStop, CrossDirection, RemoteTriggerStore } from "./triggerApi";
import { attachedStopLevel, attachedStopProblem, attachedTpLevel, attachedTpProblem } from "../shared/triggerLogic";
import { TriggerSetupModal, apiErrorText, isUserRejection, triggerPhase, useNowTick } from "./TriggerSetup";

interface TicketProps {
  snapshot: WalletSnapshot | null;
  proto: TradingState | null;
  market: MarketKey;
  /** split screen: show a BTC / ETH toggle above the side buttons */
  onMarket?: (m: MarketKey) => void;
  lastPrice: number | null;
  openPnl: number;
  onSubmitted: (msg: string) => void;
  /** hypothetical-trade LIQ line for the chart; null hides it */
  onPreview: (p: TradePreview | null) => void;
  /** chart LIQ tool → side + leverage to adopt; `nonce` changes per pick */
  apply?: { leverage: number; isLong: boolean; nonce: number } | null;
  /** Trigger mode: arm a server-side trigger entry instead of placing a market
   *  order (see triggerApi.ts). When absent, the Market|Trigger toggle is hidden. */
  onArmEntry?: (spec: ArmEntrySpec) => Promise<ApiResult>;
  /** the trigger store: the big button walks the user through enabling (TriggerSetup.tsx) before it arms */
  trigStore?: RemoteTriggerStore | null;
}

const QUICK_LEV = [2, 5, 10, 25, 50, 100];
const SIZE_PCT = [25, 50, 75, 100];
const SLIDER_MAX = 10_000;
const CURVE = 2.8;
// leverage ↔ slider position, same curve as theirs
const levToSlider = (lev: number, maxLev: number) =>
  Math.round(SLIDER_MAX * Math.pow((lev - 1) / (maxLev - 1), 1 / CURVE));
const sliderToLev = (v: number, maxLev: number) =>
  Math.round(1 + (maxLev - 1) * Math.pow(v / SLIDER_MAX, CURVE));

const round2 = (v: number) => Math.floor(v * 100) / 100;
const noSubscribe = () => () => {};
const zeroVersion = () => 0;

export default function Ticket({
  snapshot,
  proto,
  market,
  onMarket,
  lastPrice,
  openPnl,
  onSubmitted,
  onPreview,
  apply,
  onArmEntry,
  trigStore = null,
}: TicketProps) {
  const { t } = useI18n();
  const { address, isConnected, chainId } = useAccount();
  const { connect, connectors, isPending } = useConnect();
  const { switchChain } = useSwitchChain();
  const { data: walletClient } = useWalletClient();

  const [side, setSide] = useState<Side>("long");
  const [marginText, setMarginText] = useState("10");
  const [followMax, setFollowMax] = useState(false);
  const [leverage, setLeverage] = useState(10);
  // Market | Trigger mode (trigger = server-side trigger entry, see triggerApi.ts)
  const [mode, setMode] = useState<"market" | "trigger">("market");
  const [triggerText, setTriggerText] = useState("");
  const [expiry, setExpiry] = useState<"never" | "1h" | "24h" | "7d">("24h");
  // optional stop the watcher creates for the position the moment the entry fills:
  // a % distance from the fill (default) or a fixed price
  const [stopMode, setStopMode] = useState<"off" | "pct" | "price">("off");
  const [stopText, setStopText] = useState("");
  const [tpMode, setTpMode] = useState<"off" | "pct" | "price">("off");
  const [tpText, setTpText] = useState("");
  // enabling triggers: the explainer modal, then the registration signature — both off the big button
  const [setupOpen, setSetupOpen] = useState(false);
  const [regBusy, setRegBusy] = useState(false);
  const nowTick = useNowTick(1000);
  useSyncExternalStore(trigStore?.subscribe ?? noSubscribe, trigStore?.getVersion ?? zeroVersion); // re-render on store changes
  const phase = triggerPhase(trigStore, nowTick);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [hover, setHover] = useState(false);
  const [focus, setFocus] = useState(false);
  const [, setTick] = useState(0);
  const bump = () => setTick((t) => t + 1);
  const formRef = useRef<HTMLDivElement>(null);

  // LIQ tool on the chart picked a bust price → adopt its side + leverage
  useEffect(() => {
    if (!apply) return;
    setSide(apply.isLong ? "long" : "short");
    setLeverage(apply.leverage);
  }, [apply]);

  const inst = proto?.instruments.find((i) => i.id === MARKETS[market].id) ?? null;
  const maxLev = inst?.maxLeverage ?? 1000;
  const minTrade = proto?.minimumTradeUsdc ?? 10;
  const minNotional = proto?.minimumOpenNotionalUsdc ?? 1000;
  const available = snapshot?.available ?? 0;
  const isLong = side === "long";

  const session = sessionStatus(address);
  const sessionRegistered =
    session.state === "active" ||
    (session.state === "unregistered" &&
      !!snapshot?.sessionKeys.includes(session.address.toLowerCase()));

  // ---- executable maximum margin + the reason that binds (their `dr`) ----
  const limit = useMemo(() => {
    let maximum = available;
    let reason = t("ticket.p.insufficient");
    let headroom: number | null = null;
    const cap = (v: number, why: string) => {
      if (v < maximum) {
        maximum = v;
        reason = why;
      }
    };
    if (inst) {
      if (leverage > inst.maxLeverage) cap(0, t("ticket.p.levTooHigh"));
      if (inst.maxPositionNotional > 0) cap(inst.maxPositionNotional / leverage, t("ticket.p.posTooLarge"));
      headroom = oiHeadroomUsd(inst, isLong, lastPrice);
      if (headroom != null) cap(headroom / leverage, t(isLong ? "ticket.p.longOiCap" : "ticket.p.shortOiCap"));
    }
    return { maximum: Math.max(0, maximum), reason, headroom };
  }, [available, inst, leverage, isLong, lastPrice, t]);

  const margin = followMax ? round2(limit.maximum) : Number(marginText);
  const marginValid = Number.isFinite(margin) && marginText.trim() !== "";
  const notional = marginValid ? margin * leverage : 0;
  const bust = lastPrice ? bustPrice(lastPrice, leverage, isLong, inst?.bustBuffer ?? 0) : null;
  const queuedOpens = snapshot?.operations.filter((o) => o.action === "openPosition").length ?? 0;

  // ---- validation (their `or`), message doubles as the disabled CTA label ----
  const problem = useMemo(() => {
    if (!proto || !inst) return t("ticket.p.unavailable");
    if (proto.tradingPaused) return t("ticket.p.tradingPaused");
    if (inst.paused || !inst.active) return t("ticket.p.marketPaused", { market });
    if (!Number.isInteger(leverage) || leverage < 1 || leverage > maxLev)
      return t("ticket.p.levRange", { max: maxLev });
    if (!marginValid) return t("ticket.p.enterMargin");
    if (margin <= 0 || margin < minTrade) return t("ticket.p.minMargin", { v: fmtUsd(minTrade) });
    if (notional < minNotional) return t("ticket.p.minNotional", { v: fmtUsd(minNotional) });
    if (snapshot && margin > limit.maximum + 1e-9) return limit.reason;
    return null;
  }, [proto, inst, market, leverage, maxLev, marginValid, margin, minTrade, notional, minNotional, snapshot, limit, t]);

  // near-OI-cap warning (their threshold: remaining ≤ max(headroom/20, $1,000))
  const warning = useMemo(() => {
    if (limit.headroom == null || !marginValid || margin <= 0) return null;
    const remaining = limit.headroom - notional;
    const band = Math.max(limit.headroom / 20, 1000);
    return remaining >= 0 && remaining <= band
      ? t("ticket.nearOiCap")
      : null;
  }, [limit.headroom, marginValid, margin, notional, t]);

  // ---- trigger mode derivations ----
  // Direction is explicit, never inferred at fire time: long at/below the live
  // price is a pullback entry (fires down-to), long above it a breakout
  // (up-to); shorts mirror. Without a live price, fall back to the side's
  // pullback direction.
  const triggerPrice = Number(triggerText);
  const triggerValid =
    triggerText.trim() !== "" && Number.isFinite(triggerPrice) && triggerPrice > 0;
  const triggerCross: CrossDirection =
    lastPrice != null
      ? isLong
        ? triggerPrice <= lastPrice
          ? "down-to"
          : "up-to"
        : triggerPrice >= lastPrice
          ? "up-to"
          : "down-to"
      : isLong
        ? "down-to"
        : "up-to";
  const triggerProblem =
    mode === "trigger" && !triggerValid ? t("ticket.p.enterTrigger") : null;
  const triggerAlreadyPast =
    mode === "trigger" &&
    triggerValid &&
    lastPrice != null &&
    (triggerCross === "down-to" ? lastPrice <= triggerPrice : lastPrice >= triggerPrice);

  // attached stop: what the watcher will arm on the fill. "pct" is typed as a
  // percentage (2 = 2 %) and sent as a fraction; the estimate below uses the
  // trigger price as a stand-in for the unknown fill.
  const stopNum = Number(stopText);
  const stopTyped = stopText.trim() !== "" && Number.isFinite(stopNum) && stopNum > 0;
  const attachedStop: AttachedStop | null =
    mode === "trigger" && stopMode !== "off" && stopTyped ? { mode: stopMode, value: stopMode === "pct" ? stopNum / 100 : stopNum } : null;
  const stopProblem =
    mode !== "trigger" || stopMode === "off"
      ? null
      : !stopTyped
        ? t("ticket.p.enterStop")
        : attachedStop && triggerValid
          ? (() => {
              const p = attachedStopProblem(attachedStop, { isLong, leverage, triggerPrice });
              return p === "wrong-side" ? t("ticket.p.stopWrongSide") : p === "beyond-bust" ? t("ticket.p.stopBeyondBust") : null;
            })()
          : null;
  const stopEstimate =
    attachedStop && triggerValid && !stopProblem
      ? (() => {
          const level = attachedStopLevel(attachedStop, isLong, triggerPrice);
          const frac = Math.abs(triggerPrice - level) / triggerPrice;
          const loss = margin * leverage * frac;
          return { level, loss, pctOfMargin: (loss / Math.max(margin, 1e-9)) * 100 };
        })()
      : null;

  // attached take-profit: the favourable twin of the stop. No bust bound on this
  // side; the only thing that can be wrong is a fixed level on the loss side.
  const tpNum = Number(tpText);
  const tpTyped = tpText.trim() !== "" && Number.isFinite(tpNum) && tpNum > 0;
  const attachedTp: AttachedStop | null =
    mode === "trigger" && tpMode !== "off" && tpTyped ? { mode: tpMode, value: tpMode === "pct" ? tpNum / 100 : tpNum } : null;
  const tpProblem =
    mode !== "trigger" || tpMode === "off"
      ? null
      : !tpTyped
        ? t("ticket.p.enterTp")
        : attachedTp && triggerValid && attachedTpProblem(attachedTp, { isLong, triggerPrice })
          ? t("ticket.p.tpWrongSide")
          : null;
  const tpEstimate =
    attachedTp && triggerValid && !tpProblem
      ? (() => {
          const level = attachedTpLevel(attachedTp, isLong, triggerPrice);
          const frac = Math.abs(level - triggerPrice) / triggerPrice;
          const gain = margin * leverage * frac;
          return { level, gain, pctOfMargin: (gain / Math.max(margin, 1e-9)) * 100 };
        })()
      : null;

  // ---- chart preview: visible while the pointer is over the ticket or a field is focused ----
  // Hover is tracked at document level (not just enter/leave) so a tap, a click
  // elsewhere or the cursor leaving the window can never leave it stuck on.
  useEffect(() => {
    const onPointer = (e: PointerEvent) => setHover(!!formRef.current?.contains(e.target as Node | null));
    const onLeaveWindow = () => setHover(false);
    document.addEventListener("pointermove", onPointer, { passive: true });
    document.addEventListener("pointerdown", onPointer, { passive: true });
    document.documentElement.addEventListener("pointerleave", onLeaveWindow);
    return () => {
      document.removeEventListener("pointermove", onPointer);
      document.removeEventListener("pointerdown", onPointer);
      document.documentElement.removeEventListener("pointerleave", onLeaveWindow);
    };
  }, []);
  const previewVisible = hover || focus;
  useEffect(() => {
    // the chart preview is a market-order LIQ line; trigger mode doesn't place
    // an order now, so it stays hidden there
    onPreview(previewVisible && bust && mode === "market" ? { bust, isLong } : null);
  }, [previewVisible, bust, isLong, onPreview, mode]);
  useEffect(() => () => onPreview(null), [onPreview]);

  const setMarginManual = (v: number) => {
    setFollowMax(false);
    setMarginText(String(round2(Math.max(0, v))));
  };

  const doRegister = async () => {
    if (!walletClient || !address) return;
    setBusy(true);
    setMsg(null);
    try {
      const r = await registerSessionKey(walletClient, address);
      setMsg(r.ok ? t("ticket.sessionRegistered") : relayerError(r.error, r.reason) ?? r.message ?? r.error ?? t("ticket.failed"));
    } catch (e: any) {
      setMsg(e?.shortMessage ?? e?.message ?? String(e));
    } finally {
      setBusy(false);
      bump();
    }
  };

  const doPlace = async () => {
    if (!address || problem) return;
    setBusy(true);
    setMsg(null);
    try {
      const r = await openPositionIntent({
        user: address,
        instrumentId: MARKETS[market].id,
        isLong,
        marginUsdc: margin,
        leverage,
      });
      if (r.ok) {
        setMsg(null);
        onSubmitted(t("ticket.queued", { side: t(isLong ? "house.long" : "house.short").toUpperCase(), market, lev: leverage, margin: fmtUsd(margin) }));
      } else {
        setMsg(relayerError(r.error, r.reason) ?? r.message ?? r.error ?? t("ticket.rejected"));
      }
    } catch (e: any) {
      setMsg(e?.shortMessage ?? e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  };

  const EXPIRY_MS = { "1h": 3600_000, "24h": 24 * 3600_000, "7d": 7 * 24 * 3600_000 } as const;

  /** Arm a server-side trigger entry — the watcher evaluates and fires it (triggerApi.ts). */
  const doArm = async () => {
    if (!address || problem || triggerProblem || stopProblem || tpProblem || !onArmEntry) return;
    setBusy(true);
    setMsg(null);
    try {
      const r = await onArmEntry({
        instrumentId: MARKETS[market].id,
        isLong,
        marginUsdc: margin,
        leverage,
        useDebt: false,
        triggerPrice,
        cross: triggerCross,
        expiresAt: expiry === "never" ? null : Date.now() + EXPIRY_MS[expiry],
        attachedStop,
        attachedTp,
      });
      if (!r.ok) {
        setMsg(apiErrorText(t, r));
        return;
      }
    } catch (e: any) {
      setMsg(e?.shortMessage ?? e?.message ?? String(e));
      return;
    } finally {
      setBusy(false);
    }
    onSubmitted(
      t("ticket.trigArmed", {
        side: t(isLong ? "house.long" : "house.short").toUpperCase(),
        market,
        lev: leverage,
        cmp: triggerCross === "down-to" ? "≤" : "≥",
        price: fmtPrice(triggerPrice),
      })
    );
  };

  /** last enabling step: one EIP-712 signature registers the watcher's key on-chain */
  const doSignRegistration = async () => {
    if (!trigStore || !walletClient || regBusy) return;
    setRegBusy(true);
    setMsg(null);
    try {
      const r = await trigStore.registerKey(walletClient);
      if (!r.ok) setMsg(apiErrorText(t, r));
    } catch (e: any) {
      if (!isUserRejection(e)) setMsg(e?.shortMessage ?? e?.message ?? String(e));
    } finally {
      setRegBusy(false);
    }
  };

  const pickMode = (m: "market" | "trigger") => {
    setMode(m);
    // prefill the trigger price with the live price on first switch
    if (m === "trigger" && triggerText.trim() === "" && lastPrice != null)
      setTriggerText(String(Math.round(lastPrice * 10) / 10));
  };

  const sliderPos = levToSlider(Math.min(maxLev, Math.max(1, leverage)), maxLev);
  const sideClass = isLong ? "lo" : "sh";

  // ---- risk block: what the trader is actually committing ----
  // Reference price: the live mark for a market order, the trigger level for a trigger.
  const refPrice = mode === "trigger" ? (triggerValid ? triggerPrice : null) : lastPrice;
  const liq = refPrice ? bustPrice(refPrice, leverage, isLong, inst?.bustBuffer ?? 0) : null;
  const liqDistPct = refPrice && liq ? (Math.abs(refPrice - liq) / refPrice) * 100 : null;
  // Without a stop the whole isolated margin is at risk; with a stop on fill, the estimated loss there.
  const maxLoss = marginValid ? (stopEstimate ? stopEstimate.loss : margin) : null;
  // reward at the take-profit and the resulting R multiple against the max loss
  const reward = marginValid && tpEstimate ? tpEstimate.gain : null;
  const rMultiple = reward != null && maxLoss != null && maxLoss > 0 ? reward / maxLoss : null;
  const sizePctOfFree = snapshot && marginValid && limit.maximum > 0 ? Math.min(100, (margin / limit.maximum) * 100) : null;
  const ctaLabel =
    mode === "trigger"
      ? t(isLong ? "ticket.cta.armLong" : "ticket.cta.armShort", {
          market,
          cmp: triggerCross === "down-to" ? "≤" : "≥",
          price: triggerValid ? fmtPrice(triggerPrice) : "—",
        })
      : t(isLong ? "ticket.cta.long" : "ticket.cta.short", {
          market,
          lev: leverage,
          notional: marginValid ? fmtUsd(notional, 0) : "—",
        });

  return (
    <>
      {/* ticket — hovering or focusing anything inside shows the LIQ preview on the chart */}
      <div
        className="order-ticket"
        ref={formRef}
        onFocus={() => setFocus(true)}
        onBlur={(e) => {
          if (!formRef.current?.contains(e.relatedTarget as Node | null)) setFocus(false);
        }}
      >
        {onArmEntry && (
          <div className="seg seg-mode" role="tablist" aria-label={t("ticket.modeLabel")}>
            <button role="tab" className={mode === "market" ? "on" : ""} aria-selected={mode === "market"} onClick={() => pickMode("market")}>
              {t("ticket.modeMarket")}
            </button>
            <button role="tab" className={mode === "trigger" ? "on" : ""} aria-selected={mode === "trigger"} onClick={() => pickMode("trigger")}>
              {t("ticket.modeTrigger")}
            </button>
          </div>
        )}
        {onMarket && (
          <div className="seg" role="tablist" aria-label={t("ticket.market")}>
            {(Object.keys(MARKETS) as MarketKey[]).map((k) => (
              <button key={k} role="tab" className={k === market ? "on" : ""} aria-selected={k === market} onClick={() => onMarket(k)}>
                {k}
              </button>
            ))}
          </div>
        )}

        <div className="side-sel" role="radiogroup" aria-label={t("ticket.modeLabel")}>
          <button className={isLong ? "side-btn long on" : "side-btn long"} role="radio" aria-checked={isLong} onClick={() => setSide("long")}>
            {t("ticket.long")}
          </button>
          <button className={!isLong ? "side-btn short on" : "side-btn short"} role="radio" aria-checked={!isLong} onClick={() => setSide("short")}>
            {t("ticket.short")}
          </button>
        </div>

        {/* size */}
        <div className="fld">
          <div className="fld-head">
            <label htmlFor="margin-in">{t("ticket.marginUsdc")}</label>
            <span className="fld-aux">
              {t("ticket.free")} <b className="numeric">{snapshot ? fmtUsd(available) : "—"}</b>
            </span>
          </div>
          <div className="fld-in">
            <input
              id="margin-in"
              type="number"
              inputMode="decimal"
              min={0}
              step="any"
              value={followMax ? String(round2(limit.maximum)) : marginText}
              onChange={(e) => {
                setFollowMax(false);
                setMarginText(e.target.value);
              }}
            />
            <span className="fld-unit">USDC</span>
          </div>
          <div className="presets">
            {SIZE_PCT.map((p) => {
              const on = p === 100 ? followMax : !followMax && sizePctOfFree != null && Math.abs(sizePctOfFree - p) < 0.5;
              return (
                <button
                  key={p}
                  className={on ? "preset on" : "preset"}
                  aria-pressed={on}
                  disabled={!snapshot}
                  title={p === 100 ? t("ticket.help.max") : undefined}
                  onClick={() => (p === 100 ? setFollowMax(true) : setMarginManual((limit.maximum * p) / 100))}
                >
                  {p === 100 ? t("ticket.max") : t("ticket.sizePct", { p })}
                </button>
              );
            })}
          </div>
        </div>

        {/* leverage */}
        <div className="fld">
          <div className="fld-head">
            <label htmlFor="lev-in">{t("ticket.leverage")}</label>
            <span className="fld-aux">
              {t("ticket.orderValue")} <b className="numeric">{marginValid ? fmtUsd(notional) : "—"}</b>
            </span>
          </div>
          <div className="lev-row">
            <div className="fld-in lev-in">
              <input
                id="lev-in"
                type="number"
                inputMode="numeric"
                min={1}
                max={maxLev}
                step={1}
                value={leverage}
                onKeyDown={(e) => {
                  if (!e.ctrlKey && !e.metaKey && [".", ",", "e", "E", "+", "-"].includes(e.key)) e.preventDefault();
                }}
                onChange={(e) => {
                  const n = Math.round(Number(e.target.value));
                  if (Number.isFinite(n)) setLeverage(Math.min(maxLev, Math.max(1, n)));
                }}
              />
              <span className="fld-unit">x</span>
            </div>
            <div className="strack">
              <div className="sthumb" style={{ left: `${(sliderPos / SLIDER_MAX) * 100}%` }} />
              <input
                className="lev-range"
                type="range"
                min={0}
                max={SLIDER_MAX}
                step={1}
                aria-label={t("ticket.sliderLabel")}
                aria-valuetext={`${leverage}x`}
                value={sliderPos}
                onChange={(e) => setLeverage(sliderToLev(Number(e.target.value), maxLev))}
              />
            </div>
          </div>
          <div className="presets">
            {QUICK_LEV.filter((l) => l < maxLev).map((l) => (
              <button key={l} className={leverage === l ? "preset on" : "preset"} aria-pressed={leverage === l} onClick={() => setLeverage(l)}>
                {l}x
              </button>
            ))}
            <button className={leverage === maxLev ? "preset on" : "preset"} aria-pressed={leverage === maxLev} onClick={() => setLeverage(maxLev)}>
              {maxLev}x
            </button>
          </div>
        </div>

        {mode === "trigger" && (
          <>
            <div className="fld">
              <div className="fld-head">
                <label htmlFor="trig-in">{t("ticket.triggerPrice")}</label>
                {triggerValid && lastPrice != null && (
                  <span className={`fld-aux tag ${triggerCross === "down-to" ? "down" : "up"}`}>
                    {triggerCross === "down-to" ? "≤" : "≥"} {t((isLong) === (triggerCross === "down-to") ? "ticket.pullback" : "ticket.breakout")}
                  </span>
                )}
              </div>
              <div className="fld-in">
                <input
                  id="trig-in"
                  type="number"
                  inputMode="decimal"
                  min={0}
                  step="any"
                  value={triggerText}
                  onChange={(e) => setTriggerText(e.target.value)}
                />
                <span className="fld-unit">USD</span>
              </div>
            </div>

            <div className="fld">
              <div className="fld-head">
                <label htmlFor="trig-stop-in" title={t("ticket.stopOnFillWhy")}>
                  {t("ticket.stopOnFill")}
                </label>
                <div className="seg seg-mini" role="tablist">
                  {(["off", "pct", "price"] as const).map((x) => (
                    <button
                      key={x}
                      role="tab"
                      className={stopMode === x ? "on" : ""}
                      aria-selected={stopMode === x}
                      onClick={() => {
                        setStopMode(x);
                        // switching unit converts the value: a fixed price starts from the trigger
                        // price minus the typed % so the user edits a sensible number, never "$2"
                        if (x === "price" && (stopText.trim() === "" || stopMode === "pct") && triggerValid) {
                          const typedPct = Number(stopText);
                          const pct = stopMode === "pct" && Number.isFinite(typedPct) && typedPct > 0 ? typedPct / 100 : 0.02;
                          setStopText(String(Math.round(triggerPrice * (isLong ? 1 - pct : 1 + pct) * 10) / 10));
                        }
                        if (x === "pct" && (stopText.trim() === "" || stopMode === "price")) setStopText("2");
                        if (x === "off") setStopText("");
                      }}
                    >
                      {x === "off" ? t("ticket.stopOff") : x === "pct" ? "%" : "$"}
                    </button>
                  ))}
                </div>
              </div>
              {stopMode !== "off" && (
                <div className={stopProblem && stopTyped ? "fld-in warn" : "fld-in"}>
                  <input
                    id="trig-stop-in"
                    type="number"
                    inputMode="decimal"
                    min={0}
                    step="any"
                    placeholder={stopMode === "pct" ? "2" : t("trig.stopPrice")}
                    value={stopText}
                    onChange={(e) => setStopText(e.target.value)}
                  />
                  <span className="fld-unit">{stopMode === "pct" ? "%" : "USD"}</span>
                </div>
              )}
            </div>

            <div className="fld">
              <div className="fld-head">
                <label htmlFor="trig-tp-in" title={t("ticket.tpOnFillWhy")}>
                  {t("ticket.tpOnFill")}
                </label>
                <div className="seg seg-mini" role="tablist">
                  {(["off", "pct", "price"] as const).map((x) => (
                    <button
                      key={x}
                      role="tab"
                      className={tpMode === x ? "on" : ""}
                      aria-selected={tpMode === x}
                      onClick={() => {
                        setTpMode(x);
                        // same conversion as the stop, mirrored: a fixed price starts from the trigger plus the typed %
                        if (x === "price" && (tpText.trim() === "" || tpMode === "pct") && triggerValid) {
                          const typedPct = Number(tpText);
                          const pct = tpMode === "pct" && Number.isFinite(typedPct) && typedPct > 0 ? typedPct / 100 : 0.04;
                          setTpText(String(Math.round(triggerPrice * (isLong ? 1 + pct : 1 - pct) * 10) / 10));
                        }
                        if (x === "pct" && (tpText.trim() === "" || tpMode === "price")) setTpText("4");
                        if (x === "off") setTpText("");
                      }}
                    >
                      {x === "off" ? t("ticket.stopOff") : x === "pct" ? "%" : "$"}
                    </button>
                  ))}
                </div>
              </div>
              {tpMode !== "off" && (
                <div className={tpProblem && tpTyped ? "fld-in warn" : "fld-in"}>
                  <input
                    id="trig-tp-in"
                    type="number"
                    inputMode="decimal"
                    min={0}
                    step="any"
                    placeholder={tpMode === "pct" ? "4" : t("trig.tpPrice")}
                    value={tpText}
                    onChange={(e) => setTpText(e.target.value)}
                  />
                  <span className="fld-unit">{tpMode === "pct" ? "%" : "USD"}</span>
                </div>
              )}
            </div>

            <div className="fld">
              <div className="fld-head">
                <label>{t("ticket.expiry")}</label>
                <div className="seg seg-mini" role="tablist">
                  {(["1h", "24h", "7d", "never"] as const).map((x) => (
                    <button key={x} role="tab" className={expiry === x ? "on" : ""} aria-selected={expiry === x} onClick={() => setExpiry(x)}>
                      {x === "never" ? "∞" : t(`ticket.exp.${x}` as I18nKey)}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {stopProblem && stopTyped && <div className="hint small warn-text">{stopProblem}</div>}
            {tpProblem && tpTyped && <div className="hint small warn-text">{tpProblem}</div>}
            {triggerAlreadyPast && <div className="hint small warn-text">{t("ticket.trigAlreadyPast")}</div>}
          </>
        )}

        {/* risk summary */}
        <div className="risk-sum">
          <div className="kv">
            <span>{t("ticket.entry")}</span>
            <b className="numeric">
              {mode === "trigger"
                ? triggerValid
                  ? fmtPrice(triggerPrice)
                  : "—"
                : lastPrice
                  ? <>
                      <i>{t("ticket.entryMarket")}</i> ~{fmtPrice(lastPrice)}
                    </>
                  : "—"}
            </b>
          </div>
          <div className="kv">
            <span title={t("ticket.help.bust")}>{t("ticket.bustPrice")}</span>
            <b className="numeric">
              {liq ? (
                <>
                  {fmtPrice(liq)} <i>{t("ticket.liqDist", { pct: liqDistPct!.toFixed(liqDistPct! < 1 ? 2 : 1) })}</i>
                </>
              ) : (
                "—"
              )}
            </b>
          </div>
          <div className="kv">
            <span>{t("ticket.maxLoss")}</span>
            <b className="numeric down">
              {maxLoss != null ? (
                <>
                  −{fmtUsd(maxLoss)} <i>{stopEstimate ? t("ticket.maxLossAtStop") : t("ticket.maxLossFull")}</i>
                </>
              ) : (
                "—"
              )}
            </b>
          </div>
          {reward != null && (
            <div className="kv">
              <span>{t("ticket.reward")}</span>
              <b className="numeric up">
                +{fmtUsd(reward)}{" "}
                <i>
                  {t("ticket.atTp")}
                  {rMultiple != null ? ` · ${rMultiple.toFixed(rMultiple < 10 ? 1 : 0)}R` : ""}
                </i>
              </b>
            </div>
          )}
        </div>

        {/* gated CTA */}
        {!isConnected ? (
          <button className="gobtn auth" disabled={isPending} onClick={() => connect({ connector: connectors[0] })}>
            {isPending ? t("ticket.connectingWallet") : t("ticket.connectWallet")}
          </button>
        ) : chainId !== hyperevm.id ? (
          <button className="gobtn auth" onClick={() => switchChain({ chainId: hyperevm.id })}>
            {t("ticket.switchNetwork")}
          </button>
        ) : mode === "trigger" ? (
          // Trigger mode never needs the browser session key: the watcher signs with
          // its own. The big button walks the ladder: Enable triggers (explainer →
          // sign in → key minted) → Sign registration → Arm trigger.
          phase.id === "offline" ? (
            <button className="gobtn auth" disabled>
              {t("ticket.trigOffline")}
            </button>
          ) : phase.id === "loading" ? (
            <button className="gobtn auth" disabled>
              …
            </button>
          ) : phase.id === "enable" ? (
            <button className="gobtn auth" disabled={!walletClient} onClick={() => setSetupOpen(true)}>
              {t("trig.setup.enable")}
            </button>
          ) : phase.id === "register" ? (
            <button className="gobtn auth" disabled={regBusy || !walletClient} onClick={() => void doSignRegistration()}>
              {regBusy ? t("ticket.waitingSig") : phase.again ? t("ticket.signRegistrationAgain") : t("trig.setup.signAgain")}
            </button>
          ) : phase.id === "registering" ? (
            <button className="gobtn auth" disabled>
              {t("ticket.registering")}
            </button>
          ) : (
            <button
              className={`gobtn ${sideClass}`}
              disabled={busy || !!problem || !!triggerProblem || !!stopProblem || !!tpProblem}
              onClick={() => void doArm()}
            >
              {busy ? t("ticket.submitting") : problem ?? triggerProblem ?? stopProblem ?? tpProblem ?? ctaLabel}
            </button>
          )
        ) : session.state === "none" || session.state === "expired" ? (
          <button
            className="gobtn auth"
            onClick={() => {
              createSessionKey(address!);
              bump();
            }}
          >
            {t("ticket.enableTrading")}
          </button>
        ) : !sessionRegistered ? (
          <button className="gobtn auth" disabled={busy || !walletClient} onClick={doRegister}>
            {busy ? t("ticket.waitingSig") : t("ticket.authorizeKey")}
          </button>
        ) : (
          <button className={`gobtn ${sideClass}`} disabled={busy || !!problem} onClick={doPlace}>
            {busy ? t("ticket.submitting") : problem ?? `${ctaLabel}${queuedOpens ? ` (${queuedOpens + 1})` : ""}`}
          </button>
        )}

        {mode === "trigger" && isConnected && chainId === hyperevm.id && (
          phase.id === "register" ? (
            <div className="hint small">{phase.again ? t("ticket.registerAgainHint") : t("ticket.registerHint")}</div>
          ) : phase.id === "registering" ? (
            <div className="hint small">{t("ticket.registeringHint")}</div>
          ) : phase.id === "ready" && trigStore?.me?.kill?.on ? (
            <div className="hint small warn-text">{t("ticket.trigPaused")}</div>
          ) : phase.id === "ready" && trigStore && !trigStore.me?.watcher.alive ? (
            <div className="hint small warn-text">{t("ticket.trigWatcherDown")}</div>
          ) : phase.id === "ready" && trigStore && !trigStore.enabled ? (
            <div className="hint small warn-text">{t("ticket.trigUserPaused")}</div>
          ) : null
        )}
        {warning && !problem && <div className="hint small warn-text">{warning}</div>}
        {msg && <div className="schema-gate">{msg}</div>}
        {setupOpen && trigStore && <TriggerSetupModal store={trigStore} walletClient={walletClient} onClose={() => setSetupOpen(false)} />}

        {sessionRegistered && (
          <div className="hint small">
            {t("ticket.sessionHint")}{" "}
            <a href={explorerAddress(CONTRACTS.sessionKeyManager)} target="_blank" rel="noreferrer">
              SessionKeyManager
            </a>
            {(session.state === "active" || session.state === "unregistered") && (
              <> ({t("ticket.key")} {shortAddr(session.address)}, <button className="linklike" onClick={() => { clearSessionKey(); bump(); }}>{t("ticket.discard")}</button>)</>
            )}
            .
          </div>
        )}
      </div>
    </>
  );
}
