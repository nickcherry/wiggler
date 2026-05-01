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
            request::{BalanceAllowanceRequest, OrdersRequest, TradesRequest},
        },
    },
    types::{Address, B256},
};
use wiggler::config::{PolymarketSignatureType, RuntimeConfig};

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

    let trades_request = market_trades_request()?;
    report(
        "trades_no_cursor",
        client.trades(&trades_request, None).await.map(|value| {
            format!(
                "ok rows={} next_cursor={}",
                value.data.len(),
                value.next_cursor
            )
        }),
    );
    report(
        "trades_initial_cursor",
        client
            .trades(&trades_request, Some("MA==".to_string()))
            .await
            .map(|value| {
                format!(
                    "ok rows={} next_cursor={}",
                    value.data.len(),
                    value.next_cursor
                )
            }),
    );

    Ok(())
}

fn market_orders_request() -> Result<OrdersRequest> {
    if let Some(market) = probe_market()? {
        Ok(OrdersRequest::builder().market(market).build())
    } else {
        Ok(OrdersRequest::default())
    }
}

fn market_trades_request() -> Result<TradesRequest> {
    if let Some(market) = probe_market()? {
        Ok(TradesRequest::builder().market(market).build())
    } else {
        Ok(TradesRequest::default())
    }
}

fn probe_market() -> Result<Option<B256>> {
    env::var("WIGGLER_PROBE_MARKET")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .map(|value| B256::from_str(value.trim()).context("parse WIGGLER_PROBE_MARKET"))
        .transpose()
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
