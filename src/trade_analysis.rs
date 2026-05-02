use std::{
    collections::{HashMap, HashSet},
    io::{self, IsTerminal},
    str::FromStr,
};

use alloy::signers::local::PrivateKeySigner;
use anyhow::{Context, Result, bail};
use polymarket_client_sdk_v2::types::Address;

use crate::{
    cli::AnalyzeTradesArgs,
    config::{PolymarketSignatureType, RuntimeConfig},
    domain::{
        asset::{Asset, normalize_assets},
        time::duration_from_seconds,
    },
    polymarket::{data::DataApiClient, gamma::GammaClient},
    runtime::RuntimeBundle,
};

#[cfg(test)]
use crate::trading::fees::{LiquidityRole, buy_net_pnl_usdc, platform_fee_usdc};

const MIN_CURRENT_POSITION_LOOKUP_ROWS: usize = 500;

mod analysis;
mod market_text;
mod report;
mod rows;
#[cfg(test)]
mod tests;

pub use rows::{
    ApiClosedPositionPnlRow, ApiClosedPositionPnlRows, ApiTradePnlRow, ApiTradePnlRows,
    fetch_api_closed_position_pnl_rows, fetch_api_trade_pnl_rows,
};

use analysis::{PositionPnlLookup, analyze_api_rows};
use report::{PerformanceReport, ReportInput, format_percent};

pub async fn run(args: AnalyzeTradesArgs, config: RuntimeConfig) -> Result<()> {
    if args.max_trades == 0 {
        bail!("max_trades must be positive");
    }

    let user = resolve_user_address(&args, &config)?;
    let duration = duration_from_seconds(args.slot_seconds)?;
    let assets = normalize_assets(args.assets);
    let data_api = DataApiClient::new(&config.data_api_base_url)?;
    let gamma = GammaClient::new(config.gamma_base_url.clone());

    let trades = data_api.fetch_trades(user, args.max_trades).await?;
    let closed_positions = data_api
        .fetch_closed_positions(user, args.max_trades)
        .await?;
    let current_positions = data_api
        .fetch_positions(
            user,
            args.max_trades.max(MIN_CURRENT_POSITION_LOOKUP_ROWS),
            None,
        )
        .await?;
    let position_pnl =
        PositionPnlLookup::from_positions(&closed_positions, &current_positions, &assets)?;
    let analyzed = analyze_api_rows(&trades, &assets, duration, &gamma, &position_pnl).await?;
    let report = PerformanceReport::new(ReportInput {
        user,
        data_api_base_url: config.data_api_base_url,
        gamma_base_url: config.gamma_base_url,
        assets,
        slot_seconds: duration.num_seconds(),
        fee_model: position_pnl.summary(),
        trades_fetched: trades.len(),
        closed_positions_fetched: closed_positions.len(),
        closed_positions_considered: position_pnl.closed_positions_considered,
        current_positions_fetched: current_positions.len(),
        current_positions_considered: position_pnl.current_positions_considered,
        buy_trades_considered: analyzed.buy_trades_considered,
        unresolved_trades: analyzed.unresolved_trades,
        missing_closed_position_trades: analyzed.missing_closed_position_trades,
        trades: analyzed.trades,
    });

    let color = !args.no_color && io::stdout().is_terminal();
    print!("{}", report.render(color));

    Ok(())
}

fn resolve_user_address(args: &AnalyzeTradesArgs, config: &RuntimeConfig) -> Result<Address> {
    if let Some(user) = args.user.as_deref() {
        return parse_address(user, "--user");
    }

    resolve_config_user_address(config)
}

pub fn resolve_config_user_address(config: &RuntimeConfig) -> Result<Address> {
    if let Some(user) = config.polymarket_user_address.as_deref() {
        return parse_address(user, "POLYMARKET_USER_ADDRESS");
    }

    if let Some(funder) = config.polymarket_funder_address.as_deref() {
        return parse_address(funder, "POLYMARKET_FUNDER_ADDRESS");
    }

    if config.polymarket_signature_type != PolymarketSignatureType::Eoa {
        bail!(
            "analysis needs the Polymarket proxy/safe wallet address; pass --user or set POLYMARKET_USER_ADDRESS/POLYMARKET_FUNDER_ADDRESS"
        );
    }

    let private_key = config.polymarket_private_key.as_deref().context(
        "analysis needs a wallet address; pass --user or set POLYMARKET_USER_ADDRESS/POLYMARKET_FUNDER_ADDRESS",
    )?;
    let signer = PrivateKeySigner::from_str(private_key).context("parse POLYMARKET_PRIVATE_KEY")?;
    Ok(signer.address())
}

fn parse_address(value: &str, source: &str) -> Result<Address> {
    Address::from_str(value).with_context(|| format!("parse {source} as an address"))
}

#[derive(Clone, Debug)]
pub struct TradeFeeRates {
    rates: HashMap<Asset, f64>,
}

impl TradeFeeRates {
    pub fn maker_for_assets(assets: &[Asset]) -> Self {
        Self {
            rates: assets.iter().copied().map(|asset| (asset, 0.0)).collect(),
        }
    }

    pub fn from_runtime_bundle(runtime_bundle: &RuntimeBundle, assets: &[Asset]) -> Result<Self> {
        let mut rates = HashMap::new();
        for asset in assets {
            let runtime = runtime_bundle
                .config_for(*asset)
                .with_context(|| format!("runtime bundle is missing fee config for {}", asset))?;
            rates.insert(*asset, runtime.fee_rate());
        }
        Ok(Self { rates })
    }

    pub fn rate_for(&self, asset: Asset) -> f64 {
        *self.rates.get(&asset).unwrap_or(&0.0)
    }

    pub fn summary(&self) -> String {
        let mut rates = self.rates.iter().collect::<Vec<_>>();
        rates.sort_by_key(|(asset, _)| **asset);
        let unique_rates = rates
            .iter()
            .map(|(_, rate)| rate.to_bits())
            .collect::<HashSet<_>>();
        if unique_rates.len() == 1 {
            let (_, rate) = rates[0];
            if *rate == 0.0 {
                "0.00% maker entry fee".to_string()
            } else {
                format!("{} taker entry fee", format_percent(rate * 100.0))
            }
        } else {
            rates
                .into_iter()
                .map(|(asset, rate)| {
                    format!(
                        "{} {}",
                        asset.to_string().to_ascii_uppercase(),
                        format_percent(rate * 100.0)
                    )
                })
                .collect::<Vec<_>>()
                .join(", ")
        }
    }
}

#[cfg(test)]
fn trade_fee(size: f64, price: f64, fee_rate: f64) -> f64 {
    platform_fee_usdc(size, price, fee_rate, LiquidityRole::Taker).unwrap_or(0.0)
}

#[cfg(test)]
fn buy_trade_pnl(size: f64, entry_price: f64, resolution_price: f64, entry_fee: f64) -> f64 {
    buy_net_pnl_usdc(size, entry_price, resolution_price, entry_fee).unwrap_or(0.0)
}
