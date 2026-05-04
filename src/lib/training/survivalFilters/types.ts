import type {
  SurvivalRemainingMinutes,
  SurvivalSnapshot,
  SurvivalSnapshotContext,
} from "@alea/lib/training/computeSurvivalSnapshots";
import type {
  SurvivalSurface,
  SurvivalSurfaceWithCount,
} from "@alea/lib/training/types";

/**
 * Result of classifying a single snapshot for a binary filter:
 *
 *   - `true`/`false` — snapshot belongs to that side of the split.
 *   - `"skip"` — snapshot lacks the lookback context this filter needs
 *     (e.g. very early in the series). Skipped snapshots count toward
 *     `snapshotsSkipped` in the filter summary but never toward either
 *     side, so coverage stays honest.
 */
export type SurvivalFilterDecision = boolean | "skip";

// ----------------------------------------------------------------
// SurvivalFilter — the canonical interface every filter implements.
//
// Adding a new filter is one file under `survivalFilters/` exporting an
// object that satisfies this type, plus a single line in the registry.
// The runner, the cache layer, the renderer all consume filters
// generically through this interface — they never special-case a
// particular filter id. Keep the metadata fields tight; rich
// per-section copy belongs in `description`.
// ----------------------------------------------------------------

export type SurvivalFilter = {
  /**
   * Stable, machine-readable identifier (snake_case, no spaces). Used as
   * the cache filename component and the JSON payload field key. Don't
   * change it after a filter is in production — the cache will go stale
   * silently and the dashboard's UI state (selected tab, etc.) won't
   * carry over.
   */
  readonly id: string;

  /**
   * Human-readable section title for the dashboard.
   */
  readonly displayName: string;

  /**
   * One-or-two-sentence prose explanation of what the split means.
   * Rendered verbatim under the section title.
   *
   * Style guide:
   *   - Phrase as a yes/no question. Filters are binary splits, so a
   *     question reads naturally: "Is price decisively away from
   *     the window's open?" (✓) vs "Splits snapshots by..." (✗).
   *   - Write for a non-quant reader. Translate jargon: "ATR-14"
   *     becomes "typical 5-min swing", "EMA-50" becomes "longer-
   *     term trend", "current side" becomes "leading side", "5m
   *     start line" becomes "where the window opened".
   *   - It's fine — encouraged — to mention the precise threshold
   *     in parentheses for the reader who wants the technical
   *     version, e.g. "(at least half a typical 5-min swing away)"
   *     or "(RSI ≥ 70 or ≤ 30)". Keep it short.
   *   - Aim for ≤ 25 words. The dashboard renders the description
   *     verbatim and a long blurb pushes the chart down.
   */
  readonly description: string;

  /**
   * Label for the "filter classified true" half. Shown in the chart
   * legend, summary line, and (when surfaced) tab badges.
   */
  readonly trueLabel: string;

  /**
   * Label for the "filter classified false" half. Same surfaces as
   * `trueLabel`.
   */
  readonly falseLabel: string;

  /**
   * Bumps when `classify` produces materially different output for the
   * same input — different tie-break, different threshold, a corrected
   * bug. Cache keys mix this in so a version bump invalidates only this
   * filter's cached results, not the whole dashboard. Start at 1; the
   * convention is monotonic positive integers.
   */
  readonly version: number;

  /**
   * Pure classifier. The `context` argument is the snapshot's lookback
   * context (prev 1m direction, MA-20, etc.); it's also accessible as
   * `snapshot.context` but is passed separately so closures over context
   * fields stay easy to write. Must return `"skip"` when the lookback
   * data the filter needs isn't present.
   */
  readonly classify: (
    snapshot: SurvivalSnapshot,
    context: SurvivalSnapshotContext,
  ) => SurvivalFilterDecision;
};

// ----------------------------------------------------------------
// Per-asset rolled-up filter result + summary.
// ----------------------------------------------------------------

/**
 * Per-asset rolled-up filter result. The baseline surface is duplicated
 * into each result so the renderer can build delta cells without
 * maintaining its own join from `(asset, filter)` back to the baseline.
 */
export type SurvivalFilterResult = {
  readonly id: string;
  readonly displayName: string;
  readonly description: string;
  readonly trueLabel: string;
  readonly falseLabel: string;
  readonly baseline: SurvivalSurfaceWithCount;
  readonly whenTrue: SurvivalSurfaceWithCount;
  readonly whenFalse: SurvivalSurfaceWithCount;
  readonly summary: SurvivalFilterSummary;
};

