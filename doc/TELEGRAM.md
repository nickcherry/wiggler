# Telegram

Telegram support is scaffolded in `src/telegram.rs`.

## Configuration

```bash
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
WIGGLER_TELEGRAM_PNL_INTERVAL_SECS=900
```

If either value is missing, the Telegram client is a no-op.
Set `WIGGLER_TELEGRAM_PNL_INTERVAL_SECS=0` to disable periodic PnL
summaries while keeping trade lifecycle messages enabled.

## Current Behavior

When configured, the monitor sends Telegram messages for:

- live entry fills
- live entry rejections and hard execution errors
- one live settlement summary for each five-minute window with closed positions

Live entry attempts are not messaged. Retryable FAK/FOK no-fill misses are
logged and recorded, but they do not send Telegram messages and do not block the
monitor from looking for another entry in the same market.

Live settlement Telegram win/loss/PnL values are fetched from Polymarket
`closed-positions` data using `POLYMARKET_FUNDER_ADDRESS`. The local
trade-record ledger remains available for debugging exact bot attempts and
closeout timing, but it is not used as the Telegram settlement source of truth.

## Message Content

Live entry fill messages use this shape:

```text
Entered BTC ↑ for $49.99, price line @ $77,972.55
```

Live entry rejection messages use this shape:

```text
Rejected entry of BTC ↑: invalid signature
```

Five-minute settlement summaries use this shape:

```text
BTC ↑ won +$58.35
ETH ↓ lost -$49.99

Total wins: 1 (50%)
Total losses: 1 (50%)

Total PnL: +$8.36
```

Keep messages terse enough to scan on mobile.
