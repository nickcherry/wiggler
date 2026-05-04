import { formatDryRunEvent } from "@alea/lib/trading/dryRun/formatDryRunEvent";
import type { DryRunEvent } from "@alea/lib/trading/dryRun/types";
import { describe, expect, it } from "bun:test";

function stripAnsi(text: string): string {
  const ansiEscapePattern = new RegExp(
    `${String.fromCharCode(27)}\\[[0-9;]*m`,
    "g",
  );
  return text.replace(ansiEscapePattern, "");
}

describe("formatDryRunEvent", () => {
  it("formats info, warnings, and errors with an ISO time fragment", () => {
    const atMs = Date.parse("2026-05-04T12:34:56.789Z");

    expect(
      stripAnsi(
        formatDryRunEvent({ event: { kind: "info", atMs, message: "ready" } }),
      ),
    ).toBe("12:34:56 ready");
    expect(
      stripAnsi(
        formatDryRunEvent({ event: { kind: "warn", atMs, message: "slow" } }),
      ),
    ).toBe("12:34:56 slow");
    expect(
      stripAnsi(
        formatDryRunEvent({ event: { kind: "error", atMs, message: "boom" } }),
      ),
    ).toBe("12:34:56 boom");
  });

  it("formats trade decisions with asset precision, market bids, and edge", () => {
    const event: DryRunEvent = {
      kind: "decision",
      atMs: Date.parse("2026-05-04T12:34:56.789Z"),
      decision: {
        kind: "trade",
        samples: 250,
        snapshot: {
          asset: "doge",
          windowStartMs: 1_777_867_200_000,
          nowMs: 1_777_867_320_000,
          line: 0.18241,
          currentPrice: 0.183,
          distanceBp: 32,
          remaining: 3,
          ema50: 0.18123,
          regime: "up",
          currentSide: "up",
          aligned: true,
        },
        chosen: {
          side: "up",
          tokenId: "UP",
          bid: 0.61,
          ourProbability: 0.72,
          edge: 0.11,
        },
        other: {
          side: "down",
          tokenId: "DOWN",
          bid: 0.38,
          ourProbability: 0.28,
          edge: -0.1,
        },
      },
    };

    expect(stripAnsi(formatDryRunEvent({ event }))).toBe(
      "12:34:56 DOGE  [rem=3m] line=0.18241 px=0.18300 32bp↑ ema=0.18123 aligned ourP=0.720 mkt(up=0.61 down=0.38) → TAKE UP @0.61 edge=+0.110",
    );
  });

  it("formats skip decisions without a snapshot", () => {
    expect(
      stripAnsi(
        formatDryRunEvent({
          event: {
            kind: "decision",
            atMs: Date.parse("2026-05-04T12:34:56.789Z"),
            decision: {
              kind: "skip",
              reason: "warmup",
              snapshot: null,
              samples: null,
              up: null,
              down: null,
            },
          },
        }),
      ),
    ).toBe("12:34:56 WARMUP (no snapshot)");
  });
});
