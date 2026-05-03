#!/usr/bin/env bun
import { candlesFillGapsCommand } from "@wiggler/bin/candles/fillGaps";
import { candlesSyncCommand } from "@wiggler/bin/candles/sync";
import { dbMigrateCommand } from "@wiggler/bin/db/migrate";
import { latencyCaptureCommand } from "@wiggler/bin/latency/capture";
import { latencyChartCommand } from "@wiggler/bin/latency/chart";
import { telegramTestCommand } from "@wiggler/bin/telegram/test";
import { trainingDistributionsCommand } from "@wiggler/bin/training/distributions";
import { createCli } from "@wiggler/lib/cli/createCli";

const cli = createCli({
  name: "wiggler",
  summary: "Polymarket crypto up/down monitor and gated trader",
  commands: [
    dbMigrateCommand,
    candlesSyncCommand,
    candlesFillGapsCommand,
    latencyCaptureCommand,
    latencyChartCommand,
    trainingDistributionsCommand,
    telegramTestCommand,
  ],
});

await cli.runWithErrorBoundary(process.argv.slice(2));
