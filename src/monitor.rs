use std::{
    collections::{HashMap, HashSet},
    future,
    time::Duration,
};

use anyhow::{Context, Result, bail};
use chrono::{DateTime, Utc};
use rust_decimal::{Decimal, prelude::ToPrimitive};
use tokio::{sync::mpsc, task::JoinHandle, time};
use tracing::{debug, info, warn};

use crate::{
    cli::MonitorArgs,
    config::RuntimeConfig,
    domain::{
        asset::{Asset, format_assets, normalize_assets},
        market::{MonitoredMarket, Outcome, OutcomeToken},
        orderbook::{OrderBookSet, PriceLevel, TokenBook},
        time::{MarketSlot, duration_from_seconds},
    },
    polymarket::{
        gamma::GammaClient,
        market_ws::{MarketWsEvent, run_market_feed},
        rtds::{PriceTick, run_price_feed},
    },
    runtime::{AssetRuntime, PriceHistory, RuntimeBundle, RuntimeCell, SideLeading},
    telegram::TelegramClient,
    trading::executor::{LiveOrderRequest, LiveTradeExecutor},
};

pub async fn run(args: MonitorArgs, config: RuntimeConfig) -> Result<()> {
    let duration = duration_from_seconds(args.slot_seconds)?;
    if duration.num_seconds() % 60 != 0 {
        bail!("slot_seconds must be divisible by 60 for Polymarket crypto up/down slugs");
    }

    let gamma = GammaClient::new(config.gamma_base_url.clone());
    let assets = normalize_assets(args.assets.clone());
    let runtime_bundle = RuntimeBundle::load(&args.runtime_bundle_dir).with_context(|| {
        format!(
            "load runtime bundle from {}",
            args.runtime_bundle_dir.display()
        )
    })?;
    let telegram = TelegramClient::from_config(&config);
    let live_executor = if config.live_trading {
        Some(LiveTradeExecutor::from_config(&config).await?)
    } else {
        None
    };

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
    let mut evaluation_interval = time::interval(config.evaluation_interval);
    refresh_interval.tick().await;
    status_interval.tick().await;
    evaluation_interval.tick().await;
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
        tradable_assets = format_assets(&config.tradable_assets),
        runtime_assets = format_assets(&runtime_bundle.assets()),
        runtime_bundle_dir = %args.runtime_bundle_dir.display(),
        runtime_manifest_version = runtime_bundle.manifest_version(),
        live_trading = config.live_trading,
        telegram_configured = telegram.is_configured(),
        slot_seconds = args.slot_seconds,
        price_feed = %args.price_feed,
        evaluation_interval_ms = duration_ms(config.evaluation_interval),
        "monitor started"
    );
    if telegram.is_configured() {
        telegram
            .send_message(&format!(
                "wiggler started: live_trading={} assets={} tradable={}",
                config.live_trading,
                format_assets(&assets),
                format_assets(&config.tradable_assets)
            ))
            .await
            .context("send Telegram startup message")?;
    }

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
            _ = evaluation_interval.tick() => {
                state.evaluate_and_maybe_execute(
                    &runtime_bundle,
                    &config,
                    live_executor.as_ref(),
                    &telegram,
                ).await;
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
    price_history: HashMap<Asset, PriceHistory>,
    slot_lines: HashMap<String, SlotLine>,
    positioned_markets: HashSet<String>,
    pending_markets: HashSet<String>,
    shadow_decision_markets: HashSet<String>,
    initial_books_seen: HashSet<String>,
    event_counts: EventCounts,
}

impl MonitorState {
    fn replace_markets(&mut self, markets: Vec<MonitoredMarket>) {
        let active_slugs = markets
            .iter()
            .map(|market| market.slug.clone())
            .collect::<HashSet<_>>();
        let active_asset_ids = markets
            .iter()
            .flat_map(MonitoredMarket::asset_ids)
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
        self.initial_books_seen
            .retain(|asset_id| active_asset_ids.contains(asset_id));
        self.books.retain_only(&active_asset_ids);
    }

