use std::collections::HashSet;

use chrono::{DateTime, Utc};
use rust_decimal::prelude::ToPrimitive;
use serde_json::{Value, json};
use tracing::{debug, info, warn};

use crate::{
    config::RuntimeConfig,
    domain::market::MonitoredMarket,
    trading::{LiveFill, LiveOrderResponse},
};

use super::state::MonitorState;
use super::trades::{PreparedTrade, TrackedEntry};
use super::{
    LIVE_EXPOSURE_CACHE_MAX_AGE_MS, LiveExposureReconcileResult, TelegramOutbox, TradeMode,
    closeout_estimated_pnl, closeout_won, is_retryable_no_fill_response, live_entry_filled_text,
    outcome_label, trade_entry_record_json, trade_record_path, write_json_record,
};

impl MonitorState {
    pub(super) fn record_trade_entry(
        &mut self,
        config: &RuntimeConfig,
        market: &MonitoredMarket,
        prepared: &PreparedTrade,
        mode: TradeMode,
        track_closeout: bool,
    ) {
        let attempted_at = Utc::now();
        let record_path = trade_record_path(&config.trade_record_dir, attempted_at, mode, prepared);
        let mut record = trade_entry_record_json(mode, market, prepared, attempted_at);
        record["record_path"] = json!(record_path.display().to_string());
        if let Err(error) = write_json_record(&record_path, &record) {
            warn!(
                error = %error,
                path = %record_path.display(),
                slug = market.slug,
                "failed to write trade entry record"
            );
        }
        self.tracked_entries.insert(
            market.condition_id.clone(),
            TrackedEntry {
                prepared: prepared.clone(),
                slot_start: market.slot.start(),
                slot_end: market.slot.end(),
                record_path: Some(record_path),
                record,
                track_closeout,
                closeout_sent: false,
                filled_amount_usdc: None,
                filled_payout_usdc: None,
                filled_trade_ids: HashSet::new(),
                filled_fingerprints: HashSet::new(),
            },
        );
    }

    pub(super) fn record_live_response(
        &mut self,
        condition_id: &str,
        response: &LiveOrderResponse,
    ) {
        let Some(entry) = self.tracked_entries.get_mut(condition_id) else {
            return;
        };
        let retryable_no_fill = is_retryable_no_fill_response(response);
        entry.record["order_response"] = json!({
            "received_at": Utc::now().to_rfc3339(),
            "order_id": response.order_id.as_str(),
            "status": response.status.as_str(),
            "success": response.success,
            "error_msg": response.error_msg.as_deref(),
            "making_amount": response.making_amount.as_str(),
            "taking_amount": response.taking_amount.as_str(),
            "trade_ids": &response.trade_ids,
            "maker_only": true,
        });
        entry.record["state"] = json!(if response.success {
            "posted"
        } else if retryable_no_fill {
            "no_fill_retryable"
        } else {
            "rejected"
        });
        entry.write_record();
    }

    pub(super) fn record_live_error(
        &mut self,
        condition_id: &str,
        error: &str,
        retryable_no_fill: bool,
    ) {
        let Some(entry) = self.tracked_entries.get_mut(condition_id) else {
            return;
        };
        entry.track_closeout = false;
        entry.record["order_error"] = json!({
            "received_at": Utc::now().to_rfc3339(),
            "error": error,
        });
        entry.record["state"] = json!(if retryable_no_fill {
            "no_fill_retryable"
        } else {
            "error"
        });
        entry.write_record();
    }

    pub(super) fn close_tracked_entries(&mut self) {
        for entry in self.tracked_entries.values_mut() {
            if entry.closeout_sent || !entry.track_closeout {
                continue;
            }
            let Some(tick) = self.latest_prices.get(&entry.prepared.asset) else {
                continue;
            };
            if tick.exchange_timestamp < entry.slot_end {
                continue;
            }
            let Some(close_price) = tick.value.to_f64() else {
                continue;
            };
            let won = closeout_won(
                &entry.prepared.outcome,
                close_price,
                entry.prepared.line_price,
            );
            let amount_usdc = entry.filled_amount_usdc();
            let estimated_profit_usdc = entry.filled_profit_usdc();
            let estimated_pnl = closeout_estimated_pnl(amount_usdc, estimated_profit_usdc, won);
            entry.closeout_sent = true;
            entry.record["closeout"] = json!({
                "closed_at": Utc::now().to_rfc3339(),
                "price_timestamp": tick.exchange_timestamp,
                "price_received_at": tick.received_at,
                "slot_start": entry.slot_start,
                "slot_end": entry.slot_end,
                "close_price": close_price,
                "line_price": entry.prepared.line_price,
                "outcome": outcome_label(&entry.prepared.outcome),
                "won": won,
                "filled_amount_usdc": amount_usdc,
                "estimated_payout_usdc": entry.filled_payout_usdc,
                "estimated_profit_usdc": estimated_profit_usdc,
                "estimated_pnl_usdc": estimated_pnl,
            });
            entry.record["state"] = json!("closed");
            entry.write_record();
        }
    }

    pub(super) fn live_exposure_reconcile_condition_ids(&self) -> Vec<String> {
        let mut condition_ids = self
            .markets_by_slug
            .values()
            .map(|market| market.condition_id.clone())
            .collect::<Vec<_>>();
        condition_ids.sort();
        condition_ids.dedup();
        condition_ids
    }

