use std::sync::Arc;

use anyhow::Result;
use chrono::{DateTime, Utc};
use tokio::sync::mpsc;

use crate::trading::{LiveTradeExecutor, executor::MarketExposureSnapshot};

use super::state::MonitorState;

const LIVE_EXPOSURE_RECENT_TRADES_MAX: usize = 1_000;

pub(super) struct LiveExposureReconcileResult {
    pub(super) condition_ids: Vec<String>,
    pub(super) checked_at: DateTime<Utc>,
    pub(super) result: Result<MarketExposureSnapshot>,
}

pub(super) fn maybe_spawn_live_exposure_reconcile(
    executor: Option<&Arc<LiveTradeExecutor>>,
    state: &MonitorState,
    tx: &mpsc::Sender<LiveExposureReconcileResult>,
    in_flight: &mut bool,
) {
    if *in_flight {
        return;
    }
    let Some(executor) = executor else {
        return;
    };
    let condition_ids = state.live_exposure_reconcile_condition_ids();
    if condition_ids.is_empty() {
        return;
    }

    *in_flight = true;
    let executor = Arc::clone(executor);
    let tx = tx.clone();
    tokio::spawn(async move {
        let result = executor
            .reconcile_market_exposure(&condition_ids, LIVE_EXPOSURE_RECENT_TRADES_MAX)
            .await;
        let _ = tx
            .send(LiveExposureReconcileResult {
                condition_ids,
                checked_at: Utc::now(),
                result,
            })
            .await;
    });
}
