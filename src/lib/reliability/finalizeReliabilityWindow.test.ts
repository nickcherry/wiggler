import { finalizeReliabilityWindow } from "@alea/lib/reliability/finalizeReliabilityWindow";
import {
  type ReliabilityAssetWindow,
  type ReliabilitySource,
  type ReliabilitySourceCell,
} from "@alea/lib/reliability/types";
import { describe, expect, it } from "bun:test";

const startMs = 1_777_902_600_000;
const endMs = startMs + 300_000;

describe("finalizeReliabilityWindow", () => {
  it("computes outcomes and agreement against polymarket", () => {
    const finalized = finalizeReliabilityWindow({
      window: windowFixture({
        sources: {
          "polymarket-chainlink": cell({
            source: "polymarket-chainlink",
            start: 100,
            end: 101,
          }),
          "coinbase-spot": cell({
            source: "coinbase-spot",
            start: 200,
            end: 202,
          }),
          "coinbase-perp": cell({
            source: "coinbase-perp",
            start: 200,
            end: 199,
          }),
          "binance-spot": cell({
            source: "binance-spot",
            start: 300,
            end: 300,
          }),
          "binance-perp": cell({
            source: "binance-perp",
            start: 300,
            end: 299,
          }),
        },
      }),
      finalizedAtMs: endMs + 10_000,
      graceMs: 10_000,
    });

    expect(finalized.sources["polymarket-chainlink"].outcome).toBe("up");
    expect(finalized.sources["coinbase-spot"].agreesWithPolymarket).toBe(true);
    expect(finalized.sources["coinbase-perp"].agreesWithPolymarket).toBe(false);
    expect(finalized.sources["binance-spot"].outcome).toBe("up");
    expect(finalized.sources["binance-spot"].agreesWithPolymarket).toBe(true);
    expect(finalized.sources["binance-perp"].agreesWithPolymarket).toBe(false);
  });

  it("marks missing and stale cells unavailable for agreement", () => {
    const finalized = finalizeReliabilityWindow({
      window: windowFixture({
        sources: {
          "polymarket-chainlink": cell({
            source: "polymarket-chainlink",
            start: 100,
            end: 101,
          }),
          "coinbase-spot": missingEnd({ source: "coinbase-spot" }),
          "coinbase-perp": cell({
            source: "coinbase-perp",
            start: 100,
            end: 101,
            startLagMs: 10_001,
          }),
          "binance-spot": missingStart({ source: "binance-spot" }),
          "binance-perp": cell({
            source: "binance-perp",
            start: 100,
            end: 101,
            endLagMs: 10_001,
          }),
        },
      }),
      finalizedAtMs: endMs + 10_000,
      graceMs: 10_000,
    });

    expect(finalized.sources["coinbase-spot"].status).toBe("missing-end");
    expect(finalized.sources["coinbase-perp"].status).toBe("stale-start");
    expect(finalized.sources["binance-spot"].status).toBe("missing-start");
    expect(finalized.sources["binance-perp"].status).toBe("stale-end");
    expect(finalized.sources["coinbase-spot"].agreesWithPolymarket).toBeNull();
    expect(finalized.sources["coinbase-perp"].agreesWithPolymarket).toBeNull();
  });

  it("marks every source no-market when the polymarket market is unavailable", () => {
    const finalized = finalizeReliabilityWindow({
      window: {
        ...windowFixture({ sources: completeCells() }),
        marketStatus: "missing",
      },
      finalizedAtMs: endMs + 10_000,
      graceMs: 10_000,
    });

    expect(finalized.sources["polymarket-chainlink"].status).toBe("no-market");
    expect(finalized.sources["coinbase-spot"].status).toBe("no-market");
    expect(finalized.sources["coinbase-spot"].outcome).toBeNull();
  });
});

function windowFixture({
  sources,
}: {
  readonly sources: Record<ReliabilitySource, ReliabilitySourceCell>;
}): ReliabilityAssetWindow {
  return {
    asset: "btc",
    status: "active",
    windowStartMs: startMs,
    windowEndMs: endMs,
    marketSlug: "btc-updown-5m-1777902600",
    conditionId: "0xabc",
    marketStatus: "active",
    marketError: null,
    finalizedAtMs: null,
    sources,
  };
}

function completeCells(): Record<ReliabilitySource, ReliabilitySourceCell> {
  return {
    "polymarket-chainlink": cell({
      source: "polymarket-chainlink",
      start: 100,
      end: 101,
    }),
    "coinbase-spot": cell({ source: "coinbase-spot", start: 100, end: 101 }),
    "coinbase-perp": cell({ source: "coinbase-perp", start: 100, end: 101 }),
    "binance-spot": cell({ source: "binance-spot", start: 100, end: 101 }),
    "binance-perp": cell({ source: "binance-perp", start: 100, end: 101 }),
  };
}

function cell({
  source,
  start,
  end,
  startLagMs = 3,
  endLagMs = 4,
}: {
  readonly source: ReliabilitySource;
  readonly start: number;
  readonly end: number;
  readonly startLagMs?: number;
  readonly endLagMs?: number;
}): ReliabilitySourceCell {
  return {
    source,
    status: "pending",
    startPrice: start,
    startAtMs: startMs + startLagMs,
    startLagMs,
    endPrice: end,
    endAtMs: endMs + endLagMs,
    endLagMs,
    deltaBp: null,
    outcome: null,
    agreesWithPolymarket: null,
  };
}

function missingEnd({
  source,
}: {
  readonly source: ReliabilitySource;
}): ReliabilitySourceCell {
  return {
    ...cell({ source, start: 100, end: 101 }),
    endPrice: null,
    endAtMs: null,
    endLagMs: null,
  };
}

function missingStart({
  source,
}: {
  readonly source: ReliabilitySource;
}): ReliabilitySourceCell {
  return {
    ...cell({ source, start: 100, end: 101 }),
    startPrice: null,
    startAtMs: null,
    startLagMs: null,
  };
}
