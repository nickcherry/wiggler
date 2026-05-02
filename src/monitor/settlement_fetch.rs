use std::time::Duration;

use chrono::{DateTime, TimeDelta, Utc};
use polymarket_client_sdk_v2::types::Address;
use tokio::{sync::mpsc, time};
use tracing::info;

use crate::{
    domain::asset::Asset,
    polymarket::data::DataApiClient,
    telegram::TelegramClient,
    trade_analysis::{self, ApiClosedPositionPnlRow},
};

use super::{
    settlement::{
        ClosedPositionPnlRow, closed_position_slot_start, live_settlement_candidate_slots,
        live_settlement_lookback_slots,
    },
    state::{LiveSettlementFetchResult, MonitorState},
};

const TELEGRAM_SETTLEMENT_MAX_POSITIONS: usize = 10_000;
pub(super) const LIVE_SETTLEMENT_CHECK_INTERVAL_SECONDS: u64 = 30;

pub(super) fn telegram_settlement_interval(
    telegram: &TelegramClient,
    pnl_interval: Duration,
) -> Option<time::Interval> {
    telegram_settlement_interval_duration(telegram, pnl_interval).map(time::interval)
}

pub(super) fn telegram_settlement_interval_duration(
    telegram: &TelegramClient,
    pnl_interval: Duration,
) -> Option<Duration> {
    if !telegram.is_configured() || pnl_interval.is_zero() {
        return None;
    }

    Some(Duration::from_secs(LIVE_SETTLEMENT_CHECK_INTERVAL_SECONDS))
}

pub(super) fn closed_rows_for_slot(
    rows: &[ClosedPositionPnlRow],
    slot_start: DateTime<Utc>,
) -> Vec<ClosedPositionPnlRow> {
    rows.iter()
        .filter(|row| closed_position_slot_start(row) == Some(slot_start))
        .cloned()
        .collect()
}

pub(super) fn closed_position_row_from_api_position(
    row: ApiClosedPositionPnlRow,
) -> ClosedPositionPnlRow {
    ClosedPositionPnlRow {
        realized_pnl: Some(row.realized_pnl),
        slug: Some(row.slug),
        event_slug: Some(row.event_slug),
        title: Some(row.title),
        outcome: Some(row.outcome),
    }
}

pub(super) fn maybe_spawn_live_settlement_fetch(
    data_api: &DataApiClient,
    user: Address,
    assets: &[Asset],
    duration: TimeDelta,
    pnl_interval: Duration,
    state: &MonitorState,
    tx: &mpsc::Sender<LiveSettlementFetchResult>,
    in_flight: &mut bool,
) {
    if *in_flight {
        return;
    }

    let candidate_slots = live_settlement_candidate_slots(
        Utc::now(),
        duration,
        live_settlement_lookback_slots(duration, pnl_interval),
    );
    let unsent_slots = candidate_slots
        .into_iter()
        .filter(|slot_start| !state.sent_live_settlement_slots.contains(slot_start))
        .collect::<Vec<_>>();
    if unsent_slots.is_empty() {
        return;
    }

    info!(
        event = "live_settlement_summary_check",
        unsent_slot_count = unsent_slots.len(),
        "checking Polymarket API position PnL for Telegram summaries"
    );

    *in_flight = true;
    let data_api = data_api.clone();
    let assets = assets.to_vec();
    let tx = tx.clone();
    tokio::spawn(async move {
        let result = trade_analysis::fetch_api_closed_position_pnl_rows(
            &data_api,
            user,
            &assets,
            TELEGRAM_SETTLEMENT_MAX_POSITIONS,
        )
        .await;
        let _ = tx
            .send(LiveSettlementFetchResult {
                unsent_slots,
                result,
            })
            .await;
    });
}
