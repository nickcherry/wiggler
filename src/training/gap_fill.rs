use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use sqlx::PgPool;

use crate::domain::asset::Asset;

const TIMEFRAME: &str = "1m";
const TARGET_SOURCE: &str = "coinbase";
const FILL_SOURCE: &str = "binance";
const FILL_REASON: &str = "coinbase_source_missing";

pub struct GapFillResult {
    pub asset: Asset,
    pub rows_written: u64,
}

pub async fn fill_coinbase_from_binance(
    pool: &PgPool,
    assets: &[Asset],
    from: DateTime<Utc>,
    to: DateTime<Utc>,
) -> Result<Vec<GapFillResult>> {
    let mut results = Vec::new();
    for asset in assets {
        let asset_code = asset_code(*asset);
        let exchange_pair = asset
            .coinbase_product_id()
            .context("asset has no Coinbase product id")?;
        let result = sqlx::query(
            r#"
WITH expected AS (
    SELECT gs.open_time
    FROM generate_series($3::timestamptz, $4::timestamptz - interval '1 minute', interval '1 minute')
        AS gs(open_time)
),
missing AS (
    SELECT expected.open_time
    FROM expected
    LEFT JOIN candles target
      ON target.source = $1
     AND target.asset = $5
     AND target.timeframe = $6
     AND target.open_time = expected.open_time
    WHERE target.open_time IS NULL
)
INSERT INTO candles (
    source, asset, exchange_pair, timeframe, open_time, open_time_ms,
    open_e8, high_e8, low_e8, close_e8, volume_e8, trades, fetched_at,
    is_synthetic, filled_from_source, fill_reason
)
SELECT
    $1 AS source,
    fill.asset,
    $7 AS exchange_pair,
    fill.timeframe,
    fill.open_time,
    fill.open_time_ms,
    fill.open_e8,
    fill.high_e8,
    fill.low_e8,
    fill.close_e8,
    NULL::BIGINT AS volume_e8,
    NULL::INTEGER AS trades,
    now() AS fetched_at,
    true AS is_synthetic,
    $2 AS filled_from_source,
    $8 AS fill_reason
FROM missing
JOIN candles fill
  ON fill.source = $2
 AND fill.asset = $5
 AND fill.timeframe = $6
 AND fill.open_time = missing.open_time
ON CONFLICT (source, asset, timeframe, open_time) DO UPDATE SET
    exchange_pair = EXCLUDED.exchange_pair,
    open_time_ms = EXCLUDED.open_time_ms,
    open_e8 = EXCLUDED.open_e8,
    high_e8 = EXCLUDED.high_e8,
    low_e8 = EXCLUDED.low_e8,
    close_e8 = EXCLUDED.close_e8,
    volume_e8 = EXCLUDED.volume_e8,
    trades = EXCLUDED.trades,
    fetched_at = EXCLUDED.fetched_at,
    is_synthetic = EXCLUDED.is_synthetic,
    filled_from_source = EXCLUDED.filled_from_source,
    fill_reason = EXCLUDED.fill_reason
"#,
        )
        .bind(TARGET_SOURCE)
        .bind(FILL_SOURCE)
        .bind(from)
        .bind(to)
        .bind(&asset_code)
        .bind(TIMEFRAME)
        .bind(exchange_pair)
        .bind(FILL_REASON)
        .execute(pool)
        .await
        .with_context(|| format!("fill Coinbase gaps for {asset} from Binance"))?;

        results.push(GapFillResult {
            asset: *asset,
            rows_written: result.rows_affected(),
        });
    }
    Ok(results)
}

fn asset_code(asset: Asset) -> String {
    asset.slug_code().to_ascii_uppercase()
}
