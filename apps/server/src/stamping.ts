import { withCafe, type Database, type VisitOutcome } from "@cafe-loyalty/db";
import { ApiError, redemptionRequestSchema, type DeviceCatalog, type Redemption, type SyncResultCode, type VisitRecordedV1Event } from "@cafe-loyalty/shared";
import type { FastifyInstance } from "fastify";
import { sql, type Kysely, type Transaction } from "kysely";
import { deviceOf } from "./access.js";
import { phoneLookup, verifyCardQr, type CustomerSecrets } from "./customer-crypto.js";
import { audit, isUniqueViolation, now } from "./db-helpers.js";
import { requireSupportedBuild } from "./device-routes.js";
import { parseInput } from "./http-errors.js";

/** Minutes after a stamped visit in which the same card gets no more stamps (AC 30). Kept in step with the
 * visits_card_cooldown constraint (migration 0006), which enforces it in the database. */
export const STAMP_COOLDOWN_MINUTES = 30;
/** Most stamps one device adds in a café day (AC 30): a busy counter stays far below it; a misused one stops there. */
export const DAILY_STAMP_CAP = 300;

type CardReference = VisitRecordedV1Event["payload"]["card"];
type VisitItem = VisitRecordedV1Event["payload"]["items"][number];

type CardRefusal = "CARD_NOT_FOUND" | "CARD_REPLACED" | "PHONE_NOT_CONFIRMED" | "PHONE_DISPUTED";

export type CardLookup = { status: "found"; cardId: string } | { status: "refused"; code: CardRefusal };

/**
 * This café's card for a scanned QR or a typed phone number, under the café the transaction is set to. A QR must be
 * genuine, of this café and of the card's current epoch (AC 7, 8). A phone number finds the card through this café's
 * own cards (AC 3) and works only for a card already confirmed by a QR scan, since numbers are not verified, and
 * never once another card here signed up with the same number (a scan proves who holds a card, not whose number it is).
 * ponytail: a squatter who deletes the disputed card and signs up again starts undisputed; a per-café record of
 * disputed numbers would close that, at the cost of their stamps each time.
 */
export async function findCard(trx: Transaction<Database>, secrets: CustomerSecrets, cafeId: string, card: CardReference): Promise<CardLookup> {
  if (card.kind === "qr") {
    const verified = verifyCardQr(secrets, card.token);
    if (verified?.cafeId !== cafeId) {
      return { status: "refused", code: "CARD_NOT_FOUND" };
    }
    const row = await trx.selectFrom("cards").select("epoch").where("id", "=", verified.cardId).executeTakeFirst();
    if (row === undefined) {
      return { status: "refused", code: "CARD_NOT_FOUND" };
    }
    return row.epoch === verified.epoch ? { status: "found", cardId: verified.cardId } : { status: "refused", code: "CARD_REPLACED" };
  }
  const row = await trx
    .selectFrom("cards")
    .innerJoin("customers", "customers.id", "cards.customer_id")
    .select(["cards.id", "cards.phone_confirmed_at", "cards.phone_disputed_at"])
    .where("customers.phone_lookup", "=", phoneLookup(secrets, card.phone))
    .executeTakeFirst();
  if (row === undefined) {
    return { status: "refused", code: "CARD_NOT_FOUND" };
  }
  if (row.phone_disputed_at !== null) {
    return { status: "refused", code: "PHONE_DISPUTED" };
  }
  return row.phone_confirmed_at === null ? { status: "refused", code: "PHONE_NOT_CONFIRMED" } : { status: "found", cardId: row.id };
}

export type VisitPlan =
  | { status: "refused"; code: CardRefusal | "UNKNOWN_ORDER_TYPE" }
  | { status: "ready"; cardId: string; identifiedBy: "qr" | "phone"; stampsEach: ReadonlyMap<string, number>; stampsEarned: number };

/**
 * What a visit would do: its card, and the stamps its items earn (the sum over items whose order type earns any, at
 * the order type's current stamps), or why it is refused. Prices stay as the counter sent them (AC 32).
 */
