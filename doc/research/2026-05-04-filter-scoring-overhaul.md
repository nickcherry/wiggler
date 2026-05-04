# 2026-05-04 — Filter scoring overhaul

> **Note on numbers in this doc:** the calibration figures below were
> computed with `SUMMARY_MIN_SAMPLES = 300`. We later bumped that floor
> to 2000 (see
> [doc/research/2026-05-04-sample-floor.md](./2026-05-04-sample-floor.md))
> after finding a low-bp sample-composition artifact. Absolute
> percentages here are slightly inflated relative to current dashboard
> values; the **conclusions and methodology stand**. Skip-selection
> bias as documented here is a real, unresolved-by-the-floor-bump
> phenomenon — the bump is orthogonal to it.

## Takeaway

The original filter scoring (signed-area pp·bp delta vs the global
unconditional baseline) was systematically biased *against high-skip
filters* — and therefore *against the very kind of filter we'd most
want to use in a compound layer*: rare-but-informative classifiers
that say "skip" most of the time. We replaced it with a two-layer
scheme:

- **Per-cell scores** (the `(remaining, half)` cells under each filter)
  now compare each half against a **filter-conditioned baseline** (the
  union of `whenTrue` + `whenFalse` at each bucket). The two halves
  become sign-opposed by construction; the score reads cleanly as
  "which side of the split is better, and by how much."
- **Headline `calibrationScore`** is a single sortable number per
  filter: average information gain in nats per population-snapshot vs
  the global no-filter baseline. Skipped snapshots contribute zero.
  This is the production-relevant question — "is using this filter
  better than not filtering?" — and it auto-trades-off coverage vs.
  precision.

We also added `sharpe` (consistency of edge across distance buckets)
and `logLossImprovementNats` (per-cell information gain vs the
conditioned baseline) on each cell for diagnosis when a filter scores
surprisingly.

The change rendered our previous "compound winner"
`distance_atr_with_ema_aligned` ~3× worse than its parent
`distance_from_line_atr` per snapshot, and surfaced
`distance_from_line_atr` as the clear single-filter champion across
all five assets. Most other filters (~25 of them) provide near-zero
calibration improvement once you account for skip rate honestly.

## Skip-selection bias: the smoking gun

Before the change, the score for a half was the sample-weighted
signed area of `(halfWinRate − globalRate)` across distance buckets.
The trouble is that the **global rate** at a bucket includes every
snapshot — including the ones the filter `skip`ped. If the skipped
snapshots have systematically different (typically *higher*) win
rates than the kept ones, the global rate at the bucket overestimates
what the kept population actually does, so both halves of the kept
population score below the global reference even when the filter's
split is genuinely informative.

Empirically, this showed up cleanly. We bucketed all 350 cached
filter-asset cells by skip rate and counted what fraction of
`(remaining)` configs had **both halves negative**:

```
skip rate    n_filters   % configs where both halves are negative
< 10%           260         0.1%
10-30%           14        16.1%
30-50%           17        39.7%
50-75%           34        49.3%
75-90%            5        45.0%
> 90%            20        68.8%
```

Monotonic with skip rate. Under unbiased scoring this is impossible —
the conditioned baseline is the count-weighted average of the two
halves, so by construction one is above and one is below. The only
way "both halves negative" at all, much less > 50% of the time, was
the global-baseline reference point being miscalibrated for the
filter's kept population.

After switching to the conditioned baseline, the same query returns
zero "both halves negative" cells. By construction.

## Why two baselines?

The headline (`calibrationScore`) **must** use the global baseline,
because it's answering the production question: "in live trading, my
alternative to using filter X is using *no filter*. Is X better?" The
log-loss comparison stays valid against the global baseline because
log-loss measures prediction quality on the same set of snapshots —
it doesn't care that the prediction is trained on a different
population, only whether it's closer to the actual outcomes than the
alternative prediction.

