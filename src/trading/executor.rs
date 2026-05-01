use std::{
    str::FromStr,
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use alloy::{
    core::sol,
    dyn_abi::Eip712Domain,
    hex::ToHexExt as _,
    signers::{Signer as _, local::PrivateKeySigner},
    sol_types::SolStruct as _,
};
use anyhow::{Context, Result, bail};
use polymarket_client_sdk_v2::{
    POLYGON,
    auth::{Credentials, Uuid},
    clob::{
        Client, Config,
        types::{
            Amount, AssetType, OrderType, Side, SignatureType,
            request::{BalanceAllowanceRequest, OrdersRequest, TradesRequest},
            response::{BalanceAllowanceResponse, HeartbeatResponse, PostOrderResponse},
        },
    },
    error::{Error as PolymarketError, Status as PolymarketStatus},
    types::{Address, B256, Decimal, U256},
};
use reqwest::header::{HeaderMap, HeaderValue};
use rust_decimal::prelude::FromPrimitive;
use serde::Deserialize;
use tokio::{sync::Mutex, task::JoinHandle};
use tracing::{info, warn};

use crate::{
    config::{LiveOrderType, PolymarketSignatureType, RuntimeConfig},
    domain::{asset::Asset, market::Outcome},
};

type AuthenticatedClient = Client<
    polymarket_client_sdk_v2::auth::state::Authenticated<polymarket_client_sdk_v2::auth::Normal>,
>;
type ClientState = Arc<Mutex<AuthenticatedClient>>;
type HeartbeatState = Arc<Mutex<Option<Uuid>>>;
const INITIAL_CURSOR: &str = "MA==";

sol! {
    struct ClobAuth {
        address address;
        string timestamp;
        uint256 nonce;
        string message;
    }
}

pub struct LiveTradeExecutor {
    client: ClientState,
    signer: PrivateKeySigner,
    auth_config: LiveAuthConfig,
    order_type: OrderType,
    heartbeat_state: HeartbeatState,
    _heartbeat_task: JoinHandle<()>,
}

impl LiveTradeExecutor {
    pub async fn from_config(config: &RuntimeConfig) -> Result<Self> {
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
            signature_type: config.polymarket_signature_type,
            funder_address,
        };
        let mut client = authenticate_client(&auth_config, &signer, CredentialSource::Configured)
            .await
            .context("authenticate CLOB client")?;
        let heartbeat_state = Arc::new(Mutex::new(None));
        if let Err(error) = refresh_heartbeat(&client, &heartbeat_state).await {
            if is_l2_auth_error_chain(&error) {
                let nonce = fresh_api_nonce()?;
                warn!(
                    event = "live_api_key_rotate",
                    endpoint = "startup/heartbeat",
                    nonce,
                    error = %format!("{error:#}"),
                    "creating fresh Polymarket API credentials after startup heartbeat auth error"
                );
                client =
                    authenticate_client(&auth_config, &signer, CredentialSource::FreshNonce(nonce))
                        .await
                        .context("authenticate CLOB client with fresh API credentials")?;
                reset_heartbeat(&heartbeat_state).await;
                refresh_heartbeat(&client, &heartbeat_state)
                    .await
                    .context("initialize CLOB heartbeat after API credential rotation")?;
                info!(
                    event = "live_api_key_rotated",
                    endpoint = "startup/heartbeat",
                    nonce,
                    api_key = %redacted_uuid(client.credentials().key()),
                    "fresh Polymarket API credentials installed"
                );
            } else {
                return Err(error).context("initialize CLOB heartbeat");
            }
        }
        let collateral = match validate_live_account(&client, &heartbeat_state).await {
            Ok(collateral) => collateral,
            Err(error) if is_l2_auth_error_chain(&error) => {
                let nonce = fresh_api_nonce()?;
                warn!(
                    event = "live_api_key_rotate",
                    nonce,
                    error = %format!("{error:#}"),
                    "creating fresh Polymarket API credentials after startup L2 auth error"
                );
                client =
                    authenticate_client(&auth_config, &signer, CredentialSource::FreshNonce(nonce))
                        .await
                        .context("authenticate CLOB client with fresh API credentials")?;
                reset_heartbeat(&heartbeat_state).await;
                refresh_heartbeat(&client, &heartbeat_state)
                    .await
                    .context("initialize CLOB heartbeat after API credential rotation")?;
                let collateral = validate_live_account(&client, &heartbeat_state)
                    .await
                    .context("validate live account after API credential rotation")?;
                info!(
                    event = "live_api_key_rotated",
                    nonce,
                    api_key = %redacted_uuid(client.credentials().key()),
                    "fresh Polymarket API credentials installed"
                );
                collateral
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
            ),
            client,
            signer,
            auth_config,
            order_type: map_order_type(config.live_order_type),
            heartbeat_state,
        })
    }

    pub async fn has_market_exposure(&self, condition_id: &str) -> Result<bool> {
        let market = B256::from_str(condition_id).context("parse market condition id")?;
        let orders_request = OrdersRequest::builder().market(market).build();
        let mut client = self.current_client().await;
        let orders = match client
            .orders(&orders_request, Some(INITIAL_CURSOR.to_string()))
            .await
        {
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
                    .orders(
                        &OrdersRequest::builder().market(market).build(),
                        Some(INITIAL_CURSOR.to_string()),
                    )
                    .await
                {
                    Ok(orders) => orders,
                    Err(retry_error) if is_l2_auth_error(&retry_error) => {
                        client = self
                            .rotate_api_key_after_l2_auth_error("data/orders", &retry_error)
                            .await?;
                        client
                            .orders(
                                &OrdersRequest::builder().market(market).build(),
                                Some(INITIAL_CURSOR.to_string()),
                            )
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

        let trades_request = TradesRequest::builder().market(market).build();
        let trades = match client
            .trades(&trades_request, Some(INITIAL_CURSOR.to_string()))
            .await
        {
            Ok(trades) => trades,
            Err(error) if is_l2_auth_error(&error) => {
                warn!(
                    event = "live_auth_refresh",
                    endpoint = "data/trades",
                    error = %error,
                    "refreshing heartbeat after L2 auth error"
                );
                refresh_heartbeat(&client, &self.heartbeat_state)
                    .await
                    .context("refresh CLOB heartbeat after trades auth error")?;
                match client
                    .trades(
                        &TradesRequest::builder().market(market).build(),
                        Some(INITIAL_CURSOR.to_string()),
                    )
                    .await
                {
                    Ok(trades) => trades,
                    Err(retry_error) if is_l2_auth_error(&retry_error) => {
                        client = self
                            .rotate_api_key_after_l2_auth_error("data/trades", &retry_error)
                            .await?;
                        client
                            .trades(
                                &TradesRequest::builder().market(market).build(),
                                Some(INITIAL_CURSOR.to_string()),
                            )
                            .await
                            .context("query trade history after API credential rotation")?
                    }
                    Err(retry_error) => {
                        return Err(retry_error)
                            .context("query trade history after heartbeat refresh");
                    }
                }
            }
            Err(error) => return Err(error).context("query trade history"),
        };

        Ok(!trades.data.is_empty())
    }

    pub async fn execute(&self, request: &LiveOrderRequest) -> Result<LiveOrderResponse> {
        let token_id = U256::from_str(&request.token_id).context("parse token id")?;
        let amount = positive_decimal_truncated("amount_usdc", request.amount_usdc, 2)?;
        let price = probability_decimal_truncated("max_price", request.max_price, 2)?;

        let client = self.current_client().await;
        let response = match client
            .market_order()
            .token_id(token_id)
            .side(Side::Buy)
            .amount(Amount::usdc(amount).context("build USDC order amount")?)
            .price(price)
            .order_type(self.order_type.clone())
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
                return Err(error).context("post live Polymarket order");
            }
            Err(error) => return Err(error).context("post live Polymarket order"),
        };

        Ok(LiveOrderResponse::from(response))
    }

    async fn current_client(&self) -> AuthenticatedClient {
        self.client.lock().await.clone()
    }

    async fn rotate_api_key_after_l2_auth_error(
        &self,
        endpoint: &'static str,
        error: &PolymarketError,
    ) -> Result<AuthenticatedClient> {
        let nonce = fresh_api_nonce()?;
        warn!(
            event = "live_api_key_rotate",
            endpoint,
            nonce,
            error = %error,
            "creating fresh Polymarket API credentials after L2 auth error"
        );
        let client = authenticate_client(
            &self.auth_config,
            &self.signer,
            CredentialSource::FreshNonce(nonce),
        )
        .await
        .context("authenticate CLOB client with fresh API credentials")?;
        reset_heartbeat(&self.heartbeat_state).await;
        refresh_heartbeat(&client, &self.heartbeat_state)
            .await
            .context("refresh CLOB heartbeat after API credential rotation")?;
        {
            let mut current = self.client.lock().await;
            *current = client.clone();
        }
        info!(
            event = "live_api_key_rotated",
            endpoint,
            nonce,
            api_key = %redacted_uuid(client.credentials().key()),
            "fresh Polymarket API credentials installed"
        );
        Ok(client)
    }
}

