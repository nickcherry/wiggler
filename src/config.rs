use std::{env, path::PathBuf, time::Duration};

use anyhow::{Result, bail};

use crate::domain::asset::{Asset, DEFAULT_ASSET_WHITELIST};

pub const DEFAULT_GAMMA_BASE_URL: &str = "https://gamma-api.polymarket.com";
pub const DEFAULT_CLOB_API_URL: &str = "https://clob.polymarket.com";
pub const DEFAULT_CLOB_MARKET_WS_URL: &str = "wss://ws-subscriptions-clob.polymarket.com/ws/market";
pub const DEFAULT_RTDS_WS_URL: &str = "wss://ws-live-data.polymarket.com";
pub const DEFAULT_PRICE_STALE_AFTER_MS: u64 = 20_000;
pub const DEFAULT_ORDERBOOK_STALE_AFTER_MS: u64 = 10_000;
pub const DEFAULT_MIN_ABS_D_BPS: f64 = 0.01;
pub const DEFAULT_MIN_ORDER_USDC: f64 = 1.0;
pub const DEFAULT_MAX_ORDER_USDC: f64 = 25.0;
pub const DEFAULT_EVALUATION_INTERVAL_MS: u64 = 1_000;
pub const DEFAULT_LOG_EVALUATIONS: bool = false;
pub const DEFAULT_TRADE_RECORD_DIR: &str = "trade-records";

#[derive(Clone)]
pub struct RuntimeConfig {
    pub gamma_base_url: String,
    pub clob_api_url: String,
    pub clob_market_ws_url: String,
    pub rtds_ws_url: String,
    pub live_trading: bool,
    pub tradable_assets: Vec<Asset>,
    pub min_order_usdc: f64,
    pub max_order_usdc: f64,
    pub live_order_type: LiveOrderType,
    pub evaluation_interval: Duration,
    pub log_evaluations: bool,
    pub trade_record_dir: PathBuf,
    pub polymarket_private_key: Option<String>,
    pub polymarket_api_key: Option<String>,
    pub polymarket_api_secret: Option<String>,
    pub polymarket_api_passphrase: Option<String>,
    pub polymarket_api_nonce: Option<u32>,
    pub polymarket_signature_type: PolymarketSignatureType,
    pub polymarket_funder_address: Option<String>,
    pub price_stale_after: Duration,
    pub orderbook_stale_after: Duration,
    pub min_abs_d_bps: f64,
    pub telegram_enabled: bool,
    pub telegram_bot_token: Option<String>,
    pub telegram_chat_id: Option<String>,
}

