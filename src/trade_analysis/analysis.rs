use std::collections::{HashMap, HashSet};

use anyhow::{Context, Result};
use chrono::TimeDelta;
use futures_util::{StreamExt, stream};
use polymarket_client_sdk_v2::{
    data::types::response::{ClosedPosition, Position, Trade},
    types::{B256, U256},
};
use rust_decimal::prelude::ToPrimitive;

use crate::{
    domain::asset::Asset,
    polymarket::{data::is_buy, gamma::GammaClient},
    trading::fees::{buy_gross_pnl_usdc, realized_pnl_adjustment_usdc},
};

use super::{
    market_text::{asset_from_market_text, slot_start_from_market_slug},
    report::AnalyzedTrade,
};

pub(super) async fn analyze_api_rows(
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
pub(super) struct AnalysisRows {
    pub(super) trades: Vec<AnalyzedTrade>,
    pub(super) buy_trades_considered: usize,
    pub(super) unresolved_trades: usize,
    pub(super) missing_closed_position_trades: usize,
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub(super) struct PositionKey {
    condition_id: B256,
    asset: U256,
}

impl PositionKey {
    pub(super) fn new(condition_id: B256, asset: U256) -> Self {
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
pub(super) struct PositionPnlLookup {
    pnl_by_position: HashMap<PositionKey, f64>,
    pub(super) closed_positions_considered: usize,
    pub(super) current_positions_considered: usize,
}

impl PositionPnlLookup {
    pub(super) fn from_positions(
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

    pub(super) fn summary(&self) -> String {
        "Polymarket Data API realizedPnl for closed positions, or realizedPnl+cashPnl for current positions; fee/adjustment = gross fill PnL minus API position PnL, allocated by pre-fee notional".to_string()
    }
}

pub(super) fn decimal_to_f64(value: rust_decimal::Decimal, field: &'static str) -> Result<f64> {
    value
        .to_f64()
        .with_context(|| format!("convert Polymarket {field} to f64"))
}
