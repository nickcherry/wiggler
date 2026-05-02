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
The same convention is currently used for the whitelisted crypto assets:

```text
btc-updown-5m-{slot_start_unix_seconds}
eth-updown-5m-{slot_start_unix_seconds}
sol-updown-5m-{slot_start_unix_seconds}
xrp-updown-5m-{slot_start_unix_seconds}
doge-updown-5m-{slot_start_unix_seconds}
hype-updown-5m-{slot_start_unix_seconds}
bnb-updown-5m-{slot_start_unix_seconds}
```

For 5-minute up/down markets there are two token IDs:

- `Up`
- `Down`

The monitor subscribes to current and next slot tokens for every whitelisted
asset so rollover can happen without waiting for the next slot to be discovered
at the boundary.

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

## Live Trading API

Live order signing and submission uses Polymarket's official Rust SDK:

- Docs: <https://docs.polymarket.com/api-reference/clients-sdks>
- Order docs: <https://docs.polymarket.com/trading/orders/create>
- Auth docs: <https://docs.polymarket.com/api-reference/authentication>
- Rust crate: `polymarket_client_sdk_v2`

The default trading API host is:

```text
https://clob.polymarket.com
```

The SDK handles L1 authentication, L2 headers, EIP-712 signing, protocol
version detection, and order submission. Wiggler also posts CLOB heartbeats
while live trading is enabled. It only submits buy-side maker orders with:

- `GTD` order type
- `postOnly=true`
- limit price at the current best bid
- dollar size selected inside Wiggler's configured min/max notional range, then
  converted to shares at that limit price
- share size truncated to Polymarket's two-decimal lot precision
- no sell/flipping path
- no repeated local or remote exposure in the same market

Before enabling live trading, the funder wallet must have the required
Polymarket collateral allowance. The SDK/API will reject orders with
insufficient balance or allowance.

The monitor keeps Polymarket L2 API credentials in
`POLYMARKET_API_CREDENTIAL_FILE`, which defaults to
`tmp/polymarket-api.env`. That file is a local runtime cache and must stay out
of git. Startup loads the cache first, then falls back to credentials from the
environment. If Polymarket later rejects the active API key, the monitor
single-flights recovery, tries to derive credentials from the cached/configured
nonce, and only creates a fresh key when derivation fails. Successful recovery
writes the replacement credentials back to the cache and refreshes the
heartbeat before order, trade, or heartbeat polling resumes.

For emergency manual API-key setup, use the checked-in auth helper:

```bash
set -a
. ./.env
set +a
export POLYMARKET_API_NONCE="$(date +%s)"
AUTH_MANUAL_MODE=create \
AUTH_MANUAL_BODY='{}' \
AUTH_MANUAL_WRITE_ENV=tmp/polymarket-api.env \
cargo run --release --example auth_manual
```

The helper uses the same L1 EIP-712 auth as the monitor and sends an explicit
empty JSON body on `POST /auth/api-key`. The generated file contains
`POLYMARKET_API_KEY`, `POLYMARKET_API_SECRET`, `POLYMARKET_API_PASSPHRASE`, and
the nonce used to mint the credentials.

To test the configured credentials without placing orders, run:

```bash
set -a
. ./.env
set +a
cargo run --example l2_probe
```

The probe checks `closed_only`, balance/allowance, and open orders with the
current L2 credentials, then checks trade history through the public Polymarket
Data API. Set `WIGGLER_PROBE_MARKET=<condition id>` to include market-filtered
orders/trades checks. Production exposure reconciliation uses the same split:
CLOB for live open orders and Data API for historical trades, because CLOB
`/data/trades` can reject otherwise valid API keys.

When the account is a Polymarket proxy wallet, verify the signature type before
live trading. `proxy`, `gnosis-safe`, and `eoa` can all authenticate, but only
the correct type reports the funded collateral balance. On the current prod
account, `gnosis-safe` is the type that returns collateral and allowances.
For proxy and Gnosis Safe accounts, `POLYMARKET_FUNDER_ADDRESS` must be the
Polymarket profile/proxy wallet, not the EOA address for
`POLYMARKET_PRIVATE_KEY`; leave it empty to let the SDK derive the wallet.
To inspect the signer and derived proxy/safe addresses without printing
secrets, run:

```bash
set -a
. ./.env
set +a
cargo run --example address_probe
```

## Underlying Price Feed

The 5-minute crypto market descriptions say resolution uses Chainlink streams,
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

For a multi-asset whitelist, the monitor opens one RTDS connection per asset and
filters ticks by the exact expected Chainlink symbol:

- `btc/usd`
- `eth/usd`
- `sol/usd`
- `xrp/usd`
- `doge/usd`
- `hype/usd`
- `bnb/usd`

## Slot Line

This repo calls the boundary price the `slot line`. It is the price that the
final Chainlink tick must finish above/equal to for `Up`, or below for `Down`.

The current monitor captures a slot line only when it observes that asset's
Chainlink tick crossing the slot start. If the process starts after the current
slot began, it does not invent a line for that slot. It will capture the next
slot line once it observes the boundary.

That behavior is intentional. A stale or guessed line is worse than no line.
