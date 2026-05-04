import { getPolymarketAuthState } from "@alea/lib/polymarket/getPolymarketClobClient";
import { probeUserWebSocket } from "@alea/lib/polymarket/probeUserWebSocket";
import { AssetType, type ClobClient, Side } from "@polymarket/clob-client";
import { z } from "zod";

export type VerifyAuthCheck = {
  readonly label: string;
  readonly ok: boolean;
  readonly detail: string;
  readonly errorMessage?: string;
};

export type VerifyAuthResult = {
  readonly checks: readonly VerifyAuthCheck[];
  readonly allPassed: boolean;
};

/**
 * Runs the tier-1 read checks plus a tier-2 order-signing dry-run against
 * real Polymarket endpoints. Each step returns a single `VerifyAuthCheck`
 * row; the caller renders them. We do NOT post any orders — the tier-2 check
 * builds and signs a representative bid locally and stops.
 */
export async function verifyAuth({
  webSocketObserveMs,
}: {
  readonly webSocketObserveMs: number;
}): Promise<VerifyAuthResult> {
  const checks: VerifyAuthCheck[] = [];

  const initCheck = await runStep("L1 EIP-712", async () => {
    const auth = await getPolymarketAuthState();
    const apiKeyPrefix = auth.apiKey.slice(0, 8);
    const offsetMs = Math.round(auth.serverTimeOffsetSeconds * 1000);
    return {
      detail: `derived API creds (apiKey: ${apiKeyPrefix}..., clock offset: ${offsetMs}ms)`,
    };
  });
  checks.push(initCheck);
  if (!initCheck.ok) {
    return { checks, allPassed: false };
  }

  const auth = await getPolymarketAuthState();
  const client = auth.client;

  checks.push(
    await runStep("L2 HMAC", async () => {
      const apiKeysResponse = await client.getApiKeys();
      const keys = extractApiKeyList(apiKeysResponse);
      return {
        detail: `listed ${keys.length} API key(s) for this wallet`,
      };
    }),
  );

  checks.push(
    await runStep("Funder recognized", async () => {
      const response = await client.getBalanceAllowance({
        asset_type: AssetType.COLLATERAL,
      });
      const balance = formatUsdc(response.balance);
      const allowance = formatMaxAllowance(response);
      return {
        detail: `USDC balance: ${balance}, allowance: ${allowance}`,
      };
    }),
  );

  checks.push(
    await runStep("L2 GET", async () => {
      const orders = await client.getOpenOrders();
      const count = Array.isArray(orders) ? orders.length : 0;
      return { detail: `${count} open order(s)` };
    }),
  );

  checks.push(
    await runStep("WS user channel", async () => {
      const probe = await probeUserWebSocket({ observeMs: webSocketObserveMs });
      if (!probe.opened) {
        throw new Error(probe.errorMessage ?? "socket failed to open");
      }
      if (probe.errorMessage && !probe.closedCleanly) {
        throw new Error(probe.errorMessage);
      }
      const seconds = Math.round(webSocketObserveMs / 1000);
      const eventSummary =
        probe.framesReceived > 0
          ? `${probe.framesReceived} frame(s)`
          : "clean idle";
      return {
        detail: `subscribed cleanly, observed for ${seconds}s (${eventSummary})`,
      };
    }),
  );

  checks.push(
    await runStep("Order signing", async () => {
      const tokenId = await pickRepresentativeTokenId({ client });
      const signed = await client.createOrder(
        {
          tokenID: tokenId.tokenId,
          price: 0.01,
          size: 5,
          side: Side.BUY,
        },
        { negRisk: tokenId.negRisk },
      );
      return {
        detail: `built + signed unfillable bid for ${tokenId.marketSlug}, sig: ${signed.signature.slice(0, 18)}...`,
      };
    }),
  );

  return {
    checks,
    allPassed: checks.every((check) => check.ok),
  };
}

async function runStep(
  label: string,
  step: () => Promise<{ readonly detail: string }>,
): Promise<VerifyAuthCheck> {
  try {
    const { detail } = await step();
    return { label, ok: true, detail };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      label,
      ok: false,
      detail: "",
      errorMessage,
    };
  }
}

function extractApiKeyList(response: unknown): readonly unknown[] {
  if (response && typeof response === "object" && "apiKeys" in response) {
    const { apiKeys } = response;
    if (Array.isArray(apiKeys)) {
      return apiKeys;
    }
  }
  return [];
}

function formatUsdc(raw: string): string {
  const numeric = Number(raw);
  if (!Number.isFinite(numeric)) {
    return raw;
  }
  // Polymarket reports USDC at 6 decimals as a plain integer string.
  const usdc = numeric / 1_000_000;
  return `${usdc.toFixed(2)} USDC`;
}

/**
 * The live `/balance-allowance` response returns an `allowances` map keyed by
 * exchange contract address rather than a single `allowance` string (the SDK
 * type is stale). Callers care that allowance is "set high enough to be
 * unlimited" — surface a "max" indicator when it matches `uint256.max`,
 * otherwise the lowest concrete allowance across the contracts.
 */
function formatMaxAllowance(response: unknown): string {
  const parsed = balanceAllowanceResponseSchema.safeParse(response);
  if (!parsed.success) {
    return "unknown";
  }
  if (parsed.data.allowances) {
    const values = Object.values(parsed.data.allowances);
    if (values.length === 0) {
      return "0";
    }
    if (values.every((value) => value === maxUint256)) {
      return "max";
    }
    const min = values
      .map((value) => Number(value))
      .filter(Number.isFinite)
      .reduce((acc, value) => Math.min(acc, value), Infinity);
    return Number.isFinite(min) ? formatUsdc(String(min)) : "unknown";
  }
  if (parsed.data.allowance !== undefined) {
    return formatUsdc(parsed.data.allowance);
  }
  return "unknown";
}

const balanceAllowanceResponseSchema = z.object({
  balance: z.string(),
  allowance: z.string().optional(),
  allowances: z.record(z.string(), z.string()).optional(),
});

const maxUint256 =
  "115792089237316195423570985008687907853269984665640564039457584007913129639935";

type RepresentativeToken = {
  readonly tokenId: string;
  readonly marketSlug: string;
  readonly negRisk: boolean;
};

const samplingMarketSchema = z.object({
  condition_id: z.string().optional(),
  neg_risk: z.boolean().optional(),
  tokens: z.array(z.object({ token_id: z.string() }).passthrough()).min(1),
});

const samplingPageSchema = z.object({
  data: z.array(z.unknown()),
});

async function pickRepresentativeTokenId({
  client,
}: {
  readonly client: ClobClient;
}): Promise<RepresentativeToken> {
  // Pull a single page of sampling-simplified markets — the cheapest endpoint
  // that returns active, tradable token ids. We pick the first market with a
  // non-empty tokens array.
  const page = samplingPageSchema.parse(
    await client.getSamplingSimplifiedMarkets(),
  );
  for (const candidate of page.data) {
    const parsed = samplingMarketSchema.safeParse(candidate);
    if (!parsed.success) {
      continue;
    }
    const market = parsed.data;
    const firstToken = market.tokens[0];
    if (!firstToken) {
      continue;
    }
    return {
      tokenId: firstToken.token_id,
      marketSlug: shortenConditionId(market.condition_id ?? "<unknown>"),
      negRisk: market.neg_risk ?? false,
    };
  }
  throw new Error("No active markets returned by /sampling-simplified-markets");
}

function shortenConditionId(conditionId: string): string {
  return conditionId.length > 14
    ? `${conditionId.slice(0, 10)}...${conditionId.slice(-4)}`
    : conditionId;
}
