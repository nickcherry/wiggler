# Price Capture Experiment

## Purpose

We're building a model that bets on Polymarket's 5-minute crypto up/down markets. Those markets settle on a Chainlink oracle price feed at the end of each 5-minute window: above the start-line price → "Up" wins, below → "Down" wins.

To bet profitably we need a directional read on where the Chainlink feed is going to land before the window closes. Chainlink itself only emits at ~1 Hz with a 0.05% deviation threshold, so by the time it tells us a move is happening the move has often already happened. The question is: **which exchange feed gives us the earliest reliable signal that Chainlink is about to move?**

We don't care about absolute price accuracy — every venue has its own basis (perps trade at funding-rate offsets to spot, individual exchanges drift relative to the cross-venue mean). What matters is the **relative move**: at the start of each 5-minute window we anchor every venue's price to its own value at T=0, and from then on we're tracking percentage deviation. The venue whose deviation reliably leads Chainlink's deviation is the one we want our model conditioned on.

This isn't the trading model itself. It's the upstream choice of "which sensor goes into the model." The model itself is a separate effort — it consumes historical 5-minute windows and learns conditional probabilities of "given price moved X% in the first N seconds, what's the probability the window settles Up vs Down?"

## Tooling

`bun wiggler prices:capture` opens public WebSocket connections to a roster of exchanges, records every BBO mid update for the configured duration, and emits both a JSON snapshot and an interactive HTML chart to `wiggler/tmp/`.

- **Default mode** (no flag): focused 5-source roster. The four candidate leading indicators plus the Chainlink baseline:
  - `binance-spot`, `binance-perp` — by far the deepest BTC venues; bookTicker fires on every BBO price-or-quantity change
  - `coinbase-spot`, `coinbase-perp` — Coinbase International perp via `BTC-PERP-INTX`; both via the `level2` channel with same price-or-qty-at-top semantics as Binance
  - `polymarket-chainlink` — the RTDS feed Polymarket itself uses to settle. **This is the baseline.** ~1 Hz, dictated by Chainlink Data Streams' heartbeat
- `--exhaustive`: adds every other supported venue (bitstamp, gemini, okx spot+swap, bybit spot+perp) and overlays spot/perp VWAP consensus lines. Used for the broader cross-venue sanity check.
- `--duration <seconds>`: capture window length (default 120). Use `--duration 300` for a 5-minute window matching one Polymarket settlement interval.

`bun wiggler prices:chart [path]` re-renders the HTML chart from a saved JSON capture. Default picks the most recent file under `wiggler/tmp/`.

## What the chart shows

Two synced uPlot panels stacked vertically:

- **Top panel**: spot venues + polymarket-chainlink (in red, thicker — this is the focal series). Polymarket is plotted on the spot panel because it tracks spot prices.
- **Bottom panel**: perp/swap venues, which sit ~$30 below spot due to funding-rate basis.

Each panel auto-fits its own y-range so the basis gap doesn't waste vertical space. Cursors sync across panels — hovering anywhere highlights the same instant in both. A floating tooltip pinned to whichever side is opposite the cursor lists every series' value at that instant.

Below the chart, a horizontal bar chart shows ticks captured per source so you can see which feeds were dense vs sparse.

## Current findings

A handful of multi-minute captures have been enough to confirm the rough lead/lag picture for BTC at low/normal volatility:

- **Binance-perp leads everything**, including spot, by a consistent few hundred ms during real moves. Its tick rate (60-200 Hz) and depth make it the cleanest leading indicator.
- **Binance-spot tracks the perp tightly**, also high-rate (30-80 Hz). Useful as a confirmation signal.
- **Coinbase-spot and Coinbase-perp** lag Binance by 0.5-2s and tick at ~2-4 Hz. Real but less dense; useful as a third corroborator.
- **Polymarket-chainlink** lags spot exchanges by 5-10s during real moves (visible during sharp moves where spot exchanges leap and the Chainlink line catches up over the next few ticks). This is the latency we're exploiting.

All four primary candidates (Binance spot+perp, Coinbase spot+perp) reliably show price movement *before* polymarket-chainlink does, which is the precondition for the trading strategy to work. Whether the lead is consistent enough at the magnitudes the bot cares about ($X-level moves over Y-second windows) is a question for the trade-model evaluation, not this experiment.

## Notes on data quality

- **Connection ramp-up** (~1.7s in the worst case): exchanges open WebSocket connections and emit their first frame at staggered intervals. The first 1-2 seconds of each capture have lines for some venues coming online while others haven't yet.
- **Apparent flat regions** are usually real BBO calmness, not feed loss. Especially Coinbase: BTC-USD has a 1¢ spread and deep inside liquidity, so the BBO genuinely doesn't churn as fast as Binance.
- **All venues' tick timestamps are local receipt time** (`Date.now()` at message arrival), not the exchange's own timestamp. For lead/lag purposes this is what matters — we want the bot's reaction time, which is gated by network arrival.
- **Polymarket's CLOB market WebSocket** (the `wss://ws-subscriptions-clob.polymarket.com` endpoint) is much higher rate (~200 Hz during active windows) but does **not** carry an underlying BTC price — it streams the binary outcome token's orderbook in $0–$1. We don't currently subscribe to it; if we want a "what are Polymarket traders pricing this market at" signal it's a separate panel and a separate analysis (and would require auto-rolling the subscription every 5 minutes as new market slots open).

## Files

- CLI: [src/bin/prices/capture.ts](../src/bin/prices/capture.ts), [src/bin/prices/chart.ts](../src/bin/prices/chart.ts)
- Orchestration: [src/lib/exchangePrices/captureAllQuoteStreams.ts](../src/lib/exchangePrices/captureAllQuoteStreams.ts), [streamStartersByExchange.ts](../src/lib/exchangePrices/streamStartersByExchange.ts)
- Per-venue stream functions: [src/lib/exchangePrices/sources/](../src/lib/exchangePrices/sources/) — one folder per venue
- Chart renderer: [renderPriceChartHtml.ts](../src/lib/exchangePrices/renderPriceChartHtml.ts)
- Volume weights for the exhaustive-mode VWAP overlays: [exchangeSpotVolumeWeights.ts](../src/lib/exchangePrices/exchangeSpotVolumeWeights.ts), [exchangePerpVolumeWeights.ts](../src/lib/exchangePrices/exchangePerpVolumeWeights.ts)
