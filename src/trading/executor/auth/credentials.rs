use std::{
    collections::HashMap,
    fs,
    io::Write as _,
    path::Path,
    sync::atomic::{AtomicU32, Ordering},
    time::{SystemTime, UNIX_EPOCH},
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
    types::U256,
};
use reqwest::header::{HeaderMap, HeaderValue};
use serde::Deserialize;
use tracing::{info, warn};

use crate::config::RuntimeConfig;

use super::{CredentialSource, LiveAuthConfig};

static LAST_FRESH_API_NONCE: AtomicU32 = AtomicU32::new(0);

sol! {
    struct ClobAuth {
        address address;
        string timestamp;
        uint256 nonce;
        string message;
    }
}

pub(super) async fn credentials_for_source(
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

#[derive(Deserialize)]
struct ApiCredentialsBody {
    #[serde(alias = "apiKey")]
    api_key: String,
    secret: String,
    passphrase: String,
}

pub(super) fn fresh_api_nonce() -> Result<u32> {
    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .context("system clock is before Unix epoch")?
        .as_secs();
    let seconds =
        u32::try_from(seconds).context("current Unix timestamp exceeds u32 nonce range")?;
    reserve_fresh_api_nonce(&LAST_FRESH_API_NONCE, seconds)
}

pub(in crate::trading::executor) fn reserve_fresh_api_nonce(
    last_nonce: &AtomicU32,
    base_nonce: u32,
) -> Result<u32> {
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

pub(super) fn redacted_uuid(value: Uuid) -> String {
    let value = value.to_string();
    let suffix_start = value.len().saturating_sub(4);
    format!("{}...{}", &value[..8], &value[suffix_start..])
}

#[derive(Clone)]
pub(crate) struct CachedCredentials {
    pub(crate) credentials: Credentials,
    pub(crate) nonce: Option<u32>,
}

pub(in crate::trading::executor) fn read_credentials_cache(
    path: &Path,
) -> Result<Option<CachedCredentials>> {
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

pub(in crate::trading::executor) fn write_credentials_cache(
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

pub(in crate::trading::executor) fn parse_env_lines(text: &str) -> HashMap<String, String> {
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

pub(in crate::trading::executor) fn credential_nonce_candidates(
    config: &LiveAuthConfig,
) -> Result<Vec<u32>> {
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

pub(in crate::trading::executor) fn credentials_from_config(
    config: &RuntimeConfig,
) -> Result<Option<Credentials>> {
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
