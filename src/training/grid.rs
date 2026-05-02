use serde::Serialize;

pub const ABS_D_BPS_BOUNDARIES: &[f64] = &[
    0.0, 2.0, 4.0, 6.0, 8.0, 10.0, 15.0, 20.0, 25.0, 30.0, 40.0, 50.0, 75.0,
];
pub const DECISION_REMAINING_SECS: &[u32] = &[60, 120, 180, 240];
pub const VOL_LOOKBACK_MIN: usize = 30;
pub const INTERVAL_SEC: u32 = 300;
pub const ANCHOR_STEP_MIN: usize = 5;
const WILSON_Z_95_ONE_SIDED: f64 = 1.644_853_626_951_472_2;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum VolBin {
    Low,
    Normal,
    High,
    Extreme,
}

const VOL_BINS: &[VolBin] = &[VolBin::Low, VolBin::Normal, VolBin::High, VolBin::Extreme];

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SideLeading {
    UpLeading,
    DownLeading,
    AtLine,
}

const SIDES_LEADING: &[SideLeading] = &[
    SideLeading::UpLeading,
    SideLeading::DownLeading,
    SideLeading::AtLine,
];

#[derive(Clone, Copy, Debug)]
pub struct ClosePoint {
    pub ts_ms: i64,
    pub close_e8: i64,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VolBinThresholds {
    pub low_max_bps_per_sqrt_min: f64,
    pub normal_max_bps_per_sqrt_min: f64,
    pub high_max_bps_per_sqrt_min: f64,
}

#[derive(Clone, Debug)]
pub struct WinProbGrid {
    pub interval_sec: u32,
    pub anchor_step_min: usize,
    pub decision_remaining_secs: Vec<u32>,
    pub abs_d_bps_boundaries: Vec<f64>,
    pub vol_bin_thresholds: VolBinThresholds,
    pub total_rows: u64,
    pub up_win_anchors: u64,
    pub down_win_anchors: u64,
    pub first_anchor_open_time_ms: Option<i64>,
    pub last_interval_end_open_time_ms: Option<i64>,
    pub buckets: Vec<WinProbBucket>,
}

#[derive(Clone, Debug, Serialize)]
pub struct WinProbBucket {
    pub remaining_sec: u32,
    pub vol_bin: VolBin,
    pub side_leading: SideLeading,
    pub abs_d_bps_min: f64,
    pub abs_d_bps_max: Option<f64>,
    pub count: u64,
    pub wins: u64,
    pub p_win: f64,
    pub p_win_lower: f64,
    pub tradable: bool,
}

pub fn build_win_prob_grid(closes: &[ClosePoint], min_bucket_count: u64) -> WinProbGrid {
    let interval_min = usize::try_from(INTERVAL_SEC / 60).expect("interval fits usize");
    let series = build_series_arrays(closes, VOL_LOOKBACK_MIN);
    let mut decision_vol_values = Vec::new();

    for anchor_idx in (0..series.total_minutes).step_by(ANCHOR_STEP_MIN) {
        if anchor_idx + interval_min >= series.total_minutes {
            break;
        }
        let Some(line) = series.close_at[anchor_idx] else {
            continue;
        };
        let Some(final_price) = series.close_at[anchor_idx + interval_min] else {
            continue;
        };
        if line <= 0 || final_price <= 0 {
            continue;
        }

        for remaining_sec in DECISION_REMAINING_SECS {
            let elapsed_min =
                usize::try_from((INTERVAL_SEC - remaining_sec) / 60).expect("elapsed fits usize");
            let decision_idx = anchor_idx + elapsed_min;
            let Some(current) = series.close_at[decision_idx] else {
                continue;
            };
            if current <= 0 {
                continue;
            }
            if let Some(vol) = series.recent_vol_at[decision_idx] {
                decision_vol_values.push(vol);
            }
        }
    }

    if decision_vol_values.is_empty() {
        return empty_grid();
    }

    let vol_bin_thresholds = derive_vol_bin_thresholds(&decision_vol_values);
    let bucket_count = DECISION_REMAINING_SECS.len()
        * VOL_BINS.len()
        * SIDES_LEADING.len()
        * ABS_D_BPS_BOUNDARIES.len();
    let mut counters = vec![Counter::default(); bucket_count];
    let mut total_rows = 0_u64;
    let mut up_win_anchors = 0_u64;
    let mut down_win_anchors = 0_u64;
    let mut first_anchor_open_time_ms = None;
    let mut last_interval_end_open_time_ms = None;

    for anchor_idx in (0..series.total_minutes).step_by(ANCHOR_STEP_MIN) {
        if anchor_idx + interval_min >= series.total_minutes {
            break;
        }
        let anchor_ms = series.base_ms + i64::try_from(anchor_idx).unwrap_or(0) * 60_000;
        let Some(line) = series.close_at[anchor_idx] else {
            continue;
        };
        let Some(final_price) = series.close_at[anchor_idx + interval_min] else {
            continue;
        };
        if line <= 0 || final_price <= 0 {
            continue;
        }
        let winning_side = if final_price >= line {
            AbsoluteSide::Up
        } else {
            AbsoluteSide::Down
        };
        match winning_side {
            AbsoluteSide::Up => up_win_anchors += 1,
            AbsoluteSide::Down => down_win_anchors += 1,
        }
        first_anchor_open_time_ms.get_or_insert(anchor_ms);
        last_interval_end_open_time_ms =
            Some(series.base_ms + i64::try_from(anchor_idx + interval_min).unwrap_or(0) * 60_000);

        for remaining_sec in DECISION_REMAINING_SECS {
            let elapsed_min =
                usize::try_from((INTERVAL_SEC - remaining_sec) / 60).expect("elapsed fits usize");
            let decision_idx = anchor_idx + elapsed_min;
            let Some(current) = series.close_at[decision_idx] else {
                continue;
            };
            if current <= 0 {
                continue;
            }
            let Some(vol) = series.recent_vol_at[decision_idx] else {
                continue;
            };
            let d_bps = bps_change(current, line);
            let side_leading = if d_bps > 0.0 {
                SideLeading::UpLeading
            } else if d_bps < 0.0 {
                SideLeading::DownLeading
            } else {
                SideLeading::AtLine
            };
            let current_side = if d_bps >= 0.0 {
                AbsoluteSide::Up
            } else {
                AbsoluteSide::Down
            };
            let vol_bin = bin_vol(vol, vol_bin_thresholds);
            let bucket_idx = bucket_abs_d_bps(d_bps.abs(), ABS_D_BPS_BOUNDARIES);
            let counter_idx = counter_index(*remaining_sec, vol_bin, side_leading, bucket_idx);
            let counter = &mut counters[counter_idx];
            counter.count += 1;
            if current_side == winning_side {
                counter.wins += 1;
            }
            total_rows += 1;
        }
    }

    let mut buckets = Vec::new();
    for remaining_sec in DECISION_REMAINING_SECS {
        for vol_bin in VOL_BINS {
            for side_leading in SIDES_LEADING {
                for bucket_idx in 0..ABS_D_BPS_BOUNDARIES.len() {
                    if *side_leading == SideLeading::AtLine && bucket_idx != 0 {
                        continue;
                    }
                    let counter = counters
                        [counter_index(*remaining_sec, *vol_bin, *side_leading, bucket_idx)];
                    let p_win = if counter.count == 0 {
                        0.0
                    } else {
                        counter.wins as f64 / counter.count as f64
                    };
                    let (abs_d_bps_min, abs_d_bps_max) =
                        bucket_range(bucket_idx, ABS_D_BPS_BOUNDARIES);
                    buckets.push(WinProbBucket {
                        remaining_sec: *remaining_sec,
                        vol_bin: *vol_bin,
                        side_leading: *side_leading,
                        abs_d_bps_min,
                        abs_d_bps_max,
                        count: counter.count,
                        wins: counter.wins,
                        p_win,
                        p_win_lower: wilson_lower_bound(counter.wins, counter.count),
                        tradable: counter.count >= min_bucket_count && counter.count > 0,
                    });
                }
            }
        }
    }

    WinProbGrid {
        interval_sec: INTERVAL_SEC,
        anchor_step_min: ANCHOR_STEP_MIN,
        decision_remaining_secs: DECISION_REMAINING_SECS.to_vec(),
        abs_d_bps_boundaries: ABS_D_BPS_BOUNDARIES.to_vec(),
        vol_bin_thresholds,
        total_rows,
        up_win_anchors,
        down_win_anchors,
        first_anchor_open_time_ms,
        last_interval_end_open_time_ms,
        buckets,
    }
}

#[derive(Clone, Copy, Debug, Default)]
struct Counter {
    count: u64,
    wins: u64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum AbsoluteSide {
    Up,
    Down,
}

struct SeriesArrays {
    base_ms: i64,
    total_minutes: usize,
    close_at: Vec<Option<i64>>,
    recent_vol_at: Vec<Option<f64>>,
}

fn build_series_arrays(closes: &[ClosePoint], vol_lookback_min: usize) -> SeriesArrays {
    if closes.is_empty() {
        return SeriesArrays {
            base_ms: 0,
            total_minutes: 0,
            close_at: Vec::new(),
            recent_vol_at: Vec::new(),
        };
    }

    let base_ms = closes[0].ts_ms;
    let last_ms = closes[closes.len() - 1].ts_ms;
    let total_minutes = usize::try_from(((last_ms - base_ms) / 60_000) + 1).unwrap_or(0);
    let mut close_at = vec![None; total_minutes];
    for close in closes {
        let idx = (close.ts_ms - base_ms) / 60_000;
        if let Ok(idx) = usize::try_from(idx)
            && idx < total_minutes
        {
            close_at[idx] = Some(close.close_e8);
        }
    }

    let mut return_at = vec![None; total_minutes];
    for i in 1..total_minutes {
        if let (Some(prev), Some(curr)) = (close_at[i - 1], close_at[i])
            && prev > 0
        {
            return_at[i] = Some(bps_change(curr, prev));
        }
    }

    let min_samples = (vol_lookback_min / 2).max(5);
    let mut recent_vol_at = vec![None; total_minutes];
    for (i, recent_vol) in recent_vol_at.iter_mut().enumerate().take(total_minutes) {
        let Some(start) = i.checked_sub(vol_lookback_min) else {
            continue;
        };
        let mut sum_sq = 0.0;
        let mut n = 0_usize;
        for value in return_at.iter().take(i).skip(start).flatten() {
            sum_sq += value * value;
            n += 1;
        }
        if n >= min_samples {
            *recent_vol = Some((sum_sq / n as f64).sqrt());
        }
    }

    SeriesArrays {
        base_ms,
        total_minutes,
        close_at,
        recent_vol_at,
    }
}

fn empty_grid() -> WinProbGrid {
    WinProbGrid {
        interval_sec: INTERVAL_SEC,
        anchor_step_min: ANCHOR_STEP_MIN,
        decision_remaining_secs: DECISION_REMAINING_SECS.to_vec(),
        abs_d_bps_boundaries: ABS_D_BPS_BOUNDARIES.to_vec(),
        vol_bin_thresholds: VolBinThresholds {
            low_max_bps_per_sqrt_min: 0.0,
            normal_max_bps_per_sqrt_min: 0.0,
            high_max_bps_per_sqrt_min: 0.0,
        },
        total_rows: 0,
        up_win_anchors: 0,
        down_win_anchors: 0,
        first_anchor_open_time_ms: None,
        last_interval_end_open_time_ms: None,
        buckets: Vec::new(),
    }
}

fn counter_index(
    remaining_sec: u32,
    vol_bin: VolBin,
    side_leading: SideLeading,
    bucket_idx: usize,
) -> usize {
    let remaining_idx = DECISION_REMAINING_SECS
        .iter()
        .position(|value| *value == remaining_sec)
        .expect("remaining bucket is configured");
    let vol_idx = VOL_BINS
        .iter()
        .position(|value| *value == vol_bin)
        .expect("vol bin is configured");
    let side_idx = SIDES_LEADING
        .iter()
        .position(|value| *value == side_leading)
        .expect("side is configured");
    (((remaining_idx * VOL_BINS.len()) + vol_idx) * SIDES_LEADING.len() + side_idx)
        * ABS_D_BPS_BOUNDARIES.len()
        + bucket_idx
}

fn bucket_abs_d_bps(abs_d_bps: f64, boundaries: &[f64]) -> usize {
    if abs_d_bps >= boundaries[boundaries.len() - 1] {
        return boundaries.len() - 1;
    }
    for i in (0..boundaries.len()).rev() {
        if abs_d_bps >= boundaries[i] {
            return i;
        }
    }
    0
}

fn bucket_range(index: usize, boundaries: &[f64]) -> (f64, Option<f64>) {
    let min = boundaries[index];
    let max = boundaries.get(index + 1).copied();
    (min, max)
}

pub fn bin_vol(value: f64, thresholds: VolBinThresholds) -> VolBin {
    if value <= thresholds.low_max_bps_per_sqrt_min {
        VolBin::Low
    } else if value <= thresholds.normal_max_bps_per_sqrt_min {
        VolBin::Normal
    } else if value <= thresholds.high_max_bps_per_sqrt_min {
        VolBin::High
    } else {
        VolBin::Extreme
    }
}

fn derive_vol_bin_thresholds(values: &[f64]) -> VolBinThresholds {
    let mut sorted = values.to_vec();
    sorted.sort_by(|a, b| a.total_cmp(b));
    VolBinThresholds {
        low_max_bps_per_sqrt_min: percentile(&sorted, 0.33),
        normal_max_bps_per_sqrt_min: percentile(&sorted, 0.67),
        high_max_bps_per_sqrt_min: percentile(&sorted, 0.9),
    }
}

fn percentile(sorted: &[f64], q: f64) -> f64 {
    if sorted.len() == 1 {
        return sorted[0];
    }
    let pos = q * (sorted.len() - 1) as f64;
    let lo = pos.floor() as usize;
    let hi = pos.ceil() as usize;
    if lo == hi {
        sorted[lo]
    } else {
        let frac = pos - lo as f64;
        sorted[lo] * (1.0 - frac) + sorted[hi] * frac
    }
}

fn bps_change(current: i64, previous: i64) -> f64 {
    10_000.0 * (current as f64 / previous as f64 - 1.0)
}

fn wilson_lower_bound(wins: u64, count: u64) -> f64 {
    if count == 0 {
        return 0.0;
    }
    let n = count as f64;
    let phat = wins as f64 / n;
    let z2 = WILSON_Z_95_ONE_SIDED * WILSON_Z_95_ONE_SIDED;
    let denom = 1.0 + z2 / n;
    let center = phat + z2 / (2.0 * n);
    let margin = WILSON_Z_95_ONE_SIDED * ((phat * (1.0 - phat) + z2 / (4.0 * n)) / n).sqrt();
    ((center - margin) / denom).clamp(0.0, 1.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_abs_distance_to_tail_bucket() {
        assert_eq!(bucket_abs_d_bps(0.0, ABS_D_BPS_BOUNDARIES), 0);
        assert_eq!(bucket_abs_d_bps(1.99, ABS_D_BPS_BOUNDARIES), 0);
        assert_eq!(bucket_abs_d_bps(2.0, ABS_D_BPS_BOUNDARIES), 1);
        assert_eq!(bucket_abs_d_bps(75.0, ABS_D_BPS_BOUNDARIES), 12);
    }

    #[test]
    fn no_lookahead_bias_resolution_bar_never_enters_decision_row() {
        let mut closes = Vec::new();
        for i in 0..40_i64 {
            closes.push(ClosePoint {
                ts_ms: i * 60_000,
                close_e8: 100_000_000 + i,
            });
        }
        let series = build_series_arrays(&closes, VOL_LOOKBACK_MIN);
        let anchor_idx = 30_usize;
        let remaining_sec = 60;
        let elapsed_min = usize::try_from((INTERVAL_SEC - remaining_sec) / 60).unwrap();
        let decision_idx = anchor_idx + elapsed_min;
        let resolution_idx = anchor_idx + usize::try_from(INTERVAL_SEC / 60).unwrap();

        assert_eq!(decision_idx, anchor_idx + 4);
        assert_eq!(resolution_idx, anchor_idx + 5);
        assert_ne!(
            series.close_at[decision_idx],
            series.close_at[resolution_idx]
        );
    }

    #[test]
    fn wilson_lower_bound_is_conservative() {
        let lower = wilson_lower_bound(4344, 4972);
        assert!((lower - 0.865_739).abs() < 0.000_01);
    }
}
