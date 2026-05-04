import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve as resolvePath } from "node:path";

import { bootstrapLifetimePnl } from "@alea/lib/trading/live/lifetimePnlBootstrap";
import type { LifetimePnlBox, LiveEvent } from "@alea/lib/trading/live/types";
import {
  loadLifetimePnl,
  persistLifetimePnl,
} from "@alea/lib/trading/state/lifetimePnlStore";
import type { Vendor } from "@alea/lib/trading/vendor/types";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";

let dir: string;
let path: string;

beforeEach(async () => {
  dir = await mkdtemp(resolvePath(tmpdir(), "alea-bootstrap-pnl-"));
  path = resolvePath(dir, "lifetime-pnl.json");
});

afterEach(async () => {
  await rm(dir, { force: true, recursive: true });
});

function vendorWithScan({
  scan,
}: {
  readonly scan: Vendor["scanLifetimePnl"];
}): Vendor {
  return {
    id: "fake",
    walletAddress: "0xwallet",
    async discoverMarket() {
      throw new Error("not used");
    },
    async fetchBook() {
      throw new Error("not used");
    },
    async placeMakerLimitBuy() {
      throw new Error("not used");
    },
    async cancelOrder() {
      throw new Error("not used");
    },
    streamUserFills() {
      return { stop: async () => {} };
    },
    async hydrateMarketState() {
      throw new Error("not used");
    },
    scanLifetimePnl: scan,
  };
}

function eventMessages(events: readonly LiveEvent[]): string {
  return events
    .flatMap((event) => ("message" in event ? [event.message] : []))
    .join("\n");
}

describe("bootstrapLifetimePnl", () => {
  it("reconciles an existing checkpoint against vendor truth and persists it", async () => {
    await persistLifetimePnl({
      walletAddress: "0xwallet",
      lifetimePnlUsd: 10,
      path,
    });
    const lifetimePnl: LifetimePnlBox = { value: 0 };
    const events: LiveEvent[] = [];

    await bootstrapLifetimePnl({
      vendor: vendorWithScan({
        scan: async () => ({
          lifetimePnlUsd: 12.34,
          resolvedMarketsCounted: 3,
          unresolvedMarketsSkipped: 1,
          tradesCounted: 5,
        }),
      }),
      lifetimePnl,
      lifetimePnlPath: path,
      emit: (event) => events.push(event),
    });

    expect(lifetimePnl.value).toBe(12.34);
    expect(
      await loadLifetimePnl({ walletAddress: "0xwallet", path }),
    ).toMatchObject({
      source: "loaded",
      lifetimePnlUsd: 12.34,
    });
    expect(eventMessages(events)).toContain(
      "lifetime pnl checkpoint loaded; reconciling fake trade history",
    );
    expect(eventMessages(events)).toContain(
      "lifetime pnl reconciled: $12.34",
    );
  });

  it("keeps the loaded checkpoint when reconciliation fails", async () => {
    await persistLifetimePnl({
      walletAddress: "0xwallet",
      lifetimePnlUsd: 10,
      path,
    });
    const lifetimePnl: LifetimePnlBox = { value: 0 };
    const events: LiveEvent[] = [];

    await bootstrapLifetimePnl({
      vendor: vendorWithScan({
        scan: async () => {
          throw new Error("venue unavailable");
        },
      }),
      lifetimePnl,
      lifetimePnlPath: path,
      emit: (event) => events.push(event),
    });

    expect(lifetimePnl.value).toBe(10);
    expect(
      await loadLifetimePnl({ walletAddress: "0xwallet", path }),
    ).toMatchObject({
      source: "loaded",
      lifetimePnlUsd: 10,
    });
    expect(events.at(-1)).toMatchObject({
      kind: "warn",
      message:
        "lifetime pnl reconciliation failed: venue unavailable; keeping loaded checkpoint $10.00",
    });
  });
});
