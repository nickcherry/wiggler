use std::{collections::HashSet, time::Duration};

use chrono::{TimeDelta, TimeZone, Utc};
use rust_decimal::Decimal;
use rust_decimal::prelude::FromPrimitive;
use serde_json::json;

use crate::{
    config::{PolymarketSignatureType, RuntimeConfig},
    domain::{
        asset::Asset,
        market::{MonitoredMarket, Outcome, OutcomeToken},
        orderbook::TokenBook,
        time::MarketSlot,
    },
    polymarket::rtds::{PriceFeedSource, PriceTick},
    runtime::{RuntimeBundle, SideLeading, VolBin},
    telegram::TelegramClient,
    trade_analysis::ApiClosedPositionPnlRow,
    trading::{LiveFill, LiveFillSource, executor::MarketExposureSnapshot},
};

use super::{
    ClosedPositionPnlRow, LIVE_SETTLEMENT_CHECK_INTERVAL_SECONDS, LiveExposureReconcileResult,
    MOMENTUM_OVERLAY_THRESHOLD_VOL_UNITS, MOMENTUM_OVERLAY_VOL_LOOKBACK_MIN, MarketPricePath,
    MonitorState, PathState, PreparedTrade, SlotLine, TelegramOutbox, TrackedEntry,
    adjusted_required_edge_probability, asset_ids_for_markets, clean_failure_reason,
    closed_position_row_from_api_position, closed_position_slot_start, closed_position_totals,
    distance_bps, effective_max_order_usdc, experimental_final_window_applies, format_market_price,
    format_signed_usdc, format_usdc, is_retryable_no_fill_error, live_entry_filled_text,
    live_entry_posted_text, live_entry_rejected_text, live_settlement_candidate_slots,
    live_settlement_lookback_slots, live_settlement_summary_text, momentum_overlay_side_for_value,
    monitor_remaining_bucket, pre_submit_matches_initial, required_edge_probability,
    slot_start_from_market_slug, summarize_maker_limit, target_order_notional_usdc,
    telegram_settlement_interval_duration,
};

#[test]
fn asset_ids_are_sorted_and_deduped() {
    let market = market_with_tokens(vec!["2", "1", "2"]);
    assert_eq!(asset_ids_for_markets(&[market]), vec!["1", "2"]);
}

#[test]
fn live_exposure_cache_fails_closed_until_reconciled() {
    let now = Utc.with_ymd_and_hms(2026, 5, 2, 12, 0, 0).unwrap();
    let mut state = MonitorState::default();
    let mut market = market_with_tokens(vec![]);
    market.condition_id = "0xabc".to_string();
    state.replace_markets(vec![market]);

    assert_eq!(
        state.live_exposure_skip_reason("0xabc", now),
        Some("live_exposure_cache_stale")
    );

    state.apply_live_exposure_reconcile(LiveExposureReconcileResult {
        condition_ids: vec!["0xabc".to_string()],
        checked_at: now,
        result: Ok(MarketExposureSnapshot::default()),
    });
    assert_eq!(state.live_exposure_skip_reason("0xabc", now), None);
    assert_eq!(
        state.live_exposure_skip_reason("0xabc", now + TimeDelta::seconds(3)),
        None
    );
    assert_eq!(
        state.live_exposure_skip_reason("0xabc", now + TimeDelta::seconds(13)),
        Some("live_exposure_cache_stale")
    );
}

#[test]
fn live_exposure_cache_blocks_remote_exposure() {
    let now = Utc.with_ymd_and_hms(2026, 5, 2, 12, 0, 0).unwrap();
    let mut snapshot = MarketExposureSnapshot::default();
    snapshot.open_order_markets.insert("0xabc".to_string());

    let mut state = MonitorState::default();
    let mut market = market_with_tokens(vec![]);
    market.condition_id = "0xabc".to_string();
    state.replace_markets(vec![market]);
    state.apply_live_exposure_reconcile(LiveExposureReconcileResult {
        condition_ids: vec!["0xabc".to_string()],
        checked_at: now,
        result: Ok(snapshot),
    });

    assert_eq!(
        state.live_exposure_skip_reason("0xabc", now),
        Some("remote_market_exposure")
    );
}

#[test]
fn captures_line_only_when_price_tick_crosses_slot_start() {
    let start = Utc.with_ymd_and_hms(2026, 4, 30, 15, 50, 0).unwrap();
    let market = MonitoredMarket {
        asset: Asset::Btc,
        event_id: "event".to_string(),
        market_id: "market".to_string(),
        slug: "btc-updown-5m-1777564200".to_string(),
        title: "Bitcoin Up or Down".to_string(),
        condition_id: "0xabc".to_string(),
        slot: MarketSlot::from_start(start, TimeDelta::minutes(5)).unwrap(),
        tokens: vec![],
        resolution_source: None,
    };

    let mut state = MonitorState::default();
    state.replace_markets(vec![market]);
    state.apply_price_tick(price_tick(
        Asset::Btc,
        start - TimeDelta::milliseconds(50),
        "67000",
    ));
    state.apply_price_tick(price_tick(
        Asset::Btc,
        start + TimeDelta::milliseconds(200),
        "67001",
    ));

    let line = state.slot_lines.get("btc-updown-5m-1777564200").unwrap();
    assert_eq!(line.price, Decimal::new(67_001, 0));
}

