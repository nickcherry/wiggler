# Trading Domain

The trading domain is the live, money-touching counterpart to the
[training domain](./TRAINING_DOMAIN.md). Training is the offline
playground where we explore filters, score candidates, and produce
dashboards; trading is the curated, version-controlled subset of that
work that the bot actually runs against real Polymarket markets.

This doc describes the full live-trading system: the probability
table, the live decision pipeline, maker-only order placement, fill
tracking, in-memory position state, and the per-window Telegram
summary. The `trading:dry-run` command exercises the decision side
without orders; `trading:live --commit` is the production trader.

## Model

The bot trades Polymarket's 5-minute crypto up/down markets — one per
5m UTC boundary, per asset (`btc`, `eth`, `sol`, `xrp`, `doge`).
Settlement: did the underlying close above or below its open price at
the 5m boundary, per the Chainlink BTC/USD (etc.) oracle.

We **measure** against Binance USDT-margined perpetual futures, not
Chainlink: Binance is faster (tens of milliseconds vs Chainlink's
hundreds), the relative move tracks the oracle closely, and the
trade-off (an occasional Binance↔Chainlink directional disagreement)
is dwarfed by the latency win for execution.

Each in-window snapshot is classified by:

- `currentSide` — `up` if `currentPrice ≥ line`, else `down`.
- `distanceBp` — `floor(|currentPrice − line| / line × 10000)`.
- `remaining` — minutes left in the window, floored to one of
  `{1, 2, 3, 4}` per the training pipeline's snapshot convention
  (snapshots happen at +1m, +2m, +3m, +4m with `remaining = 5 − N`).
- `aligned` — does `currentSide` agree with the EMA-50 regime,
  evaluated _before_ the current window opened (i.e. through the most
  recently closed 5m bar). EMA-50 of 5m closes is the only context
  filter; the training framework's other filters live in
  `src/lib/training/survivalFilters/` for experimentation but are not
  consulted by the live trader.

The probability table maps `(asset, aligned, remaining, distanceBp)`
to `P(currentSide settles winning)`, derived empirically from the
training data. Buckets thinner than `MIN_BUCKET_SAMPLES` (200) are
dropped at generation; the runtime never sees them.

## Files

- Types: [src/lib/trading/types.ts](../src/lib/trading/types.ts)
- Trading constants: [src/constants/trading.ts](../src/constants/trading.ts)
- Compute helper: [src/lib/trading/computeAssetProbabilities.ts](../src/lib/trading/computeAssetProbabilities.ts)
- Runtime lookup: [src/lib/trading/lookupProbability.ts](../src/lib/trading/lookupProbability.ts)
- Committed artifact: [src/lib/trading/probabilityTable/probabilityTable.generated.ts](../src/lib/trading/probabilityTable/probabilityTable.generated.ts)
- Decision evaluator: [src/lib/trading/decision/evaluateDecision.ts](../src/lib/trading/decision/evaluateDecision.ts)
- Live price feed: [src/lib/livePrices/](../src/lib/livePrices/)
- Polymarket discovery: [src/lib/polymarket/markets/](../src/lib/polymarket/markets/)
- Dry-run runner: [src/lib/trading/dryRun/runDryRun.ts](../src/lib/trading/dryRun/runDryRun.ts)
- Gen CLI: [src/bin/trading/genProbabilityTable.ts](../src/bin/trading/genProbabilityTable.ts)
- Dry-run CLI: [src/bin/trading/dryRun.ts](../src/bin/trading/dryRun.ts)

## Commands

### `trading:gen-probability-table`

`bun alea trading:gen-probability-table` reads the local Postgres for
the configured training candle series (binance-perp, 5m + 1m), walks
the snapshot pipeline once, applies only the EMA-50 alignment filter,
and overwrites
`src/lib/trading/probabilityTable/probabilityTable.generated.ts` plus
a JSON sidecar in `tmp/`.

**Run this whenever the underlying training data has been refreshed
and you want the live trader to use the new model.** The generated
file is committed to version control on purpose: every model change
shows up as a reviewable diff.

### `trading:dry-run`

`bun alea trading:dry-run` runs the full decision pipeline against
real feeds without placing any order:

- hydrates EMA-50 from the Binance fapi REST endpoint;
- opens one combined-stream WebSocket for `bookTicker` +
  `kline_5m` on every requested asset, with auto-reconnect and a
  stale-frame watchdog;
- discovers the current Polymarket up/down market per asset via
  gamma-api slug lookup
  (`<asset>-updown-5m-<windowStartUnixSeconds>`);
