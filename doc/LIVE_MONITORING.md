# Live Monitoring

## Runtime Flow

1. Compute the current UTC slot from wall clock time.
2. Build the current and next Polymarket slugs for every whitelisted asset.
3. Fetch those events from Gamma.
4. Subscribe to every discovered `Up` and `Down` CLOB token.
5. Stream each whitelisted asset's Chainlink price from RTDS.
6. Maintain in-memory orderbooks per token.
7. Maintain bounded in-memory Coinbase/Binance OHLCV candle stores for runtime
   vol buckets and the momentum overlay.
8. Maintain a per-market in-memory price path from the same RTDS price source.
9. Load the production runtime probability-table bundle.
10. Start a background watchset refresh every 10 seconds.
11. If the token set changes, reconnect the CLOB websocket with the new set.
12. In live mode, subscribe to authenticated user trade fills for watched
    condition IDs.
13. Emit status logs every 15 seconds.
14. Evaluate every `WIGGLER_EVALUATION_INTERVAL_MS`; full per-tick evaluation logs are opt-in.

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
- current-market price path per watched slug
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
- momentum side does not conflict with the current leading side when the
  1-minute normalized momentum overlay is active
- market still active/open
- last-60-second path is not retracing against the current leading side
- current lead has not decayed enough to fail the adjusted edge gate
- current best bid has enough maker edge
- no local pending/positioned state for the market
- a fresh live exposure cache shows no remote open orders or historical trades
  for the market

Defaults:

- current price stale after 5 seconds
- orderbook stale after 5 seconds
- live exposure cache stale after 12 seconds; reconciliation runs every 5
  seconds in the background, not in the order-submit hot path
- retryable post-only no-fill/crossed-book responses cool down for 2 seconds
- no regular trading before 240 seconds or after 60 seconds remaining
- experimental 30-59 second final-window trades map to the 60-second runtime
  bucket, require at least 10 bps from the line, add 0.01 required probability
  edge, and cap order size at 10 USDC
- no trading within 0.01 bps of the line

## Logging

Info-level logging is designed to be safe for long-running operation. It logs
periodic summaries and lifecycle events, while high-volume websocket churn and
full per-tick evaluations stay off unless explicitly enabled. Production should
run with `RUST_LOG=wiggler=info,info`.

When `WIGGLER_LOG_EVALUATIONS=true`, evaluation logs include `mode`,
`decision`, and `skip_reason`. Startup backfills separate in-memory 1-minute
Coinbase and Binance OHLCV candle stores for the larger of the runtime vol
lookback and the momentum overlay lookback, then
keeps them fresh with Binance kline websocket updates plus REST reconciliation.
Vol is computed per exchange and averaged when both sources are available; if
one source is unavailable, the monitor uses the available source. The monitor
also computes a 1-minute momentum overlay from those same candles:

```text
momentum = 10_000 * ln(close_t / close_t-1) / vol_30m
```

When averaged momentum is at least `2.0`, the monitor blocks Down entries with
`skip_reason="momentum_side_conflict"`. When it is at most `-2.0`, the monitor
blocks Up entries. Missing or weaker momentum does not block anything.
Evaluation logs include `momentum_1m_vol_normalized`,
`binance_momentum_1m_vol_normalized`,
`coinbase_momentum_1m_vol_normalized`, `momentum_source_count`,
`momentum_overlay_side`, `momentum_overlay_threshold`, and
`momentum_overlay_vol_lookback_min`.

The monitor can still log `insufficient_price_history` if both exchange candle
feeds are unavailable or gapped; current-market path gaps can also produce
`insufficient_path_history`. Experimental final-window evaluations include
`final_window_experimental`, `final_window_min_abs_d_bps`,
`final_window_extra_edge_probability`, and `effective_max_order_usdc` fields.

Live trading uses the same evaluator twice: once for the logged decision and
again immediately before order submission. If the second evaluation fails, if
the side flips, or if retracing appears, no order is sent.

The main monitor loop does not await Gamma refreshes, settlement API fetches, or
Telegram sends. Gamma refreshes and settlement summary fetches run in background
tasks and return through channels; Telegram messages go through an in-process
queue. Live order submission remains awaited so local pending/positioned state
tracks the actual CLOB response.

Live entries are posted as maker-only GTD bids at the current best bid. The
order carries `postOnly=true`, so a crossed book or price move through the bid
causes a retryable rejection instead of a taker fill. Sizing is based on
Wiggler's configured min/max notional range at the selected limit price, not on
the current best-bid depth, and share size is truncated to Polymarket's
two-decimal lot precision before signing. GTD expiration is sent as slot end
plus Polymarket's one-minute threshold, making the effective resting lifetime
end at the five-minute market close.

Successful order posts are recorded as posted, not filled. A fill is recorded
only when Polymarket reports a user trade through the authenticated websocket or
the 5-second Data API fallback reconciliation. Fill records flip the local
entry into closeout tracking and trigger a fill Telegram message.

See [OPERATIONS.md](./OPERATIONS.md) for systemd and journald retention.

## Failure Behavior

- Gamma refresh failures are logged and retried on the next refresh.
- RTDS reconnects with exponential backoff up to 30 seconds.
- CLOB market websocket reconnects with exponential backoff up to 30 seconds.
- The authenticated user fill websocket uses the SDK heartbeat/reconnect loop
  and is refreshed when the watched condition-ID set changes.
- A changed token watchset restarts the market websocket and refreshes the user
  fill websocket.
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
