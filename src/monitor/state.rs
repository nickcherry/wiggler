use std::collections::{HashMap, HashSet};

use anyhow::Result;
use chrono::{DateTime, TimeDelta, Utc};
use rust_decimal::{Decimal, prelude::ToPrimitive};
use serde_json::{Value, json};
use tracing::{debug, info, warn};

use crate::{
    config::RuntimeConfig,
    domain::{
        asset::Asset,
        market::{MonitoredMarket, Outcome, OutcomeToken},
        orderbook::{OrderBookSet, PriceLevel, TokenBook},
    },
    exchange_candles::{Candle, CandleStore},
    polymarket::{market_ws::MarketWsEvent, rtds::PriceTick},
    runtime::{AssetRuntime, RuntimeBundle, RuntimeCell, SideLeading},
    trade_analysis::ApiClosedPositionPnlRows,
    trading::{LiveFill, LiveOrderRequest, LiveOrderResponse, LiveTradeExecutor},
};

use super::path::{
    EdgeSummary, MarketPricePath, PathState, edge_penalty_applies, summarize_maker_limit,
};
use super::{
    EXPERIMENTAL_FINAL_WINDOW_EXTRA_EDGE_PROBABILITY, EXPERIMENTAL_FINAL_WINDOW_MIN_ABS_D_BPS,
    EventCounts, LIVE_EXPOSURE_CACHE_MAX_AGE_MS, LiveExposureReconcileResult,
    MOMENTUM_OVERLAY_THRESHOLD_VOL_UNITS, MOMENTUM_OVERLAY_VOL_LOOKBACK_MIN, PreparedTrade,
    RETRYABLE_NO_FILL_COOLDOWN_SECONDS, TelegramOutbox, TokenContext, TrackedEntry, TradeMode,
    adjusted_required_edge_probability, age_ms, clean_failure_reason,
    closed_position_outcome_label, closed_position_row_from_api_position, closed_position_ticker,
    closed_position_totals, closed_rows_for_slot, closeout_estimated_pnl, closeout_won,
    decimal_abs, distance_bps, duration_ms, effective_max_order_usdc,
    experimental_final_window_applies, is_retryable_no_fill_error, is_retryable_no_fill_response,
    live_entry_filled_text, live_entry_posted_text, live_entry_rejected_text,
    live_settlement_summary_text, maker_order_expires_at, momentum_overlay_side_for_value,
    monitor_min_remaining_sec_to_trade, monitor_remaining_bucket, outcome_for_side, outcome_label,
    pre_submit_matches_initial, retryable_no_fill_key, side_for_distance,
    target_order_notional_usdc, trade_entry_record_json, trade_record_path, write_json_record,
};

#[derive(Clone, Debug)]
pub(super) struct SlotLine {
    pub(super) price: Decimal,
    pub(super) observed_at: DateTime<Utc>,
}

pub(super) struct LiveSettlementFetchResult {
    pub(super) unsent_slots: Vec<DateTime<Utc>>,
    pub(super) result: Result<ApiClosedPositionPnlRows>,
}

#[derive(Default)]
pub(super) struct MonitorState {
    pub(super) markets_by_slug: HashMap<String, MonitoredMarket>,
    pub(super) markets_by_asset_id: HashMap<String, (String, OutcomeToken)>,
    pub(super) books: OrderBookSet,
    pub(super) latest_prices: HashMap<Asset, PriceTick>,
    pub(super) candle_store: CandleStore,
    pub(super) price_paths: HashMap<String, MarketPricePath>,
    pub(super) slot_lines: HashMap<String, SlotLine>,
    pub(super) positioned_markets: HashSet<String>,
    pub(super) pending_markets: HashSet<String>,
    pub(super) failed_order_markets: HashSet<String>,
    pub(super) remote_exposure_markets: HashSet<String>,
    pub(super) remote_exposure_checked_at: Option<DateTime<Utc>>,
    pub(super) retryable_no_fill_cooldown_until: HashMap<String, DateTime<Utc>>,
    pub(super) shadow_decision_markets: HashSet<String>,
    pub(super) tracked_entries: HashMap<String, TrackedEntry>,
    pub(super) resolved_markets: HashSet<String>,
    pub(super) initial_books_seen: HashSet<String>,
    pub(super) event_counts: EventCounts,
    pub(super) sent_live_settlement_slots: HashSet<DateTime<Utc>>,
}

impl MonitorState {
    pub(super) fn new(candle_retention_min: i64) -> Self {
        Self {
            candle_store: CandleStore::new(candle_retention_min),
            ..Self::default()
        }
    }

