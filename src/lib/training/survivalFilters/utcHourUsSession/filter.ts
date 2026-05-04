import type { SurvivalFilter } from "@alea/lib/training/survivalFilters/types";

const US_SESSION_START_HOUR = 13;
const US_SESSION_END_HOUR = 21;

/**
 * "Did the 5m window start within the US trading session
 * (UTC 13:00–21:00)?"
 *
 * Pure time-of-day filter. Crypto trades 24/7 but tends to take
 * directional cues from US equities during NYSE hours; weekend and
 * Asian-session windows have a different microstructure (lower
 * volume, more retail-driven). The hypothesis: US-session windows
 * exhibit different side-survival behaviour than off-hours windows.
 *
 * Round-1's `european_session` filter lost; this is a different
 * slice of the day with a different population of participants, so
 * it's worth its own A/B.
 */
export const utcHourUsSessionFilter: SurvivalFilter = {
  id: "utc_hour_us_session",
  displayName: "UTC US session (13:00–21:00)",
  description:
    "Is the window during US trading hours (UTC 13–21, when NYSE is open)?",
  trueLabel: "US session",
  falseLabel: "off-hours",
  version: 1,
  classify: (snapshot) => {
    const hour = new Date(snapshot.windowStartMs).getUTCHours();
    return hour >= US_SESSION_START_HOUR && hour < US_SESSION_END_HOUR;
  },
};
