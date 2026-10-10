import { z } from "zod";
import { WIN_BACK_MAX_COOLDOWN_DAYS, WIN_BACK_OFFER_DAYS } from "./campaigns.js";
import { centsSchema } from "./money.js";
import { syncSignatureSchema } from "./sync.js";

const id = z.uuid().transform((value) => value.toLowerCase());
const text = (max: number) => z.string().trim().min(1, "Fill this in.").max(max, `Use at most ${String(max)} characters.`);
const timestamp = z.iso.datetime({ offset: false });

/** Changes to a request object must name at least one field. */
const atLeastOneField = (value: Record<string, unknown>) => Object.values(value).some((entry) => entry !== undefined);

/** The least a discounted price may be, as a percentage over cost (AC 35). */
export const minMarginPercentSchema = z.int("Use a whole percentage.").min(0, "Use 0% or more.").max(1000, "Use at most 1000%.");

/** A campaign's or win-back offer's discount: percent off each eligible unit (1-100), or a fixed amount off each, in cents. */
export const discountSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("percent"), value: z.int("Use a whole percentage.").min(1, "Use 1% to 100%.").max(100, "Use 1% to 100%.") }),
  z.object({ kind: z.literal("amount"), value: centsSchema.min(1, "Use an amount of $0.01 or more.") }),
]);

/**
 * The café's win-back offer (AC 36): the discount a lapsed card gets on its next visit (null: no offer), and the
 * cool-down in days before a card can get it again, at least the WIN_BACK_OFFER_DAYS an offer lasts.
 */
export const winBackSettingsSchema = z.object({
  discount: discountSchema.nullable(),
  cooldownDays: z
    .int("Use a whole number of days.")
    .min(WIN_BACK_OFFER_DAYS, `Use at least ${String(WIN_BACK_OFFER_DAYS)} days, how long an offer lasts.`)
    .max(WIN_BACK_MAX_COOLDOWN_DAYS, `Use at most ${String(WIN_BACK_MAX_COOLDOWN_DAYS)} days.`),
});

export const cafeUpdateSchema = z
  .object({ name: text(120).optional(), minMarginPercent: minMarginPercentSchema.optional() })
  .refine(atLeastOneField, "Change at least one field.");

export const loyaltyProgramSchema = z.object({
  stampsRequired: z.int().min(1, "Use at least 1 stamp.").max(50, "Use at most 50 stamps."),
  rewardNameAr: text(80),
  rewardNameEn: text(80),
});

const orderTypeFields = {
  nameAr: text(60),
  nameEn: text(60),
  /** USD in integer cents. */
  priceCents: centsSchema,
  costCents: centsSchema,
  stampsEarned: z.int().min(0, "Use 0 to 10 stamps.").max(10, "Use 0 to 10 stamps."),
  active: z.boolean(),
};

export const orderTypeCreateSchema = z.object({ ...orderTypeFields, active: orderTypeFields.active.default(true) });
export const orderTypeUpdateSchema = z.object(orderTypeFields).partial().refine(atLeastOneField, "Change at least one field.");
export const orderTypeSchema = z.object({ id: z.uuid(), ...orderTypeFields });

/** Everything the dashboard's café setup screen shows. */
export const cafeSetupSchema = z.object({
  cafe: z.object({ id: z.uuid(), name: z.string(), catalogVersion: z.int(), minMarginPercent: z.int(), winBack: winBackSettingsSchema }),
  program: loyaltyProgramSchema.nullable(),
  orderTypes: z.array(orderTypeSchema),
});

export const STAFF_PIN_MIN_LENGTH = 6;
export const STAFF_PIN_MAX_LENGTH = 12;

function isEasyPin(pin: string): boolean {
  const digits = Array.from(pin, Number);
  const steps = new Set(digits.slice(1).map((digit, index) => (digit - (digits[index] ?? 0) + 10) % 10));
  // One repeated digit (111111) or one constant step up or down (123456, 987654, 890123).
  return steps.size === 1 && [0, 1, 9].includes([...steps][0] ?? -1);
}

/** A barista's PIN: 6 to 12 digits, not a repeated digit or a straight run (AC 19). */
export const staffPinSchema = z
  .string()
  // abort: a PIN of the wrong shape gets only this message, not also the guessability one.
  .regex(new RegExp(`^\\d{${String(STAFF_PIN_MIN_LENGTH)},${String(STAFF_PIN_MAX_LENGTH)}}$`), { message: "Use 6 to 12 digits.", abort: true })
  .refine((pin) => !isEasyPin(pin), "Choose a PIN that is harder to guess than a repeated digit or a straight run such as 123456.");

