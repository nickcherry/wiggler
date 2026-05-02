use chrono::{TimeDelta, Utc};
use tracing::{info, warn};

use crate::{
    config::RuntimeConfig,
    domain::market::MonitoredMarket,
    runtime::RuntimeBundle,
    trading::{LiveOrderRequest, LiveTradeExecutor},
};

use super::state::MonitorState;
use super::trades::PreparedTrade;
use super::{
    RETRYABLE_NO_FILL_COOLDOWN_SECONDS, TelegramOutbox, TradeMode, clean_failure_reason,
    is_retryable_no_fill_error, is_retryable_no_fill_response, live_entry_posted_text,
    live_entry_rejected_text, pre_submit_matches_initial, retryable_no_fill_key,
};

impl MonitorState {
    pub(super) async fn execute_live_trade(
        &mut self,
        market: &MonitoredMarket,
        runtime_bundle: &RuntimeBundle,
        config: &RuntimeConfig,
        executor: &LiveTradeExecutor,
        telegram: &TelegramOutbox,
        initial_prepared: &PreparedTrade,
    ) {
        let now = Utc::now();
        let no_fill_key =
            retryable_no_fill_key(&initial_prepared.condition_id, &initial_prepared.token_id);
        if let Some(until) = self
            .retryable_no_fill_cooldown_until
            .get(&no_fill_key)
            .copied()
        {
            if now < until {
                return;
            }
            self.retryable_no_fill_cooldown_until.remove(&no_fill_key);
        }

        if self.failed_order_markets.contains(&market.condition_id) {
            return;
        }
        if let Some(skip_reason) = self.live_exposure_skip_reason(&market.condition_id, now) {
            info!(
                event = "live_execution_skipped",
                slug = market.slug,
                condition_id = market.condition_id,
                skip_reason,
                exposure_checked_at = ?self.remote_exposure_checked_at,
                "live execution skipped"
            );
            return;
        }

        let Some(prepared) = self.evaluate_trade(
            market,
            runtime_bundle,
            config,
            Utc::now(),
            config.log_evaluations,
        ) else {
            info!(
                event = "live_execution_skipped",
                slug = market.slug,
                condition_id = market.condition_id,
                skip_reason = "pre_submit_recompute_failed",
                "live execution skipped"
            );
            return;
        };
        if !pre_submit_matches_initial(initial_prepared, &prepared) {
            info!(
                event = "live_execution_skipped",
                slug = market.slug,
                condition_id = market.condition_id,
                initial_outcome = ?initial_prepared.outcome,
                pre_submit_outcome = ?prepared.outcome,
                initial_token_id = initial_prepared.token_id.as_str(),
                pre_submit_token_id = prepared.token_id.as_str(),
                skip_reason = "pre_submit_side_flip",
                "live execution skipped"
            );
            return;
        }

        self.pending_markets.insert(market.condition_id.clone());
        self.record_trade_entry(config, market, &prepared, TradeMode::Live, false);

        let request = LiveOrderRequest {
            asset: prepared.asset,
            slug: prepared.slug.clone(),
            condition_id: prepared.condition_id.clone(),
            token_id: prepared.token_id.clone(),
            outcome: prepared.outcome.clone(),
            amount_usdc: prepared.amount_usdc,
            limit_price: prepared.order_price_decimal,
            size_shares: prepared.order_size_shares_decimal,
            expires_at: prepared.expires_at,
        };
        info!(
            event = "live_order_submit",
            timestamp = %Utc::now().to_rfc3339(),
            mode = "live",
            asset = %request.asset,
            slug = request.slug.as_str(),
            condition_id = request.condition_id.as_str(),
            token_id = request.token_id.as_str(),
            outcome = ?request.outcome,
            amount_usdc = request.amount_usdc,
            limit_price = %request.limit_price,
            size_shares = %request.size_shares,
            expires_at = %request.expires_at,
            order_type = "GTD",
            post_only = true,
            decision = "submitted",
            "submitting live maker order"
        );
        let result = executor.execute(&request).await;
        self.pending_markets.remove(&market.condition_id);

        match result {
            Ok(response) => {
                let retryable_no_fill = is_retryable_no_fill_response(&response);
                if response.success {
                    self.positioned_markets.insert(market.condition_id.clone());
                    self.retryable_no_fill_cooldown_until.remove(&no_fill_key);
                } else if retryable_no_fill {
                    self.retryable_no_fill_cooldown_until.insert(
                        no_fill_key,
                        Utc::now() + TimeDelta::seconds(RETRYABLE_NO_FILL_COOLDOWN_SECONDS),
                    );
                } else {
                    self.failed_order_markets
                        .insert(market.condition_id.clone());
                }
                self.record_live_response(&market.condition_id, &response);
                let decision = if response.success {
                    "posted"
                } else if retryable_no_fill {
                    "no_fill_retryable"
                } else {
                    "rejected"
                };
                info!(
                    event = "live_order_response",
                    timestamp = %Utc::now().to_rfc3339(),
                    mode = "live",
                    slug = market.slug,
                    condition_id = market.condition_id,
                    token_id = request.token_id.as_str(),
                    outcome = ?request.outcome,
                    amount_usdc = request.amount_usdc,
                    limit_price = %request.limit_price,
                    size_shares = %request.size_shares,
                    expires_at = %request.expires_at,
                    order_type = "GTD",
                    post_only = true,
                    order_id = response.order_id.as_str(),
                    status = response.status.as_str(),
                    success = response.success,
                    error_msg = ?response.error_msg,
                    making_amount = response.making_amount.as_str(),
                    taking_amount = response.taking_amount.as_str(),
                    trade_ids = ?response.trade_ids,
                    decision,
                    "live order response"
                );
                if !response.success && !retryable_no_fill {
                    warn!(
                        event = "live_order_rejected",
                        timestamp = %Utc::now().to_rfc3339(),
                        mode = "live",
                        slug = market.slug,
                        condition_id = market.condition_id,
                        token_id = request.token_id.as_str(),
                        outcome = ?request.outcome,
                        amount_usdc = request.amount_usdc,
                        limit_price = %request.limit_price,
                        size_shares = %request.size_shares,
                        expires_at = %request.expires_at,
                        order_type = "GTD",
                        post_only = true,
                        order_id = response.order_id.as_str(),
                        status = response.status.as_str(),
                        error_msg = ?response.error_msg,
                        making_amount = response.making_amount.as_str(),
                        taking_amount = response.taking_amount.as_str(),
                        trade_ids = ?response.trade_ids,
                        decision = "rejected",
                        "live order rejected"
                    );
                }
                let message = if response.success {
                    Some(live_entry_posted_text(&prepared))
                } else if retryable_no_fill {
                    None
                } else if !response.success {
                    Some(live_entry_rejected_text(
                        request.asset,
                        &request.outcome,
                        response.error_msg.as_deref().unwrap_or("unknown"),
                    ))
                } else {
                    None
                };
                if let Some(message) = message {
                    telegram.send_message(message);
                }
            }
            Err(error) => {
                let error_chain = format!("{error:#}");
                let retryable_no_fill = is_retryable_no_fill_error(&error_chain);
                if !retryable_no_fill {
                    self.failed_order_markets
                        .insert(market.condition_id.clone());
                } else {
                    self.retryable_no_fill_cooldown_until.insert(
                        no_fill_key,
                        Utc::now() + TimeDelta::seconds(RETRYABLE_NO_FILL_COOLDOWN_SECONDS),
                    );
                }
                self.record_live_error(&market.condition_id, &error_chain, retryable_no_fill);
                warn!(
                    event = "live_order_error",
                    timestamp = %Utc::now().to_rfc3339(),
                    mode = "live",
                    slug = market.slug,
                    condition_id = market.condition_id,
                    decision = if retryable_no_fill { "no_fill_retryable" } else { "rejected" },
                    error = %error_chain,
                    "live order failed"
                );
                if !retryable_no_fill {
                    let message = live_entry_rejected_text(
                        request.asset,
                        &request.outcome,
                        &clean_failure_reason(&error_chain),
                    );
                    telegram.send_message(message);
                }
            }
        }
    }
}
