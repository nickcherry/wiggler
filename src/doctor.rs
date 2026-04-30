use anyhow::{Result, bail};
use chrono::Utc;
use serde::Serialize;

use crate::{
    cli::DoctorArgs,
    config::RuntimeConfig,
    domain::{
        asset::{format_assets, normalize_assets},
        market::Outcome,
        time::{MarketSlot, duration_from_seconds},
    },
    polymarket::gamma::GammaClient,
};

pub async fn run(args: DoctorArgs, config: RuntimeConfig) -> Result<()> {
    let duration = duration_from_seconds(args.slot_seconds)?;
    if duration.num_seconds() % 60 != 0 {
        bail!("slot_seconds must be divisible by 60 for Polymarket crypto up/down slugs");
    }

    let assets = normalize_assets(args.assets);
    let gamma = GammaClient::new(config.gamma_base_url.clone());
    let current_slot = MarketSlot::current(Utc::now(), duration)?;
    let mut slots = Vec::new();

    for asset in &assets {
        for offset in 0..=args.lookahead_slots {
            let slot = current_slot.offset(i64::from(offset))?;
            let slug = slot.slug(*asset)?;
            let market = gamma.fetch_slot_market(*asset, &slot).await?;

            slots.push(DoctorSlot {
                asset: asset.to_string(),
                slug,
                start: slot.start().to_rfc3339(),
                end: slot.end().to_rfc3339(),
                discovered: market.is_some(),
                condition_id: market.as_ref().map(|market| market.condition_id.clone()),
                token_count: market
                    .as_ref()
                    .map(|market| market.tokens.len())
                    .unwrap_or(0),
                tokens: market
                    .as_ref()
                    .map(|market| {
                        market
                            .tokens
                            .iter()
                            .map(|token| DoctorToken {
                                outcome: token.outcome.clone(),
                                asset_id: token.asset_id.clone(),
                            })
                            .collect()
                    })
                    .unwrap_or_default(),
                resolution_source: market.and_then(|market| market.resolution_source),
            });
        }
    }

    let report = DoctorReport {
        ok: slots.iter().any(|slot| slot.discovered),
        assets: format_assets(&assets),
        slot_seconds: args.slot_seconds,
        gamma_base_url: config.gamma_base_url.clone(),
        clob_market_ws_url: config.clob_market_ws_url.clone(),
        rtds_ws_url: config.rtds_ws_url.clone(),
        telegram_configured: config.telegram_is_configured(),
        slots,
    };

    println!("{}", serde_json::to_string_pretty(&report)?);

    Ok(())
}

#[derive(Debug, Serialize)]
struct DoctorReport {
    ok: bool,
    assets: String,
    slot_seconds: i64,
    gamma_base_url: String,
    clob_market_ws_url: String,
    rtds_ws_url: String,
    telegram_configured: bool,
    slots: Vec<DoctorSlot>,
}

#[derive(Debug, Serialize)]
struct DoctorSlot {
    asset: String,
    slug: String,
    start: String,
    end: String,
    discovered: bool,
    condition_id: Option<String>,
    token_count: usize,
    tokens: Vec<DoctorToken>,
    resolution_source: Option<String>,
}

#[derive(Debug, Serialize)]
struct DoctorToken {
    outcome: Outcome,
    asset_id: String,
}
