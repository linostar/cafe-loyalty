import { z } from "zod";
import { apiMessage, apiText } from "./api-messages.js";
import { DEFAULT_CARD_COLORS, DEFAULT_STAMP_SHAPE, cardColorsSchema, stampShapeSchema } from "./card-colors.js";
import { MAX_CENTS } from "./money.js";

/** A café's plan (AC 39): a suspended café's signup page enrols no one, while its counter still syncs. */
export const CAFE_PLANS = ["pilot", "active", "suspended"] as const;
export type CafePlan = (typeof CAFE_PLANS)[number];
export const cafePlanSchema = z.enum(CAFE_PLANS, apiText("Choose pilot, active or suspended."));

/** How a café paid, recorded by hand (no payment provider: plan Deferred Ideas). */
export const PAYMENT_METHODS = ["cash", "whish", "omt", "bank_transfer", "other"] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

/** Payments shown per café on the admin screen, newest first. ponytail: no paging; the pilot has three cafés. */
export const ADMIN_PAYMENTS_SHOWN = 10;

const timestamp = z.iso.datetime({ offset: false });
const day = z.iso.date(apiText("Enter the date as YYYY-MM-DD."));

/** The signed-in operator (the person who runs the service). */
export const operatorSessionSchema = z.object({ operator: z.object({ id: z.uuid(), email: z.string() }) });

/**
 * Recording a payment: its id (made by the form, so sending it again after a lost response records it once), its amount
 * (at least one cent), the day it was paid, how, and an optional receipt or transfer number.
 */
export const paymentRecordSchema = z.object({
  paymentId: z.uuid(apiText("Reload the page and record the payment again.")),
  amountCents: z.number(apiText("Enter an amount.")).int(apiText("Use whole cents.")).min(1, apiText("Use an amount over $0.")).max(MAX_CENTS, apiText("Use an amount up to $1,000,000.")),
  paidOn: day,
  method: z.enum(PAYMENT_METHODS, apiText("Choose how the café paid.")),
  reference: z
    .string()
    .trim()
    .max(100, apiMessage("Use at most {max} characters.", { max: 100 }))
    .transform((value) => (value === "" ? null : value))
    .nullable()
    .default(null),
});

/** Voiding a payment recorded by mistake, once and for good: why, kept with the payment (no names or phone numbers). */
export const paymentVoidSchema = z.object({
  reason: z
    .string(apiText("Enter why the payment is voided."))
    .trim()
    .min(1, apiText("Enter why the payment is voided."))
    .max(200, apiMessage("Use at most {max} characters.", { max: 200 })),
});

const cafeNameSchema = z
  .string(apiText("Enter the café's name."))
  .trim()
  .min(1, apiText("Enter the café's name."))
  .max(120, apiMessage("Use at most {max} characters.", { max: 120 }));

/** The operator's changes to a café, each saved on its own: its plan, its name, its card colours, its stamp shape. */
export const adminCafeUpdateSchema = z
  .object({ plan: cafePlanSchema.optional(), name: cafeNameSchema.optional(), cardColors: cardColorsSchema.optional(), stampShape: stampShapeSchema.optional() })
  .refine((value) => Object.values(value).some((entry) => entry !== undefined), apiText("Change at least one field."));

/** A new café: its id (made by the form, so sending it again after a lost response creates it once) and its name. */
export const cafeCreateSchema = z.object({
  cafeId: z.uuid(apiText("Reload the page and create the café again.")),
  name: cafeNameSchema,
});

/** A café's logo's address part: the SHA-256 of its square PNG, in hex (`/logos/<hash>.png`, `/api/logos/<hash>.png`). */
export const logoHashSchema = z.string().regex(/^[0-9a-f]{64}$/);

/** A café's card colours as the API sends them (stored ones, already checked). */
export const cardColorsShapeSchema = z.object({ background: z.string(), foreground: z.string(), label: z.string() });

/** A café's stamp shape as the API sends it: the default when a server from before it sends none (a rollback). */
export const stampShapeShapeSchema = stampShapeSchema.catch(DEFAULT_STAMP_SHAPE);

/** The owner's choice of the café's stamp shape. */
export const stampShapeUpdateSchema = z.object({ stampShape: stampShapeSchema });

/** A logo upload: a PNG or JPEG, base64-encoded (the API takes JSON only); the server checks and resizes it. */
export const logoUploadSchema = z.object({ image: z.string(apiText("Upload the logo as a PNG or JPEG image.")).min(1, apiText("Upload the logo as a PNG or JPEG image.")) });

export const adminPaymentSchema = z.object({
  id: z.uuid(),
  amountCents: z.int(),
  paidOn: day,
  method: z.enum(PAYMENT_METHODS),
  reference: z.string().nullable(),
  recordedAt: timestamp,
  /** When and why it was voided; a voided payment stays listed but no longer counts toward what the café paid. */
  voided: z.object({ at: timestamp, reason: z.string() }).nullable(),
});

/**
 * One café on the admin screen: its plan, what it paid in all (voided payments aside), its latest payments, the owners
 * who signed up (oldest first) and its signup links still open (unused and unexpired, soonest to expire first).
 */
export const adminCafeSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  plan: cafePlanSchema,
  createdAt: timestamp,
  /** The card's colours and its logo (null: the product's); defaults for a server from before them (a rollback). */
  cardColors: cardColorsShapeSchema.default({ ...DEFAULT_CARD_COLORS }),
  logoHash: logoHashSchema.nullable().default(null),
  stampShape: stampShapeShapeSchema,
  paidCents: z.int(),
  payments: z.array(adminPaymentSchema),
  owners: z.array(z.object({ email: z.string(), signedUpAt: timestamp })),
  openInvites: z.array(z.object({ id: z.uuid(), createdAt: timestamp, expiresAt: timestamp })),
});

export const adminCafesSchema = z.object({ cafes: z.array(adminCafeSchema) });

/** A new owner signup link for a café, shown once: single-use, valid until `expiresAt`. */
export const adminInviteSchema = z.object({ cafe: adminCafeSchema, link: z.url(), expiresAt: timestamp });

export type OperatorSession = z.output<typeof operatorSessionSchema>;
export type PaymentRecord = z.input<typeof paymentRecordSchema>;
export type PaymentVoid = z.input<typeof paymentVoidSchema>;
export type AdminCafeUpdate = z.input<typeof adminCafeUpdateSchema>;
export type LogoUpload = z.input<typeof logoUploadSchema>;
export type StampShapeUpdate = z.input<typeof stampShapeUpdateSchema>;
export type AdminCafe = z.output<typeof adminCafeSchema>;
export type AdminPayment = z.output<typeof adminPaymentSchema>;
export type AdminInvite = z.output<typeof adminInviteSchema>;
