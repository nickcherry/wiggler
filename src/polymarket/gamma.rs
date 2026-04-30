use anyhow::{Context, Result, bail};
use chrono::{DateTime, Utc};
use reqwest::{Client, StatusCode};
use serde::Deserialize;

use crate::{
    domain::{
        asset::Asset,
        market::{MonitoredMarket, Outcome, OutcomeToken},
        time::MarketSlot,
    },
    polymarket::serde_helpers::{parse_json_string_vec, parse_optional_json_string_vec},
};

#[derive(Clone, Debug)]
pub struct GammaClient {
    base_url: String,
    http: Client,
}

impl GammaClient {
    pub fn new(base_url: String) -> Self {
        Self {
            base_url: base_url.trim_end_matches('/').to_string(),
            http: Client::new(),
        }
    }

    pub async fn fetch_event_by_slug(&self, slug: &str) -> Result<Option<GammaEvent>> {
        let url = format!("{}/events/slug/{}", self.base_url, slug);
        let response = self
            .http
            .get(url)
            .send()
            .await
            .context("Gamma request failed")?;

        if response.status() == StatusCode::NOT_FOUND {
            return Ok(None);
        }

        let event = response
            .error_for_status()
            .context("Gamma returned an error status")?
            .json::<GammaEvent>()
            .await
            .context("Gamma event response did not match expected shape")?;

        Ok(Some(event))
    }

    pub async fn fetch_slot_market(
        &self,
        asset: Asset,
        slot: &MarketSlot,
    ) -> Result<Option<MonitoredMarket>> {
        let slug = slot.slug(asset)?;
        let Some(event) = self.fetch_event_by_slug(&slug).await? else {
            return Ok(None);
        };
        if !event.active || event.closed {
            return Ok(None);
        }

        let Some(market) = event
            .markets
            .into_iter()
            .find(|market| market.enable_order_book && market.active && !market.closed)
        else {
            return Ok(None);
        };

        if market.clob_token_ids.len() != market.outcomes.len() {
            bail!(
                "Gamma market {} has {} token ids but {} outcomes",
                market.slug,
                market.clob_token_ids.len(),
                market.outcomes.len()
            );
        }

        let tokens = market
            .outcomes
            .iter()
            .zip(market.clob_token_ids.iter())
            .map(|(outcome, asset_id)| OutcomeToken {
                outcome: Outcome::from_gamma(outcome),
                asset_id: asset_id.clone(),
            })
            .collect();

        Ok(Some(MonitoredMarket {
            asset,
            event_id: event.id,
            market_id: market.id,
            slug: market.slug,
            title: event.title,
            condition_id: market.condition_id,
            slot: slot.clone(),
            tokens,
            resolution_source: market.resolution_source,
        }))
    }
}

#[derive(Clone, Debug, Deserialize)]
pub struct GammaEvent {
    pub id: String,
    pub slug: String,
    pub title: String,
    #[serde(default)]
    pub active: bool,
    #[serde(default)]
    pub closed: bool,
    #[serde(default)]
    pub markets: Vec<GammaMarket>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GammaMarket {
    pub id: String,
    pub question: String,
    pub slug: String,
    pub condition_id: String,
    #[serde(deserialize_with = "parse_json_string_vec")]
    pub clob_token_ids: Vec<String>,
    #[serde(deserialize_with = "parse_json_string_vec")]
    pub outcomes: Vec<String>,
    #[serde(default, deserialize_with = "parse_optional_json_string_vec")]
    pub outcome_prices: Option<Vec<String>>,
    #[serde(default)]
    pub active: bool,
    #[serde(default)]
    pub closed: bool,
    #[serde(default)]
    pub enable_order_book: bool,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub resolution_source: Option<String>,
    #[serde(default)]
    pub event_start_time: Option<DateTime<Utc>>,
    #[serde(default)]
    pub end_date: Option<DateTime<Utc>>,
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::GammaEvent;

    #[test]
    fn parses_gamma_json_encoded_arrays() {
        let value = json!({
            "id": "431453",
            "slug": "btc-updown-5m-1777563900",
            "title": "Bitcoin Up or Down",
            "active": true,
            "closed": false,
            "markets": [{
                "id": "2116529",
                "question": "Bitcoin Up or Down",
                "slug": "btc-updown-5m-1777563900",
                "conditionId": "0xabc",
                "clobTokenIds": "[\"1\", \"2\"]",
                "outcomes": "[\"Up\", \"Down\"]",
                "outcomePrices": "[\"0.505\", \"0.495\"]",
                "active": true,
                "closed": false,
                "enableOrderBook": true
            }]
        });

        let event: GammaEvent = serde_json::from_value(value).unwrap();
        let market = &event.markets[0];

        assert_eq!(market.clob_token_ids, vec!["1", "2"]);
        assert_eq!(market.outcomes, vec!["Up", "Down"]);
        assert_eq!(
            market.outcome_prices.as_ref().unwrap(),
            &vec!["0.505", "0.495"]
        );
    }
}