Per-cell scoring (`score`, `meanDeltaPp`, `sharpe`) **must** use the
conditioned baseline, because the question there is "given we're
using this filter, which side of the split is better?" That's a
filter-design question, and the conditioned reference is what
produces the clean sign-opposed reading.

Both questions matter; both metrics live on the dashboard.

## Calibration ranges in our data

Baseline log-loss for a binary outcome near 50/50 is `ln(2) ≈ 0.69`
nats per snapshot. We render `calibrationScore` as a percentage of
that. So:

- `0.005` raw ≈ `0.7%` improvement
- `0.01` raw ≈ `1.4%`
- `0.05` raw ≈ `7%`

In our data, our champion `distance_from_line_atr` lands at
**0.61–0.90%** depending on asset. Most filters land below `0.10%`,
which is essentially noise — they aren't meaningfully helping
predictions vs no filter at all.

## Sharpe-of-edge: recalibrated expectations

We compute `meanDelta / stdev(delta)` across distance buckets
(sample-weighted). The conditioned baseline structurally tightens the
per-bucket variance, so our Sharpe values run high relative to
financial-Sharpe convention. Median Sharpe across all cells is
**~1.9**. Calibrated rule of thumb in our system:

- `< 1.0` — noisy edge
- `1.0–2.5` — baseline normal
- `2.5–4.0` — strong, edge holds across distances
- `> 4.0` — standout (sanity-check sample sizes)

## Cohen's kappa vs the champion

To find good compound candidates (filters that carry information
*orthogonal* to the champion), we ran a snapshot-level co-classification
pass on BTC for all 28 filters. Cohen's kappa adjusts agreement for
chance:

| Cohen's kappa | Reading |
|---|---|
| ≥ 0.8 | Essentially the same filter |
| 0.4 – 0.8 | Heavily correlated — limited compound value |
| 0.0 – 0.4 | Mostly independent — possible compound candidate |
| < 0 | Systematically opposed — also a candidate (fade) |

Notable result: `distance_atr_with_ema_aligned` had **kappa = 0.58**
with `distance_from_line_atr` AND a co-classification matrix where
`ft = 0` (compound never said true when parent said false). That's
the structural signature of a strict subset — the compound is
literally `(distance is true) AND (EMA alignment)`. Smaller per-bucket
samples in the strict subset → noisier rates → worse calibration
than the parent. The compound was actively degrading our predictions.

The most promising compound candidates (high info-gain-when-fired,
near-zero kappa with the champion, applied to BTC):

- `rsi_extreme_against_side` — kappa **0.025**. ~0.011 nats/snap when
  it fires (top of the per-kept leaderboard) but only fires on ~7% of
  snapshots, so calibration vs no-filter ends up modest. Worth
  exploring as a "switch override" layer.
- `roc_5_strong_aligned` / `roc_20_strong_alignment` — kappa near 0.
  Fire on ~40–60% of snapshots. Decent-sized info gain when they fire.
- `stochastic_extreme_against` — kappa **0.004**. Smaller info gain
  but cheap orthogonal signal.

## Files at the time of writing

- Compute: [src/lib/training/survivalFilters/applySurvivalFilters.ts](../../src/lib/training/survivalFilters/applySurvivalFilters.ts)
- Types: [src/lib/training/survivalFilters/types.ts](../../src/lib/training/survivalFilters/types.ts)
- Renderer: [src/lib/training/renderTrainingDistributionsHtml.ts](../../src/lib/training/renderTrainingDistributionsHtml.ts)
- Filter pipeline overview: [doc/TRAINING_DOMAIN.md § Scoring methodology](../TRAINING_DOMAIN.md#scoring-methodology)

The rest of the operator-facing exposition (what survival means, how
filters are registered, what each metric in the dashboard answers)
lives in [TRAINING_DOMAIN.md](../TRAINING_DOMAIN.md). This research
note is for the *why we changed it* and *what the change revealed*.
