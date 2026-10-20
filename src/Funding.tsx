// Deposit / Withdraw modals.
//
// Deposit routes (mirroring papertrade's own modal):
//  - HyperEVM (automatic): exactly papertrade's own route. Papertrade only credits
//    USDC that lands on the *HyperCore* side of your deposit address, so a plain
//    ERC-20 transfer on HyperEVM would strand the funds. Instead the user signs
//      1. USDC.approve(CoreDepositWallet, amount)          (exact amount, no infinite approval)
//      2. CoreDepositWallet.depositFor(depositAddress, amount, spot)
//    and the CoreDepositWallet bridges the USDC to the deposit address on HyperCore,
//    where the relayer's sweeper credits it (min 10 USDC after the one-time 1 USDC
//    activation fee). Before anything is signed we POST /funding/deposits/check so
//    the sweeper watches the address, and abort unless the relayer's proxy matches
//    the one derived on-chain from the factory.
//  - HyperCore: guided — a normal Hyperliquid spot send to the deposit address.
//  - Ethereum / Arbitrum / Solana: papertrade's cross-chain routes need a CCTP hook
//    that forwards to HyperCore; we don't replicate that, so we point to their modal
//    (balance is protocol-wide) or to bridging into Hyperliquid first.
//
// Nothing here ever custodies funds: every transaction is signed by the user's own
// wallet, the only recipients are papertrade's published contracts and the user's own
// deposit address, and our server merely proxies the relayer check.
//
// Withdraw: a WithdrawToCore intent (master wallet signature) — funds arrive on
// your Hyperliquid (HyperCore) spot account.

import { useEffect, useState } from "react";
import { parseUnits } from "viem";
import { useAccount, usePublicClient, useWalletClient, useWriteContract } from "wagmi";
import { CONTRACTS, CORE_DEPOSIT_ABI, CORE_DEPOSIT_SPOT_DEX, ERC20_ABI, hyperevm, shortAddr } from "./chain";
import type { WalletSnapshot } from "./liveAccount";
import { useI18n } from "./i18n";
import { fmtUsd, relayerError } from "./protocol";
import { WITHDRAW_MIN_USDC, withdrawToCoreIntent } from "./session";
import { useDepositProxy, useForeignUsdc, useHyperCoreUsdc, useUsdcBalance } from "./wallet";

/** Papertrade's minimums: 10 USDC must arrive; a first deposit also pays 1 USDC activation. */
const MIN_ARRIVE = 10;
const ACTIVATION_FEE = 1;

/**
 * Their app sends one deposit at a time and waits for it to be credited (the sweeper
 * can drop a snapshot if two deposits land in the same window). We remember the last
 * sent deposit for an hour and compare against lifetime deposits to detect credit.
 */
interface SentDeposit {
  amount: number;
  tx: string;
  sentAtMs: number;
  depositedBefore: number;
}
const SENT_TTL_MS = 60 * 60 * 1000;
const sentKey = (addr: string) => `byintent.sent-deposit.v1:${addr.toLowerCase()}`;
function readSent(addr: string | undefined): SentDeposit | null {
  if (!addr) return null;
  try {
    const v = JSON.parse(localStorage.getItem(sentKey(addr)) ?? "null") as SentDeposit | null;
    return v && Date.now() - v.sentAtMs < SENT_TTL_MS ? v : null;
  } catch {
    return null;
  }
}

type DepositStep = "check" | "approve" | "approveWait" | "deposit" | "depositWait" | null;

/**
 * On-site deposits are parked for now: the Deposit button opens a small modal that hands off to
 * papertrade's own deposit flow in a new tab. Flip this to true to bring back the full in-app
 * route picker + HyperEVM deposit (everything below is kept wired up and working).
 */
const NATIVE_DEPOSIT = false;
const PAPERTRADE_DEPOSIT_URL = "https://exchange.papertrade.xyz/trade/btc?funding=deposit";
/** Same for withdrawals: the Withdraw button hands off to papertrade's withdrawal page for now. */
const NATIVE_WITHDRAW = false;
const PAPERTRADE_WITHDRAW_URL = "https://exchange.papertrade.xyz/trade/btc?funding=withdrawal";

export type FundingMode = "deposit" | "withdraw" | null;

/** papertrade's wordmark exactly as on their site: Inter 500, −0.04em tracking, ink + a red "_" cursor */
function PapertradeWordmark() {
  return (
    <span className="pt-wordmark" aria-label="papertrade">
      papertrade<span className="pt-wordmark-cursor">_</span>
    </span>
  );
}

