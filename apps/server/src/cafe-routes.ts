import { withCafe, type Database } from "@cafe-loyalty/db";
import {
  ApiError,
  cafeUpdateSchema,
  loyaltyProgramSchema,
  orderTypeCreateSchema,
  orderTypeUpdateSchema,
  type CafeSetup,
} from "@cafe-loyalty/shared";
import type { FastifyInstance } from "fastify";
import { sql, type Kysely, type Transaction } from "kysely";
import { z } from "zod";
import { ownerOf } from "./access.js";
import { audit } from "./db-helpers.js";
import { parseInput } from "./http-errors.js";

export interface CafeRoutesOptions {
  db: Kysely<Database>;
}

const idParams = z.object({ id: z.uuid("Use an id from the list.") });

async function loadSetup(trx: Transaction<Database>, cafeId: string): Promise<CafeSetup> {
  const cafe = await trx.selectFrom("cafes").select(["id", "name", "catalog_version"]).where("id", "=", cafeId).executeTakeFirstOrThrow();
  const program = await trx.selectFrom("loyalty_programs").select(["stamps_required", "reward_name_ar", "reward_name_en"]).executeTakeFirst();
  const orderTypes = await trx
    .selectFrom("order_types")
    .select(["id", "name_ar", "name_en", "price_cents", "cost_cents", "stamps_earned", "active"])
    .orderBy("sort_order")
    .orderBy("name_en")
    .execute();
  return {
    cafe: { id: cafe.id, name: cafe.name, catalogVersion: cafe.catalog_version },
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

/** The owner's café, loyalty program and order types (AC 1). Every change is audit-logged. */
export function cafeRoutes(app: FastifyInstance, options: CafeRoutesOptions, done: (error?: Error) => void): void {
  const { db } = options;

  app.get("/cafe", { config: { access: "owner" } }, async (request) => {
    const { cafeId } = ownerOf(request);
    return withCafe(db, cafeId, (trx) => loadSetup(trx, cafeId));
  });

  app.patch("/cafe", { config: { access: "owner" } }, async (request) => {
    const owner = ownerOf(request);
    const body = parseInput(cafeUpdateSchema, request.body);
    return withCafe(db, owner.cafeId, async (trx) => {
      await trx.updateTable("cafes").set({ name: body.name }).where("id", "=", owner.cafeId).execute();
      await audit(trx, { cafeId: owner.cafeId, actorType: "owner", actorId: owner.ownerId, action: "cafe.updated", entityType: "cafe", entityId: owner.cafeId, changes: { name: body.name } });
      request.log.info({ cafeId: owner.cafeId }, "cafe updated");
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
