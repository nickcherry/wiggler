use std::env;

pub const DEFAULT_GAMMA_BASE_URL: &str = "https://gamma-api.polymarket.com";
pub const DEFAULT_CLOB_MARKET_WS_URL: &str = "wss://ws-subscriptions-clob.polymarket.com/ws/market";
pub const DEFAULT_RTDS_WS_URL: &str = "wss://ws-live-data.polymarket.com";

#[derive(Clone, Debug)]
pub struct RuntimeConfig {
    pub gamma_base_url: String,
    pub clob_market_ws_url: String,
    pub rtds_ws_url: String,
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
