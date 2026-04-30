# Execution

## Required Validation

Before calling a change done, run:

```bash
cargo fmt --check
cargo check
cargo test
```

For CLI changes, also run the relevant command:

```bash
cargo run -- doctor
cargo run -- monitor --max-runtime-seconds 15
```

Use the shortest live monitor run that proves the changed behavior. Do not
leave long-running sessions active after validation.

For production deploy changes, check [OPERATIONS.md](./OPERATIONS.md) and keep
logging under systemd/journald retention rather than app-managed files.

## Live-System Caution

`monitor` talks to public Polymarket websockets in shadow mode. When
`WIGGLER_LIVE_TRADING=true`, it can sign and post Polymarket orders.

Live trading must remain explicit and fail closed:

- `WIGGLER_LIVE_TRADING` defaults to `false`
- `POLYMARKET_PRIVATE_KEY` is required only for live mode
- live orders are buy-only, taker-only, FAK/FOK market orders with an explicit
  max acceptable price
- the evaluator reruns immediately before submit
- any existing local or remote market exposure blocks another order
- live order attempts and responses are logged and sent to Telegram when
  Telegram is configured

## Debugging

- Reproduce or observe the failure before broad changes.
- Separate Gamma discovery failures from websocket failures.
- Keep temporary logging out of final changes unless it is useful operational
  telemetry.
- Prefer narrow unit tests for parser and state-machine bugs.

## Completion

When finishing work, report:

- what changed
- validation run
- live smoke-test result if relevant
- what remains unverified
