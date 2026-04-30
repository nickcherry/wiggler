# Operations

## Logging Policy

`wiggler` does not write application log files. It emits structured JSON logs
to stdout/stderr and expects the process manager to own retention.

Production should run with:

```bash
RUST_LOG=wiggler=info,info
```

Do not run production with `wiggler=debug` unless you are doing a short
investigation. Debug logs include per-event orderbook, best-bid/ask, and trade
churn and can become the dominant disk and network cost.

## Expected Log Volume

At the default whitelist (`btc,eth,sol,xrp,doge`) and one lookahead
slot, info-level logs are intentionally bounded:

- startup and websocket connection lines
- one initial orderbook snapshot per token after each CLOB subscription
- one status line per active asset every 15 seconds
- one trade-evaluation line per active asset every `WIGGLER_EVALUATION_INTERVAL_MS`
- warnings/errors/reconnects
- watched market resolution events

At the default 1-second evaluation cadence, expect hundreds of thousands of
info-level JSON lines per day for five assets. The larger live websocket event
stream stays in memory and is only counted in periodic status logs. Increase
`WIGGLER_EVALUATION_INTERVAL_MS` for quieter shadow runs; keep it low for live
trading latency.

## Systemd

Templates live under [`deploy/systemd`](../deploy/systemd).

Suggested install shape:

```bash
sudo useradd --system --home /opt/wiggler --shell /usr/sbin/nologin wiggler
sudo mkdir -p /opt/wiggler/bin /opt/wiggler/tmp
sudo chown -R wiggler:wiggler /opt/wiggler
sudo install -m 0755 target/release/wiggler /opt/wiggler/bin/wiggler
sudo cp -R runtime /opt/wiggler/runtime
sudo chown -R wiggler:wiggler /opt/wiggler/runtime

sudo install -m 0644 deploy/systemd/wiggler.service /etc/systemd/system/wiggler.service
sudo install -D -m 0644 deploy/systemd/journald.conf.d/20-wiggler.conf /etc/systemd/journald.conf.d/20-wiggler.conf

sudo systemctl restart systemd-journald
sudo systemctl daemon-reload
sudo systemctl enable --now wiggler
```

The service template includes:

- `Restart=always`
- journal stdout/stderr
- systemd log rate limiting
- `MemoryMax=1G`
- `MemoryHigh=768M`
- file descriptor headroom
- basic filesystem hardening

## Journal Retention

The included journald drop-in caps retained logs globally for the host:

```text
SystemMaxUse=1G
SystemKeepFree=2G
RuntimeMaxUse=256M
MaxRetentionSec=7day
```

If the server runs other services, review those values before installing the
drop-in because journald retention is host-level, not per-service.

Useful commands:

```bash
journalctl -u wiggler -f
journalctl -u wiggler --since '1 hour ago'
journalctl -u wiggler --disk-usage
sudo journalctl --vacuum-size=1G
sudo journalctl --vacuum-time=7d
```

## Disk And Memory Guardrails

The monitor is intentionally stateless:

- no database
- no application log files
- no durable cache by default
- in-memory orderbooks only, pruned to the active watchset on every refresh

If memory grows unexpectedly, systemd should apply pressure at `MemoryHigh` and
kill/restart the service before it can make the whole server unhealthy.

Investigate with:

```bash
systemctl status wiggler
systemd-cgtop
journalctl -u wiggler --since '10 minutes ago'
```
