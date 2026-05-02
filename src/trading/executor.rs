use std::{
    collections::HashMap,
    fs,
    io::Write as _,
    path::{Path, PathBuf},
    str::FromStr,
    sync::{
        Arc,
        atomic::{AtomicU32, Ordering},
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
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
    auth::{Credentials, ExposeSecret as _, Uuid},
    clob::{
        Client, Config,
        types::{
            AssetType, OrderType, Side, SignatureType,
            request::{BalanceAllowanceRequest, OrdersRequest},
            response::{BalanceAllowanceResponse, HeartbeatResponse},
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
    config::{PolymarketSignatureType, RuntimeConfig},
    polymarket::data::DataApiClient,
    telegram::TelegramClient,
    trading::order::{LiveOrderRequest, LiveOrderResponse},
};

type AuthenticatedClient = Client<
    polymarket_client_sdk_v2::auth::state::Authenticated<polymarket_client_sdk_v2::auth::Normal>,
>;
type ClientState = Arc<Mutex<AuthenticatedClient>>;
type HeartbeatState = Arc<Mutex<Option<Uuid>>>;
type CredentialRotationLock = Arc<Mutex<()>>;
static LAST_FRESH_API_NONCE: AtomicU32 = AtomicU32::new(0);

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

    pub async fn execute(&self, request: &LiveOrderRequest) -> Result<LiveOrderResponse> {
        let token_id = U256::from_str(&request.token_id).context("parse token id")?;
        let price = probability_decimal_truncated_decimal("limit_price", request.limit_price, 4)?;
        let size = positive_decimal_truncated_decimal("size_shares", request.size_shares, 6)?;

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

#[derive(Clone, Debug)]
struct LiveAuthConfig {
    clob_api_url: String,
    credentials: Option<Credentials>,
    nonce: Option<u32>,
    credential_file: PathBuf,
    signature_type: PolymarketSignatureType,
    funder_address: Option<Address>,
}

#[derive(Clone, Copy, Debug)]
enum CredentialSource {
    Configured,
    DerivedNonce(u32),
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
    let credentials = credentials_for_source(config, signer, credential_source).await?;
    let mut auth = client
        .authentication_builder(signer)
        .signature_type(map_signature_type(config.signature_type));

    if let Some(funder_address) = config.funder_address {
        auth = auth.funder(funder_address);
    }

    if let Some(credentials) = credentials {
        auth = auth.credentials(credentials);
    } else if let Some(nonce) = config.nonce {
        auth = auth.nonce(nonce);
    }

    auth.authenticate()
        .await
        .context("authenticate CLOB client")
}

async fn credentials_for_source(
    config: &LiveAuthConfig,
    signer: &PrivateKeySigner,
    credential_source: CredentialSource,
) -> Result<Option<Credentials>> {
    match credential_source {
        CredentialSource::Configured => {
            if let Some(cached) = read_credentials_cache(&config.credential_file)? {
                info!(
                    event = "live_api_key_cache_loaded",
                    nonce = ?cached.nonce,
                    api_key = %redacted_uuid(cached.credentials.key()),
                    path = %config.credential_file.display(),
                    "loaded cached Polymarket API credentials"
                );
                return Ok(Some(cached.credentials));
            }

            if let Some(credentials) = &config.credentials {
                return Ok(Some(credentials.clone()));
            }

            if let Some(nonce) = config.nonce {
                match derive_api_key(config, signer, nonce).await {
                    Ok(credentials) => {
                        write_credentials_cache(&config.credential_file, &credentials, nonce)?;
                        warn!(
                            event = "live_api_key_derived",
                            endpoint = "startup/configured-nonce",
                            nonce,
                            api_key = %redacted_uuid(credentials.key()),
                            path = %config.credential_file.display(),
                            "derived and cached Polymarket API credentials"
                        );
                        return Ok(Some(credentials));
                    }
                    Err(error) => {
                        warn!(
                            event = "live_api_key_derive_error",
                            endpoint = "startup/configured-nonce",
                            nonce,
                            error = %format!("{error:#}"),
                            "failed to derive Polymarket API credentials"
                        );
                    }
                }
            }

            let nonce = fresh_api_nonce()?;
            let credentials = create_fresh_api_key(config, signer, nonce)
                .await
                .context("create fresh CLOB API key")?;
            write_credentials_cache(&config.credential_file, &credentials, nonce)?;
            warn!(
                event = "live_api_key_rotated",
                endpoint = "startup/missing-credentials",
                nonce,
                api_key = %redacted_uuid(credentials.key()),
                path = %config.credential_file.display(),
                "fresh Polymarket API credentials created and cached"
            );
            Ok(Some(credentials))
        }
        CredentialSource::DerivedNonce(nonce) => {
            let credentials = derive_api_key(config, signer, nonce)
                .await
                .with_context(|| format!("derive CLOB API key with nonce {nonce}"))?;
            write_credentials_cache(&config.credential_file, &credentials, nonce)?;
            Ok(Some(credentials))
        }
        CredentialSource::FreshNonce(nonce) => {
            let credentials = create_fresh_api_key(config, signer, nonce)
                .await
                .context("create fresh CLOB API key")?;
            write_credentials_cache(&config.credential_file, &credentials, nonce)?;
            Ok(Some(credentials))
        }
    }
}

async fn derive_api_key(
    config: &LiveAuthConfig,
    signer: &PrivateKeySigner,
    nonce: u32,
) -> Result<Credentials> {
    request_api_key(config, signer, nonce, ApiKeyRequestMode::Derive).await
}

async fn create_fresh_api_key(
    config: &LiveAuthConfig,
    signer: &PrivateKeySigner,
    nonce: u32,
) -> Result<Credentials> {
    request_api_key(config, signer, nonce, ApiKeyRequestMode::Create).await
}

#[derive(Clone, Copy)]
enum ApiKeyRequestMode {
    Create,
    Derive,
}

async fn request_api_key(
    config: &LiveAuthConfig,
    signer: &PrivateKeySigner,
    nonce: u32,
    mode: ApiKeyRequestMode,
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

    let mode_text = match mode {
        ApiKeyRequestMode::Create => "create",
        ApiKeyRequestMode::Derive => "derive",
    };
    let url = match mode {
        ApiKeyRequestMode::Create => {
            format!("{}/auth/api-key", config.clob_api_url.trim_end_matches('/'))
        }
        ApiKeyRequestMode::Derive => format!(
            "{}/auth/derive-api-key",
            config.clob_api_url.trim_end_matches('/')
        ),
    };
    let request = match mode {
        ApiKeyRequestMode::Create => http.post(url).headers(headers).body("{}"),
        ApiKeyRequestMode::Derive => http.get(url).headers(headers),
    };
    let response = request
        .send()
        .await
        .with_context(|| format!("{mode_text} CLOB API key with nonce {nonce}"))?;
    let status = response.status();
    let text = response
        .text()
        .await
        .context("read CLOB API key response")?;
    if !status.is_success() {
        bail!(
            "{} CLOB API key failed status={} body_prefix={}",
            mode_text,
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

#[allow(clippy::too_many_arguments)]
async fn recover_client_after_l2_auth_error(
    client_state: Option<&ClientState>,
    heartbeat_state: &HeartbeatState,
    auth_config: &LiveAuthConfig,
    signer: &PrivateKeySigner,
    credential_rotation_lock: &CredentialRotationLock,
    endpoint: &'static str,
    error: &str,
    failed_api_key: Option<Uuid>,
) -> Result<AuthenticatedClient> {
    let _guard = credential_rotation_lock.lock().await;

    if let Some(client_state) = client_state {
        let current = client_state.lock().await.clone();
        if failed_api_key.is_some_and(|failed| current.credentials().key() != failed) {
            info!(
                event = "live_api_key_recovery_reused",
                endpoint,
                api_key = %redacted_uuid(current.credentials().key()),
                "Polymarket API credentials were already rotated by another task"
            );
            return Ok(current);
        }
    }

    for nonce in credential_nonce_candidates(auth_config)? {
        warn!(
            event = "live_api_key_derive",
            endpoint, nonce, error, "deriving Polymarket API credentials after L2 auth error"
        );
        match authenticate_client(auth_config, signer, CredentialSource::DerivedNonce(nonce)).await
        {
            Ok(client) => {
                reset_heartbeat(heartbeat_state).await;
                refresh_heartbeat(&client, heartbeat_state)
                    .await
                    .context("refresh CLOB heartbeat after API credential derivation")?;
                if let Some(client_state) = client_state {
                    let mut current = client_state.lock().await;
                    *current = client.clone();
                }
                warn!(
                    event = "live_api_key_derived",
                    endpoint,
                    nonce,
                    api_key = %redacted_uuid(client.credentials().key()),
                    path = %auth_config.credential_file.display(),
                    "derived and cached Polymarket API credentials"
                );
                return Ok(client);
            }
            Err(derive_error) => {
                warn!(
                    event = "live_api_key_derive_error",
                    endpoint,
                    nonce,
                    error = %format!("{derive_error:#}"),
                    "failed to derive Polymarket API credentials"
                );
            }
        }
    }

    let nonce = fresh_api_nonce()?;
    warn!(
        event = "live_api_key_rotate",
        endpoint, nonce, error, "creating fresh Polymarket API credentials after L2 auth error"
    );
    let client = authenticate_client(auth_config, signer, CredentialSource::FreshNonce(nonce))
        .await
        .context("authenticate CLOB client with fresh API credentials")?;
    reset_heartbeat(heartbeat_state).await;
    refresh_heartbeat(&client, heartbeat_state)
        .await
        .context("refresh CLOB heartbeat after API credential rotation")?;
    if let Some(client_state) = client_state {
        let mut current = client_state.lock().await;
        *current = client.clone();
    }
    warn!(
        event = "live_api_key_rotated",
        endpoint,
        nonce,
        api_key = %redacted_uuid(client.credentials().key()),
        path = %auth_config.credential_file.display(),
        "fresh Polymarket API credentials created and cached"
    );
    Ok(client)
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
struct ClobErrorBody {
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

fn spawn_heartbeat_task(
    client_state: ClientState,
    heartbeat_state: HeartbeatState,
    auth_config: LiveAuthConfig,
    signer: PrivateKeySigner,
    credential_rotation_lock: CredentialRotationLock,
    telegram: TelegramClient,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(5));
        let mut next_auth_error_telegram_at = Instant::now();
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        interval.tick().await;

        loop {
            interval.tick().await;
            let client = client_state.lock().await.clone();
            if let Err(error) = refresh_heartbeat(&client, &heartbeat_state).await {
                if is_l2_auth_error_chain(&error) {
                    let rotate_result = rotate_client_after_heartbeat_auth_error(
                        &client_state,
                        &heartbeat_state,
                        &auth_config,
                        &signer,
                        &credential_rotation_lock,
                        &error,
                    )
                    .await;
                    if let Err(rotate_error) = rotate_result {
                        let rotate_error = format!("{rotate_error:#}");
                        warn!(
                            event = "live_heartbeat_auth_recovery_error",
                            error = %rotate_error,
                            "failed to rotate Polymarket API credentials after heartbeat auth error"
                        );
                        let now = Instant::now();
                        if now >= next_auth_error_telegram_at {
                            next_auth_error_telegram_at = now + Duration::from_secs(300);
                            if let Err(telegram_error) = telegram
                                .send_message(&format!(
                                    "Live auth error: Polymarket heartbeat rejected the API key and automatic credential rotation failed. {rotate_error}"
                                ))
                                .await
                            {
                                warn!(
                                    error = %telegram_error,
                                    "failed to send live heartbeat auth error Telegram message"
                                );
                            }
                        }
                    }
                    continue;
                }
                warn!(
                    event = "live_heartbeat_error",
                    error = %format!("{error:#}"),
                    "live trading heartbeat failed"
                );
            }
        }
    })
}

async fn rotate_client_after_heartbeat_auth_error(
    client_state: &ClientState,
    heartbeat_state: &HeartbeatState,
    auth_config: &LiveAuthConfig,
    signer: &PrivateKeySigner,
    credential_rotation_lock: &CredentialRotationLock,
    error: &anyhow::Error,
) -> Result<()> {
    let failed_api_key = client_state.lock().await.credentials().key();
    recover_client_after_l2_auth_error(
        Some(client_state),
        heartbeat_state,
        auth_config,
        signer,
        credential_rotation_lock,
        "heartbeat",
        &format!("{error:#}"),
        Some(failed_api_key),
    )
    .await?;
    Ok(())
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
    let seconds =
        u32::try_from(seconds).context("current Unix timestamp exceeds u32 nonce range")?;
    reserve_fresh_api_nonce(&LAST_FRESH_API_NONCE, seconds)
}

fn reserve_fresh_api_nonce(last_nonce: &AtomicU32, base_nonce: u32) -> Result<u32> {
    let mut previous = last_nonce.load(Ordering::Relaxed);
    loop {
        let nonce = if base_nonce > previous {
            base_nonce
        } else {
            previous
                .checked_add(1)
                .context("fresh Polymarket API nonce range exhausted")?
        };

        match last_nonce.compare_exchange(previous, nonce, Ordering::AcqRel, Ordering::Relaxed) {
            Ok(_) => return Ok(nonce),
            Err(current) => previous = current,
        }
    }
}

fn redacted_uuid(value: Uuid) -> String {
    let value = value.to_string();
    let suffix_start = value.len().saturating_sub(4);
    format!("{}...{}", &value[..8], &value[suffix_start..])
}

#[derive(Clone)]
struct CachedCredentials {
    credentials: Credentials,
    nonce: Option<u32>,
}

fn read_credentials_cache(path: &Path) -> Result<Option<CachedCredentials>> {
    let text = match fs::read_to_string(path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error).with_context(|| format!("read {}", path.display())),
    };
    let values = parse_env_lines(&text);
    let Some(api_key) = values.get("POLYMARKET_API_KEY") else {
        return Ok(None);
    };
    let Some(secret) = values.get("POLYMARKET_API_SECRET") else {
        return Ok(None);
    };
    let Some(passphrase) = values.get("POLYMARKET_API_PASSPHRASE") else {
        return Ok(None);
    };
    let nonce = values
        .get("POLYMARKET_API_NONCE")
        .filter(|value| !value.is_empty())
        .map(|value| value.parse::<u32>())
        .transpose()
        .with_context(|| format!("parse POLYMARKET_API_NONCE in {}", path.display()))?;

    Ok(Some(CachedCredentials {
        credentials: Credentials::new(
            Uuid::parse_str(api_key)
                .with_context(|| format!("parse POLYMARKET_API_KEY in {}", path.display()))?,
            secret.clone(),
            passphrase.clone(),
        ),
        nonce,
    }))
}

fn write_credentials_cache(path: &Path, credentials: &Credentials, nonce: u32) -> Result<()> {
    if let Some(parent) = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
    {
        fs::create_dir_all(parent)
            .with_context(|| format!("create credential cache dir {}", parent.display()))?;
    }
    let temp_path = path.with_extension("tmp");
    let body = format!(
        "POLYMARKET_API_KEY={}\nPOLYMARKET_API_SECRET={}\nPOLYMARKET_API_PASSPHRASE={}\nPOLYMARKET_API_NONCE={}\n",
        credentials.key(),
        credentials.secret().expose_secret(),
        credentials.passphrase().expose_secret(),
        nonce
    );

    let mut options = fs::OpenOptions::new();
    options.create(true).truncate(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        options.mode(0o600);
    }
    {
        let mut file = options
            .open(&temp_path)
            .with_context(|| format!("write {}", temp_path.display()))?;
        file.write_all(body.as_bytes())
            .with_context(|| format!("write {}", temp_path.display()))?;
        file.sync_all()
            .with_context(|| format!("sync {}", temp_path.display()))?;
    }
    fs::rename(&temp_path, path).with_context(|| {
        format!(
            "rename credential cache {} to {}",
            temp_path.display(),
            path.display()
        )
    })?;
    Ok(())
}

fn parse_env_lines(text: &str) -> HashMap<String, String> {
    text.lines()
        .filter_map(|line| {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') {
                return None;
            }
            let (key, value) = line.split_once('=')?;
            Some((key.trim().to_string(), value.trim().to_string()))
        })
        .collect()
}

fn credential_nonce_candidates(config: &LiveAuthConfig) -> Result<Vec<u32>> {
    let mut nonces = Vec::new();
    if let Some(nonce) =
        read_credentials_cache(&config.credential_file)?.and_then(|cache| cache.nonce)
    {
        nonces.push(nonce);
    }
    if let Some(nonce) = config.nonce
        && !nonces.contains(&nonce)
    {
        nonces.push(nonce);
    }
    Ok(nonces)
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
    if status.status_code != polymarket_client_sdk_v2::error::StatusCode::UNAUTHORIZED {
        return false;
    }

    let message = clob_error_message(&status.message).unwrap_or_else(|| status.message.clone());
    let message = message.to_ascii_lowercase();
    message.contains("invalid api key")
        || (message.contains("api key") && message.contains("expired"))
        || (message.contains("api key") && message.contains("unauthorized"))
}

fn clob_error_message(raw: &str) -> Option<String> {
    let body: ClobErrorBody = serde_json::from_str(raw).ok()?;
    body.error_msg.or(body.error)
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

fn data_api_user_address(
    config: &RuntimeConfig,
    signer_address: Address,
    funder_address: Option<Address>,
) -> Result<Address> {
    if let Some(user) = &config.polymarket_user_address {
        return Address::from_str(user).context("parse POLYMARKET_USER_ADDRESS");
    }

    Ok(funder_address.unwrap_or(signer_address))
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
mod tests {
    use std::sync::atomic::{AtomicU32, Ordering};

    use polymarket_client_sdk_v2::auth::{Credentials, ExposeSecret as _, Uuid};
    use polymarket_client_sdk_v2::error::{
        Error as PolymarketError, Method, StatusCode as PolymarketStatusCode,
    };
    use polymarket_client_sdk_v2::types::{Decimal, address};
    use rust_decimal::prelude::FromPrimitive;

    use super::{
        LiveAuthConfig, credential_nonce_candidates, is_l2_auth_error, parse_env_lines,
        positive_decimal_truncated_decimal, probability_decimal_truncated_decimal,
        read_credentials_cache, reserve_fresh_api_nonce, validate_funder_address,
        write_credentials_cache,
    };
    use crate::config::PolymarketSignatureType;

    #[test]
    fn truncates_live_order_amount_without_rounding_up() {
        let amount = positive_decimal_truncated_decimal(
            "amount_usdc",
            Decimal::from_f64(25.009).unwrap(),
            2,
        )
        .unwrap();
        assert_eq!(amount.to_string(), "25");
    }

    #[test]
    fn truncates_limit_price_without_crossing_above_limit() {
        let price = probability_decimal_truncated_decimal(
            "limit_price",
            Decimal::from_f64(0.84919).unwrap(),
            4,
        )
        .unwrap();
        assert_eq!(price.to_string(), "0.8491");
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

    #[test]
    fn fresh_api_nonce_uses_base_when_newer_than_last() {
        let last_nonce = AtomicU32::new(10);
        let nonce = reserve_fresh_api_nonce(&last_nonce, 20).unwrap();

        assert_eq!(nonce, 20);
        assert_eq!(last_nonce.load(Ordering::Relaxed), 20);
    }

    #[test]
    fn fresh_api_nonce_increments_when_base_would_repeat() {
        let last_nonce = AtomicU32::new(0);

        assert_eq!(reserve_fresh_api_nonce(&last_nonce, 100).unwrap(), 100);
        assert_eq!(reserve_fresh_api_nonce(&last_nonce, 100).unwrap(), 101);
        assert_eq!(reserve_fresh_api_nonce(&last_nonce, 99).unwrap(), 102);
    }

    #[test]
    fn fresh_api_nonce_errors_when_exhausted() {
        let last_nonce = AtomicU32::new(u32::MAX);
        let result = reserve_fresh_api_nonce(&last_nonce, u32::MAX);

        assert!(result.is_err());
    }

    #[test]
    fn l2_auth_error_detects_json_invalid_api_key_message() {
        let status = unauthorized_status(r#"{"error":"Unauthorized/Invalid api key"}"#);

        assert!(is_l2_auth_error(&status));
    }

    #[test]
    fn l2_auth_error_detects_expired_api_key_message() {
        let status = unauthorized_status(r#"{"error":"API key expired"}"#);

        assert!(is_l2_auth_error(&status));
    }

    #[test]
    fn l2_auth_error_ignores_unrelated_unauthorized_message() {
        let status = unauthorized_status(r#"{"error":"expired timestamp"}"#);

        assert!(!is_l2_auth_error(&status));
    }

    #[test]
    fn env_line_parser_ignores_comments_and_blank_lines() {
        let parsed = parse_env_lines(
            r#"
            # comment
            POLYMARKET_API_KEY=abc

            POLYMARKET_API_SECRET = secret
            "#,
        );

        assert_eq!(
            parsed.get("POLYMARKET_API_KEY").map(String::as_str),
            Some("abc")
        );
        assert_eq!(
            parsed.get("POLYMARKET_API_SECRET").map(String::as_str),
            Some("secret")
        );
    }

    #[test]
    fn credential_cache_round_trips_with_private_permissions() {
        let path = std::env::temp_dir().join(format!(
            "wiggler-polymarket-api-test-{}.env",
            uuid::Uuid::new_v4()
        ));
        let credentials = Credentials::new(
            Uuid::parse_str("00000000-0000-0000-0000-000000000001").unwrap(),
            "secret".to_string(),
            "passphrase".to_string(),
        );

        write_credentials_cache(&path, &credentials, 123).unwrap();
        let cached = read_credentials_cache(&path).unwrap().unwrap();

        assert_eq!(cached.credentials.key(), credentials.key());
        assert_eq!(cached.credentials.secret().expose_secret(), "secret");
        assert_eq!(
            cached.credentials.passphrase().expose_secret(),
            "passphrase"
        );
        assert_eq!(cached.nonce, Some(123));

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600);
        }

        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn nonce_candidates_prefer_cache_then_config_without_duplicates() {
        let path = std::env::temp_dir().join(format!(
            "wiggler-polymarket-nonce-test-{}.env",
            uuid::Uuid::new_v4()
        ));
        let credentials = Credentials::new(
            Uuid::parse_str("00000000-0000-0000-0000-000000000002").unwrap(),
            "secret".to_string(),
            "passphrase".to_string(),
        );
        write_credentials_cache(&path, &credentials, 123).unwrap();
        let config = LiveAuthConfig {
            clob_api_url: "https://clob.polymarket.com".to_string(),
            credentials: None,
            nonce: Some(456),
            credential_file: path.clone(),
            signature_type: PolymarketSignatureType::Eoa,
            funder_address: None,
        };

        assert_eq!(
            credential_nonce_candidates(&config).unwrap(),
            vec![123, 456]
        );

        let duplicate = LiveAuthConfig {
            nonce: Some(123),
            ..config
        };
        assert_eq!(credential_nonce_candidates(&duplicate).unwrap(), vec![123]);

        let _ = std::fs::remove_file(path);
    }

    fn unauthorized_status(message: &str) -> PolymarketError {
        PolymarketError::status(
            PolymarketStatusCode::UNAUTHORIZED,
            Method::GET,
            "/data/orders".to_string(),
            message.to_string(),
        )
    }
}