    fn apply_price_tick(&mut self, tick: PriceTick) {
        self.price_history
            .entry(tick.asset)
            .or_default()
            .push(tick.exchange_timestamp, tick.value);

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

    async fn evaluate_and_maybe_execute(
        &mut self,
        runtime_bundle: &RuntimeBundle,
        config: &RuntimeConfig,
        live_executor: Option<&LiveTradeExecutor>,
        telegram: &TelegramClient,
    ) {
        let now = Utc::now();
        let markets = self.markets_by_slug.values().cloned().collect::<Vec<_>>();
        for market in &markets {
            if now < market.slot.start() || now >= market.slot.end() {
                continue;
            }

            let prepared = self.evaluate_trade(market, runtime_bundle, config, now, true);
            let Some(prepared) = prepared else {
                continue;
            };

            if config.live_trading {
                let Some(executor) = live_executor else {
                    warn!(slug = market.slug, "live trading enabled without executor");
                    continue;
                };
                self.execute_live_trade(market, runtime_bundle, config, executor, telegram)
                    .await;
            } else if self
                .shadow_decision_markets
                .insert(market.condition_id.clone())
                && let Err(error) = telegram.send_message(&prepared.telegram_text(false)).await
            {
                warn!(error = %error, slug = market.slug, "failed to send shadow trade Telegram message");
            }
        }
    }

    fn evaluate_trade(
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
        let best_ask = book.and_then(TokenBook::best_ask);
        let price_age_ms = latest_tick.map(|tick| age_ms(now, tick.received_at));
        let price_exchange_age_ms = latest_tick.map(|tick| age_ms(now, tick.exchange_timestamp));
        let book_age_ms = book.and_then(|book| book.last_timestamp.map(|ts| age_ms(now, ts)));
        let remaining_bucket = runtime.and_then(|runtime| runtime.remaining_bucket(remaining_sec));
        let vol_bps_per_sqrt_min = runtime.and_then(|runtime| {
            self.price_history
                .get(&market.asset)
                .and_then(|history| history.vol_bps_per_sqrt_min(now, runtime.vol_lookback_min()))
        });
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
        let edge_summary = runtime
            .zip(cell)
            .zip(book)
            .map(|((runtime, cell), book)| summarize_asks(runtime, cell, &book.asks()));
        let already_positioned = self.positioned_markets.contains(&market.condition_id)
            || self.pending_markets.contains(&market.condition_id);
        let skip_reason = self.trade_skip_reason(
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
            token,
            book,
            book_age_ms,
            vol_bps_per_sqrt_min,
            cell,
            best_ask.as_ref(),
            edge_summary.as_ref(),
            already_positioned,
            config,
        );
        let decision = if skip_reason.is_some() {
            "skip"
        } else if config.live_trading {
            "live_trade"
        } else {
            "shadow_trade"
        };

        if emit_log {
            info!(
                event = "trade_evaluation",
                asset = %market.asset,
                market_id = market.market_id,
                condition_id = market.condition_id,
                slug = market.slug,
                up_token_id = ?self.token_for_outcome(market, Outcome::Up).map(|token| token.asset_id.as_str()),
                down_token_id = ?self.token_for_outcome(market, Outcome::Down).map(|token| token.asset_id.as_str()),
                buy_token_id = ?token.map(|token| token.asset_id.as_str()),
                line_price = ?line.map(|line| line.price.to_string()),
                line_observed_at = ?line.map(|line| line.observed_at),
                current_price = ?latest_tick.map(|tick| tick.value.to_string()),
                current_received_at = ?latest_tick.map(|tick| tick.received_at),
                current_exchange_timestamp = ?latest_tick.map(|tick| tick.exchange_timestamp),
                price_age_ms = ?price_age_ms,
                price_exchange_age_ms = ?price_exchange_age_ms,
                orderbook_age_ms = ?book_age_ms,
                remaining_sec,
                remaining_bucket = ?remaining_bucket,
                d_bps = ?d_bps.map(|value| value.round_dp(6).to_string()),
                abs_d_bps = ?abs_d_bps.map(|value| value.round_dp(6).to_string()),
                side_leading = ?side_leading.map(SideLeading::as_str),
                vol_bps_per_sqrt_min = ?vol_bps_per_sqrt_min,
                vol_bin = ?vol_bin.map(|bin| bin.as_str()),
                cell_sample_count = ?cell.map(|cell| cell.sample_count),
                p_win_lower = ?cell.map(|cell| cell.p_win_lower),
                best_ask = ?best_ask.as_ref().map(|level| level.price.to_string()),
                best_ask_size = ?best_ask.as_ref().map(|level| level.size.to_string()),
                best_ask_fee = ?edge_summary.as_ref().and_then(|summary| summary.best_fee),
                best_ask_edge = ?edge_summary.as_ref().and_then(|summary| summary.best_edge),
                positive_ev_depth_shares = ?edge_summary.as_ref().map(|summary| summary.positive_ev_depth_shares),
                positive_ev_depth_usdc = ?edge_summary.as_ref().map(|summary| summary.positive_ev_depth_usdc),
                max_acceptable_price = ?edge_summary.as_ref().and_then(|summary| summary.max_acceptable_price),
                min_edge_probability = ?runtime.map(AssetRuntime::min_edge_probability),
                min_order_usdc = config.min_order_usdc,
                max_position_usdc = ?runtime.map(AssetRuntime::max_position_usdc),
                max_order_usdc = config.max_order_usdc,
                already_positioned,
                decision,
                skip_reason = ?skip_reason,
                live_trading = config.live_trading,
                config_hash = ?runtime.map(AssetRuntime::runtime_config_hash),
                source_config_hash = ?runtime.map(AssetRuntime::source_config_hash),
                input_hash = ?runtime.map(AssetRuntime::training_input_hash),
                "trade evaluation"
            );
        }

        if skip_reason.is_some() {
            return None;
        }

        let runtime = runtime?;
        let token = token?;
        let edge_summary = edge_summary.as_ref()?;
        let max_price = edge_summary.max_acceptable_price?;
        let amount_usdc = edge_summary
            .positive_ev_depth_usdc
            .min(runtime.max_position_usdc())
            .min(config.max_order_usdc);
        if amount_usdc < config.min_order_usdc {
            return None;
        }

        Some(PreparedTrade {
            asset: market.asset,
            slug: market.slug.clone(),
            condition_id: market.condition_id.clone(),
            token_id: token.asset_id.clone(),
            outcome: token.outcome.clone(),
            amount_usdc,
            max_price,
            remaining_sec,
            d_bps: d_bps.map(|value| value.round_dp(6).to_string()),
            p_win_lower: cell.map(|cell| cell.p_win_lower),
            best_edge: edge_summary.best_edge,
        })
    }

    async fn execute_live_trade(
        &mut self,
        market: &MonitoredMarket,
        runtime_bundle: &RuntimeBundle,
        config: &RuntimeConfig,
        executor: &LiveTradeExecutor,
        telegram: &TelegramClient,
    ) {
        if self.pending_markets.contains(&market.condition_id)
            || self.positioned_markets.contains(&market.condition_id)
        {
            return;
        }

        match executor.has_market_exposure(&market.condition_id).await {
            Ok(true) => {
                self.positioned_markets.insert(market.condition_id.clone());
                info!(
                    event = "live_execution_skipped",
                    slug = market.slug,
                    condition_id = market.condition_id,
                    skip_reason = "remote_market_exposure",
                    "live execution skipped"
                );
                return;
            }
            Ok(false) => {}
            Err(error) => {
                warn!(error = %error, slug = market.slug, "failed to reconcile market exposure");
                return;
            }
        }

        let Some(prepared) = self.evaluate_trade(market, runtime_bundle, config, Utc::now(), false)
        else {
            info!(
                event = "live_execution_skipped",
                slug = market.slug,
                condition_id = market.condition_id,
                skip_reason = "pre_submit_recompute_failed",
                "live execution skipped"
            );
            return;
        };

        self.pending_markets.insert(market.condition_id.clone());
        if let Err(error) = telegram.send_message(&prepared.telegram_text(true)).await {
            warn!(error = %error, slug = market.slug, "failed to send live intent Telegram message");
        }

        let request = LiveOrderRequest {
            asset: prepared.asset,
            slug: prepared.slug.clone(),
            condition_id: prepared.condition_id.clone(),
            token_id: prepared.token_id.clone(),
            outcome: prepared.outcome.clone(),
            amount_usdc: prepared.amount_usdc,
            max_price: prepared.max_price,
        };
        let result = executor.execute(&request).await;
        self.pending_markets.remove(&market.condition_id);

        match result {
            Ok(response) => {
                if response.success {
                    self.positioned_markets.insert(market.condition_id.clone());
                }
                info!(
                    event = "live_order_response",
                    slug = market.slug,
                    condition_id = market.condition_id,
                    token_id = request.token_id,
                    outcome = ?request.outcome,
                    amount_usdc = request.amount_usdc,
                    max_price = request.max_price,
                    order_id = response.order_id,
                    status = response.status,
                    success = response.success,
                    error_msg = ?response.error_msg,
                    making_amount = response.making_amount,
                    taking_amount = response.taking_amount,
                    trade_ids = ?response.trade_ids,
                    "live order response"
                );
                if let Err(error) = telegram
                    .send_message(&format!(
                        "LIVE order response {}/{} status={} success={} order={} fills={}",
                        request.asset,
                        request.outcome_label(),
                        response.status,
                        response.success,
                        response.order_id,
                        response.trade_ids.len()
                    ))
                    .await
                {
                    warn!(error = %error, slug = market.slug, "failed to send live response Telegram message");
                }
            }
            Err(error) => {
                warn!(
                    event = "live_order_error",
                    slug = market.slug,
                    condition_id = market.condition_id,
                    error = %error,
                    "live order failed"
                );
                if let Err(telegram_error) = telegram
                    .send_message(&format!(
                        "LIVE order failed {}/{}: {}",
                        request.asset,
                        request.outcome_label(),
                        error
                    ))
                    .await
                {
                    warn!(error = %telegram_error, slug = market.slug, "failed to send live error Telegram message");
                }
            }
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn trade_skip_reason(
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
        token: Option<&OutcomeToken>,
        book: Option<&TokenBook>,
        book_age_ms: Option<i64>,
        vol_bps_per_sqrt_min: Option<f64>,
        cell: Option<&RuntimeCell>,
        best_ask: Option<&PriceLevel>,
        edge_summary: Option<&EdgeSummary>,
        already_positioned: bool,
        config: &RuntimeConfig,
    ) -> Option<&'static str> {
        if !config.tradable_assets.contains(&asset) {
            return Some("asset_not_in_tradable_whitelist");
        }
        let Some(runtime) = runtime else {
            return Some("asset_not_in_runtime_bundle");
        };
        if remaining_sec < runtime.min_remaining_sec_to_trade() {
            return Some("remaining_sec_below_min");
        }
        if remaining_sec > runtime.max_remaining_sec_to_trade() {
            return Some("remaining_sec_above_max");
        }
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
        if best_ask.is_none() {
            return Some("order_book_missing_asks");
        }
        if edge_summary.is_none_or(|summary| summary.positive_ev_depth_shares <= 0.0) {
            return Some("no_positive_ev_depth");
        }
        if edge_summary
            .and_then(|summary| summary.max_acceptable_price)
            .is_none()
        {
            return Some("missing_max_acceptable_price");
        }
        if edge_summary.is_some_and(|summary| {
            summary
                .positive_ev_depth_usdc
                .min(runtime.max_position_usdc())
                .min(config.max_order_usdc)
                < config.min_order_usdc
        }) {
            return Some("order_size_below_min");
        }

        None
    }

    fn token_for_outcome<'a>(
        &self,
        market: &'a MonitoredMarket,
        outcome: Outcome,
    ) -> Option<&'a OutcomeToken> {
        market.tokens.iter().find(|token| token.outcome == outcome)
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

#[derive(Clone, Debug)]
struct PreparedTrade {
    asset: Asset,
    slug: String,
    condition_id: String,
    token_id: String,
    outcome: Outcome,
    amount_usdc: f64,
    max_price: f64,
    remaining_sec: i64,
    d_bps: Option<String>,
    p_win_lower: Option<f64>,
    best_edge: Option<f64>,
}

impl PreparedTrade {
    fn telegram_text(&self, live: bool) -> String {
        let mode = if live {
            "LIVE intent"
        } else {
            "SHADOW decision"
        };
        format!(
            "{} {} {} amount=${:.2} max_price={:.2} remaining={}s d_bps={} p_win_lower={} edge={} {}",
            mode,
            self.asset,
            outcome_label(&self.outcome),
            self.amount_usdc,
            self.max_price,
            self.remaining_sec,
            self.d_bps.as_deref().unwrap_or("n/a"),
            self.p_win_lower
                .map(|value| format!("{value:.4}"))
                .unwrap_or_else(|| "n/a".to_string()),
            self.best_edge
                .map(|value| format!("{value:.4}"))
                .unwrap_or_else(|| "n/a".to_string()),
            self.slug
        )
    }
}

fn outcome_label(outcome: &Outcome) -> &'static str {
    match outcome {
        Outcome::Up => "Up",
        Outcome::Down => "Down",
        Outcome::Other(_) => "Other",
    }
}

fn distance_bps(price: Decimal, line: Decimal) -> Option<Decimal> {
    if line.is_zero() {
        return None;
    }

    Some(((price - line) / line) * Decimal::from(10_000))
}

fn decimal_abs(value: Decimal) -> Decimal {
    if value < Decimal::ZERO { -value } else { value }
}

fn side_for_distance(value: Decimal) -> Option<SideLeading> {
    if value > Decimal::ZERO {
        Some(SideLeading::UpLeading)
    } else if value < Decimal::ZERO {
        Some(SideLeading::DownLeading)
    } else {
        None
    }
}

fn outcome_for_side(side: SideLeading) -> Outcome {
    match side {
        SideLeading::UpLeading => Outcome::Up,
        SideLeading::DownLeading => Outcome::Down,
    }
}

fn age_ms(now: DateTime<Utc>, timestamp: DateTime<Utc>) -> i64 {
    (now - timestamp).num_milliseconds().max(0)
}

fn duration_ms(duration: Duration) -> i64 {
    duration.as_millis().try_into().unwrap_or(i64::MAX)
}

#[derive(Clone, Debug, Default)]
struct EdgeSummary {
    best_fee: Option<f64>,
    best_edge: Option<f64>,
    positive_ev_depth_shares: f64,
    positive_ev_depth_usdc: f64,
    max_acceptable_price: Option<f64>,
}

fn summarize_asks(runtime: &AssetRuntime, cell: &RuntimeCell, asks: &[PriceLevel]) -> EdgeSummary {
    let mut summary = EdgeSummary::default();

    for (index, level) in asks.iter().enumerate() {
        let Some(ask) = level.price.to_f64() else {
            break;
        };
        let Some(size) = level.size.to_f64() else {
            break;
        };

        let fee = runtime.fee_rate() * ask * (1.0 - ask);
        let edge = cell.p_win_lower - (ask + fee);
        if index == 0 {
            summary.best_fee = Some(fee);
            summary.best_edge = Some(edge);
        }

        if edge < runtime.min_edge_probability() {
            break;
        }

        summary.positive_ev_depth_shares += size;
        summary.positive_ev_depth_usdc += size * ask;
        summary.max_acceptable_price = Some(ask);
    }

    summary
}

#[cfg(test)]
mod tests {
    use chrono::{TimeDelta, TimeZone, Utc};
    use rust_decimal::Decimal;

