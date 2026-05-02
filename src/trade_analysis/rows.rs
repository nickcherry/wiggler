use std::collections::HashSet;

use anyhow::Result;
use chrono::TimeDelta;
use polymarket_client_sdk_v2::{
    data::types::response::{ClosedPosition, Position},
    types::Address,
};

use crate::{
    domain::asset::Asset,
    polymarket::{data::DataApiClient, gamma::GammaClient},
};

use super::{
    MIN_CURRENT_POSITION_LOOKUP_ROWS, TradeFeeRates,
    analysis::{PositionKey, PositionPnlLookup, analyze_api_rows, decimal_to_f64},
    market_text::asset_from_market_text,
    report::AnalyzedTrade,
};

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
    pub(crate) fn from_closed_position(position: &ClosedPosition) -> Result<Self> {
        Ok(Self {
            realized_pnl: decimal_to_f64(position.realized_pnl, "realizedPnl")?,
            slug: position.slug.clone(),
            event_slug: position.event_slug.clone(),
            title: position.title.clone(),
            outcome: position.outcome.clone(),
        })
    }

    pub(crate) fn from_current_position(position: &Position) -> Result<Self> {
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
