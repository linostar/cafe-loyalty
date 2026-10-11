import { z } from "zod";
import { apiText } from "./api-messages.js";

/** Largest amount accepted anywhere, in cents (USD 1,000,000). Larger values are input errors, not real prices. */
export const MAX_CENTS = 100_000_000;

/** An amount of US dollars in whole cents (AC 32). Every price, cost and total uses this schema. */
export const centsSchema = z
  .number(apiText("Enter an amount."))
  .int(apiText("Use whole cents."))
  .min(0, apiText("Use an amount of $0 or more."))
  .max(MAX_CENTS, apiText("Use an amount up to $1,000,000."));

export type Cents = z.output<typeof centsSchema>;

export type DisplayLocale = "ar" | "en";

const formatters: Record<DisplayLocale, Intl.NumberFormat> = {
  ar: new Intl.NumberFormat("ar-LB", { style: "currency", currency: "USD" }),
  en: new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }),
};

/** Formats cents as US dollars for display, e.g. 350 -> "$3.50" in English. */
export function formatUsd(cents: Cents, locale: DisplayLocale): string {
  return formatters[locale].format(cents / 100);
}
