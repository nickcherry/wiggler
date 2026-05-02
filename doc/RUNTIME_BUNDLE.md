# Runtime Bundle

The monitor loads the production runtime bundle from
`runtime/wiggler-prod-v1` by default. Override it with:

```bash
cargo run -- monitor --runtime-bundle-dir /path/to/bundle
WIGGLER_RUNTIME_BUNDLE_DIR=/path/to/bundle cargo run -- monitor
```

Regenerate the checked-in bundle locally with the offline training pipeline:

```bash
cargo run -- training refresh-runtime --output-dir runtime/wiggler-prod-v1
```

That command syncs Coinbase/Binance spot candles into local Postgres,
recomputes cross-source VWAP labels, and emits the runtime JSON files consumed
by `monitor`. Production still loads files only; it does not connect to the
training database.

The checked-in bundle contains:

- `wiggler-runtime-manifest.json`
- `BTC_300s_boundary.runtime.json`
- `ETH_300s_boundary.runtime.json`
- `SOL_300s_boundary.runtime.json`
- `XRP_300s_boundary.runtime.json`
- `DOGE_300s_boundary.runtime.json`

HYPE and BNB are not in this bundle and are not in the default production
whitelist. The production tradable whitelist is controlled separately with
`WIGGLER_TRADABLE_ASSETS`; an asset must be in that list and have a runtime
config to become eligible.

## Validation

Startup validates the runtime files before opening websockets:

- runtime config version is `wiggler-runtime-prob-grid-v1`
- market type is `up_down`
- interval is `300`
- anchor mode is `boundary`
- config asset matches the manifest entry
- runtime, source-config, and training-input hashes match the manifest

The generator computes:

- `training_input_hash` from the ordered `(open_time_ms, vwap_e8)` training rows.
- `source_config_hash` from the full probability-grid bucket counts.
- `runtime_config_hash` from the filtered runtime cells actually shipped to the monitor.

## Shadow Evaluation

Every `WIGGLER_EVALUATION_INTERVAL_MS`, for each active 5-minute market, the monitor computes:

- line price from the captured Chainlink tick at slot start
- current Chainlink price from Polymarket RTDS
- remaining seconds and the next configured remaining-time bucket
- distance from line in bps
- 30-minute realized vol from in-memory one-minute Coinbase/Binance OHLCV candles
- leading side and corresponding Up/Down token
- current 5-minute price path from the same live price source
- executable ask-level edge using `p_win_lower`

The evaluator skips when data is missing or stale, the market is outside the
regular 60-240 second trading window, the price is too close to the line, no
runtime cell matches, the last-60-second price path is retracing against the
leading side, max path lead is unavailable, or there is no positive-EV
executable ask depth. As an explicit live experiment, 30-59 seconds remaining
maps to the runtime's 60-second bucket only when stricter final-window gates
pass: at least 10 bps from the line, an additional 0.01 required probability
edge, and a 10 USDC effective order cap.

The base executable-edge gate is `risk_defaults.min_edge_probability`. If the
current absolute lead has decayed below 75% of the max absolute lead observed
so far in the current 5-minute market, the evaluator adds a 0.005 probability
edge penalty before walking asks.

Fees are applied at runtime, not inside the probability grid:

```text
all_in_cost = ask + fee_rate * ask * (1 - ask)
edge = p_win_lower - all_in_cost
```

The generated bundle defaults to `fee.taker_fee_rate = 0.072`. If crypto market
fees change materially, regenerate with `training build-runtime` or
`training refresh-runtime` and an explicit `--taker-fee-rate`.

`WIGGLER_LIVE_TRADING=false` sends a Telegram shadow decision when all gates
pass, but it never submits orders. `WIGGLER_LIVE_TRADING=true` sends a live
intent notification, repeats the full evaluation immediately before submit, and
submits only when the recomputed outcome token still matches the initial
decision. Live order lifecycle logs use `decision="submitted"`,
`decision="filled"`, or `decision="rejected"`. Full per-tick
`trade_evaluation` logs are off by default; enable `WIGGLER_LOG_EVALUATIONS=true`
for short debugging runs.

Live order sizing is the minimum of:

- positive-EV executable depth in USDC
- the runtime config's `max_position_usdc`
- `WIGGLER_MAX_ORDER_USDC`

For the experimental 30-59 second final window, the `WIGGLER_MAX_ORDER_USDC`
leg is capped at 10 USDC before applying the normal minimum-order check.

The monitor skips if that amount is below `WIGGLER_MIN_ORDER_USDC`.

## Warmup

Vol uses the bundle's configured 30-minute lookback:

```text
r_i_bps = 10_000 * (price_i / price_{i-1} - 1)
vol = sqrt(mean(r_i_bps^2))
```

The monitor requires a full lookback window of minute samples. It backfills
separate in-memory Coinbase and Binance 1-minute OHLCV candle stores and keeps
those candles fresh with Binance websocket updates plus REST reconciliation. Vol
is computed per exchange and averaged when both sources are available; if one
source is unavailable, the monitor uses the available source. Fresh processes can
still log `skip_reason="insufficient_price_history"` if both exchange candle
feeds are unavailable or gapped. Path-state also needs a recent price sample from
approximately 60 seconds ago in the current market, so early or gapped path data
can log `skip_reason="insufficient_path_history"`.

The offline training bundle uses the same two spot sources but fuses them into a
local VWAP label source before grid generation.
