use std::{
    collections::{HashMap, HashSet},
    str::FromStr,
    sync::Arc,
};

use alloy::signers::{Signer as _, local::PrivateKeySigner};
use anyhow::{Context, Result, bail};
use polymarket_client_sdk_v2::{
    POLYGON,
    auth::Credentials,
    clob::{
        Client, Config,
        types::{
            OrderType, Side,
            request::OrdersRequest,
            response::{OpenOrderResponse, Page},
        },
    },
    error::Error as PolymarketError,
    types::{Address, B256, Decimal, U256},
};
use rust_decimal::prelude::FromPrimitive;
use tokio::{sync::Mutex, task::JoinHandle};
use tracing::{info, warn};

use crate::{
    config::RuntimeConfig,
    polymarket::data::{DataApiClient, is_buy},
    telegram::TelegramClient,
    trading::order::{LIVE_ORDER_SIZE_SCALE, LiveOrderRequest, LiveOrderResponse},
};

mod auth;
mod exposure;

use auth::{
    AuthenticatedClient, ClientState, CredentialRotationLock, CredentialSource, HeartbeatState,
    LiveAuthConfig, authenticate_client, credentials_from_config, data_api_user_address,
    is_l2_auth_error, is_l2_auth_error_chain, recover_client_after_l2_auth_error,
    refresh_heartbeat, spawn_heartbeat_task, validate_funder_address, validate_live_account,
};
#[cfg(test)]
use auth::{
    credential_nonce_candidates, parse_env_lines, read_credentials_cache, reserve_fresh_api_nonce,
    write_credentials_cache,
};
pub use exposure::MarketExposureSnapshot;
use exposure::{RecentTradeExposure, live_fill_from_data_trade, parse_condition_ids};
const TERMINAL_CURSOR: &str = "LTE=";

pub struct LiveTradeExecutor {
    client: ClientState,
    signer: PrivateKeySigner,
    auth_config: LiveAuthConfig,
    data_api: DataApiClient,
    data_api_user: Address,
    heartbeat_state: HeartbeatState,
    credential_rotation_lock: CredentialRotationLock,
    _heartbeat_task: JoinHandle<()>,
}

impl LiveTradeExecutor {
    pub async fn from_config(config: &RuntimeConfig, telegram: TelegramClient) -> Result<Self> {
        let private_key = config
            .polymarket_private_key
            .as_deref()
            .context("POLYMARKET_PRIVATE_KEY is required when WIGGLER_LIVE_TRADING=true")?;
        let signer = PrivateKeySigner::from_str(private_key)
            .context("parse POLYMARKET_PRIVATE_KEY")?
            .with_chain_id(Some(POLYGON));

        let unauthenticated_client = Client::new(
            &config.clob_api_url,
            Config::builder().use_server_time(true).build(),
        )
        .with_context(|| format!("create CLOB client for {}", config.clob_api_url))?;
        let geoblock = unauthenticated_client
            .check_geoblock()
            .await
            .context("check Polymarket geoblock status")?;
        if geoblock.blocked {
            bail!(
                "Polymarket order placement is geoblocked from country={}, region={}",
                geoblock.country,
                geoblock.region
            );
        }
        info!(
            country = geoblock.country,
            region = geoblock.region,
            "Polymarket geoblock check passed"
        );

        let funder_address = if let Some(funder) = &config.polymarket_funder_address {
            let funder_address =
                Address::from_str(funder).context("parse POLYMARKET_FUNDER_ADDRESS")?;
            validate_funder_address(
                config.polymarket_signature_type,
                signer.address(),
                funder_address,
            )?;
            Some(funder_address)
        } else {
            None
        };
        let auth_config = LiveAuthConfig {
            clob_api_url: config.clob_api_url.clone(),
            credentials: credentials_from_config(config)?,
            nonce: config.polymarket_api_nonce,
            credential_file: config.polymarket_api_credential_file.clone(),
            signature_type: config.polymarket_signature_type,
            funder_address,
        };
        let data_api = DataApiClient::new(&config.data_api_base_url)?;
        let data_api_user = data_api_user_address(config, signer.address(), funder_address)?;
        let credential_rotation_lock = Arc::new(Mutex::new(()));
        let mut client = authenticate_client(&auth_config, &signer, CredentialSource::Configured)
            .await
            .context("authenticate CLOB client")?;
        let heartbeat_state = Arc::new(Mutex::new(None));
        if let Err(error) = refresh_heartbeat(&client, &heartbeat_state).await {
            if is_l2_auth_error_chain(&error) {
                client = recover_client_after_l2_auth_error(
                    None,
                    &heartbeat_state,
                    &auth_config,
                    &signer,
                    &credential_rotation_lock,
                    "startup/heartbeat",
                    &format!("{error:#}"),
                    None,
                )
                .await
                .context("recover CLOB client after startup heartbeat auth error")?;
            } else {
                return Err(error).context("initialize CLOB heartbeat");
            }
        }
        let collateral = match validate_live_account(&client, &heartbeat_state).await {
            Ok(collateral) => collateral,
            Err(error) if is_l2_auth_error_chain(&error) => {
                client = recover_client_after_l2_auth_error(
                    None,
                    &heartbeat_state,
                    &auth_config,
                    &signer,
                    &credential_rotation_lock,
                    "startup/account",
                    &format!("{error:#}"),
                    None,
                )
                .await
                .context("recover CLOB client after startup account auth error")?;
                validate_live_account(&client, &heartbeat_state)
                    .await
                    .context("validate live account after API credential rotation")?
            }
            Err(error) => return Err(error),
        };
        let min_order_usdc =
            Decimal::from_f64(config.min_order_usdc).context("convert min order USDC")?;
        if collateral.balance < min_order_usdc || collateral.allowances.is_empty() {
            warn!(
                collateral_balance = %collateral.balance,
                allowance_count = collateral.allowances.len(),
                min_order_usdc = %min_order_usdc,
                "live trading account may not be able to place orders"
            );
        } else {
            info!(
                collateral_balance = %collateral.balance,
                allowance_count = collateral.allowances.len(),
                "live trading account balance allowance loaded"
            );
        }

        info!(
            clob_api_url = config.clob_api_url,
            signature_type = ?config.polymarket_signature_type,
            "live trading executor authenticated"
        );

        let client = Arc::new(Mutex::new(client));
        Ok(Self {
            _heartbeat_task: spawn_heartbeat_task(
                Arc::clone(&client),
                Arc::clone(&heartbeat_state),
                auth_config.clone(),
                signer.clone(),
                Arc::clone(&credential_rotation_lock),
                telegram,
            ),
            client,
            signer,
            auth_config,
            data_api,
            data_api_user,
            heartbeat_state,
            credential_rotation_lock,
        })
    }

