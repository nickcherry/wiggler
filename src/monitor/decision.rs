use chrono::{DateTime, Utc};
use rust_decimal::prelude::ToPrimitive;
use tracing::{info, warn};

use crate::{
    config::RuntimeConfig,
    domain::{
        market::{MonitoredMarket, Outcome},
        orderbook::TokenBook,
    },
    runtime::{AssetRuntime, RuntimeBundle, SideLeading},
    trading::LiveTradeExecutor,
};

use super::path::{edge_penalty_applies, summarize_maker_limit};
use super::state::MonitorState;
use super::trades::PreparedTrade;
use super::{
    EXPERIMENTAL_FINAL_WINDOW_EXTRA_EDGE_PROBABILITY, EXPERIMENTAL_FINAL_WINDOW_MIN_ABS_D_BPS,
    MOMENTUM_OVERLAY_THRESHOLD_VOL_UNITS, MOMENTUM_OVERLAY_VOL_LOOKBACK_MIN, TelegramOutbox,
    TradeMode, adjusted_required_edge_probability, age_ms, decimal_abs, distance_bps,
    effective_max_order_usdc, experimental_final_window_applies, maker_order_expires_at,
    momentum_overlay_side_for_value, monitor_remaining_bucket, outcome_for_side, outcome_label,
    side_for_distance, target_order_notional_usdc,
};

impl MonitorState {
    pub(super) async fn evaluate_and_maybe_execute(
        &mut self,
        runtime_bundle: &RuntimeBundle,
        config: &RuntimeConfig,
        live_executor: Option<&LiveTradeExecutor>,
        telegram: &TelegramOutbox,
    ) {
        let now = Utc::now();
        let markets = self.markets_by_slug.values().cloned().collect::<Vec<_>>();
        for market in &markets {
            if now < market.slot.start() || now >= market.slot.end() {
                continue;
            }

            let prepared =
                self.evaluate_trade(market, runtime_bundle, config, now, config.log_evaluations);
            let Some(prepared) = prepared else {
                continue;
            };

            if config.live_trading {
                let Some(executor) = live_executor else {
                    warn!(slug = market.slug, "live trading enabled without executor");
                    continue;
                };
                self.execute_live_trade(
                    market,
                    runtime_bundle,
                    config,
                    executor,
                    telegram,
                    &prepared,
                )
                .await;
            } else if self
                .shadow_decision_markets
                .insert(market.condition_id.clone())
            {
                self.record_trade_entry(config, market, &prepared, TradeMode::Shadow, true);
                telegram.send_message(prepared.telegram_text(TradeMode::Shadow));
            }
        }
    }