#[test]
fn line_capture_is_scoped_to_tick_asset() {
    let start = Utc.with_ymd_and_hms(2026, 4, 30, 15, 50, 0).unwrap();
    let eth_market = MonitoredMarket {
        asset: Asset::Eth,
        event_id: "event".to_string(),
        market_id: "market".to_string(),
        slug: "eth-updown-5m-1777564200".to_string(),
        title: "Ethereum Up or Down".to_string(),
        condition_id: "0xabc".to_string(),
        slot: MarketSlot::from_start(start, TimeDelta::minutes(5)).unwrap(),
        tokens: vec![],
        resolution_source: None,
    };

    let mut state = MonitorState::default();
    state.replace_markets(vec![eth_market]);
    state.apply_price_tick(price_tick(
        Asset::Btc,
        start - TimeDelta::milliseconds(50),
        "67000",
    ));
    state.apply_price_tick(price_tick(
        Asset::Btc,
        start + TimeDelta::milliseconds(200),
        "67001",
    ));

    assert!(!state.slot_lines.contains_key("eth-updown-5m-1777564200"));
}

#[test]
fn computes_distance_from_line_in_bps() {
    assert_eq!(
        distance_bps(Decimal::new(10_050, 2), Decimal::new(10_000, 2)).unwrap(),
        Decimal::new(50, 0)
    );
}

#[test]
fn maker_limit_uses_p_win_lower_without_taker_fee() {
    let bundle = RuntimeBundle::load(
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("runtime/wiggler-prod-v1"),
    )
    .unwrap();
    let runtime = bundle.config_for(Asset::Btc).unwrap();
    let cell = runtime
        .find_cell(60, VolBin::Low, SideLeading::UpLeading, 2.5)
        .unwrap();

    let summary = summarize_maker_limit(
        cell,
        Decimal::new(80, 2),
        runtime.min_edge_probability(),
        Decimal::new(25, 0),
    )
    .unwrap();

    assert_eq!(summary.best_fee, Some(0.0));
    assert!((summary.best_all_in_cost.unwrap() - 0.80).abs() < 0.000001);
    assert!(summary.best_edge.unwrap() > runtime.min_edge_probability());
    assert_eq!(summary.weighted_avg_price, Some(0.80));
    assert_eq!(summary.max_acceptable_price, Some(0.80));
    assert_eq!(summary.order_price, Some(Decimal::new(80, 2)));
    assert_eq!(summary.order_size_shares, Some(Decimal::new(3125, 2)));
    assert_eq!(summary.order_notional_usdc, Some(Decimal::new(25, 0)));
}

#[test]
fn maker_limit_rejects_price_that_only_raw_p_win_would_accept() {
    let (runtime, cell) = btc_runtime_and_cell();
    assert!(cell.p_win > cell.p_win_lower);

    let summary = summarize_maker_limit(
        cell,
        Decimal::from_f64(cell.p_win - runtime.min_edge_probability())
            .unwrap()
            .trunc_with_scale(4),
        runtime.min_edge_probability(),
        Decimal::new(25, 0),
    )
    .unwrap();

    assert!(cell.p_win - summary.best_all_in_cost.unwrap() >= runtime.min_edge_probability());
    assert!(summary.best_edge.unwrap() < runtime.min_edge_probability());
    assert_eq!(summary.order_price, None);
    assert_eq!(summary.order_size_shares, None);
}

#[test]
fn maker_limit_sizes_from_notional_cap() {
    let (runtime, cell) = btc_runtime_and_cell();
    let summary = summarize_maker_limit(
        cell,
        Decimal::new(80, 2),
        runtime.min_edge_probability(),
        Decimal::new(10, 0),
    )
    .unwrap();

    assert_eq!(summary.order_size_shares, Some(Decimal::new(125, 1)));
    assert_eq!(summary.order_notional_usdc, Some(Decimal::new(10, 0)));
    assert_eq!(summary.max_acceptable_price, Some(0.80));
}

#[test]
fn maker_limit_truncates_size_to_polymarket_lot_precision() {
    let (runtime, cell) = btc_runtime_and_cell();
    let summary = summarize_maker_limit(
        cell,
        Decimal::new(36, 2),
        runtime.min_edge_probability(),
        Decimal::new(50, 0),
    )
    .unwrap();

    assert_eq!(summary.order_size_shares, Some(Decimal::new(13888, 2)));
    assert_eq!(summary.order_notional_usdc, Some(Decimal::new(499968, 4)));
}

#[test]
fn path_rule_skips_up_leader_retracing_over_last_60s() {
    let state = path_state("101", "100.5", SideLeading::UpLeading);
    assert!(state.return_last_60s_bps < 0.0);
    assert!(state.retracing_60s);
}

