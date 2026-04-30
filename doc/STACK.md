# Stack

## Core Stack

- Rust 2024 edition.
- Tokio for async runtime, timers, signals, and channels.
- Clap for the CLI contract.
- Reqwest with rustls for Gamma REST and future Telegram calls.
- Tokio Tungstenite with rustls for Polymarket websockets.
- Serde / serde_json for boundary parsing.
- rust_decimal for probability prices and underlying asset prices.
- tracing / tracing-subscriber for JSON logs.

## External Services

- Gamma API: `https://gamma-api.polymarket.com`
  - Used for event discovery by slug.
  - Public, no auth.
- CLOB market websocket: `wss://ws-subscriptions-clob.polymarket.com/ws/market`
  - Used for orderbook snapshots, price changes, best bid/ask, trades, and market lifecycle events.
  - Public, no auth.
- RTDS websocket: `wss://ws-live-data.polymarket.com`
  - Used for Chainlink BTC/USD ticks.
  - Public for crypto prices, no auth.
- Telegram Bot API
  - Optional.
  - Used for startup, shadow/would-trade, live intent, and live response notifications when configured.

## Current Shape

- `src/main.rs` is the only binary entrypoint.
- `src/cli.rs` defines operator commands and flags.
- `src/domain/` holds asset, slot-time, market, decimal, and orderbook types.
- `src/polymarket/` holds Gamma, CLOB websocket, and RTDS clients.
- `src/monitor.rs` owns long-running orchestration and rollover.
- `src/doctor.rs` owns quick connectivity/discovery checks.
- Internal docs live under `doc/`.

## Philosophy

- Keep the stack small and boring.
- Keep boundary parsing isolated from trading logic.
- Store numeric market values as decimals or scaled integers, not floats.
- Prefer one default runtime path with direct CLI overrides.
- Keep the live process restartable and stateless unless a future edge requires durable local cache.
