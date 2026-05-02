use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
};

use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use rust_decimal::Decimal;
use serde_json::{Value, json};
use tracing::warn;

use crate::domain::{
    asset::Asset,
    market::{MonitoredMarket, Outcome, OutcomeToken},
};

use super::{maker_order_effective_until, outcome_label};

pub(super) fn pre_submit_matches_initial(
    initial: &PreparedTrade,
    pre_submit: &PreparedTrade,
) -> bool {
    initial.outcome == pre_submit.outcome && initial.token_id == pre_submit.token_id
}

#[derive(Default)]
pub(super) struct EventCounts {
    pub(super) books: u64,
    pub(super) price_changes: u64,
    pub(super) best_bid_ask: u64,
    pub(super) last_trade_price: u64,
    pub(super) tick_size_changes: u64,
    pub(super) new_markets: u64,
    pub(super) market_resolved: u64,
    pub(super) unknown: u64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum TradeMode {
    Live,
    Shadow,
}

impl TradeMode {
    pub(super) fn as_str(self) -> &'static str {
        match self {
            Self::Live => "live",
            Self::Shadow => "shadow",
        }
    }
}

#[derive(Clone, Debug)]
pub(super) struct TrackedEntry {
    pub(super) prepared: PreparedTrade,
    pub(super) slot_start: DateTime<Utc>,
    pub(super) slot_end: DateTime<Utc>,
    pub(super) record_path: Option<PathBuf>,
    pub(super) record: Value,
    pub(super) track_closeout: bool,
    pub(super) closeout_sent: bool,
    pub(super) filled_amount_usdc: Option<f64>,
    pub(super) filled_payout_usdc: Option<f64>,
    pub(super) filled_trade_ids: HashSet<String>,
    pub(super) filled_fingerprints: HashSet<String>,
}

impl TrackedEntry {
    pub(super) fn filled_amount_usdc(&self) -> f64 {
        self.filled_amount_usdc.unwrap_or(self.prepared.amount_usdc)
    }

    pub(super) fn filled_profit_usdc(&self) -> Option<f64> {
        match (self.filled_amount_usdc, self.filled_payout_usdc) {
            (Some(amount), Some(payout)) => Some(payout - amount),
            _ => self.prepared.estimated_profit_usdc,
        }
    }

    pub(super) fn write_record(&self) {
        let Some(record_path) = &self.record_path else {
            return;
        };
        if let Err(error) = write_json_record(record_path, &self.record) {
            warn!(
                error = %error,
                path = %record_path.display(),
                slug = self.prepared.slug,
                "failed to update trade record"
            );
        }
    }
}

pub(super) fn trade_record_path(
    dir: &Path,
    attempted_at: DateTime<Utc>,
    mode: TradeMode,
    prepared: &PreparedTrade,
) -> PathBuf {
    let condition = prepared
        .condition_id
        .trim_start_matches("0x")
        .chars()
        .take(10)
        .collect::<String>();
    let filename = format!(
        "{}-{}-{}-{}-{}.json",
        attempted_at.format("%Y%m%dT%H%M%S%.3fZ"),
        mode.as_str(),
        prepared.asset,
        outcome_label(&prepared.outcome).to_ascii_lowercase(),
        condition
    );
    dir.join(filename)
}

pub(super) fn write_json_record(path: &Path, value: &Value) -> Result<()> {
    let parent = path.parent().context("trade record path has no parent")?;
    fs::create_dir_all(parent)
        .with_context(|| format!("create trade record dir {}", parent.display()))?;
    let bytes = serde_json::to_vec_pretty(value).context("serialize trade record")?;
    let tmp_path = path.with_extension("json.tmp");
    fs::write(&tmp_path, bytes)
        .with_context(|| format!("write trade record temp file {}", tmp_path.display()))?;
    fs::rename(&tmp_path, path)
        .with_context(|| format!("rename trade record file {}", path.display()))?;
    Ok(())
}

