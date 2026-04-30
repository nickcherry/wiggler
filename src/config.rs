use std::{env, time::Duration};

use crate::domain::asset::{Asset, DEFAULT_ASSET_WHITELIST};

pub const DEFAULT_GAMMA_BASE_URL: &str = "https://gamma-api.polymarket.com";
pub const DEFAULT_CLOB_MARKET_WS_URL: &str = "wss://ws-subscriptions-clob.polymarket.com/ws/market";
pub const DEFAULT_RTDS_WS_URL: &str = "wss://ws-live-data.polymarket.com";
pub const DEFAULT_PRICE_STALE_AFTER_MS: u64 = 20_000;
pub const DEFAULT_ORDERBOOK_STALE_AFTER_MS: u64 = 10_000;
pub const DEFAULT_MIN_ABS_D_BPS: f64 = 0.01;

#[derive(Clone, Debug)]
pub struct RuntimeConfig {
    pub gamma_base_url: String,
    pub clob_market_ws_url: String,
    pub rtds_ws_url: String,
    pub live_trading: bool,
    pub tradable_assets: Vec<Asset>,
    pub price_stale_after: Duration,
    pub orderbook_stale_after: Duration,
    pub min_abs_d_bps: f64,
    pub telegram_bot_token: Option<String>,
    pub telegram_chat_id: Option<String>,
}

impl RuntimeConfig {
    pub fn from_env() -> Self {
        Self {
            gamma_base_url: env_or_default("POLYMARKET_GAMMA_BASE_URL", DEFAULT_GAMMA_BASE_URL),
            clob_market_ws_url: env_or_default(
                "POLYMARKET_CLOB_MARKET_WS_URL",
                DEFAULT_CLOB_MARKET_WS_URL,
            ),
            rtds_ws_url: env_or_default("POLYMARKET_RTDS_WS_URL", DEFAULT_RTDS_WS_URL),
            live_trading: bool_env("WIGGLER_LIVE_TRADING", false),
            tradable_assets: asset_list_env("WIGGLER_TRADABLE_ASSETS"),
            price_stale_after: Duration::from_millis(u64_env(
                "WIGGLER_PRICE_STALE_AFTER_MS",
                DEFAULT_PRICE_STALE_AFTER_MS,
            )),
            orderbook_stale_after: Duration::from_millis(u64_env(
                "WIGGLER_ORDERBOOK_STALE_AFTER_MS",
                DEFAULT_ORDERBOOK_STALE_AFTER_MS,
            )),
            min_abs_d_bps: f64_env("WIGGLER_MIN_ABS_D_BPS", DEFAULT_MIN_ABS_D_BPS),
            telegram_bot_token: non_empty_env("TELEGRAM_BOT_TOKEN"),
            telegram_chat_id: non_empty_env("TELEGRAM_CHAT_ID"),
        }
    }

    pub fn telegram_is_configured(&self) -> bool {
        self.telegram_bot_token.is_some() && self.telegram_chat_id.is_some()
    }
}

fn env_or_default(name: &str, default_value: &str) -> String {
    env::var(name)
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| default_value.to_string())
}

fn non_empty_env(name: &str) -> Option<String> {
    env::var(name)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn bool_env(name: &str, default_value: bool) -> bool {
    let Some(value) = non_empty_env(name) else {
        return default_value;
    };

    matches!(
        value.to_ascii_lowercase().as_str(),
        "1" | "true" | "yes" | "y" | "on"
    )
}

fn u64_env(name: &str, default_value: u64) -> u64 {
    non_empty_env(name)
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(default_value)
}

fn f64_env(name: &str, default_value: f64) -> f64 {
    non_empty_env(name)
        .and_then(|value| value.parse::<f64>().ok())
        .unwrap_or(default_value)
}

fn asset_list_env(name: &str) -> Vec<Asset> {
    let value = env_or_default(name, DEFAULT_ASSET_WHITELIST);
    let mut assets = value
        .split(',')
        .filter_map(|asset| asset.trim().parse::<Asset>().ok())
        .collect::<Vec<_>>();
    assets.sort();
    assets.dedup();

    assets
}
