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

## Live-System Caution

`monitor` talks to public Polymarket websockets. It does not write to external
systems or place orders.

Future live trading commands must be explicit and must not share the same
default path as data-only monitoring.

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