#[test]
fn path_rule_skips_down_leader_retracing_over_last_60s() {
    let state = path_state("99", "99.5", SideLeading::DownLeading);
    assert!(state.return_last_60s_bps > 0.0);
    assert!(state.retracing_60s);
}

#[test]
fn path_rule_allows_up_leader_extending_over_last_60s() {
    let state = path_state("100", "101", SideLeading::UpLeading);
    assert!(state.return_last_60s_bps > 0.0);
    assert!(!state.retracing_60s);
}

#[test]
fn path_rule_allows_down_leader_extending_over_last_60s() {
    let state = path_state("100", "99", SideLeading::DownLeading);
    assert!(state.return_last_60s_bps < 0.0);
    assert!(!state.retracing_60s);
}

#[test]
fn lead_decay_penalty_increases_required_edge() {
    let (runtime, _) = btc_runtime_and_cell();
    let decayed = PathState {
        return_last_60s_bps: 1.0,
        retracing_60s: false,
        max_abs_d_bps_so_far: 100.0,
        lead_decay_ratio: 0.74,
    };
    let intact = PathState {
        lead_decay_ratio: 0.75,
        ..decayed.clone()
    };
    let invalid = PathState {
        max_abs_d_bps_so_far: 0.0,
        ..decayed.clone()
    };

    assert!(
        (required_edge_probability(runtime, &decayed).unwrap()
            - (runtime.min_edge_probability() + 0.005))
            .abs()
            < 0.000001
    );
    assert_eq!(
        required_edge_probability(runtime, &intact),
        Some(runtime.min_edge_probability())
    );
    assert_eq!(required_edge_probability(runtime, &invalid), None);
}

#[test]
fn skip_reason_rejects_unwhitelisted_and_missing_runtime_assets() {
    let state = MonitorState::default();
    let config = test_config(false);

    assert_eq!(
        state.trade_skip_reason(
            Asset::Bnb,
            None,
            120,
            None, // line
            None, // latest_tick
            None, // price_age_ms
            None, // price_exchange_age_ms
            None, // d_bps
            None, // abs_d_bps
            None, // side_leading
            None, // momentum_overlay_side
            None, // token
            None, // book
            None, // book_age_ms
            None, // vol_bps_per_sqrt_min
            None, // cell
            None, // path_state
            None, // required_edge
            None, // best_bid
            None, // best_ask
            None, // edge_summary
            false,
            false,
            &config,
        ),
        Some("asset_not_in_tradable_whitelist")
    );
    assert_eq!(
        state.trade_skip_reason(
            Asset::Btc,
            None,
            120,
            None, // line
            None, // latest_tick
            None, // price_age_ms
            None, // price_exchange_age_ms
            None, // d_bps
            None, // abs_d_bps
            None, // side_leading
            None, // momentum_overlay_side
            None, // token
            None, // book
            None, // book_age_ms
            None, // vol_bps_per_sqrt_min
            None, // cell
            None, // path_state
            None, // required_edge
            None, // best_bid
            None, // best_ask
            None, // edge_summary
            false,
            false,
            &config,
        ),
        Some("asset_not_in_runtime_bundle")
    );
}

#[test]
fn monitor_remaining_bucket_maps_final_window_to_runtime_minimum() {
    let (runtime, _) = btc_runtime_and_cell();

    assert_eq!(monitor_remaining_bucket(runtime, 29), None);
    assert_eq!(monitor_remaining_bucket(runtime, 30), Some(60));
    assert_eq!(monitor_remaining_bucket(runtime, 45), Some(60));
    assert_eq!(monitor_remaining_bucket(runtime, 59), Some(60));
    assert_eq!(monitor_remaining_bucket(runtime, 60), Some(60));
    assert_eq!(monitor_remaining_bucket(runtime, 61), Some(120));
}

#[test]
fn final_window_tightens_edge_and_order_cap() {
    let (runtime, _) = btc_runtime_and_cell();
    let path = PathState {
        return_last_60s_bps: 1.0,
        retracing_60s: false,
        max_abs_d_bps_so_far: 10.0,
        lead_decay_ratio: 1.0,
    };
    let config = test_config(false);

    assert!(experimental_final_window_applies(runtime, 45));
    assert_eq!(
        adjusted_required_edge_probability(runtime, &path, true),
        Some(runtime.min_edge_probability() + 0.01)
    );
    assert_eq!(effective_max_order_usdc(&config, true), 10.0);
    assert_eq!(
        effective_max_order_usdc(&config, false),
        config.max_order_usdc
    );
}

#[test]
fn target_order_notional_uses_configured_dollar_max() {
    let (runtime, _) = btc_runtime_and_cell();
    let mut config = test_config(false);
    config.min_order_usdc = 25.0;
    config.max_order_usdc = 50.0;

    assert_eq!(
        target_order_notional_usdc(runtime, &config, false),
        Some(Decimal::new(50, 0))
    );
}

