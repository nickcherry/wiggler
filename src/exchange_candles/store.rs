use std::collections::{BTreeMap, HashMap};

use chrono::{DateTime, TimeDelta, Utc};
use rust_decimal::prelude::ToPrimitive;

use crate::{
    domain::asset::Asset,
    exchange_candles::types::{Candle, CandleSource},
};

const DEFAULT_RETENTION_MINUTES: i64 = 35;

#[derive(Clone, Debug)]
pub struct CandleStore {
    retention: TimeDelta,
    candles: HashMap<(Asset, CandleSource), BTreeMap<i64, Candle>>,
}

impl Default for CandleStore {
    fn default() -> Self {
        Self::new(DEFAULT_RETENTION_MINUTES)
    }
}

impl CandleStore {
    pub fn new(retention_min: i64) -> Self {
        Self {
            retention: TimeDelta::minutes(retention_min.max(1)),
            candles: HashMap::new(),
        }
    }

    pub fn upsert(&mut self, candle: Candle) {
        let key = (candle.asset, candle.source);
        let cutoff = candle.start - self.retention;
        let source_candles = self.candles.entry(key).or_default();
        source_candles.retain(|_, existing| existing.start >= cutoff);
        source_candles.insert(candle.start.timestamp(), candle);
    }

    pub fn candles(&self, asset: Asset, source: CandleSource) -> Option<&BTreeMap<i64, Candle>> {
        self.candles.get(&(asset, source))
    }

    pub fn vol_bps_per_sqrt_min(
        &self,
        asset: Asset,
        now: DateTime<Utc>,
        lookback_min: u32,
    ) -> CandleVol {
        CandleVol {
            binance: self.source_vol_bps_per_sqrt_min(
                asset,
                CandleSource::Binance,
                now,
                lookback_min,
            ),
            coinbase: self.source_vol_bps_per_sqrt_min(
                asset,
                CandleSource::Coinbase,
                now,
                lookback_min,
            ),
        }
    }

    pub fn normalized_momentum_1m(
        &self,
        asset: Asset,
        now: DateTime<Utc>,
        vol_lookback_min: u32,
    ) -> CandleMomentum {
        CandleMomentum {
            binance: self.source_normalized_momentum_1m(
                asset,
                CandleSource::Binance,
                now,
                vol_lookback_min,
            ),
            coinbase: self.source_normalized_momentum_1m(
                asset,
                CandleSource::Coinbase,
                now,
                vol_lookback_min,
            ),
        }
    }

    fn source_vol_bps_per_sqrt_min(
        &self,
        asset: Asset,
        source: CandleSource,
        now: DateTime<Utc>,
        lookback_min: u32,
    ) -> Option<f64> {
        let end_minute = now.timestamp().div_euclid(60).checked_sub(1)?;
        let first_minute = end_minute.checked_sub(i64::from(lookback_min))?;
        let candles = self.candles.get(&(asset, source))?;
        let mut prices = Vec::with_capacity(lookback_min as usize + 1);

        for minute in first_minute..=end_minute {
            let close = candles.get(&(minute * 60))?.close.to_f64()?;
            prices.push(close);
        }

        candle_vol_from_prices(&prices)
    }

    fn source_normalized_momentum_1m(
        &self,
        asset: Asset,
        source: CandleSource,
        now: DateTime<Utc>,
        vol_lookback_min: u32,
    ) -> Option<f64> {
        let end_minute = now.timestamp().div_euclid(60).checked_sub(1)?;
        let previous_minute = end_minute.checked_sub(1)?;
        let candles = self.candles.get(&(asset, source))?;
        let previous = candles.get(&(previous_minute * 60))?.close.to_f64()?;
        let current = candles.get(&(end_minute * 60))?.close.to_f64()?;
        let vol = self.source_vol_bps_per_sqrt_min(asset, source, now, vol_lookback_min)?;

        if previous <= 0.0 || current <= 0.0 || vol <= f64::EPSILON {
            return None;
        }

        Some((current / previous).ln() * 10_000.0 / vol)
    }
}

#[derive(Clone, Copy, Debug, Default)]
pub struct CandleVol {
    pub binance: Option<f64>,
    pub coinbase: Option<f64>,
}

impl CandleVol {
    pub fn average(self) -> Option<f64> {
        match (self.binance, self.coinbase) {
            (Some(binance), Some(coinbase)) => Some((binance + coinbase) / 2.0),
            (Some(binance), None) => Some(binance),
            (None, Some(coinbase)) => Some(coinbase),
            (None, None) => None,
        }
    }

    pub fn source_count(self) -> u8 {
        u8::from(self.binance.is_some()) + u8::from(self.coinbase.is_some())
    }
}

#[derive(Clone, Copy, Debug, Default)]
pub struct CandleMomentum {
    pub binance: Option<f64>,
    pub coinbase: Option<f64>,
}

impl CandleMomentum {
    pub fn average(self) -> Option<f64> {
        match (self.binance, self.coinbase) {
            (Some(binance), Some(coinbase)) => Some((binance + coinbase) / 2.0),
            (Some(binance), None) => Some(binance),
            (None, Some(coinbase)) => Some(coinbase),
            (None, None) => None,
        }
    }

