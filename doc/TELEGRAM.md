# Telegram

Telegram support is implemented in `src/telegram.rs`.

## Configuration

```bash
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
WIGGLER_TELEGRAM_PNL_INTERVAL_SECS=900
```

If either value is missing, the Telegram client is a no-op.
Set `WIGGLER_TELEGRAM_PNL_INTERVAL_SECS=0` to disable periodic PnL
summaries while keeping trade lifecycle messages enabled. When enabled, the
monitor checks for newly closed five-minute windows every 30 seconds and
dedupes summaries by slot.

## Current Behavior

When configured, the monitor sends Telegram messages for:

- live order posts
- live order fills
- live entry rejections and hard execution errors
- one live settlement summary for each five-minute window with position PnL

Retryable post-only rejections are logged and recorded without a Telegram
message, and they do not block the monitor from looking for another entry in
the same market.

Live settlement Telegram win/loss/PnL values use Polymarket Data API position
PnL. Closed/redeemed positions use `realizedPnl`; resolved but not-yet-redeemed
current positions use `realizedPnl + cashPnl`. Local trade records are not used
for PnL or win/loss summaries. Totals are account-wide for the configured
wallet and asset whitelist, using position data available from Polymarket APIs.
Posted-order messages show the effective resting lifetime. The signed GTD
expiration sent to Polymarket carries the required one-minute buffer, so local
records store both `gtd_expires_at` and `effective_until`.
The wallet comes from `POLYMARKET_USER_ADDRESS` or `POLYMARKET_FUNDER_ADDRESS`
in `.env`, with EOA configs falling back to `POLYMARKET_PRIVATE_KEY`.

## Message Content

Live order post messages use this shape:

```text
Posted SOL ↑ maker bid for $50.00 (96.15 shares @ 0.5200)
Expires: 2026-05-02 11:56:00 UTC

Current price is 0.01% above the price line ($83.6113)
```

Live order fill messages use this shape:

```text
Filled SOL ↑ maker bid for $50.00 (96.15 shares @ 0.5200)

Current price is 0.01% above the price line ($83.6113)
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
