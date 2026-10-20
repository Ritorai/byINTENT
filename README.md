# byINTENT

A minimal trading terminal for [papertrade](https://papertrade.xyz) (synthetic BTC/ETH perps on HyperEVM) that adds what the protocol does not have: **trigger orders and stop-losses that keep working with the tab closed**.

One screen. Chart, ticket, positions. No gimmicks.

- Market orders and **Trigger** orders (fire a market order when price crosses a level) with an optional **stop on fill**
- Stop-losses on open positions, evaluated server-side
- Chart with horizontal / trend lines, magnet, and a **LIQ tool** (click a price → the leverage that busts exactly there)
- Dark and light theme, English only
- The site never holds funds. Trades settle on-chain through papertrade's relayer and contracts.

## How triggers work

A user enables triggers once: the app mints a papertrade **session key** (can open/close, can never withdraw, expires in ≤30 days) and hands it to the server, which stores it AES-256-GCM encrypted. A separate **watcher** process polls prices, and when a trigger level is crossed it signs an open/close intent with that key and submits it to papertrade's relayer. Fill price is whatever the queue gives — a trigger is not a limit order.

Full design, threat model and operational rules: [`server/SPEC.md`](server/SPEC.md). Incident runbook: [`docs/EMERGENCY.md`](docs/EMERGENCY.md).

## Stack

- Client: Vite + React 18 + TypeScript, wagmi/viem, canvas chart
- Server: Node 20, Express (`server.mjs`) — serves `dist/`, proxies `/pt/*` to papertrade (their edge rejects foreign origins), mounts the trigger API under `/api/*`
- Watcher: `server-dist/watcher.mjs` (esbuild bundle of `server/watcher.ts`)
- Postgres shared by web and watcher

## Local development

```sh
npm install
npm run dev            # vite on :5173, /pt proxied to papertrade, /api answers 503 (no server)
```

With the trigger API running locally (needs a Postgres):

```sh
# terminal 1 — web + trigger API (+ engine inline, dev only)
set DATABASE_URL=postgres://...
set AUTH_SECRET=<32+ random chars>
set KEY_KEK=<64 hex>
set WATCHER_MODE=inline
set PW_GATED=0
npm run build:server && node server.mjs      # :3000

# terminal 2 — vite with /api forwarded to it
set TRIGGER_API=http://localhost:3000
npm run dev
```

`npm run build` type-checks client and server, builds `dist/` and `server-dist/`.

## Deploy on Railway

Create a new Railway project from this GitHub repo with **two services** sharing **one Postgres**.

### 1. Postgres

Add a Postgres plugin. Railway exposes `DATABASE_URL`; reference it from both services.

### 2. `web` service (this repo, public)

- Build: `npm run build` (auto-detected) · Start: `node server.mjs` · listens on `$PORT`
- Variables:

| Variable | Value |
|---|---|
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` |
| `AUTH_SECRET` | ≥32 random characters — signs the sign-in-with-wallet cookie |
| `PW_GATED` | `0` for public, `1` (default) to require `SITE_PASSWORD` |
| `SITE_PASSWORD` | tester password while gated |
| `ADMIN_WALLETS` | comma-separated wallet addresses allowed to use `/admin/*` (kill switch) |
| `API_ALLOWED_ORIGINS` | optional, e.g. `https://byintent.xyz` — extra origins accepted on mutating `/api` calls |

Never set `KEY_KEK` on the web service.

### 3. `watcher` service (same repo, no public port)

- Build: `npm run build:server` · Start: `node server-dist/watcher.mjs`
- Variables:

| Variable | Value |
|---|---|
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` |
| `KEY_KEK` | 64 hex chars — the only secret that can decrypt session keys |
| `WATCHER_KEY_TTL_DAYS` | optional, default 30 (max 30) |
| `BREAKER_WALLET_FIRES_PER_HOUR` | optional, default 20 |
| `BREAKER_GLOBAL_FIRES_PER_MIN` | optional, default 60 |
| `WATCHER_KILL` | set to `1` to pause all firing (emergency) |

Never set `AUTH_SECRET` on the watcher.

Generate secrets:

```sh
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"   # KEY_KEK
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"   # AUTH_SECRET
```

### Other web variables

| Variable | Purpose |
|---|---|
| `MAINTENANCE` / `MAINTENANCE_MESSAGE` | `1` shows a maintenance page to everyone (503) |
| `GATE_SECRET` | optional extra secret mixed into the gate cookie |
| `ADMIN_SECRET` | optional secret for the admin cookie (falls back to `GATE_SECRET` / `SITE_PASSWORD`) |
| `EXCHANGE_URL` | papertrade relayer, default `https://exchange.papertrade.xyz` |
| `PGSSL` | `0` to disable TLS to Postgres (local only) |

## Admin: kill switch

Admin wallets (from `ADMIN_WALLETS`) sign a message via `POST /admin/auth` to get a 7-day cookie, then:

- `GET /admin/watcher` — heartbeat, lease holder, kill state, recent audit
- `POST /admin/watcher/kill` `{ "on": true, "reason": "incident" }` — pause all firing; `{ "on": false }` lifts it

Without a wallet: set `WATCHER_KILL=1` on the watcher service and redeploy.

## Repository layout

```
src/            client (App, Chart, Ticket, TradeBar, TriggerOrders, Funding, …)
shared/         code used by both client and server (trigger state machine, wallet frames, markets)
server/         trigger API + watcher (TypeScript, bundled by esbuild)
server.mjs      Express entry: static, /pt proxy, gate, /admin, mounts /api
scripts/        build-server.mjs
docs/           EMERGENCY.md
```

## Disclaimer

byINTENT is an independent frontend for the papertrade protocol and is not affiliated with it. Trading leveraged synthetic perps can lose your whole margin. Triggers fire market orders through a queue; fills are not guaranteed at the trigger level.