#[test]
fn target_order_notional_rejects_effective_max_below_dollar_min() {
    let (runtime, _) = btc_runtime_and_cell();
    let mut config = test_config(false);
    config.min_order_usdc = 25.0;
    config.max_order_usdc = 50.0;

    assert_eq!(target_order_notional_usdc(runtime, &config, true), None);
}

#[test]
fn skip_reason_rejects_remaining_seconds_below_experimental_minimum() {
    let state = MonitorState::default();
    let config = test_config(false);
    let (runtime, _) = btc_runtime_and_cell();

    assert_eq!(
        state.trade_skip_reason(
            Asset::Btc,
            Some(runtime),
            29,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            false,
            false,
            &config,
        ),
        Some("remaining_sec_below_min")
    );
}

#[test]
fn skip_reason_rejects_final_window_when_distance_is_too_small() {
    let state = MonitorState::default();
    let config = test_config(false);
    let (runtime, _) = btc_runtime_and_cell();
    let now = Utc::now();

    assert_eq!(
        state.trade_skip_reason(
            Asset::Btc,
            Some(runtime),
            45,
            Some(&SlotLine {
                price: Decimal::new(100, 0),
                observed_at: now,
            }),
            Some(&price_tick(Asset::Btc, now, "100.05")),
            Some(0),
            Some(0),
            Some(Decimal::new(5, 0)),
            Some(5.0),
            Some(SideLeading::UpLeading),
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            false,
            false,
            &config,
        ),
        Some("final_window_distance_below_min")
    );
}

#[test]
fn momentum_overlay_side_uses_global_threshold() {
    assert_eq!(momentum_overlay_side_for_value(1.999), None);
    assert_eq!(
        momentum_overlay_side_for_value(2.0),
        Some(SideLeading::UpLeading)
    );
    assert_eq!(
        momentum_overlay_side_for_value(-2.0),
        Some(SideLeading::DownLeading)
    );
    assert_eq!(momentum_overlay_side_for_value(f64::NAN), None);
}

#[test]
fn skip_reason_blocks_side_that_conflicts_with_momentum_overlay() {
    let state = MonitorState::default();
    let config = test_config(false);
    let (runtime, _) = btc_runtime_and_cell();
    let now = Utc::now();

    assert_eq!(
        state.trade_skip_reason(
            Asset::Btc,
            Some(runtime),
            120,
            Some(&SlotLine {
                price: Decimal::new(100, 0),
                observed_at: now,
            }),
            Some(&price_tick(Asset::Btc, now, "101")),
            Some(0),
            Some(0),
            Some(Decimal::new(100, 0)),
            Some(100.0),
            Some(SideLeading::UpLeading),
            Some(SideLeading::DownLeading),
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            false,
            false,
            &config,
        ),
        Some("momentum_side_conflict")
    );
}

#[test]
fn skip_reason_applies_retracing_and_invalid_path_gates() {
    let config = test_config(false);
    let state = MonitorState::default();
    let (runtime, cell) = btc_runtime_and_cell();
    let token = OutcomeToken {
        outcome: Outcome::Up,
        asset_id: "up-token".to_string(),
    };
    let book = TokenBook::default();
    let retracing = PathState {
        return_last_60s_bps: -1.0,
        retracing_60s: true,
        max_abs_d_bps_so_far: 10.0,
        lead_decay_ratio: 1.0,
    };
    let invalid = PathState {
        retracing_60s: false,
        max_abs_d_bps_so_far: 0.0,
        ..retracing.clone()
    };

    assert_eq!(
        state.trade_skip_reason(
            Asset::Btc,
            Some(runtime),
            120,
            Some(&SlotLine {
                price: Decimal::new(100, 0),
                observed_at: Utc::now(),
            }),
            Some(&price_tick(Asset::Btc, Utc::now(), "101")),
            Some(0),
            Some(0),
            Some(Decimal::new(100, 0)),
            Some(100.0),
            Some(SideLeading::UpLeading),
            None,
            Some(&token),
            Some(&book),
            Some(0),
            Some(1.0),
            Some(cell),
            Some(&retracing),
            Some(runtime.min_edge_probability()),
            None,
            None,
            None,
            false,
            false,
            &config,
        ),
        Some("retracing_60s")
    );
    assert_eq!(
        state.trade_skip_reason(
            Asset::Btc,
            Some(runtime),
            120,
            Some(&SlotLine {
                price: Decimal::new(100, 0),
                observed_at: Utc::now(),
            }),
            Some(&price_tick(Asset::Btc, Utc::now(), "101")),
            Some(0),
            Some(0),
            Some(Decimal::new(100, 0)),
            Some(100.0),
            Some(SideLeading::UpLeading),
            None,
            Some(&token),
            Some(&book),
            Some(0),
            Some(1.0),
            Some(cell),
            Some(&invalid),
            None,
            None,
            None,
            None,
            false,
            false,
            &config,
        ),
        Some("invalid_path_lead")
    );
}

