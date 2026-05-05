# 2026-05-05 — Overnight dry-run iteration: gates, adverse selection, and regime-blindness

## Takeaway

Through four code iterations against live Polymarket dry-run data over ~9 hours, we found that (1) the probability surface's long-shot tail was systematically over-predicting reversion and a `MIN_MODEL_PROBABILITY = 0.30` gate fixes that calibration cleanly, (2) maker fills against thin bid queues are catastrophically adversely-selected and a `MIN_QUEUE_AHEAD_SHARES = 20` gate eliminates almost all of that bleed, and (3) the model is **regime-blind** — it gives the same probabilities for reversion vs continuation bets regardless of trending vs choppy regime, and the day's regime determines which call is profitable. Iter 4 (modelProb + queue gates stacked) lifted filled win rate from 21% to 47% and eliminated adverse selection, but canonical PnL still bled because all the model's reversion bets failed in today's trending regime. The next high-leverage lever is regime-aware trade selection.

## Context

The 2026-05-04 baseline (115 orders, no gates) had:

- 21% filled win rate, 30% all-orders-if-filled win rate
- -$127 canonical PnL, +$274 all-orders-if-filled PnL
- 84% fill rate
- Adverse-selection delta of -$401 (i.e., orders that didn't fill would have collectively earned $400 more than orders that did fill)

The headline question entering the night: **can we lift canonical filled PnL meaningfully positive without changing the underlying probability table?**

The user's bar: filled win rate +10pp, fill rate up, canonical PnL positive AND ≥2× a meaningful positive baseline.

A new telemetry layer (Codex's pre-entry price velocity, lead-time counterfactuals, taker counterfactuals, entry book/price state) had just been added. The session's iterations exploited what that telemetry exposed.

## The four iterations

| Iter | Change | Live result | Status |
|---|---|---|---|
| 1 | `MIN_MODEL_PROBABILITY = 0.30` in `evaluateDecision` (skip if chosen-side prob < 0.30) | 75 orders / 2hr; filled win 29%, all-orders 40%, canon -$128, all-orders +$184 | ✓ kept |
| 2 | Adverse-momentum gate: skip if 30s pre-entry outcome priceDelta < 0 | 23 orders / 1hr; filled win 25%, canon -$207. Over-filtered (1115 skips/hr); 30s window too short | ✗ rolled back |
| 3 | Queue-depth gate `MIN_QUEUE_AHEAD_SHARES = 7` | 84 orders / 3hr; filled win 31%, canon -$240. Gate fired only 26 times — effectively a no-op on top of iter 1 | ✗ tuned away |
| 4 | Tightened queue threshold `7 → 20` | 51 orders / 1.5hr (still running at writing); filled win 47%, canon -$132, **adverse-selection delta -$42 (was -$401)** | currently running |

## Finding 1: long-shot mis-calibration in the probability surface

The 2026-05-04 baseline calibration table (predicted vs actual all-orders win rate, model probability buckets):

| Predicted | N | Actual | Gap |
|---|---|---|---|
| 5–10% | 6 | 0% | -8.8pp |
| 15–20% | **21** | **4.8%** | **-13.1pp** |
| 25–30% | 7 | 14.3% | -12.8pp |
| 30–35% | **51** | **31.4%** | **-1.4pp** ✓ |
| 35–40% | 7 | 57.1% | +19.9pp |
| 60–65% | 4 | 75.0% | +12.2pp |
| 80–85% | 7 | 71.4% | -11.3pp |

The 30-35% bucket — where most baseline trades sat — was well-calibrated. Anything below 30% predicted was systematically over-predicted by ~13pp, especially the 21-trade 15-20% bucket where actual rate was 4.8% versus 18% predicted.

A `MIN_MODEL_PROBABILITY = 0.30` gate prunes the long-shot tail. Counterfactual on the baseline:

- All-orders win rate 30% → 42% (+12pp)
- All-orders if-filled PnL +$274 → +$617 (2.25×)
- Canonical PnL -$127 → +$157 (positive flip)

This is the **durable structural win** of the night. Live in iter 1 it lifted filled win rate from 21% to 29% across 75 orders, validated the calibration finding, and stays in place across all subsequent iterations.

Source: [src/lib/trading/decision/evaluateDecision.ts](../../src/lib/trading/decision/evaluateDecision.ts), [src/constants/trading.ts](../../src/constants/trading.ts).

## Finding 2: queue depth at the bid is a strong adverse-selection predictor

In iter 1's 75-order data, splitting filled orders by queue-depth quartile:

| Queue quartile | N | Avg queue | Fill rate | Filled win | Canon PnL |
|---|---|---|---|---|---|
| Q0 | 18 | 5.7 | 89% | **12.5%** | **-$143** |
| Q1 | 19 | 10.0 | 79% | 26.7% | +$27 |
| Q2 | 19 | 37.5 | 79% | 33.3% | +$2 |
| Q3 | 19 | 237.9 | 84% | 43.7% | -$14 |

Filled win rate scales monotonically with queue depth. Q0 — orders placed against near-empty bid queues — had a 12.5% filled win rate and bled the run's PnL alone. Mechanism: a thin bid queue means our level isn't being defended. Fills come from price-level breaks, and price-level breaks are correlated with the price moving against us.

We tried a soft threshold first (`queueAheadShares ≥ 7`, iter 3). It barely fired (26 skips in 3hrs) and was effectively a no-op. Re-analysis on iter 3's 84-order live dataset showed the cleaner cut was at 20:

| Filter | N | Fill rate | Filled win | Canon PnL | All-orders PnL |
|---|---|---|---|---|---|
| no_filter (iter 3) | 84 | 89% | 31% | -$228 | +$3 |
| queue ≥ 15 | 57 | 89% | 41% | +$73 | +$224 |
| **queue ≥ 20** | **49** | **92%** | **42%** | **+$129** | **+$219** |
| queue ≥ 30 | 41 | 93% | 39% | +$60 | +$90 |

Iter 4 lifted the threshold to 20 live. 1.5hr in: 370 shallow-queue skips, fill rate 88%, filled win rate 47%, **adverse-selection delta -$42 vs iter 3's -$232 in the same elapsed window**. The structural fill-quality problem is meaningfully addressed.

Source: [src/lib/trading/dryRun/runDryRun.ts](../../src/lib/trading/dryRun/runDryRun.ts) (gate after `prepareMakerLimitBuy` returns), [src/constants/trading.ts](../../src/constants/trading.ts).

## Finding 3: the model is regime-blind

The most interesting finding of the night, surfaced only because the iter 4 gate cleared away the noise.

Splitting iter 4's 51 orders by trade direction (chosen side vs current side):

|  | N | Avg limit | Avg modelProb | Filled wins | Canon PnL | All-orders PnL |
|---|---|---|---|---|---|---|
| Reversion (chosen ≠ current) | 23 | $0.22 | 0.32 | 2/23 | **-$266** | -$266 |
| Continuation (chosen = current) | 28 | $0.69 | 0.78 | 19/22 | **+$134** | +$176 |

Today's regime: continuation works (86% filled win rate), reversion fails (8.7% filled win rate). The model gave reversion bets average modelProb 32% — its predictions matter, and were directionally wrong by about 23 percentage points.

The 2026-05-04 baseline (yesterday) had the **opposite** regime:

|  | N | Avg limit | Filled win | Canon PnL | All-orders PnL |
|---|---|---|---|---|---|
| Reversion | 96 | $0.18 | 19.5% | -$31 | **+$265** |
| Continuation | 19 | $0.61 | 30.0% | -$95 | +$9 |

Yesterday: reversions paid (high-volume, reasonable-rate-vs-low-price), continuations underperformed.

Same probability surface, opposite outcomes by trade direction. The model's training data is averaged across regimes; live, the regime determines which call is correct. **Both calls cannot be correct simultaneously**, but the model emits the same probability for both.

This is the next high-leverage lever — but a real design change, not a one-shot constant. Candidates:

1. **Regime classifier**: detect trending vs mean-reverting regime via short-window ATR slope, EMA distance, or recent realized vol; route trades accordingly.
2. **Asymmetric gates**: stricter `MIN_MODEL_PROBABILITY` for reversion bets (e.g., ≥0.40) since the model over-predicts reversions in trending regimes by more than continuations.
3. **Trend confirmation overlay**: only take reversions if recent micro-trend has already started reversing.
4. **Adapt the training surface**: condition the probability table on a regime feature.

## What didn't work

### Iter 2: pre-entry priceDelta gate

The signal looked promising on iter 1 data: filled wins had +30s outcome priceDelta of +$0.017, losses had -$0.032. Skipping orders where priceDelta < 0 had a counterfactual canonical PnL of +$82 on iter 1's data.

In live, it failed:

| Iter 2 1hr | Iter 1 1hr |
|---|---|
| 23 finalized orders | 39 |
| Fill rate 70% | 90% |
| Canonical PnL -$207 | +$158 |
| 1115 skips logged | n/a |

Failure modes:
1. **30s window was too short.** DOGE losers slipped through with priceDelta30s = 0 while their priceDelta60s was strongly negative.
2. **Skip-and-retry concentrated marginal trades.** When the gate skipped, the runner reset the slot to empty and the next tick re-evaluated. The orders that ended up placed were the ones where the gate just barely flipped from skip → pass — i.e., the most marginal moments. This is structurally different from the post-hoc filter that just removes the original orders.
3. **Counterfactual on small samples doesn't generalize.** 75 orders is enough to suggest a hypothesis but not enough to commit to a midnight implementation against live.

Rolled back. The `computePreEntryPriceDelta` helper and its tests were kept in place for future analysis but no longer fire in the runner.

### Iter 3: queue gate at the wrong threshold

Threshold of 7 was picked from iter 1's bottom quartile. With more data (iter 3 reached 84 orders) the cleaner cut was at 20. Lesson: small-sample threshold fitting is unreliable in this domain.

## The headline numbers (iter 4 at 1.5hr, ~51 orders)

| KPI | Baseline (yesterday, 115 orders) | Iter 4 1.5hr (51 orders) | Δ | Bar | Pass? |
|---|---|---|---|---|---|
| Filled win rate | 20.6% | **46.7%** | **+26.1pp** | +10pp | ✓ |
| All-orders win rate | 29.6% | 52.9% | +23.3pp | +10pp | ✓ |
| Canonical fill rate | 84.3% | 88.2% | +3.9pp | up | ✓ |
| Canonical PnL | -$127 | -$132 | -$5 (~flat) | positive AND 2× | ✗ |
| All-orders PnL | +$274 | -$89 | (today's regime ~zero edge) | 2× | ✗ |
| Adverse-selection delta | -$401 | **-$42** | **+$359 better** | down | ✓ |

Three of five KPIs cleared the bar. Canonical PnL did not — and the reason is **not** that the gates aren't working: it's that today's market regime is unfavorable for the strategy's largest bucket of trades (reversion bets), and the model can't see that.

**Per-asset (iter 4 1.5hr)**:

| Asset | N | Fill rate | Filled win | Canon PnL | All-orders PnL |
|---|---|---|---|---|---|
| BTC | 16 | 100% | 50% | +$2 | +$2 |
| DOGE | 10 | 80% | 75% | -$1 | +$13 |
| ETH | 16 | 94% | 33% | -$65 | -$56 |
| SOL | 2 | 50% | 0% | -$20 | -$12 |
| XRP | 7 | 71% | 40% | -$48 | -$37 |

ETH is the bleeder. DOGE, after a brutal first 3 hours of iter 3, is now break-even. BTC is essentially flat. Today's bleed is concentrated in two assets.

## Files changed (all kept, 134 trading tests pass, typecheck clean)

| File | Change |
|---|---|
| [src/constants/trading.ts](../../src/constants/trading.ts) | Added `MIN_MODEL_PROBABILITY = 0.30`; added `MIN_QUEUE_AHEAD_SHARES = 20` (was tried at 7 first) |
| [src/lib/trading/decision/types.ts](../../src/lib/trading/decision/types.ts) | Added `low-confidence` skip reason |
| [src/lib/trading/decision/evaluateDecision.ts](../../src/lib/trading/decision/evaluateDecision.ts) | Added modelProb gate after edge check |
| [src/lib/trading/decision/evaluateDecision.test.ts](../../src/lib/trading/decision/evaluateDecision.test.ts) | Added test for new skip path |
| [src/lib/trading/dryRun/runDryRun.ts](../../src/lib/trading/dryRun/runDryRun.ts) | Added queue-depth gate after `prepareMakerLimitBuy` returns |
| [src/lib/trading/dryRun/telemetry.ts](../../src/lib/trading/dryRun/telemetry.ts) | Added `computePreEntryPriceDelta` helper (currently unused; kept for analysis utility) |
| [src/lib/trading/dryRun/telemetry.test.ts](../../src/lib/trading/dryRun/telemetry.test.ts) | Added 4 tests for new helper |

The model gate also applies to live trading since `evaluateDecision` is shared. The queue gate currently lives only in `runDryRun.ts`; promoting it to live would require plumbing `queueAheadShares` into the live-runner's pre-placement check (the live placement code path uses `prepareMakerLimitBuy` similarly, so the same hook point exists).

## Recommendations for next steps

In rough priority order:

1. **Multi-session validation of the iter 4 stack.** Run the same `MIN_MODEL_PROBABILITY = 0.30` + `MIN_QUEUE_AHEAD_SHARES = 20` configuration across at least 3-5 different days/regimes before drawing conclusions about canonical PnL. Single-day variance is huge: yesterday's regime would have given iter 4 a strongly positive canonical PnL; today's regime gave it slightly negative. Average across regimes is what matters.

2. **Regime-aware trade routing (the new big lever).** The reversion-vs-continuation finding suggests significant headroom. Three implementation options of increasing complexity:
   - **Asymmetric gate**: require `modelProb ≥ 0.40` for reversion bets, keep 0.30 for continuation. Cheap, addressable in `evaluateDecision`.
   - **Regime classifier**: add an ATR-slope or EMA-distance signal as a runtime feature; gate reversions when the regime is trending.
   - **Conditioned probability table**: re-train the surface with regime as an additional dimension.

3. **Dynamic cancellation (the unexplored maker-trader lever).** Currently we place a limit order and passively wait until fill or window expiry. Real market makers re-evaluate continuously. Mechanic: every 5-10s after placement, re-run `evaluateDecision` with current state; if the model would no longer recommend this trade (or recommends the other side), cancel. Validation path before code: replay the model's decision at intermediate times between placement and fill on the existing iter 3 + iter 4 datasets. If the model would have flipped on ≥40% of filled losers before the fill, this is a high-leverage intervention. The new `entryPriceTelemetry` lookbacks make this counterfactual computable from existing data.

4. **Exit-on-profit logic (architectural change).** We currently hold to settlement. Mid-window unrealized gains can't be locked in unless we sell on the ask. Selling means a maker-sell code path that doesn't exist yet. Trades expected value (give up upside on big winners) for variance reduction (lock in many small wins). Given that variance is the main thing destroying canonical PnL today, this is a Sharpe-ratio improvement even if it's net-negative on raw EV.

5. **Don't tune thresholds on small samples.** The night's biggest waste was the iter 2 → iter 3 → iter 4 cycle where the queue threshold went 7 → 20 because of new data. Future tuning should be done on multi-session aggregates, not within-session.

## Methodology lessons

1. **Counterfactuals on the same data you used to derive the rule are over-optimistic.** The iter 2 priceDelta gate looked great on iter 1 data and failed in live. Always validate on out-of-sample data before committing.

2. **Live vs replay differ in non-obvious ways.** The skip-and-retry loop in iter 2 created behavior the post-hoc analysis didn't capture. Counterfactual: "what if we had filtered these orders out". Live: "what if the runner re-evaluates every 250ms after a skip". Different.

3. **Small-sample variance dominates one-night decisions.** Per-hour canonical PnL swings of $200+ in either direction were routine across all four iterations. Drawing strategy conclusions from any single hour is noise.

4. **The pre-entry telemetry was load-bearing for the night's findings.** Without `preEntryMarketTelemetry` and `entryBookTelemetry`, neither the priceDelta hypothesis nor the queue-depth signal would have been visible. Even though iter 2's specific gate failed, the telemetry system that supported the experiment was valuable infrastructure.
