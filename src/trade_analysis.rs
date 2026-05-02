use std::{
    collections::{HashMap, HashSet},
    io::{self, IsTerminal},
    str::FromStr,
};

use alloy::signers::local::PrivateKeySigner;
use anyhow::{Context, Result, bail};
use chrono::{DateTime, TimeDelta, Utc};
use futures_util::{StreamExt, stream};
use polymarket_client_sdk_v2::{
    data::types::response::{ClosedPosition, Position, Trade},
    types::{Address, B256, U256},
};
use rust_decimal::prelude::ToPrimitive;

use crate::{
    cli::AnalyzeTradesArgs,
    config::{PolymarketSignatureType, RuntimeConfig},
    domain::{
        asset::{Asset, normalize_assets},
        time::duration_from_seconds,
    },
    polymarket::{
        data::{DataApiClient, is_buy},
        gamma::GammaClient,
    },
    runtime::RuntimeBundle,
    trading::fees::{buy_gross_pnl_usdc, realized_pnl_adjustment_usdc},
};

const MIN_CURRENT_POSITION_LOOKUP_ROWS: usize = 500;

mod report;

use report::{AnalyzedTrade, PerformanceReport, ReportInput, format_percent};
#[cfg(test)]
use report::{EntryOddsBucket, RemainingBucket, SummaryStats, format_signed_usdc};

#[cfg(test)]
use crate::trading::fees::{LiquidityRole, buy_net_pnl_usdc, platform_fee_usdc};

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
pub struct ApiTradePnlRows {
    pub rows: Vec<ApiTradePnlRow>,
    pub trades_fetched: usize,
    pub buy_trades_considered: usize,
    pub unresolved_trades: usize,
    pub missing_closed_position_trades: usize,
}

#[derive(Clone, Debug)]
pub struct ApiTradePnlRow {
    pub realized_pnl: f64,
    pub slug: String,
    pub event_slug: String,
    pub title: String,
    pub outcome: String,
}

#[derive(Clone, Debug)]
pub struct ApiClosedPositionPnlRows {
    pub rows: Vec<ApiClosedPositionPnlRow>,
    pub positions_fetched: usize,
    pub positions_considered: usize,
}

#[derive(Clone, Debug)]
pub struct ApiClosedPositionPnlRow {
    pub realized_pnl: f64,
    pub slug: String,
    pub event_slug: String,
    pub title: String,
    pub outcome: String,
}

pub async fn fetch_api_trade_pnl_rows(
    data_api: &DataApiClient,
    gamma: &GammaClient,
    user: Address,
    assets: &[Asset],
    duration: TimeDelta,
    max_trades: usize,
    _fee_rates: &TradeFeeRates,
) -> Result<ApiTradePnlRows> {
    let trades = data_api.fetch_trades(user, max_trades).await?;
    let closed_positions = data_api.fetch_closed_positions(user, max_trades).await?;
    let current_positions = data_api
        .fetch_positions(user, max_trades.max(MIN_CURRENT_POSITION_LOOKUP_ROWS), None)
        .await?;
    let position_pnl =
        PositionPnlLookup::from_positions(&closed_positions, &current_positions, assets)?;
    let analyzed = analyze_api_rows(&trades, assets, duration, gamma, &position_pnl).await?;
    Ok(ApiTradePnlRows {
        rows: analyzed
            .trades
            .iter()
            .map(ApiTradePnlRow::from_analyzed_trade)
            .collect(),
        trades_fetched: trades.len(),
        buy_trades_considered: analyzed.buy_trades_considered,
        unresolved_trades: analyzed.unresolved_trades,
        missing_closed_position_trades: analyzed.missing_closed_position_trades,
    })
}

