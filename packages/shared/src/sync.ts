import { z } from "zod";
import { MAX_CENTS, centsSchema } from "./money.js";
import { e164PhoneSchema } from "./phone.js";

/**
 * Sync wire format, schema version 1.
 *
 * Versioning rule: any change to an event's fields or payload adds a new schemaVersion for that type, and the
 * server keeps accepting every version a counter build inside the support window can send (AC 26, AC 27). Within
 * a version, unknown fields are stripped, so new data must never be added to an existing version.
 *
 * Signing and idempotency: the device signs `syncEventSigningPayload(raw)` and the server verifies the signature and
 * computes the idempotency payload hash (AC 24) over the same bytes of the raw event, before any field is stripped,
 * so builds with extra fields verify and hash consistently.
 */

/** Most events one sync request may carry. It may only ever grow: older builds send batches up to this size. */
export const MAX_SYNC_BATCH = 100;

/** A UUID, lowercased so ids compare equal to PostgreSQL's uuid output. */
const idSchema = z.uuid().transform((id) => id.toLowerCase());

/** Largest per-device sequence number: the server stores it as a PostgreSQL integer. */
export const MAX_SYNC_SEQUENCE = 2_147_483_647;

/** Signature: ECDSA P-256 with SHA-256 in WebCrypto's raw r||s form (64 bytes), base64url without padding. */
export const syncSignatureSchema = z.string().regex(/^[A-Za-z0-9_-]{86}$/, "Signature must be 64 bytes, base64url-encoded.");

/** The fields every event of every type and version carries, read before anything else. */
const syncEventHeaderSchema = z.object({
  eventId: idSchema,
  type: z.string().min(1).max(64),
  schemaVersion: z.number().int().min(1),
});

/** How the counter identified the customer's card. A new kind needs a new schemaVersion. */
export const cardReferenceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("qr"), token: z.string().min(1).max(512) }),
  z.object({ kind: z.literal("phone"), phone: e164PhoneSchema }),
]);

/** One line of a visit, priced as the counter saw it (AC 32): the server never re-prices from today's catalog. */
export const visitItemSchema = z.object({
  orderTypeId: idSchema,
  quantity: z.number().int().min(1).max(50),
  unitPriceCents: centsSchema,
  unitCostCents: centsSchema,
  catalogVersion: z.number().int().min(1),
});

export type VisitItem = z.output<typeof visitItemSchema>;

/** Total of a visit's items in cents, or null if it leaves the accepted range. */
export function visitItemsTotalCents(items: readonly VisitItem[]): number | null {
  let total = 0;
  for (const item of items) {
    total += item.quantity * item.unitPriceCents;
    if (total > MAX_CENTS) {
      return null;
    }
  }
  return total;
}

/**
 * Envelope of a version 1 event (AC 22). `deviceId` and `keyId` name the device and key that signed the event;
 * they stay valid after a token renewal or re-pairing, so a queue recorded before either still syncs (AC 18).
 * The server takes the café from the authenticated token, never from the event (AC 25).
 */
const v1EnvelopeFields = {
  eventId: idSchema,
  deviceId: idSchema,
  keyId: idSchema,
  staffId: idSchema,
  sequence: z.number().int().min(0).max(MAX_SYNC_SEQUENCE),
  occurredAt: z.iso.datetime({ offset: false }),
  signature: syncSignatureSchema,
};

/** Payload of `visit.recorded`, schema version 1. The total must equal the sum of its items (AC 32). */
export const visitRecordedV1PayloadSchema = z
  .object({
    card: cardReferenceSchema,
    items: z.array(visitItemSchema).min(1).max(30),
    totalCents: centsSchema,
  })
  .superRefine((visit, context) => {
    const total = visitItemsTotalCents(visit.items);
    if (total === null) {
      context.addIssue({ code: "custom", path: ["items"], message: "The items add up to more than the largest accepted amount." });
    } else if (total !== visit.totalCents) {
      context.addIssue({ code: "custom", path: ["totalCents"], message: "The total does not match the sum of the items." });
    }
  });

export const visitRecordedV1EventSchema = z.object({
  ...v1EnvelopeFields,
  type: z.literal("visit.recorded"),
  schemaVersion: z.literal(1),
  payload: visitRecordedV1PayloadSchema,
});

export type VisitRecordedV1Event = z.output<typeof visitRecordedV1EventSchema>;

/**
 * `staff.pin_lockout`, schema version 1: the device locked out the envelope's staff member after repeated wrong PINs
 * (AC 19). `failedAttempts` counts the wrong PINs in a row so far; `lockedUntil` is when the device accepts a PIN again.
 */
