# CLI

`wiggler` is a CLI-first application.

During development, run commands through Cargo:

```bash
cargo run -- <command>
```

After release/build, the binary itself is the entrypoint:

```bash
target/release/wiggler <command>
```

## Commands

### `doctor`

Checks Gamma discovery for current and upcoming Polymarket slots.

```bash
cargo run -- doctor
cargo run -- doctor --asset btc --slot-seconds 300 --lookahead-slots 1
```

Output is pretty JSON so it can be read by a human or parsed by tooling.

Side effects:

- Makes public Gamma REST requests.
- Does not open websockets.
- Does not send Telegram messages.
- Does not write files.

### `monitor`

Runs the data-only live monitor.

```bash
cargo run -- monitor
cargo run -- monitor --max-runtime-seconds 15
```

Default behavior:

- Asset: `btc`
- Slot width: `300` seconds
- Lookahead: current slot plus one future slot
- Underlying price feed: `chainlink`

Side effects:

- Makes public Gamma REST requests every 10 seconds.
- Opens one RTDS websocket for the configured price source.
- Opens one CLOB market websocket for the current token watchset.
- Emits JSON logs to stdout/stderr through tracing.
- Does not place orders or send trade decisions.

## Output

Long-running output is structured JSON logs. Key events:

- `discovered market`
- `refreshing market websocket subscription`
- `book snapshot`
- `best bid ask`
- `last trade`
- `captured slot line`
- `monitor status`

## Destructive Commands

None.
