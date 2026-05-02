use std::{
    collections::{BTreeMap, HashMap, HashSet},
    fmt::Write as _,
    io::{self, IsTerminal},
    str::FromStr,
};

use alloy::signers::local::PrivateKeySigner;
use anyhow::{Context, Result, bail};
use chrono::{DateTime, TimeDelta, Utc};
use futures_util::{StreamExt, stream};
use polymarket_client_sdk_v2::{data::types::response::Trade, types::Address};
use rust_decimal::prelude::ToPrimitive;

use crate::{
    cli::AnalyzeTradesArgs,
    config::{PolymarketSignatureType, RuntimeConfig},
    domain::{
        asset::{Asset, format_assets, normalize_assets},
        time::duration_from_seconds,
    },
    polymarket::{
        data::{DataApiClient, is_buy},
        gamma::GammaClient,
    },
    runtime::RuntimeBundle,
};

pub async fn run(args: AnalyzeTradesArgs, config: RuntimeConfig) -> Result<()> {
    if args.max_trades == 0 {
        bail!("max_trades must be positive");
    }

    let user = resolve_user_address(&args, &config)?;
    let duration = duration_from_seconds(args.slot_seconds)?;
    let assets = normalize_assets(args.assets);
    let runtime_bundle = RuntimeBundle::load(&args.runtime_bundle_dir).with_context(|| {
        format!(
            "load runtime bundle from {}",
            args.runtime_bundle_dir.display()
        )
    })?;
    let fee_rates = TradeFeeRates::from_runtime_bundle(&runtime_bundle, &assets)?;
    let data_api = DataApiClient::new(&config.data_api_base_url)?;
    let gamma = GammaClient::new(config.gamma_base_url.clone());

    let trades = data_api.fetch_trades(user, args.max_trades).await?;
    let analyzed = analyze_api_rows(&trades, &assets, duration, &gamma, &fee_rates).await?;
    let report = PerformanceReport::new(ReportInput {
        user,
        data_api_base_url: config.data_api_base_url,
        gamma_base_url: config.gamma_base_url,
        assets,
        slot_seconds: duration.num_seconds(),
        fee_model: fee_rates.summary(),
        trades_fetched: trades.len(),
        buy_trades_considered: analyzed.buy_trades_considered,
        unresolved_trades: analyzed.unresolved_trades,
        trades: analyzed.trades,
    });

    let color = !args.no_color && io::stdout().is_terminal();
    print!("{}", report.render(color));

    Ok(())
}

fn resolve_user_address(args: &AnalyzeTradesArgs, config: &RuntimeConfig) -> Result<Address> {
    if let Some(user) = args.user.as_deref() {
        return parse_address(user, "--user");
    }

    resolve_config_user_address(config)
}

pub fn resolve_config_user_address(config: &RuntimeConfig) -> Result<Address> {
    if let Some(user) = config.polymarket_user_address.as_deref() {
        return parse_address(user, "POLYMARKET_USER_ADDRESS");
    }

    if let Some(funder) = config.polymarket_funder_address.as_deref() {
        return parse_address(funder, "POLYMARKET_FUNDER_ADDRESS");
    }

    if config.polymarket_signature_type != PolymarketSignatureType::Eoa {
        bail!(
            "analysis needs the Polymarket proxy/safe wallet address; pass --user or set POLYMARKET_USER_ADDRESS/POLYMARKET_FUNDER_ADDRESS"
        );
    }

    let private_key = config.polymarket_private_key.as_deref().context(
        "analysis needs a wallet address; pass --user or set POLYMARKET_USER_ADDRESS/POLYMARKET_FUNDER_ADDRESS",
    )?;
    let signer = PrivateKeySigner::from_str(private_key).context("parse POLYMARKET_PRIVATE_KEY")?;
    Ok(signer.address())
}

fn parse_address(value: &str, source: &str) -> Result<Address> {
    Address::from_str(value).with_context(|| format!("parse {source} as an address"))
}

#[derive(Clone, Debug)]
pub struct ApiTradePnlRows {
    pub rows: Vec<ApiTradePnlRow>,
    pub trades_fetched: usize,
    pub buy_trades_considered: usize,
    pub unresolved_trades: usize,
}

#[derive(Clone, Debug)]
pub struct ApiTradePnlRow {
    pub realized_pnl: f64,
    pub slug: String,
    pub event_slug: String,
    pub title: String,
    pub outcome: String,
}

pub async fn fetch_api_trade_pnl_rows(
    data_api: &DataApiClient,
    gamma: &GammaClient,
    user: Address,
    assets: &[Asset],
    duration: TimeDelta,
    max_trades: usize,
    fee_rates: &TradeFeeRates,
) -> Result<ApiTradePnlRows> {
    let trades = data_api.fetch_trades(user, max_trades).await?;
    let analyzed = analyze_api_rows(&trades, assets, duration, gamma, fee_rates).await?;
    Ok(ApiTradePnlRows {
        rows: analyzed
            .trades
            .iter()
            .map(ApiTradePnlRow::from_analyzed_trade)
            .collect(),
        trades_fetched: trades.len(),
        buy_trades_considered: analyzed.buy_trades_considered,
        unresolved_trades: analyzed.unresolved_trades,
    })
}

