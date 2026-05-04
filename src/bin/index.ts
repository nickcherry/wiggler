#!/usr/bin/env bun
import { candlesFillGapsCommand } from "@alea/bin/candles/fillGaps";
import { candlesSyncCommand } from "@alea/bin/candles/sync";
import { dbMigrateCommand } from "@alea/bin/db/migrate";
import { latencyCaptureCommand } from "@alea/bin/latency/capture";
import { latencyChartCommand } from "@alea/bin/latency/chart";
import { polymarketAuthCheckCommand } from "@alea/bin/polymarket/authCheck";
import { telegramTestCommand } from "@alea/bin/telegram/test";
import { tradingDryRunCommand } from "@alea/bin/trading/dryRun";
import { tradingGenProbabilityTableCommand } from "@alea/bin/trading/genProbabilityTable";
import { trainingDistributionsCommand } from "@alea/bin/training/distributions";
import { createCli } from "@alea/lib/cli/createCli";

const cli = createCli({
  name: "alea",
  summary: "Polymarket crypto up/down monitor and gated trader",
  commands: [
    dbMigrateCommand,
    candlesSyncCommand,
    candlesFillGapsCommand,
    latencyCaptureCommand,
    latencyChartCommand,
    trainingDistributionsCommand,
    telegramTestCommand,
    polymarketAuthCheckCommand,
    tradingGenProbabilityTableCommand,
    tradingDryRunCommand,
  ],
});

await cli.runWithErrorBoundary(process.argv.slice(2));
