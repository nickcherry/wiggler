#!/usr/bin/env bun
/**
 * Print the runtime probability lookup tables that the live monitor consults
 * each evaluation tick.
 *
 * Each cell is keyed by (asset, vol_bin, side_leading, remaining_sec_bucket,
 * abs_d_bps_bucket); the value the trader cares about is `p_win_lower` (the
 * conservative lower bound, which is what the bot uses against the all-in
 * cost to compute edge). Cells that do not pass the active gates are dimmed.
 *
 * Usage:
 *   ./tools/runtime_tables.ts                    # all assets
 *   ./tools/runtime_tables.ts btc eth             # subset
 *   MIN_P_WIN_LOWER=0.65 ./tools/runtime_tables.ts
 *   MIN_ABS_D_BPS=4 ./tools/runtime_tables.ts
 *   BUNDLE=runtime/wiggler-prod-v1 ./tools/runtime_tables.ts
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, basename } from "node:path";

type Cell = {
  remaining_sec: number;
  vol_bin: "low" | "normal" | "high" | "extreme";
  side_leading: "up_leading" | "down_leading";
  abs_d_bps_min: number;
  abs_d_bps_max: number | null;
  sample_count: number;
  wins: number;
  p_win: number;
  p_win_lower: number;
};

type Bundle = {
  asset: string;
  cells: Cell[];
  min_edge_probability: number;
};

const BUNDLE_DIR = process.env.BUNDLE ?? "runtime/wiggler-prod-v1";
const MIN_P_WIN_LOWER = Number(process.env.MIN_P_WIN_LOWER ?? "0.60");
const MIN_ABS_D_BPS = Number(process.env.MIN_ABS_D_BPS ?? "2.0");
const ASSET_FILTER = process.argv.slice(2).map((a) => a.toLowerCase());

const VOL_ORDER = ["low", "normal", "high", "extreme"] as const;
const SIDE_ORDER = ["up_leading", "down_leading"] as const;

// ANSI helpers
const ansi = process.stdout.isTTY;
const dim = (s: string) => (ansi ? `\x1b[2m${s}\x1b[0m` : s);
const bold = (s: string) => (ansi ? `\x1b[1m${s}\x1b[0m` : s);
const green = (s: string) => (ansi ? `\x1b[32m${s}\x1b[0m` : s);
const red = (s: string) => (ansi ? `\x1b[31m${s}\x1b[0m` : s);
const yellow = (s: string) => (ansi ? `\x1b[33m${s}\x1b[0m` : s);

function loadBundles(): Bundle[] {
  const bundles: Bundle[] = [];
  for (const file of readdirSync(BUNDLE_DIR).sort()) {
    if (!file.endsWith(".runtime.json")) continue;
    const path = join(BUNDLE_DIR, file);
    const data = JSON.parse(readFileSync(path, "utf8"));
    const asset = (data.asset ?? basename(file).split("_")[0]).toLowerCase();
    if (ASSET_FILTER.length && !ASSET_FILTER.includes(asset)) continue;
    bundles.push({
      asset,
      cells: data.cells as Cell[],
      min_edge_probability: data.risk_defaults?.min_edge_probability ?? 0,
    });
  }
  return bundles;
}

function fmtBucket(min: number, max: number | null): string {
  return max === null ? `[${min},∞)` : `[${min},${max})`;
}

function passesGate(cell: Cell): boolean {
  return cell.p_win_lower >= MIN_P_WIN_LOWER && cell.abs_d_bps_min >= MIN_ABS_D_BPS;
}

function colorizePWin(v: number, passes: boolean): string {
  const s = v.toFixed(3);
  if (!passes) return dim(s);
  if (v >= 0.75) return green(bold(s));
  if (v >= 0.65) return green(s);
  if (v >= 0.60) return yellow(s);
  return red(s);
}

function printAssetTable(b: Bundle): void {
  console.log(bold(`\n=== ${b.asset.toUpperCase()} (${b.cells.length} cells, min_edge_probability=${b.min_edge_probability}) ===`));

  const cols = ["vol", "rem_s", "side", "|d_bps|", "samples", "p_win", "p_win_lower", "edge_vs_cell_min"];
  const widths = [7, 5, 13, 11, 9, 7, 11, 16];
  console.log(cols.map((c, i) => c.padEnd(widths[i])).join(" "));
  console.log(widths.map((w) => "-".repeat(w)).join(" "));

  // sort cells: vol_bin → remaining_sec → side_leading → abs_d_bps_min
  const sorted = [...b.cells].sort((a, c) => {
    const va = VOL_ORDER.indexOf(a.vol_bin);
    const vc = VOL_ORDER.indexOf(c.vol_bin);
    if (va !== vc) return va - vc;
    if (a.remaining_sec !== c.remaining_sec) return a.remaining_sec - c.remaining_sec;
    const sa = SIDE_ORDER.indexOf(a.side_leading);
    const sc = SIDE_ORDER.indexOf(c.side_leading);
    if (sa !== sc) return sa - sc;
    return a.abs_d_bps_min - c.abs_d_bps_min;
  });

  let last_vol = "";
  let last_rem = -1;
  for (const cell of sorted) {
    const passes = passesGate(cell);
    const vol = cell.vol_bin === last_vol && cell.remaining_sec === last_rem ? "" : cell.vol_bin;
    const rem = cell.remaining_sec === last_rem && cell.vol_bin === last_vol ? "" : String(cell.remaining_sec);
    if (cell.vol_bin !== last_vol) {
      last_vol = cell.vol_bin;
      last_rem = -1;
    }
    if (cell.remaining_sec !== last_rem) last_rem = cell.remaining_sec;

    const row = [
      vol.padEnd(widths[0]),
      rem.padEnd(widths[1]),
      cell.side_leading.padEnd(widths[2]),
      fmtBucket(cell.abs_d_bps_min, cell.abs_d_bps_max).padEnd(widths[3]),
      String(cell.sample_count).padStart(widths[4]),
      cell.p_win.toFixed(3).padStart(widths[5]),
      colorizePWin(cell.p_win_lower, passes).padStart(widths[6] + (ansi ? 9 : 0)),
      // edge vs the bundle's min_edge_probability, assuming bid=cell.p_win_lower-min_edge as the lowest still-acceptable cost
      (cell.p_win_lower - b.min_edge_probability).toFixed(3).padStart(widths[7]),
    ];
    const line = row.join(" ");
    console.log(passes ? line : dim(line));
  }
}

function summary(bundles: Bundle[]): void {
  console.log(bold("\n=== Summary across all bundles ==="));
  console.log(
    dim(
      `gates: p_win_lower >= ${MIN_P_WIN_LOWER}, |d_bps| >= ${MIN_ABS_D_BPS}; cells passing both shown bright, others dimmed`,
    ),
  );
  const head = ["asset", "cells", "passing", "%pass", "best_p_win_lower", "min_passing_p_win_lower"];
  const widths = [6, 6, 8, 6, 18, 24];
  console.log(head.map((c, i) => c.padEnd(widths[i])).join(" "));
  console.log(widths.map((w) => "-".repeat(w)).join(" "));
  for (const b of bundles) {
    const passing = b.cells.filter(passesGate);
    const best = b.cells.reduce((m, c) => Math.max(m, c.p_win_lower), 0);
    const minPassing = passing.length
      ? passing.reduce((m, c) => Math.min(m, c.p_win_lower), 1)
      : NaN;
    const row = [
      b.asset.toUpperCase(),
      String(b.cells.length),
      String(passing.length),
      `${((100 * passing.length) / b.cells.length).toFixed(1)}%`,
      best.toFixed(3),
      Number.isNaN(minPassing) ? "-" : minPassing.toFixed(3),
    ];
    console.log(row.map((c, i) => c.padEnd(widths[i])).join(" "));
  }
}

const bundles = loadBundles();
if (!bundles.length) {
  console.error(`no runtime bundles in ${BUNDLE_DIR}`);
  process.exit(1);
}
for (const b of bundles) printAssetTable(b);
summary(bundles);
