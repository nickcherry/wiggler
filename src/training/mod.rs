use std::time::Duration;

use anyhow::{Context, Result, bail};
use chrono::{DateTime, TimeDelta, Utc};
use tracing::info;

use crate::{
    domain::asset::{format_assets, normalize_assets},
    training::cli::{
        TrainingBuildRuntimeArgs, TrainingCommand, TrainingDbArgs, TrainingFillGapsArgs,
        TrainingRefreshRuntimeArgs, TrainingResetArgs, TrainingSourceArg, TrainingSyncArgs,
        TrainingVwapArgs,
    },
};

pub mod cli;
mod db;
mod gap_fill;
mod grid;
mod runtime_bundle;
mod sync;
mod vwap;

pub async fn run(command: TrainingCommand) -> Result<()> {
    match command {
        TrainingCommand::Migrate(args) => migrate(args).await,
        TrainingCommand::Reset(args) => reset(args).await,
        TrainingCommand::Sync(args) => sync(args).await,
        TrainingCommand::Vwap(args) => vwap(args).await,
        TrainingCommand::FillGaps(args) => fill_gaps(args).await,
        TrainingCommand::BuildRuntime(args) => build_runtime(args).await,
        TrainingCommand::RefreshRuntime(args) => refresh_runtime(args).await,
    }
}

async fn migrate(args: TrainingDbArgs) -> Result<()> {
    let pool = db::connect(&args.database_url).await?;
    db::ensure_schema(&pool).await?;
    info!("offline training schema is ready");
    println!("offline training schema is ready");
    Ok(())
}

async fn reset(args: TrainingResetArgs) -> Result<()> {
    if !args.yes {
        bail!("training reset is destructive; pass --yes to confirm");
    }

    let pool = db::connect(&args.database_url).await?;
    db::reset_schema(&pool).await?;
    db::ensure_schema(&pool).await?;
    println!("offline training tables were reset");
    Ok(())
}

async fn sync(args: TrainingSyncArgs) -> Result<()> {
    let assets = normalize_assets(args.assets);
    let sources = sources_from_args(&args.sources);
    let window = training_window(
        args.from_iso.as_deref(),
        args.to_iso.as_deref(),
        args.since_days,
    )?;
    let pool = db::connect(&args.database_url).await?;
    db::ensure_schema(&pool).await?;

    let results = sync::sync_many(
        pool,
        sync::SyncOptions {
            assets,
            sources,
            from: window.from,
            to: window.to,
            force_full_range: args.force_full_range,
            concurrency_per_source: args.concurrency_per_source,
            request_delay: Duration::from_millis(args.request_delay_ms),
            coinbase_api_base_url: args.coinbase_api_base_url,
            binance_api_base_url: args.binance_api_base_url,
        },
    )
    .await?;

    print_sync_summary(&results);
    if results
        .iter()
        .any(|result| result.status == sync::SyncStatus::Failed)
    {
        bail!("one or more candle sync series failed");
    }
    Ok(())
}

async fn vwap(args: TrainingVwapArgs) -> Result<()> {
    let assets = normalize_assets(args.assets);
    let window = training_window(
        args.from_iso.as_deref(),
        args.to_iso.as_deref(),
        args.since_days,
    )?;
    let pool = db::connect(&args.database_url).await?;
    db::ensure_schema(&pool).await?;
    let results = vwap::recompute_vwap(&pool, &assets, window.from, window.to).await?;
    print_vwap_summary(&results);
    Ok(())
}

async fn fill_gaps(args: TrainingFillGapsArgs) -> Result<()> {
    let assets = normalize_assets(args.assets);
    let window = training_window(
        args.from_iso.as_deref(),
        args.to_iso.as_deref(),
        args.since_days,
    )?;
    let pool = db::connect(&args.database_url).await?;
    db::ensure_schema(&pool).await?;
    let results =
        gap_fill::fill_coinbase_from_binance(&pool, &assets, window.from, window.to).await?;
    print_gap_fill_summary(&results);
    Ok(())
}

async fn build_runtime(args: TrainingBuildRuntimeArgs) -> Result<()> {
    let assets = normalize_assets(args.assets);
    let window = training_window(
        args.from_iso.as_deref(),
        args.to_iso.as_deref(),
        args.since_days,
    )?;
    let pool = db::connect(&args.database_url).await?;
    db::ensure_schema(&pool).await?;
    let result = runtime_bundle::build_runtime_bundle(
        &pool,
        runtime_bundle::BuildRuntimeOptions {
            assets,
            output_dir: args.output_dir,
            from: window.from,
            to: window.to,
            taker_fee_rate: args.taker_fee_rate,
            min_edge_probability: args.min_edge_probability,
            min_bucket_count: args.min_bucket_count,
            max_position_usdc: args.max_position_usdc,
        },
    )
    .await?;
    print_runtime_summary(&result);
    Ok(())
}

