use std::collections::{HashMap, HashSet};

use anyhow::Result;
use chrono::{DateTime, Utc};
use rust_decimal::Decimal;
use tracing::{debug, info, warn};

use crate::{
    domain::{
        asset::Asset,
        market::{MonitoredMarket, Outcome, OutcomeToken},
        orderbook::OrderBookSet,
    },
    exchange_candles::{Candle, CandleStore},
    polymarket::{market_ws::MarketWsEvent, rtds::PriceTick},
    trade_analysis::ApiClosedPositionPnlRows,
};

use super::path::MarketPricePath;
use super::{
    EventCounts, TelegramOutbox, TokenContext, TrackedEntry, closed_position_outcome_label,
    closed_position_row_from_api_position, closed_position_ticker, closed_position_totals,
    closed_rows_for_slot, distance_bps, live_settlement_summary_text,
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

    pub(super) fn is_watched_condition(&self, condition_id: &str) -> bool {
        self.markets_by_slug
            .values()
            .any(|market| market.condition_id == condition_id)
    }
}
