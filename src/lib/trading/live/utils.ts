import type { Asset } from "@alea/types/assets";

/** Right-padded uppercase label so log columns align nicely. */
export function labelAsset(asset: Asset): string {
  return asset.toUpperCase().padEnd(5);
}

/**
 * Per-asset decimal precision for printed underlying prices. The
 * model and the venue both work in pure numbers; this only affects
 * how we render them in log lines and Telegram messages.
 */
export function decimalsFor({ asset }: { readonly asset: Asset }): number {
  switch (asset) {
    case "btc":
    case "eth":
      return 2;
    case "sol":
    case "xrp":
      return 4;
    case "doge":
      return 5;
  }
}

export async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}
