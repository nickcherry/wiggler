use serde::Serialize;

use crate::domain::{asset::Asset, time::MarketSlot};

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Outcome {
    Up,
    Down,
    Other(String),
}

impl Outcome {
    pub fn from_gamma(value: &str) -> Self {
        match value.to_ascii_lowercase().as_str() {
            "up" | "yes" => Self::Up,
            "down" | "no" => Self::Down,
            _ => Self::Other(value.to_string()),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct OutcomeToken {
    pub outcome: Outcome,
    pub asset_id: String,
}

#[derive(Clone, Debug)]
pub struct MonitoredMarket {
    pub asset: Asset,
    pub event_id: String,
    pub market_id: String,
    pub slug: String,
    pub title: String,
    pub condition_id: String,
    pub slot: MarketSlot,
    pub tokens: Vec<OutcomeToken>,
    pub resolution_source: Option<String>,
}

impl MonitoredMarket {
    pub fn asset_ids(&self) -> Vec<String> {
        self.tokens
            .iter()
            .map(|token| token.asset_id.clone())
            .collect()
    }

    pub fn token_for_asset_id(&self, asset_id: &str) -> Option<&OutcomeToken> {
        self.tokens.iter().find(|token| token.asset_id == asset_id)
    }
}
