use std::{future, sync::Arc, time::Duration};

use anyhow::{Context, Result, bail};
use tokio::{sync::mpsc, task::JoinHandle, time};
use tracing::{info, warn};

use crate::{
    cli::MonitorArgs,
    config::RuntimeConfig,
    domain::{
        asset::{Asset, format_assets, normalize_assets},
        time::duration_from_seconds,
    },
    exchange_candles::{Candle, LiveCandleFeedConfig, run_live_candle_feed},
    polymarket::{
        data::DataApiClient,
        gamma::GammaClient,
        market_ws::MarketWsEvent,
        rtds::{PriceTick, run_price_feed},
    },
    runtime::{AssetRuntime, RuntimeBundle},
    telegram::TelegramClient,
    trade_analysis,
    trading::{LiveFill, LiveTradeExecutor},
};

mod decision;
mod execution;
mod formatting;
mod live_exposure_reconcile;
mod live_tracking;
mod logic;
mod path;
mod settlement;
mod settlement_fetch;
mod skip;
mod state;
mod telegram_outbox;
mod trades;
mod watchset;

const WATCHSET_REFRESH_INTERVAL_SECONDS: u64 = 10;
const LIVE_EXPOSURE_RECONCILE_INTERVAL_MS: u64 = 5_000;
const LIVE_EXPOSURE_CACHE_MAX_AGE_MS: i64 = 12_000;

use formatting::{
    clean_failure_reason, format_percent, format_signed_usdc, format_whole_number,
    live_entry_filled_text, live_entry_posted_text, live_entry_rejected_text,
    live_startup_error_text, outcome_label,
};
#[cfg(test)]
use formatting::{format_market_price, format_usdc};
use live_exposure_reconcile::{LiveExposureReconcileResult, maybe_spawn_live_exposure_reconcile};
use logic::{
    EXPERIMENTAL_FINAL_WINDOW_EXTRA_EDGE_PROBABILITY, EXPERIMENTAL_FINAL_WINDOW_MIN_ABS_D_BPS,
    MOMENTUM_OVERLAY_THRESHOLD_VOL_UNITS, MOMENTUM_OVERLAY_VOL_LOOKBACK_MIN, ORDER_NOTIONAL_SCALE,
    RETRYABLE_NO_FILL_COOLDOWN_SECONDS, adjusted_required_edge_probability, age_ms, decimal_abs,
    distance_bps, duration_ms, effective_max_order_usdc, experimental_final_window_applies,
    is_retryable_no_fill_error, is_retryable_no_fill_response, maker_order_effective_until,
    maker_order_expires_at, momentum_overlay_side_for_value, monitor_min_remaining_sec_to_trade,
    monitor_remaining_bucket, outcome_for_side, retryable_no_fill_key, side_for_distance,
    target_order_notional_usdc,
};
#[cfg(test)]
use path::{MarketPricePath, summarize_maker_limit};
#[cfg(test)]
use path::{PathState, required_edge_probability};
#[cfg(test)]
use settlement::slot_start_from_market_slug;
#[cfg(test)]
use settlement::{
    ClosedPositionPnlRow, closed_position_slot_start, live_settlement_candidate_slots,
    live_settlement_lookback_slots,
};
use settlement::{
    closed_position_outcome_label, closed_position_ticker, closed_position_totals,
    live_settlement_summary_text,
};
#[cfg(test)]
use settlement_fetch::{
    LIVE_SETTLEMENT_CHECK_INTERVAL_SECONDS, telegram_settlement_interval_duration,
};
use settlement_fetch::{
    closed_position_row_from_api_position, closed_rows_for_slot, maybe_spawn_live_settlement_fetch,
    telegram_settlement_interval,
};
#[cfg(test)]
use state::SlotLine;
use state::{LiveSettlementFetchResult, MonitorState};
use telegram_outbox::TelegramOutbox;
use trades::{
    EventCounts, PreparedTrade, TokenContext, TrackedEntry, TradeMode, closeout_estimated_pnl,
    closeout_won, pre_submit_matches_initial, trade_entry_record_json, trade_record_path,
    write_json_record,
};
#[cfg(test)]
use watchset::asset_ids_for_markets;
use watchset::{
    WatchsetConfig, WatchsetRefreshResult, apply_watchset_markets, fetch_watchset_with_timeout,
    maybe_spawn_watchset_refresh, refresh_live_user_fill_feed,
};

