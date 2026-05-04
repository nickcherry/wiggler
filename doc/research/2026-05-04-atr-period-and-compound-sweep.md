# 2026-05-04 — ATR period and compound-filter sweep

## Takeaway

`Distance from price line >= 0.5 ATR` still looks like the right primary
filter family, but ATR-14 is no longer the best period under the current
scoring. A short-period sweep puts **ATR-3** on top by average
`calibrationScore`, with ATR-4 and ATR-5 close behind.

Do not remove ATR-14 from the dashboard. Keep it registered/rendered as the
comparison baseline, but the next production candidate should be the
ATR-3 version unless a later validation run contradicts this result.

## ATR period results

Scores below are `calibrationScore` rendered as a percent of `ln(2)`, the
same convention used in the dashboard/research docs. Higher is better.

| ATR period | Avg | vs ATR-14 | Assets better than ATR-14 |
|---:|---:|---:|---:|
| 3 | **0.640%** | **+23.1%** | 5/5 |
| 4 | 0.637% | +22.5% | 5/5 |
| 5 | 0.629% | +20.9% | 5/5 |
| 6 | 0.614% | +18.0% | 5/5 |
| 7 | 0.604% | +16.1% | 5/5 |
| 8 | 0.592% | +13.7% | 5/5 |
| 10 | 0.561% | +7.9% | 5/5 |
| 12 | 0.532% | +2.2% | 5/5 |
| 14 | 0.520% | 0.0% | baseline |
| 20 | 0.474% | -8.9% | 0/5 |
| 21 | 0.463% | -11.0% | 0/5 |
| 30 | 0.419% | -19.4% | 0/5 |
| 50 | 0.341% | -34.4% | 0/5 |

Per-asset leaders:

| Asset | Best period | Best score | ATR-14 score |
|---|---:|---:|---:|
| BTC | 3 | 0.879% | 0.701% |
| ETH | 4 | 0.693% | 0.559% |
| SOL | 4 | 0.426% | 0.349% |
| XRP | 3 | 0.644% | 0.518% |
| DOGE | 4 | 0.573% | 0.475% |

ATR-3 wins the equal-asset average. ATR-4 wins more individual assets, but
the difference is tiny (`0.640%` vs `0.637%` average), so treat ATR-3/4 as
near-tied and ATR-3 as the current scoring winner.

## Compound-filter passes

Tested compounds as **switch/gate overlays** on the chosen ATR baseline,
not as strict `base AND extra` subsets:

- **Switch:** default to ATR classification; if an overlay activates, use
  the overlay classification instead.
- **Gate:** default to ATR classification; if ATR is true and an overlay
  activates, the overlay can confirm or veto it. ATR-false stays false.

This shape matches the current binary filter/probability-table design while
avoiding the strict-subset problem documented for
`distance_atr_with_ema_aligned`.

### First pass

With ATR-3 as the baseline, broad overlays did **not** add meaningful edge:

| Compound | Avg | vs ATR-3 | Assets better than ATR-3 |
|---|---:|---:|---:|
| ATR-3 gate + RSI 80/20 reversal | 0.641% | +0.1% | 4/5 |
| ATR-3 gate + RSI 75/25 reversal | 0.641% | +0.1% | 3/5 |
| ATR-3 gate + RSI 70/30 reversal | 0.641% | +0.1% | 3/5 |
| ATR-3 gate + ROC-5 0.75% alignment | 0.640% | +0.0% | 3/5 |

Everything else tested was worse, often materially: full switches, broad
ROC gates, stochastic gates, and combined RSI+ROC/stochastic overlays.

### Second pass

Learning from the first pass: broad overlays and full switches are bad;
only rare, veto-only RSI gates were directionally positive. The second
batch therefore tested:

- stricter ROC activation thresholds,
- RSI/ROC/stochastic gates restricted to ATR-distance zones,
- volatility-compression gates,
- inverted RSI,
- two-signal confirmation gates.

The best ATR-3 compound became a local RSI gate:

| Compound | Avg | vs plain ATR-3 | Assets better |
|---|---:|---:|---:|
| ATR-3 + RSI 70/30 gate only when distance is 0.5–0.75 ATR-3 | 0.6430% | +0.0026pp (+0.40% relative) | 4/5 |
| ATR-3 + RSI 70/30 gate only when distance is 0.5–1.0 ATR-3 | 0.6429% | +0.0025pp (+0.39% relative) | 4/5 |
| ATR-3 + RSI 70/30 AND ROC-5 0.75% gate | 0.6415% | +0.0011pp (+0.18% relative) | 4/5 |

