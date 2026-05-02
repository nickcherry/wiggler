use anyhow::{Context, Result};
use polymarket_client_sdk_v2::{
    data::{
        Client,
        types::{
            ClosedPositionSortBy, MarketFilter, PositionSortBy, Side, SortDirection,
            request::{ClosedPositionsRequest, PositionsRequest, TradesRequest},
            response::{ClosedPosition, Position, Trade},
        },
    },
    types::{Address, B256, Decimal},
};

const TRADES_PAGE_LIMIT: i32 = 10_000;
const TRADES_MAX_OFFSET: i32 = 10_000;
const POSITIONS_PAGE_LIMIT: i32 = 500;
const POSITIONS_MAX_OFFSET: i32 = 10_000;
const CLOSED_POSITIONS_PAGE_LIMIT: i32 = 50;
const CLOSED_POSITIONS_MAX_OFFSET: i32 = 100_000;

#[derive(Clone, Debug)]
pub struct DataApiClient {
    inner: Client,
}

impl DataApiClient {
    pub fn new(base_url: &str) -> Result<Self> {
        Ok(Self {
            inner: Client::new(base_url).context("create Polymarket Data API client")?,
        })
    }

    pub async fn fetch_trades(&self, user: Address, max_trades: usize) -> Result<Vec<Trade>> {
        let mut rows = Vec::new();
        let mut offset = 0_i32;

        while rows.len() < max_trades && offset <= TRADES_MAX_OFFSET {
            let remaining = max_trades.saturating_sub(rows.len());
            let limit = remaining.min(TRADES_PAGE_LIMIT as usize) as i32;
            if limit == 0 {
                break;
            }

            let request = TradesRequest::builder()
                .user(user)
                .limit(limit)
                .context("set trades page limit")?
                .offset(offset)
                .context("set trades page offset")?
                .taker_only(false)
                .build();
            let page = self
                .inner
                .trades(&request)
                .await
                .with_context(|| format!("fetch trades at offset {offset}"))?;
            let count = page.len();

            rows.extend(page);
            if count < limit as usize {
                break;
            }
            offset = offset.saturating_add(count as i32);
        }

        Ok(rows)
    }

    pub async fn fetch_closed_positions(
        &self,
        user: Address,
        max_positions: usize,
    ) -> Result<Vec<ClosedPosition>> {
        let mut rows = Vec::new();
        let mut offset = 0_i32;

        while rows.len() < max_positions && offset <= CLOSED_POSITIONS_MAX_OFFSET {
            let remaining = max_positions.saturating_sub(rows.len());
            let limit = remaining.min(CLOSED_POSITIONS_PAGE_LIMIT as usize) as i32;
            if limit == 0 {
                break;
            }

            let request = ClosedPositionsRequest::builder()
                .user(user)
                .limit(limit)
                .context("set closed positions page limit")?
                .offset(offset)
                .context("set closed positions page offset")?
                .sort_by(ClosedPositionSortBy::Timestamp)
                .sort_direction(SortDirection::Desc)
                .build();
            let page = self
                .inner
                .closed_positions(&request)
                .await
                .with_context(|| format!("fetch closed positions at offset {offset}"))?;
            let count = page.len();

            rows.extend(page);
            if count < limit as usize {
                break;
            }
            offset = offset.saturating_add(count as i32);
        }

        Ok(rows)
    }

    pub async fn fetch_positions(
        &self,
        user: Address,
        max_positions: usize,
        redeemable: Option<bool>,
    ) -> Result<Vec<Position>> {
        let mut rows = Vec::new();
        let mut offset = 0_i32;

        while rows.len() < max_positions && offset <= POSITIONS_MAX_OFFSET {
            let remaining = max_positions.saturating_sub(rows.len());
            let limit = remaining.min(POSITIONS_PAGE_LIMIT as usize) as i32;
            if limit == 0 {
                break;
            }

            let request_builder = PositionsRequest::builder()
                .user(user)
                .limit(limit)
                .context("set positions page limit")?
                .offset(offset)
                .context("set positions page offset")?
                .size_threshold(Decimal::ZERO)
                .sort_by(PositionSortBy::Current)
                .sort_direction(SortDirection::Desc);
            let request = match redeemable {
                Some(redeemable) => request_builder.redeemable(redeemable).build(),
                None => request_builder.build(),
            };
            let page = self
                .inner
                .positions(&request)
                .await
                .with_context(|| format!("fetch positions at offset {offset}"))?;
            let count = page.len();

            rows.extend(page);
            if count < limit as usize {
                break;
            }
            offset = offset.saturating_add(count as i32);
        }

        Ok(rows)
    }

    pub async fn has_market_trade(&self, user: Address, market: B256) -> Result<bool> {
        let request = TradesRequest::builder()
            .user(user)
            .filter(MarketFilter::markets([market]))
            .limit(1)
            .context("set trades page limit")?
            .offset(0)
            .context("set trades page offset")?
            .taker_only(false)
            .build();

        let rows = self
            .inner
            .trades(&request)
            .await
            .context("fetch market trades")?;
        Ok(!rows.is_empty())
    }
}

pub fn is_buy(side: &Side) -> bool {
    matches!(side, Side::Buy)
}
