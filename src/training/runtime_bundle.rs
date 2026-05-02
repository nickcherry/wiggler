use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
};

use anyhow::{Context, Result, bail};
use chrono::{DateTime, Utc};
use serde::Serialize;
use sha2::{Digest, Sha256};
use sqlx::PgPool;

use crate::domain::asset::Asset;

use super::grid::{
    ClosePoint, INTERVAL_SEC, SideLeading, VOL_LOOKBACK_MIN, WinProbBucket, WinProbGrid,
    build_win_prob_grid,
};
use schema::*;

const TIMEFRAME: &str = "1m";
const RUNTIME_CONFIG_VERSION: &str = "wiggler-runtime-prob-grid-v1";
const RUNTIME_BUNDLE_VERSION: &str = "wiggler-runtime-bundle-v1";

mod schema;

pub struct BuildRuntimeOptions {
    pub assets: Vec<Asset>,
    pub output_dir: PathBuf,
    pub from: DateTime<Utc>,
    pub to: DateTime<Utc>,
    pub taker_fee_rate: f64,
    pub min_edge_probability: f64,
    pub min_bucket_count: u64,
    pub max_position_usdc: f64,
}

pub struct BuildRuntimeResult {
    pub output_dir: PathBuf,
    pub assets: Vec<Asset>,
    pub generated_at: String,
    pub entries: Vec<BuildRuntimeEntry>,
}

pub struct BuildRuntimeEntry {
    pub asset: Asset,
    pub cell_count: usize,
    pub runtime_config_hash: String,
    pub training_input_hash: String,
}

