import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve as resolvePath } from "node:path";

import {
  loadLifetimePnl,
  persistLifetimePnl,
} from "@alea/lib/trading/state/lifetimePnlStore";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";

let dir: string;
let path: string;

beforeEach(async () => {
  dir = await mkdtemp(resolvePath(tmpdir(), "alea-lifetime-pnl-"));
  path = resolvePath(dir, "lifetime-pnl.json");
});

afterEach(async () => {
  // Best-effort cleanup; bun ignores ENOENT.
  await writeFile(path, "").catch(() => {});
});

describe("lifetimePnlStore", () => {
  it("cold-starts when the file does not exist", async () => {
    const result = await loadLifetimePnl({ walletAddress: "0xabc", path });
    expect(result.source).toBe("cold");
    expect(result.lifetimePnlUsd).toBe(0);
    if (result.source === "cold") {
      expect(result.reason).toBe("missing-file");
    }
  });

  it("round-trips a value through persist + load", async () => {
    await persistLifetimePnl({
      walletAddress: "0xabc",
      lifetimePnlUsd: 123.45,
      path,
    });
    const result = await loadLifetimePnl({ walletAddress: "0xabc", path });
    expect(result.source).toBe("loaded");
    if (result.source === "loaded") {
      expect(result.lifetimePnlUsd).toBeCloseTo(123.45, 9);
      expect(result.asOfMs).toBeGreaterThan(0);
    }
  });

  it("cold-starts with wallet-mismatch when the address differs", async () => {
    await persistLifetimePnl({
      walletAddress: "0xabc",
      lifetimePnlUsd: 50,
      path,
    });
    const result = await loadLifetimePnl({ walletAddress: "0xdef", path });
    expect(result.source).toBe("cold");
    if (result.source === "cold") {
      expect(result.reason).toBe("wallet-mismatch");
      expect(result.lifetimePnlUsd).toBe(0);
    }
  });

  it("cold-starts with corrupt when the JSON is unparseable", async () => {
    await writeFile(path, "{not-json", "utf8");
    const result = await loadLifetimePnl({ walletAddress: "0xabc", path });
    expect(result.source).toBe("cold");
    if (result.source === "cold") {
      expect(result.reason).toBe("corrupt");
    }
  });

  it("cold-starts with corrupt when the JSON fails the schema", async () => {
    await writeFile(path, JSON.stringify({ walletAddress: 123 }), "utf8");
    const result = await loadLifetimePnl({ walletAddress: "0xabc", path });
    expect(result.source).toBe("cold");
    if (result.source === "cold") {
      expect(result.reason).toBe("corrupt");
    }
  });

  it("persists with the wallet address echoed back into the file", async () => {
    await persistLifetimePnl({
      walletAddress: "0xWALLET",
      lifetimePnlUsd: -7.5,
      path,
    });
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    expect(parsed["walletAddress"]).toBe("0xWALLET");
    expect(parsed["lifetimePnlUsd"]).toBe(-7.5);
    expect(typeof parsed["asOfMs"]).toBe("number");
  });
});
