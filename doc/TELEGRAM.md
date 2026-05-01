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

- process startup
- first shadow decision per market
- live order intent
- live order response
- live order error
- live closeout with Polymarket account PnL/win-loss counts plus local trade-record debug PnL
- periodic Polymarket account PnL/win-loss counts plus local trade-record debug PnL summary

FAK/FOK no-fill errors are reported as no-fill events, but they do not block
the monitor from looking for another entry in the same market.

Polymarket account PnL and total win/loss counts are fetched from the public
profile/leaderboard, positions, and closed-positions data APIs using
`POLYMARKET_FUNDER_ADDRESS`. The local trade-record ledger is still shown
because it is useful for debugging exact bot closeouts, but it is not the
source of truth for account/profile PnL or total win/loss counts.

## Message Content

Decision messages must include:

- timestamp
- market slug
- asset
- slot start/end
- side/outcome
- market price and book depth
- Chainlink price
- slot line
- distance from line in bps
- dry-run or live execution mode

Keep messages terse enough to scan on mobile.
