# Directional Agreement Experiment

## Purpose

`reliability:capture` measures whether the feeds we might trade from land on
the same 5-minute direction as Polymarket's Chainlink-derived crypto price
feed. This is not absolute price accuracy: Coinbase, Binance, spot, and perps
can all carry different bases. The question is narrower and more useful for
trading: if every source anchors to its own price at the start of the same
Polymarket 5-minute window, does it end the window on the same side?

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
clear directional windows.

## Files

- CLI: `src/bin/reliability/capture.ts`, `src/bin/reliability/chart.ts`
- Orchestration and persistence: `src/lib/reliability/runReliabilityCapture.ts`
- Stream parsers: `src/lib/reliability/feeds/`
- Dashboard renderer: `src/lib/reliability/renderReliabilityHtml.ts`
