import type { ExchangeId, QuoteTick } from "@alea/types/exchanges";

type OkxBboFrame = {
  arg?: { channel?: string; instId?: string };
  data?: ReadonlyArray<{
    bids?: ReadonlyArray<readonly string[]>;
    asks?: ReadonlyArray<readonly string[]>;
    ts?: string;
  }>;
};

/**
 * Parses one OKX `bbo-tbt` frame into a `QuoteTick`. Shared between the
 * spot and swap streams since the channel shape is identical and only the
 * `instId` differs.
 */
export function parseOkxBboFrame({
  raw,
  instId,
  exchange,
}: {
  readonly raw: string;
  readonly instId: string;
  readonly exchange: ExchangeId;
}): QuoteTick | null {
  const data = JSON.parse(raw) as OkxBboFrame;
  if (data.arg?.channel !== "bbo-tbt" || data.arg?.instId !== instId) {
    return null;
  }
  const row = data.data?.[0];
  if (!row) {
    return null;
  }
  const bid = Number(row.bids?.[0]?.[0]);
  const ask = Number(row.asks?.[0]?.[0]);
  if (!Number.isFinite(bid) || !Number.isFinite(ask)) {
    return null;
  }
  const tsExchangeMs = row.ts ? Number(row.ts) : null;
  return {
    exchange,
    asset: "btc",
    tsReceivedMs: Date.now(),
    tsExchangeMs:
      tsExchangeMs && Number.isFinite(tsExchangeMs) ? tsExchangeMs : null,
    bid,
    ask,
    mid: (bid + ask) / 2,
  };
}