#[test]
fn skip_reason_rejects_stale_price_and_book() {
    let state = MonitorState::default();
    let config = test_config(false);
    let (runtime, cell) = btc_runtime_and_cell();
    let token = OutcomeToken {
        outcome: Outcome::Up,
        asset_id: "up-token".to_string(),
    };
    let book = TokenBook::default();
    let path_state = PathState {
        return_last_60s_bps: 1.0,
        retracing_60s: false,
        max_abs_d_bps_so_far: 100.0,
        lead_decay_ratio: 1.0,
    };

    assert_eq!(
        state.trade_skip_reason(
            Asset::Btc,
            Some(runtime),
            120,
            Some(&SlotLine {
                price: Decimal::new(100, 0),
                observed_at: Utc::now(),
            }),
            Some(&price_tick(Asset::Btc, Utc::now(), "101")),
            Some(20_001),
            Some(0),
            Some(Decimal::new(100, 0)),
            Some(100.0),
            Some(SideLeading::UpLeading),
            None,
            Some(&token),
            Some(&book),
            Some(0),
            Some(1.0),
            Some(cell),
            Some(&path_state),
            Some(runtime.min_edge_probability()),
            None,
            None,
            None,
            false,
            false,
            &config,
        ),
        Some("stale_current_price")
    );
    assert_eq!(
        state.trade_skip_reason(
            Asset::Btc,
            Some(runtime),
            120,
            Some(&SlotLine {
                price: Decimal::new(100, 0),
                observed_at: Utc::now(),
            }),
            Some(&price_tick(Asset::Btc, Utc::now(), "101")),
            Some(0),
            Some(0),
            Some(Decimal::new(100, 0)),
            Some(100.0),
            Some(SideLeading::UpLeading),
            None,
            Some(&token),
            Some(&book),
            Some(10_001),
            Some(1.0),
            Some(cell),
            Some(&path_state),
            Some(runtime.min_edge_probability()),
            None,
            None,
            None,
            false,
            false,
            &config,
        ),
        Some("stale_order_book")
    );
}

#[test]
fn pre_submit_recompute_rejects_side_flip() {
    let initial = prepared_trade(Outcome::Up, "up-token");
    let same = prepared_trade(Outcome::Up, "up-token");
    let flipped = prepared_trade(Outcome::Down, "down-token");

    assert!(pre_submit_matches_initial(&initial, &same));
    assert!(!pre_submit_matches_initial(&initial, &flipped));
}

#[test]
fn post_only_cross_is_retryable_no_fill() {
    assert!(is_retryable_no_fill_error(
        "Status: error(400 Bad Request) making POST call to /order with {\"error\":\"invalid_post_only_order\"}"
    ));
    assert!(is_retryable_no_fill_error("post-only order would cross"));
    assert!(is_retryable_no_fill_error(
        "Status: error(400 Bad Request) making POST call to /order with {\"error\":\"invalid post-only order: order crosses book\"}"
    ));
    assert!(!is_retryable_no_fill_error(
        "Status: error(401 Unauthorized) making GET call to /data/orders with {\"error\":\"Unauthorized/Invalid api key\"}"
    ));
}

#[test]
fn money_and_market_prices_use_grouping() {
    assert_eq!(format_usdc(8751.006), "$8,751.01");
    assert_eq!(format_signed_usdc(-1744.1871), "-$1,744.19");
    assert_eq!(format_market_price(Asset::Btc, 77972.55), "$77,972.55");
    assert_eq!(format_market_price(Asset::Sol, 184.3668), "$184.3668");
}

#[test]
fn live_fill_message_uses_requested_shape() {
    let mut prepared = prepared_trade(Outcome::Up, "up-token");
    prepared.asset = Asset::Btc;
    prepared.line_price = 77972.55;
    prepared.current_price = 78000.0;
    let fill = LiveFill::new(
        "condition".to_string(),
        "up-token".to_string(),
        "fill".to_string(),
        100.0,
        0.5,
        Utc.with_ymd_and_hms(2026, 5, 2, 12, 0, 0).unwrap(),
        LiveFillSource::UserWebSocket,
    )
    .unwrap();

    assert_eq!(
        live_entry_filled_text(&prepared, &fill),
        "Filled BTC ↑ maker bid for $50.00 (100 shares @ 0.5000)\n\nCurrent price is 0.04% above the price line ($77,972.55)"
    );

    prepared.current_price = 77900.0;
    assert_eq!(
        live_entry_filled_text(&prepared, &fill),
        "Filled BTC ↑ maker bid for $50.00 (100 shares @ 0.5000)\n\nCurrent price is 0.09% below the price line ($77,972.55)"
    );
}

#[test]
fn live_posted_message_identifies_resting_maker_order() {
    let mut prepared = prepared_trade(Outcome::Down, "down-token");
    prepared.asset = Asset::Xrp;
    prepared.line_price = 2.4123;
    prepared.current_price = 2.3999;
    prepared.amount_usdc = 50.0;
    prepared.size_shares = 138.88;
    prepared.order_price = 0.36;
    prepared.expires_at = Utc.with_ymd_and_hms(2026, 5, 2, 5, 5, 0).unwrap();

    assert_eq!(
        live_entry_posted_text(&prepared),
        "Posted XRP ↓ maker bid for $50.00 (138.88 shares @ 0.3600)\nExpires: 2026-05-02 05:04:00 UTC\n\nCurrent price is 0.51% below the price line ($2.412300)"
    );
}

