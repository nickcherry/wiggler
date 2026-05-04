# Research

Notes, findings, and intuition from offline-analysis sessions. Lives under
`doc/` rather than in the source tree so the actual code stays focused on
what we ship; this directory is the long-term institutional memory of
*what we tried, what worked, what didn't, and why*.

The intended audience is future-us (and future-Claude) re-opening a
question we've already explored once. Each note is dated and self-
contained — read it cold.

## When to add a note here

- After a meaningful experiment or methodology change in training/.
- After pruning code that we might want to revisit (capture the rationale
  *before* the diff lands so we can find it later via grep).
- After noticing a structural pattern in the data that's not obvious from
  the live scoring system alone.

## How to write one

- One file per session/topic, prefixed with the date: `YYYY-MM-DD-<slug>.md`.
- Open with the question you were trying to answer and the *takeaway in
  one paragraph*. The rest is the supporting work.
- Concrete numbers (calibration scores, sample counts, deltas) belong in
  tables, not prose. Future-us will look them up.
- Link to the relevant source files at the time of writing — paths can
  drift, but a `git log -p` from the file path usually finds what you
  meant. Inline links to specific commits are even better.

## Index

- [2026-05-04 — Filter scoring overhaul](./2026-05-04-filter-scoring-overhaul.md):
  why we replaced the global-baseline score with a filter-conditioned
  per-cell score plus a population-normalized log-loss-improvement
  headline (`calibrationScore`); what skip-selection bias was doing to
  the old rankings; new per-cell metrics (`sharpe`,
  `logLossImprovementNats`).
- [2026-05-04 — Filter archive](./2026-05-04-filter-archive.md): hard
  numbers (calibration % vs no-filter, per asset) for every filter we've
  evaluated to date, plus the per-filter intuition behind each. The
  reference for "should I bother re-implementing X?".
- [2026-05-04 — Sweet-spot detection](./2026-05-04-sweet-spot.md):
  why we identify the contiguous bp range that captures most of a
  filter's edge, the algorithm we use, the choice of 80% as the
  info-gain capture threshold, and the trading-discipline
  interpretation. Includes the threshold trade-off table for the
  champion filter.
- [2026-05-04 — Bumping the sample floor](./2026-05-04-sample-floor.md):
  why we raised `SUMMARY_MIN_SAMPLES` from 300 to 2000 — including the
  sample-composition artifact at low bp for `distance_from_line_atr`
  that the old floor wasn't strict enough to filter out, and the
  before/after impact on calibration scores and sweet-spot ranges.
