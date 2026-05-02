#!/usr/bin/env bun
import { candlesSyncCommand } from "@wiggler/bin/candles/sync";
import { dbMigrateCommand } from "@wiggler/bin/db/migrate";
import { telegramTestCommand } from "@wiggler/bin/telegram/test";
import { createCli } from "@wiggler/lib/cli/createCli";

const cli = createCli({
  name: "wiggler",
  summary: "Polymarket crypto up/down monitor and gated trader",
  commands: [dbMigrateCommand, candlesSyncCommand, telegramTestCommand],
});

await cli.runWithErrorBoundary(process.argv.slice(2));