impl RuntimeConfig {
    pub fn from_env() -> Result<Self> {
        let config = Self {
            gamma_base_url: env_or_default("POLYMARKET_GAMMA_BASE_URL", DEFAULT_GAMMA_BASE_URL),
            clob_api_url: env_or_default("POLYMARKET_CLOB_API_URL", DEFAULT_CLOB_API_URL),
            clob_market_ws_url: env_or_default(
                "POLYMARKET_CLOB_MARKET_WS_URL",
                DEFAULT_CLOB_MARKET_WS_URL,
            ),
            rtds_ws_url: env_or_default("POLYMARKET_RTDS_WS_URL", DEFAULT_RTDS_WS_URL),
            live_trading: bool_env("WIGGLER_LIVE_TRADING", false)?,
            tradable_assets: asset_list_env("WIGGLER_TRADABLE_ASSETS")?,
            min_order_usdc: f64_env("WIGGLER_MIN_ORDER_USDC", DEFAULT_MIN_ORDER_USDC)?,
            max_order_usdc: f64_env("WIGGLER_MAX_ORDER_USDC", DEFAULT_MAX_ORDER_USDC)?,
            live_order_type: enum_env("WIGGLER_LIVE_ORDER_TYPE", LiveOrderType::Fak)?,
            evaluation_interval: Duration::from_millis(u64_env(
                "WIGGLER_EVALUATION_INTERVAL_MS",
                DEFAULT_EVALUATION_INTERVAL_MS,
            )?),
            log_evaluations: bool_env("WIGGLER_LOG_EVALUATIONS", DEFAULT_LOG_EVALUATIONS)?,
            trade_record_dir: PathBuf::from(env_or_default(
                "WIGGLER_TRADE_RECORD_DIR",
                DEFAULT_TRADE_RECORD_DIR,
            )),
            polymarket_private_key: non_empty_env("POLYMARKET_PRIVATE_KEY"),
            polymarket_api_key: non_empty_env("POLYMARKET_API_KEY"),
            polymarket_api_secret: non_empty_env("POLYMARKET_API_SECRET"),
            polymarket_api_passphrase: non_empty_env("POLYMARKET_API_PASSPHRASE"),
            polymarket_api_nonce: u32_env("POLYMARKET_API_NONCE")?,
            polymarket_signature_type: enum_env(
                "POLYMARKET_SIGNATURE_TYPE",
                PolymarketSignatureType::Eoa,
            )?,
            polymarket_funder_address: non_empty_env("POLYMARKET_FUNDER_ADDRESS"),
            price_stale_after: Duration::from_millis(u64_env(
                "WIGGLER_PRICE_STALE_AFTER_MS",
                DEFAULT_PRICE_STALE_AFTER_MS,
            )?),
            orderbook_stale_after: Duration::from_millis(u64_env(
                "WIGGLER_ORDERBOOK_STALE_AFTER_MS",
                DEFAULT_ORDERBOOK_STALE_AFTER_MS,
            )?),
            min_abs_d_bps: f64_env("WIGGLER_MIN_ABS_D_BPS", DEFAULT_MIN_ABS_D_BPS)?,
            telegram_enabled: bool_env("WIGGLER_TELEGRAM_ENABLED", true)?,
            telegram_bot_token: non_empty_env("TELEGRAM_BOT_TOKEN"),
            telegram_chat_id: non_empty_env("TELEGRAM_CHAT_ID"),
        };
        config.validate()?;
        Ok(config)
    }

    pub fn telegram_is_configured(&self) -> bool {
        self.telegram_enabled
            && self.telegram_bot_token.is_some()
            && self.telegram_chat_id.is_some()
    }