export const staffPinLockoutV1EventSchema = z.object({
  ...v1EnvelopeFields,
  type: z.literal("staff.pin_lockout"),
  schemaVersion: z.literal(1),
  payload: z.object({
    failedAttempts: z.number().int().min(1).max(1_000_000),
    lockedUntil: z.iso.datetime({ offset: false }),
  }),
});

export type StaffPinLockoutV1Event = z.output<typeof staffPinLockoutV1EventSchema>;

/** Full event schemas by type and version. A pair missing here is unsupported, not invalid. */
const EVENT_SCHEMAS = {
  "visit.recorded": { 1: visitRecordedV1EventSchema },
  "staff.pin_lockout": { 1: staffPinLockoutV1EventSchema },
} as const;

/** Every event this server understands. */
export type KnownSyncEvent = VisitRecordedV1Event | StaffPinLockoutV1Event;

export interface SyncIssue {
  path: string;
  issue: string;
}

export type ParsedSyncEvent =
  | { status: "valid"; event: KnownSyncEvent }
  /** A type or version this server does not know, e.g. from a newer counter build: answer retry_later (AC 26). */
  | { status: "unsupported"; eventId: string; type: string; schemaVersion: number }
  /** Malformed. `eventId` is null when the event carried no readable id; results are matched by index anyway. */
  | { status: "invalid"; eventId: string | null; issues: SyncIssue[] };

function toIssues(error: z.ZodError): SyncIssue[] {
  return error.issues.map((issue) => ({ path: issue.path.map(String).join("."), issue: issue.message }));
}

function eventIdOf(raw: unknown): string | null {
  if (typeof raw === "object" && raw !== null && "eventId" in raw) {
    const result = idSchema.safeParse(raw.eventId);
    return result.success ? result.data : null;
  }
  return null;
}

function schemaFor(type: string, schemaVersion: number): z.ZodType<KnownSyncEvent> | undefined {
  if (!Object.hasOwn(EVENT_SCHEMAS, type)) {
    return undefined;
  }
  const byVersion: Readonly<Record<number, z.ZodType<KnownSyncEvent>>> = EVENT_SCHEMAS[type as keyof typeof EVENT_SCHEMAS];
  return Object.hasOwn(byVersion, schemaVersion) ? byVersion[schemaVersion] : undefined;
}

/**
 * Parses one queued event without throwing; one bad event never invalidates the rest of a batch (AC 23).
 * The type and version are read first, so an event of an unknown type is unsupported even when its other fields
 * follow rules this server does not know.
 */
export function parseSyncEvent(raw: unknown): ParsedSyncEvent {
  const header = syncEventHeaderSchema.safeParse(raw);
  if (!header.success) {
    return { status: "invalid", eventId: eventIdOf(raw), issues: toIssues(header.error) };
  }
  const { eventId, type, schemaVersion } = header.data;
  const schema = schemaFor(type, schemaVersion);
  if (schema === undefined) {
    return { status: "unsupported", eventId, type, schemaVersion };
  }
  const event = schema.safeParse(raw);
  if (!event.success) {
    return { status: "invalid", eventId, issues: toIssues(event.error) };
  }
  return { status: "valid", event: event.data };
}

/** Domain-separation prefix: a device-key signature over a sync event can never be valid in any other context. */
export const SYNC_EVENT_SIGNING_PREFIX = "cafe-loyalty/sync-event/v1\n";

/**
 * The text a device signs (UTF-8 encoded) and the server verifies and hashes: the prefix, then the raw event as
 * JSON with object keys sorted at every level and without the top-level `signature`. Accepts only a plain object;
 * throws on values JSON cannot represent exactly.
 */
