use std::{env, str::FromStr};

use alloy::signers::{Signer as _, local::PrivateKeySigner};
use anyhow::{Context, Result};
use polymarket_client_sdk_v2::{POLYGON, derive_proxy_wallet, derive_safe_wallet};

fn main() -> Result<()> {
    let private_key = env::var("POLYMARKET_PRIVATE_KEY").context("POLYMARKET_PRIVATE_KEY")?;
    let signer = PrivateKeySigner::from_str(&private_key)
        .context("parse private key")?
        .with_chain_id(Some(POLYGON));

    println!("signer={}", signer.address());
    if let Some(funder) = env::var("POLYMARKET_FUNDER_ADDRESS")
        .ok()
        .filter(|value| !value.trim().is_empty())
    {
        println!("configured_funder={}", funder.trim());
    }
    if let Some(proxy) = derive_proxy_wallet(signer.address(), POLYGON) {
        println!("derived_proxy={proxy}");
    }
    if let Some(safe) = derive_safe_wallet(signer.address(), POLYGON) {
        println!("derived_safe={safe}");
    }

    Ok(())
}
