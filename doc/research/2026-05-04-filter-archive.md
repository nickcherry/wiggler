# 2026-05-04 — Filter archive

> **Note on numbers in this doc:** the calibration figures below were
> computed with `SUMMARY_MIN_SAMPLES = 300`. We later bumped that floor
> to 2000 (see
> [doc/research/2026-05-04-sample-floor.md](./2026-05-04-sample-floor.md))
> after discovering a sample-composition artifact at low bp. Absolute
> calibration percentages here are slightly inflated relative to current
> dashboard numbers; **relative rankings are unaffected**. The table is
> preserved as a historical record of what we thought at the time.

## Takeaway

Of the 28 filters we'd ever shipped, exactly two are pulling their
weight after the [scoring overhaul](./2026-05-04-filter-scoring-overhaul.md):
`distance_from_line_atr` (training-side champion) and
`ema_50_5m_alignment` (the production live-trader's `aligned`
filter — kept registered for direct comparison). Everything else
falls below `0.30%` calibration improvement vs no-filter, and most
fall below `0.10%`. We're purging the rest from `src/`; this doc is
the record of what we tried and how each performed, so we don't
re-discover the same conclusions when designing future filters.

Restoring any of these is a one-liner: each was its own directory
under `src/lib/training/survivalFilters/<name>/`, deleted in the
purge commit. `git log -p src/lib/training/survivalFilters/<name>/`
reconstructs everything, including tests.

## Calibration table