export const staffCreateSchema = z.object({ name: text(60), pin: staffPinSchema });
export const staffUpdateSchema = z.object({ name: text(60).optional(), pin: staffPinSchema.optional() }).refine(atLeastOneField, "Change at least one field.");
export const staffMemberSchema = z.object({ id: z.uuid(), name: z.string(), revoked: z.boolean(), createdAt: timestamp });
export const staffListSchema = z.object({ staff: z.array(staffMemberSchema) });

/** Crockford base32: no I, L, O or U, so a typed code is never ambiguous. */
export const PAIRING_CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
/** Characters of a pairing code: a 4-character lookup part, then an 8-character secret part (40 bits, AC 17). */
export const PAIRING_CODE_LENGTH = 12;
export const PAIRING_CODE_LOOKUP_LENGTH = 4;

const PAIRING_CODE_FORMAT = new RegExp(`^[${PAIRING_CODE_ALPHABET}]{${String(PAIRING_CODE_LENGTH)}}$`);

/**
 * A typed or scanned pairing code in canonical form (12 upper-case Crockford characters), or null. Spaces and
 * dashes are ignored, case does not matter, and O, I and L are read as 0, 1 and 1.
 */
export function normalizePairingCode(input: string): string | null {
  const code = input
    .toUpperCase()
    .replace(/[\s-]/g, "")
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");
  return PAIRING_CODE_FORMAT.test(code) ? code : null;
}

/** A canonical pairing code shown in groups of four: `ABCD-EFGH-JKMN`. */
export const formatPairingCode = (code: string): string => code.match(/.{1,4}/g)?.join("-") ?? code;

export const pairingCodeCreateSchema = z.object({ deviceName: text(60) });
export const pairingCodeSchema = z.object({
  id: z.uuid(),
  deviceName: z.string(),
  /** Formatted for reading out: `ABCD-EFGH-JKMN`. */
  code: z.string(),
  /** The counter app's pairing page with the code in its fragment, for the QR. */
  pairingUrl: z.url(),
  expiresAt: timestamp,
});
export const deviceSchema = z.object({ id: z.uuid(), name: z.string(), pairedAt: timestamp, lastSeenAt: timestamp, revoked: z.boolean() });
export const devicesSchema = z.object({
  devices: z.array(deviceSchema),
  /** Open codes, without the code itself (shown once, when created). */
  pairingCodes: z.array(z.object({ id: z.uuid(), deviceName: z.string(), expiresAt: timestamp })),
});

const base64url = (length: number) => z.string().regex(new RegExp(`^[A-Za-z0-9_-]{${String(length)}}$`), "Not a valid key.");

/** The device's ECDSA P-256 public key, as WebCrypto exports it to JWK; other members are dropped. */
export const devicePublicKeySchema = z.object({ kty: z.literal("EC"), crv: z.literal("P-256"), x: base64url(43), y: base64url(43) });

/**
 * A device pairing again (after 7 days offline, a revocation or a lost pairing response) proves it held one of its
 * old keys, so it keeps its device id and the events it queued under that id still sync (AC 18).
 */
export const previousDeviceSchema = z.object({ deviceId: id, keyId: id, signature: syncSignatureSchema });

export const pairRequestSchema = z.object({
  code: z.string().max(40).transform((value, context) => {
    const code = normalizePairingCode(value);
    if (code === null) {
      context.addIssue({ code: "custom", message: "Enter the 12-character code shown on the owner's dashboard." });
      return z.NEVER;
    }
    return code;
  }),
  publicKey: devicePublicKeySchema,
  previous: previousDeviceSchema.optional(),
});

export const DEVICE_PAIR_PROOF_PREFIX = "cafe-loyalty/device-pair-proof/v1\n";

/**
 * The bytes an old device key signs to carry its device id over to a new key: bound to that new key and to the
 * pairing code (canonical form, as normalizePairingCode gives it), which works once, so a captured proof cannot be
 * used again with another code or key.
 */
export const devicePairProofPayload = (code: string, previous: { deviceId: string; keyId: string }, publicKey: DevicePublicKeyJwk): string =>
  `${DEVICE_PAIR_PROOF_PREFIX}${code}\n${previous.deviceId.toLowerCase()}\n${previous.keyId.toLowerCase()}\n${publicKey.x}\n${publicKey.y}`;

/**
 * Header on every counter request: when the counter build was made (ISO 8601, UTC). The API serves new actions only
 * to builds made within COUNTER_SUPPORT_DAYS of the server's own release and answers CLIENT_TOO_OLD (426) otherwise;
 * pairing, renewing the token and syncing the queue work from any build, so an old counter can always drain (AC 26).
 */
