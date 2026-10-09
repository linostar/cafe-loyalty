import { createHash } from "node:crypto";
import { withCafe, type Database } from "@cafe-loyalty/db";
import {
  ApiError,
  parseSyncEvent,
  syncEventSigningPayload,
  syncRequestSchema,
  syncResult,
  type ReviewQueue,
  type SyncHoldReason,
  type SyncResult,
  type SyncResultCode,
} from "@cafe-loyalty/shared";
import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import { sql, type Kysely } from "kysely";
import { z } from "zod";
import { deviceOf, ownerOf, type DeviceContext } from "./access.js";
import { audit, now } from "./db-helpers.js";
import { importDeviceKey, verifyDeviceSignature } from "./device-routes.js";
import { parseInput, rateLimited } from "./http-errors.js";
import { RateLimiter } from "./rate-limit.js";

const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE_MS;
/** How far ahead of the server's clock an event's occurredAt may be (AC 25). */
export const SYNC_FUTURE_SKEW_MS = 5 * MINUTE_MS;
/** How old an event may be when it arrives: a week offline, then time to pair again, with room to spare (AC 25). */
export const SYNC_MAX_EVENT_AGE_MS = 30 * DAY_MS;
/** Bytes one sync request may carry: a full batch of the largest version 1 events is about 0.5 MB. */
export const SYNC_BODY_LIMIT_BYTES = 1024 * 1024;
/** Most held events one page of the review queue shows (AC 40). */
export const REVIEW_PAGE_SIZE = 50;

export interface SyncRoutesOptions {
  db: Kysely<Database>;
}

const idParams = z.object({ id: z.uuid("Use an id from the list.") });

/** A review queue position: the received_at (microseconds, as PostgreSQL text) and id of the last item shown. */
const cursorSchema = z
  .string()
  .max(200)
  .transform((value, context) => {
    try {
      const parsed = z
        .tuple([z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/), z.uuid()])
        .safeParse(JSON.parse(Buffer.from(value, "base64url").toString("utf8")));
      if (parsed.success) {
        return { receivedAt: parsed.data[0], id: parsed.data[1] };
      }
    } catch {
      // Reported below.
    }
    context.addIssue({ code: "custom", message: "This list position is not valid. Reload the list." });
    return z.NEVER;
  });
const reviewQuery = z.object({ cursor: cursorSchema.optional() });

const encodeCursor = (receivedAt: string, id: string): string => Buffer.from(JSON.stringify([receivedAt, id])).toString("base64url");

/** A held event's reason, which sync_events_review_check guarantees. */
function holdReasonOf(reason: SyncHoldReason | null): SyncHoldReason {
  if (reason === null) {
    throw new Error("A held sync event has no hold reason.");
  }
  return reason;
}

const alreadyDecided = () => new ApiError("NOT_FOUND", "This event was already accepted or discarded. Reload the list.");

/**
 * Records one event of a sync request in its own transaction, so one event never decides another's outcome (AC 23).
 * The device and café are the token's (AC 25); the event's own deviceId must match and its key must belong to that
 * device. A verified event is recorded once (AC 24): the same id again is a duplicate with the same content and a
 * conflict with other content. Events from a revoked device, a key it had when revoked or a revoked staff member are
 * held for the owner's review (AC 21).
 */
