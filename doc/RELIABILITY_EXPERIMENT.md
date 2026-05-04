# Directional Agreement Experiment

## Purpose

`reliability:capture` is the sanity check that lets us use fast exchange feeds
as practical proxies for Polymarket's Chainlink-settled 5-minute crypto
markets.

Training and live trading intentionally use Coinbase/Binance spot and perp
prices instead of Polymarket's Chainlink stream:

- Historical Chainlink Data Streams data is not available to us in the form we
  need for broad local training without paid/enterprise access.
- Coinbase/Binance spot and perp feeds are easier to capture historically and
  arrive faster live.
- That speed is the point: the exchange feeds may be small leading indicators
  for the slower Chainlink-derived Polymarket settlement feed.

The risk is proxy drift. If Binance/Coinbase often end a 5-minute window on the
opposite side from Polymarket's Chainlink feed, then training on those feeds
would teach the model the wrong settlement target and live trading would be
measuring the wrong line. This experiment exists to detect that failure mode.

This is not an absolute price-accuracy test. Coinbase, Binance, spot, and perps
can all carry different bases. The required property is narrower: when each
source anchors to its own price at the start of the same Polymarket 5-minute
window, it should virtually always finish on the same directional side as
Polymarket. "Close enough" means disagreements should be rare and should mostly
cluster around near-zero Chainlink moves where boundary timestamp jitter can
flip the sign.

The dashboard calls this **directional agreement**.

## Method

The command opens five multi-asset public streams:

- `polymarket-chainlink` — baseline RTDS `crypto_prices_chainlink`
- `coinbase-spot`
- `coinbase-perp`
- `binance-spot`
- `binance-perp`

The default asset set is the repo whitelist: `btc`, `eth`, `sol`, `xrp`,
`doge`. The runner warms up streams, skips the partial startup window, then
records complete UTC-aligned 5-minute windows.

For each asset/window/source:

1. Start price is the first observed tick at or after the window start.
2. End price is the first observed tick at or after the window end, within
   the configured grace period (`--grace-ms`, default 10,000 ms).
3. Outcome is `UP` when `end >= start`, otherwise `DOWN`.
4. Non-Polymarket sources are marked `OK` or `DIFF` against
   `polymarket-chainlink`.

Ties favor `UP`, matching the existing trading code and Polymarket's current
5-minute crypto market wording.

The command deliberately uses live boundary ticks rather than OHLC candles.
Polymarket's market wording is beginning-price vs ending-price over the titled
time range, sourced from Chainlink Data Streams. For training, our historical
pipeline approximates that with candle open/close values from the exchange
series we can actually store and replay. This experiment checks whether that
proxy is directionally reliable enough to keep using.

## Commands

```sh
bun alea reliability:capture --duration 3600 --assets btc,eth,sol,xrp,doge
bun alea reliability:capture --indefinite --assets btc,eth,sol,xrp,doge
bun alea reliability:capture --fresh
bun alea reliability:capture --resume tmp/reliability_2026-05-04T13-00-00-000Z.json
bun alea reliability:chart
bun alea reliability:chart tmp/reliability_2026-05-04T13-00-00-000Z.json
```

By default, `reliability:capture` resumes the newest compatible
`tmp/reliability_<timestamp>.json` for the requested asset set and appends new
completed windows to it. Use `--fresh` for a clean file, or `--resume <path>`
to append to a specific capture.

The JSON is written incrementally: at startup, after a window opens, after
market discovery updates, after source connect/error events, and after each
window finalizes. It writes the HTML dashboard at shutdown unless `--no-chart`
is passed.

The JSON intentionally stores compact window summaries, not raw ticks, so the
process can run for hours without memory growing with exchange tick volume.

## Reading Results

- **Agreement rate** counts only windows where both Polymarket and the source
  completed with usable boundary ticks.
- **Unavailable** includes missing start/end ticks, stale boundary captures,
  and missing Polymarket markets.
- **Near-zero diff** is the number of disagreements where the Polymarket
  baseline moved no more than `--near-zero-bp` (default 1 bp). These are the
  least alarming mismatches because tiny boundary moves are most sensitive to
  timestamp jitter and exchange basis.
- **Window ledger** is the audit trail. Red rows contain at least one source
  disagreement.

An hour-long run is a smoke sample, not proof. The useful signal is whether
disagreements cluster only around near-zero baseline moves or also appear on
clear directional windows. A clear-direction `DIFF` is the result that matters:
it says the proxy feed would have trained or traded against the wrong
settlement side for that window.

## Files

- CLI: `src/bin/reliability/capture.ts`, `src/bin/reliability/chart.ts`
- Orchestration and persistence: `src/lib/reliability/runReliabilityCapture.ts`
- Stream parsers: `src/lib/reliability/feeds/`
- Dashboard renderer: `src/lib/reliability/renderReliabilityHtml.ts`
