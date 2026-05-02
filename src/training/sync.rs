use std::{collections::HashMap, fmt, sync::Arc, time::Duration};

use anyhow::{Context, Result, anyhow, bail};
use chrono::{DateTime, TimeZone, Utc};
use reqwest::Client;
use sqlx::PgPool;
use tokio::{sync::Semaphore, time};
use tracing::info;
use uuid::Uuid;

use crate::domain::asset::Asset;

const TIMEFRAME: &str = "1m";
const TIMEFRAME_MS: i64 = 60_000;
const BINANCE_LIMIT: i64 = 1000;
const COINBASE_LIMIT: i64 = 300;

mod source;
mod store;

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub enum TrainingSource {
    Coinbase,
    Binance,
}

impl TrainingSource {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Coinbase => "coinbase",
            Self::Binance => "binance",
        }
    }
}

impl fmt::Display for TrainingSource {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

#[derive(Clone)]
pub struct SyncOptions {
    pub assets: Vec<Asset>,
    pub sources: Vec<TrainingSource>,
    pub from: DateTime<Utc>,
    pub to: DateTime<Utc>,
    pub force_full_range: bool,
    pub concurrency_per_source: usize,
    pub request_delay: Duration,
    pub coinbase_api_base_url: String,
    pub binance_api_base_url: String,
}

#[derive(Clone, Debug)]
pub struct SyncSeriesResult {
    pub source: TrainingSource,
    pub asset: Asset,
    pub rows_upserted: u64,
    pub already_current: bool,
    pub status: SyncStatus,
    pub error: Option<String>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SyncStatus {
    Completed,
    Failed,
}

impl SyncStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Completed => "completed",
            Self::Failed => "failed",
        }
    }
}

pub async fn sync_many(pool: PgPool, options: SyncOptions) -> Result<Vec<SyncSeriesResult>> {
    if options.assets.is_empty() {
        bail!("at least one asset is required");
    }
    if options.sources.is_empty() {
        bail!("at least one source is required");
    }
    if options.concurrency_per_source == 0 {
        bail!("--concurrency-per-source must be positive");
    }

    let from = floor_to_minute(options.from)?;
    let to = floor_to_minute(options.to)?;
    if from >= to {
        bail!("sync window has no fully closed 1-minute candles");
    }

    let client = Client::new();
    let mut semaphores = HashMap::new();
    for source in &options.sources {
        semaphores.insert(
            *source,
            Arc::new(Semaphore::new(options.concurrency_per_source)),
        );
    }

    let mut handles = Vec::new();
    for source in &options.sources {
        for asset in &options.assets {
            let source = *source;
            let asset = *asset;
            let pool = pool.clone();
            let client = client.clone();
            let permit_source = semaphores
                .get(&source)
                .expect("source semaphore exists")
                .clone();
            let options = options.clone();
            handles.push(tokio::spawn(async move {
                let _permit = permit_source
                    .acquire_owned()
                    .await
                    .expect("semaphore should not be closed");
                sync_series(
                    &pool,
                    &client,
                    SeriesOptions {
                        source,
                        asset,
                        from,
                        to,
                        force_full_range: options.force_full_range,
                        request_delay: options.request_delay,
                        coinbase_api_base_url: options.coinbase_api_base_url,
                        binance_api_base_url: options.binance_api_base_url,
                    },
                )
                .await
            }));
        }
    }

    let mut results = Vec::new();
    for handle in handles {
        results.push(handle.await.context("join candle sync task")?);
    }
    results.sort_by_key(|result| (result.source.as_str(), result.asset));
    Ok(results)
}

#[derive(Clone)]
struct SeriesOptions {
    source: TrainingSource,
    asset: Asset,
    from: DateTime<Utc>,
    to: DateTime<Utc>,
    force_full_range: bool,
    request_delay: Duration,
    coinbase_api_base_url: String,
    binance_api_base_url: String,
}

async fn sync_series(pool: &PgPool, client: &Client, options: SeriesOptions) -> SyncSeriesResult {
    match sync_series_inner(pool, client, &options).await {
        Ok(result) => result,
        Err(error) => SyncSeriesResult {
            source: options.source,
            asset: options.asset,
            rows_upserted: 0,
            already_current: false,
            status: SyncStatus::Failed,
            error: Some(format!("{error:#}")),
        },
    }
}

