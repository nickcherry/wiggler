use serde_json::Value;

use crate::{
    domain::{asset::Asset, market::Outcome},
    trading::LiveFill,
};

use super::{PreparedTrade, TradeMode, maker_order_effective_until};

impl PreparedTrade {
    pub(super) fn telegram_text(&self, mode: TradeMode) -> String {
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
            "{}\nTarget: {}\nCurrent: {}\nMaker bid: {} for {} shares @ {:.4}\nTime left: {}\n{}",
            heading,
            format_market_price(self.asset, self.line_price),
            format_market_price(self.asset, self.current_price),
            format_usdc(self.amount_usdc),
            format_shares(self.size_shares),
            self.order_price,
            format_remaining(self.remaining_sec),
            win_text
        )
    }
}

pub(super) fn outcome_label(outcome: &Outcome) -> &'static str {
    match outcome {
        Outcome::Up => "Up",
        Outcome::Down => "Down",
        Outcome::Other(_) => "Other",
    }
}

pub(super) fn format_usdc(value: f64) -> String {
    format_currency(value, 2)
}

pub(super) fn format_shares(value: f64) -> String {
    format!("{value:.4}")
        .trim_end_matches('0')
        .trim_end_matches('.')
        .to_string()
}

pub(super) fn format_signed_usdc(value: f64) -> String {
    if value > 0.0 {
        format!("+{}", format_usdc(value))
    } else if value < 0.0 {
        format!("-{}", format_usdc(value.abs()))
    } else {
        format_usdc(0.0)
    }
}

pub(super) fn format_remaining(seconds: i64) -> String {
    let seconds = seconds.max(0);
    let minutes = seconds / 60;
    let seconds = seconds % 60;
    if minutes > 0 {
        format!("{minutes}m {seconds:02}s")
    } else {
        format!("{seconds}s")
    }
}

pub(super) fn format_market_price(asset: Asset, value: f64) -> String {
    match asset {
        Asset::Btc | Asset::Eth => format_currency(value, 2),
        Asset::Sol => format_currency(value, 4),
        Asset::Xrp | Asset::Doge | Asset::Hype | Asset::Bnb => format_currency(value, 6),
    }
}

pub(super) fn format_currency(value: f64, decimals: usize) -> String {
    let sign = if value < 0.0 { "-" } else { "" };
    let raw = format!("{:.*}", decimals, value.abs());
    let (whole, fractional) = raw.split_once('.').unwrap_or((raw.as_str(), ""));
    if decimals == 0 {
        format!("{sign}${}", add_digit_grouping(whole))
    } else {
        format!("{sign}${}.{}", add_digit_grouping(whole), fractional)
    }
}

pub(super) fn format_whole_number(value: u64) -> String {
    add_digit_grouping(&value.to_string())
}

pub(super) fn format_percent(value: f64) -> String {
    let rounded = (value * 10.0).round() / 10.0;
    if (rounded.fract()).abs() < 0.000001 {
        format!("{rounded:.0}%")
    } else {
        format!("{rounded:.1}%")
    }
}

pub(super) fn format_percent_limited(value: f64, max_decimals: usize) -> String {
    let mut text = format!("{:.*}", max_decimals, value);
    if let Some(dot_index) = text.find('.') {
        while text.ends_with('0') {
            text.pop();
        }
        if text.len() == dot_index + 1 {
            text.pop();
        }
    }
    format!("{text}%")
}

pub(super) fn format_price_line_distance_percent(current_price: f64, line_price: f64) -> String {
    let line_abs = line_price.abs();
    if line_abs <= f64::EPSILON {
        return format_percent_limited(0.0, 2);
    }
    format_percent_limited(((current_price - line_price).abs() / line_abs) * 100.0, 2)
}

pub(super) fn price_line_position(current_price: f64, line_price: f64) -> &'static str {
    if current_price < line_price {
        "below"
    } else {
        "above"
    }
}

pub(super) fn add_digit_grouping(digits: &str) -> String {
    let mut grouped = String::with_capacity(digits.len() + digits.len() / 3);
    for (index, ch) in digits.chars().rev().enumerate() {
        if index > 0 && index % 3 == 0 {
            grouped.push(',');
        }
        grouped.push(ch);
    }
    grouped.chars().rev().collect()
}

pub(super) fn live_startup_error_text(error: &str) -> String {
    format!("Live trading could not start.\nReason: {error}\nNo live orders were sent.")
}

pub(super) fn live_entry_filled_text(prepared: &PreparedTrade, fill: &LiveFill) -> String {
    format!(
        "Filled {} {} maker bid for {} ({} shares @ {:.4})\n\nCurrent price is {} {} the price line ({})",
        asset_ticker(prepared.asset),
        outcome_arrow(&prepared.outcome),
        format_usdc(fill.amount_usdc),
        format_shares(fill.size_shares),
        fill.price,
        format_price_line_distance_percent(prepared.current_price, prepared.line_price),
        price_line_position(prepared.current_price, prepared.line_price),
        format_market_price(prepared.asset, prepared.line_price),
    )
}

pub(super) fn live_entry_posted_text(prepared: &PreparedTrade) -> String {
    let effective_until = maker_order_effective_until(prepared.expires_at);
    format!(
        "Posted {} {} maker bid for {} ({} shares @ {:.4})\nExpires: {}\n\nCurrent price is {} {} the price line ({})",
        asset_ticker(prepared.asset),
        outcome_arrow(&prepared.outcome),
        format_usdc(prepared.amount_usdc),
        format_shares(prepared.size_shares),
        prepared.order_price,
        effective_until.format("%Y-%m-%d %H:%M:%S UTC"),
        format_price_line_distance_percent(prepared.current_price, prepared.line_price),
        price_line_position(prepared.current_price, prepared.line_price),
        format_market_price(prepared.asset, prepared.line_price),
    )
}

pub(super) fn live_entry_rejected_text(asset: Asset, outcome: &Outcome, reason: &str) -> String {
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

pub(super) fn clean_failure_reason(reason: &str) -> String {
    let trimmed = reason.trim();
    extract_error_json_value(trimmed).unwrap_or_else(|| trimmed.to_string())
}

fn extract_error_json_value(reason: &str) -> Option<String> {
    let start = reason.find('{')?;
    let end = reason.rfind('}')?;
    if end < start {
        return None;
    }

    let payload: Value = serde_json::from_str(&reason[start..=end]).ok()?;
    payload
        .get("error")
        .or_else(|| payload.get("error_msg"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}
