use std::str::FromStr;

use alloy::{signers::Signer as _, signers::local::PrivateKeySigner};
use anyhow::{Context, Result, bail};
use polymarket_client_sdk_v2::{
    POLYGON,
    auth::{Credentials, Uuid},
    clob::{
        Client, Config,
        types::{
            Amount, AssetType, OrderType, Side, SignatureType,
            request::{BalanceAllowanceRequest, OrdersRequest, TradesRequest},
            response::PostOrderResponse,
        },
    },
    types::{Address, B256, Decimal, U256},
};
use rust_decimal::prelude::FromPrimitive;
use tracing::{info, warn};

use crate::{
    config::{LiveOrderType, PolymarketSignatureType, RuntimeConfig},
    domain::{asset::Asset, market::Outcome},
};

type AuthenticatedClient = Client<
    polymarket_client_sdk_v2::auth::state::Authenticated<polymarket_client_sdk_v2::auth::Normal>,
>;

pub struct LiveTradeExecutor {
    client: AuthenticatedClient,
    signer: PrivateKeySigner,
    order_type: OrderType,
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

        let clob_config = Config::builder().use_server_time(true).build();
        let client = Client::new(&config.clob_api_url, clob_config)
            .with_context(|| format!("create CLOB client for {}", config.clob_api_url))?;
        let geoblock = client
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

        let mut auth = client
            .authentication_builder(&signer)
            .signature_type(map_signature_type(config.polymarket_signature_type));

        if let Some(funder) = &config.polymarket_funder_address {
            auth =
                auth.funder(Address::from_str(funder).context("parse POLYMARKET_FUNDER_ADDRESS")?);
        }

        if let Some(credentials) = credentials_from_config(config)? {
            auth = auth.credentials(credentials);
        } else if let Some(nonce) = config.polymarket_api_nonce {
            auth = auth.nonce(nonce);
        }

        let client = auth
            .authenticate()
            .await
            .context("authenticate CLOB client")?;
        let closed_only = client
            .closed_only_mode()
            .await
            .context("check CLOB closed-only mode")?;
        if closed_only.closed_only {
            bail!("Polymarket account is in closed-only mode");
        }

        let collateral_request = BalanceAllowanceRequest::builder()
            .asset_type(AssetType::Collateral)
            .build();
        if let Err(error) = client
            .update_balance_allowance(collateral_request.clone())
            .await
        {
            warn!(
                error = %format!("{error:#}"),
                "failed to refresh CLOB collateral balance allowance"
            );
        }
        let collateral = client
            .balance_allowance(collateral_request)
            .await
            .context("query CLOB collateral balance allowance")?;
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

        Ok(Self {
            client,
            signer,
            order_type: map_order_type(config.live_order_type),
        })
    }

    pub async fn has_market_exposure(&self, condition_id: &str) -> Result<bool> {
        let market = B256::from_str(condition_id).context("parse market condition id")?;
        let orders = self
            .client
            .orders(&OrdersRequest::builder().market(market).build(), None)
            .await
            .context("query open orders")?;
        if !orders.data.is_empty() {
            return Ok(true);
        }

        let trades = self
            .client
            .trades(&TradesRequest::builder().market(market).build(), None)
            .await
            .context("query trade history")?;

        Ok(!trades.data.is_empty())
    }

    pub async fn execute(&self, request: &LiveOrderRequest) -> Result<LiveOrderResponse> {
        let token_id = U256::from_str(&request.token_id).context("parse token id")?;
        let amount = positive_decimal_truncated("amount_usdc", request.amount_usdc, 2)?;
        let price = probability_decimal_truncated("max_price", request.max_price, 2)?;

        let response = self
            .client
            .market_order()
            .token_id(token_id)
            .side(Side::Buy)
            .amount(Amount::usdc(amount).context("build USDC order amount")?)
            .price(price)
            .order_type(self.order_type.clone())
            .build_sign_and_post(&self.signer)
            .await
            .context("post live Polymarket order")?;

        Ok(LiveOrderResponse::from(response))
    }
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
    use super::{positive_decimal_truncated, probability_decimal_truncated};

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
}
