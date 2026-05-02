use std::time::{Duration, Instant};

use alloy::signers::local::PrivateKeySigner;
use anyhow::{Context, Result};
use polymarket_client_sdk_v2::{
    auth::Uuid,
    clob::types::response::HeartbeatResponse,
    error::{Error as PolymarketError, Status as PolymarketStatus},
};
use serde::Deserialize;
use tokio::task::JoinHandle;
use tracing::{info, warn};

use crate::telegram::TelegramClient;

use super::{
    AuthenticatedClient, ClientState, CredentialRotationLock, HeartbeatState, LiveAuthConfig,
    is_l2_auth_error, is_l2_auth_error_chain, recover_client_after_l2_auth_error,
};

#[derive(Deserialize)]
struct HeartbeatErrorBody {
    heartbeat_id: Option<Uuid>,
    error_msg: Option<String>,
    error: Option<String>,
}

pub(in crate::trading::executor) async fn refresh_heartbeat(
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

pub(super) async fn reset_heartbeat(heartbeat_state: &HeartbeatState) {
    *heartbeat_state.lock().await = None;
}

pub(in crate::trading::executor) fn spawn_heartbeat_task(
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
