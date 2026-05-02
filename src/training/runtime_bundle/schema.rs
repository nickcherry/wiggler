use serde::Serialize;

use crate::training::grid::{SideLeading, VolBin, VolBinThresholds};

#[derive(Clone)]
pub(super) struct GitProvenance {
    pub(super) commit_sha: Option<String>,
    pub(super) dirty: bool,
}

#[derive(Serialize)]
pub(super) struct RuntimeManifest<'a> {
    pub(super) version: &'a str,
    pub(super) generated_at_iso: String,
    pub(super) description: &'a str,
    pub(super) assets: Vec<String>,
    pub(super) interval_sec: u32,
    pub(super) anchor_mode: &'a str,
    pub(super) runtime_configs: Vec<ManifestRuntimeConfig>,
    pub(super) global_assumptions: GlobalAssumptions<'a>,
    pub(super) operator_asset_whitelist: Vec<String>,
}

#[derive(Serialize)]
pub(super) struct ManifestRuntimeConfig {
    pub(super) asset: String,
    pub(super) path: String,
    pub(super) runtime_config_hash: String,
    pub(super) source_config_hash: String,
    pub(super) training_input_hash: String,
    pub(super) cell_count: usize,
    pub(super) interval_sec: u32,
    pub(super) anchor_mode: &'static str,
    pub(super) label_source_kind: &'static str,
    pub(super) resolution_symbol: String,
}

#[derive(Serialize)]
pub(super) struct GlobalAssumptions<'a> {
    pub(super) label_source_kind: &'a str,
    pub(super) resolution_source: &'a str,
    pub(super) basis_risk: &'a str,
    pub(super) final_0_to_59_sec_window: &'a str,
    pub(super) order_book_history: &'a str,
    pub(super) live_trading_control: &'a str,
}

#[derive(Serialize)]
pub(super) struct RuntimeConfigFile<'a> {
    pub(super) version: &'a str,
    pub(super) asset: String,
    pub(super) market_type: &'a str,
    pub(super) interval_sec: u32,
    pub(super) anchor_mode: &'a str,
    pub(super) generated_at_iso: String,
    pub(super) source: SourceConfig,
    pub(super) training: TrainingConfig<'a>,
    pub(super) resolution_source: ResolutionSource,
    pub(super) abs_d_bps_boundaries: Vec<f64>,
    pub(super) remaining_sec_buckets: Vec<u32>,
    pub(super) vol_bins: VolBinsConfig<'a>,
    pub(super) fee: FeeConfig<'a>,
    pub(super) risk_defaults: RiskDefaults<'a>,
    pub(super) totals: Totals,
    pub(super) lookup_rules: LookupRules<'a>,
    pub(super) cells: Vec<RuntimeCell>,
    pub(super) runtime_config_hash: String,
}

#[derive(Serialize)]
pub(super) struct SourceConfig {
    pub(super) config_hash: String,
    pub(super) training_input_hash: String,
    pub(super) wiggler_git_commit_sha: Option<String>,
    pub(super) wiggler_git_dirty: bool,
    pub(super) source_generated_at_iso: String,
}

#[derive(Serialize)]
pub(super) struct TrainingConfig<'a> {
    pub(super) label_source: &'a str,
    pub(super) label_source_kind: &'a str,
    pub(super) label_source_note: &'a str,
    pub(super) anchor_step_min: usize,
    pub(super) rowcount: u64,
    pub(super) window_start_ms: Option<i64>,
    pub(super) window_end_ms: Option<i64>,
}

#[derive(Serialize)]
pub(super) struct ResolutionSource {
    pub(super) intended: IntendedResolutionSource,
    pub(super) proxy_basis_risk: &'static str,
}

#[derive(Serialize)]
pub(super) struct IntendedResolutionSource {
    pub(super) name: &'static str,
    pub(super) symbol: String,
}

#[derive(Serialize)]
pub(super) struct VolBinsConfig<'a> {
    pub(super) method: &'a str,
    pub(super) thresholds_bps_per_sqrt_min: VolBinThresholds,
    pub(super) vol_lookback_min: u32,
}

#[derive(Serialize)]
pub(super) struct FeeConfig<'a> {
    pub(super) formula: &'a str,
    pub(super) taker_fee_rate: f64,
}

#[derive(Serialize)]
pub(super) struct RiskDefaults<'a> {
    pub(super) min_remaining_sec_to_trade: u32,
    pub(super) min_edge_probability: f64,
    pub(super) min_bucket_count: u64,
    pub(super) max_position_usdc: f64,
    pub(super) kelly_fraction: f64,
    pub(super) max_position_note: &'a str,
}

#[derive(Serialize)]
pub(super) struct Totals {
    pub(super) decision_state_rows: u64,
    pub(super) up_win_anchors: u64,
    pub(super) down_win_anchors: u64,
}

#[derive(Serialize)]
pub(super) struct LookupRules<'a> {
    pub(super) use_probability: &'a str,
    pub(super) valid_side_leading_values: Vec<&'a str>,
    pub(super) at_line_policy: &'a str,
    pub(super) distance_bucket_rule: &'a str,
    pub(super) remaining_bucket_rule: &'a str,
}

#[derive(Clone, Serialize)]
pub(super) struct RuntimeCell {
    pub(super) remaining_sec: u32,
    pub(super) vol_bin: VolBin,
    pub(super) side_leading: SideLeading,
    pub(super) abs_d_bps_min: f64,
    pub(super) abs_d_bps_max: Option<f64>,
    pub(super) sample_count: u64,
    pub(super) wins: u64,
    pub(super) p_win: f64,
    pub(super) p_win_lower: f64,
}

#[derive(Serialize)]
pub(super) struct CanonicalBucket {
    pub(super) remaining_sec: u32,
    pub(super) vol_bin: VolBin,
    pub(super) side_leading: SideLeading,
    pub(super) abs_d_bps_min: f64,
    pub(super) abs_d_bps_max: Option<f64>,
    pub(super) count: u64,
    pub(super) wins: u64,
}
