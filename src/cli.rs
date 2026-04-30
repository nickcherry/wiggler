use std::path::PathBuf;

use clap::{Parser, Subcommand};

use crate::domain::asset::{Asset, DEFAULT_ASSET_WHITELIST};
use crate::polymarket::rtds::PriceFeedSource;

#[derive(Debug, Parser)]
#[command(name = "wiggler")]
#[command(about = "Polymarket crypto up/down monitor and gated trader")]
pub struct Cli {
    #[command(subcommand)]
    pub command: Command,
}

#[derive(Debug, Subcommand)]
pub enum Command {
    /// Check external connectivity and market discovery for the next slots.
    Doctor(DoctorArgs),
    /// Stream Chainlink prices and Polymarket CLOB orderbooks for rolling slots.
    Monitor(MonitorArgs),
}

#[derive(Clone, Debug, Parser)]
pub struct DoctorArgs {
    /// Comma-separated asset whitelist to inspect.
    #[arg(
        long,
        alias = "asset",
        value_delimiter = ',',
        env = "WIGGLER_ASSETS",
        default_value = DEFAULT_ASSET_WHITELIST
    )]
    pub assets: Vec<Asset>,

    /// Slot width in seconds. Current production target is 300.
    #[arg(long, default_value_t = 300)]
    pub slot_seconds: i64,

    /// Number of future slots to include after the current slot.
    #[arg(long, default_value_t = 1)]
    pub lookahead_slots: u32,
}

#[derive(Clone, Debug, Parser)]
pub struct MonitorArgs {
    /// Comma-separated asset whitelist to monitor.
    #[arg(
        long,
        alias = "asset",
        value_delimiter = ',',
        env = "WIGGLER_ASSETS",
        default_value = DEFAULT_ASSET_WHITELIST
    )]
    pub assets: Vec<Asset>,

    /// Slot width in seconds. Current production target is 300.
    #[arg(long, default_value_t = 300)]
    pub slot_seconds: i64,

    /// Number of future slots to subscribe to after the current slot.
    #[arg(long, default_value_t = 1)]
    pub lookahead_slots: u32,

    /// RTDS crypto source. Chainlink is the default because BTC 5m markets resolve on Chainlink.
    #[arg(long, default_value_t = PriceFeedSource::Chainlink)]
    pub price_feed: PriceFeedSource,

    /// Runtime probability-table bundle directory.
    #[arg(
        long,
        env = "WIGGLER_RUNTIME_BUNDLE_DIR",
        default_value = "runtime/wiggler-prod-v1"
    )]
    pub runtime_bundle_dir: PathBuf,

    /// Stop automatically after this many seconds. Useful for smoke tests.
    #[arg(long)]
    pub max_runtime_seconds: Option<u64>,
}
