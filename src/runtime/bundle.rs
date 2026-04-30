use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    str::FromStr,
};

use anyhow::{Context, Result, bail};
use serde::Deserialize;

use crate::domain::asset::Asset;

const EXPECTED_RUNTIME_VERSION: &str = "wiggler-runtime-prob-grid-v1";
const EXPECTED_MANIFEST_VERSION: &str = "wiggler-runtime-bundle-v1";
const EXPECTED_MARKET_TYPE: &str = "up_down";
const EXPECTED_INTERVAL_SEC: u32 = 300;
const EXPECTED_ANCHOR_MODE: &str = "boundary";

#[derive(Clone, Debug)]
pub struct RuntimeBundle {
    manifest_version: String,
    configs: HashMap<Asset, AssetRuntime>,
}

impl RuntimeBundle {
    pub fn load(dir: impl AsRef<Path>) -> Result<Self> {
        let dir = dir.as_ref();
        let manifest_path = dir.join("wiggler-runtime-manifest.json");
        let manifest = read_json::<Manifest>(&manifest_path)?;
        if manifest.version != EXPECTED_MANIFEST_VERSION {
            bail!("unsupported runtime manifest version: {}", manifest.version);
        }
        let mut configs = HashMap::new();

        for entry in &manifest.runtime_configs {
            let asset = parse_asset(&entry.asset)?;
            let config_path = dir.join(&entry.path);
            let config = read_json::<RuntimeConfigFile>(&config_path)
                .with_context(|| format!("load runtime config {}", config_path.display()))?;

            validate_config(&config, entry)?;
            if configs
                .insert(asset, AssetRuntime::from_config(config))
                .is_some()
            {
                bail!("duplicate runtime config for asset {asset}");
            }
        }

        Ok(Self {
            manifest_version: manifest.version,
            configs,
        })
    }

    pub fn manifest_version(&self) -> &str {
        &self.manifest_version
    }

    pub fn config_for(&self, asset: Asset) -> Option<&AssetRuntime> {
        self.configs.get(&asset)
    }

    pub fn assets(&self) -> Vec<Asset> {
        let mut assets = self.configs.keys().copied().collect::<Vec<_>>();
        assets.sort();
        assets
    }
}

#[derive(Clone, Debug)]
pub struct AssetRuntime {
    config: RuntimeConfigFile,
    sorted_buckets: Vec<u32>,
}

impl AssetRuntime {
    fn from_config(config: RuntimeConfigFile) -> Self {
        let mut sorted_buckets = config.remaining_sec_buckets.clone();
        sorted_buckets.sort_unstable();

        Self {
            config,
            sorted_buckets,
        }
    }

    pub fn runtime_config_hash(&self) -> &str {
        &self.config.runtime_config_hash
    }

    pub fn source_config_hash(&self) -> &str {
        &self.config.source.config_hash
    }

    pub fn training_input_hash(&self) -> &str {
        &self.config.source.training_input_hash
    }

    pub fn fee_rate(&self) -> f64 {
        self.config.fee.taker_fee_rate
    }

    pub fn min_edge_probability(&self) -> f64 {
        self.config.risk_defaults.min_edge_probability
    }

    pub fn max_position_usdc(&self) -> f64 {
        self.config.risk_defaults.max_position_usdc
    }

    pub fn vol_lookback_min(&self) -> u32 {
        self.config.vol_bins.vol_lookback_min
    }

    pub fn min_remaining_sec_to_trade(&self) -> i64 {
        i64::from(self.config.risk_defaults.min_remaining_sec_to_trade)
    }

    pub fn max_remaining_sec_to_trade(&self) -> i64 {
        self.sorted_buckets
            .last()
            .copied()
            .map(i64::from)
            .unwrap_or_default()
    }

    pub fn remaining_bucket(&self, remaining_sec: i64) -> Option<u32> {
        if remaining_sec < self.min_remaining_sec_to_trade() {
            return None;
        }

        let remaining_sec: u32 = remaining_sec.try_into().ok()?;
        self.sorted_buckets
            .iter()
            .copied()
            .find(|bucket| *bucket >= remaining_sec)
    }

    pub fn vol_bin(&self, vol_bps_per_sqrt_min: f64) -> VolBin {
        let thresholds = &self.config.vol_bins.thresholds_bps_per_sqrt_min;
        if vol_bps_per_sqrt_min <= thresholds.low_max_bps_per_sqrt_min {
            VolBin::Low
        } else if vol_bps_per_sqrt_min <= thresholds.normal_max_bps_per_sqrt_min {
            VolBin::Normal
        } else if vol_bps_per_sqrt_min <= thresholds.high_max_bps_per_sqrt_min {
            VolBin::High
        } else {
            VolBin::Extreme
        }
    }