    use crate::{
        domain::{
            asset::Asset,
            market::{MonitoredMarket, Outcome, OutcomeToken},
            orderbook::PriceLevel,
            time::MarketSlot,
        },
        polymarket::rtds::{PriceFeedSource, PriceTick},
        runtime::{RuntimeBundle, SideLeading, VolBin},
    };

    use super::{MonitorState, asset_ids_for_markets, distance_bps, summarize_asks};

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

    #[test]
    fn executable_depth_uses_p_win_lower_against_ask_levels() {
        let bundle = RuntimeBundle::load(
            std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("runtime/wiggler-prod-v1"),
        )
        .unwrap();
        let runtime = bundle.config_for(Asset::Btc).unwrap();
        let cell = runtime
            .find_cell(60, VolBin::Low, SideLeading::UpLeading, 2.5)
            .unwrap();

        let summary = summarize_asks(
            runtime,
            cell,
            &[
                PriceLevel {
                    price: Decimal::new(80, 2),
                    size: Decimal::new(10, 0),
                },
                PriceLevel {
                    price: Decimal::new(84, 2),
                    size: Decimal::new(20, 0),
                },
                PriceLevel {
                    price: Decimal::new(86, 2),
                    size: Decimal::new(30, 0),
                },
            ],
        );

        assert!((summary.best_fee.unwrap() - 0.01152).abs() < 0.000001);
        assert!(summary.best_edge.unwrap() > runtime.min_edge_probability());
        assert_eq!(summary.positive_ev_depth_shares, 30.0);
        assert_eq!(summary.max_acceptable_price, Some(0.84));
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
