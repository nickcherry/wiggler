# Wiggler v1 Runtime Implementation Instructions

## Scope

Use this bundle as the probability-grid input for Wiggler v1.

Do not implement asset-level quarantine/eligibility logic from the old research files. This runtime bundle includes only the assets we intend to consider:

```text
BTC
ETH
SOL
XRP
DOGE
```

The production app should maintain its own tradable-asset whitelist. Live-vs-paper execution should be controlled by a single operator flag in the production app, not by the bundle.

## Files to load

Load:

```text
wiggler-runtime-manifest.json
<ASSET>_300s_boundary.runtime.json
```

The manifest lists the configured assets and runtime config file paths.

Validate each config has:

```text
version == "wiggler-runtime-prob-grid-v1"
market_type == "up_down"
interval_sec == 300
anchor_mode == "boundary"
```

The config contains only runtime-usable cells. There is no asset-level enabled/quarantine/live flag.

## Data model

Each config cell is keyed by:

```text
remaining_sec
vol_bin
side_leading
abs_d_bps_min
abs_d_bps_max
```

Use:

```text
p = cell.p_win_lower
```

Do not trade from `p_win`. `p_win` is the raw empirical win rate; `p_win_lower` is the conservative estimate.

## Live state calculation

For each active Polymarket 5-minute Up/Down market:

```text
line_price = interval start price
current_price = live Chainlink-like/proxy price
remaining_sec = floor((interval_end_ts - now_ts) / 1000)
d_bps = 10_000 * (current_price / line_price - 1)
abs_d_bps = abs(d_bps)
```

No trade if:

```text
line_price missing
current_price missing
price stale
order book stale
remaining_sec < 60
remaining_sec > 240
market not active
market already has position
```

The training labels used VWAP as a Chainlink proxy. Until production has measured Chainlink/proxy basis, treat this as paper/shadow or very explicitly operator-approved live risk.

## Remaining-time bucket

Configured buckets are:

```text
60, 120, 180, 240
```

Use the smallest configured bucket that is >= actual remaining seconds.

Examples:

```text
remaining=240 -> bucket 240
remaining=211 -> bucket 240
remaining=180 -> bucket 180
remaining=121 -> bucket 180
remaining=120 -> bucket 120
remaining=61  -> bucket 120
remaining=60  -> bucket 60
remaining=59  -> no trade
```

Do not map 90 seconds remaining to the 60-second bucket. That would overstate confidence.

## Side selection

```text
if d_bps > 0:
    side_leading = "up_leading"
    buy_outcome = "up"
elif d_bps < 0:
    side_leading = "down_leading"
    buy_outcome = "down"
else:
    no trade
```

The runtime bundle excludes `at_line` cells. Do not trade exactly at the line in v1.

Optional production guard:

```text
if abs_d_bps < 0.5:
    no trade
```

This avoids micro-noise around the line.

## Volatility bucket

Use the config's `vol_bins.vol_lookback_min`, currently 30 minutes.

Mirror the research calculation as closely as possible. If not already implemented, use:

```text
r_i_bps = 10_000 * (price_i / price_{i-1} - 1)
vol_bps_per_sqrt_min = sqrt(mean(r_i_bps^2))
```

Bucket:

```text
vol <= lowMaxBpsPerSqrtMin     -> low
vol <= normalMaxBpsPerSqrtMin  -> normal
vol <= highMaxBpsPerSqrtMin    -> high
else                           -> extreme
```

No trade if there is insufficient recent price history.

## Cell lookup

Find the cell where:

```text
cell.remaining_sec == remaining_bucket
cell.vol_bin == vol_bin
cell.side_leading == side_leading
cell.abs_d_bps_min <= abs_d_bps
and (cell.abs_d_bps_max == null or abs_d_bps < cell.abs_d_bps_max)
```

If no cell exists, no trade.

Use `p_win_lower`.

## Polymarket order book comparison

Compare model probability to the live maker bid, not midpoint.

If `buy_outcome == "up"`, inspect the best bid for the Up token.
If `buy_outcome == "down"`, inspect the best bid for the Down token.

For the selected token:

```text
bid = best_bid.price
fee = 0
all_in_cost = bid
edge = p_win_lower - all_in_cost
```

The runtime bundle's taker fee rate is retained for provenance and historical
taker analysis; live entries are maker bids.

A level is eligible if:

```text
edge >= min_edge_probability
```

The default is:

```text
min_edge_probability = 0.015
```

Evaluate the current best bid as a maker entry. The entry cost is the bid price
with zero maker fee.

Use the best bid as the maker limit price only. Do not size from best-bid
depth; size from the configured notional caps divided by the selected limit
price. Truncate share size to Polymarket's two-decimal lot precision before
signing.

## Order behavior

For v1:

```text
maker only
post-only GTD limit order at the current best bid
no taker mode
no blind market orders
no crossing the spread
no averaging down
no flipping sides inside a market
one position per market unless explicitly changed
```

Immediately before sending an order, recompute:

```text
current_price
remaining_sec
d_bps
side_leading
vol_bin
cell
best ask / book levels
edge
```

Skip if anything changed enough to invalidate the decision.

## Suggested sizing

Config contains:

```text
max_position_usdc
kelly_fraction
```

For the first implementation, simple capped sizing is fine:

```text
notional <= max_position_usdc
notional <= operator global risk cap
```

If using Kelly, keep it heavily fractional. Do not exceed the configured cap without explicit operator override.

## Required logging

Log every evaluation and every skip, not just trades.

Minimum fields:

```text
timestamp
mode
asset
market id / slug
up token id
down token id
line_price
current_price
price_source
price_age_ms
orderbook_age_ms
remaining_sec
remaining_bucket
d_bps
abs_d_bps
side_leading
buy_outcome
vol_bps_per_sqrt_min
vol_bin
runtime_config_hash
training_input_hash
sample_count
p_win
p_win_lower
best_bid
best_ask
maker_fee_rate
taker_fee_rate
all_in_cost
edge
maker_order_notional_usdc
decision
skip_reason
```

When the market resolves, join outcome and realized PnL back to the decision log.

## Tests to add

Add tests for:

```text
loads all five runtime configs from manifest
rejects unknown assets not in production whitelist
remaining_sec=59 no-trades
remaining_sec=61 maps to bucket 120
remaining_sec=60 maps to bucket 60
d_bps > 0 maps to up_leading
d_bps < 0 maps to down_leading
d_bps == 0 no-trades
missing vol history no-trades
missing cell no-trades
EV math includes fee
book walker stops at first non-positive-EV level
pre-submit recomputation cancels if side flips
pre-submit recomputation cancels if remaining_sec < 60
```