pub async fn fetch_api_closed_position_pnl_rows(
    data_api: &DataApiClient,
    user: Address,
    assets: &[Asset],
    max_positions: usize,
) -> Result<ApiClosedPositionPnlRows> {
    let positions = data_api.fetch_closed_positions(user, max_positions).await?;
    let current_positions = data_api
        .fetch_positions(
            user,
            max_positions.max(MIN_CURRENT_POSITION_LOOKUP_ROWS),
            Some(true),
        )
        .await?;
    let asset_filter = assets.iter().copied().collect::<HashSet<_>>();
    let mut rows = Vec::new();
    let mut positions_considered = 0;
    let mut seen_positions = HashSet::new();

    for position in &positions {
        let Some(asset) =
            asset_from_market_text(&position.slug, &position.event_slug, &position.title)
        else {
            continue;
        };
        if !asset_filter.contains(&asset) {
            continue;
        }
        positions_considered += 1;
        seen_positions.insert(PositionKey::new(position.condition_id, position.asset));
        rows.push(ApiClosedPositionPnlRow::from_closed_position(position)?);
    }

    for position in &current_positions {
        let Some(asset) =
            asset_from_market_text(&position.slug, &position.event_slug, &position.title)
        else {
            continue;
        };
        if !asset_filter.contains(&asset) {
            continue;
        }
        let key = PositionKey::new(position.condition_id, position.asset);
        if seen_positions.contains(&key) {
            continue;
        }

        positions_considered += 1;
        rows.push(ApiClosedPositionPnlRow::from_current_position(position)?);
    }

    Ok(ApiClosedPositionPnlRows {
        rows,
        positions_fetched: positions.len() + current_positions.len(),
        positions_considered,
    })
}

impl ApiTradePnlRow {
    fn from_analyzed_trade(trade: &AnalyzedTrade) -> Self {
        Self {
            realized_pnl: trade.realized_pnl,
            slug: trade.slug.clone(),
            event_slug: trade.event_slug.clone(),
            title: trade.title.clone(),
            outcome: trade.outcome.clone(),
        }
    }
}

impl ApiClosedPositionPnlRow {
    fn from_closed_position(position: &ClosedPosition) -> Result<Self> {
        Ok(Self {
            realized_pnl: decimal_to_f64(position.realized_pnl, "realizedPnl")?,
            slug: position.slug.clone(),
            event_slug: position.event_slug.clone(),
            title: position.title.clone(),
            outcome: position.outcome.clone(),
        })
    }

    fn from_current_position(position: &Position) -> Result<Self> {
        let cash_pnl = decimal_to_f64(position.cash_pnl, "cashPnl")?;
        let realized_pnl = decimal_to_f64(position.realized_pnl, "realizedPnl")?;
        Ok(Self {
            realized_pnl: cash_pnl + realized_pnl,
            slug: position.slug.clone(),
            event_slug: position.event_slug.clone(),
            title: position.title.clone(),
            outcome: position.outcome.clone(),
        })
    }
}

