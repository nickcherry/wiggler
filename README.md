# wiggler

Rust CLI for monitoring Polymarket crypto up/down markets.

Current scope: data-only monitoring for whitelisted 5-minute crypto markets.
The runtime discovers the current and next Polymarket event for each
whitelisted asset, subscribes to every outcome token over the CLOB market
websocket, streams the matching Chainlink price from Polymarket RTDS, and
rolls forward without operator action.

There is no trading path yet. No orders are created, signed, or posted.

## Docs

- [Stack](./doc/STACK.md): runtime, dependencies, and external services.
- [CLI](./doc/CLI.md): command contract and examples.
- [Polymarket](./doc/POLYMARKET.md): discovery, CLOB websocket, RTDS price feed, and slot naming.
- [Live Monitoring](./doc/LIVE_MONITORING.md): long-running monitor behavior and rollover model.
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
cargo run -- monitor --assets btc,eth,sol,xrp,doge,hype,bnb --slot-seconds 300 --lookahead-slots 1
cargo run -- monitor --price-feed chainlink
```

## Environment

| name | default | purpose |
|---|---|---|
| `RUST_LOG` | `wiggler=info,info` | Tracing filter |
| `WIGGLER_ASSETS` | `btc,eth,sol,xrp,doge,hype,bnb` | Comma-separated asset whitelist |
| `POLYMARKET_GAMMA_BASE_URL` | `https://gamma-api.polymarket.com` | Market discovery |
| `POLYMARKET_CLOB_MARKET_WS_URL` | `wss://ws-subscriptions-clob.polymarket.com/ws/market` | Orderbook websocket |
| `POLYMARKET_RTDS_WS_URL` | `wss://ws-live-data.polymarket.com` | Chainlink/Binance crypto price websocket |
| `TELEGRAM_BOT_TOKEN` | unset | Optional future notification sender |
| `TELEGRAM_CHAT_ID` | unset | Optional future notification target |

## Current Non-Goals

- No database.
- No trade execution.
- No wallet or Polymarket auth.
- No strategy thresholds.
- No backtest engine.
- No CEX candle ingestion; use `../wiggler-data` for historical candles.
