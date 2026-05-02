use std::path::PathBuf;

use clap::{Parser, Subcommand};

use crate::{
    config::{DEFAULT_BINANCE_API_BASE_URL, DEFAULT_COINBASE_API_BASE_URL},
    domain::asset::{Asset, DEFAULT_ASSET_WHITELIST},
};

pub const DEFAULT_DATABASE_URL: &str = "postgres://localhost:5432/wiggler";
pub const DEFAULT_TRAINING_SOURCES: &str = "coinbase,binance";
pub const DEFAULT_REQUEST_DELAY_MS: u64 = 0;

#[derive(Clone, Debug, Parser)]
pub struct TrainingArgs {
    #[command(subcommand)]
    pub command: TrainingCommand,
}

#[derive(Clone, Debug, Subcommand)]
pub enum TrainingCommand {
    /// Create or update the local Postgres schema used for offline training.
    Migrate(TrainingDbArgs),
    /// Drop and recreate every Wiggler-managed offline training table.
    Reset(TrainingResetArgs),
    /// Backfill or refresh Coinbase/Binance spot 1-minute candles.
    Sync(TrainingSyncArgs),
    /// Recompute cross-source VWAP rows from stored candles.
    Vwap(TrainingVwapArgs),
    /// Fill missing Coinbase minutes from matching Binance candles as synthetic rows.
    FillGaps(TrainingFillGapsArgs),
    /// Generate the runtime probability-table bundle consumed by monitor.
    BuildRuntime(TrainingBuildRuntimeArgs),
    /// Run sync, VWAP recomputation, and runtime-bundle generation in one flow.
    RefreshRuntime(TrainingRefreshRuntimeArgs),
}

#[derive(Clone, Debug, Parser)]
pub struct TrainingDbArgs {
    /// Postgres connection URL for local offline training data.
    #[arg(long, env = "DATABASE_URL", default_value = DEFAULT_DATABASE_URL)]
    pub database_url: String,
}

#[derive(Clone, Debug, Parser)]
pub struct TrainingResetArgs {
    /// Postgres connection URL for local offline training data.
    #[arg(long, env = "DATABASE_URL", default_value = DEFAULT_DATABASE_URL)]
    pub database_url: String,

    /// Required confirmation because this deletes all offline training rows.
    #[arg(long)]
    pub yes: bool,
}

#[derive(Clone, Debug, Parser)]
pub struct TrainingSyncArgs {
    /// Postgres connection URL for local offline training data.
    #[arg(long, env = "DATABASE_URL", default_value = DEFAULT_DATABASE_URL)]
    pub database_url: String,

    /// Comma-separated asset whitelist to backfill.
    #[arg(
        long,
        alias = "asset",
        value_delimiter = ',',
        env = "WIGGLER_ASSETS",
        default_value = DEFAULT_ASSET_WHITELIST
    )]
    pub assets: Vec<Asset>,

    /// Comma-separated candle sources. Supported: coinbase, binance.
    #[arg(long, value_delimiter = ',', default_value = DEFAULT_TRAINING_SOURCES)]
    pub sources: Vec<TrainingSourceArg>,

    /// Lookback window in days when --from-iso is not provided.
    #[arg(long, default_value_t = 730)]
    pub since_days: i64,

    /// Inclusive UTC start time for the sync window.
    #[arg(long)]
    pub from_iso: Option<String>,

    /// Exclusive UTC end time for the sync window. Defaults to now.
    #[arg(long)]
    pub to_iso: Option<String>,

    /// Bypass coverage checks and re-fetch the whole requested window.
    #[arg(long)]
    pub force_full_range: bool,

    /// Maximum concurrent series per source.
    #[arg(long, default_value_t = 2)]
    pub concurrency_per_source: usize,

    /// Delay between requests inside one series.
    #[arg(long, default_value_t = DEFAULT_REQUEST_DELAY_MS)]
    pub request_delay_ms: u64,

    /// Coinbase API base URL.
    #[arg(long, env = "COINBASE_API_BASE_URL", default_value = DEFAULT_COINBASE_API_BASE_URL)]
    pub coinbase_api_base_url: String,

    /// Binance API base URL.
    #[arg(long, env = "BINANCE_API_BASE_URL", default_value = DEFAULT_BINANCE_API_BASE_URL)]
    pub binance_api_base_url: String,
}

#[derive(Clone, Debug, Parser)]
pub struct TrainingVwapArgs {
    /// Postgres connection URL for local offline training data.
    #[arg(long, env = "DATABASE_URL", default_value = DEFAULT_DATABASE_URL)]
    pub database_url: String,

    /// Comma-separated asset whitelist to recompute.
    #[arg(
        long,
        alias = "asset",
        value_delimiter = ',',
        env = "WIGGLER_ASSETS",
        default_value = DEFAULT_ASSET_WHITELIST
    )]
    pub assets: Vec<Asset>,

    /// Recompute window in days when --from-iso is not provided.
    #[arg(long, default_value_t = 730)]
    pub since_days: i64,

    /// Inclusive UTC start time for the recompute window.
    #[arg(long)]
    pub from_iso: Option<String>,

    /// Exclusive UTC end time for the recompute window. Defaults to now.
    #[arg(long)]
    pub to_iso: Option<String>,
}

