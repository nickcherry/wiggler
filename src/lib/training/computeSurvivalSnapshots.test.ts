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

  it("returns null prev5m + ma20 context when 5m series isn't supplied", () => {
    const candles1m = buildContiguous1m({
      startMs: Date.UTC(2025, 0, 1, 0, 0, 0),
      closes: [101, 102, 103, 104, 105],
    });
    const [snapshot] = [...computeSurvivalSnapshots({ candles1m })];
    expect(snapshot?.context.prev5mDirection).toBeNull();
    expect(snapshot?.context.prev5mClose).toBeNull();
    expect(snapshot?.context.ma20x5m).toBeNull();
    expect(snapshot?.context.last3x5mDirections).toBeNull();
  });

  it("populates prev5m direction + close from the 5m candle ending at window start", () => {
    const windowStart = Date.UTC(2025, 0, 1, 0, 5, 0);
    const candles1m = buildContiguous1m({
      startMs: windowStart,
      closes: [101, 102, 103, 104, 105],
    });
    // One 5m candle ending at windowStart: starts at windowStart - 5m.
    const candles5m: Candle[] = [
      buildCandle({
        timestamp: new Date(windowStart - MS_PER_5M),
        open: 110,
        close: 100,
        timeframe: "5m",
      }),
    ];
    const [snapshot] = [...computeSurvivalSnapshots({ candles1m, candles5m })];
    expect(snapshot?.context.prev5mDirection).toBe("down");
    expect(snapshot?.context.prev5mClose).toBe(100);
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
});
