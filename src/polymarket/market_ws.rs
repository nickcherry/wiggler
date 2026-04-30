use std::{collections::HashSet, time::Duration};

use anyhow::{Context, Result};
use futures_util::{SinkExt, StreamExt};
use rust_decimal::Decimal;
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::{sync::mpsc, time};
use tokio_tungstenite::{connect_async, tungstenite::Message};
use tracing::{debug, info, warn};

use crate::{
    domain::{
        decimal::deserialize_decimal_from_json,
        orderbook::{BookSide, PriceLevel},
    },
    polymarket::serde_helpers::deserialize_optional_millis,
};

#[derive(Clone, Debug)]
pub enum MarketWsEvent {
    Book(BookEvent),
    PriceChange(PriceChangeEvent),
    TickSizeChange(TickSizeChangeEvent),
    LastTradePrice(LastTradePriceEvent),
    BestBidAsk(BestBidAskEvent),
    NewMarket(Value),
    MarketResolved(Value),
    Unknown { event_type: String, raw: Value },
}

#[derive(Clone, Debug, Deserialize)]
pub struct BookEvent {
    pub asset_id: String,
    pub market: String,
    #[serde(default)]
    pub bids: Vec<PriceLevel>,
    #[serde(default)]
    pub asks: Vec<PriceLevel>,
    #[serde(default, deserialize_with = "deserialize_optional_millis")]
    pub timestamp: Option<chrono::DateTime<chrono::Utc>>,
    #[serde(default)]
    pub hash: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct PriceChangeEvent {
    pub market: String,
    #[serde(default)]
    pub price_changes: Vec<PriceChange>,
    #[serde(default, deserialize_with = "deserialize_optional_millis")]
    pub timestamp: Option<chrono::DateTime<chrono::Utc>>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct PriceChange {
    pub asset_id: String,
    #[serde(deserialize_with = "deserialize_decimal_from_json")]
    pub price: Decimal,
    #[serde(deserialize_with = "deserialize_decimal_from_json")]
    pub size: Decimal,
    pub side: OrderSide,
    #[serde(default)]
    pub hash: Option<String>,
    #[serde(default, deserialize_with = "optional_decimal")]
    pub best_bid: Option<Decimal>,
    #[serde(default, deserialize_with = "optional_decimal")]
    pub best_ask: Option<Decimal>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "UPPERCASE")]
pub enum OrderSide {
    Buy,
    Sell,
}

impl OrderSide {
    pub fn book_side(self) -> BookSide {
        match self {
            Self::Buy => BookSide::Bid,
            Self::Sell => BookSide::Ask,
        }
    }
}

#[derive(Clone, Debug, Deserialize)]
pub struct TickSizeChangeEvent {
    pub asset_id: String,
    pub market: String,
    #[serde(deserialize_with = "deserialize_decimal_from_json")]
    pub old_tick_size: Decimal,
    #[serde(deserialize_with = "deserialize_decimal_from_json")]
    pub new_tick_size: Decimal,
    #[serde(default, deserialize_with = "deserialize_optional_millis")]
    pub timestamp: Option<chrono::DateTime<chrono::Utc>>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct LastTradePriceEvent {
    pub asset_id: String,
    pub market: String,
    #[serde(deserialize_with = "deserialize_decimal_from_json")]
    pub price: Decimal,
    #[serde(deserialize_with = "deserialize_decimal_from_json")]
    pub size: Decimal,
    pub side: OrderSide,
    #[serde(default, deserialize_with = "deserialize_optional_millis")]
    pub timestamp: Option<chrono::DateTime<chrono::Utc>>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct BestBidAskEvent {
    pub asset_id: String,
    pub market: String,
    #[serde(deserialize_with = "deserialize_decimal_from_json")]
    pub best_bid: Decimal,
    #[serde(deserialize_with = "deserialize_decimal_from_json")]
    pub best_ask: Decimal,
    #[serde(deserialize_with = "deserialize_decimal_from_json")]
    pub spread: Decimal,
    #[serde(default, deserialize_with = "deserialize_optional_millis")]
    pub timestamp: Option<chrono::DateTime<chrono::Utc>>,
}

pub async fn run_market_feed(
    endpoint: String,
    asset_ids: Vec<String>,
    tx: mpsc::Sender<MarketWsEvent>,
) {
    let unique_assets = dedupe(asset_ids);
    let mut backoff = Duration::from_secs(1);

    loop {
        match connect_market_feed_once(&endpoint, &unique_assets, tx.clone()).await {
            Ok(()) => {
                warn!("market websocket ended cleanly; reconnecting");
                backoff = Duration::from_secs(1);
            }
            Err(error) => {
                warn!(error = %error, "market websocket disconnected");
            }
        }

        time::sleep(backoff).await;
        backoff = (backoff * 2).min(Duration::from_secs(30));
    }
}

async fn connect_market_feed_once(
    endpoint: &str,
    asset_ids: &[String],
    tx: mpsc::Sender<MarketWsEvent>,
) -> Result<()> {
    info!(
        endpoint,
        asset_count = asset_ids.len(),
        "connecting market websocket"
    );
    let (socket, _) = connect_async(endpoint)
        .await
        .context("connect market websocket")?;
    let (mut sink, mut stream) = socket.split();

    let subscription = json!({
        "assets_ids": asset_ids,
        "type": "market",
        "custom_feature_enabled": true,
    });
    sink.send(Message::Text(subscription.to_string().into()))
        .await?;

    let mut heartbeat = time::interval(Duration::from_secs(10));

    loop {
        tokio::select! {
            _ = heartbeat.tick() => {
                sink.send(Message::Ping(Vec::new().into())).await?;
            }
            frame = stream.next() => {
                let Some(frame) = frame else {
                    return Ok(());
                };
                match frame? {
                    Message::Text(text) => {
                        for event in parse_market_message(&text)? {
                            tx.send(event).await.context("send market event")?;
                        }
                    }
                    Message::Binary(bytes) => {
                        let text = String::from_utf8(bytes.to_vec()).context("binary market message was not UTF-8")?;
                        for event in parse_market_message(&text)? {
                            tx.send(event).await.context("send market event")?;
                        }
                    }
                    Message::Ping(payload) => sink.send(Message::Pong(payload)).await?,
                    Message::Pong(_) => debug!("market websocket pong"),
                    Message::Close(close) => {
                        warn!(?close, "market websocket close frame");
                        return Ok(());
                    }
                    Message::Frame(_) => {}
                }
            }
        }
    }
}

pub fn parse_market_message(text: &str) -> Result<Vec<MarketWsEvent>> {
    let trimmed = text.trim();
    if trimmed.is_empty() || trimmed == "PONG" {
        return Ok(Vec::new());
    }

    let value: Value = serde_json::from_str(trimmed).context("parse market websocket JSON")?;
    match value {
        Value::Array(values) => values.into_iter().map(parse_market_event).collect(),
        value => Ok(vec![parse_market_event(value)?]),
    }
}

fn parse_market_event(value: Value) -> Result<MarketWsEvent> {
    let event_type = value
        .get("event_type")
        .and_then(Value::as_str)
        .unwrap_or("unknown")
        .to_string();

    match event_type.as_str() {
        "book" => Ok(MarketWsEvent::Book(serde_json::from_value(value)?)),
        "price_change" => Ok(MarketWsEvent::PriceChange(serde_json::from_value(value)?)),
        "tick_size_change" => Ok(MarketWsEvent::TickSizeChange(serde_json::from_value(
            value,
        )?)),
        "last_trade_price" => Ok(MarketWsEvent::LastTradePrice(serde_json::from_value(
            value,
        )?)),
        "best_bid_ask" => Ok(MarketWsEvent::BestBidAsk(serde_json::from_value(value)?)),
        "new_market" => Ok(MarketWsEvent::NewMarket(value)),
        "market_resolved" => Ok(MarketWsEvent::MarketResolved(value)),
        _ => Ok(MarketWsEvent::Unknown {
            event_type,
            raw: value,
        }),
    }
}

fn dedupe(asset_ids: Vec<String>) -> Vec<String> {
    let mut seen = HashSet::new();
    asset_ids
        .into_iter()
        .filter(|asset_id| seen.insert(asset_id.clone()))
        .collect()
}

fn optional_decimal<'de, D>(deserializer: D) -> Result<Option<Decimal>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = Option::<Value>::deserialize(deserializer)?;
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(text)) => text
            .trim()
            .parse::<Decimal>()
            .map(Some)
            .map_err(serde::de::Error::custom),
        Some(Value::Number(number)) => number
            .to_string()
            .parse::<Decimal>()
            .map(Some)
            .map_err(serde::de::Error::custom),
        Some(other) => Err(serde::de::Error::custom(format!(
            "expected decimal string, number, or null; got {other}"
        ))),
    }
}

