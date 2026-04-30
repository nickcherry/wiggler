use std::collections::{BTreeMap, VecDeque};

use chrono::{DateTime, TimeDelta, Utc};
use rust_decimal::{Decimal, prelude::ToPrimitive};

const MAX_HISTORY_MINUTES: i64 = 35;

#[derive(Clone, Debug, Default)]
pub struct PriceHistory {
    samples: VecDeque<PriceSample>,
}

impl PriceHistory {
    pub fn push(&mut self, timestamp: DateTime<Utc>, price: Decimal) {
        self.samples.push_back(PriceSample { timestamp, price });

        let cutoff = timestamp - TimeDelta::minutes(MAX_HISTORY_MINUTES);
        while self
            .samples
            .front()
            .is_some_and(|sample| sample.timestamp < cutoff)
        {
            self.samples.pop_front();
        }
    }

    pub fn vol_bps_per_sqrt_min(&self, now: DateTime<Utc>, lookback_min: u32) -> Option<f64> {
        let cutoff = now - TimeDelta::minutes(i64::from(lookback_min) + 1);
        let mut by_minute = BTreeMap::<i64, PriceSample>::new();

        for sample in &self.samples {
            if sample.timestamp < cutoff || sample.timestamp > now {
                continue;
            }

            let minute = sample.timestamp.timestamp().div_euclid(60);
            let should_replace = by_minute
                .get(&minute)
                .is_none_or(|existing| sample.timestamp >= existing.timestamp);
            if should_replace {
                by_minute.insert(minute, *sample);
            }
        }

        let required_points = lookback_min as usize + 1;
        if by_minute.len() < required_points {
            return None;
        }

        let prices = by_minute
            .values()
            .rev()
            .take(required_points)
            .map(|sample| sample.price.to_f64())
            .collect::<Option<Vec<_>>>()?;
        let prices = prices.into_iter().rev().collect::<Vec<_>>();
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
}

#[derive(Clone, Copy, Debug)]
struct PriceSample {
    timestamp: DateTime<Utc>,
    price: Decimal,
}

#[cfg(test)]
mod tests {
    use chrono::{TimeDelta, TimeZone, Utc};
    use rust_decimal::Decimal;

    use super::PriceHistory;

    #[test]
    fn requires_full_lookback_window() {
        let start = Utc.with_ymd_and_hms(2026, 4, 30, 12, 0, 0).unwrap();
        let mut history = PriceHistory::default();
        history.push(start, Decimal::new(100, 0));
        history.push(start + TimeDelta::minutes(1), Decimal::new(101, 0));

        assert!(
            history
                .vol_bps_per_sqrt_min(start + TimeDelta::minutes(1), 30)
                .is_none()
        );
    }

    #[test]
    fn computes_rms_minute_return_vol() {
        let start = Utc.with_ymd_and_hms(2026, 4, 30, 12, 0, 0).unwrap();
        let mut history = PriceHistory::default();
        history.push(start, Decimal::new(100, 0));
        history.push(start + TimeDelta::minutes(1), Decimal::new(101, 0));
        history.push(start + TimeDelta::minutes(2), Decimal::new(100, 0));

        let vol = history
            .vol_bps_per_sqrt_min(start + TimeDelta::minutes(2), 2)
            .unwrap();
        let expected = ((100.0_f64.powi(2) + 99.00990099009901_f64.powi(2)) / 2.0).sqrt();

        assert!((vol - expected).abs() < 0.000001);
    }
}
