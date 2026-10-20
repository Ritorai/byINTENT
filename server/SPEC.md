# byINTENT watcher — server-side trigger orders

Status: v1, shipped to `dev`. This is the design the code in `server/` and
`shared/` implements. If the code and this file disagree, fix one of them.

## 1. Why a server

Papertrade's Exchange accepts exactly two trading intents, `OpenPosition` and
`Close`, and neither carries a price (`shared/intentSchema.ts`). A "limit
order" therefore cannot exist anywhere outside their matching engine. What we
can build is a *trigger*: watch the live price and, when it crosses the user's
level, submit the ordinary market intent. Running that watcher in the user's
browser tab (the previous design) meant a stop only existed while the tab was
open, raced across tabs, lost state with `localStorage`, and was impossible
for users to reason about. The watcher now runs on our server, 24/7.

The protocol already provides the delegation primitive: **session keys**. A
session key is registered by one master-wallet signature, can sign
`OpenPosition`, `Close` and `CancelIntent`, can **never** withdraw or stake, is
scoped to one wallet, expires (we ask for 30 days), and can be revoked on-chain
by the wallet at any time (`SessionKeyManager.revokeSessionKey(address)`,
selector `0x84f4fc6a`, verified against the implementation bytecode). A wallet
can hold several keys at once (observed: six), so the server key coexists with
the browser's key used for manual trading.

What this does **not** fix: a trigger still fires a *market* intent into their
queue. Fill price is whatever the queue gives. The UI copy keeps saying so.

## 2. Processes

```
 browser ──────────────► web (server.mjs)  ──► Postgres ◄── watcher (server-dist/watcher.mjs)
   │  /api/* (cookie)      serves app, /pt proxy,          │  leader-elected engine
   │  /pt/*  (proxy)       admin, trigger API              │  holds KEY_KEK, signs intents
   └──────────────────────────────────────────────────────►│  polls prices, consumes
                       exchange.papertrade.xyz  ◄──────────┘  per-wallet SSE, submits
```

| process | entry | public port | env it holds |
|---|---|---|---|
| `web` | `node server.mjs` | yes | `DATABASE_URL`, `AUTH_SECRET`, gate/admin vars |
| `watcher` | `node server-dist/watcher.mjs` | **none** | `DATABASE_URL`, `KEY_KEK` |

The signing process has no inbound HTTP surface at all. The public process
never holds the key-encryption key. Both are built from this repo
(`npm run build` produces `dist/` and `server-dist/`).

Dev shortcut: `WATCHER_MODE=inline` on `web` runs the engine in-process (then
`web` needs `KEY_KEK` too). Acceptable for the dev environment, not for main.

## 3. Key custody

- **Generation happens only in the watcher.** `POST /api/watcher/key` inserts a
  row into `key_requests`; the watcher loop generates a secp256k1 key,
  encrypts it, writes `watcher_keys`, and the web request long-polls the result
  (≤ 6 s). The plaintext key never exists in the web process, never crosses
  the network, never appears in a log line.
- **Encryption**: AES-256-GCM. `KEY_KEK` is 32 random bytes (hex) from the
  environment. AAD = the lowercase wallet address, so a ciphertext cannot be
  moved onto another wallet's row. Stored as `nonce(12) || tag(16) || ct`.
  `kek_id` = first 8 hex of `sha256(KEK)` so a rotation can re-encrypt rows
  under a new KEK while the old one is still present (`KEY_KEK_PREV`).
- **Use**: decrypted immediately before a signature, zeroed right after.
  Signing code paths exist only for `openPosition`, `closePositions` and
  `cancelIntent`. There is no code in the watcher that can build a
  `withdrawToCore`, `registerSessionKey` or staking intent, and the protocol
  would refuse a session-key signature on those anyway.
