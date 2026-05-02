# wiggler

Rust CLI for monitoring Polymarket crypto up/down markets.

Current scope: shadow monitoring plus gated live execution for whitelisted
5-minute crypto markets. The runtime discovers the current and next Polymarket
event for each whitelisted asset, subscribes to every outcome token over the
CLOB market websocket, streams the matching Chainlink price from Polymarket
RTDS, loads the production probability-table bundle, and evaluates executable
maker bids against EV/risk/staleness gates.

Live trading is off by default. With `WIGGLER_LIVE_TRADING=false`, eligible
decisions are logged as would-trades and no orders are submitted. With
`WIGGLER_LIVE_TRADING=true`, the monitor uses the official Polymarket Rust CLOB
SDK to sign and post buy-only, post-only GTD limit orders after a second
pre-submit evaluation.

## Docs

- [Stack](./doc/STACK.md): runtime, dependencies, and external services.
- [CLI](./doc/CLI.md): command contract and examples.
- [Runtime Bundle](./doc/RUNTIME_BUNDLE.md): production probability-table loading and shadow decisions.
- [Offline Training](./doc/TRAINING.md): local Postgres candle sync, VWAP, and runtime-bundle generation.
- [Polymarket](./doc/POLYMARKET.md): discovery, CLOB websocket, RTDS price feed, and slot naming.
- [Live Monitoring](./doc/LIVE_MONITORING.md): long-running monitor behavior and rollover model.
- [Operations](./doc/OPERATIONS.md): systemd, journald retention, and runtime guardrails.
- [Telegram](./doc/TELEGRAM.md): current notification surface and future decision alerts.
- [Coding Conventions](./doc/CODING_CONVENTIONS.md): Rust structure, numbers, tests, and dependency rules.
- [Documentation](./doc/DOCUMENTATION.md): what to document and where.
- [Execution](./doc/EXECUTION.md): validation and completion discipline.
- [How To Work With Nick](./doc/HOW_TO_WORK_WITH_NICK.md): collaboration expectations.

## Production Host

When this repo says "prod" or "production server", it means the server reached
with the local `wiggler_prod` shell alias. See [Operations](./doc/OPERATIONS.md)
for the exact SSH target and the commands to verify or disable the prod service.

## Setup

```bash
cargo build
cp .env.example .env
```

The binary loads `.env` on startup when the file is present.

Shadow monitoring uses public Polymarket endpoints and does not need API keys.
Live trading requires a Polymarket private key and funded/approved wallet.
Telegram is optional.

## Commands

```bash
# Check Gamma discovery for current + next whitelisted 5m slots.
cargo run -- doctor

# Run the live data monitor until interrupted.
cargo run -- monitor

# Short smoke test.
cargo run -- monitor --max-runtime-seconds 15

# Locally refresh the production runtime bundle from Coinbase/Binance candles.
cargo run -- training refresh-runtime
```

Useful overrides:

```bash
cargo run -- monitor --assets btc,eth,sol,xrp,doge --slot-seconds 300 --lookahead-slots 1
cargo run -- monitor --price-feed chainlink
cargo run -- monitor --runtime-bundle-dir runtime/wiggler-prod-v1
```

## Environment

| name | default | purpose |
|---|---|---|
| `RUST_LOG` | `wiggler=info,info` | Tracing filter |
| `WIGGLER_ASSETS` | `btc,eth,sol,xrp,doge` | Comma-separated asset whitelist |
| `WIGGLER_TRADABLE_ASSETS` | `btc,eth,sol,xrp,doge` | Comma-separated shadow/live eligibility whitelist |
| `WIGGLER_RUNTIME_BUNDLE_DIR` | `runtime/wiggler-prod-v1` | Runtime probability-table bundle |
| `WIGGLER_LIVE_TRADING` | `false` | Global live-trading flag |
| `WIGGLER_MIN_ORDER_USDC` | `1` | Minimum live/shadow decision notional |
| `WIGGLER_MAX_ORDER_USDC` | `25` | Production cap applied below bundle position caps |
| `WIGGLER_EVALUATION_INTERVAL_MS` | `1000` | Decision/evaluation cadence |
| `WIGGLER_CANDLE_REST_SYNC_INTERVAL_MS` | `60000` | Coinbase/Binance candle reconciliation cadence |
| `WIGGLER_LOG_EVALUATIONS` | `false` | Emit full per-tick `trade_evaluation` logs when debugging |
| `WIGGLER_TRADE_RECORD_DIR` | `trade-records` | Ignored JSON record directory for shadow/live entry attempts |
| `WIGGLER_PRICE_STALE_AFTER_MS` | `20000` | Max current-price age for an eligible evaluation |
| `WIGGLER_ORDERBOOK_STALE_AFTER_MS` | `10000` | Max orderbook age for an eligible evaluation |
| `WIGGLER_MIN_ABS_D_BPS` | `0.01` | Dust threshold around the market line |
| `WIGGLER_TELEGRAM_PNL_INTERVAL_SECS` | `900` | Telegram summary lookback control; summaries check every 30s, `0` disables summaries |
| `DATABASE_URL` | `postgres://localhost:5432/wiggler` | Offline training database; not used by `monitor` |
| `POLYMARKET_GAMMA_BASE_URL` | `https://gamma-api.polymarket.com` | Market discovery |
| `POLYMARKET_DATA_API_BASE_URL` | `https://data-api.polymarket.com` | Public profile/account PnL, win/loss, and trade-analysis snapshots |
| `POLYMARKET_CLOB_API_URL` | `https://clob.polymarket.com` | CLOB trading/auth API |
| `POLYMARKET_CLOB_MARKET_WS_URL` | `wss://ws-subscriptions-clob.polymarket.com/ws/market` | Orderbook websocket |
| `POLYMARKET_RTDS_WS_URL` | `wss://ws-live-data.polymarket.com` | Chainlink/Binance crypto price websocket |
| `COINBASE_API_BASE_URL` | `https://api.coinbase.com` | Public 1-minute candle backfill |
| `BINANCE_API_BASE_URL` | `https://data-api.binance.vision` | Public 1-minute candle backfill |
| `BINANCE_MARKET_WS_URL` | `wss://stream.binance.com:9443` | 1-minute kline websocket |
| `POLYMARKET_PRIVATE_KEY` | unset | Required for live order signing |
| `POLYMARKET_SIGNATURE_TYPE` | `eoa` | `eoa`, `proxy`, `gnosis-safe`, or `poly1271` |
| `POLYMARKET_FUNDER_ADDRESS` | unset | Optional explicit funded Polymarket wallet address |
| `POLYMARKET_USER_ADDRESS` | unset | Optional proxy wallet address for API-backed trade analysis and Telegram summaries |
| `POLYMARKET_API_KEY` / `POLYMARKET_API_SECRET` / `POLYMARKET_API_PASSPHRASE` | unset | Optional L2 API credentials; SDK derives/creates credentials when unset |
| `POLYMARKET_API_NONCE` | unset | Optional nonce for API key derivation/creation |
| `WIGGLER_TELEGRAM_ENABLED` | `true` | Set `false` to silence Telegram even when token/chat env vars are present |
| `TELEGRAM_BOT_TOKEN` | unset | Optional notification sender |
| `TELEGRAM_CHAT_ID` | unset | Optional notification target |

## Production Non-Goals

- No backtest engine.
- No production database dependency; local Postgres is only for offline training.
- No durable production candle cache; live Coinbase/Binance candles stay in memory.