pub(super) fn trade_entry_record_json(
    mode: TradeMode,
    market: &MonitoredMarket,
    prepared: &PreparedTrade,
    attempted_at: DateTime<Utc>,
) -> Value {
    json!({
        "schema_version": 1,
        "state": "attempting",
        "mode": mode.as_str(),
        "attempted_at": attempted_at,
        "market": {
            "asset": prepared.asset,
            "event_id": market.event_id.as_str(),
            "market_id": market.market_id.as_str(),
            "slug": market.slug.as_str(),
            "title": market.title.as_str(),
            "condition_id": market.condition_id.as_str(),
            "slot_start": market.slot.start(),
            "slot_end": market.slot.end(),
            "resolution_source": market.resolution_source.as_deref(),
            "tokens": &market.tokens,
        },
        "entry": {
            "outcome": outcome_label(&prepared.outcome),
            "token_id": prepared.token_id.as_str(),
            "order_type": "GTD",
            "post_only": true,
            "amount_usdc": prepared.amount_usdc,
            "size_shares": prepared.size_shares,
            "order_cap_usdc": prepared.order_cap_usdc,
            "target_order_notional_usdc": prepared.target_order_notional_usdc,
            "order_price": prepared.order_price,
            "gtd_expires_at": prepared.expires_at,
            "effective_until": maker_order_effective_until(prepared.expires_at),
            "expected_fill_price": prepared.expected_fill_price,
            "estimated_payout_usdc": prepared.estimated_payout_usdc,
            "estimated_profit_usdc": prepared.estimated_profit_usdc,
        },
        "prices": {
            "line_price": prepared.line_price,
            "line_observed_at": prepared.line_observed_at,
            "current_price": prepared.current_price,
            "current_exchange_timestamp": prepared.current_exchange_timestamp,
            "current_received_at": prepared.current_received_at,
            "d_bps": prepared.d_bps.as_deref(),
            "remaining_sec": prepared.remaining_sec,
            "remaining_sec_bucket": prepared.remaining_sec_bucket,
            "final_window_experimental": prepared.final_window_experimental,
        },
        "edge": {
            "p_win": prepared.p_win,
            "p_win_lower": prepared.p_win_lower,
            "best_edge": prepared.best_edge,
            "best_bid": prepared.best_bid,
            "best_bid_size": prepared.best_bid_size,
            "best_ask": prepared.best_ask,
            "best_ask_size": prepared.best_ask_size,
            "best_fee": prepared.best_fee,
            "best_all_in_cost": prepared.best_all_in_cost,
            "weighted_avg_price": prepared.weighted_avg_price,
        },
        "runtime": {
            "vol_bps_per_sqrt_min": prepared.vol_bps_per_sqrt_min,
            "vol_bin": prepared.vol_bin.as_deref(),
            "matched_remaining_sec_bucket": prepared.matched_remaining_sec_bucket,
            "matched_abs_d_bps_min": prepared.matched_abs_d_bps_min,
            "matched_abs_d_bps_max": prepared.matched_abs_d_bps_max,
            "cell_sample_count": prepared.cell_sample_count,
            "runtime_config_hash": prepared.runtime_config_hash.as_deref(),
            "source_config_hash": prepared.source_config_hash.as_deref(),
            "training_input_hash": prepared.training_input_hash.as_deref(),
            "training_label_source_kind": prepared.training_label_source_kind.as_deref(),
        },
        "momentum": {
            "momentum_1m_vol_normalized": prepared.momentum_1m_vol_normalized,
            "binance_momentum_1m_vol_normalized": prepared.binance_momentum_1m_vol_normalized,
            "coinbase_momentum_1m_vol_normalized": prepared.coinbase_momentum_1m_vol_normalized,
            "source_count": prepared.momentum_source_count,
            "overlay_side": prepared.momentum_overlay_side.as_deref(),
            "overlay_threshold": prepared.momentum_overlay_threshold,
            "vol_lookback_min": prepared.momentum_overlay_vol_lookback_min,
        },
        "path": {
            "return_last_60s_bps": prepared.return_last_60s_bps,
            "retracing_60s": prepared.retracing_60s,
            "max_abs_d_bps_so_far": prepared.max_abs_d_bps_so_far,
            "lead_decay_ratio": prepared.lead_decay_ratio,
            "edge_penalty_applied": prepared.edge_penalty_applied,
        },
    })
}