    fn validate(&self) -> Result<()> {
        require_positive("WIGGLER_MIN_ORDER_USDC", self.min_order_usdc)?;
        require_positive("WIGGLER_MAX_ORDER_USDC", self.max_order_usdc)?;
        if self.max_order_usdc < self.min_order_usdc {
            bail!("WIGGLER_MAX_ORDER_USDC must be >= WIGGLER_MIN_ORDER_USDC");
        }
        require_non_negative("WIGGLER_MIN_ABS_D_BPS", self.min_abs_d_bps)?;
        if self.price_stale_after.is_zero() {
            bail!("WIGGLER_PRICE_STALE_AFTER_MS must be positive");
        }
        if self.orderbook_stale_after.is_zero() {
            bail!("WIGGLER_ORDERBOOK_STALE_AFTER_MS must be positive");
        }
        if self.evaluation_interval.is_zero() {
            bail!("WIGGLER_EVALUATION_INTERVAL_MS must be positive");
        }
        if self.tradable_assets.is_empty() {
            bail!("WIGGLER_TRADABLE_ASSETS must include at least one asset");
        }

        Ok(())
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LiveOrderType {
    Fak,
    Fok,
}

impl std::str::FromStr for LiveOrderType {
    type Err = String;

    fn from_str(value: &str) -> std::result::Result<Self, Self::Err> {
        match value.to_ascii_lowercase().as_str() {
            "fak" | "fill-and-kill" => Ok(Self::Fak),
            "fok" | "fill-or-kill" => Ok(Self::Fok),
            _ => Err(format!("unsupported live order type: {value}")),
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PolymarketSignatureType {
    Eoa,
    Proxy,
    GnosisSafe,
    Poly1271,
}

impl std::str::FromStr for PolymarketSignatureType {
    type Err = String;

    fn from_str(value: &str) -> std::result::Result<Self, Self::Err> {
        match value.to_ascii_lowercase().as_str() {
            "eoa" | "0" => Ok(Self::Eoa),
            "proxy" | "poly_proxy" | "1" => Ok(Self::Proxy),
            "gnosis-safe" | "gnosis_safe" | "safe" | "2" => Ok(Self::GnosisSafe),
            "poly1271" | "poly_1271" | "eip1271" | "3" => Ok(Self::Poly1271),
            _ => Err(format!("unsupported Polymarket signature type: {value}")),
        }
    }
}

fn env_or_default(name: &str, default_value: &str) -> String {
    env::var(name)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| default_value.to_string())
}

fn non_empty_env(name: &str) -> Option<String> {
    env::var(name)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn bool_env(name: &str, default_value: bool) -> Result<bool> {
    let Some(value) = non_empty_env(name) else {
        return Ok(default_value);
    };

    match value.to_ascii_lowercase().as_str() {
        "1" | "true" | "yes" | "y" | "on" => Ok(true),
        "0" | "false" | "no" | "n" | "off" => Ok(false),
        _ => bail!("{name} must be a boolean"),
    }
}

fn u64_env(name: &str, default_value: u64) -> Result<u64> {
    parse_env(name, default_value)
}

fn u32_env(name: &str) -> Result<Option<u32>> {
    non_empty_env(name)
        .map(|value| {
            value
                .parse::<u32>()
                .map_err(|_| anyhow::anyhow!("{name} must be an unsigned integer"))
        })
        .transpose()
}

fn f64_env(name: &str, default_value: f64) -> Result<f64> {
    parse_env(name, default_value)
}

fn asset_list_env(name: &str) -> Result<Vec<Asset>> {
    let value = env_or_default(name, DEFAULT_ASSET_WHITELIST);
    parse_asset_list(&value)
}

fn parse_asset_list(value: &str) -> Result<Vec<Asset>> {
    let mut assets = value
        .split(',')
        .filter(|asset| !asset.trim().is_empty())
        .map(|asset| asset.trim().parse::<Asset>().map_err(anyhow::Error::msg))
        .collect::<Result<Vec<_>>>()?;
    assets.sort();
    assets.dedup();

    Ok(assets)
}

fn enum_env<T>(name: &str, default_value: T) -> Result<T>
where
    T: std::str::FromStr,
    T::Err: std::fmt::Display,
{
    let Some(value) = non_empty_env(name) else {
        return Ok(default_value);
    };

    value
        .parse::<T>()
        .map_err(|error| anyhow::anyhow!("{error}"))
}

fn parse_env<T>(name: &str, default_value: T) -> Result<T>
where
    T: std::str::FromStr,
{
    let Some(value) = non_empty_env(name) else {
        return Ok(default_value);
    };

    value
        .parse::<T>()
        .map_err(|_| anyhow::anyhow!("{name} has an invalid value: {value}"))
}

fn require_positive(name: &str, value: f64) -> Result<()> {
    if !value.is_finite() || value <= 0.0 {
        bail!("{name} must be finite and positive");
    }
    Ok(())
}

fn require_non_negative(name: &str, value: f64) -> Result<()> {
    if !value.is_finite() || value < 0.0 {
        bail!("{name} must be finite and non-negative");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{LiveOrderType, PolymarketSignatureType, parse_asset_list};

    #[test]
    fn parses_live_order_type_aliases() {
        assert_eq!("fak".parse::<LiveOrderType>().unwrap(), LiveOrderType::Fak);
        assert_eq!(
            "fill-or-kill".parse::<LiveOrderType>().unwrap(),
            LiveOrderType::Fok
        );
        assert!("maker".parse::<LiveOrderType>().is_err());
    }

    #[test]
    fn parses_polymarket_signature_type_aliases() {
        assert_eq!(
            "eoa".parse::<PolymarketSignatureType>().unwrap(),
            PolymarketSignatureType::Eoa
        );
        assert_eq!(
            "gnosis_safe".parse::<PolymarketSignatureType>().unwrap(),
            PolymarketSignatureType::GnosisSafe
        );
        assert!("invalid".parse::<PolymarketSignatureType>().is_err());
    }

    #[test]
    fn asset_list_parser_rejects_unknown_assets() {
        assert!(parse_asset_list("btc,eth").is_ok());
        assert!(parse_asset_list("btc,not-an-asset").is_err());
    }
}