    pub(super) fn apply_live_settlement_fetch(
        &mut self,
        settlement: LiveSettlementFetchResult,
        telegram: &TelegramOutbox,
    ) {
        let api_rows = match settlement.result {
            Ok(api_rows) => api_rows,
            Err(error) => {
                warn!(
                    error = %error,
                    "failed to load Polymarket API position PnL for Telegram summary"
                );
                return;
            }
        };
        let positions_fetched = api_rows.positions_fetched;
        let positions_considered = api_rows.positions_considered;
        let api_rows = api_rows
            .rows
            .into_iter()
            .map(closed_position_row_from_api_position)
            .collect::<Vec<_>>();

        let mut summaries = Vec::new();
        for slot_start in settlement.unsent_slots {
            let mut slot_rows = closed_rows_for_slot(&api_rows, slot_start);
            if slot_rows.is_empty() {
                info!(
                    event = "live_settlement_summary_empty",
                    slot_start = %slot_start,
                    positions_fetched,
                    positions_considered,
                    "no position PnL rows available for Telegram summary"
                );
                continue;
            }
            slot_rows.sort_by(|left, right| {
                closed_position_ticker(left)
                    .cmp(&closed_position_ticker(right))
                    .then_with(|| {
                        closed_position_outcome_label(left)
                            .cmp(closed_position_outcome_label(right))
                    })
                    .then_with(|| {
                        left.realized_pnl
                            .unwrap_or(0.0)
                            .total_cmp(&right.realized_pnl.unwrap_or(0.0))
                    })
            });
            summaries.push((slot_start, slot_rows));
        }

        if summaries.is_empty() {
            return;
        }

        let all_time_totals = closed_position_totals(&api_rows);

        for (slot_start, slot_rows) in summaries {
            let message = live_settlement_summary_text(&slot_rows, all_time_totals);
            if telegram.send_message(message) {
                self.sent_live_settlement_slots.insert(slot_start);
                info!(
                    event = "live_settlement_summary_queued",
                    slot_start = %slot_start,
                    row_count = slot_rows.len(),
                    source = "polymarket_api",
                    "queued live settlement Telegram summary"
                );
            }
        }
    }

    pub(super) fn replace_markets(&mut self, markets: Vec<MonitoredMarket>) {
        let active_slugs = markets
            .iter()
            .map(|market| market.slug.clone())
            .collect::<HashSet<_>>();
        let active_asset_ids = markets
            .iter()
            .flat_map(MonitoredMarket::asset_ids)
            .collect::<HashSet<_>>();
        let active_condition_ids = markets
            .iter()
            .map(|market| market.condition_id.clone())
            .collect::<HashSet<_>>();

        self.markets_by_slug = markets
            .iter()
            .map(|market| (market.slug.clone(), market.clone()))
            .collect::<HashMap<_, _>>();
        self.markets_by_asset_id = markets
            .iter()
            .flat_map(|market| {
                market
                    .tokens
                    .iter()
                    .cloned()
                    .map(|token| (token.asset_id.clone(), (market.slug.clone(), token)))
            })
            .collect::<HashMap<_, _>>();

        self.slot_lines
            .retain(|slug, _| active_slugs.contains(slug));
        self.price_paths
            .retain(|slug, _| active_slugs.contains(slug));
        self.initial_books_seen
            .retain(|asset_id| active_asset_ids.contains(asset_id));
        self.resolved_markets.retain(|condition_id| {
            markets
                .iter()
                .any(|market| market.condition_id == *condition_id)
        });
        self.positioned_markets
            .retain(|condition_id| active_condition_ids.contains(condition_id));
        self.pending_markets
            .retain(|condition_id| active_condition_ids.contains(condition_id));
        self.failed_order_markets
            .retain(|condition_id| active_condition_ids.contains(condition_id));
        self.remote_exposure_markets
            .retain(|condition_id| active_condition_ids.contains(condition_id));
        self.books.retain_only(&active_asset_ids);
    }

    pub(super) fn apply_price_tick(&mut self, tick: PriceTick) {
        if let Some(previous) = self.latest_prices.get(&tick.asset).cloned() {
            for (slug, market) in &self.markets_by_slug {
                if market.asset != tick.asset {
                    continue;
                }
                if self.slot_lines.contains_key(slug) {
                    continue;
                }

                if previous.exchange_timestamp < market.slot.start()
                    && tick.exchange_timestamp >= market.slot.start()
                    && tick.exchange_timestamp < market.slot.end()
                {
                    self.slot_lines.insert(
                        slug.clone(),
                        SlotLine {
                            price: tick.value,
                            observed_at: tick.exchange_timestamp,
                        },
                    );
                    info!(
                        asset = %tick.asset,
                        slug,
                        line_price = %tick.value,
                        observed_at = %tick.exchange_timestamp,
                        "captured slot line"
                    );
                }
            }
        }

        self.record_market_price_paths(&tick);
        self.latest_prices.insert(tick.asset, tick);
        self.close_tracked_entries();
    }

