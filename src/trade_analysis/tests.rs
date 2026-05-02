use super::{
    buy_trade_pnl,
    market_text::asset_from_market_text,
    report::{
        AnalyzedTrade, EntryOddsBucket, PerformanceReport, RemainingBucket, ReportInput,
        SummaryStats, format_signed_usdc,
    },
    rows::ApiClosedPositionPnlRow,
    trade_fee,
};
use crate::domain::asset::Asset;
use polymarket_client_sdk_v2::data::types::response::{ClosedPosition, Position};
use polymarket_client_sdk_v2::types::address;
use serde_json::json;

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
fn api_closed_position_row_uses_polymarket_realized_pnl() {
    let position: ClosedPosition = serde_json::from_value(json!({
        "proxyWallet": "0x1234567890abcdef1234567890abcdef12345678",
        "asset": "1",
        "conditionId": "0x0000000000000000000000000000000000000000000000000000000000000001",
        "avgPrice": "0.42",
        "totalBought": "42",
        "realizedPnl": "-2.375",
        "curPrice": "0",
        "timestamp": 1777648800,
        "title": "Bitcoin Up or Down - May 1, 11:20AM-11:25AM ET",
        "slug": "btc-updown-5m-1777648800",
        "icon": "",
        "eventSlug": "btc-updown-5m-1777648800",
        "outcome": "Down",
        "outcomeIndex": 1,
        "oppositeOutcome": "Up",
        "oppositeAsset": "2",
        "endDate": "2026-05-01T15:25:00Z"
    }))
    .unwrap();

    let row = ApiClosedPositionPnlRow::from_closed_position(&position).unwrap();

    assert_eq!(row.realized_pnl, -2.375);
    assert_eq!(row.slug, "btc-updown-5m-1777648800");
    assert_eq!(row.outcome, "Down");
}

#[test]
fn api_current_position_row_uses_cash_and_realized_pnl() {
    let position: Position = serde_json::from_value(json!({
        "proxyWallet": "0x1234567890abcdef1234567890abcdef12345678",
        "asset": "1",
        "conditionId": "0x0000000000000000000000000000000000000000000000000000000000000001",
        "size": "10",
        "avgPrice": "0.45",
        "initialValue": "4.5",
        "currentValue": "10",
        "cashPnl": "5.5",
        "percentPnl": "122.2222",
        "totalBought": "4.5",
        "realizedPnl": "1.25",
        "percentRealizedPnl": "27.7778",
        "curPrice": "1",
        "redeemable": true,
        "mergeable": false,
        "title": "Bitcoin Up or Down - May 1, 11:20AM-11:25AM ET",
        "slug": "btc-updown-5m-1777648800",
        "icon": "",
        "eventSlug": "btc-updown-5m-1777648800",
        "outcome": "Up",
        "outcomeIndex": 0,
        "oppositeOutcome": "Down",
        "oppositeAsset": "2",
        "endDate": "2026-05-01",
        "negativeRisk": false
    }))
    .unwrap();

    let row = ApiClosedPositionPnlRow::from_current_position(&position).unwrap();

    assert_eq!(row.realized_pnl, 6.75);
    assert_eq!(row.slug, "btc-updown-5m-1777648800");
    assert_eq!(row.outcome, "Up");
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
        fee_model: "closed-position realizedPnl".to_string(),
        trades_fetched: 2,
        closed_positions_fetched: 2,
        closed_positions_considered: 2,
        current_positions_fetched: 0,
        current_positions_considered: 0,
        buy_trades_considered: 2,
        unresolved_trades: 0,
        missing_closed_position_trades: 0,
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
        fee_model: "closed-position realizedPnl".to_string(),
        trades_fetched: 2,
        closed_positions_fetched: 2,
        closed_positions_considered: 2,
        current_positions_fetched: 0,
        current_positions_considered: 0,
        buy_trades_considered: 2,
        unresolved_trades: 0,
        missing_closed_position_trades: 0,
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
