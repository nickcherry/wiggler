# Dry Trading

Dry trading is the production trading loop run in simulation mode. It uses
real Binance-perp price updates, real Polymarket market discovery, real
Polymarket order books, and the same shared decision and maker-order
preparation path as live trading. It never signs, places, or cancels an
order.

Use it to answer the live-execution question:

> If the strategy prepared these maker BUY orders, which ones would likely
> have filled, how long did they take to fill, and how did filled trades
> compare with all prepared orders?

## Commands

Start an indefinite dry run:

```bash
bun alea trading:dry-run
```

Generate a report from the newest dry-run session:

```bash
bun alea trading:dry-run-report
```

Generate without opening the HTML:

```bash
bun alea trading:dry-run-report --no-open
```

Render a specific session:

```bash
bun alea trading:dry-run-report --session tmp/dry-trading/dry-trading_2026-05-04T23-50-46.294Z.jsonl
```

## Runtime Behavior

`trading:dry-run` runs the live decision and maker-order preparation path
against real feeds without signing, placing, or cancelling any order. It
discovers real Polymarket markets, hydrates real books, performs the same
just-in-time book refresh before entry, prepares the same GTD maker BUY shape
live would post, and then tracks whether public market trades would likely
have filled it.

The runner subscribes to:

- the injected live price source, currently Binance perps by default;
- Polymarket public market data for the active token IDs;
- Polymarket resolution data when available.

The console prints virtual-order lines as they are prepared and a multi-line
dry summary after each market finalizes. The same virtual placement and
per-window dry summary bodies are sent to Telegram using
`TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID`. Messages are explicitly labelled as
dry-run messages.

## Fill Model

Canonical dry fills are queue-aware:

- A later trade below our BUY limit fills the simulated order at our limit.
- A later trade exactly at our limit fills only after observed size clears the
  placement-time queue ahead.
- Unknown same-price queue depth is treated conservatively as unfilled.

The ledger also tracks an optimistic touch counterfactual where the first
trade at or through the limit fills immediately. That is not the canonical
fill model; it is an upper-bound comparison.

## Settlement

Dry settlement is official-first. A finalized window uses the official
Polymarket outcome when known. Binance proxy outcome and close price are
stored alongside it for mismatch analysis.

Pending orders and pending windows are intentionally excluded from the report's
analysis tables. The session context shows how many pending orders were
excluded so the sample size is explicit.

## JSONL Ledger

Each session writes:

```text
tmp/dry-trading/dry-trading_<timestamp>.jsonl
```

Records are append-only JSONL:

- `session_start`
- `virtual_order`
- `window_checkpoint`
- `window_finalized`
- `session_stop`

This means an interrupted run still leaves the completed session data usable
for reporting.

## Report

`trading:dry-run-report` writes a standalone HTML report plus a JSON sidecar
under `tmp/`.

The report is organized around the core execution comparison:

- **Filled only**: orders that became inventory under the canonical
  queue-aware fill model.
- **Filled + unfilled**: every finalized prepared order treated as if it got
  filled.
- **Unfilled only**: finalized prepared orders that did not fill under the
  canonical model.

The top comparison table shows, side by side:

- total number of trades;
- win rate;
- PnL.

The placement distribution table is also side-by-side. It compares filled
only, filled + unfilled, and unfilled only for:

- `Abs dist to line`: absolute percent distance between entry price and the
  Polymarket price line at placement time;
- `Polymarket limit`: the `$0.00` to `$1.00` prediction-market limit price
  used for the virtual BUY order.

Each placement metric shows `N`, average, median, p80, and p90.

Additional sections show filled-order details, unfilled-order details,
per-asset summaries, and per-window summaries.

## Relationship To Live Trading

Dry trading shares the production decision path where that is useful:

- probability lookup;
- line capture and freshness checks;
- market discovery and book hydration;
- just-in-time book refresh;
- maker-limit order preparation.

Dry-only behavior stays under `src/lib/trading/dryRun/` and should not add
runtime overhead or dry-run conditionals to the live order placement path.
