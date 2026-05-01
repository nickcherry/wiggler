use std::{sync::Arc, time::Duration};

use chrono::{DateTime, TimeDelta, Utc};
use reqwest::Client;
use tokio::{
    sync::{Mutex, mpsc},
    time,
};
use tracing::{debug, info, warn};

use crate::{
    domain::asset::Asset,
    exchange_candles::{
        binance::{fetch_binance_candles, run_binance_kline_ws},
        coinbase::fetch_coinbase_candles,
        types::{Candle, CandleKey, CandleSource, CandleValues},
    },
};

const BACKFILL_EXTRA_MINUTES: u32 = 2;
const CACHE_EXTRA_MINUTES: i64 = 5;

#[derive(Clone)]
pub struct LiveCandleFeedConfig {
    pub coinbase_api_base_url: String,
    pub binance_api_base_url: String,
    pub binance_market_ws_url: String,
    pub rest_sync_interval: Duration,
}

pub async fn run_live_candle_feed(
    config: LiveCandleFeedConfig,
    assets: Vec<Asset>,
    lookback_min: u32,
    tx: mpsc::Sender<Candle>,
) {
    if assets.is_empty() || lookback_min == 0 {
        return;
    }

    let cache = Arc::new(Mutex::new(PublishedCandleCache::new(
        i64::from(lookback_min) + CACHE_EXTRA_MINUTES,
    )));
    let client = Client::new();

    info!(
        asset_count = assets.len(),
        lookback_min,
        rest_sync_interval_ms = config.rest_sync_interval.as_millis(),
        "starting live exchange candle feed"
    );

    tokio::join!(
        run_rest_sync(
            client,
            config.clone(),
            assets.clone(),
            lookback_min,
            cache.clone(),
            tx.clone(),
        ),
        run_binance_kline_ws(config, assets, cache, tx),
    );
}

async fn run_rest_sync(
    client: Client,
    config: LiveCandleFeedConfig,
    assets: Vec<Asset>,
    lookback_min: u32,
    cache: Arc<Mutex<PublishedCandleCache>>,
    tx: mpsc::Sender<Candle>,
) {
    sync_all_rest_once(
        &client,
        &config,
        &assets,
        lookback_min,
        cache.clone(),
        tx.clone(),
    )
    .await;

    let mut interval = time::interval(config.rest_sync_interval);
    interval.tick().await;
    loop {
        interval.tick().await;
        sync_all_rest_once(
            &client,
            &config,
            &assets,
            lookback_min,
            cache.clone(),
            tx.clone(),
        )
        .await;
    }
}

async fn sync_all_rest_once(
    client: &Client,
    config: &LiveCandleFeedConfig,
    assets: &[Asset],
    lookback_min: u32,
    cache: Arc<Mutex<PublishedCandleCache>>,
    tx: mpsc::Sender<Candle>,
) {
    let now = Utc::now();
    let Some((start, end)) = closed_candle_range(now, lookback_min) else {
        return;
    };

    for asset in assets {
        match fetch_binance_candles(client, &config.binance_api_base_url, *asset, start, end).await
        {
            Ok(candles) => publish_candles(candles, cache.clone(), tx.clone()).await,
            Err(error) => warn!(
                source = %CandleSource::Binance,
                asset = %asset,
                error = %error,
                "failed to fetch exchange candles"
            ),
        }

        if let Some(product_id) = asset.coinbase_product_id() {
            match fetch_coinbase_candles(
                client,
                &config.coinbase_api_base_url,
                *asset,
                product_id,
                start,
                end,
            )
            .await
            {
                Ok(candles) => publish_candles(candles, cache.clone(), tx.clone()).await,
                Err(error) => warn!(
                    source = %CandleSource::Coinbase,
                    asset = %asset,
                    error = %error,
                    "failed to fetch exchange candles"
                ),
            }
        } else {
            debug!(
                source = %CandleSource::Coinbase,
                asset = %asset,
                "asset has no Coinbase spot product mapping"
            );
        }
    }
}

pub(super) async fn publish_candles(
    mut candles: Vec<Candle>,
    cache: Arc<Mutex<PublishedCandleCache>>,
    tx: mpsc::Sender<Candle>,
) {
    candles.sort_by_key(|candle| candle.start);

    for candle in candles {
        let should_publish = {
            let mut cache = cache.lock().await;
            cache.should_publish(&candle, Utc::now())
        };

        if should_publish && let Err(error) = tx.send(candle).await {
            warn!(error = %error, "failed to send exchange candle");
            return;
        }
    }
}

fn closed_candle_range(
    now: DateTime<Utc>,
    lookback_min: u32,
) -> Option<(DateTime<Utc>, DateTime<Utc>)> {
    let end_seconds = now.timestamp().div_euclid(60) * 60;
    let end = DateTime::from_timestamp(end_seconds, 0)?;
    let start = end - TimeDelta::minutes(i64::from(lookback_min + BACKFILL_EXTRA_MINUTES));
    Some((start, end))
}

pub(super) struct PublishedCandleCache {
    retention: TimeDelta,
    seen: std::collections::HashMap<CandleKey, CandleValues>,
}

impl PublishedCandleCache {
    fn new(retention_min: i64) -> Self {
        Self {
            retention: TimeDelta::minutes(retention_min),
            seen: std::collections::HashMap::new(),
        }
    }

    fn should_publish(&mut self, candle: &Candle, now: DateTime<Utc>) -> bool {
        let cutoff = (now - self.retention).timestamp();
        self.seen.retain(|key, _| key.start_timestamp >= cutoff);

        let key = candle.key();
        let values = candle.values();
        if self.seen.get(&key) == Some(&values) {
            return false;
        }

        self.seen.insert(key, values);
        true
    }
}

#[cfg(test)]
mod tests {
    use chrono::{TimeZone, Utc};
    use rust_decimal::Decimal;

    use super::*;

    #[test]
    fn published_candle_cache_prunes_old_entries_dedupes_and_allows_corrections() {
        let now = Utc.with_ymd_and_hms(2026, 5, 1, 12, 30, 0).unwrap();
        let mut cache = PublishedCandleCache::new(35);
        let candle = test_candle(CandleSource::Coinbase, now - TimeDelta::minutes(1), "100");

        assert!(cache.should_publish(&candle, now));
        assert!(!cache.should_publish(&candle, now));

        let other_source = Candle {
            source: CandleSource::Binance,
            ..candle.clone()
        };
        assert!(cache.should_publish(&other_source, now));

        let corrected = Candle {
            close: Decimal::from_str_exact("101").unwrap(),
            ..candle
        };
        assert!(cache.should_publish(&corrected, now));
    }

    fn test_candle(source: CandleSource, start: DateTime<Utc>, close: &str) -> Candle {
        let close = Decimal::from_str_exact(close).unwrap();
        Candle {
            source,
            asset: Asset::Btc,
            start,
            open: close,
            high: close,
            low: close,
            close,
            volume: Decimal::new(1, 0),
            received_at: start + TimeDelta::minutes(1),
        }
    }
}