    pub async fn has_market_exposure(&self, condition_id: &str) -> Result<bool> {
        let market = B256::from_str(condition_id).context("parse market condition id")?;
        let orders_request = OrdersRequest::builder().market(market).build();
        let mut client = self.current_client().await;
        let orders = match client.orders(&orders_request, None).await {
            Ok(orders) => orders,
            Err(error) if is_l2_auth_error(&error) => {
                warn!(
                    event = "live_auth_refresh",
                    endpoint = "data/orders",
                    error = %error,
                    "refreshing heartbeat after L2 auth error"
                );
                refresh_heartbeat(&client, &self.heartbeat_state)
                    .await
                    .context("refresh CLOB heartbeat after open-orders auth error")?;
                match client
                    .orders(&OrdersRequest::builder().market(market).build(), None)
                    .await
                {
                    Ok(orders) => orders,
                    Err(retry_error) if is_l2_auth_error(&retry_error) => {
                        client = self
                            .rotate_api_key_after_l2_auth_error("data/orders", &retry_error)
                            .await?;
                        client
                            .orders(&OrdersRequest::builder().market(market).build(), None)
                            .await
                            .context("query open orders after API credential rotation")?
                    }
                    Err(retry_error) => {
                        return Err(retry_error)
                            .context("query open orders after heartbeat refresh");
                    }
                }
            }
            Err(error) => return Err(error).context("query open orders"),
        };
        if !orders.data.is_empty() {
            return Ok(true);
        }

        self.data_api
            .has_market_trade(self.data_api_user, market)
            .await
            .context("query Data API trade exposure")
    }

    pub async fn reconcile_market_exposure(
        &self,
        condition_ids: &[String],
        max_recent_trades: usize,
    ) -> Result<MarketExposureSnapshot> {
        let requested = parse_condition_ids(condition_ids)?;
        if requested.is_empty() {
            return Ok(MarketExposureSnapshot::default());
        }

        let open_order_markets = self
            .open_order_markets_for(&requested)
            .await
            .context("reconcile open order exposure")?;
        let traded_markets = self
            .recent_trade_markets_for(&requested, max_recent_trades)
            .await
            .context("reconcile trade exposure")?;

        Ok(MarketExposureSnapshot {
            open_order_markets,
            traded_markets: traded_markets.markets,
            fills: traded_markets.fills,
        })
    }

    pub async fn execute(&self, request: &LiveOrderRequest) -> Result<LiveOrderResponse> {
        let token_id = U256::from_str(&request.token_id).context("parse token id")?;
        let price = probability_decimal_truncated_decimal("limit_price", request.limit_price, 4)?;
        let size = positive_decimal_truncated_decimal(
            "size_shares",
            request.size_shares,
            LIVE_ORDER_SIZE_SCALE,
        )?;

        let client = self.current_client().await;
        let response = match client
            .limit_order()
            .token_id(token_id)
            .side(Side::Buy)
            .price(price)
            .size(size)
            .expiration(request.expires_at)
            .order_type(OrderType::GTD)
            .post_only(true)
            .build_sign_and_post(&self.signer)
            .await
        {
            Ok(response) => response,
            Err(error) if is_l2_auth_error(&error) => {
                if let Err(rotate_error) = self
                    .rotate_api_key_after_l2_auth_error("order", &error)
                    .await
                {
                    warn!(
                        event = "live_api_key_rotate_error",
                        error = %format!("{rotate_error:#}"),
                        "failed to rotate Polymarket API credentials after order auth error"
                    );
                }
                return Err(error).context("post live Polymarket maker order");
            }
            Err(error) => return Err(error).context("post live Polymarket maker order"),
        };

        Ok(LiveOrderResponse::from(response))
    }

