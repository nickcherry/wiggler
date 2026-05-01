use std::fmt;

use chrono::{DateTime, Utc};
use rust_decimal::Decimal;

use crate::domain::asset::Asset;

#[derive(Clone, Debug)]
pub struct Candle {
    pub source: CandleSource,
    pub asset: Asset,
    pub start: DateTime<Utc>,
    pub open: Decimal,
    pub high: Decimal,
    pub low: Decimal,
    pub close: Decimal,
    pub volume: Decimal,
    pub received_at: DateTime<Utc>,
}

impl Candle {
    pub(crate) fn key(&self) -> CandleKey {
        CandleKey {
            source: self.source,
            asset: self.asset,
            start_timestamp: self.start.timestamp(),
        }
    }

    pub(crate) fn values(&self) -> CandleValues {
        CandleValues {
            open: self.open,
            high: self.high,
            low: self.low,
            close: self.close,
            volume: self.volume,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub enum CandleSource {
    Binance,
    Coinbase,
}

impl CandleSource {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Binance => "binance",
            Self::Coinbase => "coinbase",
        }
    }
}

impl fmt::Display for CandleSource {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub(crate) struct CandleKey {
    pub source: CandleSource,
    pub asset: Asset,
    pub start_timestamp: i64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct CandleValues {
    pub open: Decimal,
    pub high: Decimal,
    pub low: Decimal,
    pub close: Decimal,
    pub volume: Decimal,
}
