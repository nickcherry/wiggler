import { runDbMigrate } from "@wiggler/bin/runDbMigrate";
import { runSyncCandles } from "@wiggler/bin/runSyncCandles";

const command = process.argv[2];

async function main(): Promise<void> {
  switch (command) {
    case "db:migrate":
      await runDbMigrate();
      return;
    case "candles:sync":
      await runSyncCandles({ argv: process.argv.slice(3) });
      return;
    case undefined:
    case "--help":
    case "-h":
      printUsage();
      return;
    default:
      printUsage();
      process.exit(1);
  }
}

function printUsage(): void {
  console.log(
    [
      "wiggler <command>",
      "",
      "Commands:",
      "  db:migrate                   Apply pending Kysely migrations",
      "  candles:sync [options]       Backfill candles into Postgres",
      "",
      "candles:sync options:",
      "  --timeframe <1m|5m>          Candle timeframe (default: 5m)",
      "  --days <N>                   Lookback window in days (default: 730)",
      "  --assets <a,b,c>             Comma-separated subset of btc,eth,sol,xrp,doge",
      "  --sources <coinbase,binance> Comma-separated source list",
      "",
    ].join("\n"),
  );
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
