use std::{collections::HashMap, str::FromStr, time::Duration};

use anyhow::{Context, Result, anyhow};
use chrono::{DateTime, Utc};
use futures_util::{SinkExt, StreamExt};
use reqwest::Client;
use rust_decimal::Decimal;
use serde::Deserialize;
use serde_json::Value;
use tokio::{
    sync::{Mutex, mpsc},
    time,
};
use tokio_tungstenite::{connect_async, tungstenite::Message};
use tracing::{debug, info, warn};

use crate::{
    domain::asset::Asset,
    exchange_candles::{
        feed::{PublishedCandleCache, publish_candles},
        types::{Candle, CandleSource},
    },
};

use super::feed::LiveCandleFeedConfig;

const MAX_BINANCE_KLINE_LIMIT: u32 = 1000;

pub(super) async fn fetch_binance_candles(
    client: &Client,
    base_url: &str,
    asset: Asset,
    start: DateTime<Utc>,
    end: DateTime<Utc>,
) -> Result<Vec<Candle>> {
    let symbol = asset.binance_symbol().to_ascii_uppercase();
    let limit = ((end - start).num_minutes().max(1) as u32)
        .min(MAX_BINANCE_KLINE_LIMIT)
        .to_string();
    let end_time = (end.timestamp_millis() - 1).to_string();
    let url = format!("{}/api/v3/klines", base_url.trim_end_matches('/'));
    let rows = client
        .get(url)
        .query(&[
            ("symbol", symbol),
            ("interval", "1m".to_string()),
            ("endTime", end_time),
            ("limit", limit),
        ])
        .send()
        .await
        .context("request Binance candles")?
        .error_for_status()
        .context("Binance candles response status")?
        .json::<Vec<Value>>()
        .await
        .context("decode Binance candles response")?;

    let mut candles = parse_binance_rest_candles(asset, rows, Utc::now())?;
    candles.retain(|candle| candle.start >= start && candle.start < end);
    Ok(candles)
}

fn parse_binance_rest_candles(
    asset: Asset,
    rows: Vec<Value>,
    received_at: DateTime<Utc>,
) -> Result<Vec<Candle>> {
    rows.into_iter()
        .map(|row| {
            let values = row
                .as_array()
                .ok_or_else(|| anyhow!("Binance candle row was not an array"))?;
            let start = values
                .first()
                .and_then(value_as_i64)
                .and_then(DateTime::from_timestamp_millis)
                .context("Binance candle missing valid open timestamp")?;

            Ok(Candle {
                source: CandleSource::Binance,
                asset,
                start,
                open: values
                    .get(1)
                    .and_then(decimal_from_value)
                    .context("Binance candle missing open price")?,
                high: values
                    .get(2)
                    .and_then(decimal_from_value)
                    .context("Binance candle missing high price")?,
                low: values
                    .get(3)
                    .and_then(decimal_from_value)
                    .context("Binance candle missing low price")?,
                close: values
                    .get(4)
                    .and_then(decimal_from_value)
                    .context("Binance candle missing close price")?,
                volume: values
                    .get(5)
                    .and_then(decimal_from_value)
                    .context("Binance candle missing volume")?,
                received_at,
            })
        })
        .collect()
}

pub(super) async fn run_binance_kline_ws(
    config: LiveCandleFeedConfig,
    assets: Vec<Asset>,
    cache: std::sync::Arc<Mutex<PublishedCandleCache>>,
    tx: mpsc::Sender<Candle>,
) {
    let mut backoff = Duration::from_secs(1);

    loop {
        match connect_binance_kline_ws_once(
            &config.binance_market_ws_url,
            &assets,
            cache.clone(),
            tx.clone(),
        )
        .await
        {
            Ok(()) => {
                warn!("Binance kline websocket ended cleanly; reconnecting");
                backoff = Duration::from_secs(1);
            }
            Err(error) => {
                warn!(error = %error, "Binance kline websocket disconnected");
            }
        }

        time::sleep(backoff).await;
        backoff = (backoff * 2).min(Duration::from_secs(30));
    }
}

