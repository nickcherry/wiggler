import type { SurvivalFilter } from "@alea/lib/training/survivalFilters/types";

/**
 * "Did this 5m window start during the European trading session
 * (07:00–16:00 UTC)?"
 *
 * Time-of-day filter, fully orthogonal to every price-derived signal
 * we have. EU hours roughly cover the busiest part of the trading
 * day across global venues; price action character is known to differ
 * from the quieter Asia / late-US stretches. The hypothesis: side
 * survival rates may differ between the active European stretch and
 * the rest of the day, regardless of trend.
 *
 * No skip path — every snapshot has a `windowStartMs` so this filter
 * always classifies.
 */
const EU_SESSION_START_HOUR_UTC = 7;
const EU_SESSION_END_HOUR_UTC = 16;

export const europeanSessionFilter: SurvivalFilter = {
  id: "european_session",
  displayName: "European trading session (07:00–16:00 UTC)",
  description:
    "Splits snapshots by whether the 5m window started during the European trading session.",
  trueLabel: "EU session",
  falseLabel: "outside EU session",
  version: 1,
  classify: (snapshot, _context) => {
    const hour = new Date(snapshot.windowStartMs).getUTCHours();
    return hour >= EU_SESSION_START_HOUR_UTC && hour < EU_SESSION_END_HOUR_UTC;
  },
};