impl ApiTradePnlRow {
    fn from_analyzed_trade(trade: &AnalyzedTrade) -> Self {
        Self {
            realized_pnl: trade.realized_pnl,
            slug: trade.slug.clone(),
            event_slug: trade.event_slug.clone(),
            title: trade.title.clone(),
            outcome: trade.outcome.clone(),
        }
    }
}

async fn analyze_api_rows(
    trades: &[Trade],
    assets: &[Asset],
    duration: TimeDelta,
    gamma: &GammaClient,
    fee_rates: &TradeFeeRates,
) -> Result<AnalysisRows> {
    let asset_filter = assets.iter().copied().collect::<HashSet<_>>();
    let mut candidate_trades = Vec::new();
    let mut slugs = HashSet::new();
    let mut analyzed = Vec::new();
    let mut buy_trades_considered = 0;
    let mut unresolved_trades = 0;

    for trade in trades.iter().filter(|trade| is_buy(&trade.side)) {
        let Some(asset) = asset_from_market_text(&trade.slug, &trade.event_slug, &trade.title)
        else {
            continue;
        };
        if !asset_filter.contains(&asset) {
            continue;
        }
        buy_trades_considered += 1;
        slugs.insert(trade.slug.clone());
        candidate_trades.push((trade, asset));
    }

    let resolutions = fetch_resolutions(gamma, slugs).await?;

    for (trade, asset) in candidate_trades {
        let Some(resolution_price) = resolutions
            .get(&trade.slug)
            .and_then(Option::as_ref)
            .and_then(|market| {
                market
                    .outcome_prices
                    .get(&normalize_outcome(&trade.outcome))
            })
            .copied()
        else {
            unresolved_trades += 1;
            continue;
        };

        let size = decimal_to_f64(trade.size, "size")?;
        let entry_price = decimal_to_f64(trade.price, "price")?;
        let entry_fee = trade_fee(size, entry_price, fee_rates.rate_for(asset));
        let cost_basis = (size * entry_price) + entry_fee;
        let realized_pnl = buy_trade_pnl(size, entry_price, resolution_price, entry_fee);
        let entry_remaining_seconds = trade
            .slug
            .as_str()
            .strip_prefix(asset.slug_code())
            .and_then(|_| slot_start_from_market_slug(&trade.slug))
            .map(|start| {
                let slot_end = start + duration;
                slot_end.timestamp() - trade.timestamp
            });

        analyzed.push(AnalyzedTrade {
            asset,
            slug: trade.slug.clone(),
            event_slug: trade.event_slug.clone(),
            title: trade.title.clone(),
            outcome: trade.outcome.clone(),
            realized_pnl,
            total_bought: cost_basis,
            fees: entry_fee,
            entry_price,
            entry_remaining_seconds,
        });
    }

    Ok(AnalysisRows {
        trades: analyzed,
        buy_trades_considered,
        unresolved_trades,
    })
}

#[derive(Debug)]
struct MarketResolution {
    outcome_prices: HashMap<String, f64>,
}

async fn fetch_resolutions(
    gamma: &GammaClient,
    slugs: HashSet<String>,
) -> Result<HashMap<String, Option<MarketResolution>>> {
    let mut requests = stream::iter(slugs.into_iter().map(|slug| {
        let gamma = gamma.clone();
        async move {
            let resolution = fetch_market_resolution(&gamma, &slug).await;
            (slug, resolution)
        }
    }))
    .buffer_unordered(16);

    let mut resolutions = HashMap::new();
    while let Some((slug, resolution)) = requests.next().await {
        resolutions.insert(slug, resolution?);
    }

    Ok(resolutions)
}

async fn fetch_market_resolution(
    gamma: &GammaClient,
    slug: &str,
) -> Result<Option<MarketResolution>> {
    let Some(event) = gamma
        .fetch_event_by_slug(slug)
        .await
        .with_context(|| format!("fetch Gamma event {slug} for trade analysis"))?
    else {
        return Ok(None);
    };

    let Some(market) = event.markets.into_iter().find(|market| market.slug == slug) else {
        return Ok(None);
    };
    if !market.closed {
        return Ok(None);
    }
    let Some(outcome_prices) = market.outcome_prices else {
        return Ok(None);
    };
    if outcome_prices.len() != market.outcomes.len() {
        return Ok(None);
    }

    let mut prices = HashMap::new();
    for (outcome, price) in market.outcomes.iter().zip(outcome_prices.iter()) {
        let price = price
            .parse::<f64>()
            .with_context(|| format!("parse Gamma outcome price {price} for {slug}"))?;
        prices.insert(normalize_outcome(outcome), price);
    }

    Ok(Some(MarketResolution {
        outcome_prices: prices,
    }))
}

