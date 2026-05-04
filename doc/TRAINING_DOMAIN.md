# Training Domain

## Purpose

Training is the offline-analysis side of the project: we pull historical candles
out of the local database and study them to figure out where live-trading
thresholds should sit. It is intentionally separate from the trading bot
itself — these scripts never place orders, never hit external APIs, and never
mutate the candles table. They read, compute, and write artifacts to
`alea/tmp/`.

The dashboards under this domain are temp pages, not product pages. The
visual pattern they share is documented in
[DASHBOARDS.md](./DASHBOARDS.md).

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

`bun alea training:distributions` runs three analyses in one pass and writes
a paired HTML dashboard and JSON sidecar to `alea/tmp/`:

1. **Candle size distributions** — body and wick percentiles per asset
   (described below).
2. **Point-of-no-return survival surface** — the unconditional probability
   that a snapshot's current side holds to the 5m close, bucketed by
   `(remaining-minutes, distanceBp)`. See [Survival surface](#survival-surface).
3. **Binary filter overlays** — every registered filter's per-half survival
   surface plus the calibration metrics that rank filters against each
   other. See [Filters](#filters) and [Scoring methodology](#scoring-methodology).

Heavy intermediate results are cached per asset under
`tmp/cache/training-distributions/`. Cache keys mix in data freshness
(max candle timestamp), the snapshot pipeline version, and per-filter
versions, so re-runs with no changes are near-free, and adding or
modifying a single filter only recomputes that filter.

Useful flags:

- `--assets btc,eth` — restrict to a subset.
- `--no-cache` — bypass the cache and recompute everything.
- `--no-open` — skip auto-opening the HTML on macOS.
- `--deploy` — push the rendered dashboard to the alea Cloudflare worker.

### Candle body and wick distributions

Two per-candle metrics computed for every requested asset:

- **body** — `|close − open| / open × 100`. Directional move during the bar.
- **wick** — `(high − low) / open × 100`. Full range during the bar (always ≥ body).

Open is the natural denominator because it is the price at the moment the bar
starts — the price any in-bar live-trading decision is conditioned on.

Percentiles use the standard linear-interpolation convention (numpy `linear`):

- `p0` is the minimum
- `p50` is the median — half the candles have a metric value at or below it
- `p100` is the maximum

So `p99 body = 0.18%` reads as "99% of 5-minute bars have a body smaller than
0.18% of their open price."

The HTML page only renders totals across all years; per-year breakdowns live
only in the JSON. To answer "what was BTC body p99 in 2024", read the JSON:
`assets[btc].byYear["2024"].body[99]`.

## Survival surface

Inside each five-minute window, four 1m closes give four observations of the
form `(remainingMinutes, distanceBp, currentSide, survived)`:

- `currentSide` — `up` if the snapshot's price ≥ window's open, else `down`.
- `distanceBp` — `floor(|snapshotPrice − line| / line × 10000)`, where
  `line` is the window's open price. Half-open `[N, N+1)` buckets.
- `remaining` — minutes left in the window, one of `{1, 2, 3, 4}` for
  snapshots taken at +1m, +2m, +3m, +4m respectively.
- `survived` — true iff `currentSide === finalSide`. The final side is
  determined by the window's close vs the open. **This is what we predict.**

The "point-of-no-return" question is: given a snapshot at `(remaining,
distanceBp)`, what's the probability the price doesn't cross back over the
line and settle on the other side at close?

The unconditional baseline answers that question by aggregating every
snapshot at every bucket. It's the bedrock signal — every filter is just a
conditioning variable layered on top of it.

The snapshot enumerator is
[`computeSurvivalSnapshots.ts`](../src/lib/training/computeSurvivalSnapshots.ts);
its `SNAPSHOT_PIPELINE_VERSION` constant gates the survival/filter cache
and bumps any time the snapshot stream's externally-visible behaviour
changes (different tie-break, new context field, new metric, etc.).

## Filters

A **filter** is a binary classifier over snapshots: it asks a yes/no
question of each snapshot and splits the stream into a `true` half and a
`false` half (or returns `"skip"` when required lookback isn't available).
The framework computes a separate survival surface for each half so we can
see whether the question carries information about `survived`.

### Anatomy

Each filter lives in its own directory under
`src/lib/training/survivalFilters/<name>/` and exports a single
`SurvivalFilter` object. The canonical contract is
[`SurvivalFilter` in types.ts](../src/lib/training/survivalFilters/types.ts).
Required fields: `id`, `displayName`, `description`, `trueLabel`,
`falseLabel`, `version`, `classify`.

**Skip semantics.** A filter returns `"skip"` when its required lookback
isn't present (e.g. an EMA-50 filter on the very first 50 windows of the
backfill). Skipped snapshots count toward `snapshotsSkipped` but never
toward either half — coverage stays honest.

### Registration

The active filter set is the array exported from
[`registry.ts`](../src/lib/training/survivalFilters/registry.ts). The
runner, cache layer, and renderer all consume filters generically through
this list — none of them special-cases a particular filter id.

The registry is intentionally broad: it currently includes every filter
we've ever shipped (active dashboard winners, unregistered cousins, and
filters restored from earlier prune commits). The breadth is deliberate
so we can re-evaluate older filters under updated scoring without losing
data.

### Adding a filter

1. Create `src/lib/training/survivalFilters/<name>/filter.ts` exporting a
   `SurvivalFilter` object.
2. Pick a `version` (start at 1; bump only when classify behaviour changes
   for the same input — the cache invalidates per-filter on this).
3. Co-locate a `filter.test.ts` covering the classify-true, classify-false,
   and `"skip"` branches.
4. Append the filter to the array in
   [`registry.ts`](../src/lib/training/survivalFilters/registry.ts) and
   add its id to the registry-shape test in `registry.test.ts`.
5. Run `bun alea training:distributions --assets btc` to regenerate the
   dashboard and confirm the filter renders.

## Scoring methodology

Every filter section in the dashboard is sorted and badged by a single
headline metric (`calibrationScore`), with a per-`(remaining, half)` cell
breakdown for diagnosis. Three layers of metric, each answering a
different question.

### Headline: `calibrationScore`

> "Average information gain in nats per population-snapshot, vs the
> **global** baseline (no filter at all)."

For each counted `(remaining, half, distance)` cell, compute the log-loss
the half's snapshots take under two prediction strategies:

1. Predicting the **global** rate at that bucket (`baseLogLoss`).
2. Predicting the **half's** own rate at that bucket (`halfLogLoss`).

`natsSavedAtCell = baseLogLoss − halfLogLoss`. Sum across cells, divide
by `snapshotsTotal` (which **includes** skipped snapshots — they
contribute zero to the numerator), and the result is the headline. Higher
= better predictions than no filter. The exact computation is in
[`applySurvivalFilters.ts`](../src/lib/training/survivalFilters/applySurvivalFilters.ts)
under `natsSavedVsGlobal`.

This is the production-relevant question. Skipped snapshots are
intentionally penalized: a filter that fires rarely but informatively (high
precision) and one that fires always with a smaller edge (high recall) get
graded on the same axis.

Reference scale: baseline log-loss for binary outcomes near 50/50 is
≈ 0.69 nats (ln 2). So a `calibrationScore` of 0.005 ≈ 0.7%
improvement; 0.01 ≈ 1.4%; 0.05 ≈ 7%. Most filters land in the
0.0001–0.005 range; > 0.005 is a serious live-trading candidate.

`calibrationScoreByRemaining` splits the headline into four
contributions, one per `remaining` value. The four sum to the headline.
Useful for spotting where in the window an edge concentrates.

### Per-cell scoring: `score`, `meanDeltaPp`, `sharpe`, `logLossImprovementNats`

For each `(remaining, half)` cell, the dashboard shows:

| Field | Unit | What it answers |
|---|---|---|
| `score` | pp·bp, signed | Sample-weighted signed area between the half's win-rate curve and the **filter-conditioned** baseline (kept-population's average), integrated across distance buckets. |
| `meanDeltaPp` | pp, signed | Sample-weighted mean of the per-bucket pp deltas. Edge magnitude per bucket. |
| `sharpe` | dimensionless | `meanDelta / stdev(delta)` across buckets. Edge consistency. |
| `logLossImprovementNats` | nats/snapshot | Information gain vs the **conditioned** baseline (different from `calibrationScore`, which uses the global baseline). |
| `coverageBp` | count of buckets | How many distance buckets cleared the sample-count floor for both halves. |

