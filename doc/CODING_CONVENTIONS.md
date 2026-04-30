# Coding Conventions

## Principles

- Optimize for reviewability.
- Prefer simple code over clever abstractions.
- Keep IO and external parsing at the boundary.
- Keep strategy logic separate from transport logic.
- Make invalid states hard to represent.
- Keep files small enough to read without hunting through unrelated behavior.

## Repository Layout

- `src/main.rs`: binary entrypoint.
- `src/cli.rs`: CLI shape and flags.
- `src/config.rs`: environment variables and default endpoints.
- `src/domain/`: pure domain types and math.
- `src/polymarket/`: external Polymarket clients and payload parsing.
- `src/monitor.rs`: long-running orchestration.
- `src/doctor.rs`: quick operator health check.
- `doc/`: internal documentation.
- `tmp/`: scratch artifacts only, gitignored.

## Numbers And Units

- Probability prices should be represented as `Decimal` or scaled `e6`
  integers.
- Underlying asset prices should be represented as `Decimal` or scaled `e8`
  integers.
- Do not use floating point for trading-facing calculations.
- If a feed gives JSON numbers, parse through `serde_json::Number` string
  conversion into `Decimal`.
- Name units explicitly in fields and logs when ambiguity is likely.

## Time

- Slot math lives in `src/domain/time.rs`.
- All slot boundaries are UTC.
- Current 5-minute slugs are based on Unix seconds at the slot start.
- Do not infer the slot line if the process did not observe the boundary.

## Errors

- Boundary errors should explain which upstream shape failed.
- Long-running tasks should log and reconnect when the failure is recoverable.
- Do not silently drop unknown Polymarket event types; keep raw payloads at
  debug level.

## Tests

- Unit-test pure logic aggressively.
- Do not make network calls in unit tests.
- Prefer small tests for slug construction, slot rollover, boundary parsing,
  orderbook updates, and line capture.
- Live endpoint smoke tests belong in manual command validation, not unit tests.

## Dependencies

- Add dependencies reluctantly.
- Prefer crates that reduce boundary risk or async plumbing complexity.
- Do not add a database or service dependency without a concrete runtime need.
