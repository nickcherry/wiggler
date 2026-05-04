import type {
  ClosedFiveMinuteBar,
  LivePriceFeedFactory,
} from "@alea/lib/livePrices/types";
import type { Asset } from "@alea/types/assets";

export type LivePriceSource = {
  readonly id: string;
  readonly stream: LivePriceFeedFactory;
  readonly fetchRecentFiveMinuteBars: (input: {
    readonly asset: Asset;
    readonly count: number;
    readonly signal?: AbortSignal;
  }) => Promise<readonly ClosedFiveMinuteBar[]>;
  readonly fetchExactFiveMinuteBar: (input: {
    readonly asset: Asset;
    readonly openTimeMs: number;
    readonly signal?: AbortSignal;
  }) => Promise<ClosedFiveMinuteBar | null>;
};
