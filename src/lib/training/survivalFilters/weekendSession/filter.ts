import type { SurvivalFilter } from "@alea/lib/training/survivalFilters/types";

const SATURDAY = 6;
const SUNDAY = 0;

/**
 * "Did the 5m window start on a Saturday or Sunday (UTC)?"
 *
 * Pure day-of-week filter. Crypto trades 24/7 but weekends have
 * lower volume and a different participant mix (equity desks
 * closed, lower institutional activity, more retail). The
 * hypothesis: weekend windows show a different side-survival
 * profile than weekday ones — possibly noisier (more flips) or
 * possibly stickier (less liquidity to push prices around).
 */
export const weekendSessionFilter: SurvivalFilter = {
  id: "weekend_session",
  displayName: "Weekend (UTC Sat/Sun)",
  description: "Is the window on a weekend (UTC Saturday or Sunday)?",
  trueLabel: "weekend",
  falseLabel: "weekday",
  version: 1,
  classify: (snapshot) => {
    const day = new Date(snapshot.windowStartMs).getUTCDay();
    return day === SATURDAY || day === SUNDAY;
  },
};
