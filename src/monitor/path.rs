use std::collections::VecDeque;

use chrono::{DateTime, TimeDelta, Utc};
use rust_decimal::{Decimal, prelude::ToPrimitive};

use crate::{
    runtime::{AssetRuntime, RuntimeCell, SideLeading},
    trading::{
        LIVE_ORDER_SIZE_SCALE,
        fees::{LiquidityRole, platform_fee_usdc},
    },
};

use super::{ORDER_NOTIONAL_SCALE, decimal_abs, distance_bps};

const MAX_MARKET_PATH_SECONDS: i64 = 300;
const PATH_LOOKBACK_SECONDS: i64 = 60;
const MAX_PATH_LOOKBACK_DRIFT_SECONDS: i64 = 30;
const LEAD_DECAY_PENALTY_THRESHOLD: f64 = 0.75;
const LEAD_DECAY_EDGE_PENALTY: f64 = 0.005;

#[derive(Clone, Debug, Default)]
pub(crate) struct MarketPricePath {
    samples: VecDeque<PathSample>,
    max_abs_d_bps_so_far: f64,
}

impl MarketPricePath {
    pub(crate) fn push(&mut self, timestamp: DateTime<Utc>, price: Decimal, line_price: Decimal) {
        if self
            .samples
            .back()
            .is_some_and(|sample| sample.timestamp == timestamp && sample.price == price)
        {
            return;
        }

        if let Some(abs_d_bps) = distance_bps(price, line_price)
            .map(decimal_abs)
            .and_then(|value| value.to_f64())
        {
            self.max_abs_d_bps_so_far = self.max_abs_d_bps_so_far.max(abs_d_bps);
        }

        self.samples.push_back(PathSample { timestamp, price });
        let cutoff = timestamp - TimeDelta::seconds(MAX_MARKET_PATH_SECONDS);
        while self
            .samples
            .front()
            .is_some_and(|sample| sample.timestamp < cutoff)
        {
            self.samples.pop_front();
        }
    }

    pub(crate) fn state(
        &self,
        current_time: DateTime<Utc>,
        current_price: Decimal,
        line_price: Decimal,
        side_leading: SideLeading,
        current_abs_d_bps: f64,
    ) -> Option<PathState> {
        let price_60s_ago =
            self.price_near(current_time - TimeDelta::seconds(PATH_LOOKBACK_SECONDS))?;
        let previous_price = price_60s_ago.price.to_f64()?;
        let current_price_f64 = current_price.to_f64()?;
        if previous_price <= 0.0 {
            return None;
        }

        let return_last_60s_bps = 10_000.0 * (current_price_f64 / previous_price - 1.0);
        let retracing_60s = match side_leading {
            SideLeading::UpLeading => return_last_60s_bps < 0.0,
            SideLeading::DownLeading => return_last_60s_bps > 0.0,
        };
        let max_abs_d_bps_so_far = self
            .max_abs_d_bps_so_far
            .max(distance_bps(current_price, line_price)?.to_f64()?.abs())
            .max(current_abs_d_bps);
        let lead_decay_ratio = if max_abs_d_bps_so_far > 0.0 {
            current_abs_d_bps / max_abs_d_bps_so_far
        } else {
            0.0
        };

        Some(PathState {
            return_last_60s_bps,
            retracing_60s,
            max_abs_d_bps_so_far,
            lead_decay_ratio,
        })
    }

    fn price_near(&self, target: DateTime<Utc>) -> Option<PathSample> {
        let sample = self
            .samples
            .iter()
            .min_by_key(|sample| (sample.timestamp - target).num_milliseconds().abs())
            .copied()?;
        let drift_ms = (sample.timestamp - target).num_milliseconds().abs();
        if drift_ms > TimeDelta::seconds(MAX_PATH_LOOKBACK_DRIFT_SECONDS).num_milliseconds() {
            return None;
        }

        Some(sample)
    }
}

#[derive(Clone, Copy, Debug)]
struct PathSample {
    timestamp: DateTime<Utc>,
    price: Decimal,
}

#[derive(Clone, Debug)]
pub(crate) struct PathState {
    pub(crate) return_last_60s_bps: f64,
    pub(crate) retracing_60s: bool,
    pub(crate) max_abs_d_bps_so_far: f64,
    pub(crate) lead_decay_ratio: f64,
}

pub(crate) fn edge_penalty_applies(path_state: &PathState) -> bool {
    path_state.lead_decay_ratio < LEAD_DECAY_PENALTY_THRESHOLD
}

pub(crate) fn required_edge_probability(
    runtime: &AssetRuntime,
    path_state: &PathState,
) -> Option<f64> {
    if path_state.max_abs_d_bps_so_far <= 0.0 {
        return None;
    }

    Some(
        runtime.min_edge_probability()
            + if edge_penalty_applies(path_state) {
                LEAD_DECAY_EDGE_PENALTY
            } else {
                0.0
            },
    )
}

#[derive(Clone, Debug, Default)]
pub(crate) struct EdgeSummary {
    pub(crate) best_fee: Option<f64>,
    pub(crate) best_all_in_cost: Option<f64>,
    pub(crate) best_edge: Option<f64>,
    pub(crate) weighted_avg_price: Option<f64>,
    pub(crate) max_acceptable_price: Option<f64>,
    pub(crate) order_price: Option<Decimal>,
    pub(crate) order_size_shares: Option<Decimal>,
    pub(crate) order_notional_usdc: Option<Decimal>,
}

pub(crate) fn summarize_maker_limit(
    cell: &RuntimeCell,
    limit_price: Decimal,
    required_edge: f64,
    target_notional: Decimal,
) -> Option<EdgeSummary> {
    let mut summary = EdgeSummary::default();

    let price = limit_price.normalize();
    let price_f64 = price.to_f64()?;
    let fee = platform_fee_usdc(1.0, price_f64, 0.0, LiquidityRole::Maker)?;
    let all_in_cost = price_f64;
    let edge = cell.p_win_lower - all_in_cost;
    summary.best_fee = Some(fee);
    summary.best_all_in_cost = Some(all_in_cost);
    summary.best_edge = Some(edge);

    if edge < required_edge {
        return Some(summary);
    }

    let size_shares = (target_notional / price)
        .trunc_with_scale(LIVE_ORDER_SIZE_SCALE)
        .normalize();
    if size_shares <= Decimal::ZERO {
        return Some(summary);
    }
    let notional = (size_shares * price)
        .trunc_with_scale(ORDER_NOTIONAL_SCALE)
        .normalize();
    summary.weighted_avg_price = Some(price_f64);
    summary.max_acceptable_price = Some(price_f64);
    summary.order_price = Some(price);
    summary.order_size_shares = Some(size_shares);
    summary.order_notional_usdc = Some(notional);

    Some(summary)
}