#[derive(Clone, Debug)]
struct LiveAuthConfig {
    clob_api_url: String,
    credentials: Option<Credentials>,
    nonce: Option<u32>,
    signature_type: PolymarketSignatureType,
    funder_address: Option<Address>,
}

#[derive(Clone, Copy, Debug)]
enum CredentialSource {
    Configured,
    FreshNonce(u32),
}

async fn authenticate_client(
    config: &LiveAuthConfig,
    signer: &PrivateKeySigner,
    credential_source: CredentialSource,
) -> Result<AuthenticatedClient> {
    let client = Client::new(
        &config.clob_api_url,
        Config::builder().use_server_time(true).build(),
    )
    .with_context(|| format!("create CLOB client for {}", config.clob_api_url))?;
    let fresh_credentials = match credential_source {
        CredentialSource::FreshNonce(nonce) => Some(
            create_fresh_api_key(config, signer, nonce)
                .await
                .context("create fresh CLOB API key")?,
        ),
        CredentialSource::Configured => None,
    };
    let mut auth = client
        .authentication_builder(signer)
        .signature_type(map_signature_type(config.signature_type));

    if let Some(funder_address) = config.funder_address {
        auth = auth.funder(funder_address);
    }

    match credential_source {
        CredentialSource::Configured => {
            if let Some(credentials) = config.credentials.clone() {
                auth = auth.credentials(credentials);
            } else if let Some(nonce) = config.nonce {
                auth = auth.nonce(nonce);
            }
        }
        CredentialSource::FreshNonce(nonce) => {
            let credentials = fresh_credentials
                .with_context(|| format!("missing fresh API key nonce {nonce}"))?;
            auth = auth.credentials(credentials);
        }
    }

    auth.authenticate()
        .await
        .context("authenticate CLOB client")
}

