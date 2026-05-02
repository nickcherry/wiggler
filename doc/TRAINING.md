# Offline Training

Wiggler now owns the local candle-training pipeline that previously lived in
`../wiggler-data`.

Production remains DB-free. The live `monitor` process keeps only recent
Coinbase/Binance candles in memory for volatility and should not connect to a
database on the server. The commands here are for local research and runtime
bundle generation only.

## One-Command Refresh

For a fresh local rebuild of the runtime bundle:

```bash
createdb wiggler
cargo run -- training refresh-runtime --force-full-range
```

Defaults:

- database: `postgres://localhost:5432/wiggler`
- assets: `btc,eth,sol,xrp,doge`
- sources: Coinbase spot and Binance spot
- lookback/training window: `365` days
- output bundle: `runtime/wiggler-prod-v1`
- interval: 300 seconds, boundary-aligned only
- fee rate: `0.072`
- minimum edge: `0.015`
- minimum emitted bucket count: `500`

Useful overrides:

```bash
DATABASE_URL=postgres://localhost:5432/wiggler cargo run -- training refresh-runtime
cargo run -- training refresh-runtime --assets btc,eth --since-days 180
cargo run -- training refresh-runtime --output-dir tmp/runtime-test
cargo run -- training refresh-runtime --taker-fee-rate 0.072 --min-edge-probability 0.02
```

## Stepwise Commands

Use the stepwise flow when debugging coverage, API behavior, or model output:

```bash
cargo run -- training migrate
cargo run -- training sync --since-days 365
cargo run -- training fill-gaps --since-days 365
cargo run -- training vwap --since-days 365
cargo run -- training build-runtime --since-days 365 --output-dir runtime/wiggler-prod-v1
```

To destroy all local offline-training rows and recreate the schema:

```bash
cargo run -- training reset --yes
```

`reset` is intentionally separate from `refresh-runtime` so a normal refresh
can resume and repair coverage without deleting useful rows.

## Database Shape

The offline schema is created by `training migrate`.

`candles` stores one row per `(source, asset, timeframe, open_time)`.
OHLCV values are scaled integers in `1e8` units:

```text
source, asset, exchange_pair, timeframe,
open_time, open_time_ms,
open_e8, high_e8, low_e8, close_e8, volume_e8,
trades, fetched_at,
is_synthetic, filled_from_source, fill_reason
```

Indexes:

- primary key: `(source, asset, timeframe, open_time)`
- `candles_asset_time_idx`: `(asset, timeframe, open_time)`
- `candles_source_asset_idx`: `(source, asset, timeframe)`

`candle_sync_runs` records one audit row per source/asset sync invocation.

`candle_vwap` materializes one cross-source price per asset/minute:

```text
vwap_e8 = sum(((high + low + close) / 3) * volume) / sum(volume)
```

If every source reports zero/null volume for a minute, the command falls back
to the unweighted mean of typical prices so the training series stays dense;
`total_volume_e8 = 0` marks that fallback. Only Coinbase and Binance spot
candles contribute to this VWAP.

`training fill-gaps` makes the raw `candles` table dense when Coinbase omits
historical 1-minute candles. It inserts synthetic Coinbase rows copied from the
matching Binance minute and marks them with `is_synthetic = true`,
`filled_from_source = "binance"`, and
`fill_reason = "coinbase_source_missing"`. `training vwap` excludes synthetic
rows, so these gap fills make coverage/auditing dense without double-counting
Binance as real Coinbase liquidity.

## Sync Semantics

`training sync` fetches closed 1-minute candles only. It floors the end of the
requested window to the current minute, so it does not write a still-open candle.

By default it checks existing coverage. If the requested window is already at
least 95% covered from the old edge through the latest candle, it resumes from
the latest stored minute. If coverage is incomplete, it re-fetches the requested
window and relies on the primary key upsert to repair rows idempotently.

Coinbase and Binance use independent source-level concurrency. The default is
two concurrent series per source with no artificial per-request delay. Add
`--request-delay-ms` only if a provider starts rate-limiting local backfills.

## Runtime Generation

`training build-runtime` consumes `candle_vwap`, builds the probability grid,
filters it down to runtime-safe cells, and writes:

```text
runtime/wiggler-prod-v1/
  wiggler-runtime-manifest.json
  BTC_300s_boundary.runtime.json
  ETH_300s_boundary.runtime.json
  SOL_300s_boundary.runtime.json
  XRP_300s_boundary.runtime.json
  DOGE_300s_boundary.runtime.json
```

The model shape intentionally matches the existing runtime contract:

- 5-minute up/down markets
- true 5-minute boundary anchors
- decision buckets at 60, 120, 180, and 240 seconds remaining
- absolute distance buckets in basis points
- volatility bins from training-set 33/67/90 percentiles
- Wilson 95% one-sided lower bound
- runtime uses `p_win_lower`, not `p_win`
- `at_line` and sparse cells are not emitted to runtime

Historical labels still use VWAP as a Chainlink proxy because we do not have
historical Chainlink Data Streams prints. The generated bundle carries
`label_source_kind = "vwap_chainlink_proxy"` and `basis_risk = "unmeasured"` so
production logs can continue to expose that assumption.

## Fees And Win Rate

Crypto up/down taker fees are material. The grid itself estimates survival
probability and should not bake in an assumed order-book price. Live entries are
maker bids, so the current runtime decision gate uses zero maker fee:

```text
all_in_cost = best_bid
edge = p_win_lower - all_in_cost
```

This best bid is a price anchor for the maker limit. Order size is still a
notional-cap decision and does not use displayed best-bid depth.

The runtime bundle still records `--taker-fee-rate` for historical taker
analysis and provenance. For live maker entries, use `--min-edge-probability`
as the conservative operator lever when adverse selection or missed fills look
worse than expected.
