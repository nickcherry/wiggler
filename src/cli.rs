use clap::{Parser, Subcommand};

use crate::domain::asset::Asset;
use crate::polymarket::rtds::PriceFeedSource;

#[derive(Debug, Parser)]
#[command(name = "wiggler")]
#[command(about = "Data-only Polymarket crypto up/down market monitor")]
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
    /// Asset family to inspect.
    #[arg(long, default_value_t = Asset::Btc)]
    pub asset: Asset,

    /// Slot width in seconds. Current production target is 300.
    #[arg(long, default_value_t = 300)]
    pub slot_seconds: i64,

    /// Number of future slots to include after the current slot.
    #[arg(long, default_value_t = 1)]
    pub lookahead_slots: u32,
}

#[derive(Clone, Debug, Parser)]
pub struct MonitorArgs {
    /// Asset family to monitor.
    #[arg(long, default_value_t = Asset::Btc)]
    pub asset: Asset,

    /// Slot width in seconds. Current production target is 300.
    #[arg(long, default_value_t = 300)]
    pub slot_seconds: i64,

    /// Number of future slots to subscribe to after the current slot.
    #[arg(long, default_value_t = 1)]
    pub lookahead_slots: u32,

    /// RTDS crypto source. Chainlink is the default because BTC 5m markets resolve on Chainlink.
    #[arg(long, default_value_t = PriceFeedSource::Chainlink)]
    pub price_feed: PriceFeedSource,

    /// Stop automatically after this many seconds. Useful for smoke tests.
    #[arg(long)]
    pub max_runtime_seconds: Option<u64>,
}
