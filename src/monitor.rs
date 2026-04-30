use std::{
    collections::{HashMap, HashSet},
    future,
    time::Duration,
};

use anyhow::{Context, Result, bail};
use chrono::{DateTime, Utc};
use rust_decimal::Decimal;
use tokio::{sync::mpsc, task::JoinHandle, time};
use tracing::{debug, info, warn};

use crate::{
    cli::MonitorArgs,
    config::RuntimeConfig,
    domain::{
        asset::{Asset, format_assets, normalize_assets},
        market::{MonitoredMarket, Outcome, OutcomeToken},
        orderbook::OrderBookSet,
        time::{MarketSlot, duration_from_seconds},
    },
    polymarket::{
        gamma::GammaClient,
        market_ws::{MarketWsEvent, run_market_feed},
        rtds::{PriceTick, run_price_feed},
    },
};

pub async fn run(args: MonitorArgs, config: RuntimeConfig) -> Result<()> {
    let duration = duration_from_seconds(args.slot_seconds)?;
    if duration.num_seconds() % 60 != 0 {
        bail!("slot_seconds must be divisible by 60 for Polymarket crypto up/down slugs");
    }

    let gamma = GammaClient::new(config.gamma_base_url.clone());
    let assets = normalize_assets(args.assets.clone());
    let watchset_config = WatchsetConfig {
        ws_endpoint: config.clob_market_ws_url.clone(),
        assets: assets.clone(),
        duration,
        lookahead_slots: args.lookahead_slots,
    };
    let mut state = MonitorState::default();
    let (price_tx, mut price_rx) = mpsc::channel::<PriceTick>(1024);
    let (market_tx, mut market_rx) = mpsc::channel::<MarketWsEvent>(4096);

    let price_handles = assets
        .iter()
        .map(|asset| {
            tokio::spawn(run_price_feed(
                config.rtds_ws_url.clone(),
                *asset,
                args.price_feed,
                price_tx.clone(),
            ))
        })
        .collect::<Vec<_>>();

    let mut market_handle: Option<JoinHandle<()>> = None;
    let mut subscribed_asset_ids = Vec::<String>::new();
    let mut refresh_interval = time::interval(Duration::from_secs(10));
    let mut status_interval = time::interval(Duration::from_secs(15));
    refresh_interval.tick().await;
    status_interval.tick().await;
    let deadline = args
        .max_runtime_seconds
        .map(|seconds| time::Instant::now() + Duration::from_secs(seconds));

    refresh_watchset(
        &gamma,
        &watchset_config,
        &mut state,
        &mut subscribed_asset_ids,
        &mut market_handle,
        market_tx.clone(),
    )
    .await?;

    info!(
        assets = format_assets(&assets),
        slot_seconds = args.slot_seconds,
        price_feed = %args.price_feed,
        "monitor started"
    );

    loop {
        tokio::select! {
            _ = sleep_until(deadline), if deadline.is_some() => {
                info!("max runtime reached; stopping monitor");
                break;
            }
            signal = tokio::signal::ctrl_c() => {
                signal.context("listen for ctrl-c")?;
                info!("received ctrl-c; stopping monitor");
                break;
            }
            _ = refresh_interval.tick() => {
                if let Err(error) = refresh_watchset(
                    &gamma,
                    &watchset_config,
                    &mut state,
                    &mut subscribed_asset_ids,
                    &mut market_handle,
                    market_tx.clone(),
                ).await {
                    warn!(error = %error, "watchset refresh failed");
                }
            }
            _ = status_interval.tick() => {
                state.log_status();
            }
            Some(tick) = price_rx.recv() => {
                state.apply_price_tick(tick);
            }
            Some(event) = market_rx.recv() => {
                state.apply_market_event(event);
            }
        }
    }

    for handle in price_handles {
        handle.abort();
    }
    if let Some(handle) = market_handle {
        handle.abort();
    }

    Ok(())
}

async fn refresh_watchset(
    gamma: &GammaClient,
    config: &WatchsetConfig,
    state: &mut MonitorState,
    subscribed_asset_ids: &mut Vec<String>,
    market_handle: &mut Option<JoinHandle<()>>,
    market_tx: mpsc::Sender<MarketWsEvent>,
) -> Result<()> {
    let markets = fetch_watchset(
        gamma,
        &config.assets,
        config.duration,
        config.lookahead_slots,
    )
    .await?;
    state.replace_markets(markets.clone());

    let next_asset_ids = asset_ids_for_markets(&markets);
    if *subscribed_asset_ids == next_asset_ids {
        return Ok(());
    }

    if let Some(handle) = market_handle.take() {
        handle.abort();
    }

    *subscribed_asset_ids = next_asset_ids.clone();
    if next_asset_ids.is_empty() {
        warn!("no Polymarket token ids discovered for watchset");
        return Ok(());
    }

    info!(
        asset_count = next_asset_ids.len(),
        market_count = markets.len(),
        "refreshing market websocket subscription"
    );
    *market_handle = Some(tokio::spawn(run_market_feed(
        config.ws_endpoint.clone(),
        next_asset_ids,
        market_tx,
    )));

    Ok(())
}