async fn refresh_runtime(args: TrainingRefreshRuntimeArgs) -> Result<()> {
    if args.since_days <= 0 {
        bail!("--since-days must be positive");
    }
    let assets = normalize_assets(args.assets);
    let to = floor_to_minute(parse_optional_iso(args.to_iso.as_deref())?.unwrap_or_else(Utc::now))?;
    let from = to - TimeDelta::days(args.since_days);
    let pool = db::connect(&args.database_url).await?;
    db::ensure_schema(&pool).await?;

    let sync_results = sync::sync_many(
        pool.clone(),
        sync::SyncOptions {
            assets: assets.clone(),
            sources: vec![
                sync::TrainingSource::Coinbase,
                sync::TrainingSource::Binance,
            ],
            from,
            to,
            force_full_range: args.force_full_range,
            concurrency_per_source: args.concurrency_per_source,
            request_delay: Duration::from_millis(args.request_delay_ms),
            coinbase_api_base_url: args.coinbase_api_base_url,
            binance_api_base_url: args.binance_api_base_url,
        },
    )
    .await?;
    print_sync_summary(&sync_results);
    if sync_results
        .iter()
        .any(|result| result.status == sync::SyncStatus::Failed)
    {
        bail!("one or more candle sync series failed; refusing to build runtime bundle");
    }

    let gap_fill_results = gap_fill::fill_coinbase_from_binance(&pool, &assets, from, to).await?;
    print_gap_fill_summary(&gap_fill_results);

    let vwap_results = vwap::recompute_vwap(&pool, &assets, from, to).await?;
    print_vwap_summary(&vwap_results);

    let runtime_result = runtime_bundle::build_runtime_bundle(
        &pool,
        runtime_bundle::BuildRuntimeOptions {
            assets,
            output_dir: args.output_dir,
            from,
            to,
            taker_fee_rate: args.taker_fee_rate,
            min_edge_probability: args.min_edge_probability,
            min_bucket_count: args.min_bucket_count,
            max_position_usdc: args.max_position_usdc,
        },
    )
    .await?;
    print_runtime_summary(&runtime_result);
    Ok(())
}

fn sources_from_args(values: &[TrainingSourceArg]) -> Vec<sync::TrainingSource> {
    values
        .iter()
        .map(|source| match source {
            TrainingSourceArg::Coinbase => sync::TrainingSource::Coinbase,
            TrainingSourceArg::Binance => sync::TrainingSource::Binance,
        })
        .collect()
}

#[derive(Clone, Copy)]
struct Window {
    from: DateTime<Utc>,
    to: DateTime<Utc>,
}

fn training_window(
    from_iso: Option<&str>,
    to_iso: Option<&str>,
    since_days: i64,
) -> Result<Window> {
    if since_days <= 0 {
        bail!("--since-days must be positive");
    }
    let to = floor_to_minute(parse_optional_iso(to_iso)?.unwrap_or_else(Utc::now))?;
    let from = match parse_optional_iso(from_iso)? {
        Some(from) => from,
        None => to - TimeDelta::days(since_days),
    };
    let from = floor_to_minute(from)?;
    if from >= to {
        bail!("training window start must be before end");
    }
    Ok(Window { from, to })
}

fn floor_to_minute(value: DateTime<Utc>) -> Result<DateTime<Utc>> {
    let seconds = value.timestamp().div_euclid(60) * 60;
    DateTime::from_timestamp(seconds, 0).context("minute timestamp out of range")
}

fn parse_optional_iso(value: Option<&str>) -> Result<Option<DateTime<Utc>>> {
    value
        .map(|value| {
            DateTime::parse_from_rfc3339(value)
                .map(|dt| dt.with_timezone(&Utc))
                .with_context(|| format!("parse RFC3339 timestamp {value}"))
        })
        .transpose()
}

fn print_sync_summary(results: &[sync::SyncSeriesResult]) {
    println!("source     asset  status     rows_upserted  note");
    for result in results {
        let note = result
            .error
            .as_deref()
            .unwrap_or(if result.already_current {
                "already current"
            } else {
                ""
            });
        println!(
            "{:<10} {:<5}  {:<9}  {:>13}  {}",
            result.source.as_str(),
            result.asset,
            result.status.as_str(),
            result.rows_upserted,
            note
        );
    }
}

fn print_vwap_summary(results: &[vwap::VwapResult]) {
    println!("asset  vwap_rows");
    for result in results {
        println!("{:<5} {:>9}", result.asset, result.rows_written);
    }
}

fn print_gap_fill_summary(results: &[gap_fill::GapFillResult]) {
    println!("asset  synthetic_rows");
    for result in results {
        println!("{:<5} {:>14}", result.asset, result.rows_written);
    }
}

fn print_runtime_summary(result: &runtime_bundle::BuildRuntimeResult) {
    println!("runtime bundle: {}", result.output_dir.display());
    println!("assets: {}", format_assets(&result.assets));
    println!("generated: {}", result.generated_at);
    println!("files:");
    for entry in &result.entries {
        println!(
            "  {:<5} cells={:<4} runtime_hash={} input_hash={}",
            entry.asset,
            entry.cell_count,
            &entry.runtime_config_hash[..12],
            &entry.training_input_hash[..12],
        );
    }
}
