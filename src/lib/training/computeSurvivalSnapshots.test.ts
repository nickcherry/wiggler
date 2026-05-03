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

  it("populates prev1mDirection from the candle just before the snapshot's 1m candle", () => {
    // Six candles: c[-1] then a full 5m window. c[-1] closes down (prev
    // direction = down). For snapshot at +1m (4m left), the previous 1m
    // candle is c[-1].
    const startMs = Date.UTC(2025, 0, 1, 0, 0, 0);
    const candles1m: Candle[] = [
      // c[-1]: 00:-1 → not aligned to 5m boundary, just sits before the
      // window. open 100, close 99 → down.
      buildCandle({
        timestamp: new Date(startMs - MS_PER_1M),
        open: 100,
        close: 99,
      }),
      ...buildContiguous1m({
        startMs,
        closes: [101, 102, 103, 104, 105],
      }),
    ];
    const snapshots = [...computeSurvivalSnapshots({ candles1m })];
    // Snapshot at +1m (4m left): previous 1m is c[-1] which closed down.
    expect(snapshots[0]?.context.prev1mDirection).toBe("down");
    // Snapshot at +2m (3m left): previous 1m is c0 (close 101 vs open 99)
    // which is up.
    expect(snapshots[1]?.context.prev1mDirection).toBe("up");
  });

  it("populates last3x1mDirections only when three preceding candles exist", () => {
    const startMs = Date.UTC(2025, 0, 1, 0, 0, 0);
    // Three candles before the window, all up.
    const lookbackCloses = [101, 102, 103];
    const candles1m: Candle[] = [];
    let prev = 100;
    for (let i = 0; i < lookbackCloses.length; i += 1) {
      const ts = new Date(startMs - (3 - i) * MS_PER_1M);
      const close = lookbackCloses[i] ?? prev;
      candles1m.push(buildCandle({ timestamp: ts, open: prev, close }));
      prev = close;
    }
    candles1m.push(
      ...buildContiguous1m({ startMs, closes: [104, 105, 106, 107, 108] }),
    );
    const snapshots = [...computeSurvivalSnapshots({ candles1m })];
    // Snapshot at +1m: last 3 are the lookback candles, all up.
    expect(snapshots[0]?.context.last3x1mDirections).toEqual([
      "up",
      "up",
      "up",
    ]);
    // Snapshot at +4m: last 3 are c0, c1, c2 — all up.
    expect(snapshots[3]?.context.last3x1mDirections).toEqual([
      "up",
      "up",
      "up",
    ]);
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
