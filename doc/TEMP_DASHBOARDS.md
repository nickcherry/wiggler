# Temporary Dashboards

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
- Written in **light mode**. Light mode renders well in screenshots, on
  shared terminals, and inside Markdown previews. We do not currently ship a
  dark-mode story for these pages.

## Stack

- **Pico CSS (classless)**:
  `https://cdn.jsdelivr.net/npm/@picocss/pico@2/css/pico.classless.min.css`.
  Provides typography, color tokens (`--pico-color`,
  `--pico-muted-color`, `--pico-muted-border-color`), and styled
  defaults for `<header>`, `<main>`, `<table>`, `<button>`, etc. Use the
  classless build so unknown-class custom widgets are never affected.
- **uPlot 1.6**: charting. Same version pinned across pages.
- **No JS framework**. Plain DOM, plain `<script>` tags, plain event
  listeners. If a page needs more than a few hundred lines of JS, that's a
  signal it should not be a temp dashboard.
- **No CSS preprocessor, no build step**. Inline `<style>` block at the top
  of the HTML, written by the renderer in TypeScript.

## Layout

- Full-viewport: `body { margin: 0; min-height: 100vh; display: flex;
flex-direction: column; }`. Override Pico's default centered-document
  container — temp dashboards are dense, not prose.
- Top `<header>`: page title (`<h1>` at ~18px) and a one-line meta row
  (data series, generated-at timestamp, etc.) in muted color.
- `<main>` fills the remaining viewport with the dashboard's primary
  content.

## Brand colors

When a chart has a small set of named series, draw from the palette
established in
[renderPriceChartHtml.ts](../src/lib/exchangePrices/renderPriceChartHtml.ts):

| Color                  | Hex       | Reserved for                                 |
| ---------------------- | --------- | -------------------------------------------- |
| Coinbase               | `#0052ff` | Coinbase venues; primary metric / "the move" |
| Binance                | `#f0b90b` | Binance venues                               |
| Bybit                  | `#ff8533` | Bybit venues; secondary metric / "the range" |
| OKX                    | `#475569` | OKX venues                                   |
| Bitstamp               | `#00b873` | Bitstamp                                     |
| Gemini                 | `#0aa6a8` | Gemini                                       |
| Polymarket / Chainlink | `#ff1744` | Settlement-feed line; emphasis               |
| Slate-900              | `#0f172a` | Spot consensus / primary text on light bg    |
| Indigo-800             | `#3730a3` | Perp consensus / secondary emphasis          |

Pick the venue color when a series corresponds to a venue. Otherwise pick
two complementary colors from the palette (e.g. Coinbase blue + Bybit
orange) so adjacent dashboards feel like the same product.

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
(a real build step, a JS framework, a backend, a dark-mode toggle, multi-
file assets), it has outgrown "temp dashboard" — promote it to a real
product surface and document it under its own doc.
