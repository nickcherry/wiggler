import { defineCommand } from "@alea/lib/cli/defineCommand";
import { verifyAuth } from "@alea/lib/polymarket/verifyAuth";
import pc from "picocolors";

const webSocketObserveMs = 3_000;

/**
 * End-to-end auth smoke test against real Polymarket endpoints. Runs the
 * tier-1 read sequence (L1 EIP-712, L2 HMAC, funder balance, open orders, WS
 * user channel) plus a tier-2 order-signing dry-run. No orders are posted.
 *
 * Designed to be the first thing an operator runs after rotating creds or
 * standing up a fresh deploy: a single green checklist proves the wallet,
 * funder address, and credential lifecycle are all wired correctly.
 */
export const polymarketAuthCheckCommand = defineCommand({
  name: "polymarket:auth-check",
  summary: "Verify Polymarket authentication end-to-end (no orders posted)",
  description:
    "Initializes the auth client (which fetches /time and create-or-derives the API key bundle using the L1 auth nonce), then runs five tier-1 read checks plus a tier-2 V2 order-signing dry-run. Prints a green [OK] line per check or [FAIL] with the underlying error and exits non-zero if anything failed. Reads POLYMARKET_PRIVATE_KEY and POLYMARKET_FUNDER_ADDRESS from the environment.",
  options: [],
  examples: ["bun alea polymarket:auth-check"],
  output:
    "One [OK]/[FAIL] line per check. Exits 0 only if all six checks pass.",
  sideEffects:
    "Calls Polymarket REST endpoints, opens a 3-second WebSocket subscription on the /ws/user channel, and signs a representative order locally. No orders are posted and no on-chain transactions are sent.",
  async run({ io }) {
    const result = await verifyAuth({ webSocketObserveMs });

    for (const check of result.checks) {
      if (check.ok) {
        io.writeStdout(
          `${pc.green("[OK]")}   ${check.label} — ${check.detail}\n`,
        );
      } else {
        io.writeStdout(
          `${pc.red("[FAIL]")} ${check.label} — ${check.errorMessage ?? "unknown error"}\n`,
        );
      }
    }

    if (!result.allPassed) {
      throw new Error("Polymarket auth check failed.");
    }
  },
});