fn normalize_outcome(value: &str) -> String {
    value.trim().to_ascii_lowercase()
}

#[derive(Clone, Debug)]
struct AnalysisRows {
    trades: Vec<AnalyzedTrade>,
    buy_trades_considered: usize,
    unresolved_trades: usize,
}

fn decimal_to_f64(value: rust_decimal::Decimal, field: &'static str) -> Result<f64> {
    value
        .to_f64()
        .with_context(|| format!("convert Polymarket {field} to f64"))
}

#[derive(Clone, Debug)]
pub struct TradeFeeRates {
    rates: HashMap<Asset, f64>,
}

impl TradeFeeRates {
    pub fn from_runtime_bundle(runtime_bundle: &RuntimeBundle, assets: &[Asset]) -> Result<Self> {
        let mut rates = HashMap::new();
        for asset in assets {
            let runtime = runtime_bundle
                .config_for(*asset)
                .with_context(|| format!("runtime bundle is missing fee config for {}", asset))?;
            rates.insert(*asset, runtime.fee_rate());
        }
        Ok(Self { rates })
    }

    fn rate_for(&self, asset: Asset) -> f64 {
        *self.rates.get(&asset).unwrap_or(&0.0)
    }

    fn summary(&self) -> String {
        let mut rates = self.rates.iter().collect::<Vec<_>>();
        rates.sort_by_key(|(asset, _)| **asset);
        let unique_rates = rates
            .iter()
            .map(|(_, rate)| rate.to_bits())
            .collect::<HashSet<_>>();
        if unique_rates.len() == 1 {
            let (_, rate) = rates[0];
            format!("{} taker entry fee", format_percent(rate * 100.0))
        } else {
            rates
                .into_iter()
                .map(|(asset, rate)| {
                    format!(
                        "{} {}",
                        asset.to_string().to_ascii_uppercase(),
                        format_percent(rate * 100.0)
                    )
                })
                .collect::<Vec<_>>()
                .join(", ")
        }
    }
}

fn trade_fee(size: f64, price: f64, fee_rate: f64) -> f64 {
    size * fee_rate * price * (1.0 - price)
}

fn buy_trade_pnl(size: f64, entry_price: f64, resolution_price: f64, entry_fee: f64) -> f64 {
    size * (resolution_price - entry_price) - entry_fee
}

#[derive(Clone, Debug)]
struct AnalyzedTrade {
    asset: Asset,
    slug: String,
    event_slug: String,
    title: String,
    outcome: String,
    realized_pnl: f64,
    total_bought: f64,
    fees: f64,
    entry_price: f64,
    entry_remaining_seconds: Option<i64>,
}

#[derive(Clone, Debug)]
struct ReportInput {
    user: Address,
    data_api_base_url: String,
    gamma_base_url: String,
    assets: Vec<Asset>,
    slot_seconds: i64,
    fee_model: String,
    trades_fetched: usize,
    buy_trades_considered: usize,
    unresolved_trades: usize,
    trades: Vec<AnalyzedTrade>,
}

#[derive(Clone, Debug)]
struct PerformanceReport {
    user: Address,
    data_api_base_url: String,
    gamma_base_url: String,
    assets: Vec<Asset>,
    slot_seconds: i64,
    fee_model: String,
    trades_fetched: usize,
    buy_trades_considered: usize,
    unresolved_trades: usize,
    overall: SummaryStats,
    by_asset: Vec<GroupRow>,
    by_remaining: Vec<GroupRow>,
    by_line_distance: Vec<GroupRow>,
    by_entry_odds: Vec<GroupRow>,
}

impl PerformanceReport {
    fn new(input: ReportInput) -> Self {
        let overall = SummaryStats::from_trades(&input.trades);

        Self {
            user: input.user,
            data_api_base_url: input.data_api_base_url,
            gamma_base_url: input.gamma_base_url,
            assets: input.assets,
            slot_seconds: input.slot_seconds,
            fee_model: input.fee_model,
            trades_fetched: input.trades_fetched,
            buy_trades_considered: input.buy_trades_considered,
            unresolved_trades: input.unresolved_trades,
            by_asset: group_by(&input.trades, |trade| GroupKey::Asset(trade.asset)),
            by_remaining: group_by(&input.trades, |trade| {
                GroupKey::Remaining(RemainingBucket::from_seconds(
                    trade.entry_remaining_seconds,
                    input.slot_seconds,
                ))
            }),
            by_line_distance: group_by(&input.trades, |_| {
                GroupKey::LineDistance(LineDistanceBucket::Unavailable)
            }),
            by_entry_odds: group_by(&input.trades, |trade| {
                GroupKey::EntryOdds(EntryOddsBucket::from_price(trade.entry_price))
            }),
            overall,
        }
    }

