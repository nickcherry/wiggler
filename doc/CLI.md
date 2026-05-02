# CLI

`wiggler` is a CLI-first application.

During development, run commands through Cargo:

```bash
cargo run -- <command>
```

The binary loads a repo-root `.env` file on startup when one is present.

After release/build, the binary itself is the entrypoint:

```bash
target/release/wiggler <command>
```

## Commands

### `doctor`

Checks Gamma discovery for current and upcoming Polymarket slots.

```bash
cargo run -- doctor
cargo run -- doctor --assets btc,eth,sol,xrp,doge --slot-seconds 300 --lookahead-slots 1
```

Output is pretty JSON so it can be read by a human or parsed by tooling.

Side effects:

- Makes public Gamma REST requests.
- Does not open websockets.
- Does not send Telegram messages.
- Does not write files.

### `analyze-trades`

Analyzes closed trade performance using Polymarket API trade/resolution data
and the runtime-bundle fee model.

```bash
cargo run -- analyze-trades --user 0x...
POLYMARKET_USER_ADDRESS=0x... cargo run -- analyze-trades
cargo run -- analyze-trades --assets btc,eth,sol --max-trades 1000
```

Default behavior:

- Assets: `btc,eth,sol,xrp,doge`
- Slot width: `300` seconds
- Runtime fee source: `runtime/wiggler-prod-v1` unless overridden with
  `--runtime-bundle-dir`/`WIGGLER_RUNTIME_BUNDLE_DIR`
- Trades fetched for entry-time matching and PnL calculation: up to `10000`
- Wallet source: `--user`, then `POLYMARKET_USER_ADDRESS`, then
  `POLYMARKET_FUNDER_ADDRESS`; EOA configs can fall back to the
  `POLYMARKET_PRIVATE_KEY` address

Output is formatted for a terminal and includes overall results plus breakdowns
by asset, time remaining, entry-vs-line availability, and average entry odds.
Each section includes absolute fees, fee drag as a share of gross edge before
fees, and fees as a share of pre-fee traded notional.

The report computes each buy fill's net PnL from Data API trade rows plus
Gamma's resolved outcome prices, then subtracts the runtime-bundle estimated
taker entry fee: `shares * fee_rate * price * (1 - price)`. The
entry-vs-start-line section intentionally remains API-only: Polymarket APIs do
not include the historical underlying start-line price or underlying price at
entry, so the command will not backfill that from local trade records or
external price archives.

Side effects:

- Makes public Polymarket Data API and Gamma REST requests.
- Does not open websockets.
- Does not send Telegram messages.
- Does not write files.

### `training`

Owns the local offline candle database and runtime-bundle generation pipeline.
These commands are for local research/training only; the production `monitor`
does not use Postgres.

Common one-command flow:

```bash
cargo run -- training refresh-runtime
cargo run -- training refresh-runtime --force-full-range
cargo run -- training refresh-runtime --assets btc,eth --output-dir tmp/runtime-test
```

Stepwise flow:

```bash
cargo run -- training migrate
cargo run -- training sync --since-days 365
cargo run -- training fill-gaps --since-days 365
cargo run -- training vwap --since-days 365
cargo run -- training build-runtime --since-days 365 --output-dir runtime/wiggler-prod-v1
```

Default behavior:

- Database: `DATABASE_URL`, defaulting to `postgres://localhost:5432/wiggler`
- Assets: `btc,eth,sol,xrp,doge`
- Sources: Coinbase spot and Binance spot
- Candle timeframe: `1m`
- Runtime interval: `300` seconds, boundary-aligned
- Runtime bundle output: `runtime/wiggler-prod-v1`
- Fee rate: `0.072`
- Minimum edge probability: `0.015`
- Minimum runtime cell sample count: `500`

Subcommands:

- `training migrate`: create/update offline training tables.
- `training reset --yes`: drop and recreate Wiggler-managed offline training tables.
- `training sync`: sync Coinbase/Binance spot candles into Postgres.
- `training fill-gaps`: fill missing Coinbase minutes from Binance as synthetic/auditable rows.
- `training vwap`: recompute cross-source VWAP rows from stored candles.
- `training build-runtime`: generate the runtime probability-table bundle.
- `training refresh-runtime`: run sync, gap-fill, VWAP, and runtime generation.

Side effects:

- `migrate`, `sync`, `vwap`, and `reset` write to local Postgres.
- `sync` makes Coinbase and Binance public REST requests.
- `build-runtime` and `refresh-runtime` write runtime JSON files under the output directory.
- No `training` command opens Polymarket websockets or places orders.

### `monitor`

Runs the live monitor and shadow evaluator.

```bash
cargo run -- monitor
cargo run -- monitor --max-runtime-seconds 15
cargo run -- monitor --runtime-bundle-dir runtime/wiggler-prod-v1
```

Default behavior:

- Assets: `btc,eth,sol,xrp,doge`
- Tradable assets: `btc,eth,sol,xrp,doge`
- Slot width: `300` seconds
- Lookahead: current slot plus one future slot
- Underlying price feed: `chainlink`
- Runtime bundle: `runtime/wiggler-prod-v1`
- Evaluation cadence: `1000` ms
- Live trading: disabled; enable with `WIGGLER_LIVE_TRADING=true` and Polymarket credentials

Use a comma-separated whitelist to monitor more than one market family:

```bash
cargo run -- monitor --assets btc,eth,sol,xrp,doge
WIGGLER_ASSETS=btc,eth,sol,xrp,doge cargo run -- monitor
```

`--asset btc` is accepted as an alias for `--assets btc`.
HYPE and BNB are intentionally outside the production tradable whitelist and
the checked-in runtime bundle.

Side effects:

- Makes public Gamma REST requests every 10 seconds.
- Opens one RTDS websocket per whitelisted asset for the configured price source.
- Opens one CLOB market websocket for the full token watchset.
- Backfills bounded in-memory 1-minute Coinbase/Binance OHLCV candle stores and keeps them fresh with Binance kline websocket updates plus REST reconciliation.
- Emits JSON logs to stdout/stderr through tracing.
- Sends Telegram notifications for shadow decisions and live order lifecycle events when configured.
- Logs full per-tick trade evaluations only when `WIGGLER_LOG_EVALUATIONS=true`.
- Places live orders only when `WIGGLER_LIVE_TRADING=true`.

## Output

Long-running output is structured JSON logs. Key events:

- `connecting RTDS websocket`
- `refreshing market websocket subscription`
- `initial book snapshot`
- `captured slot line`
- `monitor status`
- `trade evaluation` when `WIGGLER_LOG_EVALUATIONS=true`
- `watched market resolved`

Per-event book, best-bid/ask, and trade churn is logged at debug level.

When enabled, `trade evaluation` logs include the market id, token ids,
line/current prices, remaining-time bucket, distance from line, vol bin,
runtime cell sample count, `p_win`, `p_win_lower`, path-state fields,
executable ask edge, positive-EV depth, decision, skip reason, runtime hashes,
training input hash, and price source/resolution-source fields for basis
auditing.

## Destructive Commands

`training reset --yes` drops and recreates the local offline-training tables:
`candles`, `candle_sync_runs`, and `candle_vwap`. It does not affect
production server state unless you point `DATABASE_URL` at that database.
