# 2026-05-04 — Sweet-spot detection

> **Note on numbers in this doc:** the calibration figures below were
> computed with `SUMMARY_MIN_SAMPLES = 300`. We later bumped that floor
> to 2000 (see
> [doc/research/2026-05-04-sample-floor.md](./2026-05-04-sample-floor.md)).
> Absolute calibration percentages and sweet-spot bp ranges in this
> doc reflect the pre-bump scoring; the current dashboard's numbers are
> different (population calibrations are lower, sweet-spot ranges
> shifted up at the low end, restricted calibrations are higher). The
> *concepts* — the algorithm, threshold rationale, trading-discipline
> framing, edge cases — are unaffected. Treat this as the methodology
> doc; treat the live dashboard as the source of truth for current
> numbers.

## Takeaway

A filter's `calibrationScore` averages information gain across the whole
population, including all the boring near-line buckets (no edge) and the
sparse far-tail buckets (high edge per snapshot but few snapshots). The
**sweet spot** is the narrowest contiguous bp range that captures most of
the filter's actual work — analogous to "the food district" on a street
of mixed restaurants. Restricting acted-upon snapshots to this range is
a discipline measure: don't trust the filter's `p` outside the buckets
where it earns its keep.

We use **80%** as the info-gain capture threshold — the conventional
Pareto-style cutoff. For our champion `distance_from_line_atr` the
edge is broadly distributed, so tightening to 70% mostly narrows the
range without lifting restricted calibration; the extra coverage at
80% is worth more than the marginally crisper range at 70%. See the
threshold-choice section below for the per-asset numbers.

## Why this exists

The headline calibration score for our champion is **0.90% (BTC)** —
small in absolute terms, dragged down by population averaging across all
distance buckets. The chart, on the other hand, shows the trueHalf line
shifting predictions by 5–8 pp away from the global baseline at certain
distances. There's a real disconnect between "the chart looks dramatic"
and "the calibration percentage is modest," and the disconnect is
because:

1. Most snapshots cluster near `bp = 0` (price hugging the line, ~50/50
   either way). The filter's prediction barely moves there.
2. Far-tail buckets (`bp ≥ 30`) have huge per-snap edge but tiny
   sample weight.
3. The interesting middle range — where the filter actually shifts
   predictions in a sample-rich way — is the bulk of the value, but
   gets averaged together with (1) and (2) in the headline.

The sweet spot isolates (3): the contiguous bp range where the filter's
edge is both real and well-supported by data.

## Algorithm

For each filter:

1. **Aggregate per-bp positive info gain.** For every counted
   `(remaining, half, distance)` cell, compute `nats saved at this
   bucket vs the global baseline` (= `globalLogLoss − halfLogLoss` on
   the half's own outcomes, summed across the bucket's snapshots).
   Clip negative buckets to 0 (anti-informative buckets don't belong
   in a "where does the filter help?" range). Pivot into a per-bp map:
   `gain[bp] = sum across all cells of nats saved at this bp`.
2. **Find smallest contiguous `[a, b]`** such that `sum(gain[bp] for
   bp in [a, b]) >= threshold * sum(gain[bp])`. Two-pointer sliding
   window, linear in the number of distinct bp keys.
3. **Compute restricted-range calibration**: `gainInRange /
   snapshotsInRange`, where `snapshotsInRange` is the count of
   snapshots that landed in floor-passing buckets within `[a, b]`.
4. **Compute coverage**: `snapshotsInRange / snapshotsTotal` — the
   fraction of population snapshots that fall inside the sweet spot.

`null` when the filter has no positive info gain anywhere.

The complete implementation is in `computeSweetSpot` in
[applySurvivalFilters.ts](../../src/lib/training/survivalFilters/applySurvivalFilters.ts).

## Threshold choice: 70% vs 80% vs 90%

This is the key tunable. There's no math that picks a "right" value —
it's a policy choice about how aggressive your restriction is.

For our champion `distance_from_line_atr`, here's how 80% (current
default) compares to 70% on real data per asset:

| Asset | 80% range | 80% restr. | 80% cov | 70% range | 70% restr. | 70% cov |
|---|---|---:|---:|---|---:|---:|
| BTC | [1, 10] | 1.09% | 67.8% | [1, 8] | 1.04% | 61.8% |
| ETH | [2, 14] | 1.07% | 62.5% | [2, 11] | 1.02% | 56.0% |
| SOL | [6, 22] | 1.04% | 47.2% | [7, 20] | 1.10% | 39.7% |
| XRP | [4, 19] | 1.27% | 51.9% | [4, 16] | 1.21% | 47.8% |
| DOGE | [4, 22] | 1.17% | 56.5% | [4, 18] | 1.12% | 51.3% |