async fn analyze_api_rows(
    trades: &[Trade],
    assets: &[Asset],
    duration: TimeDelta,
    gamma: &GammaClient,
    position_pnl: &PositionPnlLookup,
) -> Result<AnalysisRows> {
    let asset_filter = assets.iter().copied().collect::<HashSet<_>>();
    let mut candidate_trades = Vec::new();
    let mut slugs = HashSet::new();
    let mut buy_trades_considered = 0;
    let mut unresolved_trades = 0;
    let mut missing_closed_position_trades = 0;

    for trade in trades.iter().filter(|trade| is_buy(&trade.side)) {
        let Some(asset) = asset_from_market_text(&trade.slug, &trade.event_slug, &trade.title)
        else {
            continue;
        };
        if !asset_filter.contains(&asset) {
            continue;
        }
        buy_trades_considered += 1;
        slugs.insert(trade.slug.clone());
        candidate_trades.push((trade, asset));
    }

    let resolutions = fetch_resolutions(gamma, slugs).await?;
    let mut candidates = Vec::new();
    let mut position_totals = HashMap::<PositionKey, PositionGrossTotals>::new();

    for (trade, asset) in candidate_trades {
        let Some(resolution_price) = resolutions
            .get(&trade.slug)
            .and_then(Option::as_ref)
            .and_then(|market| {
                market
                    .outcome_prices
                    .get(&normalize_outcome(&trade.outcome))
            })
            .copied()
        else {
            unresolved_trades += 1;
            continue;
        };

        let size = decimal_to_f64(trade.size, "size")?;
        let entry_price = decimal_to_f64(trade.price, "price")?;
        let gross_pnl = buy_gross_pnl_usdc(size, entry_price, resolution_price)
            .context("calculate buy gross PnL")?;
        let pre_fee_notional = size * entry_price;
        let entry_remaining_seconds = trade
            .slug
            .as_str()
            .strip_prefix(asset.slug_code())
            .and_then(|_| slot_start_from_market_slug(&trade.slug))
            .map(|start| {
                let slot_end = start + duration;
                slot_end.timestamp() - trade.timestamp
            });
        let position_key = PositionKey::new(trade.condition_id, trade.asset);
        position_totals
            .entry(position_key.clone())
            .or_default()
            .add(gross_pnl, pre_fee_notional);
        candidates.push(CandidateAnalyzedTrade {
            asset,
            slug: trade.slug.clone(),
            event_slug: trade.event_slug.clone(),
            title: trade.title.clone(),
            outcome: trade.outcome.clone(),
            gross_pnl,
            pre_fee_notional,
            entry_price,
            entry_remaining_seconds,
            position_key,
        });
    }

    let mut analyzed = Vec::new();
    for candidate in candidates {
        let Some(position_total_pnl) = position_pnl.pnl(&candidate.position_key) else {
            missing_closed_position_trades += 1;
            continue;
        };
        let totals = position_totals
            .get(&candidate.position_key)
            .context("candidate position totals missing")?;
        let total_adjustment = realized_pnl_adjustment_usdc(totals.gross_pnl, position_total_pnl)
            .context("derive position PnL adjustment")?;
        let weight = totals.weight_for(candidate.pre_fee_notional);
        let entry_fee = total_adjustment * weight;
        let realized_pnl = candidate.gross_pnl - entry_fee;
        let cost_basis = (candidate.pre_fee_notional + entry_fee).max(0.0);

        analyzed.push(AnalyzedTrade {
            asset: candidate.asset,
            slug: candidate.slug,
            event_slug: candidate.event_slug,
            title: candidate.title,
            outcome: candidate.outcome,
            realized_pnl,
            total_bought: cost_basis,
            fees: entry_fee,
            entry_price: candidate.entry_price,
            entry_remaining_seconds: candidate.entry_remaining_seconds,
        });
    }

    Ok(AnalysisRows {
        trades: analyzed,
        buy_trades_considered,
        unresolved_trades,
        missing_closed_position_trades,
    })
}

#[derive(Debug)]
struct MarketResolution {
    outcome_prices: HashMap<String, f64>,
}

async fn fetch_resolutions(
    gamma: &GammaClient,
    slugs: HashSet<String>,
) -> Result<HashMap<String, Option<MarketResolution>>> {
    let mut requests = stream::iter(slugs.into_iter().map(|slug| {
        let gamma = gamma.clone();
        async move {
            let resolution = fetch_market_resolution(&gamma, &slug).await;
            (slug, resolution)
        }
    }))
    .buffer_unordered(16);

    let mut resolutions = HashMap::new();
    while let Some((slug, resolution)) = requests.next().await {
        resolutions.insert(slug, resolution?);
    }

    Ok(resolutions)
}

async fn fetch_market_resolution(
    gamma: &GammaClient,
    slug: &str,
) -> Result<Option<MarketResolution>> {
    let Some(event) = gamma
        .fetch_event_by_slug(slug)
        .await
        .with_context(|| format!("fetch Gamma event {slug} for trade analysis"))?
    else {
        return Ok(None);
    };

    let Some(market) = event.markets.into_iter().find(|market| market.slug == slug) else {
        return Ok(None);
    };
    if !market.closed {
        return Ok(None);
    }
    let Some(outcome_prices) = market.outcome_prices else {
        return Ok(None);
    };
    if outcome_prices.len() != market.outcomes.len() {
        return Ok(None);
    }

    let mut prices = HashMap::new();
    for (outcome, price) in market.outcomes.iter().zip(outcome_prices.iter()) {
        let price = price
            .parse::<f64>()
            .with_context(|| format!("parse Gamma outcome price {price} for {slug}"))?;
        prices.insert(normalize_outcome(outcome), price);
    }

    Ok(Some(MarketResolution {
        outcome_prices: prices,
    }))
}

