import { z } from "zod";
import { MAX_CENTS } from "./money.js";

/** A café's plan (AC 39): a suspended café's signup page enrols no one, while its counter still syncs. */
export const CAFE_PLANS = ["pilot", "active", "suspended"] as const;
export type CafePlan = (typeof CAFE_PLANS)[number];
export const cafePlanSchema = z.enum(CAFE_PLANS, "Choose pilot, active or suspended.");

/** How a café paid, recorded by hand (no payment provider: plan Deferred Ideas). */
export const PAYMENT_METHODS = ["cash", "whish", "omt", "bank_transfer", "other"] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

/** Payments shown per café on the admin screen, newest first. ponytail: no paging; the pilot has three cafés. */
export const ADMIN_PAYMENTS_SHOWN = 10;

const timestamp = z.iso.datetime({ offset: false });
const day = z.iso.date("Enter the date as YYYY-MM-DD.");

/** The signed-in operator (the person who runs the service). */
export const operatorSessionSchema = z.object({ operator: z.object({ id: z.uuid(), email: z.string() }) });

/** Recording a payment: its amount (at least one cent), the day it was paid, how, and an optional receipt or transfer number. */
export const paymentRecordSchema = z.object({
  amountCents: z.number("Enter an amount.").int("Use whole cents.").min(1, "Use an amount over $0.").max(MAX_CENTS, "Use an amount up to $1,000,000."),
  paidOn: day,
  method: z.enum(PAYMENT_METHODS, "Choose how the café paid."),
  reference: z
    .string()
    .trim()
    .max(100, "Use at most 100 characters.")
    .transform((value) => (value === "" ? null : value))
    .nullable()
    .default(null),
});

export const cafePlanUpdateSchema = z.object({ plan: cafePlanSchema });

export const adminPaymentSchema = z.object({
  id: z.uuid(),
  amountCents: z.int(),
  paidOn: day,
  method: z.enum(PAYMENT_METHODS),
  reference: z.string().nullable(),
  recordedAt: timestamp,
});

/** One café on the admin screen: its plan, what it paid in all, and its latest payments. */
export const adminCafeSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  plan: cafePlanSchema,
  createdAt: timestamp,
  paidCents: z.int(),
  payments: z.array(adminPaymentSchema),
});

export const adminCafesSchema = z.object({ cafes: z.array(adminCafeSchema) });

export type OperatorSession = z.output<typeof operatorSessionSchema>;
export type PaymentRecord = z.input<typeof paymentRecordSchema>;
export type AdminCafe = z.output<typeof adminCafeSchema>;
export type AdminPayment = z.output<typeof adminPaymentSchema>;