    pub fn source_count(self) -> u8 {
        u8::from(self.binance.is_some()) + u8::from(self.coinbase.is_some())
    }
}

fn candle_vol_from_prices(prices: &[f64]) -> Option<f64> {
    let mut squared_returns = Vec::with_capacity(prices.len().saturating_sub(1));

    for pair in prices.windows(2) {
        let previous = pair[0];
        let current = pair[1];
        if previous <= 0.0 {
            return None;
        }

        let return_bps = 10_000.0 * (current / previous - 1.0);
        squared_returns.push(return_bps * return_bps);
    }

    if squared_returns.is_empty() {
        return None;
    }

    let mean_square = squared_returns.iter().sum::<f64>() / squared_returns.len() as f64;
    Some(mean_square.sqrt())
}

#[cfg(test)]
mod tests {
    use chrono::{TimeDelta, TimeZone};
    use rust_decimal::Decimal;

    use super::*;

    #[test]
    fn stores_full_candles_and_prunes_old_entries() {
        let start = Utc.with_ymd_and_hms(2026, 5, 1, 12, 0, 0).unwrap();
        let mut store = CandleStore::new(2);
        store.upsert(candle(CandleSource::Binance, start, "100"));
        store.upsert(candle(
            CandleSource::Binance,
            start + TimeDelta::minutes(3),
            "103",
        ));

        let candles = store.candles(Asset::Btc, CandleSource::Binance).unwrap();
        assert!(!candles.contains_key(&start.timestamp()));
        assert!(candles.contains_key(&(start + TimeDelta::minutes(3)).timestamp()));
    }

    #[test]
    fn computes_source_vols_and_average() {
        let start = Utc.with_ymd_and_hms(2026, 5, 1, 12, 0, 0).unwrap();
        let mut store = CandleStore::new(35);
        for (source, prices) in [
            (CandleSource::Binance, ["100", "101", "100"]),
            (CandleSource::Coinbase, ["200", "200", "202"]),
        ] {
            for (offset, close) in prices.into_iter().enumerate() {
                store.upsert(candle(
                    source,
                    start + TimeDelta::minutes(offset as i64),
                    close,
                ));
            }
        }

        let vol = store.vol_bps_per_sqrt_min(Asset::Btc, start + TimeDelta::minutes(3), 2);
        let binance = ((100.0_f64.powi(2) + 99.00990099009901_f64.powi(2)) / 2.0).sqrt();
        let coinbase = ((0.0_f64.powi(2) + 100.0_f64.powi(2)) / 2.0).sqrt();

        assert_eq!(vol.source_count(), 2);
        assert!((vol.binance.unwrap() - binance).abs() < 0.000001);
        assert!((vol.coinbase.unwrap() - coinbase).abs() < 0.000001);
        assert!((vol.average().unwrap() - ((binance + coinbase) / 2.0)).abs() < 0.000001);
    }

    #[test]
    fn computes_normalized_momentum_from_last_closed_minute() {
        let start = Utc.with_ymd_and_hms(2026, 5, 1, 12, 0, 0).unwrap();
        let mut store = CandleStore::new(35);
        for (source, prices) in [
            (CandleSource::Binance, ["100", "101", "103"]),
            (CandleSource::Coinbase, ["200", "201", "199"]),
        ] {
            for (offset, close) in prices.into_iter().enumerate() {
                store.upsert(candle(
                    source,
                    start + TimeDelta::minutes(offset as i64),
                    close,
                ));
            }
        }

        let momentum = store.normalized_momentum_1m(Asset::Btc, start + TimeDelta::minutes(3), 2);
        let binance_vol = ((100.0_f64.powi(2) + 198.01980198019803_f64.powi(2)) / 2.0).sqrt();
        let coinbase_vol = ((50.0_f64.powi(2) + 99.50248756218906_f64.powi(2)) / 2.0).sqrt();
        let binance = (103.0_f64 / 101.0).ln() * 10_000.0 / binance_vol;
        let coinbase = (199.0_f64 / 201.0).ln() * 10_000.0 / coinbase_vol;

        assert_eq!(momentum.source_count(), 2);
        assert!((momentum.binance.unwrap() - binance).abs() < 0.000001);
        assert!((momentum.coinbase.unwrap() - coinbase).abs() < 0.000001);
        assert!((momentum.average().unwrap() - ((binance + coinbase) / 2.0)).abs() < 0.000001);
    }

    #[test]
    fn normalized_momentum_requires_current_previous_and_vol_history() {
        let start = Utc.with_ymd_and_hms(2026, 5, 1, 12, 0, 0).unwrap();
        let mut store = CandleStore::new(35);
        store.upsert(candle(CandleSource::Binance, start, "100"));
        store.upsert(candle(
            CandleSource::Binance,
            start + TimeDelta::minutes(2),
            "103",
        ));

        let momentum = store.normalized_momentum_1m(Asset::Btc, start + TimeDelta::minutes(3), 2);

        assert_eq!(momentum.source_count(), 0);
        assert!(momentum.average().is_none());
    }

    fn candle(source: CandleSource, start: DateTime<Utc>, close: &str) -> Candle {
        let close = close.parse::<Decimal>().unwrap();
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