    fn render(&self, color: bool) -> String {
        let theme = Theme { color };
        let mut output = String::new();

        writeln!(output, "{}", theme.heading("Trade Performance Analysis")).unwrap();
        writeln!(
            output,
            "{} {}",
            theme.dim("Source:"),
            self.data_api_base_url
        )
        .unwrap();
        writeln!(
            output,
            "{} {}",
            theme.dim("Resolution source:"),
            self.gamma_base_url
        )
        .unwrap();
        writeln!(
            output,
            "{} net PnL subtracts estimated {} using fee = shares * rate * price * (1 - price)",
            theme.dim("Fee model:"),
            self.fee_model,
        )
        .unwrap();
        writeln!(
            output,
            "{} Fee Drag = fees / gross edge before fees; Fee/Notional = fees / pre-fee notional.",
            theme.dim("Fee efficiency:")
        )
        .unwrap();
        writeln!(output, "{} {}", theme.dim("Wallet:"), self.user).unwrap();
        writeln!(
            output,
            "{} {} | {} {} | {} {} | {} {} | {} {}s",
            theme.dim("Assets:"),
            format_assets(&self.assets),
            theme.dim("trades fetched:"),
            format_whole_number(self.trades_fetched as u64),
            theme.dim("buy trades considered:"),
            format_whole_number(self.buy_trades_considered as u64),
            theme.dim("resolved trades analyzed:"),
            format_whole_number(self.overall.trades),
            theme.dim("slot:"),
            self.slot_seconds
        )
        .unwrap();
        if self.unresolved_trades > 0 {
            writeln!(
                output,
                "{}",
                theme.warn(&format!(
                    "{} buy trades were skipped because Gamma did not yet report a closed resolved market.",
                    format_whole_number(self.unresolved_trades as u64)
                ))
            )
            .unwrap();
        }
        writeln!(output).unwrap();

        self.render_overall(&mut output, &theme);
        self.render_group_table(&mut output, &theme, "By Asset", None, &self.by_asset);
        self.render_group_table(
            &mut output,
            &theme,
            "By Time Remaining",
            None,
            &self.by_remaining,
        );
        self.render_group_table(
            &mut output,
            &theme,
            "By Entry Vs Start Line",
            Some("Polymarket Data API closed-position/trade rows do not include historical underlying start-line and entry-price values, so an API-only analysis cannot reconstruct these buckets."),
            &self.by_line_distance,
        );
        self.render_group_table(
            &mut output,
            &theme,
            "By Entry Odds",
            Some("This extra API-backed cut groups by Polymarket average entry price."),
            &self.by_entry_odds,
        );

        output
    }

    fn render_overall(&self, output: &mut String, theme: &Theme) {
        writeln!(output, "{}", theme.heading("Overall")).unwrap();
        let total = self.overall.trades;
        writeln!(
            output,
            "Trades: {} | Net PnL: {} | Fees: {} | Fee Drag: {} | Fee/Notional: {} | ROI: {} | Wins: {} | Losses: {} | Flats: {}",
            format_whole_number(total),
            theme.pnl(&format_signed_usdc(self.overall.pnl), self.overall.pnl),
            format_usdc(self.overall.fees),
            format_optional_percent(self.overall.fee_drag_pct()),
            format_optional_percent(self.overall.fee_notional_pct()),
            theme.pnl(
                &format_optional_signed_percent(self.overall.roi_pct()),
                self.overall.pnl
            ),
            format_count_pct(self.overall.wins, self.overall.win_pct()),
            format_count_pct(self.overall.losses, self.overall.loss_pct()),
            format_count_pct(self.overall.flats, self.overall.flat_pct()),
        )
        .unwrap();
        writeln!(output).unwrap();
    }

    fn render_group_table(
        &self,
        output: &mut String,
        theme: &Theme,
        title: &str,
        note: Option<&str>,
        rows: &[GroupRow],
    ) {
        writeln!(output, "{}", theme.heading(title)).unwrap();
        if let Some(note) = note {
            writeln!(output, "{}", theme.dim(note)).unwrap();
        }

        if rows.is_empty() {
            writeln!(output, "{}\n", theme.dim("(no rows)")).unwrap();
            return;
        }

        let table = Table::new(
            vec![
                Column::left("Group"),
                Column::right("Trades"),
                Column::right("% Trades"),
                Column::right("Net PnL"),
                Column::right("Fees"),
                Column::right("Fee Drag"),
                Column::right("Fee/Notional"),
                Column::right("% Net PnL"),
                Column::right("ROI"),
                Column::right("Wins"),
                Column::right("Losses"),
                Column::right("Flats"),
            ],
            rows.iter()
                .map(|row| {
                    let pnl_share_pct = row.stats.pnl_share_pct(self.overall.pnl);
                    vec![
                        Cell::plain(row.label.clone()),
                        Cell::plain(format_whole_number(row.stats.trades)),
                        Cell::plain(format_percent(
                            row.stats.trade_share_pct(self.overall.trades),
                        )),
                        Cell::pnl(format_signed_usdc(row.stats.pnl), row.stats.pnl),
                        Cell::plain(format_usdc(row.stats.fees)),
                        Cell::plain(format_optional_percent(row.stats.fee_drag_pct())),
                        Cell::plain(format_optional_percent(row.stats.fee_notional_pct())),
                        Cell::pnl(
                            format_optional_signed_percent(pnl_share_pct),
                            pnl_share_pct.unwrap_or(0.0),
                        ),
                        Cell::pnl(
                            format_optional_signed_percent(row.stats.roi_pct()),
                            row.stats.pnl,
                        ),
                        Cell::plain(format_count_pct(row.stats.wins, row.stats.win_pct())),
                        Cell::plain(format_count_pct(row.stats.losses, row.stats.loss_pct())),
                        Cell::plain(format_count_pct(row.stats.flats, row.stats.flat_pct())),
                    ]
                })
                .collect(),
        );
        writeln!(output, "{}\n", table.render(theme)).unwrap();
    }
}

