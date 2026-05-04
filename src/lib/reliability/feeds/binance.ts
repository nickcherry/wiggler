import { binancePerpSymbol } from "@alea/lib/candles/sources/binance/binancePerpSymbol";
import { binanceSymbol } from "@alea/lib/candles/sources/binance/binanceSymbol";
import { createReconnectingWebSocket } from "@alea/lib/reliability/feeds/createReconnectingWebSocket";
import type {
  ReliabilityFeedCallbacks,
  ReliabilityFeedHandle,
} from "@alea/lib/reliability/feeds/types";
import type {
  ReliabilityPriceTick,
  ReliabilitySource,
} from "@alea/lib/reliability/types";
import type { Asset } from "@alea/types/assets";
import { z } from "zod";

const BINANCE_SPOT_WS_BASE = "wss://data-stream.binance.vision/stream";
const BINANCE_PERP_WS_BASE = "wss://fstream.binance.com/stream";

export function streamBinanceSpotReliabilityPrices({
  assets,
  onTick,
  onOpen,
  onClose,
  onError,
}: ReliabilityFeedCallbacks): ReliabilityFeedHandle {
  return streamBinanceReliabilityPrices({
    source: "binance-spot",
    url: buildUrl({
      baseUrl: BINANCE_SPOT_WS_BASE,
      assets,
      symbolForAsset: binanceSymbol,
    }),
    symbolToAsset: buildSymbolMap({ assets, symbolForAsset: binanceSymbol }),
    onTick,
    onOpen,
    onClose,
    onError,
  });
}

export function streamBinancePerpReliabilityPrices({
  assets,
  onTick,
  onOpen,
  onClose,
  onError,
}: ReliabilityFeedCallbacks): ReliabilityFeedHandle {
  return streamBinanceReliabilityPrices({
    source: "binance-perp",
    url: buildUrl({
      baseUrl: BINANCE_PERP_WS_BASE,
      assets,
      symbolForAsset: binancePerpSymbol,
    }),
    symbolToAsset: buildSymbolMap({
      assets,
      symbolForAsset: binancePerpSymbol,
    }),
    onTick,
    onOpen,
    onClose,
    onError,
  });
}

export function parseBinanceBookTickerFrame({
  raw,
  source,
  symbolToAsset,
  receivedAtMs,
}: {
  readonly raw: string;
  readonly source: Extract<ReliabilitySource, "binance-spot" | "binance-perp">;
  readonly symbolToAsset: ReadonlyMap<string, Asset>;
  readonly receivedAtMs: number;
}): ReliabilityPriceTick | null {
  const parsedJson = JSON.parse(raw) as unknown;
  const parsedCombined = combinedBookTickerFrameSchema.safeParse(parsedJson);
  const parsedDirect = bookTickerFrameSchema.safeParse(parsedJson);
  const data = parsedCombined.success
    ? parsedCombined.data.data
    : parsedDirect.success
      ? parsedDirect.data
      : null;
  if (data === null) {
    return null;
  }

  const asset = symbolToAsset.get(data.s);
  if (asset === undefined) {
    return null;
  }
  const bid = Number(data.b);
  const ask = Number(data.a);
  if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask <= 0) {
    return null;
  }
  return {
    source,
    asset,
    price: (bid + ask) / 2,
    receivedAtMs,
    exchangeTimeMs: typeof data.T === "number" ? data.T : (data.E ?? null),
  };
}

function streamBinanceReliabilityPrices({
  source,
  url,
  symbolToAsset,
  onTick,
  onOpen,
  onClose,
  onError,
}: {
  readonly source: Extract<ReliabilitySource, "binance-spot" | "binance-perp">;
  readonly url: string;
  readonly symbolToAsset: ReadonlyMap<string, Asset>;
} & Omit<ReliabilityFeedCallbacks, "assets">): ReliabilityFeedHandle {
  return createReconnectingWebSocket({
    source,
    url,
    onConnect: () => onOpen?.(source),
    onDisconnect: (reason) => onClose?.(source, reason),
    onError: (error) => onError?.(source, error),
    onMessage: (raw) => {
      const tick = parseBinanceBookTickerFrame({
        raw,
        source,
        symbolToAsset,
        receivedAtMs: Date.now(),
      });
      if (tick !== null) {
        onTick(tick);
      }
    },
  });
}

function buildUrl({
  baseUrl,
  assets,
  symbolForAsset,
}: {
  readonly baseUrl: string;
  readonly assets: readonly Asset[];
  readonly symbolForAsset: (input: { readonly asset: Asset }) => string;
}): string {
  const streams = assets.map(
    (asset) => `${symbolForAsset({ asset }).toLowerCase()}@bookTicker`,
  );
  return `${baseUrl}?streams=${streams.join("/")}`;
}

export function buildBinanceSymbolMap({
  assets,
  product,
}: {
  readonly assets: readonly Asset[];
  readonly product: "spot" | "perp";
}): ReadonlyMap<string, Asset> {
  return buildSymbolMap({
    assets,
    symbolForAsset: product === "spot" ? binanceSymbol : binancePerpSymbol,
  });
}

function buildSymbolMap({
  assets,
  symbolForAsset,
}: {
  readonly assets: readonly Asset[];
  readonly symbolForAsset: (input: { readonly asset: Asset }) => string;
}): ReadonlyMap<string, Asset> {
  const map = new Map<string, Asset>();
  for (const asset of assets) {
    map.set(symbolForAsset({ asset }), asset);
  }
  return map;
}

const bookTickerFrameSchema = z
  .object({
    s: z.string(),
    b: z.string(),
    a: z.string(),
    E: z.number().optional(),
    T: z.number().optional(),
  })
  .passthrough();

const combinedBookTickerFrameSchema = z
  .object({
    data: bookTickerFrameSchema,
  })
  .passthrough();
