# Market Capture

Long-running tape recorder for the venues we trade against. Captures every Polymarket market-data WS event, every Binance USDT-M perp BBO + 5m kline event, every Coinbase Advanced Trade BBO update (spot + INTX perp), and every Polymarket-RTDS Chainlink reference-price update — across **all five assets** (`btc`, `eth`, `sol`, `xrp`, `doge`) — lands them as JSONL on disk, and bulk-loads them into the `market_event` Postgres table. The intent is to build a multi-day archive we can replay against the decision pipeline offline — so threshold tuning, regime classifiers, and dynamic-cancel experiments can be validated against weeks of recorded data instead of a single overnight session.

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

That subscribes to the default asset set (`btc, eth, sol, xrp, doge`) across all five sources (`polymarket`, `binance-perp`, `coinbase-perp`, `coinbase-spot`, `polymarket-chainlink`), writes JSONL under `tmp/market-capture/YYYY-MM-DD/`, and bulk-loads each closed window into the `market_event` table at the 5-minute boundary. SIGINT / SIGTERM shuts it down cleanly.

## What gets recorded

**Polymarket public market-data WS** (window-scoped — re-subscribed every 5min for the up/down 5m markets in the current and next windows; **all five assets** subscribed concurrently):

- `book` — full L2 book snapshot for an outcome token
- `trade` — every print
- `best-bid-ask` — top-of-book diffs
- `price-change` — best-price diffs
- `tick-size-change` — venue-side tick-size policy changes
- `resolved` — settlement
- `connect` / `disconnect` / `error` — stream state markers
- `resync` — emitted on every reconnect after the first; replay code MUST reset book state when it sees one of these or it'll apply diffs on top of stale state

**Binance USDT-M perpetual WS**, multi-asset, single combined-stream socket:

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

JSONL files are kept on disk after ingestion as cheap insurance against schema or normalization mistakes. See **Observed behavior** below for measured rates; rough budget is ~1.3 GB/hr ≈ 220 GB/week, comfortably within the 3 TB Mac Mini.

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
- `id` is a synthetic bigserial because the natural identity of an event is too wide. The auto-incrementing `id` also doubles as the canonical RECEIPT order — useful when `ts_ms` is non-monotonic (see Polymarket caveat below).
- Re-ingesting the same JSONL twice would double-write — the file rename to `.ingested` is the operator-side guard against that, not a DB constraint.
- `ts_ms` and `received_ms` separate so research can spot venue-side clock skew and inter-venue latency. Both are bigint epoch-ms.
- `asset` is nullable because connect/disconnect/error events apply to the whole venue connection, not one asset.

Adding more venues is a matter of (1) extending the per-venue streamer in `src/lib/exchangePrices/sources/<venue>/` to be multi-asset + reconnect (the `wsClient/createReconnectingWebSocket` helper handles the latter), (2) writing a thin capture wrapper in `src/lib/marketCapture/capture<Venue>.ts` that maps `QuoteTick` → `CaptureRecord`, and (3) registering it in `runCapture.ts`.

## CLI

### `bun alea data:capture`

Long-running daemon. Writes JSONL and (by default) loads each closed window into Postgres on rotation.

Options:

- `--assets <list>` — comma-separated asset list. Defaults to all five whitelisted assets (`btc,eth,sol,xrp,doge`).
- `--dir <path>` — override the capture directory. Defaults to `tmp/market-capture/` under the repo root.
- `--no-ingest` — write JSONL but don't load into Postgres. Use this for the first calibration run when you want to measure event rate before committing to DB writes.

The process is designed to run for days. SIGINT / SIGTERM trigger a clean shutdown: the active JSONL is closed (no `.complete` marker, since the window isn't over yet — it'll be picked up by recovery on next start), WS subscriptions are stopped, the DB pool is drained.

### `bun alea data:ingest-pending`

One-shot ingester for orphaned JSONLs. Use after a `--no-ingest` run, after a DB outage, or any time you want to retry a load.