fn normalize_outcome(value: &str) -> String {
    value.trim().to_ascii_lowercase()
}

#[derive(Clone, Debug)]
struct AnalysisRows {
    trades: Vec<AnalyzedTrade>,
    buy_trades_considered: usize,
    unresolved_trades: usize,
    missing_closed_position_trades: usize,
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
struct PositionKey {
    condition_id: B256,
    asset: U256,
}

impl PositionKey {
    fn new(condition_id: B256, asset: U256) -> Self {
        Self {
            condition_id,
            asset,
        }
    }
}

#[derive(Clone, Copy, Debug, Default)]
struct PositionGrossTotals {
    gross_pnl: f64,
    pre_fee_notional: f64,
    trades: u64,
}

impl PositionGrossTotals {
    fn add(&mut self, gross_pnl: f64, pre_fee_notional: f64) {
        self.gross_pnl += gross_pnl;
        self.pre_fee_notional += pre_fee_notional.max(0.0);
        self.trades += 1;
    }

    fn weight_for(self, pre_fee_notional: f64) -> f64 {
        if self.pre_fee_notional > f64::EPSILON {
            pre_fee_notional.max(0.0) / self.pre_fee_notional
        } else if self.trades > 0 {
            1.0 / self.trades as f64
        } else {
            0.0
        }
    }
}

#[derive(Clone, Debug)]
struct CandidateAnalyzedTrade {
    asset: Asset,
    slug: String,
    event_slug: String,
    title: String,
    outcome: String,
    gross_pnl: f64,
    pre_fee_notional: f64,
    entry_price: f64,
    entry_remaining_seconds: Option<i64>,
    position_key: PositionKey,
}

#[derive(Clone, Debug)]
pub struct PositionPnlLookup {
    pnl_by_position: HashMap<PositionKey, f64>,
    closed_positions_considered: usize,
    current_positions_considered: usize,
}

impl PositionPnlLookup {
    fn from_positions(
        closed_positions: &[ClosedPosition],
        current_positions: &[Position],
        assets: &[Asset],
    ) -> Result<Self> {
        let asset_filter = assets.iter().copied().collect::<HashSet<_>>();
        let mut pnl_by_position = HashMap::<PositionKey, f64>::new();
        let mut closed_positions_considered = 0;
        let mut current_positions_considered = 0;

        for position in closed_positions {
            let Some(asset) =
                asset_from_market_text(&position.slug, &position.event_slug, &position.title)
            else {
                continue;
            };
            if !asset_filter.contains(&asset) {
                continue;
            }

            closed_positions_considered += 1;
            let key = PositionKey::new(position.condition_id, position.asset);
            let realized_pnl = decimal_to_f64(position.realized_pnl, "realizedPnl")?;
            *pnl_by_position.entry(key).or_default() += realized_pnl;
        }

        for position in current_positions {
            let Some(asset) =
                asset_from_market_text(&position.slug, &position.event_slug, &position.title)
            else {
                continue;
            };
            if !asset_filter.contains(&asset) {
                continue;
            }

            current_positions_considered += 1;
            let key = PositionKey::new(position.condition_id, position.asset);
            let cash_pnl = decimal_to_f64(position.cash_pnl, "cashPnl")?;
            let realized_pnl = decimal_to_f64(position.realized_pnl, "realizedPnl")?;
            pnl_by_position
                .entry(key)
                .or_insert(cash_pnl + realized_pnl);
        }

        Ok(Self {
            pnl_by_position,
            closed_positions_considered,
            current_positions_considered,
        })
    }

    fn pnl(&self, key: &PositionKey) -> Option<f64> {
        self.pnl_by_position.get(key).copied()
    }

