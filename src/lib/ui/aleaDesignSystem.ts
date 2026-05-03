/**
 * Shared visual identity for Alea's HTML reports (training:distributions,
 * latency:capture, ...). Each renderer inlines `aleaDesignSystemHead()` in
 * <head> for fonts + color tokens + base/component styles, then layers its
 * own page-specific layout CSS on top.
 *
 * Vibe: dark, intelligent, probability-driven, Roman casino without the
 * tackiness. Antique gold accents on deep felt-green panels, warm ivory
 * text, classical serif for titles, Inter for everything else.
 */

/**
 * Inline SVG dice mark used in the report header. Single antique-gold
 * fill, sized via the wrapper element's `width`/`height` attrs.
 */
export const aleaDiceMarkSvg = `
<svg viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <rect x="4.5" y="4.5" width="23" height="23" rx="4.5" ry="4.5"
    fill="none" stroke="currentColor" stroke-width="1.4"/>
  <circle cx="11" cy="11" r="1.6" fill="currentColor"/>
  <circle cx="21" cy="11" r="1.6" fill="currentColor"/>
  <circle cx="16" cy="16" r="1.6" fill="currentColor"/>
  <circle cx="11" cy="21" r="1.6" fill="currentColor"/>
  <circle cx="21" cy="21" r="1.6" fill="currentColor"/>
</svg>
`.trim();

/**
 * Chart colors keyed against the design tokens. uPlot configs read these
 * directly so axis/grid colors stay in lockstep with the page palette.
 */
export const aleaChartTokens = {
  axisStroke: "#b8aa8a",
  axisTickStroke: "#6f5320",
  axisFont: "12px Inter, ui-sans-serif, system-ui, sans-serif",
  gridStroke: "rgba(215, 170, 69, 0.12)",
  referenceLine: "rgba(215, 170, 69, 0.45)",
  bodyColor: "#5b95ff",
  wickColor: "#ffa566",
  errorColor: "#d85a4f",
  tooltipBg: "#0f150e",
  tooltipBorder: "rgba(215, 170, 69, 0.45)",
  tooltipText: "#f3ead2",
  tooltipMutedText: "#b8aa8a",
} as const;

/**
 * Markup for the Alea wordmark + dice — shared across reports so brand
 * presentation stays consistent. Use inside `.alea-brand-row`.
 */
export function aleaBrandMark(): string {
  return `
    <span class="alea-mark" aria-hidden="true">${aleaDiceMarkSvg}</span>
    <span class="alea-wordmark">Alea</span>
  `;
}

/**
 * <head>-time payload: external font links + the shared design-system
 * stylesheet. Inline a single <style> tag rather than a separate file so
 * the HTML reports stay self-contained (open from disk, no network for
 * tokens).
 */
export function aleaDesignSystemHead(): string {
  return `
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@500;600;700&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet" />
<style>${aleaDesignSystemCss()}</style>
`.trim();
}

/**
 * Tokens, base layout, and reusable component styles. Page-specific
 * layout (panels, tabs scaffolding, bar widgets) lives in each renderer.
 */
