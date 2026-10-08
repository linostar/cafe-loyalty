import { withCafe, type Database } from "@cafe-loyalty/db";
import { ApiError, staffCreateSchema, staffUpdateSchema, type StaffMember } from "@cafe-loyalty/shared";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { Kysely, Transaction } from "kysely";
import { z } from "zod";
import { ownerOf } from "./access.js";
import { audit, now } from "./db-helpers.js";
import { parseInput, rateLimited } from "./http-errors.js";
import { hashPin } from "./pins.js";
import { RateLimiter } from "./rate-limit.js";

export interface StaffRoutesOptions {
  db: Kysely<Database>;
}

const idParams = z.object({ id: z.uuid("Use an id from the list.") });

const notFound = () => new ApiError("NOT_FOUND", "This staff member does not exist. Reload the page to see the current list.");

async function listStaff(trx: Transaction<Database>): Promise<{ staff: StaffMember[] }> {
  const rows = await trx.selectFrom("staff").select(["id", "name", "revoked_at", "created_at"]).orderBy("name").execute();
  return { staff: rows.map((row) => ({ id: row.id, name: row.name, revoked: row.revoked_at !== null, createdAt: row.created_at.toISOString() })) };
}

/**
 * Baristas and their PINs (AC 19). The owner sets each PIN; the server keeps only its PBKDF2 hash, which paired
 * devices receive. Staff are revoked, never deleted, so the actions they recorded keep their author. Audit entries
 * name the staff member by id only.
 */
export function staffRoutes(app: FastifyInstance, options: StaffRoutesOptions, done: (error?: Error) => void): void {
  const { db } = options;
  // Each PIN costs 600,000 PBKDF2 iterations on the shared thread pool, so one café cannot starve the others.
  const pinsPerOwner = new RateLimiter(30, 60 * 60 * 1000);

  function limitPinHashing(ownerId: string, reply: FastifyReply): void {
    const wait = pinsPerOwner.hit(ownerId);
    if (wait > 0) {
      throw rateLimited(reply, wait);
    }
  }

  app.get("/staff", { config: { access: "owner" } }, async (request) => withCafe(db, ownerOf(request).cafeId, listStaff));

  app.post("/staff", { config: { access: "owner" } }, async (request, reply) => {
    const owner = ownerOf(request);
    const body = parseInput(staffCreateSchema, request.body);
    limitPinHashing(owner.ownerId, reply);
    const pin = await hashPin(body.pin);
    const list = await withCafe(db, owner.cafeId, async (trx) => {
      const created = await trx
        .insertInto("staff")
        .values({ cafe_id: owner.cafeId, name: body.name, pin_salt: pin.salt, pin_hash: pin.hash, pin_iterations: pin.iterations })
        .returning("id")
        .executeTakeFirstOrThrow();
      await audit(trx, { cafeId: owner.cafeId, actorType: "owner", actorId: owner.ownerId, action: "staff.added", entityType: "staff", entityId: created.id });
      return listStaff(trx);
    });
    request.log.info({ cafeId: owner.cafeId }, "staff member added");
    return reply.code(201).send(list);
  });

  app.patch("/staff/:id", { config: { access: "owner" } }, async (request, reply) => {
    const owner = ownerOf(request);
    const { id } = parseInput(idParams, request.params);
    const body = parseInput(staffUpdateSchema, request.body);
    if (body.pin !== undefined) {
      limitPinHashing(owner.ownerId, reply);
    }
    const pin = body.pin === undefined ? undefined : await hashPin(body.pin);
    const list = await withCafe(db, owner.cafeId, async (trx) => {
      const current = await trx.selectFrom("staff").select("revoked_at").where("id", "=", id).forUpdate().executeTakeFirst();
      if (current === undefined) {
        throw notFound();
      }
      if (current.revoked_at !== null) {
        throw new ApiError("CONFLICT", "This staff member was removed. Add them again to give them a PIN.");
      }
      await trx
        .updateTable("staff")
        .set({
          ...(body.name === undefined ? {} : { name: body.name }),
          ...(pin === undefined ? {} : { pin_salt: pin.salt, pin_hash: pin.hash, pin_iterations: pin.iterations }),
        })
        .where("id", "=", id)
        .execute();
      const fields = [...(body.name === undefined ? [] : ["name"]), ...(pin === undefined ? [] : ["pin"])];
      await audit(trx, { cafeId: owner.cafeId, actorType: "owner", actorId: owner.ownerId, action: "staff.updated", entityType: "staff", entityId: id, changes: { fields } });
      return listStaff(trx);
    });
    request.log.info({ cafeId: owner.cafeId, staffId: id }, "staff member updated");
    return list;
  });

  /** Removes a barista: devices stop accepting their PIN once they sync. Repeating it changes nothing. */
  app.post("/staff/:id/revoke", { config: { access: "owner" } }, async (request) => {
    const owner = ownerOf(request);
    const { id } = parseInput(idParams, request.params);
    return withCafe(db, owner.cafeId, async (trx) => {
      const current = await trx.selectFrom("staff").select("revoked_at").where("id", "=", id).forUpdate().executeTakeFirst();
      if (current === undefined) {
        throw notFound();
      }
      if (current.revoked_at === null) {
        await trx.updateTable("staff").set({ revoked_at: now() }).where("id", "=", id).execute();
        await audit(trx, { cafeId: owner.cafeId, actorType: "owner", actorId: owner.ownerId, action: "staff.revoked", entityType: "staff", entityId: id });
        request.log.info({ cafeId: owner.cafeId, staffId: id }, "staff member revoked");
      }
      return listStaff(trx);
    });
  });

  done();
}
