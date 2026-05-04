/**
 * Polymarket protocol constants.
 *
 * These values are intentionally hard-coded — they are not configurable per
 * deployment. Changing the chain id, the L1 nonce, or the signature type would
 * silently invalidate every previously-derived API key, and the URL set is
 * effectively part of the protocol surface. The only env-var inputs are the
 * wallet private key and the funder (proxy/safe) address; see
 * `src/constants/env.ts`.
 */

import { Chain, SignatureType } from "@polymarket/clob-client";

export const polymarket = {
  chainId: Chain.POLYGON,
  /**
   * Wallet-scoped nonce mixed into the L1 EIP-712 payload. (apiKey, secret,
   * passphrase) is deterministic in `(address, nonce)`, and we only ever use
   * `0` so the same wallet always derives the same bundle.
   */
  apiKeyNonce: 0,
  /**
   * Polymarket gnosis-safe proxy signature scheme. The funder address must be
   * the safe (proxy) wallet, not the EOA that signs.
   */
  signatureType: SignatureType.POLY_GNOSIS_SAFE,
  clobApiUrl: "https://clob.polymarket.com",
  gammaApiUrl: "https://gamma-api.polymarket.com",
  marketWsUrl: "wss://ws-subscriptions-clob.polymarket.com/ws/market",
  userWsUrl: "wss://ws-subscriptions-clob.polymarket.com/ws/user",
  rtdsWsUrl: "wss://ws-live-data.polymarket.com",
} as const;
