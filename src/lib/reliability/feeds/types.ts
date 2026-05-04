import type {
  ReliabilityPriceTick,
  ReliabilitySource,
} from "@alea/lib/reliability/types";
import type { Asset } from "@alea/types/assets";

export type ReliabilityFeedHandle = {
  readonly stop: () => Promise<void>;
};

export type ReliabilityFeedCallbacks = {
  readonly assets: readonly Asset[];
  readonly onTick: (tick: ReliabilityPriceTick) => void;
  readonly onOpen?: (source: ReliabilitySource) => void;
  readonly onClose?: (source: ReliabilitySource, reason: string) => void;
  readonly onError?: (source: ReliabilitySource, error: Error) => void;
};