async function recordEvent(db: Kysely<Database>, device: DeviceContext, raw: unknown, index: number): Promise<SyncResult> {
  const parsed = parseSyncEvent(raw);
  if (parsed.status === "unsupported") {
    return syncResult(index, parsed.eventId, "UNSUPPORTED_EVENT");
  }
  if (parsed.status === "invalid") {
    return syncResult(index, parsed.eventId, "INVALID_EVENT");
  }
  const event = parsed.event;
  if (event.deviceId !== device.deviceId) {
    return syncResult(index, event.eventId, "INVALID_EVENT");
  }
  // The device signed these bytes of the event as it sent it, before any unknown field was stripped.
  let signed: string;
  try {
    signed = syncEventSigningPayload(raw);
  } catch {
    return syncResult(index, event.eventId, "INVALID_EVENT");
  }
  const payloadHash = createHash("sha256").update(signed).digest();
  const code = await withCafe(db, device.cafeId, async (trx): Promise<SyncResultCode> => {
    // Locked first, so a revocation cannot slip in between reading it and recording the event.
    const deviceRow = await trx.selectFrom("devices").select("revoked_at").where("id", "=", device.deviceId).forShare().executeTakeFirstOrThrow();
    const key = await trx
      .selectFrom("device_keys")
      .select(["public_key", "revoked_at"])
      .where("id", "=", event.keyId)
      .where("device_id", "=", device.deviceId)
      .executeTakeFirst();
    const verifier = key === undefined ? undefined : importDeviceKey(key.public_key);
    if (key === undefined || verifier === undefined || !verifyDeviceSignature(verifier, signed, event.signature)) {
      return "SIGNATURE_INVALID";
    }
    const recorded = async (): Promise<SyncResultCode | undefined> => {
      const existing = await trx
        .selectFrom("sync_events")
        .select("payload_hash")
        .where("device_id", "=", device.deviceId)
        .where("event_id", "=", event.eventId)
        .executeTakeFirst();
      return existing === undefined ? undefined : existing.payload_hash.equals(payloadHash) ? "DUPLICATE" : "IDEMPOTENCY_CONFLICT";
    };
    // Before the clock check: an event recorded long ago is still a duplicate when the device sends it again.
    const earlier = await recorded();
    if (earlier !== undefined) {
      return earlier;
    }
    const occurredAt = Date.parse(event.occurredAt);
    const serverNow = Date.now();
    if (occurredAt > serverNow + SYNC_FUTURE_SKEW_MS || occurredAt < serverNow - SYNC_MAX_EVENT_AGE_MS) {
      return "CLOCK_SKEW";
    }
    const staff = await trx.selectFrom("staff").select("revoked_at").where("id", "=", event.staffId).forShare().executeTakeFirst();
    if (staff === undefined) {
      return "INVALID_EVENT";
    }
    const holdReason: SyncHoldReason | null =
      deviceRow.revoked_at !== null || key.revoked_at !== null ? "device_revoked" : staff.revoked_at !== null ? "staff_revoked" : null;
    const inserted = await trx
      .insertInto("sync_events")
      .values({
        cafe_id: device.cafeId,
        device_id: device.deviceId,
        event_id: event.eventId,
        payload_hash: payloadHash,
        key_id: event.keyId,
        staff_id: event.staffId,
        type: event.type,
        schema_version: event.schemaVersion,
        sequence: event.sequence,
        occurred_at: new Date(occurredAt),
        status: holdReason === null ? "applied" : "held",
        hold_reason: holdReason,
      })
      .onConflict((conflict) => conflict.constraint("sync_events_event_key").doNothing())
      .returning("id")
      .executeTakeFirst();
    if (inserted === undefined) {
      // A parallel request recorded the same event first.
      return (await recorded()) ?? "TEMPORARILY_UNAVAILABLE";
    }
    if (holdReason !== null) {
      return "HELD_FOR_REVIEW";
    }
    if (event.type === "staff.pin_lockout") {
      await audit(trx, {
        cafeId: device.cafeId,
        actorType: "device",
        actorId: device.deviceId,
        action: "staff.pin_locked_out",
        entityType: "staff",
        entityId: event.staffId,
        changes: { failedAttempts: event.payload.failedAttempts, lockedUntil: event.payload.lockedUntil },
      });
    }
    // Visits are recorded in the ledger only; stamps arrive with plan Step 9.
    return "OK";
  });
  return syncResult(index, event.eventId, code);
}

async function recordEventSafely(db: Kysely<Database>, device: DeviceContext, raw: unknown, index: number, log: FastifyBaseLogger): Promise<SyncResult> {
  try {
    return await recordEvent(db, device, raw, index);
  } catch (error) {
    // The device keeps the event and sends it again; the rest of the batch goes on.
    log.error({ err: error, cafeId: device.cafeId, deviceId: device.deviceId, eventIndex: index }, "sync event failed");
    return syncResult(index, null, "TEMPORARILY_UNAVAILABLE");
  }
}

