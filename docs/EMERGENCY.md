# byINTENT — emergency guide (how to take the site down and bring it back)

For whoever is on call while the site is being tested. No coding needed; everything
happens in the Railway dashboard. Hand this file to your AI assistant if you want it to
walk you through it.

## What you are dealing with

- Site: your byINTENT Railway domain (and custom domain if configured). Password protected while `PW_GATED=1`.
- Hosting: Railway project, service **byINTENT**. It auto-deploys from GitHub
  `Ritorai/byINTENT`, branch `main`, within ~2 minutes of every push.
- It is a static React app plus a Node server (`server.mjs`) that proxies `/pt/*` to
  papertrade's public API and serves the trigger API under `/api/*`.
- **Server-side triggers** (Triggers tab): a separate **watcher** process holds an encrypted
  per-user *session key* (a papertrade key that can only open/close positions — it can
  never withdraw) and fires market orders when a user's trigger level is crossed. It needs
  a Postgres database. See section 6 for how to stop it.
- **The site holds no user funds.** Trading happens on-chain (HyperEVM, papertrade's
  contracts). Taking the site offline cannot lose anyone money; open positions stay open
  on-chain and can be managed on papertrade.xyz directly. The only thing a compromised
  watcher could do is open/close positions with a user's collateral — section 6 is how
  you cut that off in under a minute.

## 1. Take the site down (maintenance page) — about 1 minute

1. Log in at https://railway.app → open the project → click the **web** service box.
2. Open the **Variables** tab → **+ New Variable**
   - Name: `MAINTENANCE`
   - Value: `1`
3. Click **Add**, then the purple **Deploy** / "Apply changes" button that appears at the top.
4. Watch the **Deployments** tab: a new deployment builds (1–2 min) and turns green ("Active").

From then on every visitor, password or not, sees a dark page saying
"We're doing some maintenance. Back soon." (HTTP 503). Nothing else is reachable.

Optional: add a variable `MAINTENANCE_MESSAGE` with your own text (plain text, no HTML).

## 2. Bring the site back

Variables tab → hover `MAINTENANCE` → trash icon (or edit the value to `0`) → **Deploy**.
Green deployment = site is back exactly as before.

## 3. Other levers, from mild to drastic

| Situation | What to do |
|---|---|
| Go public (launch): no password for anyone | Variables → set `PW_GATED` to `0` → Deploy. Set it back to `1` (or delete it) → Deploy to re-enable the password. |
| Testers' password leaked / want to kick everyone out | Variables → edit `SITE_PASSWORD` to a new value → Deploy. All existing logins are invalidated instantly. |
| Lock everyone out, no page at all | Variables → delete `SITE_PASSWORD` → Deploy. The server then serves only a "Locked — SITE_PASSWORD is not configured" notice. |
| The latest deploy broke something | **Deployments** tab → find the last green deployment that was fine → **⋯** menu → **Redeploy**. Railway rebuilds that exact commit. |
| Take it fully offline (not even the maintenance page) | **Deployments** → **⋯** on the Active deployment → **Remove**. Railway then shows its own "Application not found". Bring back with Redeploy on any earlier deployment. |
| Stop new pushes from going live | Service **Settings** → **Source** → disable automatic deployments (or simply nobody pushes to `main`). |
| Something is slow / erroring and you want to know why | **Deployments** → click the Active deployment → **Deploy Logs** (runtime) or **Build Logs** (build errors). |

Do **not** use Settings → Danger → "Remove service": that deletes the custom domain
and all variables, and the site cannot be brought back with one click.

## 4. If Railway itself is unreachable: GitHub route

A bad commit can be undone on GitHub and Railway will redeploy by itself:
GitHub → repo → **Commits** → the bad commit → **⋯** → **Revert** → create and merge the
pull request into `main`. Within ~2 minutes the previous version is live again.

## 5. Facts an assistant will ask for

- Repo: https://github.com/Ritorai/byINTENT — Node 20, ES modules.
  `npm run build` (tsc + vite → `dist/`, esbuild → `server-dist/`), start command
  `node server.mjs`, listens on `$PORT`. Watcher start command: `node server-dist/watcher.mjs`.
- Environment variables the server reads:
  - `PW_GATED` — `1` (default, also when missing) = password required; `0` = public, no password.
  - `SITE_PASSWORD` — the tester password; required while `PW_GATED` is `1`. Missing = site locked.
  - `MAINTENANCE` — `1` / `true` = maintenance page for everyone.
  - `MAINTENANCE_MESSAGE` — optional custom text for that page.
  - `GATE_SECRET` — optional; extra secret mixed into the login cookie.
  - Trigger system (see section 6): `DATABASE_URL`, `AUTH_SECRET` (web only),
    `KEY_KEK` (watcher only), `WATCHER_KILL`, `WATCHER_MODE`, `API_ALLOWED_ORIGINS`,
    `WATCHER_KEY_TTL_DAYS`, `BREAKER_WALLET_FIRES_PER_HOUR`, `BREAKER_GLOBAL_FIRES_PER_MIN`,
    `WATCHER_TICK_MS`, `WATCHER_PRICE_MS`.
