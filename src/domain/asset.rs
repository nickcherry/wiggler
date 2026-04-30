use std::{fmt, str::FromStr};

use clap::ValueEnum;
use serde::{Deserialize, Serialize};

#[derive(
    Clone, Copy, Debug, Deserialize, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize, ValueEnum,
)]
pub enum Asset {
    Btc,
    Eth,
    Sol,
    Xrp,
    Doge,
    Hype,
    Bnb,
}

pub const DEFAULT_ASSET_WHITELIST: &str = "btc,eth,sol,xrp,doge,hype,bnb";

pub fn normalize_assets(mut assets: Vec<Asset>) -> Vec<Asset> {
    if assets.is_empty() {
        assets.push(Asset::Btc);
    }

    assets.sort();
    assets.dedup();
    assets
}

pub fn format_assets(assets: &[Asset]) -> String {
    assets
        .iter()
        .map(|asset| asset.slug_code())
        .collect::<Vec<_>>()
        .join(",")
}

impl Asset {
    pub fn slug_code(self) -> &'static str {
        match self {
            Self::Btc => "btc",
            Self::Eth => "eth",
            Self::Sol => "sol",
            Self::Xrp => "xrp",
            Self::Doge => "doge",
            Self::Hype => "hype",
            Self::Bnb => "bnb",
        }
    }

    pub fn chainlink_symbol(self) -> &'static str {
        match self {
            Self::Btc => "btc/usd",
            Self::Eth => "eth/usd",
            Self::Sol => "sol/usd",
            Self::Xrp => "xrp/usd",
            Self::Doge => "doge/usd",
            Self::Hype => "hype/usd",
            Self::Bnb => "bnb/usd",
        }
    }

    pub fn binance_symbol(self) -> &'static str {
        match self {
            Self::Btc => "btcusdt",
            Self::Eth => "ethusdt",
            Self::Sol => "solusdt",
            Self::Xrp => "xrpusdt",
            Self::Doge => "dogeusdt",
            Self::Hype => "hypeusdt",
            Self::Bnb => "bnbusdt",
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
            "xrp" | "ripple" => Ok(Self::Xrp),
            "doge" | "dogecoin" => Ok(Self::Doge),
            "hype" | "hyperliquid" => Ok(Self::Hype),
            "bnb" | "binancecoin" | "binance-coin" => Ok(Self::Bnb),
            _ => Err(format!("unsupported asset: {value}")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{Asset, DEFAULT_ASSET_WHITELIST, format_assets, normalize_assets};

    #[test]
    fn default_whitelist_matches_supported_trading_assets() {
        let assets = DEFAULT_ASSET_WHITELIST
            .split(',')
            .map(|asset| asset.parse::<Asset>().unwrap())
            .collect::<Vec<_>>();

        assert_eq!(
            format_assets(&normalize_assets(assets)),
            DEFAULT_ASSET_WHITELIST
        );
    }
}
