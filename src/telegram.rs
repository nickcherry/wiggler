use anyhow::{Context, Result};
use reqwest::Client;
use serde_json::json;

use crate::config::RuntimeConfig;

#[derive(Clone, Debug)]
pub struct TelegramClient {
    http: Client,
    bot_token: Option<String>,
    chat_id: Option<String>,
}

impl TelegramClient {
    pub fn from_config(config: &RuntimeConfig) -> Self {
        Self {
            http: Client::new(),
            bot_token: config.telegram_bot_token.clone(),
            chat_id: config.telegram_chat_id.clone(),
        }
    }

    pub fn is_configured(&self) -> bool {
        self.bot_token.is_some() && self.chat_id.is_some()
    }

    pub async fn send_message(&self, text: &str) -> Result<()> {
        let (Some(bot_token), Some(chat_id)) = (&self.bot_token, &self.chat_id) else {
            return Ok(());
        };

        let url = format!("https://api.telegram.org/bot{bot_token}/sendMessage");
        self.http
            .post(url)
            .json(&json!({
                "chat_id": chat_id,
                "text": text,
                "disable_web_page_preview": true,
            }))
            .send()
            .await
            .context("send Telegram message")?
            .error_for_status()
            .context("Telegram returned an error status")?;

        Ok(())
    }
}
