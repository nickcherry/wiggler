/**
 * One captured market-data event. The shape mirrors the
 * `market_event` table 1:1 so the JSONL → Postgres ingester can map
 * fields without a translation step.
 *
 * `tsMs` is the venue's clock when known (Binance bookTicker `T`,
 * Polymarket `timestamp`, etc.); it falls back to `receivedMs` when
 * the venue doesn't surface its own timestamp. Keeping both columns
 * separate is deliberate — research can spot venue clock skew and
 * inter-venue latency by their delta.
 *
 * `kind` is intentionally a free string rather than a TS union: each
 * source has its own vocabulary (Polymarket has `book`/`trade`/
 * `price-change`/`tick-size-change`/`resolved`; Binance has
 * `bbo`/`kline-close`; we add `connect`/`disconnect`/`resync` for
 * stream-state markers). Constraining at the type level would either
 * be a giant union or hide ambiguity at the source-selection layer.
 *
 * `payload` is the full venue-side event, kept verbatim. Mapping to
 * a normalized schema would force us to make decisions before we
 * know which fields matter for research. Leaving it as JSONB defers
 * those decisions.
 */
export type CaptureRecord = {
  readonly tsMs: number;
  readonly receivedMs: number;
  readonly source: string;
  readonly asset: string | null;
  readonly kind: string;
  readonly marketRef: string | null;
  readonly payload: Record<string, unknown>;
};
