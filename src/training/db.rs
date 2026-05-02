use anyhow::{Context, Result};
use sqlx::{PgPool, postgres::PgPoolOptions};

pub async fn connect(database_url: &str) -> Result<PgPool> {
    PgPoolOptions::new()
        .max_connections(8)
        .connect(database_url)
        .await
        .context("connect to offline training Postgres database")
}

pub async fn ensure_schema(pool: &PgPool) -> Result<()> {
    for statement in SCHEMA_STATEMENTS {
        sqlx::query(statement)
            .execute(pool)
            .await
            .with_context(|| format!("execute schema statement: {statement}"))?;
    }
    Ok(())
}

pub async fn reset_schema(pool: &PgPool) -> Result<()> {
    for statement in RESET_STATEMENTS {
        sqlx::query(statement)
            .execute(pool)
            .await
            .with_context(|| format!("execute reset statement: {statement}"))?;
    }
    Ok(())
}

const RESET_STATEMENTS: &[&str] = &[
    "DROP TABLE IF EXISTS candle_vwap",
    "DROP TABLE IF EXISTS candle_sync_runs",
    "DROP TABLE IF EXISTS candles",
];

const SCHEMA_STATEMENTS: &[&str] = &[
    r#"
CREATE TABLE IF NOT EXISTS candles (
    source TEXT NOT NULL,
    asset TEXT NOT NULL,
    exchange_pair TEXT NOT NULL,
    timeframe TEXT NOT NULL,
    open_time TIMESTAMPTZ NOT NULL,
    open_time_ms BIGINT NOT NULL,
    open_e8 BIGINT NOT NULL,
    high_e8 BIGINT NOT NULL,
    low_e8 BIGINT NOT NULL,
    close_e8 BIGINT NOT NULL,
    volume_e8 BIGINT,
    trades INTEGER,
    fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    is_synthetic BOOLEAN NOT NULL DEFAULT false,
    filled_from_source TEXT,
    fill_reason TEXT,
    PRIMARY KEY (source, asset, timeframe, open_time)
)
"#,
    r#"
ALTER TABLE candles
    ADD COLUMN IF NOT EXISTS is_synthetic BOOLEAN NOT NULL DEFAULT false
"#,
    r#"
ALTER TABLE candles
    ADD COLUMN IF NOT EXISTS filled_from_source TEXT
"#,
    r#"
ALTER TABLE candles
    ADD COLUMN IF NOT EXISTS fill_reason TEXT
"#,
    r#"
CREATE INDEX IF NOT EXISTS candles_asset_time_idx
    ON candles (asset, timeframe, open_time)
"#,
    r#"
CREATE INDEX IF NOT EXISTS candles_source_asset_idx
    ON candles (source, asset, timeframe)
"#,
    r#"
CREATE TABLE IF NOT EXISTS candle_sync_runs (
    id BIGSERIAL PRIMARY KEY,
    run_id TEXT NOT NULL UNIQUE,
    source TEXT NOT NULL,
    asset TEXT NOT NULL,
    timeframe TEXT NOT NULL,
    from_ts TIMESTAMPTZ NOT NULL,
    to_ts TIMESTAMPTZ NOT NULL,
    started_at TIMESTAMPTZ NOT NULL,
    finished_at TIMESTAMPTZ,
    status TEXT NOT NULL,
    rows_upserted BIGINT NOT NULL DEFAULT 0,
    error TEXT
)
"#,
    r#"
CREATE INDEX IF NOT EXISTS candle_sync_runs_source_started_idx
    ON candle_sync_runs (source, asset, timeframe, started_at)
"#,
    r#"
CREATE TABLE IF NOT EXISTS candle_vwap (
    asset TEXT NOT NULL,
    timeframe TEXT NOT NULL,
    open_time TIMESTAMPTZ NOT NULL,
    open_time_ms BIGINT NOT NULL,
    vwap_e8 BIGINT NOT NULL,
    total_volume_e8 BIGINT NOT NULL,
    source_count SMALLINT NOT NULL,
    computed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (asset, timeframe, open_time)
)
"#,
];