- polls the Polymarket CLOB book for both YES tokens every 2s;
- emits a one-line decision log on every `(remaining = 1, 2, 3, 4)`
  bucket transition and a per-window summary on close.

`fapi.binance.com` is unreachable from the United States; the bot is
deployed in Spain and runs locally over a non-US VPN.

## Edge calculation

For a snapshot, the table gives `ourP(currentSide wins)`. Polymarket
quotes both YES tokens; the maker entry price for either side is the
current best bid (we are exclusively maker, never taker — taker fees
on these markets can run up to 7% and would erase any edge).

Per side:

```
edge_up   = ourP_up   − bid_up
edge_down = ourP_down − bid_down
```

We pick the side with the higher edge. If the higher edge is below
`MIN_EDGE` (chunk-1 default `0.05`, hard-coded in
`src/constants/trading.ts`) the snapshot is logged as a `thin-edge`
skip; otherwise the dry-run logs `→ TAKE <SIDE>`.

### `trading:live`

`bun alea trading:live --commit` is the production trader. Same
decision pipeline as the dry-run, but it actually posts maker-only
GTC limit BUY orders ($20 fixed stake), watches fills via Polymarket's
user WS channel, settles each window with real PnL net of fees, and
ships a per-window Telegram summary.

**Maker-only enforcement.** Every order is posted with the venue's
`postOnly: true` flag. Polymarket rejects the order if it would cross
the spread (= become a taker), so taker fills are structurally
impossible. We exclusively quote against the current best bid; this
keeps fees in the maker tier (effectively 0% on these markets) and
sidesteps the up-to-7% taker fee that would erase any edge.

**One-slot-per-asset rule.** Per the chunk-2 spec, the bot holds at
most one open order _or_ one filled position per asset at a time —
never both, never more. The slot state machine lives in
`src/lib/trading/state/types.ts` and the runner's tick loop refuses
to place a new order unless the slot is `empty`.

**No database.** All state is in-memory and per-window. Polymarket is
the source of truth: on every market discovery the runner calls
`getOpenOrders` + `getTrades` and re-hydrates the slot. A process
crash and restart loses no state.

**Telegram alerts.** Two messages per window:

1. On order placement, immediately:

   ```
   Placed order for $20 of BTC ↑ @ $80,251.35

   Price line is $80,253.10
   Market expires in 2 minutes 20 seconds.
   ```

2. ~8s after window close, a summary listing every asset's outcome
   and a `Total Pnl:` line that includes the maker fee. If no asset
   traded, the body reads `No trades entered this market.` followed
   by `Total Pnl: $0.00`.

**PnL formula.** When a position settles:

```
gross = won ? sharesFilled × $1 − costUsd : −costUsd
fees  = (feeRateBps / 10_000) × costUsd
net   = gross − fees
```

We settle off the Binance perp 5m close, not the Chainlink oracle
Polymarket actually uses. The two virtually never disagree
directionally; the wallet's USDC balance remains the on-chain source
of truth, and the Telegram summary's net PnL will line up with it
under normal conditions.

**Lifecycle.** Per asset, per window:

```
T+0:00 ─── window opens, line = first WS tick mid after T
T+1:00 ─── first decision boundary (rem=4); place if TAKE + slot empty
T+2:00..+4:00 ─── same logic, only fires while slot still empty
T+4:50 ─── cancel any still-resting order (10s margin)
T+5:00 ─── window closes; kline_5m close defines the final price
T+5:08 ─── wrap-up: settle filled positions, build outcomes, send Telegram
```

## Files (live)

- Order placement: [src/lib/trading/orders/placeMakerLimitBuy.ts](../src/lib/trading/orders/placeMakerLimitBuy.ts)
- Cancel: [src/lib/trading/orders/cancelOpenOrder.ts](../src/lib/trading/orders/cancelOpenOrder.ts)
- Hydration: [src/lib/trading/orders/hydrateMarketState.ts](../src/lib/trading/orders/hydrateMarketState.ts)
- Slot state machine: [src/lib/trading/state/types.ts](../src/lib/trading/state/types.ts)
- Settlement: [src/lib/trading/state/settleFilled.ts](../src/lib/trading/state/settleFilled.ts)
- User WS channel: [src/lib/polymarket/userChannel/streamUserChannel.ts](../src/lib/polymarket/userChannel/streamUserChannel.ts)
- Telegram composers: [src/lib/trading/telegram/](../src/lib/trading/telegram/)
- Live runner: [src/lib/trading/live/runLive.ts](../src/lib/trading/live/runLive.ts)
- Live CLI: [src/bin/trading/live.ts](../src/bin/trading/live.ts)