    pub(super) fn evaluate_trade(
        &self,
        market: &MonitoredMarket,
        runtime_bundle: &RuntimeBundle,
        config: &RuntimeConfig,
        now: DateTime<Utc>,
        emit_log: bool,
    ) -> Option<PreparedTrade> {
        let runtime = runtime_bundle.config_for(market.asset);
        let line = self.slot_lines.get(&market.slug);
        let latest_tick = self.latest_prices.get(&market.asset);
        let remaining_sec = (market.slot.end() - now).num_seconds();
        let d_bps = latest_tick
            .zip(line)
            .and_then(|(tick, line)| distance_bps(tick.value, line.price));
        let abs_d_bps = d_bps.map(decimal_abs);
        let abs_d_bps_f64 = abs_d_bps.and_then(|value| value.to_f64());
        let side_leading = d_bps.and_then(side_for_distance);
        let buy_outcome = side_leading.map(outcome_for_side);
        let token = buy_outcome
            .clone()
            .and_then(|outcome| self.token_for_outcome(market, outcome));
        let book = token.and_then(|token| self.books.book(&token.asset_id));
        let best_bid = book.and_then(TokenBook::best_bid);
        let best_ask = book.and_then(TokenBook::best_ask);
        let price_age_ms = latest_tick.map(|tick| age_ms(now, tick.received_at));
        let price_exchange_age_ms = latest_tick.map(|tick| age_ms(now, tick.exchange_timestamp));
        let book_age_ms = book.and_then(|book| book.last_timestamp.map(|ts| age_ms(now, ts)));
        let remaining_bucket =
            runtime.and_then(|runtime| monitor_remaining_bucket(runtime, remaining_sec));
        let final_window_experimental = runtime
            .is_some_and(|runtime| experimental_final_window_applies(runtime, remaining_sec));
        let exchange_vol = runtime.map(|runtime| {
            self.candle_store
                .vol_bps_per_sqrt_min(market.asset, now, runtime.vol_lookback_min())
        });
        let binance_vol_bps_per_sqrt_min = exchange_vol.and_then(|vol| vol.binance);
        let coinbase_vol_bps_per_sqrt_min = exchange_vol.and_then(|vol| vol.coinbase);
        let vol_bps_per_sqrt_min = exchange_vol.and_then(|vol| vol.average());
        let exchange_momentum = runtime.map(|_| {
            self.candle_store.normalized_momentum_1m(
                market.asset,
                now,
                MOMENTUM_OVERLAY_VOL_LOOKBACK_MIN,
            )
        });
        let binance_momentum_1m_vol_normalized =
            exchange_momentum.and_then(|momentum| momentum.binance);
        let coinbase_momentum_1m_vol_normalized =
            exchange_momentum.and_then(|momentum| momentum.coinbase);
        let momentum_1m_vol_normalized = exchange_momentum.and_then(|momentum| momentum.average());
        let momentum_source_count = exchange_momentum
            .map(|momentum| momentum.source_count())
            .unwrap_or_default();
        let momentum_overlay_side =
            momentum_1m_vol_normalized.and_then(momentum_overlay_side_for_value);
        let vol_bin = runtime
            .zip(vol_bps_per_sqrt_min)
            .map(|(runtime, vol)| runtime.vol_bin(vol));
        let cell = runtime
            .zip(remaining_bucket)
            .zip(vol_bin)
            .zip(side_leading)
            .zip(abs_d_bps_f64)
            .and_then(
                |((((runtime, remaining_bucket), vol_bin), side_leading), abs_d_bps)| {
                    runtime.find_cell(remaining_bucket, vol_bin, side_leading, abs_d_bps)
                },
            );
        let path_state = self
            .price_paths
            .get(&market.slug)
            .zip(latest_tick)
            .zip(line)
            .zip(side_leading)
            .zip(abs_d_bps_f64)
            .and_then(
                |((((path, tick), line), side_leading), current_abs_d_bps)| {
                    path.state(
                        tick.exchange_timestamp,
                        tick.value,
                        line.price,
                        side_leading,
                        current_abs_d_bps,
                    )
                },
            );
        let edge_penalty_applied = path_state.as_ref().is_some_and(edge_penalty_applies);
        let required_edge = runtime
            .zip(path_state.as_ref())
            .and_then(|(runtime, state)| {
                adjusted_required_edge_probability(runtime, state, final_window_experimental)
            });
        let order_cap_usdc = effective_max_order_usdc(config, final_window_experimental);
        let target_order_notional_usdc = runtime.and_then(|runtime| {
            target_order_notional_usdc(runtime, config, final_window_experimental)
        });
        let maker_limit_price = best_bid.as_ref().map(|level| level.price);
        let edge_summary = runtime
            .zip(cell)
            .zip(maker_limit_price)
            .zip(required_edge)
            .zip(target_order_notional_usdc)
            .and_then(
                |((((_, cell), limit_price), required_edge), target_notional)| {
                    summarize_maker_limit(cell, limit_price, required_edge, target_notional)
                },
            );
        let already_positioned = self.positioned_markets.contains(&market.condition_id)
            || self.pending_markets.contains(&market.condition_id);
        let market_resolved = self.resolved_markets.contains(&market.condition_id);
        let live_exposure_skip_reason = config
            .live_trading
            .then(|| self.live_exposure_skip_reason(&market.condition_id, now))
            .flatten();
        let skip_reason = if self.failed_order_markets.contains(&market.condition_id) {
            Some("live_order_failed")
        } else if let Some(reason) = live_exposure_skip_reason {
            Some(reason)
        } else {
            self.trade_skip_reason(
                market.asset,
                runtime,
                remaining_sec,
                line,
                latest_tick,
                price_age_ms,
                price_exchange_age_ms,
                d_bps,
                abs_d_bps_f64,
                side_leading,
                momentum_overlay_side,
                token,
                book,
                book_age_ms,
                vol_bps_per_sqrt_min,
                cell,
                path_state.as_ref(),
                required_edge,
                best_bid.as_ref(),
                best_ask.as_ref(),
                edge_summary.as_ref(),
                already_positioned,
                market_resolved,
                config,
            )
        };
        let decision = if skip_reason.is_some() {
            "skip"
        } else {
            "would_trade"
        };

        if emit_log {
            info!(
                event = "trade_evaluation",
                timestamp = %now.to_rfc3339(),
                mode = if config.live_trading { "live" } else { "shadow" },
                asset = %market.asset,
                market_id = market.market_id,
                condition_id = market.condition_id,
                slug = market.slug,
                up_token_id = ?self.token_for_outcome(market, Outcome::Up).map(|token| token.asset_id.as_str()),
                down_token_id = ?self.token_for_outcome(market, Outcome::Down).map(|token| token.asset_id.as_str()),
                buy_token_id = ?token.map(|token| token.asset_id.as_str()),
                buy_outcome = ?buy_outcome.as_ref().map(outcome_label),
                line_price = ?line.map(|line| line.price.to_string()),
                line_observed_at = ?line.map(|line| line.observed_at),
                current_price = ?latest_tick.map(|tick| tick.value.to_string()),
                price_source = ?latest_tick.map(|tick| tick.source.to_string()),
                price_symbol = ?latest_tick.map(|tick| tick.symbol.as_str()),
                market_resolution_source = ?market.resolution_source.as_deref(),
                current_received_at = ?latest_tick.map(|tick| tick.received_at),
                current_exchange_timestamp = ?latest_tick.map(|tick| tick.exchange_timestamp),
                price_age_ms = ?price_age_ms,
                price_exchange_age_ms = ?price_exchange_age_ms,
                orderbook_age_ms = ?book_age_ms,
                remaining_sec,
                remaining_sec_bucket = ?remaining_bucket,
                final_window_experimental,
                final_window_min_abs_d_bps = ?final_window_experimental.then_some(EXPERIMENTAL_FINAL_WINDOW_MIN_ABS_D_BPS),
                d_bps = ?d_bps.map(|value| value.round_dp(6).to_string()),
                abs_d_bps = ?abs_d_bps.map(|value| value.round_dp(6).to_string()),
                side_leading = ?side_leading.map(SideLeading::as_str),
                vol_bps_per_sqrt_min = ?vol_bps_per_sqrt_min,
                binance_vol_bps_per_sqrt_min = ?binance_vol_bps_per_sqrt_min,
                coinbase_vol_bps_per_sqrt_min = ?coinbase_vol_bps_per_sqrt_min,
                vol_source_count = exchange_vol.map(|vol| vol.source_count()).unwrap_or_default(),
                momentum_1m_vol_normalized = ?momentum_1m_vol_normalized,
                binance_momentum_1m_vol_normalized = ?binance_momentum_1m_vol_normalized,
                coinbase_momentum_1m_vol_normalized = ?coinbase_momentum_1m_vol_normalized,
                momentum_source_count,
                momentum_overlay_side = ?momentum_overlay_side.map(SideLeading::as_str),
                momentum_overlay_threshold = MOMENTUM_OVERLAY_THRESHOLD_VOL_UNITS,
                momentum_overlay_vol_lookback_min = MOMENTUM_OVERLAY_VOL_LOOKBACK_MIN,
                vol_bin = ?vol_bin.map(|bin| bin.as_str()),
                matched_remaining_sec_bucket = ?cell.map(|cell| cell.remaining_sec),
                matched_vol_bin = ?cell.map(|cell| cell.vol_bin.as_str()),
                matched_side_leading = ?cell.map(|cell| cell.side_leading.as_str()),
                matched_abs_d_bps_min = ?cell.map(|cell| cell.abs_d_bps_min),
                matched_abs_d_bps_max = ?cell.and_then(|cell| cell.abs_d_bps_max),
                cell_sample_count = ?cell.map(|cell| cell.sample_count),
                p_win = ?cell.map(|cell| cell.p_win),
                p_win_lower = ?cell.map(|cell| cell.p_win_lower),
                return_last_60s_bps = ?path_state.as_ref().map(|state| state.return_last_60s_bps),
                retracing_60s = ?path_state.as_ref().map(|state| state.retracing_60s),
                max_abs_d_bps_so_far = ?path_state.as_ref().map(|state| state.max_abs_d_bps_so_far),
                lead_decay_ratio = ?path_state.as_ref().map(|state| state.lead_decay_ratio),
                edge_penalty_applied,
                best_bid = ?best_bid.as_ref().map(|level| level.price.to_string()),
                best_bid_size = ?best_bid.as_ref().map(|level| level.size.to_string()),
                best_ask = ?best_ask.as_ref().map(|level| level.price.to_string()),
                best_ask_size = ?best_ask.as_ref().map(|level| level.size.to_string()),
                maker_fee = ?edge_summary.as_ref().and_then(|summary| summary.best_fee),
                maker_edge = ?edge_summary.as_ref().and_then(|summary| summary.best_edge),
                maker_order_price = ?edge_summary.as_ref().and_then(|summary| summary.order_price).map(|price| price.to_string()),
                maker_order_size_shares = ?edge_summary.as_ref().and_then(|summary| summary.order_size_shares).map(|size| size.to_string()),
                maker_order_notional_usdc = ?edge_summary.as_ref().and_then(|summary| summary.order_notional_usdc).map(|amount| amount.to_string()),
                target_order_notional_usdc = ?target_order_notional_usdc.map(|amount| amount.to_string()),
                weighted_avg_price = ?edge_summary.as_ref().and_then(|summary| summary.weighted_avg_price),
                all_in_cost = ?edge_summary.as_ref().and_then(|summary| summary.best_all_in_cost),
                edge = ?edge_summary.as_ref().and_then(|summary| summary.best_edge),
                max_acceptable_price = ?edge_summary.as_ref().and_then(|summary| summary.max_acceptable_price),
                maker_fee_rate = 0.0,
                taker_fee_rate = ?runtime.map(AssetRuntime::fee_rate),
                min_edge_probability = ?runtime.map(AssetRuntime::min_edge_probability),
                min_p_win_lower = config.min_p_win_lower,
                min_abs_d_bps = config.min_abs_d_bps,
                required_edge = ?required_edge,
                final_window_extra_edge_probability = ?final_window_experimental.then_some(EXPERIMENTAL_FINAL_WINDOW_EXTRA_EDGE_PROBABILITY),
                min_order_usdc = config.min_order_usdc,
                max_position_usdc = ?runtime.map(AssetRuntime::max_position_usdc),
                max_order_usdc = config.max_order_usdc,
                effective_max_order_usdc = order_cap_usdc,
                already_positioned,
                market_resolved,
                decision,
                skip_reason = ?skip_reason,
                live_trading = config.live_trading,
                config_hash = ?runtime.map(AssetRuntime::runtime_config_hash),
                source_config_hash = ?runtime.map(AssetRuntime::source_config_hash),
                training_input_hash = ?runtime.map(AssetRuntime::training_input_hash),
                training_label_source_kind = ?runtime.and_then(AssetRuntime::training_label_source_kind),
                "trade evaluation"
            );
        }

        if skip_reason.is_some() {
            return None;
        }

        let runtime = runtime?;
        let token = token?;
        let line = line?;
        let latest_tick = latest_tick?;
        let edge_summary = edge_summary.as_ref()?;
        let target_order_notional_usdc = target_order_notional_usdc?;
        let order_price = edge_summary.order_price?;
        let order_size_shares = edge_summary.order_size_shares?;
        let amount_usdc_decimal = edge_summary.order_notional_usdc?;
        let amount_usdc = amount_usdc_decimal.to_f64()?;
        if amount_usdc < config.min_order_usdc {
            return None;
        }
        let order_price_f64 = order_price.to_f64()?;
        let order_size_shares_f64 = order_size_shares.to_f64()?;
        let expires_at = maker_order_expires_at(market.slot.end());
        let best_bid_price = best_bid.as_ref().and_then(|level| level.price.to_f64());
        let best_bid_size = best_bid.as_ref().and_then(|level| level.size.to_f64());
        let best_ask_price = best_ask.as_ref().and_then(|level| level.price.to_f64());
        let best_ask_size = best_ask.as_ref().and_then(|level| level.size.to_f64());
        let expected_fill_price = Some(order_price_f64);
        let estimated_payout_usdc = Some(order_size_shares_f64);
        let estimated_profit_usdc = estimated_payout_usdc.map(|payout| payout - amount_usdc);

        Some(PreparedTrade {
            asset: market.asset,
            slug: market.slug.clone(),
            condition_id: market.condition_id.clone(),
            token_id: token.asset_id.clone(),
            outcome: token.outcome.clone(),
            amount_usdc,
            order_price: order_price_f64,
            size_shares: order_size_shares_f64,
            order_price_decimal: order_price,
            order_size_shares_decimal: order_size_shares,
            expires_at,
            line_price: line.price.to_f64()?,
            current_price: latest_tick.value.to_f64()?,
            line_observed_at: line.observed_at,
            current_exchange_timestamp: latest_tick.exchange_timestamp,
            current_received_at: latest_tick.received_at,
            remaining_sec,
            final_window_experimental,
            order_cap_usdc,
            target_order_notional_usdc: target_order_notional_usdc.to_f64()?,
            d_bps: d_bps.map(|value| value.round_dp(6).to_string()),
            p_win: cell.map(|cell| cell.p_win),
            p_win_lower: cell.map(|cell| cell.p_win_lower),
            best_edge: edge_summary.best_edge,
            best_bid: best_bid_price,
            best_bid_size,
            best_ask: best_ask_price,
            best_ask_size,
            weighted_avg_price: edge_summary.weighted_avg_price,
            best_fee: edge_summary.best_fee,
            best_all_in_cost: edge_summary.best_all_in_cost,
            expected_fill_price,
            estimated_payout_usdc,
            estimated_profit_usdc,
            remaining_sec_bucket: remaining_bucket,
            vol_bps_per_sqrt_min,
            momentum_1m_vol_normalized,
            binance_momentum_1m_vol_normalized,
            coinbase_momentum_1m_vol_normalized,
            momentum_source_count,
            momentum_overlay_side: momentum_overlay_side.map(|side| side.as_str().to_string()),
            momentum_overlay_threshold: MOMENTUM_OVERLAY_THRESHOLD_VOL_UNITS,
            momentum_overlay_vol_lookback_min: MOMENTUM_OVERLAY_VOL_LOOKBACK_MIN,
            vol_bin: vol_bin.map(|bin| bin.as_str().to_string()),
            matched_remaining_sec_bucket: cell.map(|cell| cell.remaining_sec),
            matched_abs_d_bps_min: cell.map(|cell| cell.abs_d_bps_min),
            matched_abs_d_bps_max: cell.and_then(|cell| cell.abs_d_bps_max),
            cell_sample_count: cell.map(|cell| cell.sample_count),
            return_last_60s_bps: path_state.as_ref().map(|state| state.return_last_60s_bps),
            retracing_60s: path_state.as_ref().map(|state| state.retracing_60s),
            max_abs_d_bps_so_far: path_state.as_ref().map(|state| state.max_abs_d_bps_so_far),
            lead_decay_ratio: path_state.as_ref().map(|state| state.lead_decay_ratio),
            edge_penalty_applied,
            runtime_config_hash: Some(runtime.runtime_config_hash().to_string()),
            source_config_hash: Some(runtime.source_config_hash().to_string()),
            training_input_hash: Some(runtime.training_input_hash().to_string()),
            training_label_source_kind: runtime.training_label_source_kind().map(str::to_string),
        })
    }
}
