use std::time::Duration;

use chrono::{DateTime, TimeDelta, Utc};
use rust_decimal::{
    Decimal,
    prelude::{FromPrimitive, ToPrimitive},
};

use crate::{
    config::RuntimeConfig,
    domain::market::Outcome,
    runtime::{AssetRuntime, SideLeading},
    trading::LiveOrderResponse,
};

use super::path::{PathState, required_edge_probability};

pub(super) const RETRYABLE_NO_FILL_COOLDOWN_SECONDS: i64 = 2;
pub(super) const MOMENTUM_OVERLAY_VOL_LOOKBACK_MIN: u32 = 30;
pub(super) const MOMENTUM_OVERLAY_THRESHOLD_VOL_UNITS: f64 = 2.0;
pub(super) const ORDER_NOTIONAL_SCALE: u32 = 6;

// Monitor-only final-window experiment; the runtime bundle still has no <60s cells.
const EXPERIMENTAL_MIN_REMAINING_SEC_TO_TRADE: i64 = 30;
pub(super) const EXPERIMENTAL_FINAL_WINDOW_MIN_ABS_D_BPS: f64 = 10.0;
pub(super) const EXPERIMENTAL_FINAL_WINDOW_EXTRA_EDGE_PROBABILITY: f64 = 0.01;
const EXPERIMENTAL_FINAL_WINDOW_MAX_ORDER_USDC: f64 = 10.0;

pub(super) fn is_retryable_no_fill_response(response: &LiveOrderResponse) -> bool {
    !response.success
        && response
            .error_msg
            .as_deref()
            .is_some_and(is_retryable_no_fill_error)
}

pub(super) fn is_retryable_no_fill_error(error: &str) -> bool {
    let normalized = error.to_ascii_lowercase();
    (normalized.contains("invalid_post_only_order")
        && !normalized.contains("invalid_post_only_order_type"))
        || normalized.contains("invalid post-only order")
        || normalized.contains("order crosses book")
        || (normalized.contains("post-only") && normalized.contains("would cross"))
}

pub(super) fn retryable_no_fill_key(condition_id: &str, token_id: &str) -> String {
    format!("{condition_id}:{token_id}")
}

pub(super) fn distance_bps(price: Decimal, line: Decimal) -> Option<Decimal> {
    if line.is_zero() {
        return None;
    }

    Some(((price - line) / line) * Decimal::from(10_000))
}

pub(super) fn decimal_abs(value: Decimal) -> Decimal {
    if value < Decimal::ZERO { -value } else { value }
}

pub(super) fn side_for_distance(value: Decimal) -> Option<SideLeading> {
    if value > Decimal::ZERO {
        Some(SideLeading::UpLeading)
    } else if value < Decimal::ZERO {
        Some(SideLeading::DownLeading)
    } else {
        None
    }
}

pub(super) fn momentum_overlay_side_for_value(value: f64) -> Option<SideLeading> {
    if !value.is_finite() {
        return None;
    }

    if value >= MOMENTUM_OVERLAY_THRESHOLD_VOL_UNITS {
        Some(SideLeading::UpLeading)
    } else if value <= -MOMENTUM_OVERLAY_THRESHOLD_VOL_UNITS {
        Some(SideLeading::DownLeading)
    } else {
        None
    }
}

pub(super) fn outcome_for_side(side: SideLeading) -> Outcome {
    match side {
        SideLeading::UpLeading => Outcome::Up,
        SideLeading::DownLeading => Outcome::Down,
    }
}

pub(super) fn age_ms(now: DateTime<Utc>, timestamp: DateTime<Utc>) -> i64 {
    (now - timestamp).num_milliseconds().max(0)
}

pub(super) fn duration_ms(duration: Duration) -> i64 {
    duration.as_millis().try_into().unwrap_or(i64::MAX)
}

pub(super) fn monitor_min_remaining_sec_to_trade(runtime: &AssetRuntime) -> i64 {
    runtime
        .min_remaining_sec_to_trade()
        .min(EXPERIMENTAL_MIN_REMAINING_SEC_TO_TRADE)
}

pub(super) fn experimental_final_window_applies(
    runtime: &AssetRuntime,
    remaining_sec: i64,
) -> bool {
    remaining_sec >= EXPERIMENTAL_MIN_REMAINING_SEC_TO_TRADE
        && remaining_sec < runtime.min_remaining_sec_to_trade()
}

pub(super) fn monitor_remaining_bucket(runtime: &AssetRuntime, remaining_sec: i64) -> Option<u32> {
    if experimental_final_window_applies(runtime, remaining_sec) {
        return runtime.remaining_bucket(runtime.min_remaining_sec_to_trade());
    }

    runtime.remaining_bucket(remaining_sec)
}

pub(super) fn adjusted_required_edge_probability(
    runtime: &AssetRuntime,
    path_state: &PathState,
    final_window_experimental: bool,
) -> Option<f64> {
    required_edge_probability(runtime, path_state).map(|edge| {
        edge + if final_window_experimental {
            EXPERIMENTAL_FINAL_WINDOW_EXTRA_EDGE_PROBABILITY
        } else {
            0.0
        }
    })
}

pub(super) fn effective_max_order_usdc(
    config: &RuntimeConfig,
    final_window_experimental: bool,
) -> f64 {
    if final_window_experimental {
        config
            .max_order_usdc
            .min(EXPERIMENTAL_FINAL_WINDOW_MAX_ORDER_USDC)
    } else {
        config.max_order_usdc
    }
}

pub(super) fn target_order_notional_usdc(
    runtime: &AssetRuntime,
    config: &RuntimeConfig,
    final_window_experimental: bool,
) -> Option<Decimal> {
    let upper_bound = runtime
        .max_position_usdc()
        .min(effective_max_order_usdc(config, final_window_experimental));
    if upper_bound < config.min_order_usdc {
        return None;
    }

    let target = Decimal::from_f64(upper_bound)?
        .trunc_with_scale(ORDER_NOTIONAL_SCALE)
        .normalize();
    if target <= Decimal::ZERO || target.to_f64()? < config.min_order_usdc {
        return None;
    }

    Some(target)
}

pub(super) fn maker_order_expires_at(slot_end: DateTime<Utc>) -> DateTime<Utc> {
    slot_end + TimeDelta::seconds(60)
}

pub(super) fn maker_order_effective_until(expires_at: DateTime<Utc>) -> DateTime<Utc> {
    expires_at - TimeDelta::seconds(60)
}