async fn connect_binance_kline_ws_once(
    base_url: &str,
    assets: &[Asset],
    cache: std::sync::Arc<Mutex<PublishedCandleCache>>,
    tx: mpsc::Sender<Candle>,
) -> Result<()> {
    let symbol_assets = assets
        .iter()
        .map(|asset| (asset.binance_symbol().to_ascii_uppercase(), *asset))
        .collect::<HashMap<_, _>>();
    let url = binance_combined_stream_url(base_url, assets);

    info!(
        endpoint = %url,
        asset_count = assets.len(),
        "connecting Binance kline websocket"
    );
    let (socket, _) = connect_async(&url)
        .await
        .context("connect Binance kline websocket")?;
    let (mut sink, mut stream) = socket.split();

    loop {
        let Some(frame) = stream.next().await else {
            return Ok(());
        };

        match frame? {
            Message::Text(text) => {
                if let Some(candle) = parse_binance_ws_candle(&text, &symbol_assets)? {
                    publish_candles(vec![candle], cache.clone(), tx.clone()).await;
                }
            }
            Message::Binary(bytes) => {
                let text = String::from_utf8(bytes.to_vec())
                    .context("binary Binance kline message was not UTF-8")?;
                if let Some(candle) = parse_binance_ws_candle(&text, &symbol_assets)? {
                    publish_candles(vec![candle], cache.clone(), tx.clone()).await;
                }
            }
            Message::Ping(payload) => sink.send(Message::Pong(payload)).await?,
            Message::Pong(_) => debug!("Binance kline websocket pong"),
            Message::Close(close) => {
                warn!(?close, "Binance kline websocket close frame");
                return Ok(());
            }
            Message::Frame(_) => {}
        }
    }
}

fn parse_binance_ws_candle(
    text: &str,
    symbol_assets: &HashMap<String, Asset>,
) -> Result<Option<Candle>> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }

    let value =
        serde_json::from_str::<Value>(trimmed).context("parse Binance kline websocket JSON")?;
    let data = value.get("data").unwrap_or(&value);
    let message: BinanceKlineMessage =
        serde_json::from_value(data.clone()).context("decode Binance kline websocket payload")?;
    if message.event_type != "kline" || message.kline.interval != "1m" || !message.kline.closed {
        return Ok(None);
    }

    let Some(asset) = symbol_assets.get(&message.symbol) else {
        return Ok(None);
    };
    let start = DateTime::from_timestamp_millis(message.kline.start_time)
        .context("Binance kline websocket missing valid open timestamp")?;

    Ok(Some(Candle {
        source: CandleSource::Binance,
        asset: *asset,
        start,
        open: Decimal::from_str(&message.kline.open).context("parse Binance kline open")?,
        high: Decimal::from_str(&message.kline.high).context("parse Binance kline high")?,
        low: Decimal::from_str(&message.kline.low).context("parse Binance kline low")?,
        close: Decimal::from_str(&message.kline.close).context("parse Binance kline close")?,
        volume: Decimal::from_str(&message.kline.volume).context("parse Binance kline volume")?,
        received_at: Utc::now(),
    }))
}

fn binance_combined_stream_url(base_url: &str, assets: &[Asset]) -> String {
    let streams = assets
        .iter()
        .map(|asset| format!("{}@kline_1m", asset.binance_symbol()))
        .collect::<Vec<_>>()
        .join("/");
    format!(
        "{}/stream?streams={streams}",
        base_url.trim_end_matches('/')
    )
}

fn value_as_i64(value: &Value) -> Option<i64> {
    value
        .as_i64()
        .or_else(|| value.as_u64().and_then(|value| value.try_into().ok()))
        .or_else(|| value.as_str().and_then(|value| value.parse().ok()))
}

fn decimal_from_value(value: &Value) -> Option<Decimal> {
    match value {
        Value::String(value) => Decimal::from_str(value).ok(),
        Value::Number(value) => Decimal::from_str(&value.to_string()).ok(),
        _ => None,
    }
}