Sharpe values run higher in our system than financial-Sharpe convention
suggests — median is around 1.9 because the conditioned baseline tightens
per-bucket variance. Calibrated rule of thumb for these metrics:

- < 1.0 — noisy edge
- 1.0–2.5 — baseline normal
- 2.5–4.0 — strong, edge holds across distances
- > 4.0 — standout (sanity-check sample sizes before celebrating)

### Why two different baselines?

The headline (`calibrationScore`) uses the **global** baseline; per-cell
scores use a **filter-conditioned** baseline (the union of `whenTrue` +
`whenFalse` buckets). They answer different questions:

- **Global baseline:** "Is using this filter better than not filtering at
  all?" The relevant comparison for production: in live trading our
  alternative to filter X is no filter, not filter X's other half.
- **Conditioned baseline:** "Given we're using this filter, which side of
  the split is more informative?" The relevant question for filter design.

The conditioned baseline also fixes a subtle bug in the earlier scoring:
under the global baseline, high-skip filters were punished simply for
selecting hard subsets of snapshots, even when their splits were genuinely
informative within the kept population. Empirically, this showed up as
"both halves negative" in 50%+ of `(remaining)` configs for filters with
skip rate > 50% — which is mathematically impossible under unbiased
scoring (the two halves can't both lose to a baseline that's their own
count-weighted average).