    pub fn find_cell(
        &self,
        remaining_sec: u32,
        vol_bin: VolBin,
        side_leading: SideLeading,
        abs_d_bps: f64,
    ) -> Option<&RuntimeCell> {
        self.config.cells.iter().find(|cell| {
            cell.remaining_sec == remaining_sec
                && cell.vol_bin == vol_bin
                && cell.side_leading == side_leading
                && cell.abs_d_bps_min <= abs_d_bps
                && cell.abs_d_bps_max.is_none_or(|max| abs_d_bps < max)
        })
    }
}

#[derive(Clone, Debug, Deserialize)]
struct Manifest {
    version: String,
    runtime_configs: Vec<ManifestRuntimeConfig>,
}

#[derive(Clone, Debug, Deserialize)]
struct ManifestRuntimeConfig {
    asset: String,
    path: PathBuf,
    runtime_config_hash: String,
    source_config_hash: String,
    training_input_hash: String,
    interval_sec: u32,
    anchor_mode: String,
}

#[derive(Clone, Debug, Deserialize)]
struct RuntimeConfigFile {
    version: String,
    #[serde(deserialize_with = "deserialize_asset")]
    asset: Asset,
    market_type: String,
    interval_sec: u32,
    anchor_mode: String,
    source: SourceConfig,
    remaining_sec_buckets: Vec<u32>,
    vol_bins: VolBinsConfig,
    fee: FeeConfig,
    risk_defaults: RiskDefaults,
    cells: Vec<RuntimeCell>,
    runtime_config_hash: String,
}

#[derive(Clone, Debug, Deserialize)]
struct SourceConfig {
    config_hash: String,
    training_input_hash: String,
}

#[derive(Clone, Debug, Deserialize)]
struct VolBinsConfig {
    thresholds_bps_per_sqrt_min: VolThresholds,
    vol_lookback_min: u32,
}

#[derive(Clone, Debug, Deserialize)]
struct VolThresholds {
    #[serde(rename = "lowMaxBpsPerSqrtMin")]
    low_max_bps_per_sqrt_min: f64,
    #[serde(rename = "normalMaxBpsPerSqrtMin")]
    normal_max_bps_per_sqrt_min: f64,
    #[serde(rename = "highMaxBpsPerSqrtMin")]
    high_max_bps_per_sqrt_min: f64,
}

#[derive(Clone, Debug, Deserialize)]
struct FeeConfig {
    taker_fee_rate: f64,
}

#[derive(Clone, Debug, Deserialize)]
struct RiskDefaults {
    min_remaining_sec_to_trade: u32,
    min_edge_probability: f64,
    max_position_usdc: f64,
}

#[derive(Clone, Debug, Deserialize)]
pub struct RuntimeCell {
    pub remaining_sec: u32,
    pub vol_bin: VolBin,
    pub side_leading: SideLeading,
    pub abs_d_bps_min: f64,
    pub abs_d_bps_max: Option<f64>,
    pub sample_count: u64,
    pub p_win_lower: f64,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum VolBin {
    Low,
    Normal,
    High,
    Extreme,
}

impl VolBin {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Low => "low",
            Self::Normal => "normal",
            Self::High => "high",
            Self::Extreme => "extreme",
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum SideLeading {
    UpLeading,
    DownLeading,
}

impl SideLeading {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::UpLeading => "up_leading",
            Self::DownLeading => "down_leading",
        }
    }
}

fn read_json<T>(path: &Path) -> Result<T>
where
    T: for<'de> Deserialize<'de>,
{
    let text = fs::read_to_string(path).with_context(|| format!("read {}", path.display()))?;
    serde_json::from_str(&text).with_context(|| format!("parse {}", path.display()))
}

