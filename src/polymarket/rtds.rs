use std::{fmt, time::Duration};

use anyhow::{Context, Result};
use clap::ValueEnum;
use futures_util::{SinkExt, StreamExt};
use rust_decimal::Decimal;
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::{sync::mpsc, time};
use tokio_tungstenite::{connect_async, tungstenite::Message};
use tracing::{debug, info, warn};

use crate::{
    domain::{asset::Asset, decimal::deserialize_decimal_from_json},
    polymarket::serde_helpers::deserialize_millis,
};

#[derive(Clone, Copy, Debug, Eq, PartialEq, ValueEnum)]
pub enum PriceFeedSource {
    Chainlink,
    Binance,
}

impl fmt::Display for PriceFeedSource {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Chainlink => formatter.write_str("chainlink"),
            Self::Binance => formatter.write_str("binance"),
        }
    }
}

#[derive(Clone, Debug)]
pub struct PriceTick {
    pub asset: Asset,
    pub source: PriceFeedSource,
    pub symbol: String,
    pub value: Decimal,
    pub exchange_timestamp: chrono::DateTime<chrono::Utc>,
    pub received_at: chrono::DateTime<chrono::Utc>,
}

pub async fn run_price_feed(
    endpoint: String,
    asset: Asset,
    source: PriceFeedSource,
    tx: mpsc::Sender<PriceTick>,
) {
    let mut backoff = Duration::from_secs(1);

    loop {
        match connect_price_feed_once(&endpoint, asset, source, tx.clone()).await {
            Ok(()) => {
                warn!(source = %source, "RTDS websocket ended cleanly; reconnecting");
                backoff = Duration::from_secs(1);
            }
            Err(error) => {
                warn!(source = %source, error = %error, "RTDS websocket disconnected");
            }
        }

        time::sleep(backoff).await;
        backoff = (backoff * 2).min(Duration::from_secs(30));
    }
}

async fn connect_price_feed_once(
    endpoint: &str,
    asset: Asset,
    source: PriceFeedSource,
    tx: mpsc::Sender<PriceTick>,
) -> Result<()> {
    info!(endpoint, source = %source, asset = %asset, "connecting RTDS websocket");
    let (socket, _) = connect_async(endpoint)
        .await
        .context("connect RTDS websocket")?;
    let (mut sink, mut stream) = socket.split();

    sink.send(Message::Text(
        subscription_message(asset, source).to_string().into(),
    ))
    .await?;

    let mut heartbeat = time::interval(Duration::from_secs(5));

    loop {
        tokio::select! {
            _ = heartbeat.tick() => {
                sink.send(Message::Text("PING".into())).await?;
            }
            frame = stream.next() => {
                let Some(frame) = frame else {
                    return Ok(());
                };
                match frame? {
                    Message::Text(text) => {
                        if text.trim() == "PONG" {
                            debug!("RTDS pong");
                            continue;
                        }

                        if let Some(tick) = parse_price_message(&text, source, asset)? {
                            tx.send(tick).await.context("send RTDS price tick")?;
                        }
                    }
                    Message::Binary(bytes) => {
                        let text = String::from_utf8(bytes.to_vec()).context("binary RTDS message was not UTF-8")?;
                        if let Some(tick) = parse_price_message(&text, source, asset)? {
                            tx.send(tick).await.context("send RTDS price tick")?;
                        }
                    }
                    Message::Ping(payload) => sink.send(Message::Pong(payload)).await?,
                    Message::Pong(_) => debug!("RTDS websocket pong frame"),
                    Message::Close(close) => {
                        warn!(?close, "RTDS close frame");
                        return Ok(());
                    }
                    Message::Frame(_) => {}
                }
            }
        }
    }
}

pub fn subscription_message(asset: Asset, source: PriceFeedSource) -> Value {
    match source {
        PriceFeedSource::Chainlink => json!({
            "action": "subscribe",
            "subscriptions": [{
                "topic": "crypto_prices_chainlink",
                "type": "*",
                "filters": json!({ "symbol": asset.chainlink_symbol() }).to_string(),
            }]
        }),
        PriceFeedSource::Binance => json!({
            "action": "subscribe",
            "subscriptions": [{
                "topic": "crypto_prices",
                "type": "update",
                "filters": asset.binance_symbol(),
            }]
        }),
    }
}

pub fn parse_price_message(
    text: &str,
    source_filter: PriceFeedSource,
    asset_filter: Asset,
) -> Result<Option<PriceTick>> {
    let trimmed = text.trim();
    if trimmed.is_empty() || trimmed == "PONG" {
        return Ok(None);
    }

    let message: RtdsMessage = serde_json::from_str(trimmed).context("parse RTDS JSON")?;
    let Some(source) = source_from_topic(&message.topic) else {
        return Ok(None);
    };
    if source != source_filter {
        return Ok(None);
    }

    let payload: PricePayload = serde_json::from_value(message.payload)?;
    if payload.symbol != expected_symbol(asset_filter, source_filter) {
        return Ok(None);
    }

    Ok(Some(PriceTick {
        asset: asset_filter,
        source,
        symbol: payload.symbol,
        value: payload.value,
        exchange_timestamp: payload.timestamp,
        received_at: message.timestamp,
    }))
}

fn expected_symbol(asset: Asset, source: PriceFeedSource) -> &'static str {
    match source {
        PriceFeedSource::Chainlink => asset.chainlink_symbol(),
        PriceFeedSource::Binance => asset.binance_symbol(),
    }
}

fn source_from_topic(topic: &str) -> Option<PriceFeedSource> {
    match topic {
        "crypto_prices_chainlink" => Some(PriceFeedSource::Chainlink),
        "crypto_prices" => Some(PriceFeedSource::Binance),
        _ => None,
    }
}

#[derive(Debug, Deserialize)]
struct RtdsMessage {
    topic: String,
    #[serde(rename = "type")]
    _message_type: String,
    #[serde(deserialize_with = "deserialize_millis")]
    timestamp: chrono::DateTime<chrono::Utc>,
    payload: Value,
}

#[derive(Debug, Deserialize)]
struct PricePayload {
    symbol: String,
    #[serde(deserialize_with = "deserialize_millis")]
    timestamp: chrono::DateTime<chrono::Utc>,
    #[serde(deserialize_with = "deserialize_decimal_from_json")]
    value: Decimal,
}

#[cfg(test)]
mod tests {
    use rust_decimal::Decimal;

    use super::{PriceFeedSource, parse_price_message};

    #[test]
    fn parses_chainlink_price_update() {
        let tick = parse_price_message(
            r#"{
                "topic":"crypto_prices_chainlink",
                "type":"update",
                "timestamp":1753314088421,
                "payload":{
                    "symbol":"btc/usd",
                    "timestamp":1753314088395,
                    "value":67234.50
                }
            }"#,
            PriceFeedSource::Chainlink,
            crate::domain::asset::Asset::Btc,
        )
        .unwrap()
        .unwrap();

        assert_eq!(tick.symbol, "btc/usd");
        assert_eq!(tick.value, Decimal::new(6_723_450, 2));
    }
}
