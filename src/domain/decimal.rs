use std::str::FromStr;

use anyhow::{Context, Result};
use rust_decimal::Decimal;
use serde::{Deserialize, Deserializer, de::Error as SerdeError};
use serde_json::Value;

pub const PROBABILITY_SCALE: u32 = 6;
pub const ASSET_PRICE_SCALE: u32 = 8;

pub fn parse_decimal(value: &str) -> Result<Decimal> {
    Decimal::from_str(value.trim()).with_context(|| format!("invalid decimal: {value}"))
}

pub fn decimal_to_scaled_i128(value: Decimal, scale: u32) -> i128 {
    let multiplier = Decimal::from(10_i64.pow(scale));
    (value * multiplier).round().mantissa()
}

pub fn deserialize_decimal_from_json<'de, D>(deserializer: D) -> Result<Decimal, D::Error>
where
    D: Deserializer<'de>,
{
    let value = Value::deserialize(deserializer)?;
    match value {
        Value::String(text) => Decimal::from_str(text.trim()).map_err(SerdeError::custom),
        Value::Number(number) => Decimal::from_str(&number.to_string()).map_err(SerdeError::custom),
        other => Err(SerdeError::custom(format!(
            "expected decimal string or number, got {other}"
        ))),
    }
}

#[cfg(test)]
mod tests {
    use rust_decimal::Decimal;

    use super::{ASSET_PRICE_SCALE, PROBABILITY_SCALE, decimal_to_scaled_i128, parse_decimal};

    #[test]
    fn scales_probability_prices_to_e6() {
        let value = parse_decimal("0.523").unwrap();
        assert_eq!(decimal_to_scaled_i128(value, PROBABILITY_SCALE), 523_000);
    }

    #[test]
    fn scales_asset_prices_to_e8() {
        let value = Decimal::new(67_234_501_234, 6);
        assert_eq!(
            decimal_to_scaled_i128(value, ASSET_PRICE_SCALE),
            6_723_450_123_400
        );
    }
}