pub(super) fn closeout_won(outcome: &Outcome, close_price: f64, line_price: f64) -> Option<bool> {
    if (close_price - line_price).abs() <= f64::EPSILON {
        return None;
    }
    match outcome {
        Outcome::Up => Some(close_price > line_price),
        Outcome::Down => Some(close_price < line_price),
        Outcome::Other(_) => None,
    }
}

pub(super) fn closeout_estimated_pnl(
    amount_usdc: f64,
    estimated_profit_usdc: Option<f64>,
    won: Option<bool>,
) -> Option<f64> {
    match won {
        Some(true) => estimated_profit_usdc,
        Some(false) => Some(-amount_usdc),
        None => Some(0.0),
    }
}

pub(super) struct TokenContext<'a> {
    pub(super) slug: &'a String,
    pub(super) token: &'a OutcomeToken,
}

#[derive(Clone, Debug)]
pub(super) struct PreparedTrade {
    pub(super) asset: Asset,
    pub(super) slug: String,
    pub(super) condition_id: String,
    pub(super) token_id: String,
    pub(super) outcome: Outcome,
    pub(super) amount_usdc: f64,
    pub(super) order_price: f64,
    pub(super) size_shares: f64,
    pub(super) order_price_decimal: Decimal,
    pub(super) order_size_shares_decimal: Decimal,
    pub(super) expires_at: DateTime<Utc>,
    pub(super) line_price: f64,
    pub(super) current_price: f64,
    pub(super) line_observed_at: DateTime<Utc>,
    pub(super) current_exchange_timestamp: DateTime<Utc>,
    pub(super) current_received_at: DateTime<Utc>,
    pub(super) remaining_sec: i64,
    pub(super) final_window_experimental: bool,
    pub(super) order_cap_usdc: f64,
    pub(super) target_order_notional_usdc: f64,
    pub(super) d_bps: Option<String>,
    pub(super) p_win: Option<f64>,
    pub(super) p_win_lower: Option<f64>,
    pub(super) best_edge: Option<f64>,
    pub(super) best_bid: Option<f64>,
    pub(super) best_bid_size: Option<f64>,
    pub(super) best_ask: Option<f64>,
    pub(super) best_ask_size: Option<f64>,
    pub(super) weighted_avg_price: Option<f64>,
    pub(super) best_fee: Option<f64>,
    pub(super) best_all_in_cost: Option<f64>,
    pub(super) expected_fill_price: Option<f64>,
    pub(super) estimated_payout_usdc: Option<f64>,
    pub(super) estimated_profit_usdc: Option<f64>,
    pub(super) remaining_sec_bucket: Option<u32>,
    pub(super) vol_bps_per_sqrt_min: Option<f64>,
    pub(super) momentum_1m_vol_normalized: Option<f64>,
    pub(super) binance_momentum_1m_vol_normalized: Option<f64>,
    pub(super) coinbase_momentum_1m_vol_normalized: Option<f64>,
    pub(super) momentum_source_count: u8,
    pub(super) momentum_overlay_side: Option<String>,
    pub(super) momentum_overlay_threshold: f64,
    pub(super) momentum_overlay_vol_lookback_min: u32,
    pub(super) vol_bin: Option<String>,
    pub(super) matched_remaining_sec_bucket: Option<u32>,
    pub(super) matched_abs_d_bps_min: Option<f64>,
    pub(super) matched_abs_d_bps_max: Option<f64>,
    pub(super) cell_sample_count: Option<u64>,
    pub(super) return_last_60s_bps: Option<f64>,
    pub(super) retracing_60s: Option<bool>,
    pub(super) max_abs_d_bps_so_far: Option<f64>,
    pub(super) lead_decay_ratio: Option<f64>,
    pub(super) edge_penalty_applied: bool,
    pub(super) runtime_config_hash: Option<String>,
    pub(super) source_config_hash: Option<String>,
    pub(super) training_input_hash: Option<String>,
    pub(super) training_label_source_kind: Option<String>,
}