The conditioned baseline makes the two halves sign-opposed at every cell
by construction, so a per-cell `score` reads cleanly as "which side of the
split wins, by how much."

The headline `calibrationScore` doesn't suffer from this problem because
log-loss against ground truth is invariant to which population you draw
the prediction from — it only cares whether the prediction is closer to
the actual outcomes than the alternative prediction is.

### What we learned by running this

A few observations from the first regen with the new methodology:

- `distance_from_line_atr` is the clear single-filter champion across all
  five assets (calibration ~0.6–0.9% vs no-filter). Universal coverage,
  decent calibration, and consistently the top by total information gain.
- `distance_atr_with_ema_aligned`, the previous "compound winner," now
  scores meaningfully **worse** than its parent under fair scoring. The
  EMA-alignment AND condition restricts the kept population to smaller
  per-bucket samples whose noisier rates predict outcomes worse than the
  parent's smoother rates. Restrictive compounds trade calibration quality
  for selectivity; the trade can go badly when sample sizes drop too far.
- `rsi_extreme_against_side` has the highest per-kept-snapshot
  information gain (~0.011 nats/snapshot) but fires on only 7% of
  snapshots, so its `calibrationScore` lands well below the champion.
  Strong candidate for a future compound layer (orthogonal to the
  champion's signal — Cohen's kappa ≈ 0.025).
- The per-rem breakdown reveals where filters earn their edge. The
  champion peaks at `remaining=2/3`; some niche filters peak at
  `remaining=4` (window-open) and decay sharply.

## Output

Two files per run, written next to each other in `alea/tmp/`:

- `training-distributions_<UTC-iso>.html` — the dashboard.
- `training-distributions_<UTC-iso>.json` — the raw payload.

The HTML page renders totals across all years. Per-year breakdowns and
the full per-asset survival/filter surfaces live in the JSON sidecar — to
answer "what was BTC body p99 in 2024", read
`assets[btc].byYear["2024"].body[99]`.

The dashboard contract (visual identity, layout, file naming) is in
[DASHBOARDS.md](./DASHBOARDS.md).

## Files

### Pipeline

- CLI entrypoint: [src/bin/training/distributions.ts](../src/bin/training/distributions.ts)
- DB loader: [src/lib/training/loadTrainingCandles.ts](../src/lib/training/loadTrainingCandles.ts)
- Series constant: [src/constants/training.ts](../src/constants/training.ts)
- Series type: [src/types/candleSeries.ts](../src/types/candleSeries.ts)
- Output writer: [src/lib/training/writeTrainingDistributionsArtifacts.ts](../src/lib/training/writeTrainingDistributionsArtifacts.ts)

### Body / wick distributions

- Pure analysis: [src/lib/training/computeCandleSizeDistribution.ts](../src/lib/training/computeCandleSizeDistribution.ts)
- Percentile helper: [src/lib/training/computePercentiles.ts](../src/lib/training/computePercentiles.ts)

### Survival surface and filters

- Snapshot enumerator: [src/lib/training/computeSurvivalSnapshots.ts](../src/lib/training/computeSurvivalSnapshots.ts)
- Filter pipeline + scoring: [src/lib/training/survivalFilters/applySurvivalFilters.ts](../src/lib/training/survivalFilters/applySurvivalFilters.ts)
- Filter contract types: [src/lib/training/survivalFilters/types.ts](../src/lib/training/survivalFilters/types.ts)
- Registry: [src/lib/training/survivalFilters/registry.ts](../src/lib/training/survivalFilters/registry.ts)
- Per-filter directories: [src/lib/training/survivalFilters/](../src/lib/training/survivalFilters/)

### Cache and rendering

- Cache layer: [src/lib/training/cache/](../src/lib/training/cache/)
- HTML renderer: [src/lib/training/renderTrainingDistributionsHtml.ts](../src/lib/training/renderTrainingDistributionsHtml.ts)
- Dashboard deploy: [src/lib/training/deployTrainingDashboard.ts](../src/lib/training/deployTrainingDashboard.ts)