/**
 * Per-`(remaining-minutes, half)` score against a **filter-conditioned
 * baseline** (the union of `whenTrue` + `whenFalse` at each bucket — i.e.
 * the unconditional survival rate restricted to snapshots this filter
 * actually classified, excluding `skip`s). The score is the signed area
 * between the half's win-rate line and that conditioned baseline,
 * integrated over distance:
 *
 *     score = Σ over comparable bp buckets of (halfWinRate − conditionedBaselineWinRate)
 *
 * Units are pp·bp (percentage-points × basis-points), but we render it
 * as a dimensionless number — relative magnitude is what matters for
 * ranking.
 *
 * Convention: **positive = this side of the split is the better-
 * performing half within this filter's kept population**. By
 * construction the two halves' scores are sign-opposed at each bucket
 * (the conditioned baseline is the count-weighted average of the
 * halves), so what `score` answers is *which* side of the split to
 * trust, with magnitude = how cleanly the split separates the two
 * halves. Both signs are tradeable as long as we know which side we're
 * on; in our YES-only ("price stays") setup we follow the positive
 * side and let the negative side act as a shut-off signal via its
 * effect on `P(stays)`.
 *
 * Why a conditioned baseline rather than the global unconditional one:
 * filters with high skip rates (e.g. "only fire when ROC is extreme")
 * were getting punished on the global comparison even when their
 * splits were genuinely informative — the snapshots they skip have
 * systematically different win rates, biasing the global reference.
 * The conditioned baseline strips that out: every filter is graded on
 * how well it sorts the population it acts on, not how that
 * population compares to the wider universe.
 *
 * "Comparable" = a bp bucket where BOTH halves clear the sample-count
 * floor at that distance. We require both because the baseline at the
 * bucket is built from both — a thin other-half feeds noise into the
 * comparison reference and we'd rather drop the bucket than score
 * against a soft baseline.
 */
export type SurvivalScore = {
  readonly score: number;
  /** Number of bp buckets where the half-vs-baseline comparison was valid. */
  readonly coverageBp: number;
  /**
   * Sample-weighted mean of the per-bucket pp deltas = `score /
   * coverageBp`. A rate that strips coverage out so two filters compare
   * on edge magnitude alone. `null` when `coverageBp === 0`.
   */
  readonly meanDeltaPp: number | null;
  /** Largest single-bucket positive delta. `null` when no comparable buckets. */
  readonly maxDeltaPp: number | null;
  /** Largest single-bucket negative delta (your "min punishment"). */
  readonly minDeltaPp: number | null;
  /**
   * Consistency of the per-bucket pp deltas: `meanDeltaPp /
   * stdevDeltaPp`. Higher absolute value = the edge holds up across
   * distances; near zero = the per-bucket deltas are noisy around the
   * mean and the headline score is unreliable. Sign matches
   * `meanDeltaPp`.
   *
   * Stdev is sample-weighted to match how the score itself is computed
   * (so a sparse-tail bucket can't blow up variance any more than it
   * blows up the mean). `null` when `coverageBp < 2` (a single bucket
   * has no spread).
   */
  readonly sharpe: number | null;
  /**
   * Information gain in nats per snapshot from using the half's bucket
   * win-rate as the predicted probability vs. using the conditioned
   * baseline's bucket win-rate. Positive = the half's predictions
   * carry more information than the baseline's; zero = no improvement;
   * negative shouldn't happen for the better-performing half but can
   * for the worse one (which is fine — its purpose is to signal we
   * should not act on it, or to act in the opposite direction).
   *
   * Per-bucket info gain is summed across buckets weighted by the
   * half's bucket count and divided by the half's total kept snapshots
   * (across counted buckets), so the units are "average nats saved per
   * snapshot." Typical magnitudes are small (`0.001` – `0.05`); render
   * as percentage of baseline log-loss for readability.
   *
   * Probabilities are clamped away from {0, 1} by a tiny epsilon to
   * keep `log(0)` out of the math. `null` when `coverageBp === 0`.
   */
  readonly logLossImprovementNats: number | null;
};

/**
 * The contiguous bp range where a filter does most of its work, plus
 * the prediction-quality numbers restricted to that range. See
 * `SurvivalFilterSummary.sweetSpot` for the full convention.
 */
export type SurvivalSweetSpot = {
  /** Inclusive lower bound of the bp range. */
  readonly startBp: number;
  /** Inclusive upper bound of the bp range. */
  readonly endBp: number;
  /**
   * Restricted-range calibration: average information gain in nats
   * per snapshot **inside the sweet-spot bp range**, vs the global
   * (no-filter) baseline. Compare directly to
   * `SurvivalFilterSummary.calibrationScore` (which uses the same
   * units but averages across the whole population). Typically
   * several × larger than the population-wide score, because the
   * sweet-spot population strips out the boring near-line and far-
   * tail buckets that dilute the headline.
   */
  readonly calibrationScore: number;
  /**
   * Fraction of the filter's `snapshotsTotal` that falls inside the
   * sweet-spot bp range AND was classified (not skipped). 0..1.
   * Multiply by 100 for a percentage. A high number here means the
   * sweet-spot restriction barely changes which snapshots we'd trade
   * on; a low number means restricting to the sweet spot would
   * meaningfully reduce trade volume.
   */
  readonly coverageFraction: number;
};