    pub(super) fn apply_live_exposure_reconcile(
        &mut self,
        reconcile: LiveExposureReconcileResult,
    ) -> Vec<LiveFill> {
        let requested_condition_ids = reconcile.condition_ids.into_iter().collect::<HashSet<_>>();
        let current_condition_ids = self
            .live_exposure_reconcile_condition_ids()
            .into_iter()
            .collect::<HashSet<_>>();
        let market_count = requested_condition_ids.len();
        match reconcile.result {
            Ok(snapshot) => {
                let open_order_count = snapshot.open_order_markets.len();
                let traded_count = snapshot.traded_markets.len();
                let mut exposed_markets = snapshot.exposed_markets();
                let fills = snapshot.fills;
                let fill_count = fills.len();
                exposed_markets.retain(|condition_id| current_condition_ids.contains(condition_id));
                self.remote_exposure_markets = exposed_markets;
                let snapshot_is_current = requested_condition_ids == current_condition_ids;
                self.remote_exposure_checked_at =
                    snapshot_is_current.then_some(reconcile.checked_at);
                info!(
                    event = "live_exposure_reconcile",
                    checked_at = %reconcile.checked_at,
                    market_count,
                    remote_exposure_count = self.remote_exposure_markets.len(),
                    open_order_count,
                    traded_count,
                    fill_count,
                    snapshot_is_current,
                    "refreshed live exposure cache"
                );
                fills
            }
            Err(error) => {
                warn!(
                    event = "live_exposure_reconcile_error",
                    market_count,
                    error = %format!("{error:#}"),
                    "failed to refresh live exposure cache"
                );
                Vec::new()
            }
        }
    }

    pub(super) fn apply_live_fill(&mut self, fill: LiveFill, telegram: &TelegramOutbox) {
        self.positioned_markets.insert(fill.condition_id.clone());
        self.remote_exposure_markets
            .insert(fill.condition_id.clone());

        let message = {
            let Some(entry) = self.tracked_entries.get_mut(&fill.condition_id) else {
                debug!(
                    event = "live_fill_untracked",
                    condition_id = fill.condition_id.as_str(),
                    asset_id = fill.asset_id.as_str(),
                    fill_id = fill.fill_id.as_str(),
                    source = fill.source.as_str(),
                    "observed fill without a local tracked entry"
                );
                return;
            };
            if entry.prepared.token_id != fill.asset_id {
                debug!(
                    event = "live_fill_token_mismatch",
                    condition_id = fill.condition_id.as_str(),
                    fill_asset_id = fill.asset_id.as_str(),
                    tracked_token_id = entry.prepared.token_id.as_str(),
                    fill_id = fill.fill_id.as_str(),
                    source = fill.source.as_str(),
                    "observed fill on a different outcome token"
                );
                return;
            }

            let fill_fingerprint = fill.approximate_key();
            if entry.filled_trade_ids.contains(&fill.fill_id)
                || entry.filled_fingerprints.contains(&fill_fingerprint)
            {
                return;
            }
            entry.filled_trade_ids.insert(fill.fill_id.clone());
            entry.filled_fingerprints.insert(fill_fingerprint);
            entry.track_closeout = true;
            entry.filled_amount_usdc =
                Some(entry.filled_amount_usdc.unwrap_or_default() + fill.amount_usdc);
            entry.filled_payout_usdc =
                Some(entry.filled_payout_usdc.unwrap_or_default() + fill.payout_usdc);

            if entry
                .record
                .get("fills")
                .and_then(Value::as_array)
                .is_none()
            {
                entry.record["fills"] = json!([]);
            }
            if let Some(fills) = entry.record.get_mut("fills").and_then(Value::as_array_mut) {
                fills.push(json!({
                    "fill_id": fill.fill_id.as_str(),
                    "source": fill.source.as_str(),
                    "matched_at": fill.matched_at.to_rfc3339(),
                    "condition_id": fill.condition_id.as_str(),
                    "asset_id": fill.asset_id.as_str(),
                    "size_shares": fill.size_shares,
                    "price": fill.price,
                    "amount_usdc": fill.amount_usdc,
                    "payout_usdc": fill.payout_usdc,
                }));
            }
            entry.record["state"] = json!("filled");
            entry.record["filled_amount_usdc"] = json!(entry.filled_amount_usdc);
            entry.record["filled_payout_usdc"] = json!(entry.filled_payout_usdc);
            entry.write_record();

            info!(
                event = "live_order_fill",
                slug = entry.prepared.slug.as_str(),
                condition_id = fill.condition_id.as_str(),
                asset_id = fill.asset_id.as_str(),
                fill_id = fill.fill_id.as_str(),
                source = fill.source.as_str(),
                size_shares = fill.size_shares,
                price = fill.price,
                amount_usdc = fill.amount_usdc,
                payout_usdc = fill.payout_usdc,
                matched_at = %fill.matched_at,
                "recorded live maker order fill"
            );

            live_entry_filled_text(&entry.prepared, &fill)
        };

        telegram.send_message(message);
    }

    pub(super) fn live_exposure_skip_reason(
        &self,
        condition_id: &str,
        now: DateTime<Utc>,
    ) -> Option<&'static str> {
        if self.pending_markets.contains(condition_id) {
            return Some("pending_market");
        }
        if self.positioned_markets.contains(condition_id) {
            return Some("already_positioned");
        }
        if self.remote_exposure_markets.contains(condition_id) {
            return Some("remote_market_exposure");
        }
        if self.live_exposure_cache_is_stale(now) {
            return Some("live_exposure_cache_stale");
        }
        None
    }

    pub(super) fn live_exposure_cache_is_stale(&self, now: DateTime<Utc>) -> bool {
        self.remote_exposure_checked_at.is_none_or(|checked_at| {
            (now - checked_at).num_milliseconds() > LIVE_EXPOSURE_CACHE_MAX_AGE_MS
        })
    }
}
