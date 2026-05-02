use polymarket_client_sdk_v2::clob::types::response::PostOrderResponse;
use rust_decimal::Decimal;

use crate::domain::{asset::Asset, market::Outcome};

#[derive(Clone, Debug)]
pub struct LiveOrderRequest {
    pub asset: Asset,
    pub slug: String,
    pub condition_id: String,
    pub token_id: String,
    pub outcome: Outcome,
    pub amount_usdc: f64,
    pub limit_price: Decimal,
    pub size_shares: Decimal,
    pub expires_at: chrono::DateTime<chrono::Utc>,
}

impl LiveOrderRequest {
    pub fn outcome_label(&self) -> &'static str {
        match self.outcome {
            Outcome::Up => "Up",
            Outcome::Down => "Down",
            Outcome::Other(_) => "Other",
        }
    }
}

#[derive(Clone, Debug)]
pub struct LiveOrderResponse {
    pub order_id: String,
    pub status: String,
    pub success: bool,
    pub error_msg: Option<String>,
    pub making_amount: String,
    pub taking_amount: String,
    pub trade_ids: Vec<String>,
}

impl LiveOrderResponse {
    pub fn has_fill(&self) -> bool {
        self.success && (!self.trade_ids.is_empty() || positive_f64(&self.taking_amount).is_some())
    }

    pub fn filled_amount_usdc(&self) -> Option<f64> {
        positive_f64(&self.making_amount)
    }

    pub fn filled_payout_usdc(&self) -> Option<f64> {
        positive_f64(&self.taking_amount)
    }
}

impl From<PostOrderResponse> for LiveOrderResponse {
    fn from(value: PostOrderResponse) -> Self {
        Self {
            order_id: value.order_id,
            status: value.status.to_string(),
            success: value.success,
            error_msg: value.error_msg,
            making_amount: value.making_amount.to_string(),
            taking_amount: value.taking_amount.to_string(),
            trade_ids: value.trade_ids,
        }
    }
}

fn positive_f64(value: &str) -> Option<f64> {
    value
        .parse::<f64>()
        .ok()
        .filter(|value| value.is_finite() && *value > 0.0)
}

#[cfg(test)]
mod tests {
    use super::LiveOrderResponse;

    #[test]
    fn zero_decimal_taking_amount_is_not_a_fill() {
        let response = LiveOrderResponse {
            order_id: "order".to_string(),
            status: "matched".to_string(),
            success: true,
            error_msg: None,
            making_amount: "0.000000".to_string(),
            taking_amount: "0.000000".to_string(),
            trade_ids: Vec::new(),
        };

        assert!(!response.has_fill());
    }
}