#[derive(Clone, Debug)]
struct GroupRow {
    label: String,
    stats: SummaryStats,
}

fn group_by<F>(trades: &[AnalyzedTrade], key_for: F) -> Vec<GroupRow>
where
    F: Fn(&AnalyzedTrade) -> GroupKey,
{
    let mut groups: BTreeMap<GroupKey, SummaryStats> = BTreeMap::new();
    for trade in trades {
        groups.entry(key_for(trade)).or_default().add(trade);
    }

    groups
        .into_iter()
        .map(|(key, stats)| GroupRow {
            label: key.label(),
            stats,
        })
        .collect()
}

#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
enum GroupKey {
    Asset(Asset),
    Remaining(RemainingBucket),
    LineDistance(LineDistanceBucket),
    EntryOdds(EntryOddsBucket),
}

impl GroupKey {
    fn label(&self) -> String {
        match self {
            Self::Asset(asset) => asset.to_string().to_ascii_uppercase(),
            Self::Remaining(bucket) => bucket.label(),
            Self::LineDistance(bucket) => bucket.label(),
            Self::EntryOdds(bucket) => bucket.label(),
        }
    }
}

#[derive(Clone, Copy, Debug, Default)]
struct SummaryStats {
    trades: u64,
    cost_basis: f64,
    fees: f64,
    pnl: f64,
    wins: u64,
    losses: u64,
    flats: u64,
}

impl SummaryStats {
    fn from_trades(trades: &[AnalyzedTrade]) -> Self {
        let mut stats = Self::default();
        for trade in trades {
            stats.add(trade);
        }
        stats
    }

    fn add(&mut self, trade: &AnalyzedTrade) {
        self.trades += 1;
        self.cost_basis += trade.total_bought.max(0.0);
        self.fees += trade.fees.max(0.0);
        self.pnl += trade.realized_pnl;
        if trade.realized_pnl > 0.0 {
            self.wins += 1;
        } else if trade.realized_pnl < 0.0 {
            self.losses += 1;
        } else {
            self.flats += 1;
        }
    }

    fn trade_share_pct(self, total_trades: u64) -> f64 {
        percent_of(self.trades as f64, total_trades as f64).unwrap_or(0.0)
    }

    fn pnl_share_pct(self, total_pnl: f64) -> Option<f64> {
        percent_of(self.pnl, total_pnl)
    }

    fn fee_drag_pct(self) -> Option<f64> {
        let gross_edge = self.pnl + self.fees;
        if gross_edge <= f64::EPSILON {
            None
        } else {
            percent_of(self.fees, gross_edge)
        }
    }

    fn fee_notional_pct(self) -> Option<f64> {
        percent_of(self.fees, self.cost_basis - self.fees)
    }

    fn roi_pct(self) -> Option<f64> {
        percent_of(self.pnl, self.cost_basis)
    }

    fn win_pct(self) -> f64 {
        percent_of(self.wins as f64, self.trades as f64).unwrap_or(0.0)
    }

    fn loss_pct(self) -> f64 {
        percent_of(self.losses as f64, self.trades as f64).unwrap_or(0.0)
    }

    fn flat_pct(self) -> f64 {
        percent_of(self.flats as f64, self.trades as f64).unwrap_or(0.0)
    }
}

