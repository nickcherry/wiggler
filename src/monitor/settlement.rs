use std::time::Duration;

use chrono::{DateTime, TimeDelta, Utc};
use serde::Deserialize;
use tracing::warn;

use crate::{config::RuntimeConfig, domain::time::MarketSlot};

use super::{format_percent, format_signed_usdc, format_whole_number};

const LIVE_SETTLEMENT_DELAY_SECONDS: u64 = 20;
const MAX_RECENT_CLOSED_POSITION_ROWS: usize = 500;
const MAX_CLOSED_POSITION_ROWS: usize = 50_000;

#[derive(Clone)]
pub(super) struct AccountPnlClient {
    http: reqwest::Client,
    data_api_base_url: String,
    user: Option<String>,
}

impl AccountPnlClient {
    pub(super) fn from_config(config: &RuntimeConfig) -> Self {
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

    pub(super) async fn fetch_recent_closed_positions(&self) -> Option<Vec<ClosedPositionPnlRow>> {
        self.fetch_closed_positions(MAX_RECENT_CLOSED_POSITION_ROWS)
            .await
    }

    pub(super) async fn fetch_all_closed_positions(&self) -> Option<Vec<ClosedPositionPnlRow>> {
        self.fetch_closed_positions(MAX_CLOSED_POSITION_ROWS).await
    }

    async fn fetch_closed_positions(&self, max_rows: usize) -> Option<Vec<ClosedPositionPnlRow>> {
        let user = self.user.as_deref()?;
        match self.fetch_closed_position_rows(user, max_rows).await {
            Some(rows) => Some(rows),
            None => {
                warn!(
                    user,
                    "failed to fetch Polymarket closed positions for Telegram summary"
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
        let mut offset = 0usize;

        while all_rows.len() < max_rows {
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
            offset += limit;
        }

        warn!(
            max_rows,
            "Polymarket closed position fetch hit row cap; Telegram all-time totals may be partial"
        );
        Some(all_rows)
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ClosedPositionPnlRow {
    pub(super) realized_pnl: Option<f64>,
    pub(super) slug: Option<String>,
    pub(super) event_slug: Option<String>,
    pub(super) title: Option<String>,
    pub(super) outcome: Option<String>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub(super) struct ClosedPositionTotals {
    pub(super) wins: u64,
    pub(super) losses: u64,
    pub(super) total_pnl: f64,
}

pub(super) fn live_settlement_candidate_slots(
    now: DateTime<Utc>,
    duration: TimeDelta,
    lookback_slots: u32,
) -> Vec<DateTime<Utc>> {
    let Ok(current_slot) = MarketSlot::current(now, duration) else {
        return Vec::new();
    };

    (1..=lookback_slots)
        .filter_map(|offset| {
            let slot = current_slot.offset(-(offset as i64)).ok()?;
            let delay = TimeDelta::try_seconds(LIVE_SETTLEMENT_DELAY_SECONDS as i64)?;
            let ready_at = slot.end() + delay;
            (now >= ready_at).then_some(slot.start())
        })
        .rev()
        .collect()
}

pub(super) fn live_settlement_summary_text(
    window_rows: &[ClosedPositionPnlRow],
    all_time_totals: ClosedPositionTotals,
) -> String {
    let mut lines = Vec::new();

    for row in window_rows {
        let pnl = row.realized_pnl.unwrap_or(0.0);
        lines.push(format!(
            "{} {} {} {}",
            closed_position_ticker(row),
            closed_position_outcome_arrow(row),
            closed_position_result_label(row.realized_pnl),
            format_signed_usdc(pnl)
        ));
    }

    let total = all_time_totals.wins + all_time_totals.losses;
    let win_pct = if total > 0 {
        (all_time_totals.wins as f64 / total as f64) * 100.0
    } else {
        0.0
    };
    let loss_pct = if total > 0 {
        (all_time_totals.losses as f64 / total as f64) * 100.0
    } else {
        0.0
    };

    lines.push(String::new());
    lines.push(format!(
        "Total wins: {} ({})",
        format_whole_number(all_time_totals.wins),
        format_percent(win_pct)
    ));
    lines.push(format!(
        "Total losses: {} ({})",
        format_whole_number(all_time_totals.losses),
        format_percent(loss_pct)
    ));
    lines.push(String::new());
    lines.push(format!(
        "Total PnL: {}",
        format_signed_usdc(all_time_totals.total_pnl)
    ));
    lines.join("\n")
}

pub(super) fn closed_position_totals(rows: &[ClosedPositionPnlRow]) -> ClosedPositionTotals {
    let mut totals = ClosedPositionTotals::default();
    for row in rows {
        if let Some(pnl) = row.realized_pnl {
            totals.total_pnl += pnl;
            if pnl > 0.0 {
                totals.wins += 1;
            } else if pnl < 0.0 {
                totals.losses += 1;
            }
        }
    }
    totals
}

fn closed_position_result_label(realized_pnl: Option<f64>) -> &'static str {
    match realized_pnl {
        Some(pnl) if pnl > 0.0 => "won",
        Some(pnl) if pnl < 0.0 => "lost",
        Some(_) => "flat",
        None => "unknown",
    }
}

pub(super) fn closed_position_slot_start(row: &ClosedPositionPnlRow) -> Option<DateTime<Utc>> {
    row.slug
        .as_deref()
        .or(row.event_slug.as_deref())
        .and_then(slot_start_from_market_slug)
}

pub(super) fn slot_start_from_market_slug(slug: &str) -> Option<DateTime<Utc>> {
    let timestamp = slug.rsplit('-').next()?.parse::<i64>().ok()?;
    DateTime::from_timestamp(timestamp, 0)
}

pub(super) fn closed_position_ticker(row: &ClosedPositionPnlRow) -> String {
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

pub(super) fn closed_position_outcome_label(row: &ClosedPositionPnlRow) -> &'static str {
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

pub(super) fn live_settlement_lookback_slots(duration: TimeDelta, pnl_interval: Duration) -> u32 {
    const LIVE_SETTLEMENT_LOOKBACK_SLOTS: u32 = 3;
    let slot_seconds = duration.num_seconds();
    if slot_seconds <= 0 {
        return LIVE_SETTLEMENT_LOOKBACK_SLOTS;
    }

    let interval_slots = pnl_interval.as_secs().div_ceil(slot_seconds as u64);
    interval_slots
        .saturating_add(2)
        .max(u64::from(LIVE_SETTLEMENT_LOOKBACK_SLOTS))
        .min(u64::from(u32::MAX)) as u32
}
