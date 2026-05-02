use std::{env, str::FromStr};

use alloy::{signers::Signer as _, signers::local::PrivateKeySigner};
use anyhow::{Context, Result, bail};
use polymarket_client_sdk_v2::{
    POLYGON,
    auth::{Credentials, Uuid},
    clob::{
        Client, Config,
        types::{
            AssetType, SignatureType,
            request::{BalanceAllowanceRequest, OrdersRequest},
            response::HeartbeatResponse,
        },
    },
    error::{Error as PolymarketError, Status as PolymarketStatus},
    types::{Address, B256},
};
use serde::Deserialize;
use wiggler::{
    config::{PolymarketSignatureType, RuntimeConfig},
    polymarket::data::DataApiClient,
};

type AuthenticatedClient = Client<
    polymarket_client_sdk_v2::auth::state::Authenticated<polymarket_client_sdk_v2::auth::Normal>,
>;

#[tokio::main]
async fn main() -> Result<()> {
    let config = RuntimeConfig::from_env()?;
    let private_key = config
        .polymarket_private_key
        .as_deref()
        .context("POLYMARKET_PRIVATE_KEY")?;
    let signer = PrivateKeySigner::from_str(private_key)
        .context("parse POLYMARKET_PRIVATE_KEY")?
        .with_chain_id(Some(POLYGON));

    let mut auth = Client::new(
        &config.clob_api_url,
        Config::builder().use_server_time(true).build(),
    )?
    .authentication_builder(&signer)
    .signature_type(map_signature_type(config.polymarket_signature_type));

    if let Some(funder) = &config.polymarket_funder_address {
        let funder_address =
            Address::from_str(funder).context("parse POLYMARKET_FUNDER_ADDRESS")?;
        validate_funder_address(
            config.polymarket_signature_type,
            signer.address(),
            funder_address,
        )?;
        auth = auth.funder(funder_address);
    }

    if let Some(credentials) = credentials_from_config(&config)? {
        auth = auth.credentials(credentials);
    } else if let Some(nonce) = config.polymarket_api_nonce {
        auth = auth.nonce(nonce);
    }

    let client = auth
        .authenticate()
        .await
        .context("authenticate CLOB client")?;

    report(
        "heartbeat",
        post_heartbeat_resync(&client).await.map(|value| {
            format!(
                "ok heartbeat_id={} error={:?}",
                value.heartbeat_id, value.error
            )
        }),
    );
    report(
        "closed_only",
        client
            .closed_only_mode()
            .await
            .map(|value| format!("ok closed_only={}", value.closed_only)),
    );

    let balance_request = BalanceAllowanceRequest::builder()
        .asset_type(AssetType::Collateral)
        .build();
    report(
        "balance_allowance",
        client
            .balance_allowance(balance_request)
            .await
            .map(|value| {
                format!(
                    "ok balance={} allowances={}",
                    value.balance,
                    value.allowances.len()
                )
            }),
    );

    let orders_request = market_orders_request()?;
    report(
        "orders_no_cursor",
        client.orders(&orders_request, None).await.map(|value| {
            format!(
                "ok rows={} next_cursor={}",
                value.data.len(),
                value.next_cursor
            )
        }),
    );
    report(
        "orders_initial_cursor",
        client
            .orders(&orders_request, Some("MA==".to_string()))
            .await
            .map(|value| {
                format!(
                    "ok rows={} next_cursor={}",
                    value.data.len(),
                    value.next_cursor
                )
            }),
    );

    let data_api = DataApiClient::new(&config.data_api_base_url)?;
    let data_api_user = data_api_user_address(&config, signer.address())?;
    if let Some(market) = probe_market()? {
        report(
            "data_api_market_trades",
            data_api
                .has_market_trade(data_api_user, market)
                .await
                .map(|value| format!("ok has_trade={value}")),
        );
    } else {
        report(
            "data_api_recent_trades",
            data_api
                .fetch_trades(data_api_user, 1)
                .await
                .map(|value| format!("ok rows={}", value.len())),
        );
    }
    Ok(())
}

#[derive(Deserialize)]
struct HeartbeatErrorBody {
    heartbeat_id: Option<Uuid>,
}

async fn post_heartbeat_resync(client: &AuthenticatedClient) -> Result<HeartbeatResponse> {
    match client.post_heartbeat(None).await {
        Ok(response) => Ok(response),
        Err(error) => {
            let heartbeat_id = heartbeat_id_from_error(&error)
                .with_context(|| format!("post initial heartbeat: {error}"))?;
            client
                .post_heartbeat(Some(heartbeat_id))
                .await
                .context("post resynchronized heartbeat")
        }
    }
}

fn heartbeat_id_from_error(error: &PolymarketError) -> Option<Uuid> {
    let status = error.downcast_ref::<PolymarketStatus>()?;
    let body: HeartbeatErrorBody = serde_json::from_str(&status.message).ok()?;
    body.heartbeat_id
}

fn market_orders_request() -> Result<OrdersRequest> {
    if let Some(market) = probe_market()? {
        Ok(OrdersRequest::builder().market(market).build())
    } else {
        Ok(OrdersRequest::default())
    }
}

fn probe_market() -> Result<Option<B256>> {
    env::var("WIGGLER_PROBE_MARKET")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .map(|value| B256::from_str(value.trim()).context("parse WIGGLER_PROBE_MARKET"))
        .transpose()
}

fn data_api_user_address(config: &RuntimeConfig, signer_address: Address) -> Result<Address> {
    if let Some(user) = &config.polymarket_user_address {
        return Address::from_str(user).context("parse POLYMARKET_USER_ADDRESS");
    }
    if let Some(funder) = &config.polymarket_funder_address {
        return Address::from_str(funder).context("parse POLYMARKET_FUNDER_ADDRESS");
    }

    Ok(signer_address)
}

fn report<T, E>(label: &str, result: std::result::Result<T, E>)
where
    T: std::fmt::Display,
    E: std::fmt::Display,
{
    match result {
        Ok(message) => println!("{label}: {message}"),
        Err(error) => println!("{label}: error={error}"),
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
            "POLYMARKET_FUNDER_ADDRESS must be the Polymarket proxy/safe wallet for {:?}, not the signing EOA",
            signature_type
        );
    }

    Ok(())
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
