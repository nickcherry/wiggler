# Training Domain

## Purpose

Training is the offline-analysis side of the project: we pull historical candles
out of the local database and study them to figure out where live-trading
thresholds should sit. It is intentionally separate from the trading bot
itself — these scripts never place orders, never hit external APIs, and never
mutate the candles table. They read, compute, and write artifacts to
`wiggler/tmp/`.

The dashboards under this domain are temp pages, not product pages. The
visual pattern they share is documented in
[TEMP_DASHBOARDS.md](./TEMP_DASHBOARDS.md).

## Candle series under study

Today the training domain studies a single candle series:
**binance-perp 5m**. That choice is centralized in
[`src/constants/training.ts`](../src/constants/training.ts) as
`trainingCandleSeries`. Every analysis pulls from this constant rather than
hardcoding source/product/timeframe separately, so widening or swapping the
series later is a one-line edit.

The `(source, product, timeframe)` tuple itself is typed as
[`CandleSeries`](../src/types/candleSeries.ts), with a Zod schema sourced
from the existing `candleSourceSchema`, `productSchema`, and
`candleTimeframeSchema`.

## Commands

### `training:distributions`

`bun wiggler training:distributions` computes percentile distributions of two
per-candle metrics for every requested asset, then writes a paired HTML
dashboard and JSON sidecar to `wiggler/tmp/`.

Metrics:

- **body** — `|close − open| / open × 100`. The directional move during the
  bar, expressed as a percentage of the bar's open price.
- **wick** — `(high − low) / open × 100`. The full range during the bar
  (always ≥ body), again expressed as a percentage of open.

Open is the natural denominator because it is the price at the moment the bar
starts — the price any in-bar live-trading decision is conditioned on.

Percentile convention is the standard linear-interpolation one (numpy
`linear`):

- `p0` is the minimum
- `p50` is the median — half the candles have a metric value at or below it
- `p100` is the maximum

So `p99 body = 0.18%` reads as "99% of 5-minute bars have a body smaller than
0.18% of their open price."

### Output

Two files per run, written next to each other in `wiggler/tmp/`:

- `training-distributions_<UTC-iso>.html` — the dashboard.
- `training-distributions_<UTC-iso>.json` — the raw payload.

The HTML page only renders the totals across all years. The per-year
breakdown lives only in the JSON. To answer "what was BTC body p99 in 2024",
read the JSON: `assets[btc].byYear["2024"].body[99]`.

## Files

- CLI: [src/bin/training/distributions.ts](../src/bin/training/distributions.ts)
- Pure analysis: [src/lib/training/computeCandleSizeDistribution.ts](../src/lib/training/computeCandleSizeDistribution.ts)
- Percentile helper: [src/lib/training/computePercentiles.ts](../src/lib/training/computePercentiles.ts)
- DB loader: [src/lib/training/loadTrainingCandles.ts](../src/lib/training/loadTrainingCandles.ts)
- HTML renderer: [src/lib/training/renderTrainingDistributionsHtml.ts](../src/lib/training/renderTrainingDistributionsHtml.ts)
- Output writer: [src/lib/training/writeTrainingDistributionsArtifacts.ts](../src/lib/training/writeTrainingDistributionsArtifacts.ts)
- Series constant: [src/constants/training.ts](../src/constants/training.ts)
- Series type: [src/types/candleSeries.ts](../src/types/candleSeries.ts)
