use std::{future, sync::Arc, time::Duration};

use anyhow::{Context, Result};
use chrono::{DateTime, TimeDelta, Utc};
use futures_util::{StreamExt, stream};
use tokio::{sync::mpsc, task::JoinHandle, time};
use tracing::{debug, info, warn};

use crate::{
    domain::{asset::Asset, market::MonitoredMarket, time::MarketSlot},
    polymarket::{
        gamma::GammaClient,
        market_ws::{MarketWsEvent, run_market_feed},
        user_ws::{UserFillFeedConfig, run_user_fill_feed},
    },
    trading::{LiveFill, LiveTradeExecutor},
};

use super::MonitorState;

const WATCHSET_REFRESH_TIMEOUT_SECONDS: u64 = 4;
const WATCHSET_FETCH_CONCURRENCY: usize = 8;

pub(super) struct WatchsetRefreshResult {
    pub(super) checked_at: DateTime<Utc>,
    pub(super) result: Result<Vec<MonitoredMarket>>,
}

#[derive(Clone)]
pub(super) struct WatchsetConfig {
    pub(super) ws_endpoint: String,
    pub(super) assets: Vec<Asset>,
    pub(super) duration: TimeDelta,
    pub(super) lookahead_slots: u32,
}

pub(super) fn apply_watchset_markets(
    markets: Vec<MonitoredMarket>,
    ws_endpoint: &str,
    state: &mut MonitorState,
    subscribed_asset_ids: &mut Vec<String>,
    market_handle: &mut Option<JoinHandle<()>>,
    market_tx: mpsc::Sender<MarketWsEvent>,
) {
    state.replace_markets(markets.clone());

    let next_asset_ids = asset_ids_for_markets(&markets);
    if *subscribed_asset_ids == next_asset_ids {
        return;
    }

    if let Some(handle) = market_handle.take() {
        handle.abort();
    }

    *subscribed_asset_ids = next_asset_ids.clone();
    if next_asset_ids.is_empty() {
        warn!("no Polymarket token ids discovered for watchset");
        return;
    }

    info!(
        asset_count = next_asset_ids.len(),
        market_count = markets.len(),
        "refreshing market websocket subscription"
    );
    *market_handle = Some(tokio::spawn(run_market_feed(
        ws_endpoint.to_string(),
        next_asset_ids,
        market_tx,
    )));
}

pub(super) async fn refresh_live_user_fill_feed(
    executor: Option<&Arc<LiveTradeExecutor>>,
    ws_endpoint: &str,
    state: &MonitorState,
    subscribed_condition_ids: &mut Vec<String>,
    user_fill_handle: &mut Option<JoinHandle<()>>,
    live_fill_tx: mpsc::Sender<LiveFill>,
) -> Result<()> {
    let Some(executor) = executor else {
        return Ok(());
    };

    let mut next_condition_ids = state.live_exposure_reconcile_condition_ids();
    next_condition_ids.sort();
    next_condition_ids.dedup();
    let handle_finished = user_fill_handle
        .as_ref()
        .is_some_and(JoinHandle::is_finished);
    if *subscribed_condition_ids == next_condition_ids && !handle_finished {
        return Ok(());
    }

    if let Some(handle) = user_fill_handle.take() {
        handle.abort();
    }
    *subscribed_condition_ids = next_condition_ids.clone();
    if next_condition_ids.is_empty() {
        return Ok(());
    }

    let config = UserFillFeedConfig {
        endpoint: ws_endpoint.to_string(),
        credentials: executor.current_credentials().await,
        user_address: executor.user_address(),
        condition_ids: next_condition_ids,
    };
    *user_fill_handle = Some(tokio::spawn(run_user_fill_feed(config, live_fill_tx)));

    Ok(())
}

pub(super) fn maybe_spawn_watchset_refresh(
    gamma: &GammaClient,
    config: &WatchsetConfig,
    tx: &mpsc::Sender<WatchsetRefreshResult>,
    in_flight: &mut bool,
) {
    if *in_flight {
        return;
    }

    *in_flight = true;
    let gamma = gamma.clone();
    let config = config.clone();
    let tx = tx.clone();
    tokio::spawn(async move {
        let result = fetch_watchset_with_timeout(&gamma, &config).await;
        let _ = tx
            .send(WatchsetRefreshResult {
                checked_at: Utc::now(),
                result,
            })
            .await;
    });
}

pub(super) async fn fetch_watchset_with_timeout(
    gamma: &GammaClient,
    config: &WatchsetConfig,
) -> Result<Vec<MonitoredMarket>> {
    time::timeout(
        Duration::from_secs(WATCHSET_REFRESH_TIMEOUT_SECONDS),
        fetch_watchset(
            gamma,
            &config.assets,
            config.duration,
            config.lookahead_slots,
        ),
    )
    .await
    .context("watchset refresh timed out")?
}

async fn fetch_watchset(
    gamma: &GammaClient,
    assets: &[Asset],
    duration: TimeDelta,
    lookahead_slots: u32,
) -> Result<Vec<MonitoredMarket>> {
    let current_slot = MarketSlot::current(Utc::now(), duration)?;
    let mut requests = Vec::new();
    for &asset in assets {
        for offset in 0..=lookahead_slots {
            requests.push((asset, current_slot.offset(i64::from(offset))?));
        }
    }

    let mut markets = stream::iter(requests)
        .map(|(asset, slot)| {
            let gamma = gamma.clone();
            async move {
                match gamma.fetch_slot_market(asset, &slot).await {
                    Ok(Some(market)) => {
                        debug!(
                            asset = %asset,
                            slug = market.slug,
                            start = %market.slot.start(),
                            end = %market.slot.end(),
                            token_count = market.tokens.len(),
                            "discovered market"
                        );
                        Some(market)
                    }
                    Ok(None) => {
                        let slug = slot.slug(asset).ok();
                        debug!(asset = %asset, slug, "market not yet available");
                        None
                    }
                    Err(error) => {
                        let slug = slot.slug(asset).ok();
                        warn!(asset = %asset, slug, error = %error, "failed to fetch market");
                        None
                    }
                }
            }
        })
        .buffer_unordered(WATCHSET_FETCH_CONCURRENCY)
        .filter_map(future::ready)
        .collect::<Vec<_>>()
        .await;
    markets.sort_by(|left, right| left.slug.cmp(&right.slug));

    Ok(markets)
}

pub(super) fn asset_ids_for_markets(markets: &[MonitoredMarket]) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    let mut asset_ids = markets
        .iter()
        .flat_map(MonitoredMarket::asset_ids)
        .filter(|asset_id| seen.insert(asset_id.clone()))
        .collect::<Vec<_>>();
    asset_ids.sort();
    asset_ids
}