Options:

- `--dir <path>` — same default as capture.
- `--active <filename>` — filename (not full path) of the live capture session, if any. Excluded from the scan so the ingester doesn't race the writer.

## Observed behavior

Numbers below are from a clean calibration run on 2026-05-05 (~10 minutes, two complete window rotations, all five assets, all five sources). They're a useful baseline for capacity planning and for spotting drift in future operational checks.

### Event rates per (source, asset)

Steady-state event rate over a 5-minute window:

| Source | BTC | ETH | SOL | XRP | DOGE | Total/sec |
|---|---:|---:|---:|---:|---:|---:|
| binance-perp (bbo) | 372/s | 382/s | 134/s | 50/s | 81/s | 1018/s |
| coinbase-perp (bbo) | 6/s | 6/s | 6/s | 4/s | 3/s | 25/s |
| coinbase-spot (bbo) | 8/s | 6/s | 6/s | 4/s | 2/s | 26/s |
| polymarket (book+bba+trade) | 88/s | 16/s | 8/s | 6/s | 6/s | 124/s |
| polymarket-chainlink (ref-price) | 1/s | 1/s | 1/s | 1/s | 1/s | 5/s |

Binance dominates by 8–10× because its `bookTicker` stream fires on every BBO change (high-frequency); Coinbase's `level2` channel only fires when the top of book actually moves. **Total: ~1,200 events/sec sustained.**

### Payload size per `(source, kind)`

| Source | Kind | Avg bytes | Notes |
|---|---|---:|---|
| binance-perp | bbo | 81 | bid/ask/mid + venue ts |
| coinbase-{spot,perp} | bbo | 81 | same shape as binance |
| polymarket | best-bid-ask | 259 | bestBid/bestAsk + token id |
| polymarket | trade | 263 | price + size + side + token id |
| polymarket | book | **3,099** | 30–40 levels of L2 depth |
| polymarket-chainlink | reference-price | 58 | single value + ts |

Polymarket book events dominate storage despite being only ~3% of row count: ~3 KB each at ~38/sec across all assets ≈ 110 KB/sec just for books, ~28% of total bytes.

### Storage projection

Measured at 9 minutes of capture:

| | Size |
|---|---:|
| `market_event` table | 130 MB |
| `market_event_source_asset_ts_ms_idx` | 23 MB |
| `market_event_market_ref_ts_ms_idx` | 21 MB |
| `market_event_ts_ms_idx` | 6.7 MB |
| **DB total** (table + indexes + toast) | **192 MB** |
| JSONL on disk (audit copy) | 165 MB |

That's ~1.3 GB/hr in the DB and ~1.1 GB/hr in JSONL files. Index overhead is ~39%. Linear projections:

- 1 day: ~30 GB DB + ~26 GB JSONL
- 1 week: ~220 GB DB + ~190 GB JSONL ≈ 410 GB combined
- 1 month: ~1.0 TB combined

3 TB available — comfortable for a month, with room for a backfill or a second concurrent run.

### Ingest timing

The bulk-INSERT path runs synchronously inside the rollover hook every 5 minutes. Real numbers:

| Window | Rows | Ingest time | Throughput |
|---|---:|---:|---:|
| First (partial, 2.5min after start) | 179,791 | 2 s | ~90k rows/s |
| Second (full 5min) | 356,601 | 5 s | ~71k rows/s |

Linear scaling at ~14 µs/row inserted. **60× headroom** under the 5-minute window budget. Even a 5× volatility spike (~1.8M rows/window) would still ingest in ~25 s.

While the ingest is running, the JSONL writer's serialisation chain blocks new writes — events arriving from the WS streams accumulate as JS-heap closures behind the await chain. At sustained 1,200 events/sec × 5 s ingest = ~6,000 events ≈ ~5 MB held briefly. Trivially small.

### Process resource steady-state

After ~5 minutes of warm-up the bun process plateaus and stays flat:

| Metric | Value |
|---|---|
| RSS | ~720 MB (flat after warm-up; **no growth observed over 60s**) |
| Open FDs | 27 (stable) |
| TCP sockets | 7 (stable: 5 WS + 2 HTTP keep-alives for Polymarket gamma-api / CLOB market discovery) |

The earlier RSS growth from ~480 MB → ~720 MB during the first ~5 minutes is bun heap warm-up, not a leak. If you see RSS continuing to grow past the 1 GB plateau, that's a regression worth investigating.

### Cross-venue price agreement (sanity check)

At one calibration timestamp, all five sources for BTC/USD agreed within ~$70 (8 bps), which is the expected venue-spread baseline:

| Source | BTC mid |
|---|---:|
| binance-perp | $81,557.75 |
| polymarket-chainlink | $81,597.31 |
| coinbase-perp | $81,601.15 |
| coinbase-spot | $81,624.51 |

If you see venues diverging by hundreds of bps, something is wrong (stale book, stuck WS, asset/symbol mismatch).

## Data quality gotchas

These are real, present in the captured data, and mostly affect downstream replay/research code rather than the capture itself.

### Polymarket-chainlink has ~1.3 s lag

| Source | avg `received_ms − ts_ms` | p99 | max |
|---|---:|---:|---:|
| polymarket-chainlink | **1,338 ms** | 2,063 ms | 2,822 ms |
| binance-perp | 113 ms | 252 ms | 438 ms |
| coinbase-perp | 37 ms | 53 ms | 153 ms |
| coinbase-spot | 41 ms | 60 ms | 1,964 ms (single outlier) |