fn validate_config(config: &RuntimeConfigFile, manifest: &ManifestRuntimeConfig) -> Result<()> {
    let manifest_asset = parse_asset(&manifest.asset)?;
    if config.asset != manifest_asset {
        bail!(
            "runtime asset mismatch: manifest {} vs config {}",
            manifest.asset,
            config.asset
        );
    }
    if config.version != EXPECTED_RUNTIME_VERSION {
        bail!("unsupported runtime config version: {}", config.version);
    }
    if config.market_type != EXPECTED_MARKET_TYPE {
        bail!("unsupported market type: {}", config.market_type);
    }
    if config.interval_sec != EXPECTED_INTERVAL_SEC
        || manifest.interval_sec != EXPECTED_INTERVAL_SEC
    {
        bail!(
            "unsupported interval: config {} manifest {}",
            config.interval_sec,
            manifest.interval_sec
        );
    }
    if config.anchor_mode != EXPECTED_ANCHOR_MODE || manifest.anchor_mode != EXPECTED_ANCHOR_MODE {
        bail!(
            "unsupported anchor mode: config {} manifest {}",
            config.anchor_mode,
            manifest.anchor_mode
        );
    }
    if config.runtime_config_hash != manifest.runtime_config_hash {
        bail!(
            "runtime hash mismatch for {}: manifest {} vs config {}",
            manifest.asset,
            manifest.runtime_config_hash,
            config.runtime_config_hash
        );
    }
    if config.source.config_hash != manifest.source_config_hash {
        bail!(
            "source hash mismatch for {}: manifest {} vs config {}",
            manifest.asset,
            manifest.source_config_hash,
            config.source.config_hash
        );
    }
    if config.source.training_input_hash != manifest.training_input_hash {
        bail!(
            "training input hash mismatch for {}: manifest {} vs config {}",
            manifest.asset,
            manifest.training_input_hash,
            config.source.training_input_hash
        );
    }
    if config.remaining_sec_buckets.is_empty() {
        bail!(
            "runtime config for {} has no remaining-sec buckets",
            config.asset
        );
    }
    if !config.fee.taker_fee_rate.is_finite() || config.fee.taker_fee_rate < 0.0 {
        bail!("runtime config for {} has invalid taker fee", config.asset);
    }
    if !config.risk_defaults.min_edge_probability.is_finite()
        || config.risk_defaults.min_edge_probability < 0.0
    {
        bail!(
            "runtime config for {} has invalid min edge probability",
            config.asset
        );
    }
    if !config.risk_defaults.max_position_usdc.is_finite()
        || config.risk_defaults.max_position_usdc <= 0.0
    {
        bail!(
            "runtime config for {} has invalid max position",
            config.asset
        );
    }
    let thresholds = &config.vol_bins.thresholds_bps_per_sqrt_min;
    if !thresholds.low_max_bps_per_sqrt_min.is_finite()
        || !thresholds.normal_max_bps_per_sqrt_min.is_finite()
        || !thresholds.high_max_bps_per_sqrt_min.is_finite()
        || thresholds.low_max_bps_per_sqrt_min > thresholds.normal_max_bps_per_sqrt_min
        || thresholds.normal_max_bps_per_sqrt_min > thresholds.high_max_bps_per_sqrt_min
    {
        bail!(
            "runtime config for {} has invalid vol thresholds",
            config.asset
        );
    }
    if config.cells.iter().any(|cell| {
        !cell.abs_d_bps_min.is_finite()
            || cell
                .abs_d_bps_max
                .is_some_and(|max| !max.is_finite() || max <= cell.abs_d_bps_min)
            || !cell.p_win_lower.is_finite()
            || !(0.0..=1.0).contains(&cell.p_win_lower)
    }) {
        bail!(
            "runtime config for {} has invalid cell values",
            config.asset
        );
    }

    Ok(())
}

fn parse_asset(value: &str) -> Result<Asset> {
    Asset::from_str(value).map_err(anyhow::Error::msg)
}

fn deserialize_asset<'de, D>(deserializer: D) -> Result<Asset, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = String::deserialize(deserializer)?;
    Asset::from_str(&value).map_err(serde::de::Error::custom)
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::{RuntimeBundle, SideLeading, VolBin};
    use crate::domain::asset::Asset;

    #[test]
    fn loads_embedded_runtime_bundle() {
        let bundle = RuntimeBundle::load(bundle_dir()).unwrap();
        assert_eq!(
            bundle.assets(),
            vec![Asset::Btc, Asset::Eth, Asset::Sol, Asset::Xrp, Asset::Doge]
        );
        assert_eq!(bundle.manifest_version(), "wiggler-runtime-bundle-v1");
    }

    #[test]
    fn maps_remaining_seconds_to_next_bucket() {
        let bundle = RuntimeBundle::load(bundle_dir()).unwrap();
        let btc = bundle.config_for(Asset::Btc).unwrap();

        assert_eq!(btc.remaining_bucket(240), Some(240));
        assert_eq!(btc.remaining_bucket(211), Some(240));
        assert_eq!(btc.remaining_bucket(180), Some(180));
        assert_eq!(btc.remaining_bucket(121), Some(180));
        assert_eq!(btc.remaining_bucket(120), Some(120));
        assert_eq!(btc.remaining_bucket(61), Some(120));
        assert_eq!(btc.remaining_bucket(60), Some(60));
        assert_eq!(btc.remaining_bucket(59), None);
        assert_eq!(btc.remaining_bucket(241), None);
    }

    #[test]
    fn finds_cells_using_lower_bound_probability_inputs() {
        let bundle = RuntimeBundle::load(bundle_dir()).unwrap();
        let btc = bundle.config_for(Asset::Btc).unwrap();
        let cell = btc
            .find_cell(60, VolBin::Low, SideLeading::UpLeading, 2.5)
            .unwrap();

        assert_eq!(cell.sample_count, 4972);
        assert!((cell.p_win_lower - 0.865739).abs() < 0.000001);
    }

    fn bundle_dir() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("runtime/wiggler-prod-v1")
    }
}
