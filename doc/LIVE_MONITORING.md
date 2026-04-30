# Live Monitoring

## Runtime Flow

1. Compute the current UTC slot from wall clock time.
2. Build the current and next Polymarket slugs for every whitelisted asset.
3. Fetch those events from Gamma.
4. Subscribe to every discovered `Up` and `Down` CLOB token.
5. Stream each whitelisted asset's Chainlink price from RTDS.
6. Maintain in-memory orderbooks per token.
7. Refresh the watchset every 10 seconds.
8. If the token set changes, reconnect the CLOB websocket with the new set.
9. Emit status logs every 15 seconds.

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
- captured slot line per watched slug

No database is used. If future logic needs a short local cache, prefer a simple
file artifact under `tmp/` before adding a managed service.

## Data Freshness

Future decision code must check freshness before acting:

- latest Chainlink tick age
- orderbook websocket health
- current slot line availability
- market still active/open
- enough book depth at expected execution price

The scaffold does not make decisions, so it only logs the available state.

## Logging

Info-level logging is designed to be safe for long-running operation. It logs
periodic summaries and lifecycle events, while high-volume websocket churn stays
at debug level. Production should run with `RUST_LOG=wiggler=info,info`.

See [OPERATIONS.md](./OPERATIONS.md) for systemd and journald retention.

## Failure Behavior

- Gamma refresh failures are logged and retried on the next refresh.
- RTDS reconnects with exponential backoff up to 30 seconds.
- CLOB websocket reconnects with exponential backoff up to 30 seconds.
- A changed token watchset restarts only the CLOB task.
- `Ctrl-C` exits cleanly.

## Hosting

London hosting may reduce latency to Polymarket/market participants, but this
is not yet benchmarked in this repo. Before production trading, measure:

- RTDS tick receive latency
- CLOB best bid/ask receive latency
- Gamma discovery latency near rollover
- future order placement and fill latency
