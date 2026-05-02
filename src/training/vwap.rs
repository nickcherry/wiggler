use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use sqlx::PgPool;

use crate::domain::asset::Asset;

const TIMEFRAME: &str = "1m";

pub struct VwapResult {
    pub asset: Asset,
    pub rows_written: u64,
}

pub async fn recompute_vwap(
    pool: &PgPool,
    assets: &[Asset],
    from: DateTime<Utc>,
    to: DateTime<Utc>,
) -> Result<Vec<VwapResult>> {
    let mut results = Vec::new();
    for asset in assets {
        let asset_code = asset_code(*asset);
        let mut transaction = pool.begin().await.context("begin vwap transaction")?;
        sqlx::query(
            r#"
DELETE FROM candle_vwap
WHERE asset = $1
  AND timeframe = $2
  AND open_time >= $3
  AND open_time < $4
"#,
        )
        .bind(&asset_code)
        .bind(TIMEFRAME)
        .bind(from)
        .bind(to)
        .execute(&mut *transaction)
        .await
        .context("delete old vwap rows")?;

        let result = sqlx::query(
            r#"
INSERT INTO candle_vwap (
    asset, timeframe, open_time, open_time_ms,
    vwap_e8, total_volume_e8, source_count, computed_at
)
SELECT
    asset,
    timeframe,
    open_time,
    open_time_ms,
    CASE
        WHEN SUM(CASE WHEN volume_e8 IS NOT NULL AND volume_e8 > 0 THEN volume_e8::numeric ELSE 0 END) > 0 THEN
            ROUND(
                SUM(CASE WHEN volume_e8 IS NOT NULL AND volume_e8 > 0
                    THEN ((high_e8 + low_e8 + close_e8)::numeric / 3.0) * volume_e8::numeric
                    ELSE 0 END)
                / SUM(CASE WHEN volume_e8 IS NOT NULL AND volume_e8 > 0 THEN volume_e8::numeric ELSE 0 END)
            )::BIGINT
        ELSE
            ROUND(AVG((high_e8 + low_e8 + close_e8)::numeric / 3.0))::BIGINT
    END AS vwap_e8,
    COALESCE(
        SUM(CASE WHEN volume_e8 IS NOT NULL AND volume_e8 > 0 THEN volume_e8 ELSE 0 END),
        0
    )::BIGINT AS total_volume_e8,
    COUNT(*)::SMALLINT AS source_count,
    now()
FROM candles
WHERE asset = $1
  AND timeframe = $2
  AND open_time >= $3
  AND open_time < $4
  AND NOT is_synthetic
GROUP BY asset, timeframe, open_time, open_time_ms
"#,
        )
        .bind(&asset_code)
        .bind(TIMEFRAME)
        .bind(from)
        .bind(to)
        .execute(&mut *transaction)
        .await
        .context("insert vwap rows")?;

        transaction
            .commit()
            .await
            .context("commit vwap transaction")?;
        results.push(VwapResult {
            asset: *asset,
            rows_written: result.rows_affected(),
        });
    }
    Ok(results)
}

fn asset_code(asset: Asset) -> String {
    asset.slug_code().to_ascii_uppercase()
}