/**
 * Summary metrics for one filter against the baseline. Holds one
 * `SurvivalScore` per `(remaining-minutes, half)` cell so the dashboard
 * can compare every config of every filter on the same scale.
 *
 * Notably absent: any `bestImprovementBp` field. The score's sign +
 * magnitude carries the story; bp-delta phrasing was confusing.
 */
export type SurvivalFilterSummary = {
  readonly snapshotsTotal: number;
  readonly snapshotsTrue: number;
  readonly snapshotsFalse: number;
  readonly snapshotsSkipped: number;
  /** Share of classified snapshots in each half (true + false sum to 1). */
  readonly occurrenceTrue: number;
  readonly occurrenceFalse: number;
  /**
   * Headline filter-quality score: average information gain in nats
   * per snapshot in the **whole population** (skipped snapshots
   * contribute zero). Computed against the **global** survival
   * baseline (i.e. "no filter at all"), summed across every counted
   * `(remaining, half, distance)` cell, then divided by
   * `snapshotsTotal`.
   *
   * Why this is the dashboard's primary sort key:
   *   - Directly answers the production question "is using this
   *     filter better than using nothing?"
   *   - Auto-trades off coverage vs precision: a high-edge rare-fire
   *     filter (small numerator, big edge) and a small-edge always-
   *     fire filter (big numerator, small edge) get compared on the
   *     same axis.
   *   - Higher-fidelity-but-noisier filters (smaller per-bucket
   *     samples, e.g. heavily-conditioned compounds) get penalized
   *     automatically because their bucket-level rates predict their
   *     own outcomes worse than the parent's smoother rates would.
   *
   * Reference: baseline log-loss for ~50/50 binary outcomes is
   * ≈ 0.69 nats. So 0.005 ≈ 0.7% improvement over no-filter; 0.01 ≈
   * 1.4%; 0.05 ≈ 7%. Most filters land in the 0.0001–0.005 range; a
   * filter scoring above 0.005 is a serious candidate for live use.
   *
   * `0` for filters where every cell was below the sample floor.
   */
  readonly calibrationScore: number;
  /**
   * Per-`remaining-minutes` breakdown of `calibrationScore`: each
   * entry is the nats saved across that remaining's two halves vs the
   * global baseline, divided by the same `snapshotsTotal` used in the
   * headline. The four entries sum exactly to `calibrationScore`, so
   * the dashboard can render per-rem contribution badges that are
   * directly comparable on the same scale as the headline.
   */
  readonly calibrationScoreByRemaining: Readonly<
    Record<SurvivalRemainingMinutes, number>
  >;
  /**
   * The contiguous bp range where the filter does most of its work.
   * Computed as the **narrowest** `[startBp, endBp]` that captures
   * `SWEET_SPOT_INFO_GAIN_THRESHOLD` (default 80%) of the filter's
   * total positive info gain — a "smallest stretch of distances that
   * contains most of the hill" rule.
   *
   * Used by the dashboard for two things: a translucent overlay on the
   * per-bp lift chart so the operator can see the range visually, and
   * the restricted-range calibration number that tells you how good
   * predictions are *inside* the sweet spot vs. averaged across the
   * whole population (the headline `calibrationScore` is the latter).
   * For trading discipline: the sweet spot is the bp range where you
   * can trust the filter's `p` enough to act on it.
   *
   * `null` when the filter has no positive info gain anywhere — i.e.
   * a useless filter where no bp range carries signal.
   */
  readonly sweetSpot: SurvivalSweetSpot | null;
  /**
   * One score per `(remaining-minutes, half)` config. The detail view
   * renders these with all per-cell metrics — `meanDeltaPp`, `sharpe`,
   * `logLossImprovementNats` (vs the conditioned baseline), etc. —
   * for diagnosing *why* a filter scored the way it did at the
   * top-level `calibrationScore`. By construction the two halves at
   * a given remaining are sign-opposed.
   */
  readonly scoresByRemaining: Readonly<
    Record<
      SurvivalRemainingMinutes,
      {
        readonly true: SurvivalScore;
        readonly false: SurvivalScore;
      }
    >
  >;
};

/**
 * Helper alias for the renderer: the per-asset `SurvivalSurface` shape
 * that filter halves share with the baseline.
 */
export type SurvivalFilterSurface = SurvivalSurface;
