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
 * Per-`(remaining-minutes, half)` score against the baseline. The score
 * is the **signed area between the half's win-rate line and the baseline
 * line**, integrated over distance:
 *
 *     score = Σ over comparable bp buckets of (halfWinRate − baselineWinRate)
 *
 * Units are pp·bp (percentage-points × basis-points), but we render it
 * as a dimensionless number — relative magnitude is what matters for
 * ranking.
 *
 * Convention: **positive = filter half beats baseline** (higher
 * survival probability than the unconditional curve). A filter that
 * improves confidence at most distances accumulates a big positive
 * area; one that's flat-vs-baseline averages near zero; one that
 * underperforms accumulates negative area. Both signs are tradeable —
 * positive scores are "do-trade" signals, negative are "avoid-trade".
 *
 * "Comparable" = a bp bucket where BOTH the half and the baseline clear
 * the sample-count floor at that distance. We never compare against a
 * missing reference point.
 */
export type SurvivalScore = {
  readonly score: number;
  /** Number of bp buckets where the half-vs-baseline comparison was valid. */
  readonly coverageBp: number;
  /**
   * Mean per-bucket delta = `score / coverageBp`. A rate that strips
   * coverage out so two filters compare on edge magnitude alone.
   * `null` when `coverageBp === 0`.
   */
  readonly meanDeltaPp: number | null;
  /** Largest single-bucket positive delta. `null` when no comparable buckets. */
  readonly maxDeltaPp: number | null;
  /** Largest single-bucket negative delta (your "min punishment"). */
  readonly minDeltaPp: number | null;
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
   * One score per `(remaining-minutes, half)` config. Renderer uses
   * this to badge each tab, sort tabs by `|score|`, default to the
   * largest-`|score|` tab, and mark the asset-wide best (most positive)
   * + worst (most negative) configs across all filters.
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