pub async fn build_runtime_bundle(
    pool: &PgPool,
    options: BuildRuntimeOptions,
) -> Result<BuildRuntimeResult> {
    validate_build_options(&options)?;

    fs::create_dir_all(&options.output_dir)
        .with_context(|| format!("create {}", options.output_dir.display()))?;
    let generated_at = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
    let git = read_git_provenance();
    let mut manifest_entries = Vec::new();
    let mut result_entries = Vec::new();

    for asset in &options.assets {
        let closes = load_vwap_closes(pool, *asset, options.from, options.to).await?;
        if closes.len() < VOL_LOOKBACK_MIN + usize::try_from(INTERVAL_SEC / 60).unwrap_or(0) + 1 {
            bail!(
                "not enough VWAP closes for {} in requested window: {} rows",
                asset,
                closes.len()
            );
        }
        let training_input_hash = compute_input_hash(&closes);
        let grid = build_win_prob_grid(&closes, options.min_bucket_count);
        let source_config_hash = compute_grid_hash(&grid)?;
        let cells = runtime_cells(&grid);
        let runtime_config_hash = compute_runtime_hash(&cells)?;
        let runtime_path = format!("{}_300s_boundary.runtime.json", asset_code(*asset));
        let config = RuntimeConfigFile {
            version: RUNTIME_CONFIG_VERSION,
            asset: asset_code(*asset),
            market_type: "up_down",
            interval_sec: grid.interval_sec,
            anchor_mode: anchor_mode(&grid),
            generated_at_iso: generated_at.clone(),
            source: SourceConfig {
                config_hash: source_config_hash.clone(),
                training_input_hash: training_input_hash.clone(),
                wiggler_git_commit_sha: git.commit_sha.clone(),
                wiggler_git_dirty: git.dirty,
                source_generated_at_iso: generated_at.clone(),
            },
            training: TrainingConfig {
                label_source: "vwap",
                label_source_kind: "vwap_chainlink_proxy",
                label_source_note: "Local cross-source 1m VWAP across Coinbase and Binance spot. Used as a Chainlink proxy: at training time we have no historical Chainlink data, so basis risk versus the live resolution feed is unmeasured.",
                anchor_step_min: grid.anchor_step_min,
                rowcount: grid.total_rows,
                window_start_ms: grid.first_anchor_open_time_ms,
                window_end_ms: grid.last_interval_end_open_time_ms,
            },
            resolution_source: ResolutionSource {
                intended: IntendedResolutionSource {
                    name: "Chainlink Data Streams",
                    symbol: chainlink_symbol(*asset),
                },
                proxy_basis_risk: "unmeasured",
            },
            abs_d_bps_boundaries: grid.abs_d_bps_boundaries.clone(),
            remaining_sec_buckets: grid.decision_remaining_secs.clone(),
            vol_bins: VolBinsConfig {
                method: "training_terciles_with_p90_tail",
                thresholds_bps_per_sqrt_min: grid.vol_bin_thresholds,
                vol_lookback_min: VOL_LOOKBACK_MIN as u32,
            },
            fee: FeeConfig {
                formula: "fee = shares * fee_rate * price * (1 - price)",
                taker_fee_rate: options.taker_fee_rate,
            },
            risk_defaults: RiskDefaults {
                min_remaining_sec_to_trade: 60,
                min_edge_probability: options.min_edge_probability,
                min_bucket_count: options.min_bucket_count,
                max_position_usdc: options.max_position_usdc,
                kelly_fraction: 0.1,
                max_position_note: "Suggested per-market cap from research config; production may override downward but should not exceed without explicit operator change.",
            },
            totals: Totals {
                decision_state_rows: grid.total_rows,
                up_win_anchors: grid.up_win_anchors,
                down_win_anchors: grid.down_win_anchors,
            },
            lookup_rules: LookupRules {
                use_probability: "p_win_lower",
                valid_side_leading_values: vec!["up_leading", "down_leading"],
                at_line_policy: "no_trade",
                distance_bucket_rule: "abs_d_bps_min <= abs(d_bps) < abs_d_bps_max; null max means open-ended",
                remaining_bucket_rule: "use the smallest configured remaining_sec bucket >= actual remaining seconds; if actual remaining seconds < min_remaining_sec_to_trade, no trade",
            },
            cells: cells.clone(),
            runtime_config_hash: runtime_config_hash.clone(),
        };
        write_json(options.output_dir.join(&runtime_path), &config)?;
        manifest_entries.push(ManifestRuntimeConfig {
            asset: asset_code(*asset),
            path: runtime_path,
            runtime_config_hash: runtime_config_hash.clone(),
            source_config_hash,
            training_input_hash: training_input_hash.clone(),
            cell_count: cells.len(),
            interval_sec: INTERVAL_SEC,
            anchor_mode: "boundary",
            label_source_kind: "vwap_chainlink_proxy",
            resolution_symbol: chainlink_symbol(*asset),
        });
        result_entries.push(BuildRuntimeEntry {
            asset: *asset,
            cell_count: cells.len(),
            runtime_config_hash,
            training_input_hash,
        });
    }

    let manifest = RuntimeManifest {
        version: RUNTIME_BUNDLE_VERSION,
        generated_at_iso: generated_at.clone(),
        description: "Runtime probability-grid bundle for Wiggler. The app controls live-vs-paper execution via its own operator flag; this bundle only lists configured assets and probability grids.",
        assets: options
            .assets
            .iter()
            .map(|asset| asset_code(*asset))
            .collect(),
        interval_sec: INTERVAL_SEC,
        anchor_mode: "boundary",
        runtime_configs: manifest_entries,
        global_assumptions: GlobalAssumptions {
            label_source_kind: "vwap_chainlink_proxy",
            resolution_source: "Chainlink Data Streams intended; historical labels are Coinbase/Binance VWAP proxy",
            basis_risk: "unmeasured",
            final_0_to_59_sec_window: "not modeled by 1-minute candles; production applies stricter experimental gates if enabled",
            order_book_history: "not included; production must use live maker bids and depth",
            live_trading_control: "not encoded here; production app must use a separate operator-controlled live-trading flag",
        },
        operator_asset_whitelist: options
            .assets
            .iter()
            .map(|asset| asset_code(*asset))
            .collect(),
    };
    write_json(
        options.output_dir.join("wiggler-runtime-manifest.json"),
        &manifest,
    )?;

    Ok(BuildRuntimeResult {
        output_dir: options.output_dir,
        assets: options.assets,
        generated_at,
        entries: result_entries,
    })
}

fn validate_build_options(options: &BuildRuntimeOptions) -> Result<()> {
    if options.assets.is_empty() {
        bail!("at least one asset is required");
    }
    if options.from >= options.to {
        bail!("training window start must be before end");
    }
    if !options.taker_fee_rate.is_finite() || options.taker_fee_rate < 0.0 {
        bail!("--taker-fee-rate must be a non-negative finite number");
    }
    if !options.min_edge_probability.is_finite() || options.min_edge_probability < 0.0 {
        bail!("--min-edge-probability must be a non-negative finite number");
    }
    if !options.max_position_usdc.is_finite() || options.max_position_usdc <= 0.0 {
        bail!("--max-position-usdc must be positive");
    }
    Ok(())
}

