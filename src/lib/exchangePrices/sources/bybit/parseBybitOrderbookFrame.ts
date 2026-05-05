import type { ExchangeId, QuoteTick } from "@alea/types/exchanges";

type BybitOrderbookFrame = {
  topic?: string;
  type?: "snapshot" | "delta";
  ts?: number;
  data?: {
    s?: string;
    b?: ReadonlyArray<readonly [string, string]>;
    a?: ReadonlyArray<readonly [string, string]>;
  };
};

type BybitState = {
  bid: number | null;
  ask: number | null;
};

/**
 * Parses one Bybit v5 `orderbook.1.<symbol>` frame and updates a small
 * in-memory state for the best bid and best ask. Bybit sends a `snapshot`
 * for the first frame and `delta` for subsequent frames; depth-1 frames
 * effectively just replace the top, so we treat both the same way.
 */
export function parseBybitOrderbookFrame({
  raw,
  topic,
  exchange,
  state,
}: {
  readonly raw: string;
  readonly topic: string;
  readonly exchange: ExchangeId;
  readonly state: BybitState;
}): QuoteTick | null {
  const data = JSON.parse(raw) as BybitOrderbookFrame;
  if (data.topic !== topic || !data.data) {
    return null;
  }

  const bidLevel = data.data.b?.[0];
  const askLevel = data.data.a?.[0];
  if (bidLevel) {
    const price = Number(bidLevel[0]);
    const qty = Number(bidLevel[1]);
    if (Number.isFinite(price) && qty > 0) {
      state.bid = price;
    }
  }
  if (askLevel) {
    const price = Number(askLevel[0]);
    const qty = Number(askLevel[1]);
    if (Number.isFinite(price) && qty > 0) {
      state.ask = price;
    }
  }

  if (state.bid === null || state.ask === null) {
    return null;
  }
  return {
    exchange,
    asset: "btc",
    tsReceivedMs: Date.now(),
    tsExchangeMs: typeof data.ts === "number" ? data.ts : null,
    bid: state.bid,
    ask: state.ask,
    mid: (state.bid + state.ask) / 2,
  };
}
