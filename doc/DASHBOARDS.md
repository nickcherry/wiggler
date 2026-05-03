# Dashboards

This is the design contract for the standalone HTML pages we drop into
`alea/tmp/` from CLI commands like `latency:capture` and
`training:distributions`. These pages are not product surfaces and are not
shipped anywhere — they exist for one operator (or one agent) to read a
particular analysis result quickly. The contract below exists so each new
page slots into the same visual language without bikeshedding.

## What "temp dashboard" means

- A single self-contained `.html` file written to `alea/tmp/`.
- All assets (CSS, JS, data) inlined or pulled from a public CDN. No build
  step, no asset pipeline. The file should still render correctly if you
  open it from disk a year from now.
- One companion `.json` file written next to the HTML, with the raw payload
  the page renders. The JSON is the source of truth; the HTML is a view.
- Auto-opened on macOS via `open <path>` unless `--no-open` is passed.
- Written in the **Alea dark theme** — see "Visual identity" below. The
  dark felt-green panels with antique-gold accents are the shared brand
  identity across every Alea report.

## Stack

- **Alea design system**:
  [`src/lib/ui/aleaDesignSystem.ts`](../src/lib/ui/aleaDesignSystem.ts).
  Inline `aleaDesignSystemHead()` in `<head>` to pull in fonts and the
  shared `<style>` block (tokens, base layout, cards, tabs, tables,
  tooltip, legend, section rule). Inline `aleaBrandMark()` in the header
  for the dice + `Alea` wordmark. Read `aleaChartTokens` for axis/grid/
  reference-line colors so uPlot configs stay in lockstep with the
  page palette.
- **uPlot 1.6**: charting. Same version pinned across pages.
- **No JS framework**. Plain DOM, plain `<script>` tags, plain event
  listeners. If a page needs more than a few hundred lines of JS, that's a
  signal it should not be a temp dashboard.
- **No CSS preprocessor, no build step**. The shared CSS is a string
  exported from the design-system module; page-specific layout goes in an
  inline `<style>` block right after `aleaDesignSystemHead()`.

## Visual identity

The look is "modern analytics dashboard + Monte Carlo casino table." Dark
felt-green panels, thin antique-gold rules, ivory text, classical serif
for titles and numerics, Inter for everything else. The theme should come
from restraint — gold is an accent for borders, dividers, active states,
headings, and aggregate-line emphasis, not a fill color for everything.

Reusable components (defined in the design system, no per-page styling
needed):

- `.alea-shell` / `.alea-header` / `.alea-main` — page scaffolding.
- `.alea-brand-row` + `aleaBrandMark()` — dice + `Alea` wordmark in gold.
- `.alea-title` (Cormorant Garamond) + `.alea-subtitle` (muted, separator
  via `<span class="sep">·</span>`).
- `.alea-card` — felt-green panel with subtle radial highlights and a
  drop shadow. Add `with-corners` for the CSS-only L-bracket flourishes.
- `.alea-tabs` + `.alea-tab` (with `.active`) — ledger-plaque tab strip,
  gold underline on active.
- `.alea-table-wrap` + `.alea-table` — ledger-feel table, gold uppercase
  headers, hairline gold row borders, hover row highlight.
- `.alea-tooltip` (with `.alea-tooltip-head` and `.alea-tooltip-row`) —
  dark panel with antique-gold border.
- `.alea-legend` + `.alea-legend-item` + `.alea-legend-swatch` (with
  `dashed` modifier for aggregate lines).
- `.alea-section-rule` — section heading in gold uppercase with a
  trailing gradient rule.

## Layout

- Full-viewport: wrap the page in `.alea-shell` so it fills the viewport
  with a flex column. The design system handles `body` margins/typography.
- Top `.alea-header`: brand row, then a serif `.alea-title` (~28px), then
  a muted `.alea-subtitle` with the data series + generation timestamp.
  A subtle gold gradient hairline runs under the header automatically.
- `.alea-main` fills the remaining viewport with the page's primary
  content (cards, charts, tables).

## Brand colors

Series colors are tuned for the dark Alea palette. Each venue keeps its
brand identity (Coinbase blue, Binance amber, etc.) but is brightened
where necessary so the line stays readable on a felt-green panel. The
canonical palette lives in
[renderPriceChartHtml.ts](../src/lib/exchangePrices/renderPriceChartHtml.ts)
under `colorByExchange`:

| Color                  | Hex       | Reserved for                                   |
| ---------------------- | --------- | ---------------------------------------------- |
| Coinbase spot          | `#2a8bff` | Coinbase spot venues                           |
| Coinbase perp          | `#5fa8ff` | Coinbase perp venues                           |
| Binance spot           | `#f0b90b` | Binance spot venues                            |
| Binance perp           | `#d99d2c` | Binance perp venues                            |
| Bybit spot             | `#ff8533` | Bybit spot venues                              |
| Bybit perp             | `#ffa75e` | Bybit perp venues                              |
| OKX spot               | `#cbd5e1` | OKX spot venues                                |
| OKX swap               | `#94a3b8` | OKX perp/swap venues                           |
| Bitstamp               | `#27d18e` | Bitstamp                                       |
| Gemini                 | `#34d2d4` | Gemini                                         |
| Polymarket / Chainlink | `#ff5470` | Settlement-feed line; emphasized in both modes |
| Spot VWAP (marble)     | `#e8dec4` | Volume-weighted spot consensus, dashed         |
| Perp VWAP (gold)       | `#d7aa45` | Volume-weighted perp consensus, dashed         |

For non-venue series (e.g. body vs. wick on the training distributions
chart), use the chart accents from
[`aleaChartTokens`](../src/lib/ui/aleaDesignSystem.ts):
`bodyColor` (`#5b95ff`, "the move") and `wickColor` (`#ffa566`, "the
envelope"). Pick two complementary colors from this set so adjacent
dashboards feel like the same product.

## Data flow

1. CLI command calls into `src/lib/<domain>/`.
2. The domain layer returns a structured payload (a typed object).
3. The CLI writes the payload to JSON and hands the same payload to the
   renderer to produce HTML.
4. Both paths are printed to stdout. The HTML is auto-opened on macOS.

The renderer is a pure function: `payload → html string`. It does not touch
the filesystem, the database, or the network. This makes the renderer
trivially testable and lets a `*:chart` companion command re-render an
older JSON without re-running the analysis.

## File-naming convention

`tmp/<command>_<UTC-iso>.html` plus `tmp/<command>_<UTC-iso>.json`. The
prefix matches the CLI verb (`latency_*`, `training-distributions_*`) so a
`ls tmp/` listing groups runs by analysis. The timestamp uses the standard
`Date#toISOString().replace(/[:.]/g, "-")` form so it sorts lexically.

## When something doesn't fit

If a page needs functionality that doesn't fit cleanly into this contract
(a real build step, a JS framework, a backend, a light-mode toggle, multi-
file assets), it has outgrown "temp dashboard" — promote it to a real
product surface and document it under its own doc.
