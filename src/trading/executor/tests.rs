use std::sync::atomic::{AtomicU32, Ordering};

use polymarket_client_sdk_v2::auth::{Credentials, ExposeSecret as _, Uuid};
use polymarket_client_sdk_v2::error::{
    Error as PolymarketError, Method, StatusCode as PolymarketStatusCode,
};
use polymarket_client_sdk_v2::types::{Decimal, address};
use rust_decimal::prelude::FromPrimitive;

use super::{
    LiveAuthConfig, MarketExposureSnapshot, credential_nonce_candidates, is_l2_auth_error,
    parse_env_lines, positive_decimal_truncated_decimal, probability_decimal_truncated_decimal,
    read_credentials_cache, reserve_fresh_api_nonce, validate_funder_address,
    write_credentials_cache,
};
use crate::{config::PolymarketSignatureType, trading::LIVE_ORDER_SIZE_SCALE};

#[test]
fn truncates_live_order_amount_without_rounding_up() {
    let amount =
        positive_decimal_truncated_decimal("amount_usdc", Decimal::from_f64(25.009).unwrap(), 2)
            .unwrap();
    assert_eq!(amount.to_string(), "25");
}

#[test]
fn truncates_live_order_size_to_polymarket_lot_precision() {
    let size = positive_decimal_truncated_decimal(
        "size_shares",
        Decimal::from_f64(66.666666).unwrap(),
        LIVE_ORDER_SIZE_SCALE,
    )
    .unwrap();
    assert_eq!(size.to_string(), "66.66");
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
fn exposure_snapshot_unions_open_orders_and_trades() {
    let mut snapshot = MarketExposureSnapshot::default();
    snapshot.open_order_markets.insert("0xopen".to_string());
    snapshot.traded_markets.insert("0xtraded".to_string());
    snapshot.traded_markets.insert("0xopen".to_string());

    let exposed = snapshot.exposed_markets();

    assert_eq!(exposed.len(), 2);
    assert!(exposed.contains("0xopen"));
    assert!(exposed.contains("0xtraded"));
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