#[derive(Deserialize)]
struct BinanceKlineMessage {
    #[serde(rename = "e")]
    event_type: String,
    #[serde(rename = "s")]
    symbol: String,
    #[serde(rename = "k")]
    kline: BinanceKline,
}

#[derive(Deserialize)]
struct BinanceKline {
    #[serde(rename = "t")]
    start_time: i64,
    #[serde(rename = "i")]
    interval: String,
    #[serde(rename = "o")]
    open: String,
    #[serde(rename = "h")]
    high: String,
    #[serde(rename = "l")]
    low: String,
    #[serde(rename = "c")]
    close: String,
    #[serde(rename = "v")]
    volume: String,
    #[serde(rename = "x")]
    closed: bool,
}

#[cfg(test)]
mod tests {
    use chrono::TimeZone;
    use serde_json::json;

    use super::*;

    #[test]
    fn parses_binance_rest_candles() {
        let candles = parse_binance_rest_candles(
            Asset::Btc,
            vec![json!([
                1777652880000_i64,
                "78283.99000000",
                "78368.08000000",
                "78278.75000000",
                "78368.08000000",
                "18.91572000",
                1777652939999_i64,
                "1481407.19461320",
                2301,
                "16.18199000",
                "1267320.08943820",
                "0"
            ])],
            Utc.with_ymd_and_hms(2026, 5, 1, 12, 0, 0).unwrap(),
        )
        .unwrap();

        assert_eq!(candles.len(), 1);
        assert_eq!(candles[0].source, CandleSource::Binance);
        assert_eq!(candles[0].start.timestamp_millis(), 1777652880000);
        assert_eq!(
            candles[0].open,
            Decimal::from_str("78283.99000000").unwrap()
        );
        assert_eq!(
            candles[0].high,
            Decimal::from_str("78368.08000000").unwrap()
        );
        assert_eq!(candles[0].low, Decimal::from_str("78278.75000000").unwrap());
        assert_eq!(
            candles[0].close,
            Decimal::from_str("78368.08000000").unwrap()
        );
        assert_eq!(candles[0].volume, Decimal::from_str("18.91572000").unwrap());
    }

    #[test]
    fn parses_only_closed_binance_ws_candles() {
        let mut symbols = HashMap::new();
        symbols.insert("BTCUSDT".to_string(), Asset::Btc);

        let text = json!({
            "stream": "btcusdt@kline_1m",
            "data": {
                "e": "kline",
                "E": 1672515840000_i64,
                "s": "BTCUSDT",
                "k": {
                    "t": 1672515780000_i64,
                    "T": 1672515839999_i64,
                    "s": "BTCUSDT",
                    "i": "1m",
                    "o": "0.0010",
                    "h": "0.0030",
                    "l": "0.0005",
                    "c": "0.0020",
                    "v": "12.3",
                    "x": true
                }
            }
        })
        .to_string();

        let candle = parse_binance_ws_candle(&text, &symbols).unwrap().unwrap();
        assert_eq!(candle.source, CandleSource::Binance);
        assert_eq!(candle.asset, Asset::Btc);
        assert_eq!(candle.start.timestamp_millis(), 1672515780000);
        assert_eq!(candle.open, Decimal::from_str("0.0010").unwrap());
        assert_eq!(candle.high, Decimal::from_str("0.0030").unwrap());
        assert_eq!(candle.low, Decimal::from_str("0.0005").unwrap());
        assert_eq!(candle.close, Decimal::from_str("0.0020").unwrap());
        assert_eq!(candle.volume, Decimal::from_str("12.3").unwrap());
    }

    #[test]
    fn ignores_open_binance_ws_candles() {
        let mut symbols = HashMap::new();
        symbols.insert("BTCUSDT".to_string(), Asset::Btc);

        let text = json!({
            "e": "kline",
            "s": "BTCUSDT",
            "k": {
                "t": 1672515780000_i64,
                "i": "1m",
                "o": "0.0010",
                "h": "0.0030",
                "l": "0.0005",
                "c": "0.0020",
                "v": "12.3",
                "x": false
            }
        })
        .to_string();

        assert!(parse_binance_ws_candle(&text, &symbols).unwrap().is_none());
    }
}
