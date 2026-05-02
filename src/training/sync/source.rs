use std::time::Duration;

use anyhow::{Context, Result, bail};
use reqwest::Client;
use serde::Deserialize;
use serde_json::Value;
use tokio::time;
use tracing::warn;

use crate::domain::asset::Asset;

use super::{TrainingCandle, TrainingSource, datetime_from_millis};

pub(super) async fn fetch_coinbase_chunk(
    client: &Client,
    base_url: &str,
    asset: Asset,
    product_id: &str,
    cursor_ms: i64,
    chunk_end_ms: i64,
) -> Result<Vec<TrainingCandle>> {
    let url = format!(
        "{}/api/v3/brokerage/market/products/{}/candles?granularity=ONE_MINUTE&start={}&end={}",
        base_url.trim_end_matches('/'),
        product_id,
        cursor_ms / 1000,
        chunk_end_ms / 1000
    );
    let response: CoinbaseCandlesResponse = fetch_json_with_retry(client, &url).await?;
    let mut candles = response
        .candles
        .into_iter()
        .filter_map(|row| coinbase_row_to_candle(asset, product_id, row).transpose())
        .collect::<Result<Vec<_>>>()?;
    candles.retain(|candle| candle.open_time_ms >= cursor_ms && candle.open_time_ms < chunk_end_ms);
    candles.sort_by_key(|candle| candle.open_time_ms);
    Ok(candles)
}

pub(super) async fn fetch_binance_chunk(
    client: &Client,
    base_url: &str,
    asset: Asset,
    pair: &str,
    cursor_ms: i64,
    chunk_end_ms: i64,
    limit: i64,
) -> Result<Vec<TrainingCandle>> {
    let url = format!(
        "{}/api/v3/klines?symbol={}&interval=1m&startTime={}&endTime={}&limit={}",
        base_url.trim_end_matches('/'),
        pair,
        cursor_ms,
        chunk_end_ms - 1,
        limit
    );
    let rows: Vec<Value> = fetch_json_with_retry(client, &url).await?;
    let mut candles = Vec::new();
    for row in rows {
        if let Some(candle) = binance_row_to_candle(asset, pair, row)?
            && candle.open_time_ms >= cursor_ms
            && candle.open_time_ms < chunk_end_ms
        {
            candles.push(candle);
        }
    }
    candles.sort_by_key(|candle| candle.open_time_ms);
    Ok(candles)
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

fn coinbase_row_to_candle(
    asset: Asset,
    product_id: &str,
    row: CoinbaseCandle,
) -> Result<Option<TrainingCandle>> {
    let seconds = row
        .start
        .parse::<i64>()
        .with_context(|| format!("parse Coinbase candle start {}", row.start))?;
    let open_time_ms = seconds
        .checked_mul(1000)
        .context("Coinbase candle timestamp overflow")?;
    Ok(Some(TrainingCandle {
        source: TrainingSource::Coinbase,
        asset,
        exchange_pair: product_id.to_string(),
        open_time: datetime_from_millis(open_time_ms)?,
        open_time_ms,
        open_e8: decimal_to_e8(&row.open)?,
        high_e8: decimal_to_e8(&row.high)?,
        low_e8: decimal_to_e8(&row.low)?,
        close_e8: decimal_to_e8(&row.close)?,
        volume_e8: decimal_to_e8(&row.volume).ok(),
        trades: None,
    }))
}

fn binance_row_to_candle(asset: Asset, pair: &str, row: Value) -> Result<Option<TrainingCandle>> {
    let Some(values) = row.as_array() else {
        return Ok(None);
    };
    if values.len() < 9 {
        return Ok(None);
    }
    let open_time_ms = value_i64(&values[0]).context("Binance candle missing open time")?;
    Ok(Some(TrainingCandle {
        source: TrainingSource::Binance,
        asset,
        exchange_pair: pair.to_string(),
        open_time: datetime_from_millis(open_time_ms)?,
        open_time_ms,
        open_e8: decimal_to_e8(&value_string(&values[1]).context("Binance candle missing open")?)?,
        high_e8: decimal_to_e8(&value_string(&values[2]).context("Binance candle missing high")?)?,
        low_e8: decimal_to_e8(&value_string(&values[3]).context("Binance candle missing low")?)?,
        close_e8: decimal_to_e8(
            &value_string(&values[4]).context("Binance candle missing close")?,
        )?,
        volume_e8: value_string(&values[5]).and_then(|value| decimal_to_e8(&value).ok()),
        trades: value_i64(&values[8]).and_then(|value| i32::try_from(value).ok()),
    }))
}

async fn fetch_json_with_retry<T>(client: &Client, url: &str) -> Result<T>
where
    T: for<'de> Deserialize<'de>,
{
    let mut attempt = 1_u32;
    loop {
        let response = client
            .get(url)
            .send()
            .await
            .with_context(|| format!("request {url}"))?;
        if response.status().as_u16() == 429
            || response.status().as_u16() == 418
            || response.status().is_server_error()
        {
            if attempt > 5 {
                bail!(
                    "request failed after {attempt} attempts: {}",
                    response.status()
                );
            }
            let backoff_ms = (2_u64.pow(attempt) * 250).min(10_000);
            warn!(
                status = %response.status(),
                attempt,
                backoff_ms,
                "candle fetch backoff"
            );
            time::sleep(Duration::from_millis(backoff_ms)).await;
            attempt += 1;
            continue;
        }
        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            bail!(
                "request failed with {status}: {}",
                body.chars().take(240).collect::<String>()
            );
        }
        return response.json::<T>().await.context("decode candle response");
    }
}