async fn sync_series_inner(
    pool: &PgPool,
    client: &Client,
    options: &SeriesOptions,
) -> Result<SyncSeriesResult> {
    if options.source == TrainingSource::Coinbase && options.asset.coinbase_product_id().is_none() {
        return Ok(SyncSeriesResult {
            source: options.source,
            asset: options.asset,
            rows_upserted: 0,
            already_current: true,
            status: SyncStatus::Completed,
            error: None,
        });
    }

    let from_ms = options.from.timestamp_millis();
    let to_ms = options.to.timestamp_millis();
    let resume_from_ms = if options.force_full_range {
        from_ms
    } else {
        store::resume_from_ms(pool, options.source, options.asset, from_ms, to_ms).await?
    };

    if resume_from_ms >= to_ms {
        return Ok(SyncSeriesResult {
            source: options.source,
            asset: options.asset,
            rows_upserted: 0,
            already_current: true,
            status: SyncStatus::Completed,
            error: None,
        });
    }

    let run_id = Uuid::new_v4().to_string();
    store::start_run(
        pool,
        &run_id,
        options.source,
        options.asset,
        options.to,
        resume_from_ms,
    )
    .await?;
    info!(
        source = %options.source,
        asset = %options.asset,
        from_ms = resume_from_ms,
        to_ms,
        "offline candle sync started"
    );

    let mut rows_upserted = 0_u64;
    let result = async {
        match options.source {
            TrainingSource::Coinbase => {
                sync_coinbase(
                    pool,
                    client,
                    options,
                    resume_from_ms,
                    to_ms,
                    &mut rows_upserted,
                )
                .await
            }
            TrainingSource::Binance => {
                sync_binance(
                    pool,
                    client,
                    options,
                    resume_from_ms,
                    to_ms,
                    &mut rows_upserted,
                )
                .await
            }
        }
    }
    .await;

    match result {
        Ok(()) => {
            store::finish_run(pool, &run_id, SyncStatus::Completed, rows_upserted, None).await?;
            info!(
                source = %options.source,
                asset = %options.asset,
                rows_upserted,
                "offline candle sync completed"
            );
            Ok(SyncSeriesResult {
                source: options.source,
                asset: options.asset,
                rows_upserted,
                already_current: false,
                status: SyncStatus::Completed,
                error: None,
            })
        }
        Err(error) => {
            let message = format!("{error:#}");
            store::finish_run(
                pool,
                &run_id,
                SyncStatus::Failed,
                rows_upserted,
                Some(&message),
            )
            .await?;
            Ok(SyncSeriesResult {
                source: options.source,
                asset: options.asset,
                rows_upserted,
                already_current: false,
                status: SyncStatus::Failed,
                error: Some(message),
            })
        }
    }
}

async fn sync_coinbase(
    pool: &PgPool,
    client: &Client,
    options: &SeriesOptions,
    mut cursor_ms: i64,
    to_ms: i64,
    rows_upserted: &mut u64,
) -> Result<()> {
    let product_id = options
        .asset
        .coinbase_product_id()
        .context("asset has no Coinbase product id")?;
    let chunk_ms = COINBASE_LIMIT * TIMEFRAME_MS;
    while cursor_ms < to_ms {
        let chunk_end_ms = (cursor_ms + chunk_ms).min(to_ms);
        let candles = source::fetch_coinbase_chunk(
            client,
            &options.coinbase_api_base_url,
            options.asset,
            product_id,
            cursor_ms,
            chunk_end_ms,
        )
        .await?;
        *rows_upserted += store::upsert_candles(pool, &candles).await?;
        cursor_ms = chunk_end_ms;
        time::sleep(options.request_delay).await;
    }
    Ok(())
}

async fn sync_binance(
    pool: &PgPool,
    client: &Client,
    options: &SeriesOptions,
    mut cursor_ms: i64,
    to_ms: i64,
    rows_upserted: &mut u64,
) -> Result<()> {
    let pair = options.asset.binance_symbol().to_ascii_uppercase();
    let chunk_ms = BINANCE_LIMIT * TIMEFRAME_MS;
    while cursor_ms < to_ms {
        let chunk_end_ms = (cursor_ms + chunk_ms).min(to_ms);
        let candles = source::fetch_binance_chunk(
            client,
            &options.binance_api_base_url,
            options.asset,
            &pair,
            cursor_ms,
            chunk_end_ms,
            BINANCE_LIMIT,
        )
        .await?;
        let last_open_ms = candles
            .iter()
            .map(|candle| candle.open_time_ms)
            .max()
            .unwrap_or(cursor_ms);
        *rows_upserted += store::upsert_candles(pool, &candles).await?;
        cursor_ms = if candles.is_empty() {
            chunk_end_ms
        } else {
            (last_open_ms + TIMEFRAME_MS).min(chunk_end_ms)
        };
        time::sleep(options.request_delay).await;
    }
    Ok(())
}

#[derive(Clone, Debug)]
struct TrainingCandle {
    source: TrainingSource,
    asset: Asset,
    exchange_pair: String,
    open_time: DateTime<Utc>,
    open_time_ms: i64,
    open_e8: i64,
    high_e8: i64,
    low_e8: i64,
    close_e8: i64,
    volume_e8: Option<i64>,
    trades: Option<i32>,
}

fn floor_to_minute(value: DateTime<Utc>) -> Result<DateTime<Utc>> {
    let seconds = value.timestamp().div_euclid(60) * 60;
    DateTime::from_timestamp(seconds, 0).context("minute timestamp out of range")
}

fn datetime_from_millis(value: i64) -> Result<DateTime<Utc>> {
    Utc.timestamp_millis_opt(value)
        .single()
        .ok_or_else(|| anyhow!("timestamp millis out of range: {value}"))
}

fn asset_code(asset: Asset) -> String {
    asset.slug_code().to_ascii_uppercase()
}