- **Registration**: the browser receives `{keyAddress, expiryS}`, the master
  wallet signs `RegisterSessionKey{user, key, expiry, feeAddress, nonce,
  deadline}` (same path as today's browser key), the relayer submits. The row
  moves `pending → active` when the key appears in the wallet's on-chain
  `sessionKeys` list on the SSE stream — not when the relayer says OK.
- **Expiry**: we request `WATCHER_KEY_TTL_DAYS` (default 30, max 30). The
  watcher refuses to sign with a key past its expiry regardless of what the
  chain says; the UI warns 3 days ahead and offers a one-signature renewal.

### Revocation — "stop an attacker immediately"

Three independent layers; any one of them alone stops trading.

1. **Server revoke** (`POST /api/watcher/key/revoke`, or automatic). One
   transaction: `status='revoked'`, `key_cipher=NULL`, every live trigger for
   the wallet `→ cancelled`, audit row. The ciphertext is gone before the
   response is sent, so a queued intent we already fired cannot be cancelled by
   the watcher any more — it stays cancellable from the Positions tab with the
   browser session key (the user's own key, which revoke does not touch).
   Wiping first was chosen over "cancel then wipe": the cancel would need the
   key to sign, and the whole point of revoke is that nobody signs with it
   again. The engine re-reads keys every pass (≤ 500 ms) and will
   not sign for a revoked wallet. Automatic triggers: the key vanished from the
   on-chain list (user revoked elsewhere), key expired, or the per-wallet
   breaker tripped.
2. **On-chain revoke**. The UI's "Revoke on-chain" button sends
   `revokeSessionKey(key)` from the master wallet (needs a little HYPE for
   gas). This holds even if *our* infrastructure is fully compromised, because
   the exchange stops honouring the key. The Status tab shows the button
   whenever a server key exists, and the Orders tab repeats it after a server
   revoke.
3. **Global kill**. `watcher_settings.kill = {on, reason}` set by
   `POST /admin/watcher/kill` (admin cookie) or env `WATCHER_KILL=1`. While on,
   the engine evaluates nothing and signs nothing; the UI shows a banner.
   `MAINTENANCE=1` on `web` additionally takes the API down.

Automatic breakers (each trips a kill — per wallet or global — and writes an
audit row):

- per wallet: > `BREAKER_WALLET_FIRES_PER_HOUR` (20) signatures in 60 min, or
  ≥ 3 `unauthorized_intent` answers in 5 min (someone is replaying or the key
  was revoked under us) → wallet revoke (layer 1).
- global: > `BREAKER_GLOBAL_FIRES_PER_MIN` (60) signatures in a minute → kill.
- clock: tick timestamps more than 30 s away from the server clock → the feed
  is treated as stale (nothing fires) until it recovers.

### Blast radius

| compromised | attacker can | attacker cannot |
|---|---|---|
| web process | create/cancel triggers for wallets with active keys (= place market trades), read ciphertexts | decrypt keys, withdraw, stake |
| watcher process | sign market trades for every active key until users revoke on-chain / keys expire | withdraw, stake, exceed the user's balance |
| Postgres only | read ciphertexts, trigger history | anything with the keys |
| user's browser | what the user can | — |

The user's exit in every row is the same: **revoke on-chain**. That button is
never more than one click away while a server key exists.

## 4. Auth (browser ↔ web)

Sign-in-with-wallet, one `personal_sign`, 7-day cookie.

- `POST /api/auth/challenge {address}` → stores a single-use nonce (10 min)
  and returns the message:

  ```
  byINTENT wants you to sign in with your wallet.

  Address: 0x…
  Nonce: …
  Issued At: 2026-10-20T14:00:00.000Z

  This signature only signs you in to manage trigger orders on byINTENT.
  It cannot trade or move funds by itself.
  ```
- `POST /api/auth/verify {address, nonce, signature}` → `recoverMessageAddress`
  must equal `address`, nonce is consumed, cookie `bi_sess =
  addr.exp.hmac(AUTH_SECRET)`; `HttpOnly; SameSite=Strict; Secure; Path=/api`.
- Authenticated routes take the wallet **from the cookie only**. Request
  bodies never name a wallet.
- Mutations additionally require `Content-Type: application/json` and an
  `Origin` (or `Sec-Fetch-Site: same-origin`) that matches the request host.
- Rate limits (per process, token bucket): challenge/verify 10/min/IP;
  mutations 60/min/wallet; reads 240/min/wallet. Over the limit → 429.
- `AUTH_SECRET` missing → every `/api` route answers 503; rotating it logs
  everyone out.

## 5. API

All JSON, all under `/api`. Errors: `{error: code, message?}`.

| route | auth | body → result |
|---|---|---|
| `POST /api/auth/challenge` | – | `{address}` → `{message, nonce}` |
| `POST /api/auth/verify` | – | `{address, nonce, signature}` → cookie, `{wallet}` |
| `POST /api/auth/logout` | cookie | clears cookie |
| `GET  /api/me` | cookie | `{wallet, key, watcher, kill}` — see below |
| `POST /api/watcher/key` | cookie | → `{keyAddress, expiryS}` (idempotent while pending) |
| `POST /api/watcher/key/registered` | cookie | `{intentId}` advisory; activation is on-chain |
| `POST /api/watcher/key/revoke` | cookie | → `{keyAddress}` (for the on-chain tx) |
| `GET  /api/triggers` | cookie | → `{version, enabled, entries[], stops[]}` |
| `POST /api/triggers/entry` | cookie | `ArmEntrySpec` (incl. optional `attachedStop` / `attachedTp`) → `TriggerEntry` |
| `POST /api/triggers/stop` | cookie | `ArmStopSpec` (`exit?: "stop" \| "tp"`, default stop) → `StopLoss` (supersedes the live exit *of that kind* on that position) |
| `POST /api/triggers/:id/stop` | cookie | `{stop: AttachedStop \| null, which?: "stop" \| "tp"}` sets / clears the exit a waiting entry spawns on fill |
| `POST /api/triggers/:id/cancel` | cookie | armed/confirming/attention → cancelled |
| `POST /api/triggers/:id/rearm` | cookie | attention → armed (re-baselines) |
| `POST /api/triggers/:id/cancel-queued` | cookie | asks the watcher to `cancelIntent` the fired intent |
| `POST /api/triggers/enabled` | cookie | `{enabled}` pauses/resumes this wallet's triggers |
| `GET  /admin/watcher` | admin | heartbeat, lease, counts, breaker state, audit tail |
| `POST /admin/watcher/kill` | admin | `{on, reason}` |

`key`: `null | {address, status: pending|active|revoked|expired, expiresAt,
registeredAt}`. `watcher`: `{alive, lastBeatAt, feeds: {instrumentId: ageMs}}`
— `alive` is "heartbeat younger than 10 s". `kill`: `null | {on, reason, at}`.

Server-side limits: ≤ 25 live triggers per wallet; `marginUsdc` ∈ (0, 1e6];
`leverage` integer ∈ [1, 10000] (checked again against protocol state at fire
time); `instrumentId` ∈ `MARKETS`; `positionId` decimal string; prices finite
and > 0. Every arm is validated with the same `validate*` functions the engine
trusts (`shared/triggerLogic.ts`).

The `TriggerEntry` / `StopLoss` shapes and the status vocabulary are unchanged
from the client engine, so the Orders tab and the STOP cell needed no new
states.

**Take-profit.** A TP is a `StopLoss` row with `data.exit = "tp"` — same
`kind = 'stop'` in the table (the CHECK constraint is untouched), same
evaluate / CAS-fire / `close` / reconcile path, mirrored hit test
(`stopHit`: long fires at/above the level, short at/below). Rows without
`exit` mean stop. A position may carry one live stop and one live TP; arming a
new one of a kind supersedes only that kind. A TP has no bust clamp (there is
nothing to clamp against on the profit side); its only validation is that a
fixed level sits on the profit side of the trigger / entry. On fill, an entry
spawns its `attachedStop` and `attachedTp` in the same transaction as its own
`executed` write (`updateTriggerAndSpawn(rec, spawns[])`), so a bracket is
either fully armed or not written at all.

## 6. Engine

One pass every 500 ms on the leader:

1. **Housekeeping**: read `kill`; load keys; load every non-terminal trigger;
   start/stop a price poller per instrument that has a live trigger; start/stop
   a wallet SSE per wallet that has any non-terminal trigger.
2. **Reconcile** fired items against the wallet snapshot — same state machine
   as before, now authoritative:
   `firing` → `queued` when its intent appears in `operations`, → `unknown`
   after 60 s with no result; `queued` → `expired` after the intent TTL,
   → `cancelled` if the user asked, → `executed` when its position appears
   (matched by the position tuple's `intentId`, index 9; fallback: a new
   position on that instrument that carries no other intent's id), →
   `unreconciled` only after two consecutive no-effect observations; stops →
   `done` when the position is gone before the stop fired.
3. **Stops first**, then entries oldest-first (reservation of in-flight margin
   is deterministic). Pure transitions come from `nextStopState` /
   `nextEntryState`: a cross must be confirmed by a sample with a strictly
   newer tick timestamp (≥ 600 ms later for entries); a retreat resets; a
   sample older than 10 s cannot fire anything.
4. **Fire** = one atomic CAS: `UPDATE triggers SET status='firing', fired_at=…
   WHERE id=$1 AND status IN ('armed','confirming') RETURNING *`. Zero rows →
   someone else (another leader, a cancel) won; nothing is signed. Then the
   leader lease is re-asserted, the key decrypted, the intent signed and
   submitted, the result settled on the row. Thrown/5xx → `unknown` for
   entries (never resent), re-arm with a 5 s cooldown for stops.
5. **Veto-only revalidation** at fire time (session key active, trading not
   paused, market active, leverage ≤ max, margin ≥ min, notional ≥ min,
   margin ≤ available − reserved) may kill a trigger; it never resizes it.
6. **Restart quarantine**: after a leader change every armed/confirming item
   re-baselines on its first fresh sample; already past the level → `attention`
   (a human re-arms). Same posture the client engine took on reload.

Price source: `GET /query/markets/{id}/price-history?intervalMs=125` for the
current and previous minute, every 400 ms per instrument, directly against
`exchange.papertrade.xyz` (server-to-server has no Origin problem). Sample =
latest tick `{price, ts, receivedAt}`. One poller per market serves every
user — two markets, not two per tab.

Wallet source: `GET /state/user/live?wallet=…` SSE, parsed by the same reducer
the browser uses (`shared/walletFrames.ts`), one stream per wallet with
non-terminal triggers, closed when none remain.

Nonces: `watcher_nonces(wallet, last_nonce)`; next = `max(last+1, now_ms)`
in one `UPDATE … RETURNING`. Browser nonces are also ms timestamps; the two
only collide if the server and the user fire in the same millisecond, and the
relayer rejects a duplicate harmlessly (re-arm for stops).

## 7. Failover

- **Leader lease**: `watcher_leases(name='engine', holder, until)`; acquire
  with `UPDATE … WHERE until < now() OR holder = $me`, TTL 10 s, renewed every
  2 s. Losers are hot standbys polling every 2 s. The lease is re-checked
  immediately before every signature; a lost lease aborts the fire before the
  key is touched. Even without the lease the CAS in §6.4 guarantees a trigger
  fires at most once. Run two watcher replicas on Railway and either can die.
- **Heartbeat**: `watcher_heartbeat` row every 2 s with feed ages. The UI
  shows "Watcher online · prices 0.4 s" or a red "Watcher offline since …"
  banner; `/api/me` exposes the same.
- **Restart**: all state is in Postgres. `firing` rows older than 60 s with no
  intent id → `unknown` (loud in the UI, never resent).
- **Relayer down**: stops re-arm and retry every 5 s; entries follow the N5
  rule (5xx → `unknown`). Nothing auto-resubmits an entry.
- **Postgres down**: no CAS → no fire; `web` answers 503 on `/api`. Nothing
  can double-fire.
- **Feed down**: samples go stale after 10 s → nothing fires, banner on.

## 8. Audit & logging

`watcher_audit` is append-only: key generated / activated / revoked, kill
on/off, every signature (wallet, trigger, action, intent id, relayer verdict),
every breaker trip. Nothing in any log line ever contains a private key, a
signature component, a cookie or a secret; `server.mjs` already strips `v/r/s`
from the intents log.

## 9. Threat checklist (what the pen-test probes cover)

- auth: no cookie, forged cookie, expired cookie, cookie for wallet A used to
  touch wallet B's trigger id, nonce replay, signature from a different
  address, challenge for one address verified with another.
- CSRF: cross-origin POST with a valid cookie (blocked by `SameSite=Strict`
  **and** the Origin check), non-JSON content type.
- input: NaN/Infinity/negative/huge numbers, leverage 0 / 99999, unknown
  instrument, non-decimal position ids, 1 MB bodies, 26th live trigger.
- rate limits on every route; 429 never leaks whether a wallet exists.
- kill: engine refuses to sign within one pass of `kill=on`; revoke cancels
  every live trigger and leaves no decryptable key.
- custody: `KEY_KEK` absent from the web process; `grep` the web bundle and
  logs for `0x` 64-hex strings.

## 10. Environment

| var | process | required | notes |
|---|---|---|---|
| `DATABASE_URL` | both | yes | Railway Postgres reference variable |
| `AUTH_SECRET` | web | yes for `/api` | ≥ 32 random bytes, hex; rotate = log everyone out |
| `KEY_KEK` | watcher (web only if inline) | yes | `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `KEY_KEK_PREV` | watcher | rotation only | old KEK, read-only, until all rows are re-encrypted |
| `WATCHER_MODE` | web | no | `off` (default) / `inline` |
| `WATCHER_KILL` | watcher | no | `1` = refuse to sign (env-level kill) |
| `WATCHER_KEY_TTL_DAYS` | web | no | default 30, max 30 |
| `BREAKER_WALLET_FIRES_PER_HOUR` / `BREAKER_GLOBAL_FIRES_PER_MIN` | watcher | no | 20 / 60 |

Railway: one Postgres plugin shared by both services. Second service =
same repo, start command `node server-dist/watcher.mjs`, no public domain.

## 11. Out of scope / known limits

- Limit orders. Not possible without a price field in their intents.
- Fill-price guarantees. A trigger is a market order with a condition.
- A `sessionKeyLimit` rejection on registration means the wallet is at the
  protocol's key cap; the UI lists the on-chain keys so the user can revoke
  old ones.