fn value_i64(value: &Value) -> Option<i64> {
    value
        .as_i64()
        .or_else(|| value.as_u64().and_then(|value| i64::try_from(value).ok()))
        .or_else(|| value.as_str().and_then(|value| value.parse::<i64>().ok()))
}

fn value_string(value: &Value) -> Option<String> {
    match value {
        Value::String(value) => Some(value.clone()),
        Value::Number(value) => Some(value.to_string()),
        _ => None,
    }
}

fn decimal_to_e8(input: &str) -> Result<i64> {
    const SCALE_DIGITS: usize = 8;

    let value = input.trim();
    if value.is_empty() {
        bail!("cannot scale empty decimal");
    }
    let negative = value.starts_with('-');
    let body = if negative { &value[1..] } else { value };
    let (whole, fraction) = body.split_once('.').unwrap_or((body, ""));
    if whole.is_empty() && fraction.is_empty() {
        bail!("cannot parse decimal {input}");
    }
    if !whole.chars().all(|ch| ch.is_ascii_digit())
        || !fraction.chars().all(|ch| ch.is_ascii_digit())
    {
        bail!("cannot parse decimal {input}");
    }

    let whole = if whole.is_empty() { "0" } else { whole };
    let mut fraction_scaled = fraction.to_string();
    fraction_scaled.push_str("00000000");
    fraction_scaled.truncate(SCALE_DIGITS);
    let composed = format!("{whole}{fraction_scaled}");
    let magnitude = composed
        .trim_start_matches('0')
        .parse::<i128>()
        .unwrap_or(0);
    let signed = if negative { -magnitude } else { magnitude };
    i64::try_from(signed).with_context(|| format!("scaled decimal exceeds i64: {input}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scales_decimals_to_e8_with_truncation() {
        assert_eq!(decimal_to_e8("1").unwrap(), 100_000_000);
        assert_eq!(decimal_to_e8("1.23").unwrap(), 123_000_000);
        assert_eq!(decimal_to_e8("0.123456789").unwrap(), 12_345_678);
        assert_eq!(decimal_to_e8("0002.000000001").unwrap(), 200_000_000);
    }
}
