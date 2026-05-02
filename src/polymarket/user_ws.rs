use std::{str::FromStr, time::Duration};

use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use futures_util::StreamExt;
use polymarket_client_sdk_v2::{
    auth::Credentials,
    clob::{
        types::Side,
        ws::{
            Client as WsClient,
            types::response::{TradeMessage, TradeMessageStatus},
        },
    },
    types::{Address, B256},
    ws::config::Config as WsConfig,
};
use rust_decimal::prelude::ToPrimitive;
use tokio::{sync::mpsc, time};
use tracing::{info, warn};

use crate::trading::{LiveFill, LiveFillSource};

#[derive(Clone, Debug)]
pub struct UserFillFeedConfig {
    pub endpoint: String,
    pub credentials: Credentials,
    pub user_address: Address,
    pub condition_ids: Vec<String>,
}

pub async fn run_user_fill_feed(config: UserFillFeedConfig, tx: mpsc::Sender<LiveFill>) {
    loop {
        match run_user_fill_feed_once(&config, tx.clone()).await {
            Ok(()) => warn!(
                event = "polymarket_user_ws_closed",
                market_count = config.condition_ids.len(),
                "Polymarket user fill websocket ended"
            ),
            Err(error) => warn!(
                event = "polymarket_user_ws_error",
                market_count = config.condition_ids.len(),
                error = %format!("{error:#}"),
                "Polymarket user fill websocket failed"
            ),
        }
        time::sleep(Duration::from_secs(2)).await;
    }
}

async fn run_user_fill_feed_once(
    config: &UserFillFeedConfig,
    tx: mpsc::Sender<LiveFill>,
) -> Result<()> {
    let markets = config
        .condition_ids
        .iter()
        .map(|condition_id| {
            B256::from_str(condition_id)
                .with_context(|| format!("parse user websocket market {condition_id}"))
        })
        .collect::<Result<Vec<_>>>()?;
    if markets.is_empty() {
        return Ok(());
    }

    let client = WsClient::new(&config.endpoint, WsConfig::default())
        .with_context(|| format!("create user websocket client for {}", config.endpoint))?
        .authenticate(config.credentials.clone(), config.user_address)
        .context("authenticate user websocket client")?;
    let stream = client
        .subscribe_trades(markets)
        .context("subscribe to user trade fills")?;
    let mut stream = Box::pin(stream);

    info!(
        event = "polymarket_user_ws_subscribed",
        market_count = config.condition_ids.len(),
        "subscribed to Polymarket user fill websocket"
    );
    while let Some(message) = stream.next().await {
        match message {
            Ok(trade) => {
                if let Some(fill) = live_fill_from_user_trade(&trade)
                    && tx.send(fill).await.is_err()
                {
                    break;
                }
            }
            Err(error) => return Err(error).context("read user websocket trade"),
        }
    }

    Ok(())
}

fn live_fill_from_user_trade(trade: &TradeMessage) -> Option<LiveFill> {
    if !matches!(trade.side, Side::Buy) {
        return None;
    }
    if matches!(
        trade.status,
        TradeMessageStatus::Failed | TradeMessageStatus::Retrying | TradeMessageStatus::Unknown(_)
    ) {
        return None;
    }

    let size = trade.size.to_f64()?;
    let price = trade.price.to_f64()?;
    let matched_at = trade
        .matchtime
        .or(trade.timestamp)
        .or(trade.last_update)
        .and_then(timestamp_to_utc)
        .unwrap_or_else(Utc::now);
    let fill_id = trade.transaction_hash.as_ref().map_or_else(
        || format!("ws:{}:{}", trade.id, trade.asset_id),
        |hash| format!("tx:{hash}:{}", trade.asset_id),
    );

    LiveFill::new(
        trade.market.to_string(),
        trade.asset_id.to_string(),
        fill_id,
        size,
        price,
        matched_at,
        LiveFillSource::UserWebSocket,
    )
}

fn timestamp_to_utc(timestamp: i64) -> Option<DateTime<Utc>> {
    if timestamp > 10_000_000_000 {
        DateTime::<Utc>::from_timestamp_millis(timestamp)
    } else {
        DateTime::<Utc>::from_timestamp(timestamp, 0)
    }
}
