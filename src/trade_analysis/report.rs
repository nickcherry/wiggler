use std::{collections::BTreeMap, fmt::Write as _};

use polymarket_client_sdk_v2::types::Address;

use crate::domain::asset::{Asset, format_assets};

#[derive(Clone, Debug)]
pub(crate) struct AnalyzedTrade {
    pub(crate) asset: Asset,
    pub(crate) slug: String,
    pub(crate) event_slug: String,
    pub(crate) title: String,
    pub(crate) outcome: String,
    pub(crate) realized_pnl: f64,
    pub(crate) total_bought: f64,
    pub(crate) fees: f64,
    pub(crate) entry_price: f64,
    pub(crate) entry_remaining_seconds: Option<i64>,
}

#[derive(Clone, Debug)]
pub(crate) struct ReportInput {
    pub(crate) user: Address,
    pub(crate) data_api_base_url: String,
    pub(crate) gamma_base_url: String,
    pub(crate) assets: Vec<Asset>,
    pub(crate) slot_seconds: i64,
    pub(crate) fee_model: String,
    pub(crate) trades_fetched: usize,
    pub(crate) closed_positions_fetched: usize,
    pub(crate) closed_positions_considered: usize,
    pub(crate) current_positions_fetched: usize,
    pub(crate) current_positions_considered: usize,
    pub(crate) buy_trades_considered: usize,
    pub(crate) unresolved_trades: usize,
    pub(crate) missing_closed_position_trades: usize,
    pub(crate) trades: Vec<AnalyzedTrade>,
}

#[derive(Clone, Debug)]
pub(crate) struct PerformanceReport {
    user: Address,
    data_api_base_url: String,
    gamma_base_url: String,
    assets: Vec<Asset>,
    slot_seconds: i64,
    fee_model: String,
    trades_fetched: usize,
    closed_positions_fetched: usize,
    closed_positions_considered: usize,
    current_positions_fetched: usize,
    current_positions_considered: usize,
    buy_trades_considered: usize,
    unresolved_trades: usize,
    missing_closed_position_trades: usize,
    overall: SummaryStats,
    by_asset: Vec<GroupRow>,
    by_remaining: Vec<GroupRow>,
    by_line_distance: Vec<GroupRow>,
    by_entry_odds: Vec<GroupRow>,
}

impl PerformanceReport {
    pub(crate) fn new(input: ReportInput) -> Self {
        let overall = SummaryStats::from_trades(&input.trades);

        Self {
            user: input.user,
            data_api_base_url: input.data_api_base_url,
            gamma_base_url: input.gamma_base_url,
            assets: input.assets,
            slot_seconds: input.slot_seconds,
            fee_model: input.fee_model,
            trades_fetched: input.trades_fetched,
            closed_positions_fetched: input.closed_positions_fetched,
            closed_positions_considered: input.closed_positions_considered,
            current_positions_fetched: input.current_positions_fetched,
            current_positions_considered: input.current_positions_considered,
            buy_trades_considered: input.buy_trades_considered,
            unresolved_trades: input.unresolved_trades,
            missing_closed_position_trades: input.missing_closed_position_trades,
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

    pub(crate) fn render(&self, color: bool) -> String {
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
        writeln!(output, "{} {}", theme.dim("Fee model:"), self.fee_model,).unwrap();
        writeln!(
            output,
            "{} Fee Drag = derived fees/adjustments / gross edge before fees; Fee/Notional = derived fees/adjustments / pre-fee notional.",
            theme.dim("Fee efficiency:")
        )
        .unwrap();
        writeln!(output, "{} {}", theme.dim("Wallet:"), self.user).unwrap();
        writeln!(
            output,
            "{} {} | {} {} | {} {} | {} {} | {} {} | {} {} | {} {}s",
            theme.dim("Assets:"),
            format_assets(&self.assets),
            theme.dim("trades fetched:"),
            format_whole_number(self.trades_fetched as u64),
            theme.dim("closed positions:"),
            format!(
                "{}/{}",
                format_whole_number(self.closed_positions_considered as u64),
                format_whole_number(self.closed_positions_fetched as u64)
            ),
            theme.dim("current positions:"),
            format!(
                "{}/{}",
                format_whole_number(self.current_positions_considered as u64),
                format_whole_number(self.current_positions_fetched as u64)
            ),
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
        if self.missing_closed_position_trades > 0 {
            writeln!(
                output,
                "{}",
                theme.warn(&format!(
                    "{} resolved buy trades were skipped because Polymarket position data did not include matching PnL.",
                    format_whole_number(self.missing_closed_position_trades as u64)
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
            Some("Polymarket Data API position/trade rows do not include historical underlying start-line and entry-price values, so an API-only analysis cannot reconstruct these buckets."),
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
pub(crate) struct SummaryStats {
    pub(crate) trades: u64,
    pub(crate) cost_basis: f64,
    pub(crate) fees: f64,
    pub(crate) pnl: f64,
    pub(crate) wins: u64,
    pub(crate) losses: u64,
    pub(crate) flats: u64,
}

impl SummaryStats {
    pub(crate) fn from_trades(trades: &[AnalyzedTrade]) -> Self {
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

    pub(crate) fn fee_drag_pct(self) -> Option<f64> {
        let gross_edge = self.pnl + self.fees;
        if gross_edge <= f64::EPSILON {
            None
        } else {
            percent_of(self.fees, gross_edge)
        }
    }

    pub(crate) fn fee_notional_pct(self) -> Option<f64> {
        percent_of(self.fees, self.cost_basis - self.fees)
    }

    pub(crate) fn roi_pct(self) -> Option<f64> {
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
pub(crate) enum RemainingBucket {
    Minute { lower: i64, upper: i64 },
    Outside,
    Unknown,
}

impl RemainingBucket {
    pub(crate) fn from_seconds(remaining_seconds: Option<i64>, slot_seconds: i64) -> Self {
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

    pub(crate) fn label(&self) -> String {
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
pub(crate) enum EntryOddsBucket {
    Decile { lower_cents: u32, upper_cents: u32 },
    Unknown,
}

impl EntryOddsBucket {
    pub(crate) fn from_price(price: f64) -> Self {
        if !price.is_finite() || price < 0.0 {
            return Self::Unknown;
        }
        let lower = ((price * 10.0).floor() as u32).min(9) * 10;
        Self::Decile {
            lower_cents: lower,
            upper_cents: lower + 10,
        }
    }

    pub(crate) fn label(&self) -> String {
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

pub(crate) fn format_signed_usdc(value: f64) -> String {
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

pub(crate) fn format_percent(value: f64) -> String {
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