#[tokio::test]
async fn live_fill_updates_tracked_entry_for_closeout_and_dedupes() {
    let prepared = prepared_trade(Outcome::Up, "up-token");
    let mut state = MonitorState::default();
    state.tracked_entries.insert(
        prepared.condition_id.clone(),
        TrackedEntry {
            prepared: prepared.clone(),
            slot_start: prepared.current_exchange_timestamp,
            slot_end: prepared.expires_at,
            record_path: None,
            record: json!({}),
            track_closeout: false,
            closeout_sent: false,
            filled_amount_usdc: None,
            filled_payout_usdc: None,
            filled_trade_ids: HashSet::new(),
            filled_fingerprints: HashSet::new(),
        },
    );
    let telegram = TelegramOutbox::new(TelegramClient::from_config(&test_config(false)));
    let fill = LiveFill::new(
        prepared.condition_id.clone(),
        prepared.token_id.clone(),
        "fill".to_string(),
        100.0,
        0.5,
        prepared.current_exchange_timestamp,
        LiveFillSource::UserWebSocket,
    )
    .unwrap();

    state.apply_live_fill(fill.clone(), &telegram);
    state.apply_live_fill(fill, &telegram);

    let entry = state.tracked_entries.get(&prepared.condition_id).unwrap();
    assert!(entry.track_closeout);
    assert_eq!(entry.filled_amount_usdc, Some(50.0));
    assert_eq!(entry.filled_payout_usdc, Some(100.0));
    assert_eq!(entry.record["state"], json!("filled"));
    assert_eq!(entry.record["fills"].as_array().unwrap().len(), 1);
}

#[test]
fn live_rejection_message_uses_requested_shape_and_reason() {
    assert_eq!(
        live_entry_rejected_text(
            Asset::Eth,
            &Outcome::Down,
            "Status: error(400 Bad Request) making POST call to /order with {\"error\":\"invalid signature\"}"
        ),
        "Rejected entry of ETH ↓: invalid signature"
    );
}

#[test]
fn settlement_summary_uses_api_rows() {
    let window_rows = vec![
        ClosedPositionPnlRow {
            realized_pnl: Some(58.352126999999996),
            slug: Some("btc-updown-5m-1777648800".to_string()),
            event_slug: None,
            title: Some("Bitcoin Up or Down - May 1, 11:20AM-11:25AM ET".to_string()),
            outcome: Some("Up".to_string()),
        },
        ClosedPositionPnlRow {
            realized_pnl: Some(-49.999999),
            slug: Some("eth-updown-5m-1777648800".to_string()),
            event_slug: None,
            title: Some("Ethereum Up or Down - May 1, 11:20AM-11:25AM ET".to_string()),
            outcome: Some("Down".to_string()),
        },
    ];
    let mut all_time_rows = window_rows.clone();
    all_time_rows.push(ClosedPositionPnlRow {
        realized_pnl: Some(100.0),
        slug: Some("sol-updown-5m-1777648500".to_string()),
        event_slug: None,
        title: Some("Solana Up or Down - May 1, 11:15AM-11:20AM ET".to_string()),
        outcome: Some("Up".to_string()),
    });

    assert_eq!(
        live_settlement_summary_text(&window_rows, closed_position_totals(&all_time_rows)),
        "BTC ↑ won +$58.35\nETH ↓ lost -$50.00\n\nTotal wins: 2 (66.7%)\nTotal losses: 1 (33.3%)\n\nTotal PnL: +$108.35"
    );
}

#[test]
fn api_closed_position_rows_map_to_settlement_rows() {
    let row = closed_position_row_from_api_position(ApiClosedPositionPnlRow {
        realized_pnl: -7.25,
        slug: "btc-updown-5m-1777648800".to_string(),
        event_slug: "btc-updown-5m-1777648800".to_string(),
        title: "Bitcoin Up or Down - May 1, 11:20AM-11:25AM ET".to_string(),
        outcome: "Down".to_string(),
    });

    assert_eq!(row.realized_pnl, Some(-7.25));
    assert_eq!(row.slug.as_deref(), Some("btc-updown-5m-1777648800"));
    assert_eq!(row.outcome.as_deref(), Some("Down"));
    assert_eq!(
        closed_position_slot_start(&row),
        Utc.with_ymd_and_hms(2026, 5, 1, 15, 20, 0).single()
    );
}

#[test]
fn closed_position_totals_are_all_time() {
    let rows = vec![
        ClosedPositionPnlRow {
            realized_pnl: Some(58.352126999999996),
            slug: None,
            event_slug: None,
            title: None,
            outcome: None,
        },
        ClosedPositionPnlRow {
            realized_pnl: Some(-50.0),
            slug: None,
            event_slug: None,
            title: None,
            outcome: None,
        },
        ClosedPositionPnlRow {
            realized_pnl: Some(100.0),
            slug: None,
            event_slug: None,
            title: None,
            outcome: None,
        },
    ];

    let totals = closed_position_totals(&rows);
    assert_eq!(totals.wins, 2);
    assert_eq!(totals.losses, 1);
    assert!((totals.total_pnl - 108.352127).abs() < 0.000001);
}