Volatility gates were actively bad (`vol_compression` average 0.430%,
`vol_expansion` average 0.012%). Inverted RSI was also worse, which
confirms the original mean-reversion direction is the right side of the
RSI extreme.

Because ATR-4 was near-tied as a base period and won 3/5 individual
assets, the same second-batch compounds were rerun with ATR-4 as the
baseline. The best overall tested classifier was:

| Compound | Avg | vs plain ATR-4 | vs plain ATR-3 | Assets better than ATR-4 |
|---|---:|---:|---:|---:|
| ATR-4 + RSI 70/30 gate only when distance is 0.5–1.0 ATR-4 | **0.6433%** | +0.0059pp (+0.93% relative) | +0.0028pp (+0.44% relative) | 4/5 |

That is the best raw score found so far, but the lift over plain ATR-3 is
tiny and it loses XRP vs plain ATR-3. Current read: **promote no compound
yet**. The strongest compound shape is "rare RSI mean-reversion veto in
the just-above-threshold ATR zone"; it is worth keeping as a future
candidate, not enough to justify production complexity now.

### Third pass and validation

Learning from pass two, the third pass narrowed the grid around the only
working shape: ATR-4 base, RSI mean-reversion veto, and a just-above-
threshold ATR-distance zone. This found a higher all-data score:

| Compound | Avg | vs plain ATR-4 | vs plain ATR-3 | Assets better than ATR-4 |
|---|---:|---:|---:|---:|
| ATR-4 + RSI 65/35 gate only when distance is 0.5–0.65 ATR-4 | **0.6506%** | +0.0132pp (+2.08% relative) | +0.0101pp (+1.58% relative) | 5/5 |

Per asset vs plain ATR-3:

| Asset | Compound | Plain ATR-3 | Delta |
|---|---:|---:|---:|
| BTC | 0.8926% | 0.8787% | +0.0139pp |
| ETH | 0.7043% | 0.6902% | +0.0140pp |
| SOL | 0.4399% | 0.4254% | +0.0145pp |
| XRP | 0.6372% | 0.6436% | -0.0064pp |
| DOGE | 0.5789% | 0.5643% | +0.0146pp |

This looked promising enough to sanity-check by calendar year. Using the
same scoring code on per-year snapshots, the compound did **not** hold up
cleanly vs plain ATR-3:

| Year | ATR-3 | Compound | Compound vs ATR-3 |
|---|---:|---:|---:|
| 2023 | 0.111% | 0.111% | -0.000pp |
| 2024 | 0.115% | 0.104% | -0.010pp |
| 2025 | 0.126% | 0.125% | -0.001pp |
| 2026 | 0.008% | 0.008% | -0.000pp |

The per-year run uses fewer samples per slice, so absolute scores are not
directly comparable to the all-data dashboard score under the 2000-sample
floor. The relative read is still useful: the tuned compound's advantage
is not stable across calendar regimes. Treat it as likely overfit until a
more rigorous out-of-sample/backtest says otherwise.

Final current recommendation: **ATR-3 remains the primary candidate; do
not promote a compound yet.**

## Dashboard representation

The training dashboard now renders the ATR short-period candidates alongside
the existing production comparison filter:

- `distance_from_line_atr_3` — `Distance from price line >= 0.5 ATR-3`
- `distance_from_line_atr_4` — `Distance from price line >= 0.5 ATR-4`
- `distance_from_line_atr` — existing ATR-14 filter, kept for comparison

Production/live probability generation still points at the existing
ATR-14 filter id until we deliberately make a production change. The
training snapshot pipeline version was bumped so ATR-3 and ATR-4 values
are present in rebuilt dashboard snapshots.

## Artifact

Raw experiment output was written under ignored `tmp/` as:

- `tmp/atr-period-sweep_2026-05-04T19-20-04-837Z.json`
- `tmp/atr-period-sweep_2026-05-04T19-25-25-879Z.json`
- `tmp/atr-period-sweep_2026-05-04T19-27-17-951Z.json`
- `tmp/atr-period-sweep_2026-05-04T19-30-51-905Z.json`
- `tmp/atr-period-sweep_2026-05-04T19-34-44-326Z.json`

Validation helper:

- `tmp/validate_candidate_by_year.ts`

Dashboard regeneration after registering ATR-3 and ATR-4:

- `tmp/training-distributions_2026-05-04T20-44-35-000Z.json`
- `tmp/training-distributions_2026-05-04T20-44-35-000Z.html`
