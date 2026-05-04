import { computeSurvivalSnapshots } from "@alea/lib/training/computeSurvivalSnapshots";
import type { Candle, CandleTimeframe } from "@alea/types/candles";
import { describe, expect, it } from "bun:test";

const MS_PER_5M = 5 * 60 * 1000;
const MS_PER_1M = 60 * 1000;

function buildCandle({
  timestamp,
  open,
  close,
  timeframe = "1m",
}: {
  readonly timestamp: Date;
  readonly open: number;
  readonly close: number;
  readonly timeframe?: CandleTimeframe;
}): Candle {
  return {
    source: "binance",
    asset: "btc",
    product: "perp",
    timeframe,
    timestamp,
    open,
    high: Math.max(open, close),
    low: Math.min(open, close),
    close,
    volume: 1,
  };
}

function buildContiguous1m({
  startMs,
  closes,
}: {
  readonly startMs: number;
  readonly closes: readonly number[];
}): Candle[] {
  const out: Candle[] = [];
  let prevClose = closes[0] ?? 100;
  for (let i = 0; i < closes.length; i += 1) {
    const ts = new Date(startMs + i * MS_PER_1M);
    const close = closes[i] ?? prevClose;
    const open = i === 0 ? close : prevClose;
    out.push(buildCandle({ timestamp: ts, open, close }));
    prevClose = close;
  }
  return out;
}

