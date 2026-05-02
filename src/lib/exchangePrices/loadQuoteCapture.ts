import { readFile } from "node:fs/promises";
import { exchangeIdValues } from "@wiggler/constants/exchanges";
import { quoteCaptureSchema, type QuoteCapture } from "@wiggler/types/exchanges";

const knownExchanges = new Set<string>(exchangeIdValues);

/**
 * Reads a `prices:capture` JSON file from disk and validates it against the
 * shared `quoteCaptureSchema`.
 *
 * Captures recorded under an older roster (for example before an exchange
 * was retired) can contain ticks for unknown ids. To keep old files usable
 * we silently drop those rows before validation rather than refuse the
 * file outright.
 */
export async function loadQuoteCapture({
  path,
}: {
  readonly path: string;
}): Promise<QuoteCapture> {
  const raw = await readFile(path, "utf8");
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const cleaned = dropUnknownExchanges({ raw: parsed });
  return quoteCaptureSchema.parse(cleaned);
}

function dropUnknownExchanges({
  raw,
}: {
  readonly raw: Record<string, unknown>;
}): Record<string, unknown> {
  const ticks = Array.isArray(raw["ticks"]) ? raw["ticks"] : [];
  const filteredTicks = ticks.filter((tick): tick is Record<string, unknown> => {
    if (typeof tick !== "object" || tick === null) return false;
    const exchange = (tick as Record<string, unknown>)["exchange"];
    return typeof exchange === "string" && knownExchanges.has(exchange);
  });

  const tickCounts =
    typeof raw["tickCounts"] === "object" && raw["tickCounts"] !== null
      ? (raw["tickCounts"] as Record<string, unknown>)
      : {};
  const filteredCounts: Record<string, unknown> = {};
  for (const [exchange, count] of Object.entries(tickCounts)) {
    if (knownExchanges.has(exchange)) {
      filteredCounts[exchange] = count;
    }
  }

  const errors = Array.isArray(raw["errors"]) ? raw["errors"] : [];
  const filteredErrors = errors.filter(
    (entry): entry is Record<string, unknown> => {
      if (typeof entry !== "object" || entry === null) return false;
      const exchange = (entry as Record<string, unknown>)["exchange"];
      return typeof exchange === "string" && knownExchanges.has(exchange);
    },
  );

  return {
    ...raw,
    ticks: filteredTicks,
    tickCounts: filteredCounts,
    errors: filteredErrors,
  };
}