async fn load_vwap_closes(
    pool: &PgPool,
    asset: Asset,
    from: DateTime<Utc>,
    to: DateTime<Utc>,
) -> Result<Vec<ClosePoint>> {
    let rows: Vec<(i64, i64)> = sqlx::query_as(
        r#"
SELECT open_time_ms, vwap_e8
FROM candle_vwap
WHERE asset = $1
  AND timeframe = $2
  AND open_time >= $3
  AND open_time < $4
ORDER BY open_time_ms
"#,
    )
    .bind(asset_code(asset))
    .bind(TIMEFRAME)
    .bind(from)
    .bind(to)
    .fetch_all(pool)
    .await
    .with_context(|| format!("load VWAP closes for {asset}"))?;

    Ok(rows
        .into_iter()
        .map(|(open_time_ms, vwap_e8)| ClosePoint {
            ts_ms: open_time_ms,
            close_e8: vwap_e8,
        })
        .collect())
}

fn runtime_cells(grid: &WinProbGrid) -> Vec<RuntimeCell> {
    grid.buckets
        .iter()
        .filter(|bucket| {
            bucket.tradable
                && matches!(
                    bucket.side_leading,
                    SideLeading::UpLeading | SideLeading::DownLeading
                )
        })
        .map(runtime_cell)
        .collect()
}

fn runtime_cell(bucket: &WinProbBucket) -> RuntimeCell {
    RuntimeCell {
        remaining_sec: bucket.remaining_sec,
        vol_bin: bucket.vol_bin,
        side_leading: bucket.side_leading,
        abs_d_bps_min: bucket.abs_d_bps_min,
        abs_d_bps_max: bucket.abs_d_bps_max,
        sample_count: bucket.count,
        wins: bucket.wins,
        p_win: round6(bucket.p_win),
        p_win_lower: round6(bucket.p_win_lower),
    }
}

fn compute_input_hash(closes: &[ClosePoint]) -> String {
    let mut hash = Sha256::new();
    for close in closes {
        hash.update(close.ts_ms.to_string());
        hash.update(b"|");
        hash.update(close.close_e8.to_string());
        hash.update(b"\n");
    }
    hex::encode(hash.finalize())
}

fn compute_grid_hash(grid: &WinProbGrid) -> Result<String> {
    let canonical = grid
        .buckets
        .iter()
        .map(|bucket| CanonicalBucket {
            remaining_sec: bucket.remaining_sec,
            vol_bin: bucket.vol_bin,
            side_leading: bucket.side_leading,
            abs_d_bps_min: bucket.abs_d_bps_min,
            abs_d_bps_max: bucket.abs_d_bps_max,
            count: bucket.count,
            wins: bucket.wins,
        })
        .collect::<Vec<_>>();
    sha256_json(&canonical)
}

fn compute_runtime_hash(cells: &[RuntimeCell]) -> Result<String> {
    sha256_json(cells)
}

fn sha256_json<T: Serialize + ?Sized>(value: &T) -> Result<String> {
    let text = serde_json::to_string(value).context("serialize canonical hash input")?;
    let mut hash = Sha256::new();
    hash.update(text.as_bytes());
    Ok(hex::encode(hash.finalize()))
}

fn write_json(path: impl AsRef<Path>, value: &impl Serialize) -> Result<()> {
    let path = path.as_ref();
    let text = serde_json::to_string_pretty(value).context("serialize runtime JSON")?;
    fs::write(path, format!("{text}\n")).with_context(|| format!("write {}", path.display()))
}

fn anchor_mode(grid: &WinProbGrid) -> &'static str {
    if grid.anchor_step_min == usize::try_from(grid.interval_sec / 60).unwrap_or(0) {
        "boundary"
    } else {
        "rolling"
    }
}

fn read_git_provenance() -> GitProvenance {
    let commit_sha = command_stdout("git", &["rev-parse", "HEAD"]);
    let dirty = command_stdout("git", &["status", "--porcelain"])
        .is_some_and(|status| !status.trim().is_empty());
    GitProvenance { commit_sha, dirty }
}

fn command_stdout(program: &str, args: &[&str]) -> Option<String> {
    let output = Command::new(program).args(args).output().ok()?;
    if !output.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn asset_code(asset: Asset) -> String {
    asset.slug_code().to_ascii_uppercase()
}

fn chainlink_symbol(asset: Asset) -> String {
    asset.chainlink_symbol().to_ascii_uppercase()
}

fn round6(value: f64) -> f64 {
    (value * 1_000_000.0).round() / 1_000_000.0
}
