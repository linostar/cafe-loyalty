import { queueChangedPasses, withCafe, type Database, type PgBoss } from "@cafe-loyalty/db";
import {
  ApiError,
  REPEATED_DELIVERY_FAILURES,
  VISIT_HOURS_WEEKS,
  cafeUpdateSchema,
  loyaltyProgramSchema,
  orderTypeCreateSchema,
  orderTypeUpdateSchema,
  winBackSettingsSchema,
  type CafeSetup,
  type Discount,
  type VisitHours,
  type WalletDeliveries,
} from "@cafe-loyalty/shared";
import type { FastifyInstance } from "fastify";
import { sql, type Kysely, type Transaction } from "kysely";
import { z } from "zod";
import { ownerOf } from "./access.js";
import { audit } from "./db-helpers.js";
import { parseInput } from "./http-errors.js";

export interface CafeRoutesOptions {
  db: Kysely<Database>;
  /** This server's public address; the café's signup QR opens its /join page. */
  publicUrl: string;
  /** The job queue, or undefined when it could not start (passes are still marked changed, for the sweep). */
  jobs: PgBoss | undefined;
}

const idParams = z.object({ id: z.uuid("Use an id from the list.") });

/** The café's win-back discount from its columns (AC 36), or null without one. */
export const winBackDiscountOf = (cafe: { win_back_discount_kind: "percent" | "amount" | null; win_back_discount_value: number | null }): Discount | null =>
  cafe.win_back_discount_kind === null || cafe.win_back_discount_value === null ? null : { kind: cafe.win_back_discount_kind, value: cafe.win_back_discount_value };

async function loadSetup(trx: Transaction<Database>, cafeId: string): Promise<CafeSetup> {
  const cafe = await trx
    .selectFrom("cafes")
    .select(["id", "name", "catalog_version", "min_margin_percent", "win_back_discount_kind", "win_back_discount_value", "win_back_cooldown_days"])
    .where("id", "=", cafeId)
    .executeTakeFirstOrThrow();
  const program = await trx.selectFrom("loyalty_programs").select(["stamps_required", "reward_name_ar", "reward_name_en"]).executeTakeFirst();
  const orderTypes = await trx
    .selectFrom("order_types")
    .select(["id", "name_ar", "name_en", "price_cents", "cost_cents", "stamps_earned", "active"])
    .orderBy("sort_order")
    .orderBy("name_en")
    .execute();
  return {
    cafe: {
      id: cafe.id,
      name: cafe.name,
      catalogVersion: cafe.catalog_version,
      minMarginPercent: cafe.min_margin_percent,
      winBack: { discount: winBackDiscountOf(cafe), cooldownDays: cafe.win_back_cooldown_days },
    },
    program:
      program === undefined
        ? null
        : { stampsRequired: program.stamps_required, rewardNameAr: program.reward_name_ar, rewardNameEn: program.reward_name_en },
    orderTypes: orderTypes.map((row) => ({
      id: row.id,
      nameAr: row.name_ar,
      nameEn: row.name_en,
      priceCents: row.price_cents,
      costCents: row.cost_cents,
      stampsEarned: row.stamps_earned,
      active: row.active,
    })),
  };
}

/** Prices change: visits priced at the old catalog keep their version, new ones get the next (AC 32). */
async function bumpCatalogVersion(trx: Transaction<Database>, cafeId: string): Promise<void> {
  await trx
    .updateTable("cafes")
    .set({ catalog_version: sql<number>`catalog_version + 1` })
    .where("id", "=", cafeId)
    .execute();
}

/**
 * The café's member visits from `from` up to `to`, by ISO weekday (index 0 = Monday) and hour, in the café's time
 * zone (AC 33). Bucketed by when each visit happened (occurred_at), so a visit synced days late lands in its own hour,
 * and only by PostgreSQL's time zone data, never Node's as well, so the two can never disagree about a changeover.
 * Held and discarded visits are left out until the owner accepts them; a visit whose card was deleted since counts.
 */