    fn summary(&self) -> String {
        "Polymarket Data API realizedPnl for closed positions, or realizedPnl+cashPnl for current positions; fee/adjustment = gross fill PnL minus API position PnL, allocated by pre-fee notional".to_string()
    }
}

fn decimal_to_f64(value: rust_decimal::Decimal, field: &'static str) -> Result<f64> {
    value
        .to_f64()
        .with_context(|| format!("convert Polymarket {field} to f64"))
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

fn asset_from_market_text(slug: &str, event_slug: &str, title: &str) -> Option<Asset> {
    asset_from_slug(slug)
        .or_else(|| asset_from_slug(event_slug))
        .or_else(|| asset_from_title(title))
}

fn asset_from_slug(slug: &str) -> Option<Asset> {
    slug.split('-').next()?.parse::<Asset>().ok()
}

fn asset_from_title(title: &str) -> Option<Asset> {
    let lower = title.to_ascii_lowercase();
    if lower.starts_with("bitcoin ") {
        Some(Asset::Btc)
    } else if lower.starts_with("ethereum ") {
        Some(Asset::Eth)
    } else if lower.starts_with("solana ") {
        Some(Asset::Sol)
    } else if lower.starts_with("xrp ") {
        Some(Asset::Xrp)
    } else if lower.starts_with("dogecoin ") {
        Some(Asset::Doge)
    } else if lower.starts_with("hyperliquid ") {
        Some(Asset::Hype)
    } else if lower.starts_with("bnb ") || lower.starts_with("binance coin ") {
        Some(Asset::Bnb)
    } else {
        None
    }
}

fn slot_start_from_market_slug(slug: &str) -> Option<DateTime<Utc>> {
    let timestamp = slug.rsplit('-').next()?.parse::<i64>().ok()?;
    DateTime::from_timestamp(timestamp, 0)
}

#[cfg(test)]
mod tests {
    use super::{
        AnalyzedTrade, ApiClosedPositionPnlRow, EntryOddsBucket, PerformanceReport,
        RemainingBucket, ReportInput, SummaryStats, asset_from_market_text, buy_trade_pnl,
        format_signed_usdc, trade_fee,
    };
    use crate::domain::asset::Asset;
    use polymarket_client_sdk_v2::data::types::response::{ClosedPosition, Position};
    use polymarket_client_sdk_v2::types::address;
    use serde_json::json;

    #[test]
    fn remaining_buckets_sort_from_largest_to_smallest_then_unknowns() {
        let mut buckets = [
            RemainingBucket::from_seconds(Some(30), 300),
            RemainingBucket::from_seconds(None, 300),
            RemainingBucket::from_seconds(Some(210), 300),
            RemainingBucket::from_seconds(Some(90), 300),
            RemainingBucket::from_seconds(Some(301), 300),
        ];

        buckets.sort();

        assert_eq!(buckets[0].label(), "3-4 min");
        assert_eq!(buckets[1].label(), "1-2 min");
        assert_eq!(buckets[2].label(), "0-1 min");
        assert_eq!(buckets[3].label(), "outside slot");
        assert_eq!(buckets[4].label(), "unknown");
    }

    #[test]
    fn entry_odds_bucket_uses_ten_cent_ranges() {
        assert_eq!(EntryOddsBucket::from_price(0.42).label(), "$0.40-$0.50");
        assert_eq!(EntryOddsBucket::from_price(1.0).label(), "$0.90-$1.00");
    }

    #[test]
    fn summary_stats_count_wins_losses_and_flats() {
        let trades = vec![
            trade(Asset::Btc, 10.0, 101.0, 1.0, 0.7, Some(210)),
            trade(Asset::Btc, -5.0, 50.5, 0.5, 0.4, Some(90)),
            trade(Asset::Eth, 0.0, 20.0, 0.0, 0.5, None),
        ];
        let stats = SummaryStats::from_trades(&trades);

        assert_eq!(stats.trades, 3);
        assert_eq!(stats.wins, 1);
        assert_eq!(stats.losses, 1);
        assert_eq!(stats.flats, 1);
        assert!((stats.pnl - 5.0).abs() < 0.000001);
        assert!((stats.fees - 1.5).abs() < 0.000001);
        assert!((stats.fee_drag_pct().unwrap() - 23.076923).abs() < 0.0001);
        assert!((stats.fee_notional_pct().unwrap() - 0.88235294).abs() < 0.0001);
        assert!((stats.roi_pct().unwrap() - 2.91545189).abs() < 0.0001);
    }

    #[test]
    fn fee_drag_is_unavailable_when_gross_edge_is_not_positive() {
        let stats = SummaryStats {
            fees: 2.0,
            pnl: -3.0,
            ..SummaryStats::default()
        };

        assert_eq!(stats.fee_drag_pct(), None);
    }

    #[test]
    fn buy_trade_pnl_subtracts_entry_fee() {
        let entry_fee = trade_fee(100.0, 0.42, 0.072);
        assert!((entry_fee - 1.75392).abs() < 0.000001);
        assert!((buy_trade_pnl(100.0, 0.42, 1.0, entry_fee) - 56.24608).abs() < 0.000001);
        assert!((buy_trade_pnl(100.0, 0.42, 0.0, entry_fee) + 43.75392).abs() < 0.000001);
    }

    #[test]
    fn api_closed_position_row_uses_polymarket_realized_pnl() {
        let position: ClosedPosition = serde_json::from_value(json!({
            "proxyWallet": "0x1234567890abcdef1234567890abcdef12345678",
            "asset": "1",
            "conditionId": "0x0000000000000000000000000000000000000000000000000000000000000001",
            "avgPrice": "0.42",
            "totalBought": "42",
            "realizedPnl": "-2.375",
            "curPrice": "0",
            "timestamp": 1777648800,
            "title": "Bitcoin Up or Down - May 1, 11:20AM-11:25AM ET",
            "slug": "btc-updown-5m-1777648800",
            "icon": "",
            "eventSlug": "btc-updown-5m-1777648800",
            "outcome": "Down",
            "outcomeIndex": 1,
            "oppositeOutcome": "Up",
            "oppositeAsset": "2",
            "endDate": "2026-05-01T15:25:00Z"
        }))
        .unwrap();

        let row = ApiClosedPositionPnlRow::from_closed_position(&position).unwrap();

        assert_eq!(row.realized_pnl, -2.375);
        assert_eq!(row.slug, "btc-updown-5m-1777648800");
        assert_eq!(row.outcome, "Down");
    }

    #[test]
    fn api_current_position_row_uses_cash_and_realized_pnl() {
        let position: Position = serde_json::from_value(json!({
            "proxyWallet": "0x1234567890abcdef1234567890abcdef12345678",
            "asset": "1",
            "conditionId": "0x0000000000000000000000000000000000000000000000000000000000000001",
            "size": "10",
            "avgPrice": "0.45",
            "initialValue": "4.5",
            "currentValue": "10",
            "cashPnl": "5.5",
            "percentPnl": "122.2222",
            "totalBought": "4.5",
            "realizedPnl": "1.25",
            "percentRealizedPnl": "27.7778",
            "curPrice": "1",
            "redeemable": true,
            "mergeable": false,
            "title": "Bitcoin Up or Down - May 1, 11:20AM-11:25AM ET",
            "slug": "btc-updown-5m-1777648800",
            "icon": "",
            "eventSlug": "btc-updown-5m-1777648800",
            "outcome": "Up",
            "outcomeIndex": 0,
            "oppositeOutcome": "Down",
            "oppositeAsset": "2",
            "endDate": "2026-05-01",
            "negativeRisk": false
        }))
        .unwrap();

        let row = ApiClosedPositionPnlRow::from_current_position(&position).unwrap();

        assert_eq!(row.realized_pnl, 6.75);
        assert_eq!(row.slug, "btc-updown-5m-1777648800");
        assert_eq!(row.outcome, "Up");
    }

    #[test]
    fn asset_extraction_uses_slug_then_title() {
        assert_eq!(
            asset_from_market_text("btc-updown-5m-1777562400", "", "ignored"),
            Some(Asset::Btc)
        );
        assert_eq!(
            asset_from_market_text("", "", "Dogecoin Up or Down"),
            Some(Asset::Doge)
        );
    }

    #[test]
    fn report_renders_requested_sections_without_color() {
        let report = PerformanceReport::new(ReportInput {
            user: address!("1234567890abcdef1234567890abcdef12345678"),
            data_api_base_url: "https://data-api.polymarket.com".to_string(),
            gamma_base_url: "https://gamma-api.polymarket.com".to_string(),
            assets: vec![Asset::Btc, Asset::Eth],
            slot_seconds: 300,
            fee_model: "closed-position realizedPnl".to_string(),
            trades_fetched: 2,
            closed_positions_fetched: 2,
            closed_positions_considered: 2,
            current_positions_fetched: 0,
            current_positions_considered: 0,
            buy_trades_considered: 2,
            unresolved_trades: 0,
            missing_closed_position_trades: 0,
            trades: vec![
                trade(Asset::Btc, 12.5, 50.0, 0.5, 0.7, Some(210)),
                trade(Asset::Eth, -10.0, 40.0, 0.4, 0.4, Some(45)),
            ],
        });

        let rendered = report.render(false);

        assert!(rendered.contains("Trade Performance Analysis"));
        assert!(rendered.contains("Fee model"));
        assert!(rendered.contains("Net PnL"));
        assert!(rendered.contains("Fee Drag"));
        assert!(rendered.contains("Fee/Notional"));
        assert!(rendered.contains("By Asset"));
        assert!(rendered.contains("By Time Remaining"));
        assert!(rendered.contains("By Entry Vs Start Line"));
        assert!(rendered.contains("unavailable from API"));
        assert!(rendered.contains("By Entry Odds"));
        assert!(rendered.contains("+$12.50"));
    }

    #[test]
    fn net_pnl_share_color_follows_rendered_percent_sign() {
        let report = PerformanceReport::new(ReportInput {
            user: address!("1234567890abcdef1234567890abcdef12345678"),
            data_api_base_url: "https://data-api.polymarket.com".to_string(),
            gamma_base_url: "https://gamma-api.polymarket.com".to_string(),
            assets: vec![Asset::Btc, Asset::Eth],
            slot_seconds: 300,
            fee_model: "closed-position realizedPnl".to_string(),
            trades_fetched: 2,
            closed_positions_fetched: 2,
            closed_positions_considered: 2,
            current_positions_fetched: 0,
            current_positions_considered: 0,
            buy_trades_considered: 2,
            unresolved_trades: 0,
            missing_closed_position_trades: 0,
            trades: vec![
                trade(Asset::Btc, 5.0, 50.0, 0.5, 0.7, Some(210)),
                trade(Asset::Eth, -10.0, 40.0, 0.4, 0.4, Some(45)),
            ],
        });

        let rendered = report.render(true);
        let btc_line = rendered.lines().find(|line| line.contains("BTC")).unwrap();
        let eth_line = rendered.lines().find(|line| line.contains("ETH")).unwrap();

        assert_ansi_color_for_text(btc_line, "-100%", "31");
        assert_ansi_color_for_text(eth_line, "+200%", "32");
    }

    #[test]
    fn signed_usdc_formats_losses() {
        assert_eq!(format_signed_usdc(-8751.006), "-$8,751.01");
    }

    fn trade(
        asset: Asset,
        pnl: f64,
        total_bought: f64,
        fees: f64,
        entry_price: f64,
        entry_remaining_seconds: Option<i64>,
    ) -> AnalyzedTrade {
        AnalyzedTrade {
            asset,
            slug: format!("{}-updown-5m-1777562400", asset.slug_code()),
            event_slug: format!("{}-updown-5m-1777562400", asset.slug_code()),
            title: format!("{} Up or Down", asset.to_string().to_ascii_uppercase()),
            outcome: "Up".to_string(),
            realized_pnl: pnl,
            total_bought,
            fees,
            entry_price,
            entry_remaining_seconds,
        }
    }

    fn assert_ansi_color_for_text(line: &str, text: &str, code: &str) {
        let text_index = line.find(text).unwrap();
        let prefix = &line[..text_index];
        let color_index = prefix.rfind("\x1b[").unwrap();
        let color_span = &line[color_index..text_index];

        assert!(
            color_span.starts_with(&format!("\x1b[{code}m")),
            "{text} had wrong ANSI color in {line:?}"
        );
        assert!(
            !color_span.contains("\x1b[0m"),
            "{text} was not inside active ANSI color in {line:?}"
        );
    }
}
