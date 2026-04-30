# wiggler

Rust CLI for monitoring Polymarket crypto up/down markets.

Current scope: shadow monitoring for whitelisted 5-minute crypto markets. The
runtime discovers the current and next Polymarket event for each whitelisted
asset, subscribes to every outcome token over the CLOB market websocket,
streams the matching Chainlink price from Polymarket RTDS, loads the production
probability-table bundle, and logs EV-gated trade evaluations without operator
action.

There is no live trading path yet. No orders are created, signed, or posted.
`WIGGLER_LIVE_TRADING=true` currently fails closed at startup.

## Docs

- [Stack](./doc/STACK.md): runtime, dependencies, and external services.
- [CLI](./doc/CLI.md): command contract and examples.
- [Runtime Bundle](./doc/RUNTIME_BUNDLE.md): production probability-table loading and shadow decisions.
- [Polymarket](./doc/POLYMARKET.md): discovery, CLOB websocket, RTDS price feed, and slot naming.
- [Live Monitoring](./doc/LIVE_MONITORING.md): long-running monitor behavior and rollover model.
- [Operations](./doc/OPERATIONS.md): systemd, journald retention, and runtime guardrails.
- [Telegram](./doc/TELEGRAM.md): current notification surface and future decision alerts.
- [Coding Conventions](./doc/CODING_CONVENTIONS.md): Rust structure, numbers, tests, and dependency rules.
- [Documentation](./doc/DOCUMENTATION.md): what to document and where.
- [Execution](./doc/EXECUTION.md): validation and completion discipline.
- [How To Work With Nick](./doc/HOW_TO_WORK_WITH_NICK.md): collaboration expectations.

## Setup

```bash
cargo build
cp .env.example .env
```

The monitor uses public Polymarket endpoints and does not need API keys.
Telegram is optional and currently only scaffolded for future decision alerts.

## Commands

```bash
# Check Gamma discovery for current + next whitelisted 5m slots.
cargo run -- doctor

# Run the live data monitor until interrupted.
cargo run -- monitor

# Short smoke test.
cargo run -- monitor --max-runtime-seconds 15
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
| `WIGGLER_LIVE_TRADING` | `false` | Global live-trading flag; true is rejected until execution is implemented |
| `WIGGLER_PRICE_STALE_AFTER_MS` | `20000` | Max current-price age for an eligible evaluation |
| `WIGGLER_ORDERBOOK_STALE_AFTER_MS` | `10000` | Max orderbook age for an eligible evaluation |
| `WIGGLER_MIN_ABS_D_BPS` | `0.01` | Dust threshold around the market line |
| `POLYMARKET_GAMMA_BASE_URL` | `https://gamma-api.polymarket.com` | Market discovery |
| `POLYMARKET_CLOB_MARKET_WS_URL` | `wss://ws-subscriptions-clob.polymarket.com/ws/market` | Orderbook websocket |
| `POLYMARKET_RTDS_WS_URL` | `wss://ws-live-data.polymarket.com` | Chainlink/Binance crypto price websocket |
| `TELEGRAM_BOT_TOKEN` | unset | Optional future notification sender |
| `TELEGRAM_CHAT_ID` | unset | Optional future notification target |

## Current Non-Goals

- No database.
- No trade execution.
- No wallet or Polymarket auth.
- No backtest engine.
- No CEX candle ingestion; use `../wiggler-data` for historical candles.