**The interesting empirical finding**: tightening from 80% to 70%
mostly does *not* improve restricted calibration for our champion. The
range narrows (4–8 bp tighter in most cases) and coverage drops 5–8 pp,
but the average info-gain-per-snapshot inside the range stays roughly
the same. This is because the champion's edge is broadly distributed —
there's no tight peak to "find" by tightening; you're just shaving off
average-density buckets at the edges.

So we stay at 80%: the wider range trades through more snapshots
without giving up meaningful per-snap quality for this filter shape.
A tighter threshold would only pay off if the per-snap calibration
inside the narrower range were materially higher, which it isn't here.

Two implications for filters we haven't built yet:

- **Sharply-peaked filters** would benefit from a tighter threshold
  more than the champion does — the algorithm would lock onto the
  peak and exclude the noise on either side. If we add such a filter
  it may be worth dropping it to 70% per-section.
- **Filters that don't beat the population score by ~1.5×+ at any
  threshold** are weak filters where the sweet-spot concept buys us
  little. The tool reads them honestly: their `sweet/pop` ratio is
  ~1.0.

Down the road, if we end up wanting to compare filters with different
edge shapes, exposing a per-section knob to dial the threshold (70/80/90)
would let the operator see the trade-off live without a regen.

## Trading-discipline interpretation

Live trading already has a check that filters out weak edges (the
modeled `p` vs market quote comparison). So in some sense the system
*already* avoids acting in the noise buckets. But there's a calibration
risk in those buckets: `p = 51%` might be from a filter cell that's
overfit to noise rather than a real edge.

Restricting acted-upon snapshots to the sweet spot is a *discipline*
measure: don't trust the filter's `p` outside the bp range where the
filter has actually shown it's earning its keep. Specifically:

- Inside the sweet spot, our `p` is ~1.3% (on a baseline of ~0.7
  nats) better than no-filter on average. That's small in absolute
  terms but *real and consistent across distance buckets*.
- Outside the sweet spot, calibration is closer to no-filter — the
  filter's prediction is barely sharper than the unconditional rate,
  so any "edge" the modeled `p` shows vs the market is more likely to
  be model noise than real signal.

Whether this discipline pays off in PnL terms is a separate question
that needs live-trading data to answer. The training-side sweet-spot
number tells us prediction quality (a leading indicator) but not
realized profit (the lagging indicator).

## Edge cases worth knowing

- **No positive gain anywhere.** `sweetSpot = null`. Surfaced on the
  dashboard as "no sweet spot." Skip the filter.
- **Bimodal info gain (two peaks separated by a trough).** A
  contiguous range either covers both peaks plus the trough between
  them, or only one peak. The algorithm picks the wider option iff
  the union reaches the configured capture threshold; otherwise picks
  one peak. Probably the right call for trading discipline (contiguous
  ranges are easier to act on), but worth flagging if a future filter
  shows clear bimodal behaviour.
- **Tiny range.** If most gain lives in `[10, 12]` (a 3-bp window), the
  sweet spot is real but you'd rarely trade in it. Coverage will be low
  (e.g. 10–15%); the visual cue on the dashboard is the very narrow
  gold overlay band.
- **Below-floor buckets in the range.** Coverage uses
  `snapshots_in_floor_passing_buckets / snapshotsTotal` while the
  population calibration uses `snapshotsTotal` directly. There's a
  small accounting gap if the sweet-spot range happens to contain
  below-floor buckets — coverage is slightly understated. Negligible
  for our current 0%-skip filters with rich data; could matter for
  rare-fire filters in future.

## Files at the time of writing

- Algorithm: [`computeSweetSpot` in applySurvivalFilters.ts](../../src/lib/training/survivalFilters/applySurvivalFilters.ts)
- Type: [`SurvivalSweetSpot` in types.ts](../../src/lib/training/survivalFilters/types.ts)
- Threshold constant: `SWEET_SPOT_INFO_GAIN_THRESHOLD = 0.80` (same file)
- Rendering (lift chart + overlay + meta strip): [renderTrainingDistributionsHtml.ts](../../src/lib/training/renderTrainingDistributionsHtml.ts) (`buildLiftChart`, `formatLiftMeta`)
- Operator-facing exposition: [TRAINING_DOMAIN.md § Sweet-spot detection](../TRAINING_DOMAIN.md#sweet-spot-detection)