async fn create_fresh_api_key(
    config: &LiveAuthConfig,
    signer: &PrivateKeySigner,
    nonce: u32,
) -> Result<Credentials> {
    let http = reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (compatible; wiggler-auth/1.0)")
        .build()
        .context("build Polymarket auth HTTP client")?;
    let timestamp = http
        .get(format!(
            "{}/time",
            config.clob_api_url.trim_end_matches('/')
        ))
        .send()
        .await
        .context("request CLOB time")?
        .error_for_status()
        .context("CLOB time returned error")?
        .text()
        .await
        .context("read CLOB time")?
        .trim()
        .to_string();

    let auth = ClobAuth {
        address: signer.address(),
        timestamp: timestamp.clone(),
        nonce: U256::from(nonce),
        message: "This message attests that I control the given wallet".to_string(),
    };
    let domain = Eip712Domain {
        name: Some("ClobAuthDomain".into()),
        version: Some("1".into()),
        chain_id: Some(U256::from(POLYGON)),
        ..Eip712Domain::default()
    };
    let signature = signer
        .sign_hash(&auth.eip712_signing_hash(&domain))
        .await
        .context("sign CLOB auth hash")?;

    let mut headers = HeaderMap::new();
    headers.insert(
        "POLY_ADDRESS",
        HeaderValue::from_str(&signer.address().encode_hex_with_prefix())
            .context("build POLY_ADDRESS header")?,
    );
    headers.insert(
        "POLY_NONCE",
        HeaderValue::from_str(&nonce.to_string()).context("build POLY_NONCE header")?,
    );
    headers.insert(
        "POLY_SIGNATURE",
        HeaderValue::from_str(&signature.to_string()).context("build POLY_SIGNATURE header")?,
    );
    headers.insert(
        "POLY_TIMESTAMP",
        HeaderValue::from_str(&timestamp).context("build POLY_TIMESTAMP header")?,
    );
    headers.insert("ACCEPT", HeaderValue::from_static("application/json"));
    headers.insert("CONTENT-TYPE", HeaderValue::from_static("application/json"));

    let response = http
        .post(format!(
            "{}/auth/api-key",
            config.clob_api_url.trim_end_matches('/')
        ))
        .headers(headers)
        .body("{}")
        .send()
        .await
        .with_context(|| format!("create CLOB API key with nonce {nonce}"))?;
    let status = response.status();
    let text = response
        .text()
        .await
        .context("read CLOB API key response")?;
    if !status.is_success() {
        bail!(
            "create CLOB API key failed status={} body_prefix={}",
            status,
            &text[..text.len().min(300)]
        );
    }
    let credentials: ApiCredentialsBody =
        serde_json::from_str(&text).context("parse CLOB API key response")?;
    Ok(Credentials::new(
        Uuid::parse_str(&credentials.api_key).context("parse CLOB API key")?,
        credentials.secret,
        credentials.passphrase,
    ))
}

