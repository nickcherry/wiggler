# Market Capture

Long-running tape recorder for the venues we trade against. Captures every Polymarket market-data WS event, every Binance USDT-M perp BBO + 5m kline event, every Coinbase Advanced Trade BBO update (spot + INTX perp), and every Polymarket-RTDS Chainlink reference-price update — lands them as JSONL on disk and bulk-loads them into the `market_event` Postgres table. The intent is to build a multi-day archive we can replay against the decision pipeline offline — so threshold tuning, regime classifiers, and dynamic-cancel experiments can be validated against weeks of recorded data instead of a single overnight session.

Capture re-uses the same per-venue stream-starters that `latency:capture` and `reliability:capture` use (`src/lib/exchangePrices/sources/`). Those starters were extended in 2026-05 to be multi-asset and to auto-reconnect; the capture pipeline subscribes one socket per venue and routes per-asset events from there.

## Quick start

First-time database setup:

```sh
bun alea db:migrate
```

Then run capture:

```sh
bun alea data:capture
```

That subscribes to the default asset set (`btc, eth, sol, xrp, doge`) on both venues, writes JSONL under `tmp/market-capture/YYYY-MM-DD/`, and bulk-loads each closed window into the `market_event` table at the 5-minute boundary. SIGINT / SIGTERM shuts it down cleanly.

## What gets recorded

**Polymarket public market-data WS** (window-scoped — re-subscribed every 5min for the up/down 5m markets in the current and next windows):

- `book` — full L2 book snapshot for an outcome token
- `trade` — every print
- `price-change` — best-price diffs
- `tick-size-change` — venue-side tick-size policy changes
- `resolved` — settlement
- `connect` / `disconnect` / `error` — stream state markers
- `resync` — emitted on every reconnect after the first; replay code MUST reset book state when it sees one of these or it'll apply diffs on top of stale state

**Binance USDT-M perpetual WS**, multi-asset, single socket:

- `bbo` — every best-bid/ask change (the bookTicker stream)
- `kline-close` — every closed 5m kline OHLCV
- `connect` / `disconnect` / `error` — stream state markers

**Coinbase Advanced Trade `level2`**, spot (`<asset>-USD`) AND perp (`<asset>-PERP-INTX`), multi-asset, one socket per product type:

- `bbo` — every best-bid/ask change derived from the L2 maintenance state
- `connect` / `disconnect` / `error`

**Polymarket RTDS Chainlink reference price**, multi-asset on a single socket. This is the actual settlement source for the up/down 5m markets, so capturing it directly closes the loop on proxy-mismatch research:

- `reference-price` — every Chainlink-derived `<asset>/usd` value update
- `connect` / `disconnect` / `error`

## Storage layout

```
tmp/market-capture/
  2026-05-05/
    2026-05-05T12-30.jsonl           ← active or rotating
    2026-05-05T12-25.jsonl           ← rotated, may or may not be ingested
    2026-05-05T12-25.jsonl.complete  ← marker: writer is done with this file
    2026-05-05T12-20.jsonl.ingested  ← already loaded into Postgres
    ...
```

One JSONL file per 5-minute window. Files within a UTC day live in that day's subdirectory. Conventions:

- A `.jsonl` with NO `.complete` sibling is either the live writer's active file or an orphan from a kill -9 mid-window.
- A `.jsonl` with a `.complete` sibling is closed cleanly and ready to ingest.
- A `.jsonl.ingested` rename means the file has been loaded into Postgres and can be archived/deleted at the operator's leisure.

JSONL files are kept on disk after ingestion as cheap insurance against schema or normalization mistakes. With ~5 venues × 5 assets at typical volumes, expect a few hundred MB per day. The Mac Mini has 3 TB.

## Postgres schema

```sql
create table market_event (
  id          bigserial primary key,
  ts_ms       bigint not null,            -- venue clock, fallback to receive time
  received_ms bigint not null,            -- our receive time (always populated)
  source      text   not null,            -- 'polymarket' | 'binance-perp' | 'coinbase-perp' | 'coinbase-spot' | 'polymarket-chainlink'
  asset       text,                       -- 'btc' | 'eth' | ... or null for venue-level events
  kind        text   not null,            -- 'book' | 'trade' | 'bbo' | 'kline-close' | 'reference-price' | 'connect' | 'disconnect' | 'resync' | 'error' | ...
  market_ref  text,                       -- Polymarket conditionId, Binance symbol, Coinbase product_id, etc.
  payload     jsonb  not null              -- full venue-side event verbatim
);

create index market_event_ts_ms_idx on market_event (ts_ms);
create index market_event_source_asset_ts_ms_idx on market_event (source, asset, ts_ms);
create index market_event_market_ref_ts_ms_idx on market_event (market_ref, ts_ms) where market_ref is not null;
```