pub async fn run(args: MonitorArgs, config: RuntimeConfig) -> Result<()> {
    let duration = duration_from_seconds(args.slot_seconds)?;
    if duration.num_seconds() % 60 != 0 {
        bail!("slot_seconds must be divisible by 60 for Polymarket crypto up/down slugs");
    }

    let gamma = GammaClient::new(config.gamma_base_url.clone());
    let data_api = DataApiClient::new(&config.data_api_base_url)?;
    let assets = normalize_assets(args.assets.clone());
    let runtime_bundle = RuntimeBundle::load(&args.runtime_bundle_dir).with_context(|| {
        format!(
            "load runtime bundle from {}",
            args.runtime_bundle_dir.display()
        )
    })?;
    let runtime_vol_lookback_min = max_vol_lookback_min(&runtime_bundle, &assets);
    let candle_lookback_min = if runtime_vol_lookback_min > 0 {
        runtime_vol_lookback_min.max(MOMENTUM_OVERLAY_VOL_LOOKBACK_MIN)
    } else {
        0
    };
    let telegram = TelegramClient::from_config(&config);
    let telegram_outbox = TelegramOutbox::new(telegram.clone());
    let settlement_user = if telegram.is_configured() && !config.telegram_pnl_interval.is_zero() {
        match trade_analysis::resolve_config_user_address(&config) {
            Ok(address) => Some(address),
            Err(error) => {
                warn!(
                    error = %error,
                    "Telegram settlement summaries disabled because Polymarket wallet address is unavailable"
                );
                None
            }
        }
    } else {
        None
    };
    let live_executor = if config.live_trading {
        match LiveTradeExecutor::from_config(&config, telegram.clone()).await {
            Ok(executor) => Some(executor),
            Err(error) => {
                let error_chain = format!("{error:#}");
                warn!(
                    event = "live_trading_startup_error",
                    error = %error_chain,
                    "live trading startup failed"
                );
                if let Err(telegram_error) = telegram
                    .send_message(&live_startup_error_text(&error_chain))
                    .await
                {
                    warn!(
                        error = %telegram_error,
                        "failed to send live startup error Telegram message"
                    );
                }
                return Err(error.context("initialize live trading executor"));
            }
        }
        .map(Arc::new)
    } else {
        None
    };

    let watchset_config = WatchsetConfig {
        ws_endpoint: config.clob_market_ws_url.clone(),
        assets: assets.clone(),
        duration,
        lookahead_slots: args.lookahead_slots,
    };
    let mut state = MonitorState::new(i64::from(candle_lookback_min) + 5);
    let (price_tx, mut price_rx) = mpsc::channel::<PriceTick>(1024);
    let (candle_tx, mut candle_rx) = mpsc::channel::<Candle>(1024);
    let (market_tx, mut market_rx) = mpsc::channel::<MarketWsEvent>(4096);
    let (live_fill_tx, mut live_fill_rx) = mpsc::channel::<LiveFill>(1024);

    let price_handles = assets
        .iter()
        .map(|asset| {
            tokio::spawn(run_price_feed(
                config.rtds_ws_url.clone(),
                *asset,
                args.price_feed,
                price_tx.clone(),
            ))
        })
        .collect::<Vec<_>>();
    let candle_handle = if candle_lookback_min > 0 {
        Some(tokio::spawn(run_live_candle_feed(
            LiveCandleFeedConfig {
                coinbase_api_base_url: config.coinbase_api_base_url.clone(),
                binance_api_base_url: config.binance_api_base_url.clone(),
                binance_market_ws_url: config.binance_market_ws_url.clone(),
                rest_sync_interval: config.candle_rest_sync_interval,
            },
            assets.clone(),
            candle_lookback_min,
            candle_tx.clone(),
        )))
    } else {
        None
    };
    drop(candle_tx);

    let mut market_handle: Option<JoinHandle<()>> = None;
    let mut user_fill_handle: Option<JoinHandle<()>> = None;
    let mut subscribed_asset_ids = Vec::<String>::new();
    let mut subscribed_user_condition_ids = Vec::<String>::new();
    let mut refresh_interval =
        time::interval(Duration::from_secs(WATCHSET_REFRESH_INTERVAL_SECONDS));
    let mut status_interval = time::interval(Duration::from_secs(15));
    let mut evaluation_interval = time::interval(config.evaluation_interval);
    let (watchset_tx, mut watchset_rx) = mpsc::channel::<WatchsetRefreshResult>(2);
    let mut watchset_refresh_in_flight = false;
    let (live_exposure_tx, mut live_exposure_rx) = mpsc::channel::<LiveExposureReconcileResult>(8);
    let mut live_exposure_reconcile_interval = if live_executor.is_some() {
        Some(time::interval(Duration::from_millis(
            LIVE_EXPOSURE_RECONCILE_INTERVAL_MS,
        )))
    } else {
        None
    };
    let mut live_exposure_reconcile_in_flight = false;
    let mut settlement_interval = if settlement_user.is_some() {
        telegram_settlement_interval(&telegram, config.telegram_pnl_interval)
    } else {
        None
    };
    let (live_settlement_tx, mut live_settlement_rx) =
        mpsc::channel::<LiveSettlementFetchResult>(2);
    let mut live_settlement_fetch_in_flight = false;
    refresh_interval.tick().await;
    status_interval.tick().await;
    evaluation_interval.tick().await;
    if let Some(interval) = live_exposure_reconcile_interval.as_mut() {
        interval.tick().await;
    }
    if let Some(interval) = settlement_interval.as_mut() {
        interval.tick().await;
    }
    let deadline = args
        .max_runtime_seconds
        .map(|seconds| time::Instant::now() + Duration::from_secs(seconds));

    let initial_markets = fetch_watchset_with_timeout(&gamma, &watchset_config).await?;
    apply_watchset_markets(
        initial_markets,
        &watchset_config.ws_endpoint,
        &mut state,
        &mut subscribed_asset_ids,
        &mut market_handle,
        market_tx.clone(),
    );
    refresh_live_user_fill_feed(
        live_executor.as_ref(),
        &watchset_config.ws_endpoint,
        &state,
        &mut subscribed_user_condition_ids,
        &mut user_fill_handle,
        live_fill_tx.clone(),
    )
    .await?;

    maybe_spawn_live_exposure_reconcile(
        live_executor.as_ref(),
        &state,
        &live_exposure_tx,
        &mut live_exposure_reconcile_in_flight,
    );

    info!(
        assets = format_assets(&assets),
        tradable_assets = format_assets(&config.tradable_assets),
        runtime_assets = format_assets(&runtime_bundle.assets()),
        runtime_bundle_dir = %args.runtime_bundle_dir.display(),
        runtime_manifest_version = runtime_bundle.manifest_version(),
        live_trading = config.live_trading,
        telegram_configured = telegram.is_configured(),
        slot_seconds = args.slot_seconds,
        price_feed = %args.price_feed,
        evaluation_interval_ms = duration_ms(config.evaluation_interval),
        candle_lookback_min,
        runtime_vol_lookback_min,
        momentum_overlay_vol_lookback_min = MOMENTUM_OVERLAY_VOL_LOOKBACK_MIN,
        candle_rest_sync_interval_ms = duration_ms(config.candle_rest_sync_interval),
        log_evaluations = config.log_evaluations,
        "monitor started"
    );
    if telegram.is_configured() && !config.live_trading {
        telegram_outbox.send_message(format!(
            "wiggler started: live_trading={} assets={} tradable={}",
            config.live_trading,
            format_assets(&assets),
            format_assets(&config.tradable_assets)
        ));
    }

    loop {
        tokio::select! {
            _ = sleep_until(deadline), if deadline.is_some() => {
                info!("max runtime reached; stopping monitor");
                break;
            }
            signal = tokio::signal::ctrl_c() => {
                signal.context("listen for ctrl-c")?;
                info!("received ctrl-c; stopping monitor");
                break;
            }
            _ = refresh_interval.tick() => {
                maybe_spawn_watchset_refresh(
                    &gamma,
                    &watchset_config,
                    &watchset_tx,
                    &mut watchset_refresh_in_flight,
                );
                maybe_spawn_live_exposure_reconcile(
                    live_executor.as_ref(),
                    &state,
                    &live_exposure_tx,
                    &mut live_exposure_reconcile_in_flight,
                );
            }
            Some(refresh) = watchset_rx.recv() => {
                watchset_refresh_in_flight = false;
                match refresh.result {
                    Ok(markets) => {
                        apply_watchset_markets(
                            markets,
                            &watchset_config.ws_endpoint,
                            &mut state,
                            &mut subscribed_asset_ids,
                            &mut market_handle,
                            market_tx.clone(),
                        );
                        if let Err(error) = refresh_live_user_fill_feed(
                            live_executor.as_ref(),
                            &watchset_config.ws_endpoint,
                            &state,
                            &mut subscribed_user_condition_ids,
                            &mut user_fill_handle,
                            live_fill_tx.clone(),
                        ).await {
                            warn!(error = %error, "user fill websocket refresh failed");
                        }
                        maybe_spawn_live_exposure_reconcile(
                            live_executor.as_ref(),
                            &state,
                            &live_exposure_tx,
                            &mut live_exposure_reconcile_in_flight,
                        );
                    }
                    Err(error) => {
                        warn!(
                            checked_at = %refresh.checked_at,
                            error = %format!("{error:#}"),
                            "watchset refresh failed"
                        );
                    }
                }
            }
            _ = status_interval.tick() => {
                state.log_status();
            }
            _ = optional_interval_tick(&mut live_exposure_reconcile_interval) => {
                maybe_spawn_live_exposure_reconcile(
                    live_executor.as_ref(),
                    &state,
                    &live_exposure_tx,
                    &mut live_exposure_reconcile_in_flight,
                );
            }
            Some(reconcile) = live_exposure_rx.recv() => {
                live_exposure_reconcile_in_flight = false;
                for fill in state.apply_live_exposure_reconcile(reconcile) {
                    state.apply_live_fill(fill, &telegram_outbox);
                }
            }
            Some(fill) = live_fill_rx.recv() => {
                state.apply_live_fill(fill, &telegram_outbox);
            }
            _ = optional_interval_tick(&mut settlement_interval) => {
                maybe_spawn_live_settlement_fetch(
                    &data_api,
                    settlement_user
                        .as_ref()
                        .cloned()
                        .expect("settlement interval requires user address"),
                    &assets,
                    duration,
                    config.telegram_pnl_interval,
                    &state,
                    &live_settlement_tx,
                    &mut live_settlement_fetch_in_flight,
                );
            }
            Some(settlement) = live_settlement_rx.recv() => {
                live_settlement_fetch_in_flight = false;
                state.apply_live_settlement_fetch(settlement, &telegram_outbox);
            }
            _ = evaluation_interval.tick() => {
                state.evaluate_and_maybe_execute(
                    &runtime_bundle,
                    &config,
                    live_executor.as_deref(),
                    &telegram_outbox,
                ).await;
            }
            Some(tick) = price_rx.recv() => {
                state.apply_price_tick(tick);
            }
            Some(candle) = candle_rx.recv() => {
                state.apply_candle(candle);
            }
            Some(event) = market_rx.recv() => {
                state.apply_market_event(event);
            }
        }
    }

    for handle in price_handles {
        handle.abort();
    }
    if let Some(handle) = candle_handle {
        handle.abort();
    }
    if let Some(handle) = market_handle {
        handle.abort();
    }
    if let Some(handle) = user_fill_handle {
        handle.abort();
    }

    Ok(())
}

fn max_vol_lookback_min(runtime_bundle: &RuntimeBundle, assets: &[Asset]) -> u32 {
    assets
        .iter()
        .filter_map(|asset| runtime_bundle.config_for(*asset))
        .map(AssetRuntime::vol_lookback_min)
        .max()
        .unwrap_or_default()
}

async fn sleep_until(deadline: Option<time::Instant>) {
    if let Some(deadline) = deadline {
        time::sleep_until(deadline).await;
    } else {
        future::pending::<()>().await;
    }
}

async fn optional_interval_tick(interval: &mut Option<time::Interval>) {
    if let Some(interval) = interval {
        interval.tick().await;
    } else {
        future::pending::<()>().await;
    }
}

#[cfg(test)]
mod tests;
