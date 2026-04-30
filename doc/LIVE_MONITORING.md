# Live Monitoring

## Runtime Flow

1. Compute the current UTC slot from wall clock time.
2. Build the current and next Polymarket slugs for every whitelisted asset.
3. Fetch those events from Gamma.
4. Subscribe to every discovered `Up` and `Down` CLOB token.
5. Stream each whitelisted asset's Chainlink price from RTDS.
6. Maintain in-memory orderbooks per token.
7. Maintain a bounded in-memory price history for runtime vol buckets.
8. Load the production runtime probability-table bundle.
9. Refresh the watchset every 10 seconds.
10. If the token set changes, reconnect the CLOB websocket with the new set.
11. Emit status logs every 15 seconds.
12. Evaluate every `WIGGLER_EVALUATION_INTERVAL_MS` and log each evaluation.

## Rollover

The monitor watches the current slot and one future slot for every whitelisted
asset by default.

On each refresh, it recomputes the current slot from `Utc::now()`. When time
crosses a 5-minute boundary, the watchset naturally becomes:

- new current slot
- new next slot

If the token IDs changed, the old CLOB websocket task is aborted and a new one
is started. RTDS stays connected because the underlying price stream does not
change across slots.

## State

All live state is in memory:

- watched markets by slug
- token-to-market lookup
- orderbook per CLOB token asset ID
- latest underlying price tick per asset
- recent underlying price history per asset
- captured slot line per watched slug

Orderbooks for tokens that leave the active watchset are pruned on refresh.
No database is used. If future logic needs a short local cache, prefer a simple
file artifact under `tmp/` before adding a managed service.

## Data Freshness

Shadow decision code checks freshness before logging an eligible decision:

- asset is in `WIGGLER_TRADABLE_ASSETS`
- latest Chainlink tick age
- orderbook update age
- current slot line availability
- market still active/open
- enough executable ask depth at expected execution price
- no local pending/positioned state for the market
- no remote open orders or historical trades for the market before live submit

Defaults:

- current price stale after 20 seconds
- orderbook stale after 10 seconds
- no trading before 240 seconds or after 60 seconds remaining
- no trading within 0.01 bps of the line

## Logging

Info-level logging is designed to be safe for long-running operation. It logs
periodic summaries, shadow evaluations, and lifecycle events, while high-volume
websocket churn stays at debug level. Production should run with
`RUST_LOG=wiggler=info,info`.

Shadow evaluations include a `decision` and `skip_reason`. A fresh process will
usually skip with `insufficient_price_history` until the 30-minute runtime vol
lookback is warm.

Live trading uses the same evaluator twice: once for the logged decision and
again immediately before order submission. If the second evaluation fails, no
order is sent.

See [OPERATIONS.md](./OPERATIONS.md) for systemd and journald retention.

## Failure Behavior

- Gamma refresh failures are logged and retried on the next refresh.
- RTDS reconnects with exponential backoff up to 30 seconds.
- CLOB websocket reconnects with exponential backoff up to 30 seconds.
- A changed token watchset restarts only the CLOB task.
- `WIGGLER_LIVE_TRADING=true` fails closed when credentials are missing,
  authentication fails, or the account is in closed-only mode.
- `Ctrl-C` exits cleanly.

## Hosting

London hosting may reduce latency to Polymarket/market participants, but this
is not yet benchmarked in this repo. Before production trading, measure:

- RTDS tick receive latency
- CLOB best bid/ask receive latency
- Gamma discovery latency near rollover
- future order placement and fill latency
