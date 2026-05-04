import { evaluateDecision } from "@alea/lib/trading/decision/evaluateDecision";
import type { ProbabilityTable } from "@alea/lib/trading/types";
import { describe, expect, it } from "bun:test";

const WINDOW_START = Date.UTC(2026, 0, 1, 0, 0, 0);
const ONE_MINUTE = 60_000;

const table: ProbabilityTable = {
  command: "trading:gen-probability-table",
  schemaVersion: 1,
  generatedAtMs: 0,
  series: { source: "binance", product: "perp", timeframe: "5m" },
  minBucketSamples: 200,
  trainingRangeMs: { firstWindowMs: 0, lastWindowMs: 0 },
  assets: [
    {
      asset: "btc",
      windowCount: 1000,
      alignedWindowShare: 0.7,
      aligned: {
        byRemaining: {
          1: [],
          2: [],
          3: [
            { distanceBp: 5, samples: 800, probability: 0.85 },
            { distanceBp: 10, samples: 500, probability: 0.92 },
          ],
          4: [],
        },
      },
      notAligned: {
        byRemaining: {
          1: [],
          2: [],
          3: [{ distanceBp: 5, samples: 600, probability: 0.6 }],
          4: [],
        },
      },
      sweetSpot: {
        startBp: 0,
        endBp: 100,
        calibrationScore: 0.01,
        coverageFraction: 0.5,
      },
    },
  ],
};

const baseInputs = {
  asset: "btc" as const,
  windowStartMs: WINDOW_START,
  nowMs: WINDOW_START + 2 * ONE_MINUTE, // [+2m, +3m) → remaining = 3
  line: 100,
  currentPrice: 100.05, // distance = 0.05, distanceBp = 5
  ema50: 99, // diagnostic only; aligned no longer keys off EMA
  // distance_from_line_atr classification: aligned iff
  // |distance| >= 0.5 × atr. Here 0.05 >= 0.5 × 0.04 = 0.02 → aligned = true.
  atr: 0.04,
  upBestBid: 0.6,
  downBestBid: 0.1,
  upTokenId: "TOKEN_UP",
  downTokenId: "TOKEN_DOWN",
  table,
  minEdge: 0.05,
};

describe("evaluateDecision", () => {
  it("trades the higher-edge side when both edges clear minEdge", () => {
    const decision = evaluateDecision(baseInputs);
    expect(decision.kind).toBe("trade");
    if (decision.kind !== "trade") {
      return;
    }
    expect(decision.snapshot.distanceBp).toBe(5);
    expect(decision.snapshot.remaining).toBe(3);
    expect(decision.snapshot.aligned).toBe(true);
    expect(decision.chosen.side).toBe("up");
    expect(decision.chosen.bid).toBe(0.6);
    expect(decision.chosen.edge).toBeCloseTo(0.85 - 0.6, 9);
    expect(decision.other.side).toBe("down");
    expect(decision.other.edge).toBeCloseTo(1 - 0.85 - 0.1, 9);
  });

  it("returns warmup before the ATR tracker is seeded", () => {
    const decision = evaluateDecision({ ...baseInputs, atr: null });
    expect(decision.kind).toBe("skip");
    if (decision.kind === "skip") {
      expect(decision.reason).toBe("warmup");
      expect(decision.snapshot).toBeNull();
    }
  });

  it("returns out-of-window past +5m", () => {
    const decision = evaluateDecision({
      ...baseInputs,
      nowMs: WINDOW_START + 5 * ONE_MINUTE,
    });
    expect(decision.kind).toBe("skip");
    if (decision.kind === "skip") {
      expect(decision.reason).toBe("out-of-window");
    }
  });

  it("returns out-of-window during the pre-snapshot first minute", () => {
    const decision = evaluateDecision({
      ...baseInputs,
      nowMs: WINDOW_START + 30_000, // [+0m, +1m) → no snapshot yet
    });
    expect(decision.kind).toBe("skip");
    if (decision.kind === "skip") {
      expect(decision.reason).toBe("out-of-window");
    }
  });

  it("returns no-bucket when distance is past the table tail", () => {
    const decision = evaluateDecision({
      ...baseInputs,
      currentPrice: 100.5, // distanceBp = 50, no entry at remaining=3
    });
    expect(decision.kind).toBe("skip");
    if (decision.kind === "skip") {
      expect(decision.reason).toBe("no-bucket");
      expect(decision.snapshot?.distanceBp).toBe(50);
    }
  });

  it("returns no-bid when both YES tokens have empty bid sides", () => {
    const decision = evaluateDecision({
      ...baseInputs,
      upBestBid: null,
      downBestBid: null,
    });
    expect(decision.kind).toBe("skip");
    if (decision.kind === "skip") {
      expect(decision.reason).toBe("no-bid");
      expect(decision.up?.bid).toBeNull();
    }
  });

  it("returns thin-edge when neither side clears minEdge", () => {
    const decision = evaluateDecision({
      ...baseInputs,
      upBestBid: 0.84, // edge = 0.01
      downBestBid: 0.14, // edge = 0.01
    });
    expect(decision.kind).toBe("skip");
    if (decision.kind === "skip") {
      expect(decision.reason).toBe("thin-edge");
      expect(decision.up?.edge).toBeCloseTo(0.01, 9);
      expect(decision.down?.edge).toBeCloseTo(0.01, 9);
    }
  });

  it("flips aligned to false when distance < 0.5 × ATR", () => {
    const decision = evaluateDecision({
      ...baseInputs,
      // distance = 0.05; 0.5 × atr = 0.5 × 0.3 = 0.15 → 0.05 < 0.15 → not aligned.
      atr: 0.3,
    });
    // notAligned table at remaining=3, distance=5 → P(currentSide=up wins) = 0.6.
    // currentSide=up so ourP_up = 0.6, ourP_down = 0.4.
    // edge_up = 0.6 - 0.6 = 0 (below minEdge);
    // edge_down = 0.4 - 0.1 = 0.3 (above minEdge) → trade DOWN.
    expect(decision.kind).toBe("trade");
    if (decision.kind !== "trade") {
      return;
    }
    expect(decision.snapshot.aligned).toBe(false);
    expect(decision.chosen.side).toBe("down");
    expect(decision.chosen.edge).toBeCloseTo(0.3, 9);
    expect(decision.other.side).toBe("up");
    expect(decision.other.edge).toBeCloseTo(0.0, 9);
  });
});