Design choices:

- One row per **event**, never per book level. Book state is in the `payload` JSONB.
- `id` is a synthetic bigserial because the natural identity of an event is too wide. Re-ingesting the same JSONL twice would double-write — the file rename to `.ingested` is the operator-side guard against that, not a DB constraint.
- `ts_ms` and `received_ms` separate so research can spot venue-side clock skew and inter-venue latency.
- `asset` is nullable because connect/disconnect/error events apply to the whole venue connection, not one asset.

Adding more venues is a matter of (1) extending the per-venue streamer in `src/lib/exchangePrices/sources/<venue>/` to be multi-asset + reconnect (the `wsClient/createReconnectingWebSocket` helper handles the latter), (2) writing a thin capture wrapper in `src/lib/marketCapture/capture<Venue>.ts` that maps `QuoteTick` → `CaptureRecord`, and (3) registering it in `runCapture.ts`.

## CLI

### `bun alea data:capture`

Long-running daemon. Writes JSONL and (by default) loads each closed window into Postgres on rotation.

Options:

- `--assets <list>` — comma-separated asset list. Defaults to all whitelisted assets.
- `--dir <path>` — override the capture directory. Defaults to `tmp/market-capture/` under the repo root.
- `--no-ingest` — write JSONL but don't load into Postgres. Use this for the first calibration run when you want to measure event rate before committing to DB writes.

The process is designed to run for days. SIGINT / SIGTERM trigger a clean shutdown: the active JSONL is closed (no `.complete` marker, since the window isn't over yet — it'll be picked up by recovery on next start), WS subscriptions are stopped, the DB pool is drained.

### `bun alea data:ingest-pending`

One-shot ingester for orphaned JSONLs. Use after a `--no-ingest` run, after a DB outage, or any time you want to retry a load.

Options:

- `--dir <path>` — same default as capture.
- `--active <filename>` — filename (not full path) of the live capture session, if any. Excluded from the scan so the ingester doesn't race the writer.

## Reliability and recovery

- **WS reconnects** are normal in long-running operation. The Binance WS has a backoff schedule and a stale-frame watchdog; the Polymarket WS has the same backoff. Each successful reconnect emits a `connect` event in the tape; Polymarket reconnects also emit a `resync` event so replay can reset book state.
- **Crash recovery**: on startup, the runner scans the capture directory for `.jsonl` files without `.ingested` siblings (excluding the file the new writer is about to open) and loads them in order. A `kill -9` mid-window leaves at most one window's worth of events un-loaded, and the next start picks them up automatically.
- **DB outages**: if Postgres is unreachable when a window rotates, the ingest call fails and the JSONL stays on disk without the `.ingested` rename. On the next successful rotation (or via `data:ingest-pending`) it gets retried.
- **Backpressure**: the JSONL writer serialises writes through a single in-flight chain, so events can't get out of order even at high rates, but a slow disk could cause backpressure to surface as growing event-handler latency. The Bulk INSERT side processes a window in chunks of 1,000 rows; even at peak rates a 5-minute window is well within Postgres parameter limits.

## Initial calibration playbook

The first time you run capture against live venues, follow this:

1. Migrate: `bun alea db:migrate`.
2. Calibration run for 30-60 minutes with no DB writes:
   ```sh
   bun alea data:capture --no-ingest
   ```
   Watch event rate per venue. Inspect a JSONL or two with `wc -l` and `jq` to confirm the shape looks right.
3. Bulk-load what you captured:
   ```sh
   bun alea data:ingest-pending
   ```
   Confirm row counts: `psql ... -c 'select source, count(*) from market_event group by source'`.
4. Switch to live ingestion:
   ```sh
   bun alea data:capture
   ```
   Leave it running for the data retention window you want (probably a week).

## Future work

- **Replay layer**: the recorder is half of the system. The other half is a player that reads `market_event` (or JSONL) ranges and emits the same `MarketDataEvent` / `LivePriceTick` shapes the runner already consumes, driven by a virtual clock. That's a separate piece of work.
- **Aggregated feature views**: the trainer reads bars from the candles table. If we ever want pre-entry book-imbalance, queue depth, or trade-velocity as training features, those should be aggregated from `market_event` into per-window or per-snapshot feature tables, not scanned live.
- **More venues**: bybit / bitstamp / gemini / okx all have BTC-only streamers in `src/lib/exchangePrices/sources/` — extending them to multi-asset + reconnect (and registering a capture wrapper) is straightforward when wider venue coverage matters.
