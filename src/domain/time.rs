use anyhow::{Result, bail};
use chrono::{DateTime, TimeDelta, Utc};

use crate::domain::asset::Asset;

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct MarketSlot {
    start: DateTime<Utc>,
    duration: TimeDelta,
}

impl MarketSlot {
    pub fn current(now: DateTime<Utc>, duration: TimeDelta) -> Result<Self> {
        let duration_seconds = duration.num_seconds();
        if duration_seconds <= 0 {
            bail!("slot duration must be positive");
        }

        let start_timestamp = now.timestamp().div_euclid(duration_seconds) * duration_seconds;
        let start = DateTime::from_timestamp(start_timestamp, 0)
            .ok_or_else(|| anyhow::anyhow!("invalid slot timestamp: {start_timestamp}"))?;

        Ok(Self { start, duration })
    }

    pub fn from_start(start: DateTime<Utc>, duration: TimeDelta) -> Result<Self> {
        if duration.num_seconds() <= 0 {
            bail!("slot duration must be positive");
        }

        Ok(Self { start, duration })
    }

    pub fn offset(&self, slots: i64) -> Result<Self> {
        let multiplier: i32 = slots.try_into()?;
        let offset = self
            .duration
            .checked_mul(multiplier)
            .ok_or_else(|| anyhow::anyhow!("slot offset overflow"))?;
        let start = self.start + offset;

        Ok(Self {
            start,
            duration: self.duration,
        })
    }

    pub fn start(&self) -> DateTime<Utc> {
        self.start
    }

    pub fn end(&self) -> DateTime<Utc> {
        self.start + self.duration
    }

    pub fn duration(&self) -> TimeDelta {
        self.duration
    }

    pub fn slug(&self, asset: Asset) -> Result<String> {
        let duration_seconds = self.duration.num_seconds();
        if duration_seconds % 60 != 0 {
            bail!("Polymarket up/down slug builder requires minute-sized slots");
        }

        Ok(format!(
            "{}-updown-{}m-{}",
            asset.slug_code(),
            duration_seconds / 60,
            self.start.timestamp()
        ))
    }
}

pub fn duration_from_seconds(seconds: i64) -> Result<TimeDelta> {
    if seconds <= 0 {
        bail!("slot_seconds must be positive");
    }

    TimeDelta::try_seconds(seconds).ok_or_else(|| anyhow::anyhow!("slot_seconds overflow"))
}

#[cfg(test)]
mod tests {
    use chrono::{TimeDelta, TimeZone, Utc};

    use crate::domain::asset::Asset;

    use super::MarketSlot;

    #[test]
    fn floors_current_time_to_slot_start() {
        let now = Utc.with_ymd_and_hms(2026, 4, 30, 15, 46, 8).unwrap();
        let slot = MarketSlot::current(now, TimeDelta::minutes(5)).unwrap();

        assert_eq!(
            slot.start(),
            Utc.with_ymd_and_hms(2026, 4, 30, 15, 45, 0).unwrap()
        );
        assert_eq!(
            slot.end(),
            Utc.with_ymd_and_hms(2026, 4, 30, 15, 50, 0).unwrap()
        );
    }

    #[test]
    fn builds_polymarket_crypto_slug() {
        let start = Utc.with_ymd_and_hms(2026, 4, 30, 15, 20, 0).unwrap();
        let slot = MarketSlot::from_start(start, TimeDelta::minutes(5)).unwrap();

        assert_eq!(slot.slug(Asset::Btc).unwrap(), "btc-updown-5m-1777562400");
    }
}
