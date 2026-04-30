# Telegram

Telegram support is scaffolded in `src/telegram.rs`.

## Configuration

```bash
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
```

If either value is missing, the Telegram client is a no-op.

## Current Behavior

The current monitor does not send Telegram messages because it does not make
trade decisions.

## Future Behavior

When decision logic is added, Telegram messages should be sent for:

- startup with runtime configuration
- slot line capture if useful operationally
- dry-run decision
- live order intent
- order accepted/rejected
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
