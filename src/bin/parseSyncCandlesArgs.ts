import { assetValues } from "@wiggler/constants/assets";
import {
  candleTimeframeValues,
  defaultCandleLookbackDays,
} from "@wiggler/constants/candles";
import { candleSourceValues } from "@wiggler/constants/sources";
import { assetSchema, type Asset } from "@wiggler/types/assets";
import {
  candleTimeframeSchema,
  type CandleTimeframe,
} from "@wiggler/types/candles";
import { candleSourceSchema, type CandleSource } from "@wiggler/types/sources";
import { z } from "zod";

export type ParsedSyncCandlesArgs = {
  readonly timeframe: CandleTimeframe;
  readonly lookbackDays: number;
  readonly assets: readonly Asset[];
  readonly sources: readonly CandleSource[];
};

const argsSchema = z.object({
  timeframe: candleTimeframeSchema.default("5m"),
  lookbackDays: z.coerce
    .number()
    .int()
    .positive()
    .default(defaultCandleLookbackDays),
  assets: z.array(assetSchema).default([...assetValues]),
  sources: z.array(candleSourceSchema).default([...candleSourceValues]),
});

/**
 * Parses `candles:sync` flags. Unknown flags or invalid enum values throw a
 * Zod error with the offending value already named.
 */
export function parseSyncCandlesArgs({
  argv,
}: {
  readonly argv: readonly string[];
}): ParsedSyncCandlesArgs {
  const raw = readFlags({ argv });

  const parsed = argsSchema.parse({
    timeframe: raw["--timeframe"] ?? undefined,
    lookbackDays: raw["--days"] ?? undefined,
    assets: raw["--assets"]
      ?.split(",")
      .map((value) => value.trim())
      .filter((value) => value.length > 0),
    sources: raw["--sources"]
      ?.split(",")
      .map((value) => value.trim())
      .filter((value) => value.length > 0),
  });

  return parsed;
}

const knownFlags = new Set([
  "--timeframe",
  "--days",
  "--assets",
  "--sources",
]);

function readFlags({
  argv,
}: {
  readonly argv: readonly string[];
}): Record<string, string> {
  const flags: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === undefined) {
      continue;
    }
    if (!knownFlags.has(flag)) {
      throw new Error(`unknown flag: ${flag}`);
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`flag ${flag} requires a value`);
    }
    flags[flag] = value;
    index += 1;
  }
  return flags;
}