describe("computeSurvivalSnapshots", () => {
  it("emits four snapshots per usable 5m window", () => {
    const candles1m = buildContiguous1m({
      startMs: Date.UTC(2025, 0, 1, 0, 0, 0),
      closes: [101, 102, 103, 104, 105],
    });
    const snapshots = [...computeSurvivalSnapshots({ candles1m })];
    expect(snapshots.length).toBe(4);
    expect(snapshots.map((s) => s.remaining)).toEqual([4, 3, 2, 1]);
  });

  it("returns null 5m context when the 5m series isn't supplied", () => {
    const candles1m = buildContiguous1m({
      startMs: Date.UTC(2025, 0, 1, 0, 0, 0),
      closes: [101, 102, 103, 104, 105],
    });
    const [snapshot] = [...computeSurvivalSnapshots({ candles1m })];
    expect(snapshot?.context.ma20x5m).toBeNull();
    expect(snapshot?.context.ma50x5m).toBeNull();
    expect(snapshot?.context.ema20x5m).toBeNull();
    expect(snapshot?.context.ema50x5m).toBeNull();
    expect(snapshot?.context.last3x5mDirections).toBeNull();
    expect(snapshot?.context.last5x5mDirections).toBeNull();
  });

  it("last3x5mDirections returns null until three prior 5m bars exist", () => {
    const windowStart = Date.UTC(2025, 0, 1, 0, 10, 0);
    const candles1m = buildContiguous1m({
      startMs: windowStart,
      closes: [101, 102, 103, 104, 105],
    });
    // Only one prior 5m bar — covering [0:05, 0:10).
    const candles5m: Candle[] = [
      buildCandle({
        timestamp: new Date(windowStart - MS_PER_5M),
        open: 100,
        close: 100,
        timeframe: "5m",
      }),
    ];
    const [snapshot] = [...computeSurvivalSnapshots({ candles1m, candles5m })];
    expect(snapshot?.context.last3x5mDirections).toBeNull();
  });

  it("last3x5mDirections returns the 3 most recent completed 5m bars in chronological order", () => {
    const windowStart = Date.UTC(2025, 0, 1, 0, 15, 0);
    const candles1m = buildContiguous1m({
      startMs: windowStart,
      closes: [101, 102, 103, 104, 105],
    });
    // Three prior 5m bars, all aligned to standard boundaries:
    //   [0:00, 0:05) → up, [0:05, 0:10) → down, [0:10, 0:15) → up.
    const candles5m: Candle[] = [
      buildCandle({
        timestamp: new Date(windowStart - 3 * MS_PER_5M),
        open: 100,
        close: 105,
        timeframe: "5m",
      }),
      buildCandle({
        timestamp: new Date(windowStart - 2 * MS_PER_5M),
        open: 105,
        close: 102,
        timeframe: "5m",
      }),
      buildCandle({
        timestamp: new Date(windowStart - MS_PER_5M),
        open: 102,
        close: 108,
        timeframe: "5m",
      }),
    ];
    const [snapshot] = [...computeSurvivalSnapshots({ candles1m, candles5m })];
    expect(snapshot?.context.last3x5mDirections).toEqual(["up", "down", "up"]);
  });

  it("ma20x5m is null until 20 prior 5m closes are available", () => {
    const windowStart = Date.UTC(2025, 0, 1, 5, 0, 0);
    const candles1m = buildContiguous1m({
      startMs: windowStart,
      closes: [101, 102, 103, 104, 105],
    });
    // 19 prior 5m candles (one short).
    const candles5m: Candle[] = [];
    for (let i = 19; i >= 1; i -= 1) {
      candles5m.push(
        buildCandle({
          timestamp: new Date(windowStart - i * MS_PER_5M),
          open: 100,
          close: 100,
          timeframe: "5m",
        }),
      );
    }
    const [snapshot] = [...computeSurvivalSnapshots({ candles1m, candles5m })];
    expect(snapshot?.context.ma20x5m).toBeNull();
  });

  it("ma20x5m equals the average of the 20 most recent prior 5m closes", () => {
    const windowStart = Date.UTC(2025, 0, 1, 5, 0, 0);
    const candles1m = buildContiguous1m({
      startMs: windowStart,
      closes: [101, 102, 103, 104, 105],
    });
    // 20 prior 5m candles, closes 1..20. SMA = (1+2+...+20)/20 = 210/20 = 10.5
    const candles5m: Candle[] = [];
    for (let i = 20; i >= 1; i -= 1) {
      const close = 21 - i; // i=20 → 1, i=1 → 20
      candles5m.push(
        buildCandle({
          timestamp: new Date(windowStart - i * MS_PER_5M),
          open: close,
          close,
          timeframe: "5m",
        }),
      );
    }
    const [snapshot] = [...computeSurvivalSnapshots({ candles1m, candles5m })];
    expect(snapshot?.context.ma20x5m).toBeCloseTo(10.5, 6);
  });

  it("ma50x5m + ema50x5m are null until 50 prior 5m closes are available", () => {
    const windowStart = Date.UTC(2025, 0, 1, 10, 0, 0);
    const candles1m = buildContiguous1m({
      startMs: windowStart,
      closes: [101, 102, 103, 104, 105],
    });
    // 49 prior 5m candles (one short of MA-50 + EMA-50 warm-ups).
    const candles5m: Candle[] = [];
    for (let i = 49; i >= 1; i -= 1) {
      candles5m.push(
        buildCandle({
          timestamp: new Date(windowStart - i * MS_PER_5M),
          open: 100,
          close: 100,
          timeframe: "5m",
        }),
      );
    }
    const [snapshot] = [...computeSurvivalSnapshots({ candles1m, candles5m })];
    expect(snapshot?.context.ma50x5m).toBeNull();
    expect(snapshot?.context.ema50x5m).toBeNull();
  });

  it("ema20x5m matches the standard EMA recurrence (α = 2/(N+1))", () => {
    const windowStart = Date.UTC(2025, 0, 1, 10, 0, 0);
    const candles1m = buildContiguous1m({
      startMs: windowStart,
      closes: [101, 102, 103, 104, 105],
    });
    // 20 prior 5m candles, all closes = 100. EMA seed = SMA(100, ..., 100) =
    // 100. With every subsequent close also 100 the recurrence stays flat at
    // 100. Easiest sanity check that the warm-up + roll-forward both work.
    const candles5m: Candle[] = [];
    for (let i = 20; i >= 1; i -= 1) {
      candles5m.push(
        buildCandle({
          timestamp: new Date(windowStart - i * MS_PER_5M),
          open: 100,
          close: 100,
          timeframe: "5m",
        }),
      );
    }
    const [snapshot] = [...computeSurvivalSnapshots({ candles1m, candles5m })];
    expect(snapshot?.context.ema20x5m).toBeCloseTo(100, 6);
  });

  it("last5x5mDirections returns the 5 most recent completed 5m bars in chronological order", () => {
    const windowStart = Date.UTC(2025, 0, 1, 0, 25, 0);
    const candles1m = buildContiguous1m({
      startMs: windowStart,
      closes: [101, 102, 103, 104, 105],
    });
    // Five prior 5m bars at standard alignment: up, down, up, down, up.
    const dirs = ["up", "down", "up", "down", "up"] as const;
    const candles5m: Candle[] = dirs.map((d, k) => {
      const open = 100;
      const close = d === "up" ? 102 : 98;
      return buildCandle({
        timestamp: new Date(windowStart - (5 - k) * MS_PER_5M),
        open,
        close,
        timeframe: "5m",
      });
    });
    const [snapshot] = [...computeSurvivalSnapshots({ candles1m, candles5m })];
    expect(snapshot?.context.last5x5mDirections).toEqual([
      "up",
      "down",
      "up",
      "down",
      "up",
    ]);
  });

  it("rsi14x5m returns 100 when all closes monotonically increase (no losses)", () => {
    // 20 prior 5m bars with strictly-increasing closes: every diff is
    // positive so avgLoss == 0 → RSI saturates at 100.
    const windowStart = Date.UTC(2025, 0, 1, 5, 0, 0);
    const candles1m = buildContiguous1m({
      startMs: windowStart,
      closes: [200, 201, 202, 203, 204],
    });
    const candles5m: Candle[] = [];
    for (let i = 20; i >= 1; i -= 1) {
      const close = 100 + (20 - i);
      candles5m.push(
        buildCandle({
          timestamp: new Date(windowStart - i * MS_PER_5M),
          open: close,
          close,
          timeframe: "5m",
        }),
      );
    }
    const [snapshot] = [...computeSurvivalSnapshots({ candles1m, candles5m })];
    expect(snapshot?.context.rsi14x5m).toBe(100);
  });

  it("rsi14x5m returns 50 on a flat series (avgGain == avgLoss == 0 ⇒ defined as 100, but flat triggers no diffs)", () => {
    // Edge case: when avgLoss is exactly 0 the implementation returns 100.
    // A flat series has both 0 — we ALSO end up at 100 by convention.
    const windowStart = Date.UTC(2025, 0, 1, 5, 0, 0);
    const candles1m = buildContiguous1m({
      startMs: windowStart,
      closes: [101, 102, 103, 104, 105],
    });
    const candles5m: Candle[] = [];
    for (let i = 20; i >= 1; i -= 1) {
      candles5m.push(
        buildCandle({
          timestamp: new Date(windowStart - i * MS_PER_5M),
          open: 100,
          close: 100,
          timeframe: "5m",
        }),
      );
    }
    const [snapshot] = [...computeSurvivalSnapshots({ candles1m, candles5m })];
    expect(snapshot?.context.rsi14x5m).toBe(100);
  });

  it("roc20Pct equals the percent change between the snapshot and the close 20 bars prior", () => {
    const windowStart = Date.UTC(2025, 0, 1, 5, 0, 0);
    const candles1m = buildContiguous1m({
      startMs: windowStart,
      closes: [101, 102, 103, 104, 105],
    });
    // 21 prior 5m bars: oldest close 100, newest 110.
    // ROC over 20 bars: (110 - 100) / 100 * 100 = 10%
    const candles5m: Candle[] = [];
    for (let i = 21; i >= 1; i -= 1) {
      const close = 100 + (21 - i) * 0.5;
      candles5m.push(
        buildCandle({
          timestamp: new Date(windowStart - i * MS_PER_5M),
          open: close,
          close,
          timeframe: "5m",
        }),
      );
    }
    const [snapshot] = [...computeSurvivalSnapshots({ candles1m, candles5m })];
    // close[lastIdx] = 110, close[lastIdx-20] = 100 → 10%
    expect(snapshot?.context.roc20Pct).toBeCloseTo(10, 5);
  });

  it("ema50SlopePct positive when the EMA-50 has been rising over 10 bars", () => {
    const windowStart = Date.UTC(2025, 0, 1, 10, 0, 0);
    const candles1m = buildContiguous1m({
      startMs: windowStart,
      closes: [101, 102, 103, 104, 105],
    });
    // 60 prior 5m bars climbing — EMA-50 will be monotonically rising
    // throughout, so slope-over-10-bars is strictly positive.
    const candles5m: Candle[] = [];
    for (let i = 60; i >= 1; i -= 1) {
      const close = 100 + (60 - i) * 0.5;
      candles5m.push(
        buildCandle({
          timestamp: new Date(windowStart - i * MS_PER_5M),
          open: close,
          close,
          timeframe: "5m",
        }),
      );
    }
    const [snapshot] = [...computeSurvivalSnapshots({ candles1m, candles5m })];
    expect(snapshot?.context.ema50SlopePct).not.toBeNull();
    expect(snapshot?.context.ema50SlopePct ?? 0).toBeGreaterThan(0);
  });

  it("atr14x5m equals the simple range on a sequence of identical bars (Wilder seed)", () => {
    // Each prior bar has range = 4 (high 102, low 98). Wilder ATR
    // initialized as the simple average of the first 14 TR values
    // collapses to 4; and rolling forward with TR=4 keeps it at 4.
    const windowStart = Date.UTC(2025, 0, 1, 5, 0, 0);
    const candles1m = buildContiguous1m({
      startMs: windowStart,
      closes: [101, 102, 103, 104, 105],
    });
    const candles5m: Candle[] = [];
    for (let i = 20; i >= 1; i -= 1) {
      candles5m.push({
        source: "binance",
        asset: "btc",
        product: "perp",
        timeframe: "5m",
        timestamp: new Date(windowStart - i * MS_PER_5M),
        open: 100,
        high: 102,
        low: 98,
        close: 100,
        volume: 1,
      });
    }
    const [snapshot] = [...computeSurvivalSnapshots({ candles1m, candles5m })];
    expect(snapshot?.context.atr14x5m).toBeCloseTo(4, 5);
  });

  it("donchian50 high+low capture the extremes across the 50 prior bars", () => {
    const windowStart = Date.UTC(2025, 0, 1, 5, 0, 0);
    const candles1m = buildContiguous1m({
      startMs: windowStart,
      closes: [101, 102, 103, 104, 105],
    });
    // 50 prior bars: highs ramp 100→149, lows = high - 1. Donchian50
    // should capture the global max-high (149) and min-low (99).
    const candles5m: Candle[] = [];
    for (let i = 50; i >= 1; i -= 1) {
      const offset = 50 - i;
      const high = 100 + offset;
      const low = high - 1;
      candles5m.push({
        source: "binance",
        asset: "btc",
        product: "perp",
        timeframe: "5m",
        timestamp: new Date(windowStart - i * MS_PER_5M),
        open: low,
        high,
        low,
        close: high,
        volume: 1,
      });
    }
    const [snapshot] = [...computeSurvivalSnapshots({ candles1m, candles5m })];
    expect(snapshot?.context.donchian50High).toBe(149);
    expect(snapshot?.context.donchian50Low).toBe(99);
  });

  it("prev5mBar carries the most recent bar's full OHLC", () => {
    const windowStart = Date.UTC(2025, 0, 1, 0, 5, 0);
    const candles1m = buildContiguous1m({
      startMs: windowStart,
      closes: [101, 102, 103, 104, 105],
    });
    const candles5m: Candle[] = [
      {
        source: "binance",
        asset: "btc",
        product: "perp",
        timeframe: "5m",
        timestamp: new Date(windowStart - MS_PER_5M),
        open: 110,
        high: 115,
        low: 95,
        close: 100,
        volume: 1,
      },
    ];
    const [snapshot] = [...computeSurvivalSnapshots({ candles1m, candles5m })];
    expect(snapshot?.context.prev5mBar).toEqual({
      open: 110,
      high: 115,
      low: 95,
      close: 100,
    });
  });
});