#[test]
fn closed_position_totals_ignore_flat_and_missing_pnl_rows() {
    let rows = vec![
        ClosedPositionPnlRow {
            realized_pnl: Some(0.0),
            slug: None,
            event_slug: None,
            title: None,
            outcome: None,
        },
        ClosedPositionPnlRow {
            realized_pnl: None,
            slug: None,
            event_slug: None,
            title: None,
            outcome: None,
        },
    ];

    let totals = closed_position_totals(&rows);
    assert_eq!(totals.wins, 0);
    assert_eq!(totals.losses, 0);
    assert_eq!(totals.total_pnl, 0.0);
}

#[test]
fn parses_slot_start_from_market_slug() {
    assert_eq!(
        slot_start_from_market_slug("btc-updown-5m-1777648800"),
        Some(Utc.with_ymd_and_hms(2026, 5, 1, 15, 20, 0).unwrap())
    );
}

#[test]
fn telegram_settlement_interval_polls_frequently_and_zero_disables() {
    let mut config = test_config(false);
    config.telegram_bot_token = Some("token".to_string());
    config.telegram_chat_id = Some("chat".to_string());
    config.telegram_pnl_interval = Duration::from_secs(123);
    let telegram = TelegramClient::from_config(&config);

    assert_eq!(
        telegram_settlement_interval_duration(&telegram, config.telegram_pnl_interval),
        Some(Duration::from_secs(LIVE_SETTLEMENT_CHECK_INTERVAL_SECONDS))
    );
    assert_eq!(
        telegram_settlement_interval_duration(&telegram, Duration::ZERO),
        None
    );
}

#[test]
fn settlement_lookback_covers_configured_summary_interval() {
    let duration = TimeDelta::minutes(5);
    let lookback = live_settlement_lookback_slots(duration, Duration::from_secs(15 * 60));
    let slots = live_settlement_candidate_slots(
        Utc.with_ymd_and_hms(2026, 5, 1, 15, 30, 0).unwrap(),
        duration,
        lookback,
    );

    assert!(lookback >= 5);
    assert!(slots.contains(&Utc.with_ymd_and_hms(2026, 5, 1, 15, 10, 0).unwrap()));
}

#[test]
fn clean_failure_reason_parses_error_json_with_spacing() {
    assert_eq!(
        clean_failure_reason(
            "Status: error(400 Bad Request) making POST call to /order with {\"error\": \"invalid signature\"}"
        ),
        "invalid signature"
    );
}

fn market_with_tokens(asset_ids: Vec<&str>) -> MonitoredMarket {
    MonitoredMarket {
        asset: Asset::Btc,
        event_id: "event".to_string(),
        market_id: "market".to_string(),
        slug: "slug".to_string(),
        title: "title".to_string(),
        condition_id: "condition".to_string(),
        slot: MarketSlot::current(Utc::now(), TimeDelta::minutes(5)).unwrap(),
        tokens: asset_ids
            .into_iter()
            .map(|asset_id| OutcomeToken {
                outcome: Outcome::Other(asset_id.to_string()),
                asset_id: asset_id.to_string(),
            })
            .collect(),
        resolution_source: None,
    }
}

fn btc_runtime_and_cell() -> (
    &'static crate::runtime::AssetRuntime,
    &'static crate::runtime::RuntimeCell,
) {
    let bundle = Box::leak(Box::new(
        RuntimeBundle::load(
            std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("runtime/wiggler-prod-v1"),
        )
        .unwrap(),
    ));
    let runtime = bundle.config_for(Asset::Btc).unwrap();
    let cell = runtime
        .find_cell(60, VolBin::Low, SideLeading::UpLeading, 2.5)
        .unwrap();
    (runtime, cell)
}

fn path_state(previous_price: &str, current_price: &str, side: SideLeading) -> PathState {
    let start = Utc.with_ymd_and_hms(2026, 4, 30, 15, 50, 0).unwrap();
    let line = Decimal::new(100, 0);
    let current = current_price.parse::<Decimal>().unwrap();
    let mut path = MarketPricePath::default();
    path.push(start, previous_price.parse().unwrap(), line);
    path.push(start + TimeDelta::seconds(60), current, line);
    let current_abs_d_bps = distance_bps(current, line)
        .unwrap()
        .abs()
        .to_string()
        .parse::<f64>()
        .unwrap();

    path.state(
        start + TimeDelta::seconds(60),
        current,
        line,
        side,
        current_abs_d_bps,
    )
    .unwrap()
}