    pub(super) fn apply_candle(&mut self, candle: Candle) {
        self.candle_store.upsert(candle.clone());
        debug!(
            source = %candle.source,
            asset = %candle.asset,
            start = %candle.start,
            open = %candle.open,
            high = %candle.high,
            low = %candle.low,
            close = %candle.close,
            volume = %candle.volume,
            received_at = %candle.received_at,
            "applied exchange candle"
        );
    }

    pub(super) fn record_market_price_paths(&mut self, tick: &PriceTick) {
        for (slug, market) in &self.markets_by_slug {
            if market.asset != tick.asset {
                continue;
            }
            if tick.exchange_timestamp < market.slot.start()
                || tick.exchange_timestamp >= market.slot.end()
            {
                continue;
            }

            let Some(line) = self.slot_lines.get(slug) else {
                continue;
            };

            self.price_paths.entry(slug.clone()).or_default().push(
                tick.exchange_timestamp,
                tick.value,
                line.price,
            );
        }
    }

    pub(super) fn apply_market_event(&mut self, event: MarketWsEvent) {
        match event {
            MarketWsEvent::Book(book) => {
                self.event_counts.books += 1;
                let token_context = self.token_context(&book.asset_id);
                let context_slug = token_context
                    .as_ref()
                    .map(|context| context.slug.to_string())
                    .unwrap_or_else(|| "unknown".to_string());
                let context_outcome = token_context
                    .as_ref()
                    .map(|context| context.token.outcome.clone());
                let book_state = self.books.book_mut(&book.asset_id);
                book_state.replace_snapshot(book.bids, book.asks, book.timestamp, book.hash);
                let (bid_depth, ask_depth) = book_state.depth();
                let is_initial_book = self.initial_books_seen.insert(book.asset_id.clone());

                if is_initial_book {
                    info!(
                        asset_id = book.asset_id,
                        market = book.market,
                        slug = context_slug,
                        outcome = ?context_outcome,
                        bid_depth,
                        ask_depth,
                        best_bid = ?book_state.best_bid().map(|level| level.price.to_string()),
                        best_ask = ?book_state.best_ask().map(|level| level.price.to_string()),
                        "initial book snapshot"
                    );
                } else {
                    debug!(
                        asset_id = book.asset_id,
                        market = book.market,
                        slug = context_slug,
                        outcome = ?context_outcome,
                        bid_depth,
                        ask_depth,
                        best_bid = ?book_state.best_bid().map(|level| level.price.to_string()),
                        best_ask = ?book_state.best_ask().map(|level| level.price.to_string()),
                        "book snapshot"
                    );
                }
            }
            MarketWsEvent::PriceChange(change) => {
                self.event_counts.price_changes += 1;
                for price_change in change.price_changes {
                    let book = self.books.book_mut(&price_change.asset_id);
                    book.apply_level(
                        price_change.side.book_side(),
                        price_change.price,
                        price_change.size,
                        change.timestamp,
                    );

                    debug!(
                        asset_id = price_change.asset_id,
                        market = change.market,
                        side = ?price_change.side,
                        price = %price_change.price,
                        size = %price_change.size,
                        best_bid = ?book.best_bid().map(|level| level.price.to_string()),
                        best_ask = ?book.best_ask().map(|level| level.price.to_string()),
                        "book level update"
                    );
                }
            }
            MarketWsEvent::BestBidAsk(bbo) => {
                self.event_counts.best_bid_ask += 1;
                let token_context = self.token_context(&bbo.asset_id);
                debug!(
                    asset_id = bbo.asset_id,
                    market = bbo.market,
                    slug = token_context.as_ref().map(|context| context.slug.as_str()).unwrap_or("unknown"),
                    outcome = ?token_context.as_ref().map(|context| &context.token.outcome),
                    best_bid = %bbo.best_bid,
                    best_ask = %bbo.best_ask,
                    spread = %bbo.spread,
                    timestamp = ?bbo.timestamp,
                    "best bid ask"
                );
            }
            MarketWsEvent::LastTradePrice(trade) => {
                self.event_counts.last_trade_price += 1;
                let token_context = self.token_context(&trade.asset_id);
                debug!(
                    asset_id = trade.asset_id,
                    market = trade.market,
                    slug = token_context.as_ref().map(|context| context.slug.as_str()).unwrap_or("unknown"),
                    outcome = ?token_context.as_ref().map(|context| &context.token.outcome),
                    price = %trade.price,
                    size = %trade.size,
                    side = ?trade.side,
                    timestamp = ?trade.timestamp,
                    "last trade"
                );
            }
            MarketWsEvent::TickSizeChange(tick) => {
                self.event_counts.tick_size_changes += 1;
                info!(
                    asset_id = tick.asset_id,
                    market = tick.market,
                    old_tick_size = %tick.old_tick_size,
                    new_tick_size = %tick.new_tick_size,
                    timestamp = ?tick.timestamp,
                    "tick size changed"
                );
            }
            MarketWsEvent::NewMarket(raw) => {
                self.event_counts.new_markets += 1;
                debug!(
                    slug = raw
                        .get("slug")
                        .and_then(|value| value.as_str())
                        .unwrap_or("unknown"),
                    "new market event"
                );
            }
            MarketWsEvent::MarketResolved(raw) => {
                self.event_counts.market_resolved += 1;
                let condition_id = raw.get("market").and_then(|value| value.as_str());
                if condition_id.is_some_and(|condition_id| self.is_watched_condition(condition_id))
                {
                    if let Some(condition_id) = condition_id {
                        self.resolved_markets.insert(condition_id.to_string());
                    }
                    info!(
                        slug = raw
                            .get("slug")
                            .and_then(|value| value.as_str())
                            .unwrap_or("unknown"),
                        winning_outcome = raw
                            .get("winning_outcome")
                            .and_then(|value| value.as_str())
                            .unwrap_or("unknown"),
                        "watched market resolved"
                    );
                } else {
                    debug!(
                        slug = raw
                            .get("slug")
                            .and_then(|value| value.as_str())
                            .unwrap_or("unknown"),
                        "unwatched market resolved"
                    );
                }
            }
            MarketWsEvent::Unknown { event_type, raw } => {
                self.event_counts.unknown += 1;
                debug!(event_type, raw = %raw, "unknown market websocket event");
            }
        }
    }

