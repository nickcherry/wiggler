use rust_decimal::{Decimal, prelude::ToPrimitive};

use crate::{
    config::RuntimeConfig,
    domain::{
        asset::Asset,
        market::OutcomeToken,
        orderbook::{PriceLevel, TokenBook},
    },
    polymarket::rtds::PriceTick,
    runtime::{AssetRuntime, RuntimeCell, SideLeading},
};

use super::path::{EdgeSummary, PathState};
use super::state::{MonitorState, SlotLine};
use super::{
    EXPERIMENTAL_FINAL_WINDOW_MIN_ABS_D_BPS, duration_ms, experimental_final_window_applies,
    monitor_min_remaining_sec_to_trade, target_order_notional_usdc,
};

impl MonitorState {
    #[allow(clippy::too_many_arguments)]
    pub(super) fn trade_skip_reason(
        &self,
        asset: Asset,
        runtime: Option<&AssetRuntime>,
        remaining_sec: i64,
        line: Option<&SlotLine>,
        latest_tick: Option<&PriceTick>,
        price_age_ms: Option<i64>,
        price_exchange_age_ms: Option<i64>,
        d_bps: Option<Decimal>,
        abs_d_bps: Option<f64>,
        side_leading: Option<SideLeading>,
        momentum_overlay_side: Option<SideLeading>,
        token: Option<&OutcomeToken>,
        book: Option<&TokenBook>,
        book_age_ms: Option<i64>,
        vol_bps_per_sqrt_min: Option<f64>,
        cell: Option<&RuntimeCell>,
        path_state: Option<&PathState>,
        required_edge: Option<f64>,
        best_bid: Option<&PriceLevel>,
        best_ask: Option<&PriceLevel>,
        edge_summary: Option<&EdgeSummary>,
        already_positioned: bool,
        market_resolved: bool,
        config: &RuntimeConfig,
    ) -> Option<&'static str> {
        if !config.tradable_assets.contains(&asset) {
            return Some("asset_not_in_tradable_whitelist");
        }
        let Some(runtime) = runtime else {
            return Some("asset_not_in_runtime_bundle");
        };
        if remaining_sec < monitor_min_remaining_sec_to_trade(runtime) {
            return Some("remaining_sec_below_min");
        }
        if remaining_sec > runtime.max_remaining_sec_to_trade() {
            return Some("remaining_sec_above_max");
        }
        let final_window_experimental = experimental_final_window_applies(runtime, remaining_sec);
        if line.is_none() {
            return Some("missing_line_price");
        }
        if latest_tick.is_none() {
            return Some("missing_current_price");
        }
        if price_age_ms.is_some_and(|age| age > duration_ms(config.price_stale_after)) {
            return Some("stale_current_price");
        }
        if price_exchange_age_ms.is_some_and(|age| age > duration_ms(config.price_stale_after)) {
            return Some("stale_current_price_source");
        }
        if d_bps.is_none() {
            return Some("invalid_line_price");
        }
        if side_leading.is_none()
            || abs_d_bps.is_some_and(|abs_d_bps| abs_d_bps < config.min_abs_d_bps)
        {
            return Some("too_close_to_line");
        }
        if final_window_experimental
            && abs_d_bps.is_none_or(|abs_d_bps| abs_d_bps < EXPERIMENTAL_FINAL_WINDOW_MIN_ABS_D_BPS)
        {
            return Some("final_window_distance_below_min");
        }
        if side_leading
            .zip(momentum_overlay_side)
            .is_some_and(|(side_leading, momentum_side)| side_leading != momentum_side)
        {
            return Some("momentum_side_conflict");
        }
        if market_resolved {
            return Some("market_closed_or_resolved");
        }
        if already_positioned {
            return Some("already_positioned");
        }
        if token.is_none() {
            return Some("missing_token_id");
        }
        if book.is_none() {
            return Some("missing_order_book");
        }
        if book_age_ms.is_none() {
            return Some("missing_order_book_timestamp");
        }
        if book_age_ms.is_some_and(|age| age > duration_ms(config.orderbook_stale_after)) {
            return Some("stale_order_book");
        }
        if vol_bps_per_sqrt_min.is_none() {
            return Some("insufficient_price_history");
        }
        if cell.is_none() {
            return Some("no_matching_config_cell");
        }
        if cell.is_some_and(|cell| cell.p_win_lower < config.min_p_win_lower) {
            return Some("p_win_lower_below_min");
        }
        let Some(path_state) = path_state else {
            return Some("insufficient_path_history");
        };
        if path_state.max_abs_d_bps_so_far <= 0.0 || required_edge.is_none() {
            return Some("invalid_path_lead");
        }
        if path_state.retracing_60s {
            return Some("retracing_60s");
        }
        if best_bid.is_none() {
            return Some("order_book_missing_bids");
        }
        if best_ask.is_none() {
            return Some("order_book_missing_asks");
        }
        if best_bid
            .zip(best_ask)
            .is_some_and(|(bid, ask)| bid.price >= ask.price)
        {
            return Some("order_book_crossed_or_locked");
        }
        if target_order_notional_usdc(runtime, config, final_window_experimental).is_none() {
            return Some("order_dollar_range_unavailable");
        }
        let Some(edge_summary) = edge_summary else {
            return Some("missing_maker_order_summary");
        };
        if edge_summary
            .best_edge
            .zip(required_edge)
            .is_none_or(|(edge, required)| edge < required)
        {
            return Some("maker_edge_below_required");
        }
        if edge_summary.max_acceptable_price.is_none() {
            return Some("missing_max_acceptable_price");
        }
        if edge_summary
            .order_notional_usdc
            .and_then(|notional| notional.to_f64())
            .is_none_or(|notional| notional < config.min_order_usdc)
        {
            return Some("order_notional_below_min_after_lot_truncation");
        }

        None
    }
}