All scores are `calibrationScore` rendered as a percentage of
baseline log-loss (≈ 0.69 nats), per asset. Higher = better. Skip
rate is shared across all five assets per filter (filters classify
deterministically off context that's the same shape per asset).

The cutoff line is around **0.10% avg** — anything below that is
contributing roughly nothing in expectation across the population.

| Filter | Avg | Skip | BTC | ETH | SOL | XRP | DOGE | Status |
|---|---:|---:|---:|---:|---:|---:|---:|---|
| `distance_from_line_atr` | **0.79%** | 0% | 0.90 | 0.81 | 0.61 | 0.82 | 0.80 | **Keep — champion** |
| `roc_5_strong_aligned` | 0.26% | 74% | 0.38 | 0.35 | 0.15 | 0.23 | 0.21 | Purge — see compound notes |
| `roc_20_strong_alignment` | 0.26% | 57% | 0.36 | 0.33 | 0.15 | 0.25 | 0.23 | Purge — see compound notes |
| `distance_atr_with_ema_aligned` | 0.23% | 0% | 0.26 | 0.23 | 0.17 | 0.24 | 0.24 | Purge — strict subset of parent, calibration-degrading |
| `vol_compression` | 0.21% | 0% | 0.28 | 0.23 | 0.20 | 0.15 | 0.18 | Purge |
| `weekend_session` | 0.13% | 0% | 0.24 | 0.15 | 0.11 | 0.10 | 0.06 | Purge |
| `stretched_from_ema_50_alignment` | 0.10% | 38% | 0.10 | 0.14 | 0.09 | 0.07 | 0.09 | Purge |
| `utc_hour_us_session` | 0.09% | 0% | 0.13 | 0.11 | 0.07 | 0.05 | 0.07 | Purge |
| `recent_breakout_aligned` | 0.07% | 66% | 0.08 | 0.10 | 0.07 | 0.06 | 0.06 | Purge |
| `rsi_extreme_against_side` | 0.06% | 93% | 0.09 | 0.09 | 0.04 | 0.05 | 0.04 | Purge — see compound notes |
| `volume_high_aligned` | 0.06% | 0% | 0.08 | 0.09 | 0.06 | 0.05 | 0.04 | Purge |
| `ema_50_5m_alignment` | 0.06% | 0% | 0.07 | 0.09 | 0.05 | 0.04 | 0.06 | **Keep — benchmark for former production alignment signal** |
| `rsi_14_5m_alignment` | 0.06% | 0% | 0.06 | 0.10 | 0.05 | 0.04 | 0.05 | Purge |
| `ema_20_5m_alignment` | 0.05% | 0% | 0.06 | 0.09 | 0.05 | 0.03 | 0.04 | Purge |
| `ma_50_5m_alignment` | 0.05% | 0% | 0.05 | 0.07 | 0.05 | 0.04 | 0.05 | Purge |
| `donchian_50_top_alignment` | 0.05% | 0% | 0.06 | 0.07 | 0.05 | 0.03 | 0.04 | Purge |
| `ma_20_5m_alignment` | 0.05% | 0% | 0.05 | 0.09 | 0.04 | 0.03 | 0.04 | Purge |
| `stochastic_extreme_against` | 0.05% | 62% | 0.06 | 0.08 | 0.04 | 0.03 | 0.03 | Purge — see compound notes |
| `roc_20_5m_alignment` | 0.04% | 1% | 0.04 | 0.06 | 0.04 | 0.03 | 0.05 | Purge |
| `range_expansion` | 0.04% | 0% | 0.05 | 0.04 | 0.05 | 0.03 | 0.04 | Purge |
| `ema_50_slope_alignment` | 0.04% | 0% | 0.04 | 0.05 | 0.04 | 0.03 | 0.04 | Purge |
| `ema_20_above_ema_50_alignment` | 0.04% | 0% | 0.03 | 0.04 | 0.04 | 0.03 | 0.04 | Purge |
| `last_5_5m_majority_alignment` | 0.02% | 0% | 0.02 | 0.04 | 0.02 | 0.02 | 0.02 | Purge |
| `range_within_atr` | 0.02% | 0% | 0.05 | 0.03 | 0.01 | 0.01 | 0.01 | Purge |
| `last_3_5m_majority_alignment` | 0.02% | 0% | 0.02 | 0.04 | 0.02 | 0.02 | 0.02 | Purge |
| `bullish_body_alignment` | 0.02% | 65% | 0.02 | 0.03 | 0.02 | 0.01 | 0.01 | Purge |
| `prev_5m_direction_alignment` | 0.02% | 0% | 0.02 | 0.02 | 0.01 | 0.01 | 0.02 | Purge |
| `european_session` | 0.01% | 0% | 0.01 | 0.01 | 0.01 | 0.01 | 0.01 | Purge — clear noise |

## Per-filter intuition

For each retired filter, the question it asked, why it seemed
plausible, and what we actually saw.

### `distance_atr_with_ema_aligned` — the broken compound

> Is the price at least 0.5 ATR-14 from the line AND aligned with EMA-50?

The thinking was that requiring both positional displacement *and*
trend agreement should produce a stronger signal than either alone.
What actually happened: it's a strict subset of the parent
`distance_from_line_atr`. Cohen's kappa with the parent: 0.58, with
the structural signature `ft = 0` (never says true when parent says
false). So all this filter does is take the parent's true-half and
sub-classify it by EMA alignment — and the smaller per-bucket samples
in the sub-classified groups produce noisier rate estimates that
predict outcomes *worse* than the parent's smoother rates. Cautionary
tale: restrictive compounds can degrade calibration even when each
constituent is informative.

### `roc_5_strong_aligned` / `roc_20_strong_alignment` — momentum-aligned

> Has the price moved more than ε% in the last 5 (or 20) bars in the
> same direction as the current side?

The two ROC variants are basically the same idea at different
lookbacks. They fire on ~50–75% of snapshots (depends on threshold
and asset). Calibration when fired (`logLossImprovementNats`) is
solid (~0.005 nats/kept-snap), but normalized by population it's
~0.25%. **Cohen's kappa with the champion ≈ 0.005** — genuinely
orthogonal signal. This is the strongest compound candidate on the
medium-frequency side: a filter that overrides the champion's
prediction when momentum strongly agrees with the current side.

### `rsi_extreme_against_side` — mean reversion at extremes

> Is RSI ≥ 70 or ≤ 30 AND `currentSide` is opposite the extreme
> direction (i.e. RSI says we should mean-revert, and we're already
> on the reverting side)?

Highest **per-kept-snapshot** info gain we have (~0.011 nats/snap)
but skips 93%, so population-normalized score is 0.06%. Cohen's
kappa ≈ 0.025 — independent of the champion. The most interesting
compound candidate: it's a sniper filter, fires rarely, but when it
fires it's *very* informative AND independent of distance. Worth a
"switch override at RSI extremes" layer.

### `vol_compression` (ATR-14 < ATR-50) — quiet markets hold

> Is short-term volatility lower than long-term?

The intuition was that quiet markets give the current side more
chance to hold. Modest signal (avg 0.21%) — real but small. Always
fires. Probably worth revisiting if we explore time-varying-edge
filters; it's basically a market-regime indicator.

### `weekend_session` / `utc_hour_us_session` — calendar-time conditioning

> Is the snapshot during the weekend / a US-trading-hours hour?

Both modest. Weekend session is the better of the two (avg 0.13%).
Crypto weekend microstructure is genuinely different from weekday.
Calendar conditioning is cheap to implement; if we want to layer
something temporally, this is the obvious starting point.

### `recent_breakout_aligned` — proximity-in-time momentum

> Did the most recent 5 5m bars set a new 50-bar high or low, AND
> is the current side aligned with that direction?

Distinct from a static donchian-position filter (proximity in space)
in that it's about *recency*. Modest signal, high skip. Probably
not worth resurrecting on its own; might combine with the ROC
candidates if we go deep on momentum compounds.

### `stretched_from_ema_50_alignment` — distance-from-MA + alignment

> Is the line ≥ 1 ATR-14 from EMA-50, AND the current side aligned
> with the stretch direction?

A spatial mean-reversion idea: when price is far from its trend,
does the trend-aligned side hold better? Skip rate 38%, signal 0.10%
average. Marginal.

### `volume_high_aligned` — volume confirmation

> Is the most recent 5m bar's volume > 1.5× the 50-bar average AND
> the current side aligned with that bar's direction?

The "real flow agrees" thesis. Always fires (volume on every bar).
Modest signal — the bar's direction is a weak feature on its own,
and volume-conditioning didn't add enough.

### `bullish_body_alignment` — bar-shape conditioning

> Is the previous 5m bar's body > 0 in the current side's direction?

Bar-shape patterns. High skip, near-zero signal. Pattern-based
conditioning at the bar level looks like noise here.

### Other 5m-trend-alignment filters — all near-noise

`ema_20_5m_alignment`, `ma_20_5m_alignment`, `ma_50_5m_alignment`,
`ema_20_above_ema_50_alignment`, `ema_50_slope_alignment`,
`donchian_50_top_alignment`, `roc_20_5m_alignment`,
`rsi_14_5m_alignment`, `last_3_5m_majority_alignment`,
`last_5_5m_majority_alignment`, `prev_5m_direction_alignment`,
`stochastic_extreme_against`, `range_within_atr`, `range_expansion`,
`european_session`. Each scored < 0.10% population-normalized;
several scored < 0.02%. The pattern is clear: simple yes/no questions
about 5m-bar context don't carry meaningful information about
within-window survival.

### Why session-of-day-like filters might still be worth a look

The session filters (`weekend_session`, `utc_hour_us_session`,
`european_session`) were originally tested as standalone yes/no
splits. They might be more useful as *covariates* (multi-way
factors of e.g. "weekend + low volume") than as binary partitions.
Not pursuing now.

## What this implies for compound design

After staring at the table:

1. **The champion is doing most of the work.** No other filter is
   even half as good on its own.
2. **The most promising orthogonal layer is RSI-extreme.** Best
   per-kept-snap info gain, lowest kappa with champion, fires
   rarely. Behaves like a regime-switch.
3. **Momentum-aligned ROC filters are the next-best orthogonal
   layer.** Higher fire-rate than RSI, decent info gain, kappa ≈ 0
   with champion.
4. **Don't trust restrictive AND-compounds.** They look attractive
   under naive scoring (more conditioning → less variance per
   bucket *in expectation*) but in finite-sample reality, smaller
   buckets have noisier rates that predict outcomes worse than the
   parent's smoother rates. The
   `distance_atr_with_ema_aligned` story is the canonical example.
5. **Bar-shape and 5m-trend-alignment filters are roughly noise.**
   Session-of-day filters are the same except `weekend_session`,
   which has visible-but-small signal.

Future compound experiments should start from
`distance_from_line_atr` as the bedrock, then layer one of:
RSI-extreme override, ROC-aligned override, or
weekend/session conditioning.
