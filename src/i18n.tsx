// Tiny i18n layer: one flat English dictionary, `{var}` interpolation, a React
// hook for components and a plain `tr()` for non-React code (canvas labels,
// formatters, API error mapping). Single language by design; the key set is the
// source of truth and `Key` is checked by the compiler.

import { createContext, useContext, type ReactNode } from "react";

const en = {
  // header
  "top.deposit": "Deposit",
  "top.withdraw": "Withdraw",
  "top.connect": "Connect",
  "top.connecting": "Connecting…",
  "top.switchNetwork": "Switch network",
  "top.wrongNetwork": "Wrong network — switch to HyperEVM",
  "top.disconnect": "Disconnect",
  "top.darkMode": "Dark mode",
  "top.toDark": "Switch to dark mode",
  "top.toLight": "Switch to light mode",

  // stats bar
  "stats.vol24h": "Vol 24h",
  "stats.oi": "OI",
  "acct.equity": "Equity",
  "acct.free": "Free",
  "acct.pnl": "Open PnL",
  "ticket.free": "Free",
  "ticket.entry": "Entry",
  "ticket.entryMarket": "Market",
  "ticket.liqDist": "{pct}% away",
  "ticket.maxLoss": "Max loss",
  "ticket.maxLossAtStop": "at stop",
  "ticket.maxLossFull": "full size",
  "ticket.pullback": "pullback",
  "ticket.breakout": "breakout",
  "ticket.cta.long": "Long {market} · {lev}x · {notional}",
  "ticket.cta.short": "Short {market} · {lev}x · {notional}",
  "ticket.cta.armLong": "Arm long {market} {cmp} {price}",
  "ticket.cta.armShort": "Arm short {market} {cmp} {price}",
  "ticket.sizePct": "{p}%",
  "status.feed": "Feed",
  "status.protocol": "Protocol",
  "status.triggers": "Triggers",
  "status.live": "live",
  "status.stale": "stale",
  "status.offline": "offline",
  "status.paused": "paused",
  "status.off": "off",
  "status.disclaimer": "Independent frontend for papertrade · settles on HyperEVM · fills are not guaranteed at trigger level",
  "stats.longOi": "Long OI",
  "stats.shortOi": "Short OI",
  "stats.live": "Live",
  "stats.reset": "Back to live",
  "stats.chartLive": "Chart is live",
  "stats.backToLive": "Back to live",

  // chart tools
  "tools.label": "Chart drawing tools",
  "tools.hline": "Horizontal line — click on the chart to place",
  "tools.trend": "Trend line — click two points on the chart",
  "tools.magnet": "Magnet — snap lines to candle open / high / low / close",
  "tools.liq": "LIQ — click a price on the chart; the ticket's leverage is set so a trade opened now busts exactly there",
  "tools.dragPanel": "Drag to widen the trade panel",
  "tools.dragBar": "Drag to make the positions panel taller",
  "liq.cant": "Can't bust there — pick a price on the other side of the live price.",
  "liq.set": "{side} ×{lev} busts at ${price} — leverage set.",
  "chart.loading": "loading live data from papertrade.xyz …",

  // sides / generic
  "side.long": "LONG",
  "side.short": "SHORT",
  "house.long": "Long",
  "house.short": "Short",
  "notice.liquidated": "LIQUIDATED {side} ×{lev} — margin forfeited (−${margin})",
  "notice.closed": "Closed {side} {pnl}",
  "ago.s": "{n}s ago",
  "ago.m": "{n}m ago",
  "ago.h": "{n}h ago",
  "ago.d": "{n}d ago",

  // ticket
  "ticket.market": "Market",
  "ticket.accountEquity": "Account Equity",
  "ticket.availableToTrade": "Available to Trade",
  "ticket.marginInUse": "Margin in Use",
  "ticket.openPnl": "Open PnL",
  "ticket.long": "Long",
  "ticket.short": "Short",
  "ticket.availableCollateral": "Free margin",
  "ticket.marginUsdc": "Size (USDC)",
  "ticket.max": "Max",
  "ticket.leverage": "Leverage",
  "ticket.sliderLabel": "Leverage slider",
  "ticket.safe": "x1 Safe",
  "ticket.wild": "Wild x{n}",
  "ticket.orderValue": "Notional",
  "ticket.bustPrice": "Liq. price",
  "ticket.connectingWallet": "Connecting Wallet…",
  "ticket.connectWallet": "Connect wallet",
  "ticket.switchNetwork": "Switch network",
  "ticket.enableTrading": "Enable trading",
  "ticket.waitingSig": "Waiting for signature…",
  "ticket.authorizeKey": "Authorize session key",
  "ticket.submitting": "Submitting…",
  "ticket.placeTrade": "Place Trade",
  "ticket.help.equity": "Show or hide account details. Account Equity is your free balance + locked margin + unrealized PnL + queued debt.",
  "ticket.help.available": "Free USDC you can spend on margin right now. Excludes margin already locked in open positions and any queued debt.",
  "ticket.help.marginInUse": "USDC currently committed as margin across open positions and pending requests.",
  "ticket.help.openPnl": "Estimated profit or loss on open positions at the current price, before settlement fees. Realised once you close.",
  "ticket.help.bust": "Liquidation is a hard bust: crossing the displayed bust price forfeits the full isolated margin, even if a voluntary close immediately beforehand could return some equity.",
  "ticket.help.halve": "Halve the current margin.",
  "ticket.help.double": "Double the current margin, up to the executable maximum.",
  "ticket.help.max": "Use the most margin Available Collateral and market limits allow, following them until you edit the margin.",
  "ticket.p.unavailable": "Live trading state is unavailable.",
  "ticket.p.tradingPaused": "Trading Paused",
  "ticket.p.marketPaused": "{market} market paused",
  "ticket.p.levRange": "Enter a whole-number leverage from 1 to {max}.",
  "ticket.p.enterMargin": "Enter margin",
  "ticket.p.minMargin": "Min margin {v}",
  "ticket.p.minNotional": "Min position value {v}",
  "ticket.p.insufficient": "Insufficient collateral",
  "ticket.p.levTooHigh": "Leverage too high for market",
  "ticket.p.posTooLarge": "Position exceeds market max size",
  "ticket.p.longOiCap": "Limited by long OI cap",
  "ticket.p.shortOiCap": "Limited by short OI cap",
  "ticket.nearOiCap": "Near OI cap; transaction may fail if another trade lands first",
  "ticket.sessionRegistered": "Session key registered — trade away.",
  "ticket.failed": "Failed.",
  "ticket.rejected": "Rejected.",
  "ticket.queued": "{side} {market} ×{lev} queued ({margin} margin).",
  "ticket.sessionHint": "Orders are signed by your local session key — no wallet popup. It can never withdraw funds; revoke any time via",
  "ticket.key": "key",
  "ticket.discard": "discard",
  "ticket.modeLabel": "Order mode",
  "ticket.modeMarket": "Market",
  "ticket.modeTrigger": "Trigger",
  "ticket.triggerPrice": "Trigger price",
  "ticket.expiry": "Expires",
  "ticket.exp.never": "Never",
  "ticket.exp.1h": "1h",
  "ticket.exp.24h": "24h",
  "ticket.exp.7d": "7d",
  "ticket.armTrigger": "Arm trigger",
  "ticket.trigFires": "{side} {lev}× — fires when {market} {cmp} ${price} · market fill, price not guaranteed",
  "ticket.trigAlreadyPast": "Price is already past this level — the trigger will fire on the next ticks.",
  "ticket.trigArmed": "Trigger armed — {side} {market} ×{lev} fires {cmp} ${price}.",
  "ticket.p.enterTrigger": "Enter a trigger price",

  // triggers (server-side trigger entries + stop-losses)
  "trig.live": "Triggers live",
  "trig.off": "Off",
  "trig.disclaimer": "A trigger fires a market order when price crosses your level — the fill price is whatever the queue gives you and is NOT guaranteed to be your level. Triggers run on the byINTENT server and keep watching with this tab closed.",
  "trig.confirmDelay": "Firing needs two fresh ticks past your level — a short built-in delay, not protection against gaps.",
  "trig.status.armed": "Armed",
  "trig.status.confirming": "Confirming…",
  "trig.status.firing": "Firing…",
  "trig.status.queued": "Queued",
  "trig.status.executed": "Executed",
  "trig.status.unknown": "UNKNOWN",
  "trig.status.unreconciled": "Unreconciled",
  "trig.status.attention": "Needs re-arm",
  "trig.status.failed": "Failed",
  "trig.status.expired": "Expired",
  "trig.status.cancelled": "Cancelled",
  "trig.status.done": "Done",
  "trig.cancel": "Cancel",
  "trig.arm": "Arm stop",
  "trig.stopPrice": "Stop price",
  "trig.warn.bustFirst": "This stop is beyond the bust price (${bust}) — liquidation will almost certainly fire first.",
  "trig.warn.pastMarket": "Price is already past this stop — it will fire immediately.",
  "trig.notice.entryQueued": "Trigger fired — {side} {market} ×{lev} queued ({margin} margin).",
  "trig.notice.entryExecuted": "Trigger executed — {side} {market} ×{lev} filled at ${price}.",
  "trig.notice.entryUnknown": "Trigger submission outcome UNKNOWN — {side} {market}. Check the queue before re-arming.",
  "trig.notice.unreconciled": "A trigger intent left the queue with no visible effect — check History.",
  "trig.notice.entryFailed": "Trigger failed — {side} {market}: {error}",
  "trig.notice.entryExpired": "Trigger expired — {side} {market} ×{lev}.",
  "trig.notice.stopQueued": "Stop fired — close queued for the {market} position.",
  "trig.notice.stopExecuted": "Stop executed — the {market} position is closed.",
  "trig.notice.stopFailed": "Stop-loss failed — {market}: {error}",
  "trig.notice.stopDone": "Stop-loss cleared — the {market} position was already closed.",
  "trig.notice.stopUnknown": "Stop submission outcome UNKNOWN — {market}. Check the queue; do not assume the position is closed.",
  "trig.notice.stopExpired": "Stop expired — the {market} position is still open; its queued close passed the deadline.",
  "trig.err.session": "Watcher key inactive or revoked",
  "trig.err.noProto": "Protocol state unavailable",
  "trig.err.marketUnavailable": "Market paused or inactive at fire time",
  "trig.err.levTooHigh": "Leverage above the market max at fire time",
  "trig.err.tradingPaused": "Trading paused",
  "trig.err.noSnapshot": "Account state unavailable",
  "trig.err.insufficient": "Insufficient available collateral at fire time",
  "trig.err.belowMinTrade": "Below the minimum margin at fire time",
  "trig.err.belowMinNotional": "Below the minimum position value at fire time",
  "trig.err.interrupted": "Interrupted before the result was recorded",
  "trig.unknownNote": "Submission outcome unknown — check the queue before re-arming. It was never auto-resubmitted.",
  "trig.attentionNote": "Price was already past this level when the watcher (re)started, so it did not fire. Re-arm to activate it.",
  "trig.unreconciledNote": "The intent left the queue with no visible effect — check History before re-placing anything.",
  "trig.rearm": "Re-arm",
  "trig.watcherStale": "Watcher unhealthy — the live price is stale, so triggers may not fire.",
  "trig.watcherDelayed": "Watcher was delayed at {time}; levels were re-checked when it caught up.",
  "trig.unprotected": "UNPROTECTED — the watcher cannot sign for this wallet right now (key inactive, revoked or expired); this trigger cannot fire.",
  "trig.notice.resumed": "{n} armed trigger(s) resumed from your last session.",
  "trig.queueRank": "queue #{n}",
  "trig.cancelQueued": "Cancel intent",
  "trig.slippage": "Executed at ${exec} vs trigger ${trig} ({pct})",
  "trig.stopPnl": "Closed: {pnl}",
  "trig.confirmPast": "Price is already past this stop — arming closes the ENTIRE position on the next check. Click again to confirm.",
  "trig.closesEntire": "A stop closes the ENTIRE position — the protocol has no partial close.",
  "trig.warn.bustClose": "Within 10% of the bust distance — too close to liquidation to reliably protect you given queue delays.",
  "trig.warn.bustBuffer": "Too close to liquidation — queue delay can let liquidation win.",
  "trig.lossAtStop": "Est. at stop: {pnl} ({pct}% of margin) — gaps and queue delay can make it worse",
  "trig.lastError": "Last attempt: {error}",
  "trig.type.entry": "Trigger",
  "trig.type.stop": "Stop",
  "trig.addStop": "+ Stop",
  "trig.confirm": "Confirm",
  "trig.noOrders": "Nothing armed. Switch the ticket to Trigger to arm an entry, or add a stop to an open position.",
  "trig.connectOrders": "Connect a wallet to arm triggers and stop-losses.",
  "trig.noticeArmed": "Stop armed — {market} closes at {cmp} ${price} (est. {pnl}).",

  "setup.title": "Enable triggers",

  "setup.intro": "Triggers run on the byINTENT server, so they fire even when this tab is closed. Enabling takes two wallet signatures — no transactions, no gas.",

  "setup.step1": "Sign in",

  "setup.step1d": "One signature proves you own this wallet.",

  "setup.step2": "Key minted",

  "setup.step2d": "The server creates a dedicated trading key for your wallet. It never leaves the server.",

  "setup.step3": "Authorize the key",

  "setup.step3d": "One more signature registers it on-chain. From then on it can open and close positions for you.",

  "setup.can": "Can open and close positions on your behalf",

  "setup.cannot": "Cannot withdraw, transfer or touch anything else",

  "setup.expiry": "Expires on its own · revoke any time from the Triggers tab",

  "setup.continue": "Continue",

  "setup.waitingWallet": "Waiting for wallet…",

  "setup.minting": "Minting key…",

  "setup.rejected": "Signature rejected — nothing was changed.",

  "ticket.signRegistrationAgain": "Sign registration again",

  "ticket.registering": "Registering key…",

  "ticket.registerHint": "Last step: one signature registers your trading key on-chain. No gas, no transaction from your wallet.",

  "ticket.registerAgainHint": "The registration hasn't shown up on-chain yet. Sign again to resend it.",

  "ticket.registeringHint": "Your key is being registered on-chain — usually a few seconds.",

  "ticket.trigOffline": "Triggers offline",

  "ticket.trigWatcherDown": "Watcher offline — armed triggers won't fire until it is back.",

  "ticket.trigPaused": "Triggers are paused by the operator — nothing fires right now.",

  "ticket.trigUserPaused": "Your triggers are paused — switch them back to Live in the Triggers tab.",

  "trig.strip.none": "Not enabled",

  "trig.strip.revoked": "Key revoked",

  "trig.strip.expired": "Key expired",

  "trig.strip.pending": "Key minted · needs your signature",

  "trig.strip.registering": "Key minted · registering on-chain…",

  "trig.strip.live": "Live",

  "trig.strip.paused": "Paused",

  "trig.strip.liveWhy": "Armed triggers fire. Click to pause them all without cancelling.",

  "trig.strip.pausedWhy": "Paused — armed triggers are kept but nothing fires until you switch back to Live.",

  "trig.strip.key": "Key {key} · {age} left",

  "trig.empty.enable": "Server-side, fires with this tab closed.",

  "trig.footShort": "Market fill when price crosses your level — the fill is not guaranteed at the level. A stop closes the whole position.",

  "ticket.stopOnFill": "Stop on fill",

  "ticket.stopOnFillWhy": "Optional. The moment this trigger fills, the watcher arms a stop-loss on the new position — a % below your fill price (above for shorts) or a fixed price. You can change it in the Triggers tab while the trigger waits.",

  "ticket.stopOff": "Off",

  "ticket.stopOnFillEst": "Stop ≈ {cmp} ${price} once filled · about −{loss} ({pct}% of margin). Set from the real fill price.",

  "ticket.p.enterStop": "Enter a stop",

  "ticket.p.stopWrongSide": "Stop must be on the loss side of the trigger",

  "ticket.p.stopBeyondBust": "Stop is past the bust price at this leverage",

  "trig.stopOnFillLine": "Stop-loss the watcher will arm at ≈ ${level} the moment this entry fills. Click to change, × to remove.",

  "trig.stopOnFillPending": "Fired — the stop is created when the fill lands.",

  "trig.stopOnFillSet": "Stop on fill set — ≈ ${level} once the entry executes.",

  "trig.stopModePct": "Distance from the fill price in % — click for a fixed price",

  "trig.stopModePrice": "Fixed price — click for % from fill",

  "trig.spawnedStop": "stop armed on the position",

  "trig.spawnedClamped": "stop was past the real bust price — moved just inside it",

  "trig.spawnFailed": "stop NOT created — add one in Positions",

  // take-profit — the favourable twin of the stop. Same market close of the whole position, mirrored side.
  "tb.tpCol": "TP",
  "ticket.tpOnFill": "Take profit on fill",
  "ticket.tpOnFillWhy": "Optional. The moment this trigger fills, the watcher arms a take-profit on the new position — a % above your fill price (below for shorts) or a fixed price. It fires a market close when price reaches the level. You can change it in the Triggers tab while the trigger waits.",
  "ticket.p.enterTp": "Enter a take profit",
  "ticket.p.tpWrongSide": "Take profit must be on the profit side of the trigger",
  "ticket.reward": "Reward",
  "ticket.atTp": "at TP",
  "trig.tpPrice": "TP price",
  "trig.addTp": "+ TP",
  "trig.type.tp": "Take profit",
  "trig.tpClosesEntire": "A take-profit closes the ENTIRE position at market when price reaches the level — the protocol has no partial close.",
  "trig.gainAtTp": "Est. at TP: {pnl} ({pct}% of margin) — market fill, the level is not guaranteed",
  "trig.noticeTpArmed": "Take profit armed — {market} closes at {cmp} ${price} (est. {pnl}).",
  "trig.warn.tpWrongSide": "This is on the loss side of your entry (${entry}) — it would lock in a loss, not take a profit.",
  "trig.tpOnFillLine": "Take-profit the watcher will arm at ≈ ${level} the moment this entry fills. Click to change, × to remove.",
  "trig.tpOnFillPending": "Fired — the take-profit is created when the fill lands.",
  "trig.tpOnFillSet": "Take profit on fill set — ≈ ${level} once the entry executes.",
  "trig.spawnedTp": "take-profit armed on the position",
  "trig.spawnTpFailed": "take-profit NOT created — add one in Positions",
  "trig.notice.tpQueued": "Take profit hit — close queued for the {market} position.",
  "trig.notice.tpExecuted": "Take profit executed — the {market} position is closed.",
  "trig.notice.tpFailed": "Take-profit failed — {market}: {error}",
  "trig.notice.tpDone": "Take-profit cleared — the {market} position was already closed.",
  "trig.notice.tpUnknown": "Take-profit submission outcome UNKNOWN — {market}. Check the queue; do not assume the position is closed.",
  "trig.notice.tpExpired": "Take-profit expired — the {market} position is still open; its queued close passed the deadline.",

  "trig.err.policyNotional": "Blocked by your max-notional-per-fire limit",
  "trig.err.policyExposure": "Blocked by your max trigger-exposure limit",
  "trig.err.policyDailyLoss": "Daily loss stop — entries paused until tomorrow (or you clear it)",
  "trig.err.policyFires": "Blocked by your max-fires-per-day limit",
  "trig.err.policyMarket": "This market is not allowed by your policy",
  "trig.err.policyLeverage": "Blocked by your max-leverage limit",

  "trig.trail": "Trail",
  "trig.trailWhy": "The stop follows price by this distance and never loosens. Same market close of the whole position.",
  "trig.trailPct": "% trail",
  "trig.type.trail": "Trail",

  "policy.title": "Limits",
  "policy.saved": "Limits saved — they apply to the next entry fire.",
  "policy.cleared": "Daily-loss trip cleared — waiting entries can fire again.",
  "policy.tripped": "tripped",
  "policy.tripLine": "Daily loss stop hit ({pnl} today).",
  "policy.clear": "Clear",
  "policy.save": "Save limits",
  "policy.bad": "Limits must be empty or a positive number.",
  "policy.maxNotional": "Max $ / fire",
  "policy.maxExposure": "Max trigger exposure $",
  "policy.dailyLoss": "Daily loss stop $",
  "policy.maxFires": "Max fires / day",
  "policy.maxLev": "Max leverage",
  "policy.today": "Today {pnl} · {fires} fires · {exp} trigger exposure",

  "ladder.title": "Entry",
  "ladder.one": "Single",
  "ladder.many": "Ladder",
  "ladder.range": "Range",
  "ladder.from": "From",
  "ladder.to": "To",
  "ladder.count": "Rungs",
  "ladder.cta": "Arm {n} {market} · {lev}x",
  "ladder.armed": "Ladder armed — {n} {market} triggers from ${from} to ${to}.",
  "ladder.cancelRest": "Cancel ladder",
  "ladder.cancelled": "Remaining ladder rungs cancelled.",
  "ladder.p.range": "Set a from/to range and 2–20 rungs",
  "ladder.p.minMargin": "Each rung needs at least {v} margin — raise size or drop rungs (now {n})",
  "ladder.p.minNotional": "Each rung is below the {v} min notional — raise size, leverage, or drop rungs (now {n})",

  "trig.historyTitle": "Triggers",

  "trig.filled": "Filled",

  "trig.err.killed": "Server-side triggers are paused by the operator",

  "trig.err.keyRevoked": "Watcher key revoked — re-enable triggers to arm again",

  "trig.err.keyExpired": "Watcher key expired — re-enable triggers to arm again",

  "trig.api.noKey": "Enable triggers first — the button in the ticket walks you through it.",

  "trig.api.keyExpired": "Your watcher key has expired — press Enable triggers to mint a new one.",

  "trig.api.tooMany": "Too many live triggers on this wallet (max 25). Cancel some first.",

  "trig.api.badSpec": "The server rejected this trigger (invalid level, size or market).",

  "trig.api.signInFirst": "Not signed in — press Enable triggers.",

  "trig.api.rateLimited": "Too many requests — slow down a little.",

  "trig.api.offline": "Server-side triggers are offline right now. Nothing can be armed or will fire until they return.",

  "trig.setup.signInWhy": "Triggers run on the byINTENT server so they fire with this tab closed. Sign in once to see and manage yours.",

  "trig.setup.signIn": "Sign in",

  "trig.setup.signInFirstList": "Enable triggers to see yours here.",

  "trig.setup.enableWhy": "Enable server-side triggers: the watcher gets its own session key for your wallet, registered by one signature. It can only open and close positions — never withdraw.",

  "trig.setup.enable": "Enable triggers",

  "trig.setup.revokedWhy": "The watcher key was revoked. Re-enable to arm triggers again (a brand-new key is minted).",

  "trig.setup.expiredWhy": "The watcher key expired. Re-enable to arm triggers again (a brand-new key is minted).",

  "trig.setup.pending": "Key minted — it still needs to be registered on-chain with one wallet signature before triggers can fire.",

  "trig.setup.signAgain": "Sign registration",

  "trig.setup.expiring": "Watcher key expires in {age}. Revoke it and enable triggers again for a fresh key (this cancels live triggers).",

  "trig.setup.keyLine": "Watcher key {key} · expires in {age} ·",

  "trig.setup.revoke": "Revoke",

  "trig.setup.revokeConfirm": "Revoke now (cancels all live triggers)",

  "trig.setup.revoked": "Watcher key revoked server-side — it can no longer sign. For belt and braces also revoke it on-chain.",

  "trig.setup.onChain": "Revoke on-chain",

  "trig.setup.onChainWhy": "Sends a HyperEVM transaction that removes the key from the SessionKeyManager — the protocol itself then refuses it, whatever our server does. Needs a little HYPE for gas.",

  "trig.setup.onChainSent": "On-chain revoke sent ({hash}).",

  "trig.watcherKilled": "PAUSED — the operator has stopped server-side triggers. Nothing will fire until this is lifted.",

  "trig.watcherOffline": "Watcher offline — last heartbeat {age} ago. Armed triggers will NOT fire until it is back.",

  "trig.watcherNever": "Watcher offline — no heartbeat yet. Armed triggers will NOT fire until it is running.",

  "ticket.trigNeedsSignIn": "Enable triggers",

  "ticket.trigNeedsKey": "Enable triggers",

  // trade bar
  "tb.positions": "Positions",
  "tb.orders": "Triggers",
  "tb.history": "History",
  "tb.status": "Status",
  "tb.stopCol": "Stop",
  "tb.type": "Type",
  "tb.level": "Level",
  "tb.distance": "Distance",
  "tb.expires": "Expires",
  "tb.statusCol": "Status",
  "tb.openPositions": "Open Positions",
  "tb.closeAll": "Close All",
  "tb.asset": "Market",
  "tb.notional": "Size",
  "tb.entry": "Entry",
  "tb.mark": "Mark",
  "tb.pnl": "PnL",
  "tb.bust": "Liq",
  "tb.risk": "To liq",
  "tb.margin": "Margin",
  "tb.when": "Age",
  "tb.connectPositions": "Connect wallet to view your positions.",
  "tb.noOpen": "No Open Positions",
  "tb.queueN": "Queue #{n}",
  "tb.queued": "Queued",
  "tb.queuedDots": "Queued…",
  "tb.cancelling": "Cancelling…",
  "tb.cancel": "Cancel",
  "tb.closing": "Closing…",
  "tb.close": "Close",
  "tb.entryExit": "Entry → Exit",
  "tb.fee": "Fee",
  "tb.duration": "Duration",
  "tb.outcome": "Outcome",
  "tb.connectHistory": "Connect wallet to view your history.",
  "tb.loadingHistory": "Loading History…",
  "tb.noHistory": "No trade history yet.",
  "tb.liquidated": "Liquidated",
  "tb.closed": "Closed",
  "tb.protocol": "Protocol",
  "tb.tradingPaused": "trading paused",
  "tb.tradingLive": "trading live",
  "tb.minTrade": "Minimum trade",
  "tb.minTradeVal": "{m} USDC margin · {n} notional",
  "tb.openInterestOf": "{sym} open interest",
  "tb.disclaimer": "byINTENT is an independent frontend for the papertrade protocol. All trades settle on-chain through papertrade's relayer and contracts on HyperEVM.",
  "tb.riskBust": "Price is in the bust region. Liquidation forfeits the full isolated margin.",
  "tb.riskPct": "{p}% of the distance to bust",
  "tb.bustTag": "BUST",
  "tb.cancelled": "Queued intent cancelled.",
  "tb.cancelFailed": "Cancel failed.",
  "tb.closeQueued": "Close request queued ({n} position(s)).",
  "tb.closeFailed": "Close failed.",

  // funding
  "fund.depositTitle": "Deposit USDC",
  "fund.handoff1": "Deposit directly on",
  "fund.handoff2": "to start trading through",
  "fund.withdrawHandoff1": "Withdraw your funds directly on",
  "fund.withdrawHandoff2": "",
  "fund.withdrawTitle": "Withdraw USDC",
  "fund.copy": "copy",
  "fund.copied": "✓ copied",
  "fund.available": "available",
  "fund.auto": "automatic, from this wallet",
  "fund.guided": "guided",
  "fund.guidedBridge": "guided bridge",
  "fund.minHint1": "Minimum 10 USDC must arrive (first deposit +1 USDC activation). Funds are credited only when they land on the HyperCore side of your personal deposit address",
  "fund.minHint2": "— the HyperEVM route handles that for you; never send plain HyperEVM USDC to the address.",
  "fund.allNetworks": "← all networks",
  "fund.amountMin": "Amount (USDC, min {min})",
  "fund.max": "Max",
  "fund.confirmWallet": "Confirm in wallet…",
  "fund.depositBtn": "Deposit {v}",
  "fund.evmHint1": "Two wallet confirmations: approve the exact amount, then deposit. papertrade's CoreDepositWallet bridges the USDC to your deposit address",
  "fund.evmHint2": " on HyperCore, where it is credited automatically (usually within a minute).",
  "fund.activationHint": "Your first deposit pays a one-time 1 USDC account activation fee.",
  "fund.pendingCredit": "A deposit of {v} (tx {tx}…) is still being credited. Wait until it shows in your balance before sending another.",
  "fund.checkFailed": "Could not reach papertrade's deposit service. Nothing was sent — try again shortly.",
  "fund.proxyMismatch": "Deposit address mismatch between the relayer and the contract. Nothing was sent.",
  "fund.txReverted": "The transaction reverted on-chain.",
  "fund.stepCheck": "Checking deposit address…",
  "fund.stepApprove": "Confirm approval in wallet (1/2)…",
  "fund.stepApproveWait": "Approval confirming…",
  "fund.stepDeposit": "Confirm deposit in wallet (2/2)…",
  "fund.stepDepositWait": "Deposit confirming…",
  "fund.core1": "In the Hyperliquid app use",
  "fund.core2": "Send (spot USDC)",
  "fund.core3": " to your deposit address below. It lands on HyperCore and is credited automatically once ≥10 USDC arrives (Hyperliquid may charge its own fee for a first transfer to a fresh address). Do not use “Transfer to EVM”.",
  "fund.bridge1": "Deposits from {chain} need papertrade's bridge route (Circle CCTP with a HyperCore forwarding hook), which this site does not replicate. Use the official deposit modal on",
  "fund.bridge2": "— your balance is protocol-wide and shows up here too. Or bridge into your own Hyperliquid account first and use the HyperCore route.",
  "fund.yourAddr": "Your deposit address (HyperCore)",
  "fund.connectDerive": "Connect your wallet to derive your deposit address.",
  "fund.availableWithdraw": "Available to withdraw",
  "fund.amount": "Amount (USDC)",
  "fund.waitingSig": "Waiting for signature…",
  "fund.withdrawBtn": "Withdraw {v} to Hyperliquid",
  "fund.withdrawHint": "Signed by your main wallet (session keys can't withdraw — by design). Funds arrive on your Hyperliquid spot account.",
  "fund.withdrawMin": "Minimum {v}.",
  "fund.depositSent": "Deposit sent ({v}) — credited automatically once it lands on HyperCore. tx {tx}…",
  "fund.withdrawQueued": "Withdrawal queued ({v}) — arrives on your Hyperliquid spot account.",
  "fund.rejected": "Rejected.",


  // drawing popup
  "dp.title": "Line style",
  "dp.thickness": "Thickness",
  "dp.style": "Style",
  "dp.solid": "Solid",
  "dp.dashed": "Dashed",
  "dp.colour": "Colour",
  "dp.colourX": "Colour {c}",
  "dp.custom": "Custom colour",
  "dp.extend": "Extend",
  "dp.extendLeft": "Extend line infinitely to the left",
  "dp.extendRight": "Extend line infinitely to the right",
  "dp.left": "← Left",
  "dp.right": "Right →",
  "dp.delete": "Delete",
  "dp.done": "Done",

  // relayer errors
  "err.unauthorized_intent": "Signature rejected — register your session key first.",
  "err.deadline_expired": "This request expired before it was accepted. Try again.",
  "err.rate_limited": "Too many requests. Try again in a moment.",
  "err.alreadyQueued": "You already have a request of this kind waiting in the queue. Wait for it to land (or cancel it) before sending another.",
  "err.sessionKeyLimit": "This wallet has reached its trading-session limit. Reuse an existing session or wait for one to expire.",
  "err.tradingPaused": "Trading is paused right now. Try again once it resumes.",
  "err.marketPaused": "This market is paused. Try again once it reopens.",
  "err.inactiveInstrument": "This market is no longer trading.",
  "err.belowMinimum": "Below the minimum trade size. Raise your margin and try again.",
  "err.belowMinimumNotional": "Position value (margin × leverage) is below the minimum. Raise margin or leverage and try again.",
  "err.leverageTooHigh": "Leverage exceeds this market's limit. Lower it and try again.",
  "err.leverageTooLow": "Leverage is below the minimum. Raise it and try again.",
  "err.positionTooLarge": "This position exceeds the market's size limit. Reduce your margin or leverage.",
  "err.openInterest": "This market has reached its open interest limit. Try a smaller size or try again later.",
  "err.funding": "Your available collateral has changed. Review your balance and reduce the trade size.",
  "err.noOpenPositions": "These positions are already closed or have a close request pending.",
  "err.noDeposit": "No deposit found for this wallet yet. Deposit on papertrade_ first.",
  "err.invalid_intent": "The relayer could not validate this request. Review it and try again.",
  "err.below_minimum_withdrawal": "Withdraw at least 10 USDC to HyperCore.",

};

export type Key = keyof typeof en;
export type Vars = Record<string, string | number>;

function format(s: string, vars?: Vars): string {
  if (!vars) return s;
  return s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
}

/** Translate outside React (canvas labels, formatters, API messages). */
export function tr(key: Key, vars?: Vars): string {
  return format(en[key], vars);
}

interface Ctx {
  t: (key: Key, vars?: Vars) => string;
}
const I18nContext = createContext<Ctx>({ t: tr });

export function I18nProvider({ children }: { children: ReactNode }) {
  return <I18nContext.Provider value={{ t: tr }}>{children}</I18nContext.Provider>;
}

export function useI18n(): Ctx {
  return useContext(I18nContext);
}