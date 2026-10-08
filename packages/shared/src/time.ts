/** The time zone all business reporting uses: opening hours, busy and quiet hours, campaign windows. */
export const BUSINESS_TIME_ZONE = "Asia/Beirut";

/** A local-time bucket for reporting. */
export interface LocalHourBucket {
  /** Local calendar date, YYYY-MM-DD. */
  date: string;
  /** ISO weekday, 1 = Monday ... 7 = Sunday. */
  weekday: number;
  /** Local hour, 0-23. */
  hour: number;
}

const WEEKDAYS: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

const bucketFormatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = bucketFormatters.get(timeZone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      weekday: "short",
      hour: "2-digit",
      hourCycle: "h23",
    });
    bucketFormatters.set(timeZone, formatter);
  }
  return formatter;
}

/**
 * Buckets an instant by local date, weekday and hour in `timeZone` (AC 33). Callers pass the moment the event
 * happened (occurredAt), never when it was received; the late-sync guarantee is tested where events are aggregated.
 * Daylight-saving changes are handled by the time zone database: on the spring-forward day one local hour does
 * not exist, and on the fall-back day one local hour holds two real hours.
 */
export function localHourBucket(instant: Date, timeZone: string = BUSINESS_TIME_ZONE): LocalHourBucket {
  if (Number.isNaN(instant.getTime())) {
    throw new RangeError("Invalid date.");
  }
  const parts = Object.fromEntries(formatterFor(timeZone).formatToParts(instant).map((part) => [part.type, part.value]));
  const weekday = WEEKDAYS[parts.weekday ?? ""];
  if (weekday === undefined || parts.year === undefined || parts.month === undefined || parts.day === undefined || parts.hour === undefined) {
    throw new RangeError(`Could not read local time parts for time zone ${timeZone}.`);
  }
  return { date: `${parts.year}-${parts.month}-${parts.day}`, weekday, hour: Number(parts.hour) };
}
