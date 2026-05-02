use anyhow::Result;
use clap::Parser;

use wiggler::{
    cli::Cli, config::RuntimeConfig, doctor, logging, monitor, trade_analysis, training,
};

#[tokio::main]
async fn main() -> Result<()> {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let _ = dotenvy::dotenv();
    logging::init();

    let cli = Cli::parse();

    match cli.command {
        wiggler::cli::Command::Doctor(args) => doctor::run(args, RuntimeConfig::from_env()?).await,
        wiggler::cli::Command::AnalyzeTrades(args) => {
            trade_analysis::run(args, RuntimeConfig::from_env()?).await
        }
        wiggler::cli::Command::Training(args) => training::run(args.command).await,
        wiggler::cli::Command::Monitor(args) => {
            monitor::run(args, RuntimeConfig::from_env()?).await
        }
    }
}