async fn fetch_watchset(
    gamma: &GammaClient,
    assets: &[Asset],
    duration: chrono::TimeDelta,
    lookahead_slots: u32,
) -> Result<Vec<MonitoredMarket>> {
    let current_slot = MarketSlot::current(Utc::now(), duration)?;
    let mut markets = Vec::new();

    for asset in assets {
        for offset in 0..=lookahead_slots {
            let slot = current_slot.offset(i64::from(offset))?;
            match gamma.fetch_slot_market(*asset, &slot).await {
                Ok(Some(market)) => {
                    debug!(
                        asset = %asset,
                        slug = market.slug,
                        start = %market.slot.start(),
                        end = %market.slot.end(),
                        token_count = market.tokens.len(),
                        "discovered market"
                    );
                    markets.push(market);
                }
                Ok(None) => {
                    let slug = slot.slug(*asset)?;
                    debug!(asset = %asset, slug, "market not yet available");
                }
                Err(error) => {
                    let slug = slot.slug(*asset)?;
                    warn!(asset = %asset, slug, error = %error, "failed to fetch market");
                }
            }
        }
    }

    Ok(markets)
}

#[derive(Clone)]
struct WatchsetConfig {
    ws_endpoint: String,
    assets: Vec<Asset>,
    duration: chrono::TimeDelta,
    lookahead_slots: u32,
}

fn asset_ids_for_markets(markets: &[MonitoredMarket]) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut asset_ids = markets
        .iter()
        .flat_map(MonitoredMarket::asset_ids)
        .filter(|asset_id| seen.insert(asset_id.clone()))
        .collect::<Vec<_>>();
    asset_ids.sort();
    asset_ids
}

async fn sleep_until(deadline: Option<time::Instant>) {
    if let Some(deadline) = deadline {
        time::sleep_until(deadline).await;
    } else {
        future::pending::<()>().await;
    }
}

#[derive(Clone, Debug)]
struct SlotLine {
    price: Decimal,
    observed_at: DateTime<Utc>,
}

#[derive(Default)]
struct MonitorState {
    markets_by_slug: HashMap<String, MonitoredMarket>,
    markets_by_asset_id: HashMap<String, (String, OutcomeToken)>,
    books: OrderBookSet,
    latest_prices: HashMap<Asset, PriceTick>,
    slot_lines: HashMap<String, SlotLine>,
    initial_books_seen: HashSet<String>,
    event_counts: EventCounts,
}

impl MonitorState {
    fn replace_markets(&mut self, markets: Vec<MonitoredMarket>) {
        let active_slugs = markets
            .iter()
            .map(|market| market.slug.clone())
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
    }

    fn apply_price_tick(&mut self, tick: PriceTick) {
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

        self.latest_prices.insert(tick.asset, tick);
    }

    fn apply_market_event(&mut self, event: MarketWsEvent) {
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

    fn log_status(&self) {
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

    fn token_context(&self, asset_id: &str) -> Option<TokenContext<'_>> {
        let (slug, token) = self.markets_by_asset_id.get(asset_id)?;
        Some(TokenContext { slug, token })
    }

    fn book_for_outcome(
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

    fn is_watched_condition(&self, condition_id: &str) -> bool {
        self.markets_by_slug
            .values()
            .any(|market| market.condition_id == condition_id)
    }
}

#[derive(Default)]
struct EventCounts {
    books: u64,
    price_changes: u64,
    best_bid_ask: u64,
    last_trade_price: u64,
    tick_size_changes: u64,
    new_markets: u64,
    market_resolved: u64,
    unknown: u64,
}

struct TokenContext<'a> {
    slug: &'a String,
    token: &'a OutcomeToken,
}

fn distance_bps(price: Decimal, line: Decimal) -> Option<Decimal> {
    if line.is_zero() {
        return None;
    }

    Some(((price - line) / line) * Decimal::from(10_000))
}

#[cfg(test)]
mod tests {
    use chrono::{TimeDelta, TimeZone, Utc};
    use rust_decimal::Decimal;

    use crate::{
        domain::{
            asset::Asset,
            market::{MonitoredMarket, Outcome, OutcomeToken},
            time::MarketSlot,
        },
        polymarket::rtds::{PriceFeedSource, PriceTick},
    };

    use super::{MonitorState, asset_ids_for_markets, distance_bps};

    #[test]
    fn asset_ids_are_sorted_and_deduped() {
        let market = market_with_tokens(vec!["2", "1", "2"]);
        assert_eq!(asset_ids_for_markets(&[market]), vec!["1", "2"]);
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
}
