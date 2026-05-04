import { computeReliabilitySummary } from "@alea/lib/reliability/computeReliabilitySummary";
import { finalizeReliabilityWindow } from "@alea/lib/reliability/finalizeReliabilityWindow";
import { renderReliabilityHtml } from "@alea/lib/reliability/renderReliabilityHtml";
import {
  RELIABILITY_SCHEMA_VERSION,
  type ReliabilityAssetWindow,
  type ReliabilityCapturePayload,
  type ReliabilitySource,
  type ReliabilitySourceCell,
  reliabilitySourceValues,
} from "@alea/lib/reliability/types";
import { describe, expect, it } from "bun:test";

const startMs = 1_777_902_600_000;
const endMs = startMs + 300_000;

describe("renderReliabilityHtml", () => {
  it("renders the shared Alea shell and mismatch rows", () => {
    const completed = finalizeReliabilityWindow({
      window: windowFixture(),
      finalizedAtMs: endMs + 10_000,
      graceMs: 10_000,
    });
    const payload = payloadFixture({ completedWindows: [completed] });
    const html = renderReliabilityHtml({ payload });

    expect(html).toContain("Directional Agreement");
    expect(html).toContain("--alea-bg");
    expect(html).toContain("coinbase-spot");
    expect(html).toContain("DIFF");
    expect(html).toContain("ledger-row diff");
    expect(html).toContain("ledger-price-cell");
  });

  it("labels near-zero baseline windows without coloring the asset cell", () => {
    const window = windowFixture();
    window.sources["polymarket-chainlink"] = cell({
      source: "polymarket-chainlink",
      start: 100,
      end: 100.005,
    });
    const completed = finalizeReliabilityWindow({
      window,
      finalizedAtMs: endMs + 10_000,
      graceMs: 10_000,
    });
    const payload = payloadFixture({ completedWindows: [completed] });
    const html = renderReliabilityHtml({ payload });

    expect(html).not.toContain("Near-zero cutoff");
    expect(html).toContain("near-zero");
    expect(html).toContain("near 0");
  });
});

function payloadFixture({
  completedWindows,
}: {
  readonly completedWindows: readonly ReliabilityAssetWindow[];
}): ReliabilityCapturePayload {
  return {
    schemaVersion: RELIABILITY_SCHEMA_VERSION,
    startedAtMs: startMs,
    updatedAtMs: endMs,
    requestedDurationMs: 300_000,
    captureStartWindowMs: startMs,
    captureEndMs: endMs,
    graceMs: 10_000,
    nearZeroThresholdBp: 1,
    assets: ["btc"],
    sources: [...reliabilitySourceValues],
    baselineSource: "polymarket-chainlink",
    activeWindows: [],
    completedWindows: [...completedWindows],
    sourceHealth: reliabilitySourceValues.map((source) => ({
      source,
      connected: false,
      connectCount: 1,
      disconnectCount: 0,
      errorCount: 0,
      ticks: 10,
      lastTickAtMs: endMs,
      lastError: null,
    })),
    errors: [],
    summary: computeReliabilitySummary({
      completedWindows,
      nearZeroThresholdBp: 1,
    }),
  };
}

function windowFixture(): ReliabilityAssetWindow {
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
    sources: {
      "polymarket-chainlink": cell({
        source: "polymarket-chainlink",
        start: 100,
        end: 101,
      }),
      "coinbase-spot": cell({ source: "coinbase-spot", start: 200, end: 199 }),
      "coinbase-perp": cell({ source: "coinbase-perp", start: 200, end: 202 }),
      "binance-spot": cell({ source: "binance-spot", start: 300, end: 303 }),
      "binance-perp": cell({ source: "binance-perp", start: 300, end: 304 }),
    },
  };
}

function cell({
  source,
  start,
  end,
}: {
  readonly source: ReliabilitySource;
  readonly start: number;
  readonly end: number;
}): ReliabilitySourceCell {
  return {
    source,
    status: "pending",
    startPrice: start,
    startAtMs: startMs + 1,
    startLagMs: 1,
    endPrice: end,
    endAtMs: endMs + 2,
    endLagMs: 2,
    deltaBp: null,
    outcome: null,
    agreesWithPolymarket: null,
  };
}