#[derive(Clone, Debug, Parser)]
pub struct TrainingFillGapsArgs {
    /// Postgres connection URL for local offline training data.
    #[arg(long, env = "DATABASE_URL", default_value = DEFAULT_DATABASE_URL)]
    pub database_url: String,

    /// Comma-separated asset whitelist to gap-fill.
    #[arg(
        long,
        alias = "asset",
        value_delimiter = ',',
        env = "WIGGLER_ASSETS",
        default_value = DEFAULT_ASSET_WHITELIST
    )]
    pub assets: Vec<Asset>,

    /// Gap-fill window in days when --from-iso is not provided.
    #[arg(long, default_value_t = 730)]
    pub since_days: i64,

    /// Inclusive UTC start time for gap-fill.
    #[arg(long)]
    pub from_iso: Option<String>,

    /// Exclusive UTC end time for gap-fill. Defaults to now.
    #[arg(long)]
    pub to_iso: Option<String>,
}

#[derive(Clone, Debug, Parser)]
pub struct TrainingBuildRuntimeArgs {
    /// Postgres connection URL for local offline training data.
    #[arg(long, env = "DATABASE_URL", default_value = DEFAULT_DATABASE_URL)]
    pub database_url: String,

    /// Comma-separated asset whitelist to include in the runtime bundle.
    #[arg(
        long,
        alias = "asset",
        value_delimiter = ',',
        env = "WIGGLER_ASSETS",
        default_value = DEFAULT_ASSET_WHITELIST
    )]
    pub assets: Vec<Asset>,

    /// Output directory for the runtime bundle.
    #[arg(
        long,
        env = "WIGGLER_RUNTIME_BUNDLE_DIR",
        default_value = "runtime/wiggler-prod-v1"
    )]
    pub output_dir: PathBuf,

    /// Training window in days when --from-iso is not provided.
    #[arg(long, default_value_t = 730)]
    pub since_days: i64,

    /// Inclusive UTC start time for training.
    #[arg(long)]
    pub from_iso: Option<String>,

    /// Exclusive UTC end time for training. Defaults to now.
    #[arg(long)]
    pub to_iso: Option<String>,

    /// Polymarket crypto taker fee rate used in generated runtime configs.
    #[arg(long, default_value_t = 0.072)]
    pub taker_fee_rate: f64,

    /// Required probability edge over executable all-in ask cost.
    #[arg(long, default_value_t = 0.015)]
    pub min_edge_probability: f64,

    /// Minimum sample count required before a grid cell is emitted to runtime.
    #[arg(long, default_value_t = 500)]
    pub min_bucket_count: u64,

    /// Per-market suggested runtime position cap.
    #[arg(long, default_value_t = 250.0)]
    pub max_position_usdc: f64,
}

#[derive(Clone, Debug, Parser)]
pub struct TrainingRefreshRuntimeArgs {
    /// Postgres connection URL for local offline training data.
    #[arg(long, env = "DATABASE_URL", default_value = DEFAULT_DATABASE_URL)]
    pub database_url: String,

    /// Comma-separated asset whitelist to sync and include.
    #[arg(
        long,
        alias = "asset",
        value_delimiter = ',',
        env = "WIGGLER_ASSETS",
        default_value = DEFAULT_ASSET_WHITELIST
    )]
    pub assets: Vec<Asset>,

    /// Output directory for the runtime bundle.
    #[arg(
        long,
        env = "WIGGLER_RUNTIME_BUNDLE_DIR",
        default_value = "runtime/wiggler-prod-v1"
    )]
    pub output_dir: PathBuf,

    /// Lookback/training window in days.
    #[arg(long, default_value_t = 730)]
    pub since_days: i64,

    /// Exclusive UTC end time for sync/training. Defaults to now.
    #[arg(long)]
    pub to_iso: Option<String>,

    /// Bypass coverage checks and re-fetch the whole requested window.
    #[arg(long)]
    pub force_full_range: bool,

    /// Maximum concurrent series per source.
    #[arg(long, default_value_t = 2)]
    pub concurrency_per_source: usize,

    /// Delay between requests inside one series.
    #[arg(long, default_value_t = DEFAULT_REQUEST_DELAY_MS)]
    pub request_delay_ms: u64,

    /// Coinbase API base URL.
    #[arg(long, env = "COINBASE_API_BASE_URL", default_value = DEFAULT_COINBASE_API_BASE_URL)]
    pub coinbase_api_base_url: String,

    /// Binance API base URL.
    #[arg(long, env = "BINANCE_API_BASE_URL", default_value = DEFAULT_BINANCE_API_BASE_URL)]
    pub binance_api_base_url: String,

    /// Polymarket crypto taker fee rate used in generated runtime configs.
    #[arg(long, default_value_t = 0.072)]
    pub taker_fee_rate: f64,

    /// Required probability edge over executable all-in ask cost.
    #[arg(long, default_value_t = 0.015)]
    pub min_edge_probability: f64,

    /// Minimum sample count required before a grid cell is emitted to runtime.
    #[arg(long, default_value_t = 500)]
    pub min_bucket_count: u64,

    /// Per-market suggested runtime position cap.
    #[arg(long, default_value_t = 250.0)]
    pub max_position_usdc: f64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, clap::ValueEnum)]
pub enum TrainingSourceArg {
    Coinbase,
    Binance,
}
