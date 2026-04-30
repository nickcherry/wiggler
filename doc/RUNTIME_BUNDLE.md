# Runtime Bundle

The monitor loads the production runtime bundle from
`runtime/wiggler-prod-v1` by default. Override it with:

```bash
cargo run -- monitor --runtime-bundle-dir /path/to/bundle
WIGGLER_RUNTIME_BUNDLE_DIR=/path/to/bundle cargo run -- monitor
```

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

## Shadow Evaluation

Every `WIGGLER_EVALUATION_INTERVAL_MS`, for each active 5-minute market, the monitor logs a
`trade_evaluation` event. It computes:

- line price from the captured Chainlink tick at slot start
- current Chainlink price from Polymarket RTDS
- remaining seconds and the next configured remaining-time bucket
- distance from line in bps
- 30-minute realized vol from in-memory one-minute price samples
- leading side and corresponding Up/Down token
- current 5-minute price path from the same live price source
- executable ask-level edge using `p_win_lower`

The evaluator skips when data is missing or stale, the market is outside the
60-240 second trading window, the price is too close to the line, no runtime
cell matches, the last-60-second price path is retracing against the leading
side, max path lead is unavailable, or there is no positive-EV executable ask
depth.

The base executable-edge gate is `risk_defaults.min_edge_probability`. If the
current absolute lead has decayed below 75% of the max absolute lead observed
so far in the current 5-minute market, the evaluator adds a 0.005 probability
edge penalty before walking asks.

`WIGGLER_LIVE_TRADING=false` logs `mode="shadow"` and `decision="would_trade"`
when all gates pass, but it never submits orders. `WIGGLER_LIVE_TRADING=true`
logs `mode="live"`, repeats the full evaluation immediately before submit, and
submits only when the recomputed outcome token still matches the initial
decision. Live order lifecycle logs use `decision="submitted"`,
`decision="filled"`, or `decision="rejected"`.

Live order sizing is the minimum of:

- positive-EV executable depth in USDC
- the runtime config's `max_position_usdc`
- `WIGGLER_MAX_ORDER_USDC`

The monitor skips if that amount is below `WIGGLER_MIN_ORDER_USDC`.

## Warmup

Vol uses the bundle's configured 30-minute lookback:

```text
r_i_bps = 10_000 * (price_i / price_{i-1} - 1)
vol = sqrt(mean(r_i_bps^2))
```

The monitor requires a full lookback window of minute samples, so fresh
processes will log `skip_reason="insufficient_price_history"` until warmup is
complete. Path-state also needs a recent price sample from approximately 60
seconds ago in the current market, so early or gapped path data can log
`skip_reason="insufficient_path_history"`.