fn percent_of(value: f64, total: f64) -> Option<f64> {
    if total.abs() <= f64::EPSILON {
        None
    } else {
        Some((value / total) * 100.0)
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
enum RemainingBucket {
    Minute { lower: i64, upper: i64 },
    Outside,
    Unknown,
}

impl RemainingBucket {
    fn from_seconds(remaining_seconds: Option<i64>, slot_seconds: i64) -> Self {
        let Some(remaining_seconds) = remaining_seconds else {
            return Self::Unknown;
        };
        if remaining_seconds < 0 || remaining_seconds > slot_seconds {
            return Self::Outside;
        }

        let capped = remaining_seconds.min(slot_seconds.saturating_sub(1)).max(0);
        let lower = capped / 60;
        Self::Minute {
            lower,
            upper: lower + 1,
        }
    }

    fn label(&self) -> String {
        match self {
            Self::Minute { lower, upper } => format!("{lower}-{upper} min"),
            Self::Outside => "outside slot".to_string(),
            Self::Unknown => "unknown".to_string(),
        }
    }

    fn sort_key(&self) -> (i64, i64) {
        match self {
            Self::Minute { lower, .. } => (0, -*lower),
            Self::Outside => (1, 0),
            Self::Unknown => (2, 0),
        }
    }
}

impl Ord for RemainingBucket {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        self.sort_key().cmp(&other.sort_key())
    }
}

impl PartialOrd for RemainingBucket {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}

#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
enum LineDistanceBucket {
    Unavailable,
}

impl LineDistanceBucket {
    fn label(&self) -> String {
        match self {
            Self::Unavailable => "unavailable from API".to_string(),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
enum EntryOddsBucket {
    Decile { lower_cents: u32, upper_cents: u32 },
    Unknown,
}

impl EntryOddsBucket {
    fn from_price(price: f64) -> Self {
        if !price.is_finite() || price < 0.0 {
            return Self::Unknown;
        }
        let lower = ((price * 10.0).floor() as u32).min(9) * 10;
        Self::Decile {
            lower_cents: lower,
            upper_cents: lower + 10,
        }
    }

    fn label(&self) -> String {
        match self {
            Self::Decile {
                lower_cents,
                upper_cents,
            } => format!(
                "${:.2}-${:.2}",
                *lower_cents as f64 / 100.0,
                *upper_cents as f64 / 100.0
            ),
            Self::Unknown => "unknown".to_string(),
        }
    }

    fn sort_key(&self) -> (u32, u32) {
        match self {
            Self::Decile { lower_cents, .. } => (0, *lower_cents),
            Self::Unknown => (1, 0),
        }
    }
}

impl Ord for EntryOddsBucket {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        self.sort_key().cmp(&other.sort_key())
    }
}

impl PartialOrd for EntryOddsBucket {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}

fn asset_from_market_text(slug: &str, event_slug: &str, title: &str) -> Option<Asset> {
    asset_from_slug(slug)
        .or_else(|| asset_from_slug(event_slug))
        .or_else(|| asset_from_title(title))
}

fn asset_from_slug(slug: &str) -> Option<Asset> {
    slug.split('-').next()?.parse::<Asset>().ok()
}

fn asset_from_title(title: &str) -> Option<Asset> {
    let lower = title.to_ascii_lowercase();
    if lower.starts_with("bitcoin ") {
        Some(Asset::Btc)
    } else if lower.starts_with("ethereum ") {
        Some(Asset::Eth)
    } else if lower.starts_with("solana ") {
        Some(Asset::Sol)
    } else if lower.starts_with("xrp ") {
        Some(Asset::Xrp)
    } else if lower.starts_with("dogecoin ") {
        Some(Asset::Doge)
    } else if lower.starts_with("hyperliquid ") {
        Some(Asset::Hype)
    } else if lower.starts_with("bnb ") || lower.starts_with("binance coin ") {
        Some(Asset::Bnb)
    } else {
        None
    }
}

fn slot_start_from_market_slug(slug: &str) -> Option<DateTime<Utc>> {
    let timestamp = slug.rsplit('-').next()?.parse::<i64>().ok()?;
    DateTime::from_timestamp(timestamp, 0)
}

#[derive(Clone, Copy)]
enum Align {
    Left,
    Right,
}

struct Column {
    heading: &'static str,
    align: Align,
}

impl Column {
    fn left(heading: &'static str) -> Self {
        Self {
            heading,
            align: Align::Left,
        }
    }

    fn right(heading: &'static str) -> Self {
        Self {
            heading,
            align: Align::Right,
        }
    }
}

struct Cell {
    text: String,
    kind: CellKind,
}

impl Cell {
    fn plain(text: String) -> Self {
        Self {
            text,
            kind: CellKind::Plain,
        }
    }

    fn pnl(text: String, value: f64) -> Self {
        Self {
            text,
            kind: CellKind::Pnl(value),
        }
    }
}

enum CellKind {
    Plain,
    Pnl(f64),
}

struct Table {
    columns: Vec<Column>,
    rows: Vec<Vec<Cell>>,
}

impl Table {
    fn new(columns: Vec<Column>, rows: Vec<Vec<Cell>>) -> Self {
        Self { columns, rows }
    }

    fn render(&self, theme: &Theme) -> String {
        let widths = self.widths();
        let mut output = String::new();

        for (index, column) in self.columns.iter().enumerate() {
            if index > 0 {
                output.push_str("  ");
            }
            let padded = pad(column.heading, widths[index], column.align);
            output.push_str(&theme.bold(&padded));
        }
        output.push('\n');

        for row in &self.rows {
            for (index, cell) in row.iter().enumerate() {
                if index > 0 {
                    output.push_str("  ");
                }
                let padded = pad(&cell.text, widths[index], self.columns[index].align);
                match cell.kind {
                    CellKind::Plain => output.push_str(&padded),
                    CellKind::Pnl(value) => output.push_str(&theme.pnl(&padded, value)),
                }
            }
            output.push('\n');
        }

        output
    }

    fn widths(&self) -> Vec<usize> {
        self.columns
            .iter()
            .enumerate()
            .map(|(index, column)| {
                self.rows
                    .iter()
                    .filter_map(|row| row.get(index))
                    .map(|cell| cell.text.len())
                    .max()
                    .unwrap_or(0)
                    .max(column.heading.len())
            })
            .collect()
    }
}

fn pad(value: &str, width: usize, align: Align) -> String {
    match align {
        Align::Left => format!("{value:<width$}"),
        Align::Right => format!("{value:>width$}"),
    }
}

struct Theme {
    color: bool,
}

impl Theme {
    fn heading(&self, value: &str) -> String {
        self.colorize("1;36", value)
    }

    fn bold(&self, value: &str) -> String {
        self.colorize("1", value)
    }

    fn dim(&self, value: &str) -> String {
        self.colorize("2", value)
    }

    fn warn(&self, value: &str) -> String {
        self.colorize("33", value)
    }

    fn pnl(&self, value: &str, pnl: f64) -> String {
        if pnl > 0.0 {
            self.colorize("32", value)
        } else if pnl < 0.0 {
            self.colorize("31", value)
        } else {
            value.to_string()
        }
    }

    fn colorize(&self, code: &str, value: &str) -> String {
        if self.color {
            format!("\x1b[{code}m{value}\x1b[0m")
        } else {
            value.to_string()
        }
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
    if rounded.abs() < 0.05 {
        "0%".to_string()
    } else if rounded.fract().abs() < 0.000001 {
        format!("{rounded:.0}%")
    } else {
        format!("{rounded:.1}%")
    }
}

fn format_signed_percent(value: f64) -> String {
    if value > 0.0 {
        format!("+{}", format_percent(value))
    } else {
        format_percent(value)
    }
}

fn format_optional_signed_percent(value: Option<f64>) -> String {
    value
        .map(format_signed_percent)
        .unwrap_or_else(|| "n/a".to_string())
}

fn format_optional_percent(value: Option<f64>) -> String {
    value
        .map(format_percent)
        .unwrap_or_else(|| "n/a".to_string())
}

fn format_count_pct(count: u64, pct: f64) -> String {
    format!("{} ({})", format_whole_number(count), format_percent(pct))
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

#[cfg(test)]
mod tests {
    use super::{
        AnalyzedTrade, EntryOddsBucket, PerformanceReport, RemainingBucket, ReportInput,
        SummaryStats, asset_from_market_text, buy_trade_pnl, format_signed_usdc, trade_fee,
    };
    use crate::domain::asset::Asset;
    use polymarket_client_sdk_v2::types::address;

    #[test]
    fn remaining_buckets_sort_from_largest_to_smallest_then_unknowns() {
        let mut buckets = [
            RemainingBucket::from_seconds(Some(30), 300),
            RemainingBucket::from_seconds(None, 300),
            RemainingBucket::from_seconds(Some(210), 300),
            RemainingBucket::from_seconds(Some(90), 300),
            RemainingBucket::from_seconds(Some(301), 300),
        ];

        buckets.sort();

        assert_eq!(buckets[0].label(), "3-4 min");
        assert_eq!(buckets[1].label(), "1-2 min");
        assert_eq!(buckets[2].label(), "0-1 min");
        assert_eq!(buckets[3].label(), "outside slot");
        assert_eq!(buckets[4].label(), "unknown");
    }

    #[test]
    fn entry_odds_bucket_uses_ten_cent_ranges() {
        assert_eq!(EntryOddsBucket::from_price(0.42).label(), "$0.40-$0.50");
        assert_eq!(EntryOddsBucket::from_price(1.0).label(), "$0.90-$1.00");
    }

    #[test]
    fn summary_stats_count_wins_losses_and_flats() {
        let trades = vec![
            trade(Asset::Btc, 10.0, 101.0, 1.0, 0.7, Some(210)),
            trade(Asset::Btc, -5.0, 50.5, 0.5, 0.4, Some(90)),
            trade(Asset::Eth, 0.0, 20.0, 0.0, 0.5, None),
        ];
        let stats = SummaryStats::from_trades(&trades);

        assert_eq!(stats.trades, 3);
        assert_eq!(stats.wins, 1);
        assert_eq!(stats.losses, 1);
        assert_eq!(stats.flats, 1);
        assert!((stats.pnl - 5.0).abs() < 0.000001);
        assert!((stats.fees - 1.5).abs() < 0.000001);
        assert!((stats.fee_drag_pct().unwrap() - 23.076923).abs() < 0.0001);
        assert!((stats.fee_notional_pct().unwrap() - 0.88235294).abs() < 0.0001);
        assert!((stats.roi_pct().unwrap() - 2.91545189).abs() < 0.0001);
    }

    #[test]
    fn fee_drag_is_unavailable_when_gross_edge_is_not_positive() {
        let stats = SummaryStats {
            fees: 2.0,
            pnl: -3.0,
            ..SummaryStats::default()
        };

        assert_eq!(stats.fee_drag_pct(), None);
    }

    #[test]
    fn buy_trade_pnl_subtracts_entry_fee() {
        let entry_fee = trade_fee(100.0, 0.42, 0.072);
        assert!((entry_fee - 1.75392).abs() < 0.000001);
        assert!((buy_trade_pnl(100.0, 0.42, 1.0, entry_fee) - 56.24608).abs() < 0.000001);
        assert!((buy_trade_pnl(100.0, 0.42, 0.0, entry_fee) + 43.75392).abs() < 0.000001);
    }

    #[test]
    fn asset_extraction_uses_slug_then_title() {
        assert_eq!(
            asset_from_market_text("btc-updown-5m-1777562400", "", "ignored"),
            Some(Asset::Btc)
        );
        assert_eq!(
            asset_from_market_text("", "", "Dogecoin Up or Down"),
            Some(Asset::Doge)
        );
    }

    #[test]
    fn report_renders_requested_sections_without_color() {
        let report = PerformanceReport::new(ReportInput {
            user: address!("1234567890abcdef1234567890abcdef12345678"),
            data_api_base_url: "https://data-api.polymarket.com".to_string(),
            gamma_base_url: "https://gamma-api.polymarket.com".to_string(),
            assets: vec![Asset::Btc, Asset::Eth],
            slot_seconds: 300,
            fee_model: "7.2% taker entry fee".to_string(),
            trades_fetched: 2,
            buy_trades_considered: 2,
            unresolved_trades: 0,
            trades: vec![
                trade(Asset::Btc, 12.5, 50.0, 0.5, 0.7, Some(210)),
                trade(Asset::Eth, -10.0, 40.0, 0.4, 0.4, Some(45)),
            ],
        });

        let rendered = report.render(false);

        assert!(rendered.contains("Trade Performance Analysis"));
        assert!(rendered.contains("Fee model"));
        assert!(rendered.contains("Net PnL"));
        assert!(rendered.contains("Fee Drag"));
        assert!(rendered.contains("Fee/Notional"));
        assert!(rendered.contains("By Asset"));
        assert!(rendered.contains("By Time Remaining"));
        assert!(rendered.contains("By Entry Vs Start Line"));
        assert!(rendered.contains("unavailable from API"));
        assert!(rendered.contains("By Entry Odds"));
        assert!(rendered.contains("+$12.50"));
    }

    #[test]
    fn net_pnl_share_color_follows_rendered_percent_sign() {
        let report = PerformanceReport::new(ReportInput {
            user: address!("1234567890abcdef1234567890abcdef12345678"),
            data_api_base_url: "https://data-api.polymarket.com".to_string(),
            gamma_base_url: "https://gamma-api.polymarket.com".to_string(),
            assets: vec![Asset::Btc, Asset::Eth],
            slot_seconds: 300,
            fee_model: "7.2% taker entry fee".to_string(),
            trades_fetched: 2,
            buy_trades_considered: 2,
            unresolved_trades: 0,
            trades: vec![
                trade(Asset::Btc, 5.0, 50.0, 0.5, 0.7, Some(210)),
                trade(Asset::Eth, -10.0, 40.0, 0.4, 0.4, Some(45)),
            ],
        });

        let rendered = report.render(true);
        let btc_line = rendered.lines().find(|line| line.contains("BTC")).unwrap();
        let eth_line = rendered.lines().find(|line| line.contains("ETH")).unwrap();

        assert_ansi_color_for_text(btc_line, "-100%", "31");
        assert_ansi_color_for_text(eth_line, "+200%", "32");
    }

    #[test]
    fn signed_usdc_formats_losses() {
        assert_eq!(format_signed_usdc(-8751.006), "-$8,751.01");
    }

    fn trade(
        asset: Asset,
        pnl: f64,
        total_bought: f64,
        fees: f64,
        entry_price: f64,
        entry_remaining_seconds: Option<i64>,
    ) -> AnalyzedTrade {
        AnalyzedTrade {
            asset,
            slug: format!("{}-updown-5m-1777562400", asset.slug_code()),
            event_slug: format!("{}-updown-5m-1777562400", asset.slug_code()),
            title: format!("{} Up or Down", asset.to_string().to_ascii_uppercase()),
            outcome: "Up".to_string(),
            realized_pnl: pnl,
            total_bought,
            fees,
            entry_price,
            entry_remaining_seconds,
        }
    }

    fn assert_ansi_color_for_text(line: &str, text: &str, code: &str) {
        let text_index = line.find(text).unwrap();
        let prefix = &line[..text_index];
        let color_index = prefix.rfind("\x1b[").unwrap();
        let color_span = &line[color_index..text_index];

        assert!(
            color_span.starts_with(&format!("\x1b[{code}m")),
            "{text} had wrong ANSI color in {line:?}"
        );
        assert!(
            !color_span.contains("\x1b[0m"),
            "{text} was not inside active ANSI color in {line:?}"
        );
    }
}
