# Polymarket Integration

This is the source map for the Polymarket behavior Alea depends on. When the
live implementation has to rely on an observed payload shape that differs from
the official docs, record the shape and observation date here before encoding
the assumption in code.

## Endpoint Constants

The canonical URL set lives in
[`src/constants/polymarket.ts`](../src/constants/polymarket.ts):

- CLOB REST: `https://clob.polymarket.com`
- Gamma API: `https://gamma-api.polymarket.com`
- CLOB market WebSocket: `wss://ws-subscriptions-clob.polymarket.com/ws/market`
- CLOB user WebSocket: `wss://ws-subscriptions-clob.polymarket.com/ws/user`
- Real Time Data Socket: `wss://ws-live-data.polymarket.com`

## Official Docs

- [Developer endpoints](https://docs.polymarket.com/developers) — base REST,
  Data API, WebSocket, and RTDS endpoints.
- [Markets and events](https://docs.polymarket.com/concepts/markets-events) —
  slug-based Gamma event discovery and market identifiers.
- [RTDS WebSocket](https://docs.polymarket.com/market-data/websocket/rtds) —
  real-time Chainlink crypto price stream used as the latency/reliability
  baseline.
- [CLOB order and trade methods](https://docs.polymarket.com/developers/CLOB/orders/cancel-orders) —
  cancel response shape, open orders, and authenticated trade history.
- [CLOB V2 migration](https://docs.polymarket.com/v2-migration) —
  current production order format, V2 signatures, and removed V1 order fields.
- [CLOB user channel](https://docs.polymarket.com/market-data/websocket/user-channel) —
  authenticated fill/order updates scoped by condition IDs.
- [WebSocket quickstart](https://docs.polymarket.com/quickstart/websocket/WSS-Quickstart) —
  channel list and subscription shapes.

## Current Assumptions

- 5-minute crypto event slugs use
  `<asset>-updown-5m-<windowStartUnixSeconds>`. `discoverPolymarketMarket`
  reads `GET /events?slug=<slug>` and expects a binary `Up` / `Down` market
  with two CLOB token IDs. It then hydrates venue order constraints from
  `GET /clob-markets/<conditionId>`.
- The TypeScript integration uses `@polymarket/clob-client-v2`. Live order
  creation must stay on the V2 signed-order shape: no submitted order nonce and
  no embedded `feeRateBps`; fee fields are read from venue market metadata and
  historical trades.
- RTDS `crypto_prices_chainlink` frames provide the Chainlink-derived crypto
  reference prices. The latency experiment filters that topic to `btc/usd`;
  the reliability experiment maps every requested `<asset>/usd` symbol.
- CLOB `/book?token_id=<tokenId>` is public and returns bid/ask level arrays
  with string prices and sizes. Alea scans levels and picks best bid/ask
  rather than trusting array order. Book responses also carry
  `min_order_size`, `tick_size`, and `neg_risk`; the adapter merges those with
  the `/clob-markets` metadata before placement.
- Live order placement is maker-only and GTD. The adapter floors prices to the
  venue tick, rejects sizes below the venue minimum, signs a V2 BUY order with
  a pre-close expiration, and posts it as
  `postOrder(order, OrderType.GTD, true, false)` where the third argument is
  `postOnly`. Polymarket does not expose a stable machine-readable post-only
  rejection code through the TypeScript client, so the adapter translates known
  rejection phrases into
  `PostOnlyRejectionError`.
- The user WebSocket subscription uses `markets` populated with condition IDs,
  not token IDs. Fill frames are normalized into Alea's vendor-agnostic
  `FillEvent` shape. The stream sends `PING` heartbeats, ignores `PONG`, and
  handles V2 `maker_orders` frames that omit top-level fill price/size fields.
- CLOB trade fees are normalized from the venue's fee curve:
  `shares * (fee_rate_bps / 10000) * price * (1 - price)`, rounded to five
  decimal places. Trades reported as `trader_side=MAKER` are treated as
  zero-fee, matching Polymarket's current fee model.
