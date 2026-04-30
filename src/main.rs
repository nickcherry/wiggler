use anyhow::Result;
use clap::Parser;

use wiggler::{cli::Cli, config::RuntimeConfig, doctor, logging, monitor};

#[tokio::main]
async fn main() -> Result<()> {
    let _ = rustls::crypto::ring::default_provider().install_default();
    logging::init();

    let cli = Cli::parse();
    let config = RuntimeConfig::from_env()?;

    match cli.command {
        wiggler::cli::Command::Doctor(args) => doctor::run(args, config).await,
        wiggler::cli::Command::Monitor(args) => monitor::run(args, config).await,
    }
}