export const COUNTER_BUILT_AT_HEADER = "x-counter-built-at";
export const COUNTER_SUPPORT_DAYS = 14;

const deviceToken = { accessToken: z.string(), accessTokenExpiresAt: timestamp };

/**
 * Pairing is not idempotent: the code is used up by the first success. If the response is lost, the counter asks
 * for a new code instead of retrying (the owner can remove the half-paired device from the dashboard).
 */
export const pairResponseSchema = z.object({
  deviceId: z.uuid(),
  keyId: z.uuid(),
  deviceName: z.string(),
  cafe: z.object({ id: z.uuid(), name: z.string() }),
  ...deviceToken,
});

export const DEVICE_TOKEN_SIGNING_PREFIX = "cafe-loyalty/device-token/v1\n";

/*
 * Device token protocol (AC 18), for the counter app:
 * - A device route answering TOKEN_EXPIRED means: renew, then retry the request.
 * - Renew by signing a fresh issuedAt (now, UTC) for every attempt, including a retry after a lost response; a
 *   renewal is refused unless its issuedAt is later than the last accepted one and within 5 minutes of the server.
 * - The renewal answers a new token, PAIRING_REQUIRED (no renewal for 7 days, or the key is unknown or no longer the
 *   device's newest: pair again, keeping the queue) or DEVICE_REVOKED (wipe PIN hashes and unpair, keeping the queue).
 * - Pairing again sends `previous`, signed with the old key over devicePairProofPayload (the code, the old ids and the
 *   new public key), so the device keeps its id.
 *   From then on only the new key renews; old keys still verify the events they signed.
 */

export const tokenRenewalRequestSchema = z.object({ deviceId: id, keyId: id, issuedAt: timestamp, signature: syncSignatureSchema });
export const tokenRenewalResponseSchema = z.object(deviceToken);
export type TokenRenewalRequest = z.output<typeof tokenRenewalRequestSchema>;

/** The bytes a device signs to renew its access token, domain-separated from event signatures. */
export const deviceTokenSigningPayload = (request: Pick<TokenRenewalRequest, "deviceId" | "keyId" | "issuedAt">): string =>
  `${DEVICE_TOKEN_SIGNING_PREFIX}${request.deviceId.toLowerCase()}\n${request.keyId.toLowerCase()}\n${request.issuedAt}`;

/** Local minutes of the day: a campaign starts at 0-1439 and ends after it, at 1440 (midnight) at the latest. */
const minuteOfDay = z.int().min(0).max(1440);

/** Most campaigns a café may run at once. */
export const MAX_RUNNING_CAMPAIGNS = 20;

/**
 * A new quiet-hour campaign (AC 35): weekdays (ISO, 1 = Monday) and local times of day in the café's time zone, the
 * discount and the order types it applies to. Refused if an order type's discounted price falls below its margin floor.
 */
export const campaignCreateSchema = z
  .object({
    nameAr: text(60),
    nameEn: text(60),
    weekdays: z
      .array(z.int().min(1).max(7))
      .min(1, "Pick at least one day.")
      .max(7)
      .refine((days) => new Set(days).size === days.length, "Pick each day once."),
    startsMinute: minuteOfDay.max(1439),
    endsMinute: minuteOfDay.min(1),
    discount: discountSchema,
    orderTypeIds: z
      .array(id)
      .min(1, "Pick at least one order type.")
      .max(100)
      .refine((ids) => new Set(ids).size === ids.length, "Pick each order type once."),
  })
  .refine((campaign) => campaign.startsMinute < campaign.endsMinute, { path: ["endsMinute"], message: "End after the start, on the same day." });

/** A campaign as the counter applies it (AC 35). */
export const campaignTermsSchema = z.object({
  id: z.uuid(),
  nameAr: z.string(),
  nameEn: z.string(),
  weekdays: z.array(z.int().min(1).max(7)),
  startsMinute: minuteOfDay,
  endsMinute: minuteOfDay,
  discount: discountSchema,
  minMarginPercent: z.int().min(0),
  orderTypeIds: z.array(z.uuid()),
});

/** A campaign as the dashboard lists it. */
export const campaignSchema = campaignTermsSchema.extend({ createdAt: timestamp, endedAt: timestamp.nullable() });

/** The café's running campaigns and the most recently ended ones. */
export const campaignsSchema = z.object({ running: z.array(campaignSchema), ended: z.array(campaignSchema) });

/** A win-back offer's terms as the counter applies them: the discount and the café's minimum margin. */
export const winBackTermsSchema = z.object({ discount: discountSchema, minMarginPercent: z.int().min(0) });

