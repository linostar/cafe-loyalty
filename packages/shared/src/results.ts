import { z } from "zod";
import { apiText } from "./api-messages.js";

const count = z.int().min(0);

/** A calendar month, `YYYY-MM`, in the café's time zone. */
export const resultsMonthSchema = z.string().regex(/^20\d{2}-(0[1-9]|1[0-2])$/, apiText("Choose a month as YYYY-MM, such as 2026-10."));

/** `GET /api/results`'s query: the month to report, the café's current month when left out. */
export const resultsQuerySchema = z.object({ month: resultsMonthSchema.optional() });

/** What one kind of offer gave away against what its visits brought in: its visits, the discounts, their totals. */
export const offerResultSchema = z.object({ visits: count, costCents: count, revenueCents: count });

/**
 * The results report (AC 38) for one calendar month in the café's time zone (`current`: the month still running), with
 * the months there are results for: from the month of the café's first member visit to the current one, newest first.
 */
export const resultsReportSchema = z.object({
  month: resultsMonthSchema,
  current: z.boolean(),
  months: z.array(resultsMonthSchema).min(1),
  memberVisits: count,
  /** Lapsed cards (AC 36) that came back with a member visit in the month. */
  customersWonBack: count,
  /** Member visits with a quiet-hour campaign discount on at least one line. */
  quietHourVisits: count,
  /** Rewards redeemed at the counter. */
  rewardRedemptions: count,
  offers: z.object({ winBack: offerResultSchema, quietHour: offerResultSchema }),
});

export type OfferResult = z.output<typeof offerResultSchema>;
export type ResultsReport = z.output<typeof resultsReportSchema>;
