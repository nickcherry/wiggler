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
cargo run -- doctor --assets btc,eth,sol,xrp,doge --slot-seconds 300 --lookahead-slots 1
```

Output is pretty JSON so it can be read by a human or parsed by tooling.

Side effects:

- Makes public Gamma REST requests.
- Does not open websockets.
- Does not send Telegram messages.
- Does not write files.

### `monitor`

Runs the live monitor and shadow evaluator.

```bash
cargo run -- monitor
cargo run -- monitor --max-runtime-seconds 15
cargo run -- monitor --runtime-bundle-dir runtime/wiggler-prod-v1
```

Default behavior:

- Assets: `btc,eth,sol,xrp,doge`
- Tradable assets: `btc,eth,sol,xrp,doge`
- Slot width: `300` seconds
- Lookahead: current slot plus one future slot
- Underlying price feed: `chainlink`
- Runtime bundle: `runtime/wiggler-prod-v1`
- Evaluation cadence: `1000` ms
- Live trading: disabled; enable with `WIGGLER_LIVE_TRADING=true` and Polymarket credentials

Use a comma-separated whitelist to monitor more than one market family:

```bash
cargo run -- monitor --assets btc,eth,sol,xrp,doge
WIGGLER_ASSETS=btc,eth,sol,xrp,doge cargo run -- monitor
```

`--asset btc` is accepted as an alias for `--assets btc`.
HYPE and BNB remain supported but are not in the default whitelist; include
them explicitly with `--assets ...` when ready.

Side effects:

- Makes public Gamma REST requests every 10 seconds.
- Opens one RTDS websocket per whitelisted asset for the configured price source.
- Opens one CLOB market websocket for the full token watchset.
- Emits JSON logs to stdout/stderr through tracing.
- Logs shadow trade evaluations and skip reasons.
- Places live orders only when `WIGGLER_LIVE_TRADING=true`.

## Output

Long-running output is structured JSON logs. Key events:

- `connecting RTDS websocket`
- `refreshing market websocket subscription`
- `initial book snapshot`
- `captured slot line`
- `monitor status`
- `trade evaluation`
- `watched market resolved`

Per-event book, best-bid/ask, and trade churn is logged at debug level.

`trade evaluation` logs include the market id, token ids, line/current prices,
remaining-time bucket, distance from line, vol bin, runtime cell sample count,
`p_win_lower`, executable ask edge, positive-EV depth, decision, skip reason,
and runtime hashes.

## Destructive Commands

None.
