# Alea

Probabilistic trader for Polymarket's 5-minute crypto up/down markets. We model the conditional distribution of where the underlying ends up by the close of each window, compare that to Polymarket's current odds, and only take the bet when our edge over the market is real.

## Docs

1. [How To Work With Nick](./doc/HOW_TO_WORK_WITH_NICK.md)
2. [Coding Conventions](./doc/CODING_CONVENTIONS.md)
3. [CLI](./doc/CLI.md)
4. [Latency Experiment](./doc/LATENCY_EXPERIMENT.md) — picking the leading-indicator feeds the model conditions on
5. [Training Domain](./doc/TRAINING_DOMAIN.md) — exploring historic candles to find live-trading thresholds
6. [Temporary Dashboards](./doc/TEMP_DASHBOARDS.md) — design language shared across the HTML pages we drop into `tmp/`
7. [Documentation](./doc/DOCUMENTATION.md)
