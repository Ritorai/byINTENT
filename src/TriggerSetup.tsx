// Enabling server-side triggers, as one flow the big ticket button drives.
//
// The ladder is: sign in (one personal_sign) → the watcher mints a key for the
// wallet (no signature) → the wallet authorises that key on-chain (one EIP-712
// signature, relayed, no gas) → the watcher sees it on-chain and the key is
// active. `triggerPhase` turns the store into the single step the user is on;
// `TriggerSetupModal` explains the flow once and runs the first two steps; the
// caller's button then reads "Sign registration" for the last one.

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { WalletClient } from "viem";
import { useI18n, type Key as I18nKey } from "./i18n";
import { relayerError } from "./protocol";
import type { ApiResult, RemoteTriggerStore as TriggerStore } from "./triggerApi";

export type TFn = (k: I18nKey, vars?: Record<string, string | number>) => string;

/** API error code → user text (falls back to the server's message or the code) */
export function apiErrorText(t: TFn, r: ApiResult): string {
  switch (r.error) {
    case "no_active_key":
      return t("trig.api.noKey");
    case "key_expired":
      return t("trig.api.keyExpired");
    case "too_many_triggers":
      return t("trig.api.tooMany");
    case "bad_spec":
      return t("trig.api.badSpec");
    case "unauthorized":
      return t("trig.api.signInFirst");
    case "rate_limited":
      return t("trig.api.rateLimited");
    case "watcher_unavailable":
    case "api_disabled":
    case "api_unavailable":
    case "network":
      return t("trig.api.offline");
    default:
      return relayerError(r.error, undefined) ?? r.message ?? r.error ?? t("ticket.failed");
  }
}

/** a wallet popup the user closed — not an error worth a red box, just "nothing happened" */
export function isUserRejection(e: unknown): boolean {
  const any = e as { code?: number; name?: string; message?: string; shortMessage?: string } | null;
  if (!any) return false;
  if (any.code === 4001 || any.name === "UserRejectedRequestError") return true;
  const m = `${any.shortMessage ?? ""} ${any.message ?? ""}`.toLowerCase();
  return m.includes("user rejected") || m.includes("user denied") || m.includes("rejected the request");
}

/** how long "registering…" is believed before the signature is offered again */
export const REGISTER_WAIT_MS = 90_000;
/** a key this close to expiry gets a renew prompt */
export const KEY_EXPIRY_WARN_MS = 3 * 24 * 3600 * 1000;

export type TriggerPhase =
  /** the trigger API itself is unreachable */
  | { id: "offline" }
  /** first /api/me not answered yet */
  | { id: "loading" }
  /** nothing usable yet: not signed in, or no / revoked / expired key → "Enable triggers" */
  | { id: "enable"; signedIn: boolean; reason: "none" | "revoked" | "expired" }
  /** key minted, waiting for the registration signature → "Sign registration" */
  | { id: "register"; again: boolean }
  /** signature sent, the watcher has not seen the key on-chain yet */
  | { id: "registering"; since: number }
  /** active key: arm away */
  | { id: "ready"; expiresIn: number; expiring: boolean };

export function triggerPhase(store: TriggerStore | null, now: number): TriggerPhase {
  if (!store) return { id: "loading" };
  if (store.apiDown) return { id: "offline" };
  if (store.authed === false) return { id: "enable", signedIn: false, reason: "none" };
  const me = store.me;
  if (store.authed == null || !me) return { id: "loading" };
  const key = me.key;
  if (!key) return { id: "enable", signedIn: true, reason: "none" };
  if (key.status === "revoked") return { id: "enable", signedIn: true, reason: "revoked" };
  if (key.status === "expired" || key.expiresAt <= now) return { id: "enable", signedIn: true, reason: "expired" };
  if (key.status === "pending") {
    const at = store.registrationSubmittedAt;
    if (at != null && now - at < REGISTER_WAIT_MS) return { id: "registering", since: at };
    return { id: "register", again: at != null };
  }
  const expiresIn = key.expiresAt - now;
  return { id: "ready", expiresIn, expiring: expiresIn < KEY_EXPIRY_WARN_MS };
}

/** 1 s wall clock for the phase helpers (expiry, "registering" timeout) */
export function useNowTick(ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}

type StepState = "todo" | "busy" | "done";

/**
 * The one explainer before the wallet pops up. "Continue" signs in (if needed)
 * and mints the key, then closes; the caller's button takes it from there with
 * the registration signature. Also used when an old key was revoked / expired.
 */
export function TriggerSetupModal({
  store,
  walletClient,
  onClose,
}: {
  store: TriggerStore;
  walletClient: WalletClient | undefined;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [busy, setBusy] = useState<null | "signin" | "mint">(null);
  const [err, setErr] = useState<string | null>(null);
  const signedIn = store.authed === true;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  const go = async () => {
    if (busy || !walletClient) return;
    setErr(null);
    try {
      if (!signedIn) {
        setBusy("signin");
        const r = await store.signIn(walletClient);
        if (!r.ok) {
          setErr(apiErrorText(t, r));
          return;
        }
      }
      setBusy("mint");
      const k = await store.mintKey();
      if (!k.ok) {
        setErr(apiErrorText(t, k));
        return;
      }
      onClose();
    } catch (e: unknown) {
      if (isUserRejection(e)) setErr(t("setup.rejected"));
      else setErr((e as { shortMessage?: string; message?: string })?.shortMessage ?? (e as { message?: string })?.message ?? String(e));
    } finally {
      setBusy(null);
    }
  };

  const steps: { title: I18nKey; detail: I18nKey; state: StepState }[] = [
    { title: "setup.step1", detail: "setup.step1d", state: signedIn ? "done" : busy === "signin" ? "busy" : "todo" },
    { title: "setup.step2", detail: "setup.step2d", state: busy === "mint" ? "busy" : "todo" },
    { title: "setup.step3", detail: "setup.step3d", state: "todo" },
  ];

  // portal: the ticket column is a transformed / scrolling ancestor on phones, which
  // would pin a fixed backdrop to it instead of the viewport
  return createPortal(
    <div className="modal-back" onClick={() => !busy && onClose()}>
      <div className="modal setup-modal" role="dialog" aria-modal="true" aria-labelledby="setup-title" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2 id="setup-title">{t("setup.title")}</h2>
          <button className="xbtn" aria-label={t("trig.cancel")} disabled={busy != null} onClick={onClose}>
            ×
          </button>
        </div>
        <p className="setup-intro">{t("setup.intro")}</p>
        <ol className="setup-steps">
          {steps.map((s, i) => (
            <li key={s.title} className={`setup-step ${s.state}`}>
              <span className="setup-num" aria-hidden>
                {s.state === "done" ? "✓" : s.state === "busy" ? "…" : i + 1}
              </span>
              <span className="setup-text">
                <b>{t(s.title)}</b>
                <small>{t(s.detail)}</small>
              </span>
            </li>
          ))}
        </ol>
        <ul className="setup-facts">
          <li className="ok">{t("setup.can")}</li>
          <li className="no">{t("setup.cannot")}</li>
          <li>{t("setup.expiry")}</li>
        </ul>
        {err && <div className="schema-gate">{err}</div>}
        <div className="setup-actions">
          <button className="close-btn" disabled={busy != null} onClick={onClose}>
            {t("trig.cancel")}
          </button>
          <button className="gobtn auth setup-go" disabled={busy != null || !walletClient} onClick={() => void go()} autoFocus>
            {busy === "signin" ? t("setup.waitingWallet") : busy === "mint" ? t("setup.minting") : t("setup.continue")}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