export function syncEventSigningPayload(raw: unknown): string {
  if (!isPlainObject(raw)) {
    throw new TypeError("A sync event must be a plain object.");
  }
  return SYNC_EVENT_SIGNING_PREFIX + canonicalJson(Object.fromEntries(Object.entries(raw).filter(([key]) => key !== "signature")));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("Cannot canonicalise a non-finite number.");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item: unknown) => canonicalJson(item)).join(",")}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`);
    return `{${entries.join(",")}}`;
  }
  throw new TypeError(`Cannot canonicalise a value of type ${typeof value}.`);
}

/** Body of POST /sync. Events stay unparsed here so each is judged on its own. */
export const syncRequestSchema = z.object({
  events: z.array(z.unknown()).min(1).max(MAX_SYNC_BATCH),
});

export const SYNC_STATUSES = ["applied", "duplicate", "rejected", "retry_later"] as const;

export type SyncStatus = (typeof SYNC_STATUSES)[number];

/** The status the server sends with each code. Clients act on the status; codes explain it. */
export const SYNC_RESULT_CODES = {
  /** Recorded. */
  OK: "applied",
  /** Taken into the owner's review queue (revoked device or staff, AC 21); the device no longer holds it. */
  HELD_FOR_REVIEW: "applied",
  /** Already recorded with the same content (AC 24). */
  DUPLICATE: "duplicate",
  /** Same event id seen before with different content (AC 24). */
  IDEMPOTENCY_CONFLICT: "rejected",
  INVALID_EVENT: "rejected",
  SIGNATURE_INVALID: "rejected",
  /** occurredAt outside the accepted clock-skew window (AC 25): more than a day ahead, or too old. */
  CLOCK_SKEW: "rejected",
  /** occurredAt a little ahead of the server's clock (the phone's clock runs fast): send it again later. */
  CLOCK_AHEAD: "retry_later",
  /** Type or version unknown to this server, e.g. after a rollback (AC 26). */
  UNSUPPORTED_EVENT: "retry_later",
  /** The server could not process it now; send it again later. */
  TEMPORARILY_UNAVAILABLE: "retry_later",
} as const satisfies Record<string, SyncStatus>;

export type SyncResultCode = keyof typeof SYNC_RESULT_CODES;

/** The outcome for one event, as the server sends it (AC 23). `index` is the event's position in the request. */
export const syncResultSchema = z.object({
  index: z.number().int().min(0),
  eventId: z.string().nullable(),
  status: z.enum(SYNC_STATUSES),
  code: z.string().min(1).max(64),
});

export type SyncResult = z.output<typeof syncResultSchema>;

export const syncResponseSchema = z.object({
  results: z.array(syncResultSchema),
  /** Set when the owner removed this device: its events were held for review, and it must now unpair (AC 21). */
  deviceRevoked: z.boolean().optional(),
});

/** Whether a sync response says the device was removed; anything unreadable says no. */
export const isDeviceRevokedResponse = (body: unknown): boolean =>
  typeof body === "object" && body !== null && "deviceRevoked" in body && body.deviceRevoked === true;

export type SyncResponse = z.output<typeof syncResponseSchema>;

/** Builds the result for event `index` from its code, so status and code always agree. */
export function syncResult(index: number, eventId: string | null, code: SyncResultCode): SyncResult {
  return { index, eventId, status: SYNC_RESULT_CODES[code], code };
}

/** Whether the counter may remove an event from its queue after this status (AC 23). An allow-list: anything else keeps it. */
export function isFinalSyncStatus(status: string): boolean {
  return status === "applied" || status === "duplicate" || status === "rejected";
}

export interface ClientSyncResult {
  status: SyncStatus;
  code: string;
}

const clientResultSchema = z.object({
  index: z.number().int().min(0),
  status: z.string(),
  code: z.string().catch("UNKNOWN"),
});

/**
 * Reads a sync response on the counter, one result at a time and tolerant of a newer server: an unknown status
 * becomes retry_later, a malformed result is ignored, and an event with no result stays queued (retry_later).
 * Returns one result per event sent, in request order.
 */
export function readSyncResponse(eventCount: number, body: unknown): ClientSyncResult[] {
  const results: ClientSyncResult[] = Array.from({ length: eventCount }, () => ({ status: "retry_later", code: "NO_RESULT" }));
  const rawResults = typeof body === "object" && body !== null && "results" in body && Array.isArray(body.results) ? (body.results as unknown[]) : [];
  for (const raw of rawResults) {
    const parsed = clientResultSchema.safeParse(raw);
    if (!parsed.success || parsed.data.index >= eventCount) {
      continue;
    }
    const known = (SYNC_STATUSES as readonly string[]).includes(parsed.data.status);
    results[parsed.data.index] = {
      status: known ? (parsed.data.status as SyncStatus) : "retry_later",
      code: parsed.data.code,
    };
  }
  return results;
}

/** Why an event was held for the owner's review instead of applied (AC 21). */
export const SYNC_HOLD_REASONS = ["device_revoked", "staff_revoked"] as const;

export type SyncHoldReason = (typeof SYNC_HOLD_REASONS)[number];

const timestamp = z.iso.datetime({ offset: false });

/** One held event in the owner's review queue. */
export const reviewItemSchema = z.object({
  id: z.uuid(),
  type: z.string(),
  deviceName: z.string(),
  staffName: z.string(),
  reason: z.enum(SYNC_HOLD_REASONS),
  occurredAt: timestamp,
  receivedAt: timestamp,
});

/** A page of the review queue, oldest first; `nextCursor` fetches the next page (AC 40). */
export const reviewQueueSchema = z.object({ items: z.array(reviewItemSchema), nextCursor: z.string().nullable() });

export type ReviewItem = z.output<typeof reviewItemSchema>;
export type ReviewQueue = z.output<typeof reviewQueueSchema>;
