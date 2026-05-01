use std::{env, fs, str::FromStr};

use alloy::{
    core::sol,
    dyn_abi::Eip712Domain,
    hex::ToHexExt as _,
    primitives::U256,
    signers::{Signer as _, local::PrivateKeySigner},
    sol_types::SolStruct as _,
};
use anyhow::{Context, Result, bail};
use reqwest::header::{HeaderMap, HeaderValue};
use serde::Deserialize;

sol! {
    struct ClobAuth {
        address address;
        string timestamp;
        uint256 nonce;
        string message;
    }
}

#[derive(Debug, Deserialize)]
struct ApiCreds {
    #[serde(alias = "apiKey")]
    api_key: String,
    secret: String,
    passphrase: String,
}

#[tokio::main]
async fn main() -> Result<()> {
    let host = env::var("POLYMARKET_CLOB_API_URL")
        .unwrap_or_else(|_| "https://clob.polymarket.com".to_string());
    let private_key = env::var("POLYMARKET_PRIVATE_KEY").context("POLYMARKET_PRIVATE_KEY")?;
    let nonce = env::var("POLYMARKET_API_NONCE")
        .ok()
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "0".to_string())
        .parse::<u32>()
        .context("parse POLYMARKET_API_NONCE")?;
    let mode = env::var("AUTH_MANUAL_MODE").unwrap_or_else(|_| "create".to_string());
    let body = env::var("AUTH_MANUAL_BODY").unwrap_or_else(|_| "{}".to_string());

    let signer = PrivateKeySigner::from_str(&private_key)
        .context("parse private key")?
        .with_chain_id(Some(137));

    let http = reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (compatible; wiggler-auth/1.0)")
        .build()
        .context("build client")?;

    let timestamp = http
        .get(format!("{host}/time"))
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
        chain_id: Some(U256::from(137)),
        ..Eip712Domain::default()
    };
    let signature = signer
        .sign_hash(&auth.eip712_signing_hash(&domain))
        .await
        .context("sign auth hash")?;

    let mut headers = HeaderMap::new();
    headers.insert(
        "POLY_ADDRESS",
        HeaderValue::from_str(&signer.address().encode_hex_with_prefix())?,
    );
    headers.insert("POLY_NONCE", HeaderValue::from_str(&nonce.to_string())?);
    headers.insert(
        "POLY_SIGNATURE",
        HeaderValue::from_str(&signature.to_string())?,
    );
    headers.insert("POLY_TIMESTAMP", HeaderValue::from_str(&timestamp)?);
    headers.insert("ACCEPT", HeaderValue::from_static("application/json"));
    headers.insert("CONTENT-TYPE", HeaderValue::from_static("application/json"));

    let request = match mode.as_str() {
        "create" => http
            .post(format!("{host}/auth/api-key"))
            .headers(headers)
            .body(body),
        "derive" => http
            .get(format!("{host}/auth/derive-api-key"))
            .headers(headers),
        other => bail!("unsupported AUTH_MANUAL_MODE={other}"),
    };
    let response = request.send().await.context("send auth request")?;
    let status = response.status();
    let text = response.text().await.context("read auth response")?;
    if !status.is_success() {
        bail!(
            "auth request failed status={status} body_prefix={}",
            &text[..text.len().min(300)]
        );
    }
    let creds: ApiCreds = serde_json::from_str(&text).context("parse API credentials")?;

    if let Ok(path) = env::var("AUTH_MANUAL_WRITE_ENV") {
        fs::write(
            &path,
            format!(
                "POLYMARKET_API_KEY={}\nPOLYMARKET_API_SECRET={}\nPOLYMARKET_API_PASSPHRASE={}\nPOLYMARKET_API_NONCE={}\n",
                creds.api_key, creds.secret, creds.passphrase, nonce
            ),
        )
        .with_context(|| format!("write {path}"))?;
    }
    println!(
        "auth_manual_ok mode={} key={} secret_len={} passphrase_len={}",
        mode,
        redacted(&creds.api_key),
        creds.secret.len(),
        creds.passphrase.len()
    );
    Ok(())
}

fn redacted(value: &str) -> String {
    let prefix = value.chars().take(8).collect::<String>();
    format!("{prefix}...")
}
