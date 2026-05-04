import { polymarket } from "@alea/constants/polymarket";
import { createReconnectingWebSocket } from "@alea/lib/reliability/feeds/createReconnectingWebSocket";
import type {
  ReliabilityFeedCallbacks,
  ReliabilityFeedHandle,
} from "@alea/lib/reliability/feeds/types";
import type { ReliabilityPriceTick } from "@alea/lib/reliability/types";
import type { Asset } from "@alea/types/assets";
import { z } from "zod";

const topic = "crypto_prices_chainlink";

export function streamPolymarketChainlinkReliabilityPrices({
  assets,
  onTick,
  onOpen,
  onClose,
  onError,
}: ReliabilityFeedCallbacks): ReliabilityFeedHandle {
  const symbolToAsset = buildPolymarketSymbolMap({ assets });
  return createReconnectingWebSocket({
    source: "polymarket-chainlink",
    url: polymarket.rtdsWsUrl,
    onOpen: (ws) => {
      ws.send(
        JSON.stringify({
          action: "subscribe",
          subscriptions: [{ topic, type: "*" }],
        }),
      );
    },
    onConnect: () => onOpen?.("polymarket-chainlink"),
    onDisconnect: (reason) => onClose?.("polymarket-chainlink", reason),
    onError: (error) => onError?.("polymarket-chainlink", error),
    onMessage: (raw) => {
      const ticks = parsePolymarketChainlinkFrame({
        raw,
        symbolToAsset,
        receivedAtMs: Date.now(),
      });
      for (const tick of ticks) {
        onTick(tick);
      }
    },
  });
}

export function parsePolymarketChainlinkFrame({
  raw,
  symbolToAsset,
  receivedAtMs,
}: {
  readonly raw: string;
  readonly symbolToAsset: ReadonlyMap<string, Asset>;
  readonly receivedAtMs: number;
}): readonly ReliabilityPriceTick[] {
  if (raw.length === 0) {
    return [];
  }
  const parsed = polymarketRtdsFrameSchema.safeParse(JSON.parse(raw));
  if (
    !parsed.success ||
    parsed.data.topic !== topic ||
    parsed.data.type !== "update" ||
    parsed.data.payload === undefined
  ) {
    return [];
  }
  const symbol = parsed.data.payload.symbol;
  const asset = symbol === undefined ? undefined : symbolToAsset.get(symbol);
  const value = parsed.data.payload.value;
  if (asset === undefined || value === undefined || value <= 0) {
    return [];
  }
  return [
    {
      source: "polymarket-chainlink",
      asset,
      price: value,
      receivedAtMs,
      exchangeTimeMs: parsed.data.payload.timestamp ?? null,
    },
  ];
}

export function buildPolymarketSymbolMap({
  assets,
}: {
  readonly assets: readonly Asset[];
}): ReadonlyMap<string, Asset> {
  const map = new Map<string, Asset>();
  for (const asset of assets) {
    map.set(`${asset}/usd`, asset);
  }
  return map;
}

const polymarketRtdsFrameSchema = z
  .object({
    topic: z.string().optional(),
    type: z.string().optional(),
    payload: z
      .object({
        symbol: z.string().optional(),
        value: z.number().finite().positive().optional(),
        timestamp: z.number().optional(),
      })
      .optional(),
  })
  .passthrough();
