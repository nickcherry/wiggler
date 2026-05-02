use std::{collections::HashMap, str::FromStr};

use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use polymarket_client_sdk_v2::{data::types::response::Trade, types::B256};
use rust_decimal::prelude::ToPrimitive;

use crate::trading::fill::{LiveFill, LiveFillSource};

#[derive(Default)]
pub(super) struct RecentTradeExposure {
    pub(super) markets: std::collections::HashSet<String>,
    pub(super) fills: Vec<LiveFill>,
}

#[derive(Clone, Debug, Default)]
pub struct MarketExposureSnapshot {
    pub open_order_markets: std::collections::HashSet<String>,
    pub traded_markets: std::collections::HashSet<String>,
    pub fills: Vec<LiveFill>,
}

impl MarketExposureSnapshot {
    pub fn exposed_markets(&self) -> std::collections::HashSet<String> {
        self.open_order_markets
            .union(&self.traded_markets)
            .cloned()
            .collect()
    }
}

pub(super) fn parse_condition_ids(condition_ids: &[String]) -> Result<HashMap<B256, String>> {
    let mut parsed = HashMap::new();
    for condition_id in condition_ids {
        let market = B256::from_str(condition_id)
            .with_context(|| format!("parse market condition id {condition_id}"))?;
        parsed.insert(market, condition_id.clone());
    }
    Ok(parsed)
}

pub(super) fn live_fill_from_data_trade(condition_id: String, trade: &Trade) -> Option<LiveFill> {
    let size = trade.size.to_f64()?;
    let price = trade.price.to_f64()?;
    let matched_at = DateTime::<Utc>::from_timestamp(trade.timestamp, 0).unwrap_or_else(Utc::now);

    LiveFill::new(
        condition_id,
        trade.asset.to_string(),
        format!("tx:{}:{}", trade.transaction_hash, trade.asset),
        size,
        price,
        matched_at,
        LiveFillSource::DataApiPoll,
    )
}