Polymarket's RTDS layer batches Chainlink updates server-side rather than pushing in real time. This is **the most important caveat for proxy-mismatch research**: when comparing Binance live vs Chainlink reference, Binance is ~1.3 seconds ahead of our Chainlink capture *by definition*. Replay code that does cross-feed analysis must correct for this — either by using Chainlink's `tsMs` (Chainlink's own clock, set by the venue) or by lagging Binance accordingly.

### Polymarket events arrive ~2% out of order

Within a single `(source, asset)`, ~2% of Polymarket events have a venue `ts_ms` that's earlier than the immediately preceding event's `ts_ms` (by insertion order). This is normal — Polymarket batches events whose internal `atMs` aren't strictly monotonic relative to receipt order.

| Source | Asset | Out-of-order |
|---|---|---:|
| polymarket | btc | 698 / 23,282 (3.0%) |
| polymarket | eth | 29 / 4,211 (0.7%) |
| polymarket | sol | 5 / 2,467 (0.2%) |
| polymarket | doge | 4 / 3,180 (0.1%) |
| polymarket | xrp | 2 / 3,071 (0.1%) |
| (all other sources) | (any) | 0 |

Replay code should sort by `ts_ms` if strict event-time ordering matters; the auto-incrementing `id` column gives you exact receipt order if that's what you want instead.

### Polymarket book payload sort order

Polymarket's `book` events emit raw venue order, which is **not** monotonic by best-of-book convention:

- `bids` array is sorted **ascending by price** → top of book is the LAST element (`max(bids[*].price)`)
- `asks` array is sorted **descending by price** → top of book is the LAST element (`min(asks[*].price)`)

Cross-checked: pulling the latest `book` event for a market and computing `max(bids)` / `min(asks)` matches the latest `best-bid-ask` event's `bestBid` / `bestAsk` exactly. Up + Down outcomes of the same market also inverse-price correctly (e.g. up `0.67/0.77`, down `0.33/0.23`).

### The window-rotation flip-flop bug (fixed)

**Past bug, fixed in commit `02a3211`** — kept here so the rationale survives.

The first version of the JSONL writer routed each event into a 5-min window using the event's own `ts_ms`. At every wall-clock 5-min boundary, cross-venue clock skew put simultaneous events on opposite sides of the boundary (Binance saying 14:59:59.97, Coinbase saying 15:00:00.05), causing the writer to alternate between two open files for several seconds — triggering O(n) redundant rotations and re-ingestions per boundary, and overwriting prior `.ingested` files via POSIX atomic-rename.

The fix routes by **wall-clock at write time**, not by event time. `record.tsMs` is still preserved verbatim in the JSONL line for any analysis that wants venue-time re-bucketing. The window key is operational, not analytical: it just answers "during which wall-clock 5-min interval was this event observed".

A regression test in `jsonlWriter.test.ts` drives a stream of out-of-order `tsMs` inside one wall-clock window and asserts no rotation occurs.

## Reliability and recovery

- **WS reconnects** are normal in long-running operation. Every WS goes through `wsClient/createReconnectingWebSocket` — backoff schedule `[1s, 2s, 5s, 10s, 30s]`, stale-frame watchdog at 30s, attempt counter resets after the first frame of each successful connection. Each successful (re)connect emits a `connect` event in the tape; Polymarket reconnects also emit a `resync` event so replay can reset book state.
- **Crash recovery**: on startup, the runner scans the capture directory for `.jsonl` files without `.ingested` siblings (excluding the file the new writer is about to open) and loads them in order. A `kill -9` mid-window leaves at most one window's worth of events un-loaded, and the next start picks them up automatically.
- **DB outages**: if Postgres is unreachable when a window rotates, the ingest call fails and the JSONL stays on disk without the `.ingested` rename. On the next successful rotation (or via `data:ingest-pending`) it gets retried.
- **Backpressure**: the JSONL writer serialises writes through a single in-flight chain, so events can't get out of order even at high rates. A slow disk or a long ingest blocks new writes briefly — events queue as JS-heap closures (~1KB each) until the chain drains.

## Initial calibration playbook

The first time you run capture against live venues — and any time after a meaningful refactor of the capture pipeline — do this:

1. **Migrate**: `bun alea db:migrate`.
2. **Calibration run, no DB writes (5–10 min)** — confirm all sources connect and shape looks right:
   ```sh
   bun alea data:capture --no-ingest
   # ctrl-c after a few minutes
   find tmp/market-capture -name "*.jsonl" -exec cat {} + | jq -r '.source + " " + (.asset // "_")' | sort | uniq -c
   ```
   Expect every (source, asset) combination present, with rates roughly matching the **Event rates** table above.
3. **Bulk-load it**: `bun alea data:ingest-pending`.
4. **Sanity-check the DB**:
   ```sh
   psql ... -c "select source, asset, count(*) from market_event group by source, asset order by 1, 2"
   ```
5. **Wait for one full window with auto-ingest**:
   ```sh
   bun alea data:capture
   # wait through one 5-min boundary; check the rotated+ingested log lines fire exactly once each
   ```
6. **Process resource check**: with capture running, take an RSS / FD / TCP-socket snapshot, wait 60s, take another. RSS should be flat (within ~1 MB), FDs and TCP sockets should be unchanged.
7. **Commit to the long-running session**: launch under tmux/launchd, walk away.

## Future work

- **Replay layer**: the recorder is half of the system. The other half is a player that reads `market_event` (or JSONL) ranges and emits the same `MarketDataEvent` / `LivePriceTick` shapes the runner already consumes, driven by a virtual clock. That's a separate piece of work.
- **Aggregated feature views**: the trainer reads bars from the candles table. If we ever want pre-entry book-imbalance, queue depth, or trade-velocity as training features, those should be aggregated from `market_event` into per-window or per-snapshot feature tables, not scanned live.
- **More venues**: bybit / bitstamp / gemini / okx all have BTC-only streamers in `src/lib/exchangePrices/sources/` — extending them to multi-asset + reconnect (and registering a capture wrapper) is straightforward when wider venue coverage matters.
- **Storage tier-down**: once we're a month in, consider archiving `.ingested` JSONLs to a cold tier and dropping the older bytes from the live Postgres if disk pressure mounts. The DB rows are the canonical store; JSONL is just a paranoid audit copy.
