use chrono::{DateTime, Utc};

use crate::domain::asset::Asset;

pub(super) fn asset_from_market_text(slug: &str, event_slug: &str, title: &str) -> Option<Asset> {
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

pub(super) fn slot_start_from_market_slug(slug: &str) -> Option<DateTime<Utc>> {
    let timestamp = slug.rsplit('-').next()?.parse::<i64>().ok()?;
    DateTime::from_timestamp(timestamp, 0)
}
