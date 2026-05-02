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
            AssetType, SignatureType,
            request::BalanceAllowanceRequest,
            response::{BalanceAllowanceResponse, HeartbeatResponse},
        },
    },
    error::{Error as PolymarketError, Status as PolymarketStatus},
    types::{Address, U256},
};
use reqwest::header::{HeaderMap, HeaderValue};
use serde::Deserialize;
use tokio::{sync::Mutex, task::JoinHandle};
use tracing::{info, warn};

use crate::{
    config::{PolymarketSignatureType, RuntimeConfig},
    telegram::TelegramClient,
};

pub(super) type AuthenticatedClient = Client<
    polymarket_client_sdk_v2::auth::state::Authenticated<polymarket_client_sdk_v2::auth::Normal>,
>;
pub(super) type ClientState = Arc<Mutex<AuthenticatedClient>>;
pub(super) type HeartbeatState = Arc<Mutex<Option<Uuid>>>;
pub(super) type CredentialRotationLock = Arc<Mutex<()>>;

static LAST_FRESH_API_NONCE: AtomicU32 = AtomicU32::new(0);

sol! {
    struct ClobAuth {
        address address;
        string timestamp;
        uint256 nonce;
        string message;
    }
}

#[derive(Clone, Debug)]
pub(crate) struct LiveAuthConfig {
    pub(crate) clob_api_url: String,
    pub(crate) credentials: Option<Credentials>,
    pub(crate) nonce: Option<u32>,
    pub(crate) credential_file: PathBuf,
    pub(crate) signature_type: PolymarketSignatureType,
    pub(crate) funder_address: Option<Address>,
}

#[derive(Clone, Copy, Debug)]
pub(super) enum CredentialSource {
    Configured,
    DerivedNonce(u32),
    FreshNonce(u32),
}

pub(super) async fn authenticate_client(
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
pub(super) async fn recover_client_after_l2_auth_error(
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

pub(super) async fn validate_live_account(
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

pub(super) async fn refresh_heartbeat(
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

pub(super) fn spawn_heartbeat_task(
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

pub(super) fn reserve_fresh_api_nonce(last_nonce: &AtomicU32, base_nonce: u32) -> Result<u32> {
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
pub(crate) struct CachedCredentials {
    pub(crate) credentials: Credentials,
    pub(crate) nonce: Option<u32>,
}

pub(super) fn read_credentials_cache(path: &Path) -> Result<Option<CachedCredentials>> {
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

pub(super) fn write_credentials_cache(
    path: &Path,
    credentials: &Credentials,
    nonce: u32,
) -> Result<()> {
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

pub(super) fn parse_env_lines(text: &str) -> HashMap<String, String> {
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

pub(super) fn credential_nonce_candidates(config: &LiveAuthConfig) -> Result<Vec<u32>> {
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

pub(super) fn is_l2_auth_error(error: &PolymarketError) -> bool {
    let Some(status) = error.downcast_ref::<PolymarketStatus>() else {
        return false;
    };

    is_invalid_api_key_status(status)
}

pub(super) fn is_l2_auth_error_chain(error: &anyhow::Error) -> bool {
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

pub(super) fn credentials_from_config(config: &RuntimeConfig) -> Result<Option<Credentials>> {
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

pub(super) fn validate_funder_address(
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

pub(super) fn data_api_user_address(
    config: &RuntimeConfig,
    signer_address: Address,
    funder_address: Option<Address>,
) -> Result<Address> {
    if let Some(user) = &config.polymarket_user_address {
        return Address::from_str(user).context("parse POLYMARKET_USER_ADDRESS");
    }

    Ok(funder_address.unwrap_or(signer_address))
}
