use chrono::{DateTime, Utc};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LiveFillSource {
    UserWebSocket,
    DataApiPoll,
}

impl LiveFillSource {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::UserWebSocket => "user_websocket",
            Self::DataApiPoll => "data_api_poll",
        }
    }
}

#[derive(Clone, Debug)]
pub struct LiveFill {
    pub condition_id: String,
    pub asset_id: String,
    pub fill_id: String,
    pub size_shares: f64,
    pub price: f64,
    pub amount_usdc: f64,
    pub payout_usdc: f64,
    pub matched_at: DateTime<Utc>,
    pub source: LiveFillSource,
}

impl LiveFill {
    pub fn new(
        condition_id: String,
        asset_id: String,
        fill_id: String,
        size_shares: f64,
        price: f64,
        matched_at: DateTime<Utc>,
        source: LiveFillSource,
    ) -> Option<Self> {
        if !size_shares.is_finite() || size_shares <= 0.0 || !price.is_finite() || price <= 0.0 {
            return None;
        }

        Some(Self {
            condition_id,
            asset_id,
            fill_id,
            size_shares,
            price,
            amount_usdc: size_shares * price,
            payout_usdc: size_shares,
            matched_at,
            source,
        })
    }

    pub fn approximate_key(&self) -> String {
        format!(
            "{}:{}:{:.8}:{:.8}:{}",
            self.condition_id,
            self.asset_id,
            self.size_shares,
            self.price,
            self.matched_at.timestamp()
        )
    }
}