fn test_config(live_trading: bool) -> RuntimeConfig {
    RuntimeConfig {
        gamma_base_url: "https://gamma-api.polymarket.com".to_string(),
        data_api_base_url: "https://data-api.polymarket.com".to_string(),
        clob_api_url: "https://clob.polymarket.com".to_string(),
        clob_market_ws_url: "wss://ws-subscriptions-clob.polymarket.com/ws/market".to_string(),
        rtds_ws_url: "wss://ws-live-data.polymarket.com".to_string(),
        coinbase_api_base_url: "https://api.coinbase.com".to_string(),
        binance_api_base_url: "https://data-api.binance.vision".to_string(),
        binance_market_ws_url: "wss://stream.binance.com:9443".to_string(),
        live_trading,
        tradable_assets: vec![Asset::Btc, Asset::Eth, Asset::Sol, Asset::Xrp, Asset::Doge],
        min_order_usdc: 1.0,
        max_order_usdc: 25.0,
        evaluation_interval: Duration::from_millis(1_000),
        candle_rest_sync_interval: Duration::from_millis(60_000),
        log_evaluations: false,
        polymarket_private_key: None,
        polymarket_api_key: None,
        polymarket_api_secret: None,
        polymarket_api_passphrase: None,
        polymarket_api_nonce: None,
        polymarket_api_credential_file: std::path::PathBuf::from("tmp/polymarket-api.env"),
        polymarket_signature_type: PolymarketSignatureType::Eoa,
        polymarket_user_address: None,
        polymarket_funder_address: None,
        price_stale_after: Duration::from_millis(20_000),
        orderbook_stale_after: Duration::from_millis(10_000),
        min_abs_d_bps: 0.01,
        trade_record_dir: std::path::PathBuf::from("trade-records"),
        telegram_enabled: true,
        telegram_bot_token: None,
        telegram_chat_id: None,
        telegram_pnl_interval: Duration::from_secs(900),
    }
}

fn prepared_trade(outcome: Outcome, token_id: &str) -> PreparedTrade {
    let now = Utc.with_ymd_and_hms(2026, 4, 30, 15, 52, 0).unwrap();
    PreparedTrade {
        asset: Asset::Btc,
        slug: "slug".to_string(),
        condition_id: "condition".to_string(),
        token_id: token_id.to_string(),
        outcome,
        amount_usdc: 10.0,
        order_price: 0.8,
        size_shares: 12.5,
        order_price_decimal: Decimal::new(80, 2),
        order_size_shares_decimal: Decimal::new(125, 1),
        expires_at: now + TimeDelta::seconds(240),
        line_price: 67_000.0,
        current_price: 67_010.0,
        line_observed_at: now - TimeDelta::seconds(120),
        current_exchange_timestamp: now,
        current_received_at: now,
        remaining_sec: 120,
        final_window_experimental: false,
        order_cap_usdc: 25.0,
        target_order_notional_usdc: 25.0,
        d_bps: Some("1".to_string()),
        p_win: Some(0.91),
        p_win_lower: Some(0.9),
        best_edge: Some(0.05),
        best_bid: Some(0.8),
        best_bid_size: Some(100.0),
        best_ask: Some(0.82),
        best_ask_size: Some(100.0),
        weighted_avg_price: Some(0.8),
        best_fee: Some(0.0),
        best_all_in_cost: Some(0.8),
        expected_fill_price: Some(0.8),
        estimated_payout_usdc: Some(12.5),
        estimated_profit_usdc: Some(2.5),
        remaining_sec_bucket: Some(120),
        vol_bps_per_sqrt_min: Some(1.5),
        momentum_1m_vol_normalized: Some(2.1),
        binance_momentum_1m_vol_normalized: Some(2.0),
        coinbase_momentum_1m_vol_normalized: Some(2.2),
        momentum_source_count: 2,
        momentum_overlay_side: Some(SideLeading::UpLeading.as_str().to_string()),
        momentum_overlay_threshold: MOMENTUM_OVERLAY_THRESHOLD_VOL_UNITS,
        momentum_overlay_vol_lookback_min: MOMENTUM_OVERLAY_VOL_LOOKBACK_MIN,
        vol_bin: Some("low".to_string()),
        matched_remaining_sec_bucket: Some(120),
        matched_abs_d_bps_min: Some(0.0),
        matched_abs_d_bps_max: Some(10.0),
        cell_sample_count: Some(100),
        return_last_60s_bps: Some(1.0),
        retracing_60s: Some(false),
        max_abs_d_bps_so_far: Some(2.0),
        lead_decay_ratio: Some(1.0),
        edge_penalty_applied: false,
        runtime_config_hash: Some("runtime".to_string()),
        source_config_hash: Some("source".to_string()),
        training_input_hash: Some("input".to_string()),
        training_label_source_kind: Some("label".to_string()),
    }
}

fn price_tick(asset: Asset, timestamp: chrono::DateTime<Utc>, value: &str) -> PriceTick {
    PriceTick {
        asset,
        source: PriceFeedSource::Chainlink,
        symbol: asset.chainlink_symbol().to_string(),
        value: value.parse().unwrap(),
        exchange_timestamp: timestamp,
        received_at: timestamp,
    }
}
