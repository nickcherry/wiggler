use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use sqlx::{PgPool, Postgres, QueryBuilder};

use crate::domain::asset::Asset;

use super::{
    SyncStatus, TIMEFRAME, TIMEFRAME_MS, TrainingCandle, TrainingSource, asset_code,
    datetime_from_millis,
};

const COVERAGE_COMPLETE_THRESHOLD_NUMERATOR: i64 = 95;
const COVERAGE_COMPLETE_THRESHOLD_DENOMINATOR: i64 = 100;

pub(super) async fn resume_from_ms(
    pool: &PgPool,
    source: TrainingSource,
    asset: Asset,
    from_ms: i64,
    to_ms: i64,
) -> Result<i64> {
    let (earliest_ms, latest_ms, row_count): (Option<i64>, Option<i64>, i64) = sqlx::query_as(
        r#"
SELECT
    MIN(open_time_ms) AS earliest_ms,
    MAX(open_time_ms) AS latest_ms,
    COUNT(*)::BIGINT AS row_count
FROM candles
WHERE source = $1
  AND asset = $2
  AND timeframe = $3
  AND open_time_ms >= $4
  AND open_time_ms < $5
"#,
    )
    .bind(source.as_str())
    .bind(asset_code(asset))
    .bind(TIMEFRAME)
    .bind(from_ms)
    .bind(to_ms)
    .fetch_one(pool)
    .await
    .context("load candle coverage")?;

    let Some(earliest_ms) = earliest_ms else {
        return Ok(from_ms);
    };
    let Some(latest_ms) = latest_ms else {
        return Ok(from_ms);
    };

    let expected_rows = ((to_ms - from_ms) / TIMEFRAME_MS).max(1);
    let older_edge_covered = earliest_ms <= from_ms + TIMEFRAME_MS;
    let no_significant_gaps = row_count * COVERAGE_COMPLETE_THRESHOLD_DENOMINATOR
        >= expected_rows * COVERAGE_COMPLETE_THRESHOLD_NUMERATOR;

    if older_edge_covered && no_significant_gaps {
        Ok((latest_ms + TIMEFRAME_MS).max(from_ms))
    } else {
        Ok(from_ms)
    }
}

pub(super) async fn start_run(
    pool: &PgPool,
    run_id: &str,
    source: TrainingSource,
    asset: Asset,
    to: DateTime<Utc>,
    resume_from_ms: i64,
) -> Result<()> {
    sqlx::query(
        r#"
INSERT INTO candle_sync_runs
    (run_id, source, asset, timeframe, from_ts, to_ts, started_at, status)
VALUES
    ($1, $2, $3, $4, $5, $6, now(), 'running')
"#,
    )
    .bind(run_id)
    .bind(source.as_str())
    .bind(asset_code(asset))
    .bind(TIMEFRAME)
    .bind(datetime_from_millis(resume_from_ms)?)
    .bind(to)
    .execute(pool)
    .await
    .context("start candle sync run")?;
    Ok(())
}

pub(super) async fn finish_run(
    pool: &PgPool,
    run_id: &str,
    status: SyncStatus,
    rows_upserted: u64,
    error: Option<&str>,
) -> Result<()> {
    sqlx::query(
        r#"
UPDATE candle_sync_runs
SET finished_at = now(), status = $2, rows_upserted = $3, error = $4
WHERE run_id = $1
"#,
    )
    .bind(run_id)
    .bind(status.as_str())
    .bind(i64::try_from(rows_upserted).context("rows_upserted exceeds i64")?)
    .bind(error)
    .execute(pool)
    .await
    .context("finish candle sync run")?;
    Ok(())
}

pub(super) async fn upsert_candles(pool: &PgPool, candles: &[TrainingCandle]) -> Result<u64> {
    if candles.is_empty() {
        return Ok(0);
    }

    let mut builder = QueryBuilder::<Postgres>::new(
        r#"
INSERT INTO candles (
    source, asset, exchange_pair, timeframe, open_time, open_time_ms,
    open_e8, high_e8, low_e8, close_e8, volume_e8, trades, fetched_at,
    is_synthetic, filled_from_source, fill_reason
)
"#,
    );
    builder.push_values(candles, |mut row, candle| {
        row.push_bind(candle.source.as_str())
            .push_bind(asset_code(candle.asset))
            .push_bind(candle.exchange_pair.as_str())
            .push_bind(TIMEFRAME)
            .push_bind(candle.open_time)
            .push_bind(candle.open_time_ms)
            .push_bind(candle.open_e8)
            .push_bind(candle.high_e8)
            .push_bind(candle.low_e8)
            .push_bind(candle.close_e8)
            .push_bind(candle.volume_e8)
            .push_bind(candle.trades)
            .push_bind(Utc::now())
            .push_bind(false)
            .push_bind(Option::<&str>::None)
            .push_bind(Option::<&str>::None);
    });
    builder.push(
        r#"
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
    );
    let result = builder
        .build()
        .execute(pool)
        .await
        .context("upsert candles")?;
    Ok(result.rows_affected())
}