function aleaDesignSystemCss(): string {
  return `
:root {
  color-scheme: dark;

  /* Surfaces — near-black page, deep felt-green for panels. */
  --alea-bg: #07090a;
  --alea-bg-soft: #0a0d0c;
  --alea-panel: #0f1610;
  --alea-panel-2: #11180f;
  --alea-panel-elevated: #15201a;

  /* Text — ivory primary, taupe secondary. */
  --alea-text: #f3ead2;
  --alea-text-muted: #b8aa8a;
  --alea-text-subtle: #7f745f;

  /* Antique gold / bronze accents. */
  --alea-gold: #d7aa45;
  --alea-gold-soft: #a67c2d;
  --alea-gold-muted: #6f5320;
  --alea-bronze: #8a5f24;

  /* Casino / Roman accents. */
  --alea-felt: #102017;
  --alea-burgundy: #6e211c;
  --alea-marble: #e8dec4;

  /* Series. Tuned slightly warmer/brighter than the spec to keep contrast
     against the deep panel backgrounds. */
  --alea-blue: #5b95ff;
  --alea-orange: #ffa566;
  --alea-green: #46c37b;
  --alea-red: #d85a4f;

  /* Borders + shadow. */
  --alea-border: rgba(215, 170, 69, 0.32);
  --alea-border-strong: rgba(215, 170, 69, 0.55);
  --alea-border-muted: rgba(215, 170, 69, 0.16);
  --alea-border-faint: rgba(215, 170, 69, 0.08);
  --alea-shadow: 0 18px 40px rgba(0, 0, 0, 0.45);
  --alea-shadow-soft: 0 6px 18px rgba(0, 0, 0, 0.3);

  /* Typography stacks. */
  --alea-font-sans: "Inter", ui-sans-serif, system-ui, -apple-system,
    BlinkMacSystemFont, "Segoe UI", sans-serif;
  --alea-font-display: "Cormorant Garamond", "EB Garamond", Georgia,
    "Times New Roman", serif;
  --alea-font-mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}

* { box-sizing: border-box; }

html, body {
  background: var(--alea-bg);
  color: var(--alea-text);
}

body {
  margin: 0;
  min-height: 100vh;
  font-family: var(--alea-font-sans);
  font-size: 14px;
  line-height: 1.5;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
  background:
    radial-gradient(circle at 18% -10%, rgba(215, 170, 69, 0.07), transparent 38%),
    radial-gradient(circle at 90% 0%, rgba(70, 195, 123, 0.04), transparent 35%),
    var(--alea-bg);
}

/* ------------------------------------------------------------------ */
/* Shell + header                                                     */
/* ------------------------------------------------------------------ */

.alea-shell {
  display: flex;
  flex-direction: column;
  min-height: 100vh;
}

.alea-header {
  flex: 0 0 auto;
  padding: 26px 36px 22px;
  border-bottom: 1px solid var(--alea-border-muted);
  background:
    linear-gradient(180deg, rgba(215, 170, 69, 0.04), transparent 70%),
    transparent;
  position: relative;
}

/* Hairline gold rule sitting on top of the header border for a subtle
   double-line ledger feel. */
.alea-header::after {
  content: "";
  position: absolute;
  left: 36px;
  right: 36px;
  bottom: -1px;
  height: 1px;
  background: linear-gradient(
    90deg,
    transparent 0%,
    var(--alea-gold-muted) 16%,
    var(--alea-gold) 50%,
    var(--alea-gold-muted) 84%,
    transparent 100%
  );
  opacity: 0.55;
  pointer-events: none;
}

.alea-brand-row {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 14px;
  color: var(--alea-gold);
}

.alea-mark {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  color: var(--alea-gold);
  flex: 0 0 auto;
}

.alea-mark svg { width: 100%; height: 100%; display: block; }

.alea-wordmark {
  font-family: var(--alea-font-display);
  font-size: 19px;
  font-weight: 600;
  letter-spacing: 0.32em;
  text-transform: uppercase;
  color: var(--alea-gold);
  line-height: 1;
}

.alea-title {
  margin: 0;
  font-family: var(--alea-font-display);
  font-weight: 600;
  font-size: 28px;
  line-height: 1.15;
  letter-spacing: 0.005em;
  color: var(--alea-text);
}

.alea-subtitle {
  margin: 8px 0 0;
  color: var(--alea-text-muted);
  font-size: 13px;
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.01em;
}

.alea-subtitle .sep {
  color: var(--alea-gold-muted);
  margin: 0 8px;
}

/* ------------------------------------------------------------------ */
/* Main content                                                       */
/* ------------------------------------------------------------------ */

.alea-main {
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  gap: 22px;
  padding: 26px 36px 40px;
  max-width: none;
}

/* ------------------------------------------------------------------ */
/* Cards                                                              */
/* ------------------------------------------------------------------ */

.alea-card {
  position: relative;
  border: 1px solid var(--alea-border);
  border-radius: 12px;
  background:
    radial-gradient(circle at 0% 0%, rgba(215, 170, 69, 0.07), transparent 40%),
    radial-gradient(circle at 100% 100%, rgba(70, 195, 123, 0.04), transparent 40%),
    linear-gradient(180deg, var(--alea-panel), var(--alea-bg-soft));
  box-shadow: var(--alea-shadow);
  padding: 24px 26px;
}

/* Subtle CSS-only corner brackets — keeps the casino feel without leaning
   on raster art or heavy ornamentation. */
.alea-card.with-corners::before,
.alea-card.with-corners::after {
  content: "";
  position: absolute;
  width: 18px;
  height: 18px;
  pointer-events: none;
  opacity: 0.85;
}
.alea-card.with-corners::before {
  top: 9px;
  left: 9px;
  border-top: 1px solid var(--alea-gold-soft);
  border-left: 1px solid var(--alea-gold-soft);
}
.alea-card.with-corners::after {
  right: 9px;
  bottom: 9px;
  border-right: 1px solid var(--alea-gold-soft);
  border-bottom: 1px solid var(--alea-gold-soft);
}

.alea-card-header {
  display: flex;
  align-items: baseline;
  gap: 14px;
  flex-wrap: wrap;
  margin-bottom: 18px;
}

.alea-card-title {
  margin: 0;
  font-family: var(--alea-font-display);
  font-weight: 600;
  font-size: 20px;
  letter-spacing: 0.04em;
  color: var(--alea-text);
}

.alea-card-meta {
  margin: 0;
  color: var(--alea-text-muted);
  font-size: 12.5px;
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.02em;
}

.alea-card-meta .sep {
  color: var(--alea-gold-muted);
  margin: 0 7px;
}

/* ------------------------------------------------------------------ */
/* Tabs                                                               */
/* ------------------------------------------------------------------ */

.alea-tabs {
  display: flex;
  flex-wrap: wrap;
  gap: 0;
  border: 1px solid var(--alea-border-muted);
  border-radius: 10px;
  background: linear-gradient(
    180deg,
    rgba(16, 23, 15, 0.92),
    rgba(8, 10, 8, 0.92)
  );
  overflow: hidden;
  box-shadow: var(--alea-shadow-soft);
}

.alea-tab {
  flex: 1 1 0;
  min-width: 96px;
  padding: 13px 18px;
  border: 0;
  background: transparent;
  color: var(--alea-text-subtle);
  font-family: var(--alea-font-sans);
  font-size: 12.5px;
  font-weight: 600;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  text-align: center;
  cursor: pointer;
  border-right: 1px solid var(--alea-border-muted);
  position: relative;
  transition: color 120ms ease, background-color 120ms ease;
  outline: none;
}

.alea-tab:last-child { border-right: 0; }

.alea-tab:hover,
.alea-tab:focus-visible {
  color: var(--alea-text);
  background: rgba(215, 170, 69, 0.04);
}

.alea-tab:focus-visible {
  outline: 1px solid var(--alea-border-strong);
  outline-offset: -3px;
}

.alea-tab.active {
  color: var(--alea-gold);
  background: rgba(215, 170, 69, 0.06);
  box-shadow: inset 0 -2px 0 0 var(--alea-gold);
}

/* ------------------------------------------------------------------ */
/* Tables (ledger feel)                                               */
/* ------------------------------------------------------------------ */

.alea-table-wrap {
  overflow-x: auto;
  border: 1px solid var(--alea-border-muted);
  border-radius: 10px;
  background: linear-gradient(180deg, var(--alea-panel-2), var(--alea-bg-soft));
}

.alea-table {
  width: 100%;
  border-collapse: collapse;
  font-variant-numeric: tabular-nums;
  font-size: 13px;
}

.alea-table thead th {
  font-family: var(--alea-font-sans);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: var(--alea-gold);
  padding: 14px 14px 12px;
  text-align: right;
  border-bottom: 1px solid var(--alea-border);
  background: rgba(215, 170, 69, 0.035);
}

.alea-table thead th:first-child {
  text-align: left;
}

.alea-table tbody td {
  padding: 13px 14px;
  text-align: right;
  color: var(--alea-text);
  border-bottom: 1px solid var(--alea-border-faint);
}

.alea-table tbody tr:last-child td {
  border-bottom: 0;
}

.alea-table tbody th {
  padding: 13px 14px;
  text-align: left;
  font-family: var(--alea-font-sans);
  font-weight: 600;
  font-size: 11.5px;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: var(--alea-text-muted);
  border-bottom: 1px solid var(--alea-border-faint);
}

.alea-table tbody tr:hover td,
.alea-table tbody tr:hover th {
  background: rgba(215, 170, 69, 0.03);
}

/* ------------------------------------------------------------------ */
/* Tooltip                                                            */
/* ------------------------------------------------------------------ */

.alea-tooltip {
  position: absolute;
  pointer-events: none;
  background:
    linear-gradient(180deg, var(--alea-panel-elevated), var(--alea-panel));
  border: 1px solid var(--alea-border-strong);
  border-radius: 8px;
  padding: 10px 12px;
  box-shadow: var(--alea-shadow);
  font-family: var(--alea-font-sans);
  font-size: 12.5px;
  font-variant-numeric: tabular-nums;
  color: var(--alea-text);
  opacity: 0;
  transition: opacity 70ms ease;
  z-index: 10;
  min-width: 200px;
}

.alea-tooltip.visible { opacity: 1; }

.alea-tooltip .alea-tooltip-head {
  font-weight: 600;
  color: var(--alea-gold);
  letter-spacing: 0.04em;
  margin-bottom: 6px;
  padding-bottom: 6px;
  border-bottom: 1px solid var(--alea-border-muted);
}

.alea-tooltip .alea-tooltip-row {
  display: grid;
  grid-template-columns: 14px auto 1fr;
  gap: 10px;
  align-items: center;
  padding: 2px 0;
}

.alea-tooltip .alea-tooltip-row .name {
  color: var(--alea-text-muted);
}

.alea-tooltip .alea-tooltip-row .value {
  text-align: right;
  font-weight: 600;
  color: var(--alea-text);
}

/* ------------------------------------------------------------------ */
/* Legend                                                             */
/* ------------------------------------------------------------------ */

.alea-legend {
  display: flex;
  flex-wrap: wrap;
  gap: 10px 22px;
  font-size: 12.5px;
  color: var(--alea-text-muted);
  user-select: none;
}

.alea-legend-item {
  display: inline-flex;
  align-items: center;
  gap: 9px;
  cursor: pointer;
  line-height: 1.3;
  padding: 3px 0;
  letter-spacing: 0.02em;
  transition: color 120ms ease;
}

.alea-legend-item:hover { color: var(--alea-text); }
.alea-legend-item.muted { opacity: 0.4; }

.alea-legend-swatch {
  width: 22px;
  height: 2px;
  border-radius: 1px;
  flex: 0 0 auto;
}

.alea-legend-swatch.dashed {
  background: repeating-linear-gradient(
    90deg,
    currentColor 0 5px,
    transparent 5px 9px
  ) !important;
  height: 2px;
}

/* ------------------------------------------------------------------ */
/* uPlot integration                                                  */
/* ------------------------------------------------------------------ */

.uplot, .u-wrap { background: transparent; color: var(--alea-text-muted); }
.u-legend { display: none !important; }

/* uPlot draws axis text using its own canvas — these classes are for any
   HTML overlays it places. */
.u-axis { color: var(--alea-text-muted); }
.u-cursor-x, .u-cursor-y { background: var(--alea-gold) !important; opacity: 0.35 !important; }

/* ------------------------------------------------------------------ */
/* Misc                                                               */
/* ------------------------------------------------------------------ */

.alea-divider {
  border: 0;
  border-top: 1px solid var(--alea-border-muted);
  margin: 0;
}

.alea-section-rule {
  display: flex;
  align-items: center;
  gap: 14px;
  margin: 0 0 14px;
}

.alea-section-rule h2 {
  margin: 0;
  font-family: var(--alea-font-display);
  font-weight: 600;
  font-size: 16px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--alea-gold);
}

.alea-section-rule::after {
  content: "";
  flex: 1 1 auto;
  height: 1px;
  background: linear-gradient(
    90deg,
    var(--alea-border-muted),
    transparent 70%
  );
}

.alea-error {
  color: var(--alea-red);
  background: rgba(216, 90, 79, 0.08);
  border: 1px solid rgba(216, 90, 79, 0.4);
  border-radius: 6px;
  padding: 12px;
  font-size: 12px;
  font-family: var(--alea-font-mono);
  white-space: pre-wrap;
  margin: 0;
}

@media (max-width: 720px) {
  .alea-header { padding: 22px 20px 18px; }
  .alea-header::after { left: 20px; right: 20px; }
  .alea-main { padding: 18px 18px 28px; gap: 16px; }
  .alea-card { padding: 18px; }
  .alea-title { font-size: 22px; }
  .alea-card-title { font-size: 17px; }
  .alea-tab { padding: 11px 12px; font-size: 11.5px; letter-spacing: 0.14em; }
}
`.trim();
}