- Build/deploy time: roughly 1–2 minutes from clicking Deploy to the new version being live.

## 6. Server-side triggers: stopping the watcher

Two Railway services share one Postgres: **web** (has `AUTH_SECRET`, never
has `KEY_KEK`) and **watcher** (no public port, has `KEY_KEK`, never has `AUTH_SECRET`).
Only the watcher can decrypt and use session keys. Full design: `server/SPEC.md`.

### 6a. Global kill — stops ALL firing in seconds, nothing is deleted

Fastest, no redeploy: while logged in as an admin wallet on the site, open the browser
console and run

```js
fetch("/admin/watcher/kill", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ on: true, reason: "incident" }) }).then(r => r.json()).then(console.log)
```

Every user sees a red "PAUSED — the operator has stopped server-side triggers" banner on
the Triggers tab. Lift it with `{ on: false }`. `GET /admin/watcher` shows the current state,
the last heartbeat and who holds the leader lease.

Without an admin wallet: Railway → **watcher** service → Variables → add `WATCHER_KILL` = `1`
→ Deploy. (The env flag wins over the dashboard flag; delete it to lift.)

### 6b. Stop the watcher completely

Railway → **watcher** service → Deployments → ⋯ on the Active deployment → **Remove**.
No process holds `KEY_KEK` any more, so no key can be decrypted anywhere. Users see
"Watcher offline" on the Triggers tab; their armed triggers stay in the database and
resume when the watcher comes back (anything that crossed while it was down is flagged
`attention`, not fired blindly). Redeploy to bring it back.

### 6c. Keys are suspected stolen (database and `KEY_KEK` both leaked)

1. 6a or 6b first.
2. Burn every stored key: generate a new 64-hex `KEY_KEK`, set it on the watcher, and
   **do not** set `KEY_KEK_PREV`. Every stored key becomes undecryptable, so all users
   must click **Enable triggers** again, which mints a brand-new key. (`KEY_KEK_PREV` =
   the old value is only for a *planned* rotation where old keys should keep working.)
3. Announce: users who want certainty can press **Revoke on-chain** on the Triggers tab
   (one HyperEVM transaction, costs a little HYPE) — that invalidates the old key at the
   papertrade contract regardless of what any server does.
4. Rotate `AUTH_SECRET` on the web service as well → every sign-in cookie is invalidated.

### 6d. Per-user

A user can **Revoke** their own key on the Triggers tab at any time (server deletes the
ciphertext in the same transaction that cancels their live triggers — nothing to wait
for). If a user asks you to do it for them, run in Postgres:

```sql
UPDATE watcher_keys SET status = 'revoked', key_cipher = NULL, revoked_at = (extract(epoch from now())*1000)::bigint, revoke_reason = 'operator'
  WHERE wallet = lower('0x…') AND status <> 'revoked';
UPDATE triggers SET status = 'cancelled', data = data || '{"status":"cancelled","error":"key-revoked"}', version = version + 1, updated_at = now()
  WHERE wallet = lower('0x…') AND status IN ('armed','confirming','firing','attention');
```

### 6e. What the automatic breakers mean when you see them in the watcher logs

| Log line | What happened | What it did on its own |
|---|---|---|
| `BREAKER wallet-rate tripped … key revoked` | One wallet fired more than `BREAKER_WALLET_FIRES_PER_HOUR` (default 20) intents in an hour | Revoked that wallet's key, cancelled its live triggers |
| `BREAKER global-rate tripped … kill switch ON` | The whole system fired more than `BREAKER_GLOBAL_FIRES_PER_MIN` (default 60) in a minute — a feed or a bug is misbehaving | Turned the global kill ON. Investigate, then lift with 6a |
| `BREAKER unauthorized_intent ×3 … key revoked` | papertrade rejected this wallet's key 3× in 5 minutes — the key was revoked on-chain or expired | Revoked locally; user re-enables |
| `leader lost — standing by` / `lease renew failed — dropping leadership` | Another watcher instance holds the leader lease (two deploys overlapping) or the DB was unreachable | Nothing — only one instance signs at a time by design; it stops signing the instant it doubts the lease. If no `leader acquired` follows within ~30 s, check the DB |
| `pass gap … ms — re-baselining` | The engine loop stalled >5 s (restart, GC pause, DB hiccup) | Every trigger that is already past its level is parked as `attention` instead of fired on stale data; the user re-arms with one click |
| `key for … vanished from the on-chain list` | The user revoked on-chain (or papertrade removed the key) | Revoked locally, triggers cancelled |
