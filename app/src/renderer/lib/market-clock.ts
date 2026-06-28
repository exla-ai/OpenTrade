export type MarketState = "pre-market" | "open" | "after-hours" | "closed";

export interface MarketClock {
  /** "HH:MM:SS" in America/New_York */
  time: string;
  /** "Mon", "Tue", ... */
  weekday: string;
  state: MarketState;
}

const NY_TZ = "America/New_York";

/** Compute NY wall-clock + regular-session state. Holidays not handled in v1. */
export function getMarketClock(now: Date = new Date()): MarketClock {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: NY_TZ,
    hour12: false,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(now);

  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const weekday = get("weekday");
  const hour = Number(get("hour"));
  const minute = Number(get("minute"));
  const second = get("second");
  const hh = String(hour).padStart(2, "0");
  const mm = String(minute).padStart(2, "0");
  const minutes = hour * 60 + minute;

  const isWeekend = weekday === "Sat" || weekday === "Sun";
  let state: MarketState = "closed";
  if (!isWeekend) {
    if (minutes >= 4 * 60 && minutes < 9 * 60 + 30) state = "pre-market";
    else if (minutes >= 9 * 60 + 30 && minutes < 16 * 60) state = "open";
    else if (minutes >= 16 * 60 && minutes < 20 * 60) state = "after-hours";
  }

  return { time: `${hh}:${mm}:${second}`, weekday, state };
}