async fn validate_live_account(
    client: &AuthenticatedClient,
    heartbeat_state: &HeartbeatState,
) -> Result<BalanceAllowanceResponse> {
    let closed_only = match client.closed_only_mode().await {
        Ok(closed_only) => closed_only,
        Err(error) if is_l2_auth_error(&error) => {
            warn!(
                event = "live_auth_refresh",
                endpoint = "auth/ban-status/closed-only",
                error = %error,
                "refreshing heartbeat after startup L2 auth error"
            );
            refresh_heartbeat(client, heartbeat_state)
                .await
                .context("refresh CLOB heartbeat after closed-only auth error")?;
            client
                .closed_only_mode()
                .await
                .context("check CLOB closed-only mode after heartbeat refresh")?
        }
        Err(error) => return Err(error).context("check CLOB closed-only mode"),
    };
    if closed_only.closed_only {
        bail!("Polymarket account is in closed-only mode");
    }

    let collateral_request = BalanceAllowanceRequest::builder()
        .asset_type(AssetType::Collateral)
        .build();
    match client
        .update_balance_allowance(collateral_request.clone())
        .await
    {
        Ok(()) => {}
        Err(error) if is_l2_auth_error(&error) => {
            warn!(
                event = "live_auth_refresh",
                endpoint = "balance-allowance/update",
                error = %error,
                "refreshing heartbeat after balance refresh auth error"
            );
            refresh_heartbeat(client, heartbeat_state)
                .await
                .context("refresh CLOB heartbeat after balance refresh auth error")?;
            if let Err(retry_error) = client
                .update_balance_allowance(collateral_request.clone())
                .await
            {
                warn!(
                    error = %format!("{retry_error:#}"),
                    "failed to refresh CLOB collateral balance allowance after heartbeat refresh"
                );
            }
        }
        Err(error) => {
            warn!(
                error = %format!("{error:#}"),
                "failed to refresh CLOB collateral balance allowance"
            );
        }
    }
    match client.balance_allowance(collateral_request.clone()).await {
        Ok(collateral) => Ok(collateral),
        Err(error) if is_l2_auth_error(&error) => {
            warn!(
                event = "live_auth_refresh",
                endpoint = "balance-allowance",
                error = %error,
                "refreshing heartbeat after balance query auth error"
            );
            refresh_heartbeat(client, heartbeat_state)
                .await
                .context("refresh CLOB heartbeat after balance query auth error")?;
            client
                .balance_allowance(collateral_request)
                .await
                .context("query CLOB collateral balance allowance after heartbeat refresh")
        }
        Err(error) => Err(error).context("query CLOB collateral balance allowance"),
    }
}

#[derive(Deserialize)]
struct HeartbeatErrorBody {
    heartbeat_id: Option<Uuid>,
    error_msg: Option<String>,
    error: Option<String>,
}

#[derive(Deserialize)]
struct ApiCredentialsBody {
    #[serde(alias = "apiKey")]
    api_key: String,
    secret: String,
    passphrase: String,
}

async fn refresh_heartbeat(
    client: &AuthenticatedClient,
    heartbeat_state: &HeartbeatState,
) -> Result<Option<Uuid>> {
    let mut heartbeat_id = heartbeat_state.lock().await;
    let previous = heartbeat_id.to_owned();

    match client.post_heartbeat(previous).await {
        Ok(response) => {
            if previous.is_none() || response.error.is_some() {
                log_heartbeat_response("live_heartbeat_ok", &response);
            }
            *heartbeat_id = Some(response.heartbeat_id);
            Ok(Some(response.heartbeat_id))
        }
        Err(error) => {
            if is_l2_auth_error(&error) {
                return Err(error).context("post CLOB heartbeat");
            }
            let Some(resynced_heartbeat_id) = heartbeat_id_from_error(&error) else {
                return Err(error).context("post initial CLOB heartbeat");
            };
            warn!(
                event = "live_heartbeat_resynced",
                heartbeat_id = %resynced_heartbeat_id,
                error = %error,
                "live trading heartbeat id resynchronized"
            );
            let response = client
                .post_heartbeat(Some(resynced_heartbeat_id))
                .await
                .context("post resynchronized CLOB heartbeat")?;
            log_heartbeat_response("live_heartbeat_ok", &response);
            *heartbeat_id = Some(response.heartbeat_id);
            Ok(Some(response.heartbeat_id))
        }
    }
}

