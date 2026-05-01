use std::str::FromStr;

use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use reqwest::Client;
use rust_decimal::Decimal;
use serde::Deserialize;

use crate::{
    domain::asset::Asset,
    exchange_candles::types::{Candle, CandleSource},
};

pub(super) async fn fetch_coinbase_candles(
    client: &Client,
    base_url: &str,
    asset: Asset,
    product_id: &str,
    start: DateTime<Utc>,
    end: DateTime<Utc>,
) -> Result<Vec<Candle>> {
    let url = format!(
        "{}/api/v3/brokerage/market/products/{}/candles",
        base_url.trim_end_matches('/'),
        product_id
    );
    let response = client
        .get(url)
        .query(&[
            ("granularity", "ONE_MINUTE".to_string()),
            ("start", start.timestamp().to_string()),
            ("end", end.timestamp().to_string()),
        ])
        .send()
        .await
        .context("request Coinbase candles")?
        .error_for_status()
        .context("Coinbase candles response status")?
        .json::<CoinbaseCandlesResponse>()
        .await
        .context("decode Coinbase candles response")?;

    let mut candles = parse_coinbase_candles(asset, response.candles, Utc::now())?;
    candles.retain(|candle| candle.start >= start && candle.start < end);
    Ok(candles)
}

fn parse_coinbase_candles(
    asset: Asset,
    rows: Vec<CoinbaseCandle>,
    received_at: DateTime<Utc>,
) -> Result<Vec<Candle>> {
    rows.into_iter()
        .map(|candle| {
            let start = candle
                .start
                .parse::<i64>()
                .ok()
                .and_then(|seconds| DateTime::from_timestamp(seconds, 0))
                .context("Coinbase candle missing valid start timestamp")?;

            Ok(Candle {
                source: CandleSource::Coinbase,
                asset,
                start,
                open: Decimal::from_str(&candle.open).context("parse Coinbase candle open")?,
                high: Decimal::from_str(&candle.high).context("parse Coinbase candle high")?,
                low: Decimal::from_str(&candle.low).context("parse Coinbase candle low")?,
                close: Decimal::from_str(&candle.close).context("parse Coinbase candle close")?,
                volume: Decimal::from_str(&candle.volume)
                    .context("parse Coinbase candle volume")?,
                received_at,
            })
        })
        .collect()
}

#[derive(Deserialize)]
struct CoinbaseCandlesResponse {
    candles: Vec<CoinbaseCandle>,
}

#[derive(Deserialize)]
struct CoinbaseCandle {
    start: String,
    low: String,
    high: String,
    open: String,
    close: String,
    volume: String,
}

#[cfg(test)]
mod tests {
    use chrono::TimeZone;

    use super::*;

    #[test]
    fn parses_coinbase_public_candles() {
        let candles = parse_coinbase_candles(
            Asset::Btc,
            vec![CoinbaseCandle {
                start: "1777652700".to_string(),
                low: "78190.16".to_string(),
                high: "78265.21".to_string(),
                open: "78265.2".to_string(),
                close: "78209.02".to_string(),
                volume: "8.43515756".to_string(),
            }],
            Utc.with_ymd_and_hms(2026, 5, 1, 12, 0, 0).unwrap(),
        )
        .unwrap();

        assert_eq!(candles.len(), 1);
        assert_eq!(candles[0].source, CandleSource::Coinbase);
        assert_eq!(candles[0].asset, Asset::Btc);
        assert_eq!(candles[0].start.timestamp(), 1777652700);
        assert_eq!(candles[0].open, Decimal::from_str("78265.2").unwrap());
        assert_eq!(candles[0].high, Decimal::from_str("78265.21").unwrap());
        assert_eq!(candles[0].low, Decimal::from_str("78190.16").unwrap());
        assert_eq!(candles[0].close, Decimal::from_str("78209.02").unwrap());
        assert_eq!(candles[0].volume, Decimal::from_str("8.43515756").unwrap());
    }
}