    pub(super) fn log_status(&self) {
        let now = Utc::now();
        for market in self.markets_by_slug.values() {
            if now < market.slot.start() || now >= market.slot.end() {
                continue;
            }

            let line = self.slot_lines.get(&market.slug);
            let latest_price = self.latest_prices.get(&market.asset);
            let distance_bps = self
                .latest_prices
                .get(&market.asset)
                .zip(line)
                .and_then(|(tick, line)| distance_bps(tick.value, line.price));

            let up_book = self.book_for_outcome(market, Outcome::Up);
            let down_book = self.book_for_outcome(market, Outcome::Down);

            info!(
                slug = market.slug,
                asset = %market.asset,
                seconds_to_end = (market.slot.end() - now).num_seconds(),
                latest_price = ?latest_price.map(|tick| tick.value.to_string()),
                line_price = ?line.map(|line| line.price.to_string()),
                line_observed_at = ?line.map(|line| line.observed_at),
                distance_bps = ?distance_bps.map(|value| value.round_dp(4).to_string()),
                up_bid = ?up_book.and_then(|book| book.best_bid()).map(|level| level.price.to_string()),
                up_ask = ?up_book.and_then(|book| book.best_ask()).map(|level| level.price.to_string()),
                down_bid = ?down_book.and_then(|book| book.best_bid()).map(|level| level.price.to_string()),
                down_ask = ?down_book.and_then(|book| book.best_ask()).map(|level| level.price.to_string()),
                books = self.event_counts.books,
                price_changes = self.event_counts.price_changes,
                bbo = self.event_counts.best_bid_ask,
                trades = self.event_counts.last_trade_price,
                "monitor status"
            );
        }
    }

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

    pub(super) fn token_for_outcome<'a>(
        &self,
        market: &'a MonitoredMarket,
        outcome: Outcome,
    ) -> Option<&'a OutcomeToken> {
        market.tokens.iter().find(|token| token.outcome == outcome)
    }

    pub(super) fn token_context(&self, asset_id: &str) -> Option<TokenContext<'_>> {
        let (slug, token) = self.markets_by_asset_id.get(asset_id)?;
        Some(TokenContext { slug, token })
    }

    pub(super) fn book_for_outcome(
        &self,
        market: &MonitoredMarket,
        outcome: Outcome,
    ) -> Option<&crate::domain::orderbook::TokenBook> {
        let token = market
            .tokens
            .iter()
            .find(|token| token.outcome == outcome)?;
        self.books.book(&token.asset_id)
    }

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

    pub(super) fn is_watched_condition(&self, condition_id: &str) -> bool {
        self.markets_by_slug
            .values()
            .any(|market| market.condition_id == condition_id)
    }
}