    async fn current_client(&self) -> AuthenticatedClient {
        self.client.lock().await.clone()
    }

    pub async fn current_credentials(&self) -> Credentials {
        self.current_client().await.credentials().clone()
    }

    pub fn user_address(&self) -> Address {
        self.data_api_user
    }

    async fn open_order_markets_for(
        &self,
        requested: &HashMap<B256, String>,
    ) -> Result<HashSet<String>> {
        let request = OrdersRequest::builder().build();
        let mut cursor = None;
        let mut markets = HashSet::new();

        loop {
            let page = self.orders_page(&request, cursor.take()).await?;
            for order in page.data {
                if let Some(condition_id) = requested.get(&order.market) {
                    markets.insert(condition_id.clone());
                }
            }
            if page.next_cursor == TERMINAL_CURSOR {
                break;
            }
            cursor = Some(page.next_cursor);
        }

        Ok(markets)
    }

    async fn recent_trade_markets_for(
        &self,
        requested: &HashMap<B256, String>,
        max_recent_trades: usize,
    ) -> Result<RecentTradeExposure> {
        if max_recent_trades == 0 {
            return Ok(RecentTradeExposure::default());
        }

        let trades = self
            .data_api
            .fetch_trades(self.data_api_user, max_recent_trades)
            .await
            .context("fetch recent Data API trades for exposure reconciliation")?;
        let mut exposure = RecentTradeExposure::default();
        for trade in trades {
            let Some(condition_id) = requested.get(&trade.condition_id).cloned() else {
                continue;
            };
            exposure.markets.insert(condition_id.clone());
            if is_buy(&trade.side)
                && let Some(fill) = live_fill_from_data_trade(condition_id, &trade)
            {
                exposure.fills.push(fill);
            }
        }

        Ok(exposure)
    }

    async fn orders_page(
        &self,
        request: &OrdersRequest,
        next_cursor: Option<String>,
    ) -> Result<Page<OpenOrderResponse>> {
        let mut client = self.current_client().await;
        match client.orders(request, next_cursor.clone()).await {
            Ok(orders) => Ok(orders),
            Err(error) if is_l2_auth_error(&error) => {
                warn!(
                    event = "live_auth_refresh",
                    endpoint = "data/orders",
                    error = %error,
                    "refreshing heartbeat after L2 auth error"
                );
                refresh_heartbeat(&client, &self.heartbeat_state)
                    .await
                    .context("refresh CLOB heartbeat after open-orders auth error")?;
                match client.orders(request, next_cursor.clone()).await {
                    Ok(orders) => Ok(orders),
                    Err(retry_error) if is_l2_auth_error(&retry_error) => {
                        client = self
                            .rotate_api_key_after_l2_auth_error("data/orders", &retry_error)
                            .await?;
                        client
                            .orders(request, next_cursor)
                            .await
                            .context("query open orders after API credential rotation")
                    }
                    Err(retry_error) => {
                        Err(retry_error).context("query open orders after heartbeat refresh")
                    }
                }
            }
            Err(error) => Err(error).context("query open orders"),
        }
    }

    async fn rotate_api_key_after_l2_auth_error(
        &self,
        endpoint: &'static str,
        error: &PolymarketError,
    ) -> Result<AuthenticatedClient> {
        recover_client_after_l2_auth_error(
            Some(&self.client),
            &self.heartbeat_state,
            &self.auth_config,
            &self.signer,
            &self.credential_rotation_lock,
            endpoint,
            &error.to_string(),
            Some(self.current_client().await.credentials().key()),
        )
        .await
        .context("recover CLOB client after L2 auth error")
    }
}

fn positive_decimal_truncated_decimal(name: &str, value: Decimal, scale: u32) -> Result<Decimal> {
    let decimal = value.trunc_with_scale(scale).normalize();
    if decimal <= Decimal::ZERO {
        bail!("{name} must be positive after truncation");
    }

    Ok(decimal)
}

fn probability_decimal_truncated_decimal(
    name: &str,
    value: Decimal,
    scale: u32,
) -> Result<Decimal> {
    let decimal = positive_decimal_truncated_decimal(name, value, scale)?;
    validate_probability_decimal(name, decimal)
}

fn validate_probability_decimal(name: &str, decimal: Decimal) -> Result<Decimal> {
    if decimal >= Decimal::ONE {
        bail!("{name} must be below 1.0 after truncation");
    }

    Ok(decimal)
}

#[cfg(test)]
mod tests;
