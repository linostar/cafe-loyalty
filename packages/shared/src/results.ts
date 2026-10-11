import { z } from "zod";

/** The first month's length: the report covers this many days from the café's first member visit (AC 38). */
export const RESULTS_WINDOW_DAYS = 30;

const timestamp = z.iso.datetime({ offset: false });
const count = z.int().min(0);

/** What one kind of offer gave away against what its visits brought in: its visits, the discounts, their totals. */
export const offerResultSchema = z.object({ visits: count, costCents: count, revenueCents: count });

/**
 * The first-month results report (AC 38): from the café's first member visit, for RESULTS_WINDOW_DAYS days (still
 * running until `complete`), or no window before the first visit.
 */
export const resultsReportSchema = z.object({
  window: z.object({ from: timestamp, to: timestamp, complete: z.boolean() }).nullable(),
  memberVisits: count,
  /** Lapsed cards (AC 36) that came back with a member visit inside the window. */
  customersWonBack: count,
  /** Member visits with a quiet-hour campaign discount on at least one line. */
  quietHourVisits: count,
  /** Rewards redeemed at the counter. */
  rewardRedemptions: count,
  offers: z.object({ winBack: offerResultSchema, quietHour: offerResultSchema }),
});

export type OfferResult = z.output<typeof offerResultSchema>;
export type ResultsReport = z.output<typeof resultsReportSchema>;