/**
 * What a counter needs to record visits offline: the order types on sale, priced at a catalog version (AC 32), and the
 * campaigns running now with the time zone they run in (AC 35), and the win-back terms (AC 36). They default for a
 * server from before Steps 12 and 13 (a rollback): no campaigns, no win-back offer.
 */
export const deviceCatalogSchema = z.object({
  catalogVersion: z.int().min(1),
  timeZone: z.string().default("UTC"),
  campaigns: z.array(campaignTermsSchema).default([]),
  /** The café's win-back terms, applied when the barista says the card shows the offer (AC 36); null without. */
  winBack: winBackTermsSchema.nullable().default(null),
  orderTypes: z.array(z.object({ id: z.uuid(), nameAr: z.string(), nameEn: z.string(), priceCents: centsSchema, costCents: centsSchema, stampsEarned: z.int() })),
  program: loyaltyProgramSchema.nullable(),
});

/**
 * A reward redemption, online only (AC 31). `eventId` is made by the counter for each redemption and sent again on a
 * retry, which then gets the first answer instead of redeeming twice.
 */
export const redemptionRequestSchema = z.object({ eventId: id, staffId: id, cardQr: z.string().min(1).max(512) });
export const redemptionSchema = z.object({ stampsUsed: z.int().min(1), stampsLeft: z.int().min(0), rewardNameAr: z.string(), rewardNameEn: z.string() });

export const deviceInfoSchema = z.object({ deviceId: z.uuid(), deviceName: z.string(), cafe: z.object({ id: z.uuid(), name: z.string() }) });

/** Active staff with what a device needs to check their PINs offline (AC 19). Salts and hashes are base64url. */
export const deviceStaffSchema = z.object({
  staff: z.array(z.object({ id: z.uuid(), name: z.string(), pinSalt: z.string(), pinHash: z.string(), pinIterations: z.int() })),
});

/** A pass counts as failing once this many updates in a row have failed (AC 13): the first retries are routine. */
export const REPEATED_DELIVERY_FAILURES = 3;

/** The wallets whose pass updates keep failing, for the owner dashboard (AC 13); empty when all are going through. */
export const walletDeliveriesSchema = z.object({
  failing: z.array(
    z.object({
      wallet: z.enum(["apple", "google"]),
      /** Passes whose last REPEATED_DELIVERY_FAILURES or more updates failed. */
      passes: z.int().min(1),
      lastFailedAt: timestamp,
      /** A short code of the last failure (such as google_503_UNAVAILABLE), for support. */
      lastError: z.string(),
    }),
  ),
});

/**
 * The busy and quiet hours cover this many whole weeks up to now, so every weekday and hour is counted equally often,
 * except the local hour a daylight-saving change skips (none) or repeats (two real hours).
 */
export const VISIT_HOURS_WEEKS = 4;

/**
 * Member visits by the weekday and hour they happened in, in the café's time zone (AC 33, 34): visits recorded with
 * a loyalty card, held or discarded ones excepted. Visits without a card are never recorded, so they are not here.
 */
export const visitHoursSchema = z.object({
  timeZone: z.string(),
  from: timestamp,
  to: timestamp,
  /** visits[weekday][hour]: ISO weekdays, index 0 = Monday, and local hours 0-23. */
  visits: z.array(z.array(z.int().min(0)).length(24)).length(7),
});

export type CafeSetup = z.output<typeof cafeSetupSchema>;
export type VisitHours = z.output<typeof visitHoursSchema>;
export type WalletDeliveries = z.output<typeof walletDeliveriesSchema>;
export type OrderType = z.output<typeof orderTypeSchema>;
export type LoyaltyProgram = z.output<typeof loyaltyProgramSchema>;
export type StaffMember = z.output<typeof staffMemberSchema>;
export type Device = z.output<typeof deviceSchema>;
export type Devices = z.output<typeof devicesSchema>;
export type PairingCode = z.output<typeof pairingCodeSchema>;
export type DevicePublicKeyJwk = z.output<typeof devicePublicKeySchema>;
export type PairRequest = z.input<typeof pairRequestSchema>;
export type DeviceCatalog = z.output<typeof deviceCatalogSchema>;
export type CampaignCreate = z.input<typeof campaignCreateSchema>;
export type Campaign = z.output<typeof campaignSchema>;
export type Campaigns = z.output<typeof campaignsSchema>;
export type Redemption = z.output<typeof redemptionSchema>;
export type WinBackSettings = z.output<typeof winBackSettingsSchema>;
export type WinBackTerms = z.output<typeof winBackTermsSchema>;