async fn reset_heartbeat(heartbeat_state: &HeartbeatState) {
    *heartbeat_state.lock().await = None;
}

fn spawn_heartbeat_task(client: ClientState, heartbeat_state: HeartbeatState) -> JoinHandle<()> {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(5));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        interval.tick().await;

        loop {
            interval.tick().await;
            let client = client.lock().await.clone();
            if let Err(error) = refresh_heartbeat(&client, &heartbeat_state).await {
                warn!(
                    event = "live_heartbeat_error",
                    error = %format!("{error:#}"),
                    "live trading heartbeat failed"
                );
            }
        }
    })
}

fn log_heartbeat_response(event: &'static str, response: &HeartbeatResponse) {
    if let Some(error) = &response.error {
        warn!(
            event = event,
            heartbeat_id = %response.heartbeat_id,
            error = %error,
            "live trading heartbeat returned an error"
        );
    } else {
        info!(
            event = event,
            heartbeat_id = %response.heartbeat_id,
            "live trading heartbeat accepted"
        );
    }
}

fn heartbeat_id_from_error(error: &PolymarketError) -> Option<Uuid> {
    let status = error.downcast_ref::<PolymarketStatus>()?;
    let body: HeartbeatErrorBody = serde_json::from_str(&status.message).ok()?;
    if let Some(error_msg) = body.error_msg.as_deref().or(body.error.as_deref()) {
        warn!(
            event = "live_heartbeat_server_error",
            error = %error_msg,
            "live trading heartbeat server returned recoverable error"
        );
    }

    body.heartbeat_id
}

fn fresh_api_nonce() -> Result<u32> {
    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .context("system clock is before Unix epoch")?
        .as_secs();
    u32::try_from(seconds).context("current Unix timestamp exceeds u32 nonce range")
}

fn redacted_uuid(value: Uuid) -> String {
    let value = value.to_string();
    let suffix_start = value.len().saturating_sub(4);
    format!("{}...{}", &value[..8], &value[suffix_start..])
}

fn is_l2_auth_error(error: &PolymarketError) -> bool {
    let Some(status) = error.downcast_ref::<PolymarketStatus>() else {
        return false;
    };

    is_invalid_api_key_status(status)
}

fn is_l2_auth_error_chain(error: &anyhow::Error) -> bool {
    error.chain().any(|cause| {
        cause
            .downcast_ref::<PolymarketError>()
            .is_some_and(is_l2_auth_error)
            || cause
                .downcast_ref::<PolymarketStatus>()
                .is_some_and(is_invalid_api_key_status)
    })
}

fn is_invalid_api_key_status(status: &PolymarketStatus) -> bool {
    status.status_code == polymarket_client_sdk_v2::error::StatusCode::UNAUTHORIZED
        && status.message.contains("Invalid api key")
}

#[derive(Clone, Debug)]
pub struct LiveOrderRequest {
    pub asset: Asset,
    pub slug: String,
    pub condition_id: String,
    pub token_id: String,
    pub outcome: Outcome,
    pub amount_usdc: f64,
    pub max_price: f64,
}

impl LiveOrderRequest {
    pub fn outcome_label(&self) -> &'static str {
        match self.outcome {
            Outcome::Up => "Up",
            Outcome::Down => "Down",
            Outcome::Other(_) => "Other",
        }
    }
}

#[derive(Clone, Debug)]
pub struct LiveOrderResponse {
    pub order_id: String,
    pub status: String,
    pub success: bool,
    pub error_msg: Option<String>,
    pub making_amount: String,
    pub taking_amount: String,
    pub trade_ids: Vec<String>,
}

impl LiveOrderResponse {
    pub fn has_fill(&self) -> bool {
        self.success && (!self.trade_ids.is_empty() || self.taking_amount != "0")
    }

    pub fn filled_amount_usdc(&self) -> Option<f64> {
        positive_f64(&self.making_amount)
    }

    pub fn filled_payout_usdc(&self) -> Option<f64> {
        positive_f64(&self.taking_amount)
    }
}

