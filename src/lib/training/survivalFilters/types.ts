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
 * Summary metrics for one filter against the baseline. Designed to feed
 * both the per-section header line and (later) a global filter ranking.
 *
 * All bp-delta fields use the convention "negative = good": a more
 * negative number means the filter reaches the same win-rate target
 * with less distance from the line, which is exactly the
 * point-of-no-return signal we trade on.
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
   * Best (most negative) bp delta between the `true` half and baseline
   * across all `(remainingMinutes, target win rate)` cells where both
   * sides clear the sample-count floor. `null` when no comparable cell
   * exists.
   */
  readonly bestImprovementBpTrue: number | null;
  /** Same as above for the `false` half. */
  readonly bestImprovementBpFalse: number | null;
  /**
   * Per-remaining-minutes best improvement for each side. The renderer
   * uses these to label the time-bucket tabs and to pick which tab to
   * default to (the bucket whose `min(true, false)` is most negative).
   */
  readonly bestImprovementByRemaining: Readonly<
    Record<
      SurvivalRemainingMinutes,
      {
        readonly trueBp: number | null;
        readonly falseBp: number | null;
      }
    >
  >;
  /** Reserved for a later rubric. Higher = more useful. */
  readonly score: number | null;
  /** Reserved for a later rubric. Categorical readout. */
  readonly verdict: "strong" | "promising" | "neutral" | "weak" | "thin" | null;
};

/**
 * Helper alias for the renderer: the per-asset `SurvivalSurface` shape
 * that filter halves share with the baseline.
 */
export type SurvivalFilterSurface = SurvivalSurface;