impl<'de> Deserialize<'de> for PriceLevel {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        #[derive(Deserialize)]
        struct RawPriceLevel {
            #[serde(deserialize_with = "deserialize_decimal_from_json")]
            price: Decimal,
            #[serde(deserialize_with = "deserialize_decimal_from_json")]
            size: Decimal,
        }

        let raw = RawPriceLevel::deserialize(deserializer)?;
        Ok(Self {
            price: raw.price,
            size: raw.size,
        })
    }
}

#[cfg(test)]
mod tests {
    use rust_decimal::Decimal;

    use super::{MarketWsEvent, parse_market_message};

    #[test]
    fn parses_book_message() {
        let events = parse_market_message(
            r#"{
                "event_type":"book",
                "asset_id":"1",
                "market":"0xabc",
                "bids":[{"price":".48","size":"30"}],
                "asks":[{"price":".52","size":"25"}],
                "timestamp":"123456789000",
                "hash":"0x1"
            }"#,
        )
        .unwrap();

        let MarketWsEvent::Book(book) = &events[0] else {
            panic!("expected book event");
        };

        assert_eq!(book.asset_id, "1");
        assert_eq!(book.bids[0].price, Decimal::new(48, 2));
    }

    #[test]
    fn parses_price_change_array_message() {
        let events = parse_market_message(
            r#"[{
                "event_type":"price_change",
                "market":"0xabc",
                "price_changes":[{
                    "asset_id":"1",
                    "price":"0.5",
                    "size":"0",
                    "side":"BUY",
                    "best_bid":"0.49",
                    "best_ask":"0.51"
                }],
                "timestamp":"1757908892351"
            }]"#,
        )
        .unwrap();

        let MarketWsEvent::PriceChange(change) = &events[0] else {
            panic!("expected price_change event");
        };

        assert_eq!(change.price_changes[0].size, Decimal::ZERO);
    }
}
