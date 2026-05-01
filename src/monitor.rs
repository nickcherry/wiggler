use std::{
    collections::{HashMap, HashSet, VecDeque},
    fs, future,
    path::{Path, PathBuf},
    time::Duration,
};

use anyhow::{Context, Result, bail};
use chrono::{DateTime, TimeDelta, Utc};
use rust_decimal::{Decimal, prelude::ToPrimitive};
use serde::Deserialize;
use serde_json::{Value, json};
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
    trading::executor::{LiveOrderRequest, LiveOrderResponse, LiveTradeExecutor},
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
    let account_pnl = AccountPnlClient::from_config(&config);
    let live_executor = if config.live_trading {
        match LiveTradeExecutor::from_config(&config).await {
            Ok(executor) => Some(executor),
            Err(error) => {
                let error_chain = format!("{error:#}");
                warn!(
                    event = "live_trading_startup_error",
                    error = %error_chain,
                    "live trading startup failed"
                );
                if let Err(telegram_error) = telegram
                    .send_message(&live_startup_error_text(&error_chain))
                    .await
                {
                    warn!(
                        error = %telegram_error,
                        "failed to send live startup error Telegram message"
                    );
                }
                return Err(error.context("initialize live trading executor"));
            }
        }
    } else {
        None
    };

    let watchset_config = WatchsetConfig {
        ws_endpoint: config.clob_market_ws_url.clone(),
        assets: assets.clone(),
        duration,
        lookahead_slots: args.lookahead_slots,
    };
    let mut state = MonitorState::from_trade_records(&config.trade_record_dir);
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
    let mut settlement_interval = telegram_settlement_interval(&telegram);
    refresh_interval.tick().await;
    status_interval.tick().await;
    evaluation_interval.tick().await;
    if let Some(interval) = settlement_interval.as_mut() {
        interval.tick().await;
    }
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
        log_evaluations = config.log_evaluations,
        "monitor started"
    );
    if telegram.is_configured() && !config.live_trading {
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
            _ = optional_interval_tick(&mut settlement_interval) => {
                state.send_live_settlement_summaries(
                    &account_pnl,
                    &telegram,
                    duration,
                ).await;
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

fn telegram_settlement_interval(telegram: &TelegramClient) -> Option<time::Interval> {
    if !telegram.is_configured() {
        return None;
    }

    Some(time::interval(Duration::from_secs(
        LIVE_SETTLEMENT_POLL_SECONDS,
    )))
}

async fn optional_interval_tick(interval: &mut Option<time::Interval>) {
    if let Some(interval) = interval {
        interval.tick().await;
    } else {
        future::pending::<()>().await;
    }
}

#[derive(Clone, Debug)]
struct SlotLine {
    price: Decimal,
    observed_at: DateTime<Utc>,
}

#[derive(Clone)]
struct AccountPnlClient {
    http: reqwest::Client,
    data_api_base_url: String,
    user: Option<String>,
}

impl AccountPnlClient {
    fn from_config(config: &RuntimeConfig) -> Self {
        Self {
            http: reqwest::Client::builder()
                .user_agent("wiggler/1.0 account-pnl")
                .build()
                .unwrap_or_else(|_| reqwest::Client::new()),
            data_api_base_url: config.data_api_base_url.trim_end_matches('/').to_string(),
            user: config
                .polymarket_funder_address
                .as_ref()
                .map(|address| address.to_ascii_lowercase()),
        }
    }

    async fn fetch_recent_closed_positions(&self) -> Option<Vec<ClosedPositionPnlRow>> {
        let Some(user) = self.user.as_deref() else {
            return None;
        };
        match self.fetch_closed_position_rows(user, 500).await {
            Some(rows) => Some(rows),
            None => {
                warn!(
                    user,
                    "failed to fetch Polymarket recent closed positions for Telegram summary"
                );
                None
            }
        }
    }

    async fn fetch_closed_position_rows(
        &self,
        user: &str,
        max_rows: usize,
    ) -> Option<Vec<ClosedPositionPnlRow>> {
        let closed_url = format!("{}/closed-positions", self.data_api_base_url);
        let limit = 50usize;
        let mut all_rows = Vec::new();

        for offset in (0..=max_rows).step_by(limit) {
            let response = match self
                .http
                .get(&closed_url)
                .query(&[
                    ("user", user),
                    ("limit", &limit.to_string()),
                    ("offset", &offset.to_string()),
                    ("sortBy", "TIMESTAMP"),
                    ("sortDirection", "DESC"),
                ])
                .send()
                .await
                .and_then(reqwest::Response::error_for_status)
            {
                Ok(response) => response,
                Err(error) => {
                    warn!(
                        error = %error,
                        "failed to fetch Polymarket closed position counts"
                    );
                    return None;
                }
            };
            let rows = match response.json::<Vec<ClosedPositionPnlRow>>().await {
                Ok(rows) => rows,
                Err(error) => {
                    warn!(
                        error = %error,
                        "failed to parse Polymarket closed position counts"
                    );
                    return None;
                }
            };

            let done = rows.len() < limit;
            all_rows.extend(rows);
            if done {
                return Some(all_rows);
            }
        }

        Some(all_rows)
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClosedPositionPnlRow {
    realized_pnl: Option<f64>,
    slug: Option<String>,
    event_slug: Option<String>,
    title: Option<String>,
    outcome: Option<String>,
}

fn live_settlement_candidate_slots(now: DateTime<Utc>, duration: TimeDelta) -> Vec<DateTime<Utc>> {
    let Ok(current_slot) = MarketSlot::current(now, duration) else {
        return Vec::new();
    };

    (1..=LIVE_SETTLEMENT_LOOKBACK_SLOTS)
        .filter_map(|offset| {
            let slot = current_slot.offset(-(offset as i64)).ok()?;
            let delay = TimeDelta::try_seconds(LIVE_SETTLEMENT_DELAY_SECONDS as i64)?;
            let ready_at = slot.end() + delay;
            (now >= ready_at).then_some(slot.start())
        })
        .rev()
        .collect()
}

fn live_settlement_summary_text(rows: &[ClosedPositionPnlRow]) -> String {
    let mut wins = 0u64;
    let mut losses = 0u64;
    let mut total_pnl = 0.0;
    let mut lines = Vec::new();

    for row in rows {
        let pnl = row.realized_pnl.unwrap_or(0.0);
        total_pnl += pnl;
        let won = pnl > 0.0;
        if won {
            wins += 1;
        } else {
            losses += 1;
        }
        lines.push(format!(
            "{} {} {} {}",
            closed_position_ticker(row),
            closed_position_outcome_arrow(row),
            if won { "won" } else { "lost" },
            format_signed_usdc(pnl)
        ));
    }

    let total = wins + losses;
    let win_pct = if total > 0 {
        (wins as f64 / total as f64) * 100.0
    } else {
        0.0
    };
    let loss_pct = if total > 0 {
        (losses as f64 / total as f64) * 100.0
    } else {
        0.0
    };

    lines.push(String::new());
    lines.push(format!(
        "Total wins: {} ({})",
        format_whole_number(wins),
        format_percent(win_pct)
    ));
    lines.push(format!(
        "Total losses: {} ({})",
        format_whole_number(losses),
        format_percent(loss_pct)
    ));
    lines.push(String::new());
    lines.push(format!("Total PnL: {}", format_signed_usdc(total_pnl)));
    lines.join("\n")
}

fn closed_position_slot_start(row: &ClosedPositionPnlRow) -> Option<DateTime<Utc>> {
    row.slug
        .as_deref()
        .or(row.event_slug.as_deref())
        .and_then(slot_start_from_market_slug)
}

fn slot_start_from_market_slug(slug: &str) -> Option<DateTime<Utc>> {
    let timestamp = slug.rsplit('-').next()?.parse::<i64>().ok()?;
    DateTime::from_timestamp(timestamp, 0)
}

fn closed_position_ticker(row: &ClosedPositionPnlRow) -> String {
    row.slug
        .as_deref()
        .or(row.event_slug.as_deref())
        .and_then(|slug| slug.split('-').next())
        .map(|ticker| ticker.to_ascii_uppercase())
        .or_else(|| ticker_from_title(row.title.as_deref()?))
        .unwrap_or_else(|| "UNKNOWN".to_string())
}

fn ticker_from_title(title: &str) -> Option<String> {
    let lower = title.to_ascii_lowercase();
    if lower.starts_with("bitcoin ") {
        Some("BTC".to_string())
    } else if lower.starts_with("ethereum ") {
        Some("ETH".to_string())
    } else if lower.starts_with("solana ") {
        Some("SOL".to_string())
    } else if lower.starts_with("xrp ") {
        Some("XRP".to_string())
    } else if lower.starts_with("dogecoin ") {
        Some("DOGE".to_string())
    } else {
        None
    }
}

fn closed_position_outcome_label(row: &ClosedPositionPnlRow) -> &'static str {
    match row
        .outcome
        .as_deref()
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("up") => "up",
        Some("down") => "down",
        _ => "other",
    }
}

fn closed_position_outcome_arrow(row: &ClosedPositionPnlRow) -> &'static str {
    match closed_position_outcome_label(row) {
        "up" => "↑",
        "down" => "↓",
        _ => "?",
    }
}

#[derive(Default)]
struct MonitorState {
    markets_by_slug: HashMap<String, MonitoredMarket>,
    markets_by_asset_id: HashMap<String, (String, OutcomeToken)>,
    books: OrderBookSet,
    latest_prices: HashMap<Asset, PriceTick>,
    price_history: HashMap<Asset, PriceHistory>,
    price_paths: HashMap<String, MarketPricePath>,
    slot_lines: HashMap<String, SlotLine>,
    positioned_markets: HashSet<String>,
    pending_markets: HashSet<String>,
    failed_order_markets: HashSet<String>,
    retryable_no_fill_cooldown_until: HashMap<String, DateTime<Utc>>,
    shadow_decision_markets: HashSet<String>,
    tracked_entries: HashMap<String, TrackedEntry>,
    resolved_markets: HashSet<String>,
    initial_books_seen: HashSet<String>,
    live_pre_submit_error_cooldown_until: Option<DateTime<Utc>>,
    event_counts: EventCounts,
    sent_live_settlement_slots: HashSet<DateTime<Utc>>,
}

impl MonitorState {
    fn from_trade_records(_trade_record_dir: &Path) -> Self {
        Self::default()
    }

    async fn send_live_settlement_summaries(
        &mut self,
        account_pnl: &AccountPnlClient,
        telegram: &TelegramClient,
        duration: TimeDelta,
    ) {
        if !telegram.is_configured() {
            return;
        }

        let candidate_slots = live_settlement_candidate_slots(Utc::now(), duration);
        let unsent_slots = candidate_slots
            .into_iter()
            .filter(|slot_start| !self.sent_live_settlement_slots.contains(slot_start))
            .collect::<Vec<_>>();
        if unsent_slots.is_empty() {
            return;
        }

        let Some(rows) = account_pnl.fetch_recent_closed_positions().await else {
            return;
        };

        for slot_start in unsent_slots {
            let mut slot_rows = rows
                .iter()
                .filter(|row| closed_position_slot_start(row) == Some(slot_start))
                .cloned()
                .collect::<Vec<_>>();
            if slot_rows.is_empty() {
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

            let message = live_settlement_summary_text(&slot_rows);
            match telegram.send_message(&message).await {
                Ok(()) => {
                    self.sent_live_settlement_slots.insert(slot_start);
                }
                Err(error) => {
                    warn!(
                        error = %error,
                        slot_start = %slot_start,
                        "failed to send live settlement Telegram summary"
                    );
                }
            }
        }
    }

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
        self.price_paths
            .retain(|slug, _| active_slugs.contains(slug));
        self.resolved_markets.retain(|condition_id| {
            markets
                .iter()
                .any(|market| market.condition_id == *condition_id)
        });
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

        self.record_market_price_paths(&tick);
        self.latest_prices.insert(tick.asset, tick);
        self.close_tracked_entries();
    }

    fn record_market_price_paths(&mut self, tick: &PriceTick) {
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
                if let Err(error) = telegram
                    .send_message(&prepared.telegram_text(TradeMode::Shadow))
                    .await
                {
                    warn!(error = %error, slug = market.slug, "failed to send shadow trade Telegram message");
                }
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
            .and_then(|(runtime, state)| required_edge_probability(runtime, state));
        let edge_summary = runtime.zip(cell).zip(book).zip(required_edge).map(
            |(((runtime, cell), book), required_edge)| {
                summarize_asks(runtime, cell, &book.asks(), required_edge)
            },
        );
        let already_positioned = self.positioned_markets.contains(&market.condition_id)
            || self.pending_markets.contains(&market.condition_id);
        let market_resolved = self.resolved_markets.contains(&market.condition_id);
        let skip_reason = if self.failed_order_markets.contains(&market.condition_id) {
            Some("live_order_failed")
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
                token,
                book,
                book_age_ms,
                vol_bps_per_sqrt_min,
                cell,
                path_state.as_ref(),
                required_edge,
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
                d_bps = ?d_bps.map(|value| value.round_dp(6).to_string()),
                abs_d_bps = ?abs_d_bps.map(|value| value.round_dp(6).to_string()),
                side_leading = ?side_leading.map(SideLeading::as_str),
                vol_bps_per_sqrt_min = ?vol_bps_per_sqrt_min,
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
                best_ask = ?best_ask.as_ref().map(|level| level.price.to_string()),
                best_ask_size = ?best_ask.as_ref().map(|level| level.size.to_string()),
                best_ask_fee = ?edge_summary.as_ref().and_then(|summary| summary.best_fee),
                best_ask_edge = ?edge_summary.as_ref().and_then(|summary| summary.best_edge),
                selected_size = ?edge_summary.as_ref().map(|summary| summary.positive_ev_depth_shares),
                weighted_avg_price = ?edge_summary.as_ref().and_then(|summary| summary.weighted_avg_price),
                all_in_cost = ?edge_summary.as_ref().and_then(|summary| summary.best_all_in_cost),
                edge = ?edge_summary.as_ref().and_then(|summary| summary.best_edge),
                positive_ev_depth_shares = ?edge_summary.as_ref().map(|summary| summary.positive_ev_depth_shares),
                positive_ev_depth_usdc = ?edge_summary.as_ref().map(|summary| summary.positive_ev_depth_usdc),
                positive_ev_depth = ?edge_summary.as_ref().map(|summary| summary.positive_ev_depth_shares),
                max_acceptable_price = ?edge_summary.as_ref().and_then(|summary| summary.max_acceptable_price),
                fee_rate = ?runtime.map(AssetRuntime::fee_rate),
                min_edge_probability = ?runtime.map(AssetRuntime::min_edge_probability),
                required_edge = ?required_edge,
                min_order_usdc = config.min_order_usdc,
                max_position_usdc = ?runtime.map(AssetRuntime::max_position_usdc),
                max_order_usdc = config.max_order_usdc,
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
        let max_price = edge_summary.max_acceptable_price?;
        let amount_usdc = edge_summary
            .positive_ev_depth_usdc
            .min(runtime.max_position_usdc())
            .min(config.max_order_usdc);
        if amount_usdc < config.min_order_usdc {
            return None;
        }
        let best_ask_price = best_ask.as_ref().and_then(|level| level.price.to_f64());
        let best_ask_size = best_ask.as_ref().and_then(|level| level.size.to_f64());
        let expected_fill_price = edge_summary.weighted_avg_price.or(best_ask_price);
        let estimated_payout_usdc = expected_fill_price
            .filter(|price| *price > 0.0)
            .map(|price| amount_usdc / price);
        let estimated_profit_usdc = estimated_payout_usdc.map(|payout| payout - amount_usdc);

        Some(PreparedTrade {
            asset: market.asset,
            slug: market.slug.clone(),
            condition_id: market.condition_id.clone(),
            token_id: token.asset_id.clone(),
            outcome: token.outcome.clone(),
            amount_usdc,
            max_price,
            line_price: line.price.to_f64()?,
            current_price: latest_tick.value.to_f64()?,
            line_observed_at: line.observed_at,
            current_exchange_timestamp: latest_tick.exchange_timestamp,
            current_received_at: latest_tick.received_at,
            remaining_sec,
            d_bps: d_bps.map(|value| value.round_dp(6).to_string()),
            p_win: cell.map(|cell| cell.p_win),
            p_win_lower: cell.map(|cell| cell.p_win_lower),
            best_edge: edge_summary.best_edge,
            best_ask: best_ask_price,
            best_ask_size,
            weighted_avg_price: edge_summary.weighted_avg_price,
            best_fee: edge_summary.best_fee,
            best_all_in_cost: edge_summary.best_all_in_cost,
            positive_ev_depth_shares: edge_summary.positive_ev_depth_shares,
            positive_ev_depth_usdc: edge_summary.positive_ev_depth_usdc,
            expected_fill_price,
            estimated_payout_usdc,
            estimated_profit_usdc,
            remaining_sec_bucket: remaining_bucket,
            vol_bps_per_sqrt_min,
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

    async fn execute_live_trade(
        &mut self,
        market: &MonitoredMarket,
        runtime_bundle: &RuntimeBundle,
        config: &RuntimeConfig,
        executor: &LiveTradeExecutor,
        telegram: &TelegramClient,
        initial_prepared: &PreparedTrade,
    ) {
        let now = Utc::now();
        if self
            .live_pre_submit_error_cooldown_until
            .is_some_and(|until| now < until)
        {
            return;
        }
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

        if self.pending_markets.contains(&market.condition_id)
            || self.positioned_markets.contains(&market.condition_id)
            || self.failed_order_markets.contains(&market.condition_id)
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
            Ok(false) => {
                self.live_pre_submit_error_cooldown_until = None;
            }
            Err(error) => {
                let error_chain = format!("{error:#}");
                self.live_pre_submit_error_cooldown_until =
                    Some(Utc::now() + TimeDelta::seconds(60));
                warn!(
                    event = "live_exposure_reconcile_error",
                    error = %error_chain,
                    slug = market.slug,
                    condition_id = market.condition_id,
                    "failed to reconcile market exposure"
                );
                if let Err(telegram_error) = telegram
                    .send_message(&live_pre_submit_error_text(
                        market,
                        initial_prepared,
                        "could not check existing market exposure",
                        &error_chain,
                    ))
                    .await
                {
                    warn!(error = %telegram_error, slug = market.slug, "failed to send live pre-submit error Telegram message");
                }
                return;
            }
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
            max_price: prepared.max_price,
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
            max_price = request.max_price,
            decision = "submitted",
            "submitting live order"
        );
        let result = executor.execute(&request).await;
        self.pending_markets.remove(&market.condition_id);

        match result {
            Ok(response) => {
                let retryable_no_fill = is_retryable_no_fill_response(&response);
                if response.has_fill() {
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
                let decision = if response.has_fill() {
                    "filled"
                } else if response.success {
                    "submitted"
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
                    max_price = request.max_price,
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
                if !response.success {
                    warn!(
                        event = "live_order_rejected",
                        timestamp = %Utc::now().to_rfc3339(),
                        mode = "live",
                        slug = market.slug,
                        condition_id = market.condition_id,
                        token_id = request.token_id.as_str(),
                        outcome = ?request.outcome,
                        amount_usdc = request.amount_usdc,
                        max_price = request.max_price,
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
                let message = if response.has_fill() {
                    Some(live_entry_filled_text(&prepared, &response))
                } else if !retryable_no_fill && !response.success {
                    Some(live_entry_rejected_text(
                        request.asset,
                        &request.outcome,
                        response.error_msg.as_deref().unwrap_or("unknown"),
                    ))
                } else {
                    None
                };
                if let Some(message) = message {
                    if let Err(error) = telegram.send_message(&message).await {
                        warn!(
                            error = %error,
                            slug = market.slug,
                            "failed to send live execution Telegram message"
                        );
                    }
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
                self.record_live_error(&market.condition_id, &error_chain);
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
                    if let Err(telegram_error) = telegram.send_message(&message).await {
                        warn!(error = %telegram_error, slug = market.slug, "failed to send live error Telegram message");
                    }
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
        path_state: Option<&PathState>,
        required_edge: Option<f64>,
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

    fn record_trade_entry(
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
            },
        );
    }

    fn record_live_response(&mut self, condition_id: &str, response: &LiveOrderResponse) {
        let Some(entry) = self.tracked_entries.get_mut(condition_id) else {
            return;
        };
        entry.track_closeout = response.has_fill();
        if response.has_fill() {
            entry.filled_amount_usdc = response
                .filled_amount_usdc()
                .or(Some(entry.prepared.amount_usdc));
            entry.filled_payout_usdc = response
                .filled_payout_usdc()
                .or(entry.prepared.estimated_payout_usdc);
        }
        entry.record["order_response"] = json!({
            "received_at": Utc::now().to_rfc3339(),
            "order_id": response.order_id.as_str(),
            "status": response.status.as_str(),
            "success": response.success,
            "error_msg": response.error_msg.as_deref(),
            "making_amount": response.making_amount.as_str(),
            "taking_amount": response.taking_amount.as_str(),
            "trade_ids": &response.trade_ids,
            "has_fill": response.has_fill(),
            "filled_amount_usdc": entry.filled_amount_usdc,
            "filled_payout_usdc": entry.filled_payout_usdc,
        });
        entry.record["state"] = json!(if response.has_fill() {
            "filled"
        } else if response.success {
            "submitted"
        } else {
            "rejected"
        });
        entry.write_record();
    }

    fn record_live_error(&mut self, condition_id: &str, error: &str) {
        let Some(entry) = self.tracked_entries.get_mut(condition_id) else {
            return;
        };
        entry.track_closeout = false;
        entry.record["order_error"] = json!({
            "received_at": Utc::now().to_rfc3339(),
            "error": error,
        });
        entry.record["state"] = json!("error");
        entry.write_record();
    }

    fn close_tracked_entries(&mut self) {
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

    fn is_watched_condition(&self, condition_id: &str) -> bool {
        self.markets_by_slug
            .values()
            .any(|market| market.condition_id == condition_id)
    }
}

fn pre_submit_matches_initial(initial: &PreparedTrade, pre_submit: &PreparedTrade) -> bool {
    initial.outcome == pre_submit.outcome && initial.token_id == pre_submit.token_id
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

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum TradeMode {
    Live,
    Shadow,
}

impl TradeMode {
    fn as_str(self) -> &'static str {
        match self {
            Self::Live => "live",
            Self::Shadow => "shadow",
        }
    }
}

#[derive(Clone, Debug)]
struct TrackedEntry {
    prepared: PreparedTrade,
    slot_start: DateTime<Utc>,
    slot_end: DateTime<Utc>,
    record_path: Option<PathBuf>,
    record: Value,
    track_closeout: bool,
    closeout_sent: bool,
    filled_amount_usdc: Option<f64>,
    filled_payout_usdc: Option<f64>,
}

impl TrackedEntry {
    fn filled_amount_usdc(&self) -> f64 {
        self.filled_amount_usdc.unwrap_or(self.prepared.amount_usdc)
    }

    fn filled_profit_usdc(&self) -> Option<f64> {
        match (self.filled_amount_usdc, self.filled_payout_usdc) {
            (Some(amount), Some(payout)) => Some(payout - amount),
            _ => self.prepared.estimated_profit_usdc,
        }
    }

    fn write_record(&self) {
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

fn trade_record_path(
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

fn write_json_record(path: &Path, value: &Value) -> Result<()> {
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

fn trade_entry_record_json(
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
            "amount_usdc": prepared.amount_usdc,
            "max_order_price": prepared.max_price,
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
        },
        "edge": {
            "p_win": prepared.p_win,
            "p_win_lower": prepared.p_win_lower,
            "best_edge": prepared.best_edge,
            "best_ask": prepared.best_ask,
            "best_ask_size": prepared.best_ask_size,
            "best_fee": prepared.best_fee,
            "best_all_in_cost": prepared.best_all_in_cost,
            "weighted_avg_price": prepared.weighted_avg_price,
            "positive_ev_depth_shares": prepared.positive_ev_depth_shares,
            "positive_ev_depth_usdc": prepared.positive_ev_depth_usdc,
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
        "path": {
            "return_last_60s_bps": prepared.return_last_60s_bps,
            "retracing_60s": prepared.retracing_60s,
            "max_abs_d_bps_so_far": prepared.max_abs_d_bps_so_far,
            "lead_decay_ratio": prepared.lead_decay_ratio,
            "edge_penalty_applied": prepared.edge_penalty_applied,
        },
    })
}

fn closeout_won(outcome: &Outcome, close_price: f64, line_price: f64) -> Option<bool> {
    if (close_price - line_price).abs() <= f64::EPSILON {
        return None;
    }
    match outcome {
        Outcome::Up => Some(close_price > line_price),
        Outcome::Down => Some(close_price < line_price),
        Outcome::Other(_) => None,
    }
}

fn closeout_estimated_pnl(
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
    line_price: f64,
    current_price: f64,
    line_observed_at: DateTime<Utc>,
    current_exchange_timestamp: DateTime<Utc>,
    current_received_at: DateTime<Utc>,
    remaining_sec: i64,
    d_bps: Option<String>,
    p_win: Option<f64>,
    p_win_lower: Option<f64>,
    best_edge: Option<f64>,
    best_ask: Option<f64>,
    best_ask_size: Option<f64>,
    weighted_avg_price: Option<f64>,
    best_fee: Option<f64>,
    best_all_in_cost: Option<f64>,
    positive_ev_depth_shares: f64,
    positive_ev_depth_usdc: f64,
    expected_fill_price: Option<f64>,
    estimated_payout_usdc: Option<f64>,
    estimated_profit_usdc: Option<f64>,
    remaining_sec_bucket: Option<u32>,
    vol_bps_per_sqrt_min: Option<f64>,
    vol_bin: Option<String>,
    matched_remaining_sec_bucket: Option<u32>,
    matched_abs_d_bps_min: Option<f64>,
    matched_abs_d_bps_max: Option<f64>,
    cell_sample_count: Option<u64>,
    return_last_60s_bps: Option<f64>,
    retracing_60s: Option<bool>,
    max_abs_d_bps_so_far: Option<f64>,
    lead_decay_ratio: Option<f64>,
    edge_penalty_applied: bool,
    runtime_config_hash: Option<String>,
    source_config_hash: Option<String>,
    training_input_hash: Option<String>,
    training_label_source_kind: Option<String>,
}

impl PreparedTrade {
    fn telegram_text(&self, mode: TradeMode) -> String {
        let heading = match mode {
            TradeMode::Live => format!(
                "Trying {} {}",
                self.asset.to_string().to_ascii_uppercase(),
                outcome_label(&self.outcome)
            ),
            TradeMode::Shadow => format!(
                "Shadow trade: {} {}",
                self.asset.to_string().to_ascii_uppercase(),
                outcome_label(&self.outcome)
            ),
        };
        let win_text = self
            .estimated_profit_usdc
            .zip(self.estimated_payout_usdc)
            .map(|(profit, payout)| {
                format!(
                    "If it wins: +{} profit ({} payout)",
                    format_usdc(profit),
                    format_usdc(payout)
                )
            })
            .unwrap_or_else(|| "If it wins: payout estimate unavailable".to_string());
        format!(
            "{}\nTarget: {}\nCurrent: {}\nBet: {} at up to {:.2}\nTime left: {}\n{}",
            heading,
            format_market_price(self.asset, self.line_price),
            format_market_price(self.asset, self.current_price),
            format_usdc(self.amount_usdc),
            self.max_price,
            format_remaining(self.remaining_sec),
            win_text
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

fn format_usdc(value: f64) -> String {
    format_currency(value, 2)
}

fn format_signed_usdc(value: f64) -> String {
    if value > 0.0 {
        format!("+{}", format_usdc(value))
    } else if value < 0.0 {
        format!("-{}", format_usdc(value.abs()))
    } else {
        format_usdc(0.0)
    }
}

fn format_remaining(seconds: i64) -> String {
    let seconds = seconds.max(0);
    let minutes = seconds / 60;
    let seconds = seconds % 60;
    if minutes > 0 {
        format!("{minutes}m {seconds:02}s")
    } else {
        format!("{seconds}s")
    }
}

fn format_market_price(asset: Asset, value: f64) -> String {
    match asset {
        Asset::Btc | Asset::Eth => format_currency(value, 2),
        Asset::Sol => format_currency(value, 4),
        Asset::Xrp | Asset::Doge | Asset::Hype | Asset::Bnb => format_currency(value, 6),
    }
}

fn format_currency(value: f64, decimals: usize) -> String {
    let sign = if value < 0.0 { "-" } else { "" };
    let raw = format!("{:.*}", decimals, value.abs());
    let (whole, fractional) = raw.split_once('.').unwrap_or((raw.as_str(), ""));
    if decimals == 0 {
        format!("{sign}${}", add_digit_grouping(whole))
    } else {
        format!("{sign}${}.{}", add_digit_grouping(whole), fractional)
    }
}

fn format_whole_number(value: u64) -> String {
    add_digit_grouping(&value.to_string())
}

fn format_percent(value: f64) -> String {
    let rounded = (value * 10.0).round() / 10.0;
    if (rounded.fract()).abs() < 0.000001 {
        format!("{rounded:.0}%")
    } else {
        format!("{rounded:.1}%")
    }
}

fn add_digit_grouping(digits: &str) -> String {
    let mut grouped = String::with_capacity(digits.len() + digits.len() / 3);
    for (index, ch) in digits.chars().rev().enumerate() {
        if index > 0 && index % 3 == 0 {
            grouped.push(',');
        }
        grouped.push(ch);
    }
    grouped.chars().rev().collect()
}

fn live_startup_error_text(error: &str) -> String {
    format!("Live trading could not start.\nReason: {error}\nNo live orders were sent.")
}

fn live_pre_submit_error_text(
    market: &MonitoredMarket,
    prepared: &PreparedTrade,
    summary: &str,
    error: &str,
) -> String {
    format!(
        "Live order blocked before submit: {} {}\nBet: {}\nReason: {summary}\nDetails: {error}\nNo order was sent.",
        market.asset.to_string().to_ascii_uppercase(),
        outcome_label(&prepared.outcome),
        format_usdc(prepared.amount_usdc)
    )
}

fn live_entry_filled_text(prepared: &PreparedTrade, response: &LiveOrderResponse) -> String {
    let filled_amount = response
        .filled_amount_usdc()
        .unwrap_or(prepared.amount_usdc);
    format!(
        "Entered {} {} for {}, price line @ {}",
        asset_ticker(prepared.asset),
        outcome_arrow(&prepared.outcome),
        format_usdc(filled_amount),
        format_market_price(prepared.asset, prepared.line_price)
    )
}

fn live_entry_rejected_text(asset: Asset, outcome: &Outcome, reason: &str) -> String {
    format!(
        "Rejected entry of {} {}: {}",
        asset_ticker(asset),
        outcome_arrow(outcome),
        clean_failure_reason(reason)
    )
}

fn asset_ticker(asset: Asset) -> &'static str {
    match asset {
        Asset::Btc => "BTC",
        Asset::Eth => "ETH",
        Asset::Sol => "SOL",
        Asset::Xrp => "XRP",
        Asset::Doge => "DOGE",
        Asset::Hype => "HYPE",
        Asset::Bnb => "BNB",
    }
}

fn outcome_arrow(outcome: &Outcome) -> &'static str {
    match outcome {
        Outcome::Up => "↑",
        Outcome::Down => "↓",
        Outcome::Other(_) => "?",
    }
}

fn clean_failure_reason(reason: &str) -> String {
    let trimmed = reason.trim();
    extract_error_json_value(trimmed).unwrap_or_else(|| trimmed.to_string())
}

fn extract_error_json_value(reason: &str) -> Option<String> {
    let marker = "\"error\":\"";
    let start = reason.find(marker)? + marker.len();
    let mut value = String::new();
    let mut escaped = false;
    for ch in reason[start..].chars() {
        if escaped {
            value.push(match ch {
                'n' => '\n',
                'r' => '\r',
                't' => '\t',
                '"' => '"',
                '\\' => '\\',
                other => other,
            });
            escaped = false;
            continue;
        }
        if ch == '\\' {
            escaped = true;
            continue;
        }
        if ch == '"' {
            break;
        }
        value.push(ch);
    }
    (!value.is_empty()).then_some(value)
}

fn is_retryable_no_fill_response(response: &LiveOrderResponse) -> bool {
    !response.has_fill()
        && (response.success
            || response
                .error_msg
                .as_deref()
                .is_some_and(is_retryable_no_fill_error))
}

fn is_retryable_no_fill_error(error: &str) -> bool {
    let normalized = error.to_ascii_lowercase();
    normalized.contains("no orders found to match")
        && (normalized.contains("fak") || normalized.contains("fok"))
}

fn retryable_no_fill_key(condition_id: &str, token_id: &str) -> String {
    format!("{condition_id}:{token_id}")
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

const MAX_MARKET_PATH_SECONDS: i64 = 300;
const PATH_LOOKBACK_SECONDS: i64 = 60;
const MAX_PATH_LOOKBACK_DRIFT_SECONDS: i64 = 30;
const LEAD_DECAY_PENALTY_THRESHOLD: f64 = 0.75;
const LEAD_DECAY_EDGE_PENALTY: f64 = 0.005;
const RETRYABLE_NO_FILL_COOLDOWN_SECONDS: i64 = 10;
const LIVE_SETTLEMENT_POLL_SECONDS: u64 = 15;
const LIVE_SETTLEMENT_DELAY_SECONDS: u64 = 20;
const LIVE_SETTLEMENT_LOOKBACK_SLOTS: u32 = 3;

#[derive(Clone, Debug, Default)]
struct MarketPricePath {
    samples: VecDeque<PathSample>,
    max_abs_d_bps_so_far: f64,
}

impl MarketPricePath {
    fn push(&mut self, timestamp: DateTime<Utc>, price: Decimal, line_price: Decimal) {
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

    fn state(
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
struct PathState {
    return_last_60s_bps: f64,
    retracing_60s: bool,
    max_abs_d_bps_so_far: f64,
    lead_decay_ratio: f64,
}

fn edge_penalty_applies(path_state: &PathState) -> bool {
    path_state.lead_decay_ratio < LEAD_DECAY_PENALTY_THRESHOLD
}

fn required_edge_probability(runtime: &AssetRuntime, path_state: &PathState) -> Option<f64> {
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
struct EdgeSummary {
    best_fee: Option<f64>,
    best_all_in_cost: Option<f64>,
    best_edge: Option<f64>,
    positive_ev_depth_shares: f64,
    positive_ev_depth_usdc: f64,
    weighted_avg_price: Option<f64>,
    max_acceptable_price: Option<f64>,
}

fn summarize_asks(
    runtime: &AssetRuntime,
    cell: &RuntimeCell,
    asks: &[PriceLevel],
    required_edge: f64,
) -> EdgeSummary {
    let mut summary = EdgeSummary::default();

    for (index, level) in asks.iter().enumerate() {
        let Some(ask) = level.price.to_f64() else {
            break;
        };
        let Some(size) = level.size.to_f64() else {
            break;
        };

        let fee = runtime.fee_rate() * ask * (1.0 - ask);
        let all_in_cost = ask + fee;
        let edge = cell.p_win_lower - all_in_cost;
        if index == 0 {
            summary.best_fee = Some(fee);
            summary.best_all_in_cost = Some(all_in_cost);
            summary.best_edge = Some(edge);
        }

        if edge < required_edge {
            break;
        }

        summary.positive_ev_depth_shares += size;
        summary.positive_ev_depth_usdc += size * ask;
        summary.weighted_avg_price =
            Some(summary.positive_ev_depth_usdc / summary.positive_ev_depth_shares);
        summary.max_acceptable_price = Some(ask);
    }

    summary
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use chrono::{TimeDelta, TimeZone, Utc};
    use rust_decimal::Decimal;

    use crate::{
        config::{LiveOrderType, PolymarketSignatureType, RuntimeConfig},
        domain::{
            asset::Asset,
            market::{MonitoredMarket, Outcome, OutcomeToken},
            orderbook::{PriceLevel, TokenBook},
            time::MarketSlot,
        },
        polymarket::rtds::{PriceFeedSource, PriceTick},
        runtime::{RuntimeBundle, SideLeading, VolBin},
        trading::executor::LiveOrderResponse,
    };

    use super::{
        ClosedPositionPnlRow, MarketPricePath, MonitorState, PathState, PreparedTrade, SlotLine,
        asset_ids_for_markets, distance_bps, format_market_price, format_signed_usdc, format_usdc,
        is_retryable_no_fill_error, live_entry_filled_text, live_entry_rejected_text,
        live_settlement_summary_text, pre_submit_matches_initial, required_edge_probability,
        slot_start_from_market_slug, summarize_asks,
    };

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
            runtime.min_edge_probability(),
        );

        assert!((summary.best_fee.unwrap() - 0.01152).abs() < 0.000001);
        assert!((summary.best_all_in_cost.unwrap() - 0.81152).abs() < 0.000001);
        assert!(summary.best_edge.unwrap() > runtime.min_edge_probability());
        assert_eq!(summary.positive_ev_depth_shares, 30.0);
        assert!((summary.weighted_avg_price.unwrap() - 0.8266666666666667).abs() < 0.000001);
        assert_eq!(summary.max_acceptable_price, Some(0.84));
    }

    #[test]
    fn executable_depth_rejects_level_that_only_raw_p_win_would_accept() {
        let (runtime, cell) = btc_runtime_and_cell();
        assert!(cell.p_win > cell.p_win_lower);

        let summary = summarize_asks(
            runtime,
            cell,
            &[PriceLevel {
                price: Decimal::new(842, 3),
                size: Decimal::new(10, 0),
            }],
            runtime.min_edge_probability(),
        );

        assert!(cell.p_win - summary.best_all_in_cost.unwrap() >= runtime.min_edge_probability());
        assert!(summary.best_edge.unwrap() < runtime.min_edge_probability());
        assert_eq!(summary.positive_ev_depth_shares, 0.0);
    }

    #[test]
    fn executable_depth_stops_at_first_bad_level() {
        let (runtime, cell) = btc_runtime_and_cell();
        let summary = summarize_asks(
            runtime,
            cell,
            &[
                PriceLevel {
                    price: Decimal::new(80, 2),
                    size: Decimal::new(10, 0),
                },
                PriceLevel {
                    price: Decimal::new(85, 2),
                    size: Decimal::new(20, 0),
                },
                PriceLevel {
                    price: Decimal::new(86, 2),
                    size: Decimal::new(30, 0),
                },
            ],
            runtime.min_edge_probability(),
        );

        assert_eq!(summary.positive_ev_depth_shares, 10.0);
        assert_eq!(summary.max_acceptable_price, Some(0.80));
    }

    #[test]
    fn path_rule_skips_up_leader_retracing_over_last_60s() {
        let state = path_state("101", "100.5", SideLeading::UpLeading);
        assert!(state.return_last_60s_bps < 0.0);
        assert!(state.retracing_60s);
    }

    #[test]
    fn path_rule_skips_down_leader_retracing_over_last_60s() {
        let state = path_state("99", "99.5", SideLeading::DownLeading);
        assert!(state.return_last_60s_bps > 0.0);
        assert!(state.retracing_60s);
    }

    #[test]
    fn path_rule_allows_up_leader_extending_over_last_60s() {
        let state = path_state("100", "101", SideLeading::UpLeading);
        assert!(state.return_last_60s_bps > 0.0);
        assert!(!state.retracing_60s);
    }

    #[test]
    fn path_rule_allows_down_leader_extending_over_last_60s() {
        let state = path_state("100", "99", SideLeading::DownLeading);
        assert!(state.return_last_60s_bps < 0.0);
        assert!(!state.retracing_60s);
    }

    #[test]
    fn lead_decay_penalty_increases_required_edge() {
        let (runtime, _) = btc_runtime_and_cell();
        let decayed = PathState {
            return_last_60s_bps: 1.0,
            retracing_60s: false,
            max_abs_d_bps_so_far: 100.0,
            lead_decay_ratio: 0.74,
        };
        let intact = PathState {
            lead_decay_ratio: 0.75,
            ..decayed.clone()
        };
        let invalid = PathState {
            max_abs_d_bps_so_far: 0.0,
            ..decayed.clone()
        };

        assert!(
            (required_edge_probability(runtime, &decayed).unwrap()
                - (runtime.min_edge_probability() + 0.005))
                .abs()
                < 0.000001
        );
        assert_eq!(
            required_edge_probability(runtime, &intact),
            Some(runtime.min_edge_probability())
        );
        assert_eq!(required_edge_probability(runtime, &invalid), None);
    }

    #[test]
    fn skip_reason_rejects_unwhitelisted_and_missing_runtime_assets() {
        let state = MonitorState::default();
        let config = test_config(false);

        assert_eq!(
            state.trade_skip_reason(
                Asset::Bnb,
                None,
                120,
                None,
                None,
                None,
                None,
                None,
                None,
                None,
                None,
                None,
                None,
                None,
                None,
                None,
                None,
                None,
                None,
                false,
                false,
                &config,
            ),
            Some("asset_not_in_tradable_whitelist")
        );
        assert_eq!(
            state.trade_skip_reason(
                Asset::Btc,
                None,
                120,
                None,
                None,
                None,
                None,
                None,
                None,
                None,
                None,
                None,
                None,
                None,
                None,
                None,
                None,
                None,
                None,
                false,
                false,
                &config,
            ),
            Some("asset_not_in_runtime_bundle")
        );
    }

    #[test]
    fn skip_reason_rejects_remaining_seconds_below_minimum() {
        let state = MonitorState::default();
        let config = test_config(false);
        let (runtime, _) = btc_runtime_and_cell();

        assert_eq!(
            state.trade_skip_reason(
                Asset::Btc,
                Some(runtime),
                59,
                None,
                None,
                None,
                None,
                None,
                None,
                None,
                None,
                None,
                None,
                None,
                None,
                None,
                None,
                None,
                None,
                false,
                false,
                &config,
            ),
            Some("remaining_sec_below_min")
        );
    }

    #[test]
    fn skip_reason_applies_retracing_and_invalid_path_gates() {
        let config = test_config(false);
        let state = MonitorState::default();
        let (runtime, cell) = btc_runtime_and_cell();
        let token = OutcomeToken {
            outcome: Outcome::Up,
            asset_id: "up-token".to_string(),
        };
        let book = TokenBook::default();
        let retracing = PathState {
            return_last_60s_bps: -1.0,
            retracing_60s: true,
            max_abs_d_bps_so_far: 10.0,
            lead_decay_ratio: 1.0,
        };
        let invalid = PathState {
            retracing_60s: false,
            max_abs_d_bps_so_far: 0.0,
            ..retracing.clone()
        };

        assert_eq!(
            state.trade_skip_reason(
                Asset::Btc,
                Some(runtime),
                120,
                Some(&SlotLine {
                    price: Decimal::new(100, 0),
                    observed_at: Utc::now(),
                }),
                Some(&price_tick(Asset::Btc, Utc::now(), "101")),
                Some(0),
                Some(0),
                Some(Decimal::new(100, 0)),
                Some(100.0),
                Some(SideLeading::UpLeading),
                Some(&token),
                Some(&book),
                Some(0),
                Some(1.0),
                Some(cell),
                Some(&retracing),
                Some(runtime.min_edge_probability()),
                None,
                None,
                false,
                false,
                &config,
            ),
            Some("retracing_60s")
        );
        assert_eq!(
            state.trade_skip_reason(
                Asset::Btc,
                Some(runtime),
                120,
                Some(&SlotLine {
                    price: Decimal::new(100, 0),
                    observed_at: Utc::now(),
                }),
                Some(&price_tick(Asset::Btc, Utc::now(), "101")),
                Some(0),
                Some(0),
                Some(Decimal::new(100, 0)),
                Some(100.0),
                Some(SideLeading::UpLeading),
                Some(&token),
                Some(&book),
                Some(0),
                Some(1.0),
                Some(cell),
                Some(&invalid),
                None,
                None,
                None,
                false,
                false,
                &config,
            ),
            Some("invalid_path_lead")
        );
    }

    #[test]
    fn skip_reason_rejects_stale_price_and_book() {
        let state = MonitorState::default();
        let config = test_config(false);
        let (runtime, cell) = btc_runtime_and_cell();
        let token = OutcomeToken {
            outcome: Outcome::Up,
            asset_id: "up-token".to_string(),
        };
        let book = TokenBook::default();
        let path_state = PathState {
            return_last_60s_bps: 1.0,
            retracing_60s: false,
            max_abs_d_bps_so_far: 100.0,
            lead_decay_ratio: 1.0,
        };

        assert_eq!(
            state.trade_skip_reason(
                Asset::Btc,
                Some(runtime),
                120,
                Some(&SlotLine {
                    price: Decimal::new(100, 0),
                    observed_at: Utc::now(),
                }),
                Some(&price_tick(Asset::Btc, Utc::now(), "101")),
                Some(20_001),
                Some(0),
                Some(Decimal::new(100, 0)),
                Some(100.0),
                Some(SideLeading::UpLeading),
                Some(&token),
                Some(&book),
                Some(0),
                Some(1.0),
                Some(cell),
                Some(&path_state),
                Some(runtime.min_edge_probability()),
                None,
                None,
                false,
                false,
                &config,
            ),
            Some("stale_current_price")
        );
        assert_eq!(
            state.trade_skip_reason(
                Asset::Btc,
                Some(runtime),
                120,
                Some(&SlotLine {
                    price: Decimal::new(100, 0),
                    observed_at: Utc::now(),
                }),
                Some(&price_tick(Asset::Btc, Utc::now(), "101")),
                Some(0),
                Some(0),
                Some(Decimal::new(100, 0)),
                Some(100.0),
                Some(SideLeading::UpLeading),
                Some(&token),
                Some(&book),
                Some(10_001),
                Some(1.0),
                Some(cell),
                Some(&path_state),
                Some(runtime.min_edge_probability()),
                None,
                None,
                false,
                false,
                &config,
            ),
            Some("stale_order_book")
        );
    }

    #[test]
    fn pre_submit_recompute_rejects_side_flip() {
        let initial = prepared_trade(Outcome::Up, "up-token");
        let same = prepared_trade(Outcome::Up, "up-token");
        let flipped = prepared_trade(Outcome::Down, "down-token");

        assert!(pre_submit_matches_initial(&initial, &same));
        assert!(!pre_submit_matches_initial(&initial, &flipped));
    }

    #[test]
    fn fak_no_match_is_retryable_no_fill() {
        assert!(is_retryable_no_fill_error(
            "Status: error(400 Bad Request) making POST call to /order with {\"error\":\"no orders found to match with FAK order\"}"
        ));
        assert!(!is_retryable_no_fill_error(
            "Status: error(401 Unauthorized) making GET call to /data/orders with {\"error\":\"Unauthorized/Invalid api key\"}"
        ));
    }

    #[test]
    fn money_and_market_prices_use_grouping() {
        assert_eq!(format_usdc(8751.006), "$8,751.01");
        assert_eq!(format_signed_usdc(-1744.1871), "-$1,744.19");
        assert_eq!(format_market_price(Asset::Btc, 77972.55), "$77,972.55");
        assert_eq!(format_market_price(Asset::Sol, 184.3668), "$184.3668");
    }

    #[test]
    fn live_fill_message_uses_requested_shape() {
        let mut prepared = prepared_trade(Outcome::Up, "up-token");
        prepared.asset = Asset::Btc;
        prepared.line_price = 77972.55;
        prepared.amount_usdc = 50.0;
        let response = LiveOrderResponse {
            order_id: "0xorder".to_string(),
            status: "matched".to_string(),
            success: true,
            error_msg: None,
            making_amount: "49.999999".to_string(),
            taking_amount: "108.35".to_string(),
            trade_ids: vec!["trade".to_string()],
        };

        assert_eq!(
            live_entry_filled_text(&prepared, &response),
            "Entered BTC ↑ for $50.00, price line @ $77,972.55"
        );
    }

    #[test]
    fn live_rejection_message_uses_requested_shape_and_reason() {
        assert_eq!(
            live_entry_rejected_text(
                Asset::Eth,
                &Outcome::Down,
                "Status: error(400 Bad Request) making POST call to /order with {\"error\":\"invalid signature\"}"
            ),
            "Rejected entry of ETH ↓: invalid signature"
        );
    }

    #[test]
    fn settlement_summary_uses_polymarket_closed_rows() {
        let rows = vec![
            ClosedPositionPnlRow {
                realized_pnl: Some(58.352126999999996),
                slug: Some("btc-updown-5m-1777648800".to_string()),
                event_slug: None,
                title: Some("Bitcoin Up or Down - May 1, 11:20AM-11:25AM ET".to_string()),
                outcome: Some("Up".to_string()),
            },
            ClosedPositionPnlRow {
                realized_pnl: Some(-49.999999),
                slug: Some("eth-updown-5m-1777648800".to_string()),
                event_slug: None,
                title: Some("Ethereum Up or Down - May 1, 11:20AM-11:25AM ET".to_string()),
                outcome: Some("Down".to_string()),
            },
        ];

        assert_eq!(
            live_settlement_summary_text(&rows),
            "BTC ↑ won +$58.35\nETH ↓ lost -$50.00\n\nTotal wins: 1 (50%)\nTotal losses: 1 (50%)\n\nTotal PnL: +$8.35"
        );
    }

    #[test]
    fn parses_slot_start_from_market_slug() {
        assert_eq!(
            slot_start_from_market_slug("btc-updown-5m-1777648800"),
            Some(Utc.with_ymd_and_hms(2026, 5, 1, 15, 20, 0).unwrap())
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

    fn btc_runtime_and_cell() -> (
        &'static crate::runtime::AssetRuntime,
        &'static crate::runtime::RuntimeCell,
    ) {
        let bundle = Box::leak(Box::new(
            RuntimeBundle::load(
                std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                    .join("runtime/wiggler-prod-v1"),
            )
            .unwrap(),
        ));
        let runtime = bundle.config_for(Asset::Btc).unwrap();
        let cell = runtime
            .find_cell(60, VolBin::Low, SideLeading::UpLeading, 2.5)
            .unwrap();
        (runtime, cell)
    }

    fn path_state(previous_price: &str, current_price: &str, side: SideLeading) -> PathState {
        let start = Utc.with_ymd_and_hms(2026, 4, 30, 15, 50, 0).unwrap();
        let line = Decimal::new(100, 0);
        let current = current_price.parse::<Decimal>().unwrap();
        let mut path = MarketPricePath::default();
        path.push(start, previous_price.parse().unwrap(), line);
        path.push(start + TimeDelta::seconds(60), current, line);
        let current_abs_d_bps = distance_bps(current, line)
            .unwrap()
            .abs()
            .to_string()
            .parse::<f64>()
            .unwrap();

        path.state(
            start + TimeDelta::seconds(60),
            current,
            line,
            side,
            current_abs_d_bps,
        )
        .unwrap()
    }

    fn test_config(live_trading: bool) -> RuntimeConfig {
        RuntimeConfig {
            gamma_base_url: "https://gamma-api.polymarket.com".to_string(),
            data_api_base_url: "https://data-api.polymarket.com".to_string(),
            clob_api_url: "https://clob.polymarket.com".to_string(),
            clob_market_ws_url: "wss://ws-subscriptions-clob.polymarket.com/ws/market".to_string(),
            rtds_ws_url: "wss://ws-live-data.polymarket.com".to_string(),
            live_trading,
            tradable_assets: vec![Asset::Btc, Asset::Eth, Asset::Sol, Asset::Xrp, Asset::Doge],
            min_order_usdc: 1.0,
            max_order_usdc: 25.0,
            live_order_type: LiveOrderType::Fak,
            evaluation_interval: Duration::from_millis(1_000),
            log_evaluations: false,
            polymarket_private_key: None,
            polymarket_api_key: None,
            polymarket_api_secret: None,
            polymarket_api_passphrase: None,
            polymarket_api_nonce: None,
            polymarket_signature_type: PolymarketSignatureType::Eoa,
            polymarket_funder_address: None,
            price_stale_after: Duration::from_millis(20_000),
            orderbook_stale_after: Duration::from_millis(10_000),
            min_abs_d_bps: 0.01,
            trade_record_dir: std::path::PathBuf::from("trade-records"),
            telegram_enabled: true,
            telegram_bot_token: None,
            telegram_chat_id: None,
            telegram_pnl_interval: Duration::from_secs(900),
        }
    }

    fn prepared_trade(outcome: Outcome, token_id: &str) -> PreparedTrade {
        let now = Utc.with_ymd_and_hms(2026, 4, 30, 15, 52, 0).unwrap();
        PreparedTrade {
            asset: Asset::Btc,
            slug: "slug".to_string(),
            condition_id: "condition".to_string(),
            token_id: token_id.to_string(),
            outcome,
            amount_usdc: 10.0,
            max_price: 0.8,
            line_price: 67_000.0,
            current_price: 67_010.0,
            line_observed_at: now - TimeDelta::seconds(120),
            current_exchange_timestamp: now,
            current_received_at: now,
            remaining_sec: 120,
            d_bps: Some("1".to_string()),
            p_win: Some(0.91),
            p_win_lower: Some(0.9),
            best_edge: Some(0.05),
            best_ask: Some(0.75),
            best_ask_size: Some(100.0),
            weighted_avg_price: Some(0.8),
            best_fee: Some(0.01),
            best_all_in_cost: Some(0.81),
            positive_ev_depth_shares: 12.5,
            positive_ev_depth_usdc: 10.0,
            expected_fill_price: Some(0.8),
            estimated_payout_usdc: Some(12.5),
            estimated_profit_usdc: Some(2.5),
            remaining_sec_bucket: Some(120),
            vol_bps_per_sqrt_min: Some(1.5),
            vol_bin: Some("low".to_string()),
            matched_remaining_sec_bucket: Some(120),
            matched_abs_d_bps_min: Some(0.0),
            matched_abs_d_bps_max: Some(10.0),
            cell_sample_count: Some(100),
            return_last_60s_bps: Some(1.0),
            retracing_60s: Some(false),
            max_abs_d_bps_so_far: Some(2.0),
            lead_decay_ratio: Some(1.0),
            edge_penalty_applied: false,
            runtime_config_hash: Some("runtime".to_string()),
            source_config_hash: Some("source".to_string()),
            training_input_hash: Some("input".to_string()),
            training_label_source_kind: Some("label".to_string()),
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