interface FundingProps {
  mode: FundingMode;
  snapshot: WalletSnapshot | null;
  onClose: () => void;
  onAction: (msg: string) => void;
}

function CopyAddr({ addr }: { addr: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="copy-addr"
      title={addr}
      onClick={() => {
        navigator.clipboard.writeText(addr).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
    >
      <code>{shortAddr(addr)}</code> {copied ? t("fund.copied") : t("fund.copy")}
    </button>
  );
}

export default function Funding({ mode, snapshot, onClose, onAction }: FundingProps) {
  const { t } = useI18n();
  const { address } = useAccount();
  const { data: walletClient } = useWalletClient();
  const { writeContractAsync } = useWriteContract();
  const publicClient = usePublicClient({ chainId: hyperevm.id });
  const proxy = useDepositProxy();
  const { usdc: evmUsdc } = useUsdcBalance();
  const coreUsdc = useHyperCoreUsdc();
  const ethUsdc = useForeignUsdc("ethereum");
  const arbUsdc = useForeignUsdc("arbitrum");

  // First deposit pays the one-time activation fee. No snapshot = the protocol has
  // never seen this wallet, so treat it as a first deposit.
  const firstDeposit = !snapshot || snapshot.lifetime.deposited <= 0;
  const minDeposit = MIN_ARRIVE + (firstDeposit ? ACTIVATION_FEE : 0);

  const [route, setRoute] = useState<string | null>(null);
  const [amount, setAmount] = useState(minDeposit);
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState<DepositStep>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [sent, setSent] = useState<SentDeposit | null>(() => readSent(address));

  useEffect(() => setSent(readSent(address)), [address, mode]);
  // Once lifetime deposits grow past what they were when we sent, the deposit is credited.
  useEffect(() => {
    if (sent && address && snapshot && snapshot.lifetime.deposited > sent.depositedBefore) {
      localStorage.removeItem(sentKey(address));
      setSent(null);
    }
  }, [sent, address, snapshot]);

  if (!mode) return null;

  const close = () => {
    setRoute(null);
    setMsg(null);
    setStep(null);
    onClose();
  };

  if (mode === "deposit" && !NATIVE_DEPOSIT) {
    return (
      <div className="modal-back" onClick={close}>
        <div className="modal modal-handoff" onClick={(e) => e.stopPropagation()}>
          <button className="wallet-x handoff-x" onClick={close} aria-label="close">
            ×
          </button>
          {/* one line: "Deposit directly on [papertrade_] to start trading through byINTENT" */}
          <p className="handoff-line">
            {t("fund.handoff1")}{" "}
            <a className="pt-handoff" href={PAPERTRADE_DEPOSIT_URL} target="_blank" rel="noreferrer" onClick={close}>
              <PapertradeWordmark />
            </a>{" "}
            {t("fund.handoff2")}{" "}
            <span className="logo handoff-logo">
              by<span className="logo-accent">INTENT</span>
            </span>
          </p>
        </div>
      </div>
    );
  }

  if (mode === "withdraw" && !NATIVE_WITHDRAW) {
    const tail = t("fund.withdrawHandoff2");
    return (
      <div className="modal-back" onClick={close}>
        <div className="modal modal-handoff" onClick={(e) => e.stopPropagation()}>
          <button className="wallet-x handoff-x" onClick={close} aria-label="close">
            ×
          </button>
          {/* one line: "Withdraw your funds directly on [papertrade_]" */}
          <p className="handoff-line">
            {t("fund.withdrawHandoff1")}{" "}
            <a className="pt-handoff" href={PAPERTRADE_WITHDRAW_URL} target="_blank" rel="noreferrer" onClick={close}>
              <PapertradeWordmark />
            </a>
            {tail && <> {tail}</>}
          </p>
        </div>
      </div>
    );
  }

  const doEvmDeposit = async () => {
    if (!proxy || !address || !publicClient) return;
    setBusy(true);
    setMsg(null);
    try {
      const raw = parseUnits(amount.toFixed(2), 6);
      const usdc = CONTRACTS.usdc as `0x${string}`;
      const cdw = CONTRACTS.coreDepositWallet as `0x${string}`;

      // 1. Register the deposit address with the relayer's sweeper and make sure the
      //    relayer agrees with the on-chain derivation before a single wei moves.
      //    (The relayer validates `user` as lowercase hex and 400s on checksummed input.)
      setStep("check");
      const chk = await fetch("/pt/funding/deposits/check", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ user: address.toLowerCase() }),
      });
      const chkJson = chk.ok ? await chk.json().catch(() => null) : null;
      const relayerProxy = typeof chkJson?.proxy === "string" ? chkJson.proxy.toLowerCase() : null;
      if (!relayerProxy) throw new Error(`${t("fund.checkFailed")} (HTTP ${chk.status})`);
      if (relayerProxy !== proxy.toLowerCase()) throw new Error(t("fund.proxyMismatch"));

      // 2. Exact-amount approval for the CoreDepositWallet (skipped if already sufficient).
      const allowance = (await publicClient.readContract({
        address: usdc,
        abi: ERC20_ABI,
        functionName: "allowance",
        args: [address, cdw],
      })) as bigint;
      if (allowance < raw) {
        setStep("approve");
        const approveHash = await writeContractAsync({
          chainId: hyperevm.id,
          address: usdc,
          abi: ERC20_ABI,
          functionName: "approve",
          args: [cdw, raw],
          gas: 80_000n, // observed ~55.4k on-chain; explicit limit so wallets don't need to estimate
        });
        setStep("approveWait");
        const rc = await publicClient.waitForTransactionReceipt({ hash: approveHash });
        if (rc.status !== "success") throw new Error(t("fund.txReverted"));
      }

      // 3. The deposit itself: bridges the USDC to the deposit address on HyperCore.
      setStep("deposit");
      const hash = await writeContractAsync({
        chainId: hyperevm.id,
        address: cdw,
        abi: CORE_DEPOSIT_ABI,
        functionName: "depositFor",
        args: [proxy, raw, CORE_DEPOSIT_SPOT_DEX],
        // depositFor ends in a CoreWriter precompile call that generic tx simulators don't
        // model. Observed 62–68k on-chain; a fixed limit avoids a failing estimate being
        // the reason a wallet refuses. Unused gas is refunded.
        gas: 150_000n,
      });
      setStep("depositWait");
      const rc = await publicClient.waitForTransactionReceipt({ hash });
      if (rc.status !== "success") throw new Error(t("fund.txReverted"));

      const record: SentDeposit = {
        amount,
        tx: hash,
        sentAtMs: Date.now(),
        depositedBefore: snapshot?.lifetime.deposited ?? 0,
      };
      try {
        localStorage.setItem(sentKey(address), JSON.stringify(record));
      } catch {
        /* storage unavailable — the guard is best-effort */
      }
      setSent(record);
      onAction(t("fund.depositSent", { v: fmtUsd(amount), tx: hash.slice(0, 10) }));
      close();
    } catch (e: any) {
      setMsg(e?.shortMessage ?? e?.message ?? String(e));
    } finally {
      setBusy(false);
      setStep(null);
    }
  };

  const stepLabel = (s: DepositStep) =>
    s === "check"
      ? t("fund.stepCheck")
      : s === "approve"
        ? t("fund.stepApprove")
        : s === "approveWait"
          ? t("fund.stepApproveWait")
          : s === "deposit"
            ? t("fund.stepDeposit")
            : s === "depositWait"
              ? t("fund.stepDepositWait")
              : t("fund.confirmWallet");

  const doWithdraw = async () => {
    if (!walletClient || !address) return;
    setBusy(true);
    setMsg(null);
    try {
      const r = await withdrawToCoreIntent(walletClient, address, amount);
      if (r.ok) {
        onAction(t("fund.withdrawQueued", { v: fmtUsd(amount) }));
        close();
      } else {
        setMsg(relayerError(r.error, r.reason) ?? r.message ?? r.error ?? t("fund.rejected"));
      }
    } catch (e: any) {
      setMsg(e?.shortMessage ?? e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  };

  const routes = [
    { id: "hyperevm", label: "HyperEVM", bal: evmUsdc, note: t("fund.auto") },
    { id: "hypercore", label: "HyperCore (Hyperliquid)", bal: coreUsdc, note: t("fund.guided") },
    { id: "ethereum", label: "Ethereum", bal: ethUsdc, note: t("fund.guidedBridge") },
    { id: "arbitrum", label: "Arbitrum", bal: arbUsdc, note: t("fund.guidedBridge") },
    { id: "solana", label: "Solana", bal: null, note: t("fund.guidedBridge") },
  ];

  return (
    <div className="modal-back" onClick={close}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>{mode === "deposit" ? t("fund.depositTitle") : t("fund.withdrawTitle")}</h2>
          <button className="wallet-x" onClick={close}>
            ×
          </button>
        </div>

        {mode === "deposit" && !route && (
          <div className="route-list">
            {routes.map((r) => (
              <button className="route" key={r.id} onClick={() => setRoute(r.id)}>
                <span>
                  <b>{r.label}</b>
                  <i>{r.note}</i>
                </span>
                <span className="route-bal">
                  {r.bal != null ? `${r.bal.toLocaleString("en-US", { maximumFractionDigits: 2 })} USDC` : "—"}
                  <i>{t("fund.available")}</i>
                </span>
              </button>
            ))}
            <div className="hint small">
              {t("fund.minHint1")}{proxy && <> (<CopyAddr addr={proxy} />)</>} {t("fund.minHint2")}
            </div>
          </div>
        )}

        {mode === "deposit" && route === "hyperevm" && (
          <div className="route-flow">
            <button className="linklike" onClick={() => setRoute(null)}>
              {t("fund.allNetworks")}
            </button>
            {sent && (
              <div className="hint">
                {t("fund.pendingCredit", { v: fmtUsd(sent.amount), tx: sent.tx.slice(0, 10) })}
              </div>
            )}
            <label className="field">
              <span>{t("fund.amountMin", { min: minDeposit })}</span>
              <div className="input-row">
                <button
                  className="mini"
                  onClick={() => setAmount(Math.max(minDeposit, Math.floor((evmUsdc ?? 0) * 100) / 100))}
                >
                  {t("fund.max")}
                </button>
                <input
                  type="number"
                  min={minDeposit}
                  value={amount}
                  onChange={(e) => setAmount(Math.max(0, Number(e.target.value)))}
                />
              </div>
            </label>
            <button
              className="cta"
              disabled={busy || !proxy || !publicClient || !!sent || amount < minDeposit || (evmUsdc ?? 0) < amount}
              onClick={doEvmDeposit}
            >
              {busy ? stepLabel(step) : t("fund.depositBtn", { v: fmtUsd(amount) })}
            </button>
            <div className="hint small">
              {t("fund.evmHint1")}
              {proxy && <> (<CopyAddr addr={proxy} />)</>}
              {t("fund.evmHint2")}
              {firstDeposit && <> {t("fund.activationHint")}</>}
            </div>
          </div>
        )}

        {mode === "deposit" && route && route !== "hyperevm" && (
          <div className="route-flow">
            <button className="linklike" onClick={() => setRoute(null)}>
              {t("fund.allNetworks")}
            </button>
            <div className="hint">
              {route === "hypercore" && (
                <>
                  {t("fund.core1")} <b>{t("fund.core2")}</b>{t("fund.core3")}
                </>
              )}
              {(route === "ethereum" || route === "arbitrum" || route === "solana") && (
                <>
                  {t("fund.bridge1", { chain: route === "ethereum" ? "Ethereum" : route === "arbitrum" ? "Arbitrum" : "Solana" })}{" "}
                  <a href="https://exchange.papertrade.xyz" target="_blank" rel="noreferrer">
                    exchange.papertrade.xyz
                  </a>{" "}
                  {t("fund.bridge2")}
                </>
              )}
            </div>
            {route === "hypercore" &&
              (proxy ? (
                <div className="kv">
                  <span>{t("fund.yourAddr")}</span>
                  <b>
                    <CopyAddr addr={proxy} />
                  </b>
                </div>
              ) : (
                <div className="hint small">{t("fund.connectDerive")}</div>
              ))}
          </div>
        )}

        {mode === "withdraw" && (
          <div className="route-flow">
            <div className="kv">
              <span>{t("fund.availableWithdraw")}</span>
              <b>{snapshot ? fmtUsd(snapshot.available) : "—"}</b>
            </div>
            <label className="field">
              <span>{t("fund.amount")}</span>
              <div className="input-row">
                <button
                  className="mini"
                  onClick={() => setAmount(Math.floor((snapshot?.available ?? 0) * 100) / 100)}
                >
                  {t("fund.max")}
                </button>
                <input
                  type="number"
                  min={0}
                  value={amount}
                  onChange={(e) => setAmount(Math.max(0, Number(e.target.value)))}
                />
              </div>
            </label>
            <button
              className="cta"
              disabled={busy || !walletClient || amount < WITHDRAW_MIN_USDC || amount > (snapshot?.available ?? 0)}
              onClick={doWithdraw}
            >
              {busy ? t("fund.waitingSig") : t("fund.withdrawBtn", { v: fmtUsd(amount) })}
            </button>
            <div className="hint small">
              {t("fund.withdrawMin", { v: fmtUsd(WITHDRAW_MIN_USDC) })} {t("fund.withdrawHint")}
            </div>
          </div>
        )}

        {msg && <div className="schema-gate">{msg}</div>}
      </div>
    </div>
  );
}
