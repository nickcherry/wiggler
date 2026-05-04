# 2026-05-04 — Bumping the per-bucket sample floor 300 → 2000

## Takeaway

We had a sample-composition artifact at low bp for our champion
`distance_from_line_atr` that was inflating both the headline
calibration score and the apparent "edge at low distances" you'd see
on the lift chart. Bumping `SUMMARY_MIN_SAMPLES` from 300 to 2000
correctly drops the artifact buckets out of scoring, at the cost of
~halved sweet-spot coverage. The new numbers are smaller in absolute
terms but *more honest*.

## The artifact

`distance_from_line_atr` classifies a snapshot as `true` ("decisively
away") when `|snapshotPrice − line| ≥ 0.5 × ATR-14`. The dashboard
plots cells by **bp distance** (not by ATR). So at bp = 1, the
trueHalf includes only the snapshots taken during *abnormally
low-ATR* periods — those are the only times when 1 bp can clear the
0.5 × ATR threshold.

In the original 300-floor scoring, we were including these tiny,
structurally-different subpopulations:

```
bp │ trueTotal │ falseTotal │ true% │ trueRate%
 0 │    219   │  186,223  │  0.1% │   92.7
 1 │  2,267   │  155,731  │  1.4% │   89.3
 2 │  6,635   │  131,879  │  4.8% │   89.0
 3 │ 11,748   │  106,989  │  9.9% │   90.5
 5 │ 20,751   │   64,146  │ 24.4% │   91.4
10 │ 19,531   │   14,576  │ 57.3% │   93.8
```

(BTC, all four `remaining` values aggregated.)

At bp = 1 only **1.4%** of snapshots are classified as true — these
are the low-ATR-regime snapshots. Their 89.3% survival rate isn't
a "decisively away" effect; it's a "low-ATR moments survive better"
effect (price moves slowly when ATR is low → 1 bp away tends to stay
1 bp away through close).

The filter is *implicitly* capturing volatility regime at low bp. At
high bp (> 5 or so), the trueHalf becomes a substantial fraction of
the population, and the "decisively away" semantics start to make
honest sense.

## Why 300 was wrong

Two issues:

1. **Sample composition.** A 300-snapshot bucket per cell at low bp
   is dominated by an unusual sub-population (low-ATR moments). The
   measured rate doesn't generalize to the typical-ATR conditions we
   care about for trading.

2. **Statistical noise.** Standard error on a binomial rate at
   `n = 300` is ~3 pp. The deltas we're trying to measure at
   trustworthy higher-bp ranges are only 1–2 pp. We were calling a
   24.7 pp delta at bp = 1 (with ~570 samples per cell) "real
   signal" against ~6 pp of combined per-cell noise. The signal-to-
   noise ratio was too loose.

## What the bump fixes

At `SUMMARY_MIN_SAMPLES = 2000`:

- Standard error drops to ~1 pp (per-cell, p ≈ 0.5).
- bp = 1 trueHalf (~570/cell) gets correctly excluded.
- bp ≥ 3 still passes the floor for the champion's trueHalf at
  typical asset volatility, so the meaningful "decisively away"
  region stays in scoring.

Empirical impact across all assets, before/after the floor change
(threshold = 70% in both cases):

| Asset | Pop% old → new | Sweet old → new | Restricted% old → new | Cov% old → new |
|---|---:|---|---:|---:|
| BTC | 0.90 → **0.70** | [1, 8] → [3, 8] | 1.04 → **1.35** | 61.8 → 38.2 |
| ETH | 0.81 → **0.56** | [2, 11] → [5, 11] | 1.02 → **1.29** | 56.0 → 30.7 |
| SOL | 0.61 → **0.35** | [7, 20] → [11, 18] | 1.10 → **1.29** | 39.7 → 19.1 |
| XRP | 0.82 → **0.52** | [4, 16] → [7, 14] | 1.21 → **1.48** | 47.8 → 25.5 |
| DOGE | 0.80 → **0.47** | [4, 18] → [8, 16] | 1.12 → **1.35** | 51.3 → 25.5 |

Three patterns to notice:

1. **Sweet-spot ranges shifted up by 1–4 bp** at the low end across
   every asset. The artifact buckets fell off the bottom of the
   range; the high-end didn't change much.
2. **Population calibration dropped 20–35%.** That's the cost of
   honesty — the old number was inflated by the low-bp artifact.
3. **Restricted calibration *rose* 25–30%.** The old sweet spot was
   *diluted* by the artifact. Once the artifact's gone, the
   genuinely-strong sweet-spot buckets show their actual edge.
4. **Coverage halved.** We're now scoring against a smaller share of
   the population. Live trading would gate on a tighter range — fewer
   trades, but better-calibrated ones.

## Implications

- **The filter's real edge is narrower than it looked.** Headline
  ~0.5–0.7% (from 0.6–0.9%). But the restricted-range edge is
  meaningfully sharper than we previously thought (~1.3–1.5% vs
  1.0–1.2%). The filter is *more concentrated* than the old numbers
  suggested.

- **Cross-filter comparisons in the [filter archive](./2026-05-04-filter-archive.md)
  use the old floor (300).** Direct numerical comparison between
  archive numbers and current dashboard numbers isn't apples-to-apples
  for filters whose edge is bp-conditioned. The archive is preserved
  as a historical record; do *not* retroactively rewrite its numbers
  against the new floor — the relative rankings hold either way, and
  the absolute values are useful as a "this is what we thought at
  the time" snapshot.

- **The renderer's display floor was bumped in lockstep**
  (`SURVIVAL_MIN_SAMPLES` 300 → 2000) so the chart's "hidden under
  floor" gaps match the scoring layer.

- **2000 is a pragmatic value, not a derived one.** It's the threshold
  at which per-cell SE drops below the ~1 pp scale of typical
  high-bp deltas, and conveniently excludes the visible artifact
  buckets. We could go higher (5000, 10000) for stricter scoring but
  would lose more coverage. 2000 is a defensible mid-point given
  current backfill volume; revisit if backfill grows substantially or
  if we onboard filters with very different per-bp distributions.

## A separate observation worth flagging

The artifact exists because `distance_from_line_atr` mixes two
effects (distance × ATR regime). A cleaner future filter formulation
would be a binary `bp ≥ N` filter (no ATR conditioning), with ATR
regime as a separate dimension we could compose explicitly. That's a
structural redesign, not a floor question — flagging it here for the
next compound-filter design pass.

## Files at the time of writing

- Constant: `SUMMARY_MIN_SAMPLES = 2000` in
  [applySurvivalFilters.ts](../../src/lib/training/survivalFilters/applySurvivalFilters.ts)
- Renderer mirror: `SURVIVAL_MIN_SAMPLES = 2000` in
  [renderTrainingDistributionsHtml.ts](../../src/lib/training/renderTrainingDistributionsHtml.ts)
- Snapshot pipeline version 14 → 15 (filter cache invalidates on
  bump).