export async function planVisit(trx: Transaction<Database>, secrets: CustomerSecrets, cafeId: string, payload: VisitRecordedV1Event["payload"]): Promise<VisitPlan> {
  const card = await findCard(trx, secrets, cafeId, payload.card);
  if (card.status === "refused") {
    return card;
  }
  const ids = [...new Set(payload.items.map((item) => item.orderTypeId))];
  const types = await trx.selectFrom("order_types").select(["id", "stamps_earned"]).where("id", "in", ids).execute();
  if (types.length !== ids.length) {
    return { status: "refused", code: "UNKNOWN_ORDER_TYPE" };
  }
  const stampsEach = new Map(types.map((type) => [type.id, type.stamps_earned]));
  const stampsEarned = payload.items.reduce((sum, item) => sum + item.quantity * (stampsEach.get(item.orderTypeId) ?? 0), 0);
  return { status: "ready", cardId: card.cardId, identifiedBy: payload.card.kind, stampsEach, stampsEarned };
}

/** Stores a visit and its items, held (applied later by the owner) or about to be applied. */
export async function insertVisit(
  trx: Transaction<Database>,
  visit: { cafeId: string; syncEventId: string; deviceId: string; staffId: string; occurredAt: Date; totalCents: number; items: readonly VisitItem[] },
  plan: Extract<VisitPlan, { status: "ready" }>,
): Promise<string> {
  const { id } = await trx
    .insertInto("visits")
    .values({
      cafe_id: visit.cafeId,
      sync_event_id: visit.syncEventId,
      card_id: plan.cardId,
      identified_by: plan.identifiedBy,
      device_id: visit.deviceId,
      staff_id: visit.staffId,
      occurred_at: visit.occurredAt,
      total_cents: visit.totalCents,
      stamps_earned: plan.stampsEarned,
      outcome: "held",
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  await trx
    .insertInto("visit_items")
    .values(
      visit.items.map((item, line) => ({
        cafe_id: visit.cafeId,
        visit_id: id,
        line,
        order_type_id: item.orderTypeId,
        quantity: item.quantity,
        unit_price_cents: item.unitPriceCents,
        unit_cost_cents: item.unitCostCents,
        catalog_version: item.catalogVersion,
        stamps_each: plan.stampsEach.get(item.orderTypeId) ?? 0,
      })),
    )
    .execute();
  return id;
}

const OUTCOME_CODES: Readonly<Record<Exclude<VisitOutcome, "held" | "discarded">, SyncResultCode>> = {
  stamped: "OK",
  no_stamps: "OK",
  cooldown: "STAMP_COOLDOWN",
  daily_cap: "DAILY_STAMP_CAP",
  card_gone: "CARD_GONE",
};

/**
 * Applies a stored visit: adds its stamps to the card unless the card got stamps within the cooldown or the device
 * reached its daily cap, both by the visit's own time, in the café's time zone (AC 30). The visit counts either way.
 * The card row is locked, so two visits of one card are applied one after the other; the sync locks the device row,
 * so its daily count is exact. Every stamp is audit-logged with the device and the staff member (AC 30).
 */
export async function applyVisit(trx: Transaction<Database>, cafeId: string, visitId: string): Promise<SyncResultCode> {
  const visit = await trx
    .selectFrom("visits")
    .select(["card_id", "identified_by", "device_id", "staff_id", "occurred_at", "stamps_earned"])
    .where("id", "=", visitId)
    .executeTakeFirstOrThrow();
  // NO KEY UPDATE: inserting the visit already took KEY SHARE on the card (its foreign key), which FOR UPDATE would
  // wait on in another device's transaction doing the same, a deadlock. Two of these still go one at a time.
  const card = visit.card_id === null ? undefined : await trx.selectFrom("cards").select("id").where("id", "=", visit.card_id).forNoKeyUpdate().executeTakeFirst();
  let outcome: Exclude<VisitOutcome, "held" | "discarded">;
  if (card === undefined) {
    outcome = "card_gone";
  } else if (visit.stamps_earned === 0) {
    outcome = "no_stamps";
  } else {
    const recent = await trx
      .selectFrom("visits")
      .select("id")
      .where("card_id", "=", card.id)
      .where("stamps_added", ">", 0)
      .where(sql<boolean>`stamp_cooldown_window(occurred_at) && stamp_cooldown_window(${visit.occurred_at})`)
      .executeTakeFirst();
    // The visit's café day as two instants first, so the sum reads only that day through visits_device_day_idx.
    const day = await trx
      .selectFrom("cafes")
      .select([
        sql<Date>`date_trunc('day', ${visit.occurred_at}::timestamptz AT TIME ZONE time_zone) AT TIME ZONE time_zone`.as("starts"),
        sql<Date>`(date_trunc('day', ${visit.occurred_at}::timestamptz AT TIME ZONE time_zone) + interval '1 day') AT TIME ZONE time_zone`.as("ends"),
      ])
      .where("id", "=", cafeId)
      .executeTakeFirstOrThrow();
    const today = await trx
      .selectFrom("visits")
      .select(sql<number>`coalesce(sum(stamps_added), 0)::int`.as("stamps"))
      .where("cafe_id", "=", cafeId)
      .where("device_id", "=", visit.device_id)
      .where("stamps_added", ">", 0)
      .where("occurred_at", ">=", day.starts)
      .where("occurred_at", "<", day.ends)
      .executeTakeFirstOrThrow();
    outcome = recent !== undefined ? "cooldown" : today.stamps + visit.stamps_earned > DAILY_STAMP_CAP ? "daily_cap" : "stamped";
  }
  const stamps = outcome === "stamped" ? visit.stamps_earned : 0;
  await trx.updateTable("visits").set({ outcome, stamps_added: stamps }).where("id", "=", visitId).execute();
  if (card !== undefined && outcome === "stamped") {
    await trx
      .updateTable("cards")
      .set({ stamps: sql<number>`stamps + ${stamps}`, ...(visit.identified_by === "qr" ? { phone_confirmed_at: sql<Date>`coalesce(phone_confirmed_at, ${now()})` } : {}) })
      .where("id", "=", card.id)
      .execute();
    // Logged against the visit, never the card: the visit loses its card when the card is deleted, and the log must
    // not keep the link (AC 9).
    await audit(trx, { cafeId, actorType: "device", actorId: visit.device_id, action: "visit.stamped", entityType: "visit", entityId: visitId, changes: { staffId: visit.staff_id, stamps } });
  } else if (card !== undefined && visit.identified_by === "qr") {
    // Scanned at the counter: the card may be stamped by phone number from now on, even if this visit added none.
    await trx.updateTable("cards").set({ phone_confirmed_at: sql<Date>`coalesce(phone_confirmed_at, ${now()})` }).where("id", "=", card.id).execute();
  }
  return OUTCOME_CODES[outcome];
}

export interface StampingRoutesOptions {
  db: Kysely<Database>;
  secrets: CustomerSecrets;
  releaseBuiltAt: Date;
}

const removedStaff = () => new ApiError("FORBIDDEN", "This barista was removed by the owner. Switch barista and try again.");

/** The device's catalog (AC 32) and online-only reward redemption (AC 31). */
export function stampingRoutes(app: FastifyInstance, options: StampingRoutesOptions, done: (error?: Error) => void): void {
  const { db, secrets } = options;

  /** Order types on sale and the reward, for recording visits offline. */
  app.get("/device/catalog", { config: { access: "device" } }, async (request): Promise<DeviceCatalog> => {
    requireSupportedBuild(request, options.releaseBuiltAt);
    const device = deviceOf(request);
    return withCafe(db, device.cafeId, async (trx) => {
      const cafe = await trx.selectFrom("cafes").select("catalog_version").where("id", "=", device.cafeId).executeTakeFirstOrThrow();
      const types = await trx
        .selectFrom("order_types")
        .select(["id", "name_ar", "name_en", "price_cents", "cost_cents", "stamps_earned"])
        .where("active", "=", true)
        .orderBy("sort_order")
        .execute();
      const program = await trx.selectFrom("loyalty_programs").select(["stamps_required", "reward_name_ar", "reward_name_en"]).executeTakeFirst();
      return {
        catalogVersion: cafe.catalog_version,
        orderTypes: types.map((type) => ({
          id: type.id,
          nameAr: type.name_ar,
          nameEn: type.name_en,
          priceCents: type.price_cents,
          costCents: type.cost_cents,
          stampsEarned: type.stamps_earned,
        })),
        program:
          program === undefined ? null : { stampsRequired: program.stamps_required, rewardNameAr: program.reward_name_ar, rewardNameEn: program.reward_name_en },
      };
    });
  });

  /**
   * Gives a reward for a scanned card QR, online only (AC 31): one atomic decrement of the program's stamps, recorded
   * once per event id, so a retry after a lost answer gets the first answer and never a second reward.
   */
  app.post("/device/redemptions", { config: { access: "device" } }, async (request, reply) => {
    const device = deviceOf(request);
    const body = parseInput(redemptionRequestSchema, request.body);
    const redeem = () =>
      withCafe(db, device.cafeId, async (trx): Promise<{ redemption: Redemption; created: boolean }> => {
        const card = await findCard(trx, secrets, device.cafeId, { kind: "qr", token: body.cardQr });
        const program = await trx.selectFrom("loyalty_programs").select(["stamps_required", "reward_name_ar", "reward_name_en"]).executeTakeFirst();
        const names = { rewardNameAr: program?.reward_name_ar ?? "", rewardNameEn: program?.reward_name_en ?? "" };
        const earlier = await trx
          .selectFrom("redemptions")
          .select(["card_id", "stamps_used", "stamps_left"])
          .where("device_id", "=", device.deviceId)
          .where("event_id", "=", body.eventId)
          .executeTakeFirst();
        if (earlier !== undefined) {
          if (card.status !== "found" || earlier.card_id !== card.cardId) {
            throw new ApiError("CONFLICT", "This reward was already given for another card. Start a new redemption.");
          }
          return { redemption: { stampsUsed: earlier.stamps_used, stampsLeft: earlier.stamps_left, ...names }, created: false };
        }
        // After the replay: a build that aged out since still learns whether its redemption was given, and a 426 means
        // it was not.
        requireSupportedBuild(request, options.releaseBuiltAt);
        // Locked and read here, so a revocation committed since the access check cannot slip through (AC 21).
        const deviceRow = await trx.selectFrom("devices").select("revoked_at").where("id", "=", device.deviceId).forShare().executeTakeFirstOrThrow();
        if (deviceRow.revoked_at !== null) {
          throw new ApiError("DEVICE_REVOKED", "The owner removed this device. Pair it again from the owner's dashboard to use it.");
        }
        const staff = await trx.selectFrom("staff").select("revoked_at").where("id", "=", body.staffId).forShare().executeTakeFirst();
        if (staff?.revoked_at !== null) {
          throw removedStaff();
        }
        if (card.status === "refused") {
          throw card.code === "CARD_REPLACED"
            ? new ApiError("NOT_FOUND", "This card was moved to another phone. Ask the customer to show the card on their new phone.")
            : new ApiError("NOT_FOUND", "This is not a loyalty card of this café. Scan the customer's card again.");
        }
        if (program === undefined) {
          throw new ApiError("CONFLICT", "This café has no reward yet. Ask the owner to set the loyalty program on the dashboard.");
        }
        const updated = await trx
          .updateTable("cards")
          .set({ stamps: sql<number>`stamps - ${program.stamps_required}` })
          .where("id", "=", card.cardId)
          .where("stamps", ">=", program.stamps_required)
          .returning("stamps")
          .executeTakeFirst();
        if (updated === undefined) {
          // The same redemption, sent twice at once, may have taken the stamps while this one waited: its answer is this one's.
          const first = await trx
            .selectFrom("redemptions")
            .select(["card_id", "stamps_used", "stamps_left"])
            .where("device_id", "=", device.deviceId)
            .where("event_id", "=", body.eventId)
            .executeTakeFirst();
          if (first?.card_id === card.cardId) {
            return { redemption: { stampsUsed: first.stamps_used, stampsLeft: first.stamps_left, ...names }, created: false };
          }
          const current = await trx.selectFrom("cards").select("stamps").where("id", "=", card.cardId).executeTakeFirstOrThrow();
          throw new ApiError(
            "CONFLICT",
            `This card has ${String(current.stamps)} of the ${String(program.stamps_required)} stamps a reward needs. Add stamps first.`,
          );
        }
        const created = await trx
          .insertInto("redemptions")
          .values({
            cafe_id: device.cafeId,
            device_id: device.deviceId,
            event_id: body.eventId,
            card_id: card.cardId,
            staff_id: body.staffId,
            stamps_used: program.stamps_required,
            stamps_left: updated.stamps,
          })
          .returning("id")
          .executeTakeFirstOrThrow();
        // Against the redemption, never the card (AC 9), as for stamps.
        await audit(trx, {
          cafeId: device.cafeId,
          actorType: "device",
          actorId: device.deviceId,
          action: "reward.redeemed",
          entityType: "redemption",
          entityId: created.id,
          changes: { staffId: body.staffId, stampsUsed: program.stamps_required },
        });
        return { redemption: { stampsUsed: program.stamps_required, stampsLeft: updated.stamps, ...names }, created: true };
      });
    let result: { redemption: Redemption; created: boolean };
    try {
      result = await redeem();
    } catch (error) {
      // The same redemption arrived twice at once: the first one won; this one gets its answer.
      if (!isUniqueViolation(error, "redemptions_event_key")) {
        throw error;
      }
      result = await redeem();
    }
    request.log.info({ cafeId: device.cafeId, deviceId: device.deviceId, repeated: !result.created }, "reward redeemed");
    return reply.code(result.created ? 201 : 200).send(result.redemption);
  });

  done();
}