export async function memberVisitHours(trx: Transaction<Database>, cafeId: string, from: Date, to: Date): Promise<Pick<VisitHours, "timeZone" | "visits">> {
  const { time_zone: timeZone } = await trx.selectFrom("cafes").select("time_zone").where("id", "=", cafeId).executeTakeFirstOrThrow();
  const { rows } = await sql<{ weekday: number; hour: number; visits: number }>`
    SELECT extract(isodow FROM local)::int AS weekday, extract(hour FROM local)::int AS hour, count(*)::int AS visits
      FROM (SELECT occurred_at AT TIME ZONE ${timeZone} AS local FROM visits
             WHERE cafe_id = ${cafeId} AND occurred_at >= ${from} AND occurred_at < ${to} AND outcome NOT IN ('held', 'discarded')) AS member_visits
     GROUP BY 1, 2`.execute(trx);
  const visits = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0));
  for (const row of rows) {
    const day = visits[row.weekday - 1];
    if (day !== undefined) {
      day[row.hour] = row.visits;
    }
  }
  return { timeZone, visits };
}

/** The owner's café, loyalty program and order types (AC 1). Every change is audit-logged. */
export function cafeRoutes(app: FastifyInstance, options: CafeRoutesOptions, done: (error?: Error) => void): void {
  const { db, jobs } = options;

  app.get("/cafe", { config: { access: "owner" } }, async (request) => {
    const { cafeId } = ownerOf(request);
    return withCafe(db, cafeId, (trx) => loadSetup(trx, cafeId));
  });

  /**
   * Wallets whose pass updates keep failing (AC 13): per wallet, the passes whose last REPEATED_DELIVERY_FAILURES or
   * more updates failed, when the last one failed and its code. Stamps are recorded regardless; this tells the owner
   * that customers' wallet cards lag behind.
   */
  app.get("/cafe/wallet-deliveries", { config: { access: "owner" } }, async (request): Promise<WalletDeliveries> => {
    const { cafeId } = ownerOf(request);
    const { rows } = await withCafe(db, cafeId, (trx) =>
      sql<{ wallet: "apple" | "google"; passes: number; last_failed_at: Date | null; last_error: string | null }>`
        SELECT 'apple' AS wallet, count(*)::int AS passes, max(delivery_failed_at) AS last_failed_at,
               (array_agg(delivery_error ORDER BY delivery_failed_at DESC))[1] AS last_error
          FROM apple_passes WHERE delivery_failures >= ${REPEATED_DELIVERY_FAILURES}
        UNION ALL
        SELECT 'google', count(*)::int, max(delivery_failed_at), (array_agg(delivery_error ORDER BY delivery_failed_at DESC))[1]
          FROM google_passes WHERE delivery_failures >= ${REPEATED_DELIVERY_FAILURES}`.execute(trx),
    );
    return {
      failing: rows.flatMap((row) =>
        row.passes > 0 && row.last_failed_at !== null
          ? [{ wallet: row.wallet, passes: row.passes, lastFailedAt: row.last_failed_at.toISOString(), lastError: row.last_error ?? "error" }]
          : [],
      ),
    };
  });

  /** Busy and quiet hours (AC 34): member visits of the last VISIT_HOURS_WEEKS weeks, counted afresh on every request. */
  app.get("/cafe/visit-hours", { config: { access: "owner" } }, async (request): Promise<VisitHours> => {
    const { cafeId } = ownerOf(request);
    const to = new Date();
    const from = new Date(to.getTime() - VISIT_HOURS_WEEKS * 7 * 24 * 60 * 60 * 1000);
    const hours = await withCafe(db, cafeId, (trx) => memberVisitHours(trx, cafeId, from, to));
    return { ...hours, from: from.toISOString(), to: to.toISOString() };
  });

  const joinLink = (code: string) => ({ joinUrl: new URL(`/join/${code}`, options.publicUrl).toString() });

  /** The café's customer signup link, for the QR printed at the counter (AC 4). */
  app.get("/cafe/join", { config: { access: "owner" } }, async (request) => {
    const { cafeId } = ownerOf(request);
    const cafe = await withCafe(db, cafeId, (trx) => trx.selectFrom("cafes").select("join_code").where("id", "=", cafeId).executeTakeFirstOrThrow());
    return joinLink(cafe.join_code);
  });

  /** Replaces the signup code, so the old printed QR stops working (for example after it was misused). */
  app.post("/cafe/join/rotate", { config: { access: "owner" } }, async (request) => {
    const owner = ownerOf(request);
    const cafe = await withCafe(db, owner.cafeId, async (trx) => {
      const updated = await trx
        .updateTable("cafes")
        .set({ join_code: sql<string>`replace(gen_random_uuid()::text, '-', '')` })
        .where("id", "=", owner.cafeId)
        .returning("join_code")
        .executeTakeFirstOrThrow();
      await audit(trx, { cafeId: owner.cafeId, actorType: "owner", actorId: owner.ownerId, action: "cafe.join_code_rotated", entityType: "cafe", entityId: owner.cafeId });
      return updated;
    });
    request.log.info({ cafeId: owner.cafeId }, "cafe join code rotated");
    return joinLink(cafe.join_code);
  });

  app.patch("/cafe", { config: { access: "owner" } }, async (request) => {
    const owner = ownerOf(request);
    const body = parseInput(cafeUpdateSchema, request.body);
    return withCafe(db, owner.cafeId, async (trx) => {
      const changes = { name: body.name, min_margin_percent: body.minMarginPercent };
      await trx.updateTable("cafes").set(changes).where("id", "=", owner.cafeId).execute();
      await audit(trx, {
        cafeId: owner.cafeId,
        actorType: "owner",
        actorId: owner.ownerId,
        action: "cafe.updated",
        entityType: "cafe",
        entityId: owner.cafeId,
        changes: { name: body.name, minMarginPercent: body.minMarginPercent },
      });
      request.log.info({ cafeId: owner.cafeId }, "cafe updated");
      return loadSetup(trx, owner.cafeId);
    });
  });

  /**
   * Sets the café's win-back offer (AC 36): the discount a lapsed card gets on its next visit, or none, and the
   * cool-down before a card can get it again. Offers already given keep their terms; turning the offer off closes them.
   */
  app.put("/cafe/win-back", { config: { access: "owner" } }, async (request) => {
    const owner = ownerOf(request);
    const body = parseInput(winBackSettingsSchema, request.body);
    return withCafe(db, owner.cafeId, async (trx) => {
      await trx
        .updateTable("cafes")
        .set({
          win_back_discount_kind: body.discount?.kind ?? null,
          win_back_discount_value: body.discount?.value ?? null,
          win_back_cooldown_days: body.cooldownDays,
        })
        .where("id", "=", owner.cafeId)
        .execute();
      if (body.discount === null) {
        // No offer any more: the open ones leave the cards' passes (a trigger marks them, migration 0014), since the
        // counter can no longer apply them.
        const closed = await trx
          .updateTable("card_lapses")
          .set({ closed_at: sql<Date>`now()` })
          .where("offered_at", "is not", null)
          .where("closed_at", "is", null)
          .returning("card_id")
          .execute();
        if (jobs !== undefined) {
          await queueChangedPasses(
            jobs,
            trx,
            owner.cafeId,
            closed.map((row) => row.card_id),
          );
        }
      }
      await audit(trx, { cafeId: owner.cafeId, actorType: "owner", actorId: owner.ownerId, action: "cafe.win_back_set", entityType: "cafe", entityId: owner.cafeId, changes: body });
      request.log.info({ cafeId: owner.cafeId }, "win-back offer set");
      return loadSetup(trx, owner.cafeId);
    });
  });

  app.put("/cafe/program", { config: { access: "owner" } }, async (request) => {
    const owner = ownerOf(request);
    const body = parseInput(loyaltyProgramSchema, request.body);
    return withCafe(db, owner.cafeId, async (trx) => {
      const values = { stamps_required: body.stampsRequired, reward_name_ar: body.rewardNameAr, reward_name_en: body.rewardNameEn };
      const saved = await trx
        .insertInto("loyalty_programs")
        .values({ cafe_id: owner.cafeId, ...values })
        .onConflict((conflict) => conflict.column("cafe_id").doUpdateSet(values))
        .returning("id")
        .executeTakeFirstOrThrow();
      await audit(trx, { cafeId: owner.cafeId, actorType: "owner", actorId: owner.ownerId, action: "loyalty_program.saved", entityType: "loyalty_program", entityId: saved.id, changes: body });
      request.log.info({ cafeId: owner.cafeId }, "loyalty program saved");
      return loadSetup(trx, owner.cafeId);
    });
  });

  app.post("/cafe/order-types", { config: { access: "owner" } }, async (request, reply) => {
    const owner = ownerOf(request);
    const body = parseInput(orderTypeCreateSchema, request.body);
    const setup = await withCafe(db, owner.cafeId, async (trx) => {
      const created = await trx
        .insertInto("order_types")
        .values({
          cafe_id: owner.cafeId,
          name_ar: body.nameAr,
          name_en: body.nameEn,
          price_cents: body.priceCents,
          cost_cents: body.costCents,
          stamps_earned: body.stampsEarned,
          active: body.active,
          sort_order: sql<number>`(SELECT coalesce(max(sort_order), 0) + 1 FROM order_types WHERE cafe_id = ${owner.cafeId})`,
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      await bumpCatalogVersion(trx, owner.cafeId);
      await audit(trx, { cafeId: owner.cafeId, actorType: "owner", actorId: owner.ownerId, action: "order_type.created", entityType: "order_type", entityId: created.id, changes: body });
      request.log.info({ cafeId: owner.cafeId }, "order type created");
      return loadSetup(trx, owner.cafeId);
    });
    return reply.code(201).send(setup);
  });

  app.patch("/cafe/order-types/:id", { config: { access: "owner" } }, async (request) => {
    const owner = ownerOf(request);
    const { id } = parseInput(idParams, request.params);
    const body = parseInput(orderTypeUpdateSchema, request.body);
    return withCafe(db, owner.cafeId, async (trx) => {
      const current = await trx
        .selectFrom("order_types")
        .select(["name_ar", "name_en", "price_cents", "cost_cents", "stamps_earned", "active"])
        .where("id", "=", id)
        .forUpdate()
        .executeTakeFirst();
      if (current === undefined) {
        throw new ApiError("NOT_FOUND", "This order type does not exist. Reload the page to see the current list.");
      }
      const next = {
        name_ar: body.nameAr ?? current.name_ar,
        name_en: body.nameEn ?? current.name_en,
        price_cents: body.priceCents ?? current.price_cents,
        cost_cents: body.costCents ?? current.cost_cents,
        stamps_earned: body.stampsEarned ?? current.stamps_earned,
        active: body.active ?? current.active,
      };
      const changes = Object.fromEntries(
        (Object.keys(next) as (keyof typeof next)[]).filter((key) => next[key] !== current[key]).map((key) => [key, { from: current[key], to: next[key] }]),
      );
      await trx.updateTable("order_types").set(next).where("id", "=", id).execute();
      if (next.price_cents !== current.price_cents || next.cost_cents !== current.cost_cents) {
        await bumpCatalogVersion(trx, owner.cafeId);
      }
      await audit(trx, { cafeId: owner.cafeId, actorType: "owner", actorId: owner.ownerId, action: "order_type.updated", entityType: "order_type", entityId: id, changes });
      request.log.info({ cafeId: owner.cafeId }, "order type updated");
      return loadSetup(trx, owner.cafeId);
    });
  });

  done();
}