/** Counter sync (AC 22 to 25) and the owner's review queue of held events (AC 21). */
export function syncRoutes(app: FastifyInstance, options: SyncRoutesOptions, done: (error?: Error) => void): void {
  const { db } = options;
  // A counter syncs when it has events, about once a minute while busy; this only stops a runaway one.
  const syncsPerDevice = new RateLimiter(240, 60 * MINUTE_MS);

  app.post(
    "/device/sync",
    { config: { access: "device", acceptRevokedDevice: true }, bodyLimit: SYNC_BODY_LIMIT_BYTES },
    async (request, reply) => {
      const device = deviceOf(request);
      const wait = syncsPerDevice.hit(device.deviceId);
      if (wait > 0) {
        throw rateLimited(reply, wait);
      }
      const body = parseInput(syncRequestSchema, request.body);
      const results: SyncResult[] = [];
      for (const [index, raw] of body.events.entries()) {
        results.push(await recordEventSafely(db, device, raw, index, request.log));
      }
      const outcomes: Record<string, number> = {};
      for (const result of results) {
        outcomes[result.code] = (outcomes[result.code] ?? 0) + 1;
      }
      request.log.info({ cafeId: device.cafeId, deviceId: device.deviceId, events: results.length, outcomes }, "sync handled");
      return { results };
    },
  );

  /** Held events, oldest first, a page at a time. A late sync only adds to the end, so paging never repeats or skips. */
  app.get("/review-queue", { config: { access: "owner" } }, async (request): Promise<ReviewQueue> => {
    const owner = ownerOf(request);
    const { cursor } = parseInput(reviewQuery, request.query);
    const rows = await withCafe(db, owner.cafeId, (trx) => {
      let query = trx
        .selectFrom("sync_events")
        .innerJoin("devices", "devices.id", "sync_events.device_id")
        .innerJoin("staff", "staff.id", "sync_events.staff_id")
        .select([
          "sync_events.id",
          "sync_events.type",
          "sync_events.hold_reason",
          "sync_events.occurred_at",
          "sync_events.received_at",
          sql<string>`to_char(sync_events.received_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`.as("position"),
          "devices.name as deviceName",
          "staff.name as staffName",
        ])
        .where("sync_events.status", "=", "held");
      if (cursor !== undefined) {
        query = query.where(sql<boolean>`(sync_events.received_at, sync_events.id) > (${cursor.receivedAt}::timestamptz, ${cursor.id}::uuid)`);
      }
      return query.orderBy("sync_events.received_at").orderBy("sync_events.id").limit(REVIEW_PAGE_SIZE + 1).execute();
    });
    const page = rows.slice(0, REVIEW_PAGE_SIZE);
    const last = page.at(-1);
    return {
      items: page.map((row) => ({
        id: row.id,
        type: row.type,
        deviceName: row.deviceName,
        staffName: row.staffName,
        reason: holdReasonOf(row.hold_reason),
        occurredAt: row.occurred_at.toISOString(),
        receivedAt: row.received_at.toISOString(),
      })),
      nextCursor: rows.length > REVIEW_PAGE_SIZE && last !== undefined ? encodeCursor(last.position, last.id) : null,
    };
  });

  for (const decision of ["accept", "discard"] as const) {
    app.post(`/review-queue/:id/${decision}`, { config: { access: "owner" } }, async (request, reply) => {
      const owner = ownerOf(request);
      const { id } = parseInput(idParams, request.params);
      await withCafe(db, owner.cafeId, async (trx) => {
        const held = await trx.selectFrom("sync_events").select(["type", "hold_reason", "status"]).where("id", "=", id).forUpdate().executeTakeFirst();
        if (held?.status !== "held") {
          throw alreadyDecided();
        }
        await trx
          .updateTable("sync_events")
          .set({ status: decision === "accept" ? "applied" : "discarded", reviewed_at: now(), reviewed_by: owner.ownerId })
          .where("id", "=", id)
          .execute();
        await audit(trx, {
          cafeId: owner.cafeId,
          actorType: "owner",
          actorId: owner.ownerId,
          action: decision === "accept" ? "sync_event.accepted" : "sync_event.discarded",
          entityType: "sync_event",
          entityId: id,
          changes: { type: held.type, holdReason: held.hold_reason },
        });
      });
      request.log.info({ cafeId: owner.cafeId, decision }, "held event reviewed");
      return reply.code(204).send();
    });
  }

  done();
}
