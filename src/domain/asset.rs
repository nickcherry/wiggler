use std::{fmt, str::FromStr};

use clap::ValueEnum;
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize, ValueEnum)]
pub enum Asset {
    Btc,
    Eth,
    Sol,
}

impl Asset {
    pub fn slug_code(self) -> &'static str {
        match self {
            Self::Btc => "btc",
            Self::Eth => "eth",
            Self::Sol => "sol",
        }
    }

    pub fn chainlink_symbol(self) -> &'static str {
        match self {
            Self::Btc => "btc/usd",
            Self::Eth => "eth/usd",
            Self::Sol => "sol/usd",
        }
    }

    pub fn binance_symbol(self) -> &'static str {
        match self {
            Self::Btc => "btcusdt",
            Self::Eth => "ethusdt",
            Self::Sol => "solusdt",
        }
    }
}

impl fmt::Display for Asset {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.slug_code())
    }
}

impl FromStr for Asset {
    type Err = String;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value.to_ascii_lowercase().as_str() {
            "btc" | "bitcoin" => Ok(Self::Btc),
            "eth" | "ethereum" => Ok(Self::Eth),
            "sol" | "solana" => Ok(Self::Sol),
            _ => Err(format!("unsupported asset: {value}")),
        }
    }
}
