import type {
  SurvivalSnapshot,
  SurvivalSnapshotContext,
} from "@alea/lib/training/computeSurvivalSnapshots";
import type {
  SurvivalSurface,
  SurvivalSurfaceWithCount,
} from "@alea/lib/training/types";

/**
 * Result of classifying a single snapshot into one half of a binary
 * filter:
 *
 *   - `true`/`false` — snapshot belongs to that side of the split
 *   - `"skip"` — snapshot lacks the lookback context this filter needs
 *     (e.g. very early in the series). Skipped snapshots count toward
 *     `snapshotsSkipped` in the filter summary but never toward either
 *     side, so coverage stays honest.
 */
export type SurvivalFilterDecision = boolean | "skip";

/**
 * A binary context filter on the survival surface. The framework runs one
 * pass over the snapshot stream, calls `classify` per snapshot, and
 * accumulates separate buckets for the `true` and `false` halves. The
 * resulting `SurvivalFilterResult` is rendered as one section of the
 * dashboard with the same chart + table treatment as the baseline.
 *
 * Adding a new filter is: implement this interface, register it.
 */
export type SurvivalFilter = {
  readonly id: string;
  readonly displayName: string;
  readonly description: string;
  readonly trueLabel: string;
  readonly falseLabel: string;
  readonly classify: (
    snapshot: SurvivalSnapshot,
    context: SurvivalSnapshotContext,
  ) => SurvivalFilterDecision;
};

/**
 * Per-filter rolled-up result. The baseline surface is duplicated into
 * each result so the renderer can build delta cells without maintaining
 * its own join from `(asset, filter)` back to the baseline.
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
 * Summary fields for a filter, designed to feed both the per-section
 * verdict header and (later) a global ranking. Everything except the
 * `score`/`verdict` pair is concrete and populated for v1; those two are
 * `null` until a rubric is specified, and the UI omits them when null.
 */
export type SurvivalFilterSummary = {
  /** Total snapshots the filter saw (true + false + skipped). */
  readonly snapshotsTotal: number;
  /** Snapshots classified as belonging to the `true` half. */
  readonly snapshotsTrue: number;
  /** Snapshots classified as belonging to the `false` half. */
  readonly snapshotsFalse: number;
  /** Snapshots the filter declined to classify (missing lookback, etc.). */
  readonly snapshotsSkipped: number;
  /**
   * Share of *classified* snapshots (true + false, ignoring skipped) that
   * landed in the `true` half. A filter that fires on, say, 12% of
   * windows tells you whether the improvement it shows is rare-event or
   * everyday signal.
   */
  readonly occurrenceTrue: number;
  /** Share of classified snapshots in the `false` half. */
  readonly occurrenceFalse: number;
  /**
   * Best (most negative) bp delta between the `true` half and baseline
   * across all `(remainingMinutes, target win rate)` cells where both
   * sides have a value above the sample-count floor. Negative = the
   * filter reaches the target with less distance than baseline (good).
   * `null` when no comparable cell exists.
   */
  readonly bestImprovementBpTrue: number | null;
  /** Same as above for the `false` half. */
  readonly bestImprovementBpFalse: number | null;
  /**
   * Reserved for a later rubric. Higher = more useful.
   */
  readonly score: number | null;
  /**
   * Reserved for a later rubric. Categorical readout.
   */
  readonly verdict: "strong" | "promising" | "neutral" | "weak" | "thin" | null;
};

/**
 * Helper alias for the renderer: the per-asset `SurvivalSurface` shape
 * that filter halves share with the baseline.
 */
export type SurvivalFilterSurface = SurvivalSurface;
