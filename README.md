# Alea

Probabilistic tooling for Polymarket's 5-minute crypto up/down markets.
Alea studies live exchange feeds, trains settlement-side probability
surfaces from historical candles, and runs the gated trader that only acts
when the modeled edge clears the market.

## Docs

### Operator Workflows

- [CLI](./doc/CLI.md) — command structure, examples, and side effects.
- [Latency Experiment](./doc/LATENCY_EXPERIMENT.md) — finding the fastest useful leading-indicator feeds.
- [Directional Agreement Experiment](./doc/RELIABILITY_EXPERIMENT.md) — checking whether candidate feeds land on the same 5-minute side as Polymarket.
- [Training Domain](./doc/TRAINING_DOMAIN.md) — historical candle analysis and threshold discovery.
- [Trading Domain](./doc/TRADING.md) — the live money-touching runner and failure modes.
- [Dashboards](./doc/DASHBOARDS.md) — shared visual language for HTML reports in `tmp/`.

### Engineering

- [Polymarket Integration](./doc/POLYMARKET.md) — endpoint contracts and external docs we rely on.
- [Coding Conventions](./doc/CODING_CONVENTIONS.md) — repo structure, TypeScript style, and testing expectations.
- [Documentation](./doc/DOCUMENTATION.md) — how project docs should be written and maintained.
- [How To Work With Nick](./doc/HOW_TO_WORK_WITH_NICK.md) — collaboration preferences.

### Research

- [Research notes](./doc/research/) — dated findings, methodology
  changes, and per-filter intuition from offline-analysis sessions.
  Long-term memory for what we've tried and why.
