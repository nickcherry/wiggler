use std::{path::PathBuf, str::FromStr, sync::Arc};

use alloy::signers::local::PrivateKeySigner;
use anyhow::{Context, Result, bail};
use polymarket_client_sdk_v2::{
    auth::{Credentials, Uuid},
    clob::{
        Client, Config,
        types::{
            AssetType, SignatureType, request::BalanceAllowanceRequest,
            response::BalanceAllowanceResponse,
        },
    },
    error::{Error as PolymarketError, Status as PolymarketStatus},
    types::Address,
};
use serde::Deserialize;
use tokio::sync::Mutex;
use tracing::{info, warn};

use crate::config::{PolymarketSignatureType, RuntimeConfig};

mod credentials;
mod heartbeat;

pub(super) use credentials::{credential_nonce_candidates, credentials_from_config};
use credentials::{credentials_for_source, fresh_api_nonce, redacted_uuid};
#[cfg(test)]
pub(super) use credentials::{
    parse_env_lines, read_credentials_cache, reserve_fresh_api_nonce, write_credentials_cache,
};
use heartbeat::reset_heartbeat;
pub(super) use heartbeat::{refresh_heartbeat, spawn_heartbeat_task};

pub(super) type AuthenticatedClient = Client<
    polymarket_client_sdk_v2::auth::state::Authenticated<polymarket_client_sdk_v2::auth::Normal>,
>;
pub(super) type ClientState = Arc<Mutex<AuthenticatedClient>>;
pub(super) type HeartbeatState = Arc<Mutex<Option<Uuid>>>;
pub(super) type CredentialRotationLock = Arc<Mutex<()>>;

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
struct ClobErrorBody {
    error_msg: Option<String>,
    error: Option<String>,
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
