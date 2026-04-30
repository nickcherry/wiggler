# Wiggler Runtime Bundle v1

Generated: 2026-04-30T18:14:29Z

This bundle contains runtime probability grids for:

BTC, ETH, SOL, XRP, DOGE

It intentionally **does not** include HYPE or BNB.

It also intentionally does **not** encode asset-level quarantine/paper/live flags. The production app should maintain its own tradable-asset whitelist and a single operator-controlled live-trading flag.

## Files

- `wiggler-runtime-manifest.json` — bundle index and asset list.
- `<ASSET>_300s_boundary.runtime.json` — runtime probability grid for each asset.
- `validation_summary.json` — compact OOS calibration/diagnostics summary.
- `wiggler-runtime-config.schema.json` — lightweight JSON schema.
- `CODEX_IMPLEMENTATION_INSTRUCTIONS.md` — implementation instructions for the production app.

## Important limits

- Historical labels use `vwap_chainlink_proxy`, not actual historical Chainlink prints.
- Basis risk versus Chainlink is unmeasured.
- The 0–59s remaining window is not modeled.
- Historical Polymarket order books are not included.
- Production must compare model probability to executable ask/depth, not midpoint.
- Production must use `p_win_lower`, not `p_win`.
