# Telegram

Telegram support is scaffolded in `src/telegram.rs`.

## Configuration

```bash
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
```

If either value is missing, the Telegram client is a no-op.

## Current Behavior

When configured, the monitor sends Telegram messages for:

- process startup
- first shadow decision per market
- live order intent
- live order response
- live order error

## Future Behavior

Additional message types that are still useful future work:

- fill
- exit/settlement
- runtime health degradation

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