impl From<PostOrderResponse> for LiveOrderResponse {
    fn from(value: PostOrderResponse) -> Self {
        Self {
            order_id: value.order_id,
            status: value.status.to_string(),
            success: value.success,
            error_msg: value.error_msg,
            making_amount: value.making_amount.to_string(),
            taking_amount: value.taking_amount.to_string(),
            trade_ids: value.trade_ids,
        }
    }
}

fn positive_f64(value: &str) -> Option<f64> {
    value
        .parse::<f64>()
        .ok()
        .filter(|value| value.is_finite() && *value > 0.0)
}

fn credentials_from_config(config: &RuntimeConfig) -> Result<Option<Credentials>> {
    match (
        &config.polymarket_api_key,
        &config.polymarket_api_secret,
        &config.polymarket_api_passphrase,
    ) {
        (None, None, None) => Ok(None),
        (Some(key), Some(secret), Some(passphrase)) => Ok(Some(Credentials::new(
            Uuid::parse_str(key).context("parse POLYMARKET_API_KEY")?,
            secret.clone(),
            passphrase.clone(),
        ))),
        _ => bail!(
            "POLYMARKET_API_KEY, POLYMARKET_API_SECRET, and POLYMARKET_API_PASSPHRASE must be set together"
        ),
    }
}

fn map_order_type(value: LiveOrderType) -> OrderType {
    match value {
        LiveOrderType::Fak => OrderType::FAK,
        LiveOrderType::Fok => OrderType::FOK,
    }
}

fn map_signature_type(value: PolymarketSignatureType) -> SignatureType {
    match value {
        PolymarketSignatureType::Eoa => SignatureType::Eoa,
        PolymarketSignatureType::Proxy => SignatureType::Proxy,
        PolymarketSignatureType::GnosisSafe => SignatureType::GnosisSafe,
        PolymarketSignatureType::Poly1271 => SignatureType::Poly1271,
    }
}

fn validate_funder_address(
    signature_type: PolymarketSignatureType,
    signer_address: Address,
    funder_address: Address,
) -> Result<()> {
    if matches!(
        signature_type,
        PolymarketSignatureType::Proxy | PolymarketSignatureType::GnosisSafe
    ) && funder_address == signer_address
    {
        bail!(
            "POLYMARKET_FUNDER_ADDRESS must be the Polymarket proxy/safe wallet for {:?}, not the signing EOA; unset it to let the SDK derive the wallet or set the profile wallet address",
            signature_type
        );
    }

    Ok(())
}

fn positive_decimal_truncated(name: &str, value: f64, scale: u32) -> Result<Decimal> {
    let decimal = Decimal::from_f64(value)
        .with_context(|| format!("convert {name} to decimal"))?
        .trunc_with_scale(scale);
    if decimal <= Decimal::ZERO {
        bail!("{name} must be positive after truncation");
    }

    Ok(decimal)
}

fn probability_decimal_truncated(name: &str, value: f64, scale: u32) -> Result<Decimal> {
    let decimal = positive_decimal_truncated(name, value, scale)?;
    if decimal >= Decimal::ONE {
        bail!("{name} must be below 1.0 after truncation");
    }

    Ok(decimal)
}

#[cfg(test)]
mod tests {
    use polymarket_client_sdk_v2::types::address;

    use super::{
        positive_decimal_truncated, probability_decimal_truncated, validate_funder_address,
    };
    use crate::config::PolymarketSignatureType;

    #[test]
    fn truncates_live_order_amount_without_rounding_up() {
        let amount = positive_decimal_truncated("amount_usdc", 25.009, 2).unwrap();
        assert_eq!(amount.to_string(), "25.00");
    }

    #[test]
    fn truncates_max_price_without_crossing_above_limit() {
        let price = probability_decimal_truncated("max_price", 0.849, 2).unwrap();
        assert_eq!(price.to_string(), "0.84");
    }

    #[test]
    fn rejects_proxy_funder_that_matches_signer() {
        let signer = address!("0x1111111111111111111111111111111111111111");
        let result = validate_funder_address(PolymarketSignatureType::GnosisSafe, signer, signer);

        assert!(result.is_err());
    }

    #[test]
    fn allows_proxy_funder_distinct_from_signer() {
        let signer = address!("0x1111111111111111111111111111111111111111");
        let funder = address!("0x2222222222222222222222222222222222222222");
        let result = validate_funder_address(PolymarketSignatureType::GnosisSafe, signer, funder);

        assert!(result.is_ok());
    }
}
