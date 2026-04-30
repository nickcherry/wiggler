# Polymarket

## Discovery

The monitor builds Polymarket event slugs from the UTC slot start:

```text
btc-updown-5m-1777562400
```

That example maps to the slot starting `2026-04-30T15:20:00Z`.

Discovery uses:

```text
GET https://gamma-api.polymarket.com/events/slug/{slug}
```

Gamma returns the event plus one market. The market includes:

- `conditionId`
- `clobTokenIds`
- `outcomes`
- `enableOrderBook`
- `resolutionSource`
- `eventStartTime`
- `endDate`

Gamma currently returns `clobTokenIds`, `outcomes`, and `outcomePrices` as
JSON-encoded strings, so parsing for those fields is isolated in
`src/polymarket/serde_helpers.rs`.

## Outcome Tokens

The CLOB market websocket subscribes by token asset IDs, not by event slug.
For BTC 5-minute markets there are two token IDs:

- `Up`
- `Down`

The monitor subscribes to current and next slot tokens so rollover can happen
without waiting for the next slot to be discovered at the boundary.

## Orderbook Feed

The CLOB market websocket endpoint is:

```text
wss://ws-subscriptions-clob.polymarket.com/ws/market
```

Subscription shape:

```json
{
  "assets_ids": ["<up_token_id>", "<down_token_id>"],
  "type": "market",
  "custom_feature_enabled": true
}
```

The monitor handles:

- `book`
- `price_change`
- `tick_size_change`
- `last_trade_price`
- `best_bid_ask`
- `new_market`
- `market_resolved`

Unknown events are logged at debug level with the raw payload.

## Underlying Price Feed

The BTC 5-minute market description says resolution uses Chainlink BTC/USD,
not spot exchange prices. The monitor therefore defaults to RTDS Chainlink:

```text
wss://ws-live-data.polymarket.com
```

Subscription shape:

```json
{
  "action": "subscribe",
  "subscriptions": [
    {
      "topic": "crypto_prices_chainlink",
      "type": "*",
      "filters": "{\"symbol\":\"btc/usd\"}"
    }
  ]
}
```

RTDS requires text `PING` messages every 5 seconds to keep the connection open.

## Slot Line

This repo calls the boundary price the `slot line`. It is the price that the
final Chainlink tick must finish above/equal to for `Up`, or below for `Down`.

The current monitor captures a slot line only when it observes a Chainlink tick
crossing the slot start. If the process starts after the current slot began, it
does not invent a line for that slot. It will capture the next slot line once
it observes the boundary.

That behavior is intentional. A stale or guessed line is worse than no line.
