# Stack

## Core Stack

- Rust 2024 edition.
- Tokio for async runtime, timers, signals, and channels.
- Clap for the CLI contract.
- Reqwest with rustls for Gamma, Coinbase, Binance, and Telegram REST calls.
- Tokio Tungstenite and the Polymarket SDK websocket client with rustls for
  Polymarket websockets.
- Serde / serde_json for boundary parsing.
- rust_decimal for probability prices and underlying asset prices.
- SQLx for local offline-training Postgres access.
- tracing / tracing-subscriber for JSON logs.

## External Services

- Gamma API: `https://gamma-api.polymarket.com`
  - Used for event discovery by slug.
  - Public, no auth.
- CLOB market websocket: `wss://ws-subscriptions-clob.polymarket.com/ws/market`
  - Used for orderbook snapshots, price changes, best bid/ask, trades, and market lifecycle events.
  - Public, no auth.
- CLOB user websocket: `wss://ws-subscriptions-clob.polymarket.com/ws/user`
  - Used in live mode for authenticated user trade fills.
  - Authenticated with the active Polymarket L2 API credentials.
- RTDS websocket: `wss://ws-live-data.polymarket.com`
  - Used for Chainlink BTC/USD ticks.
  - Public for crypto prices, no auth.
- Telegram Bot API
  - Optional.
  - Used for startup errors, shadow/would-trade messages, live order posts,
    live fills, hard live rejections/errors, and settlement summaries when
    configured.
- Coinbase public market data API: `https://api.coinbase.com`
  - Used by live in-memory candle reconciliation and local offline candle backfills.
  - Spot candles only.
- Binance public market data API: `https://data-api.binance.vision`
  - Used by live in-memory candle reconciliation and local offline candle backfills.
  - Spot candles only.
- Local PostgreSQL
  - Used only by `training` commands for offline candle storage and runtime-bundle generation.
  - Not used by the production `monitor` process.

## Current Shape

- `src/main.rs` is the only binary entrypoint.
- `src/cli.rs` defines operator commands and flags.
- `src/domain/` holds asset, slot-time, market, decimal, and orderbook types.
- `src/polymarket/` holds Gamma, CLOB market/user websocket, and RTDS clients.
- `src/monitor.rs` owns long-running orchestration and rollover.
- `src/doctor.rs` owns quick connectivity/discovery checks.
- `src/training/` owns local offline candle sync, VWAP, and runtime-bundle generation.
- Internal docs live under `doc/`.

## Philosophy

- Keep the stack small and boring.
- Keep boundary parsing isolated from trading logic.
- Store numeric market values as decimals or scaled integers, not floats.
- Prefer one default runtime path with direct CLI overrides.
- Keep the live process restartable and DB-free; durable storage belongs to offline training.
