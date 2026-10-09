import { withCafe, withLookup, type Database } from "@cafe-loyalty/db";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { sql, type Kysely } from "kysely";
import { APPLE_PASS_LAYOUT_VERSION, buildApplePass, type ApplePassConfig } from "./apple-pass.js";
import { hashToken } from "./credentials.js";
import { signCardQr, type CustomerSecrets } from "./customer-crypto.js";
import { RateLimiter, clientKey } from "./rate-limit.js";

export interface PasskitRoutesOptions {
  db: Kysely<Database>;
  secrets: CustomerSecrets;
  apple: ApplePassConfig;
  /** This server's public address; passes name `${publicUrl}/passkit` as their web service. */
  publicUrl: string;
}

const AUTHORIZATION = /^ApplePass ([A-Za-z0-9_-]{43})$/;
const DEVICE_LIBRARY_ID = /^[A-Za-z0-9._-]{1,128}$/;
const PUSH_TOKEN = /^[0-9A-Fa-f]{16,200}$/;
/** A lastUpdated tag this service gave out: a transaction id (xid8, at most 2^64 - 1). */
const isTag = (value: string): boolean => /^[0-9]{1,20}$/.test(value) && BigInt(value) <= 0xffffffffffffffffn;
/** Devices kept per pass (a phone, a watch, a few replaced phones): older ones go, so one pass never fans out widely. */
export const MAX_REGISTRATIONS_PER_PASS = 10;

interface PassParams {
  deviceLibraryIdentifier?: string;
  passTypeIdentifier: string;
  serialNumber: string;
}

/**
 * The PassKit web service (AC 11), at `/passkit/v1` as Apple's Wallet calls it: registering and unregistering a
 * device for a pass's updates, the passes of a device changed since a tag, the latest pass, and Wallet's error log.
 * It answers with the status codes Apple specifies and no error bodies. A pass is found by the SHA-256 of the
 * authenticationToken the device sends and served in its café (withCafe with that pass's café id).
 */
export function passkitRoutes(app: FastifyInstance, options: PasskitRoutesOptions, done: (error?: Error) => void): void {
  const { db, apple } = options;
  const logsPerIp = new RateLimiter(30, 60 * 60 * 1000);

  // Passes carry their authenticationToken: never cached.
  app.addHook("onRequest", (_request, reply, next) => {
    void reply.header("cache-control", "no-store");
    next();
  });

  app.setErrorHandler((error: Error & { statusCode?: number }, request, reply) => {
    const status = typeof error.statusCode === "number" && error.statusCode >= 400 && error.statusCode < 500 ? error.statusCode : 500;
    if (status >= 500) {
      request.log.error({ err: error }, "passkit request failed");
    } else {
      request.log.info({ status }, "passkit request rejected");
    }
    return reply.code(status).send();
  });

  /** The pass the request's ApplePass authorization opens, if it is the pass the path names. */
  async function authorizedPass(request: FastifyRequest, params: PassParams) {
    const token = AUTHORIZATION.exec(request.headers.authorization ?? "")?.[1];
    if (token === undefined || params.passTypeIdentifier !== apple.passTypeId) {
      return undefined;
    }
    const tokenHash = hashToken(token);
    const pass = await withLookup(db, { secretHash: tokenHash }, (trx) =>
      trx.selectFrom("apple_passes").select(["id", "cafe_id", "card_id", "epoch"]).where("auth_token_hash", "=", tokenHash).executeTakeFirst(),
    );
    return pass?.id === params.serialNumber ? { ...pass, token } : undefined;
  }

  const registrationPath = "/v1/devices/:deviceLibraryIdentifier/registrations/:passTypeIdentifier/:serialNumber";

  /** Registers a device for a pass's updates: 201 when new, 200 when it was registered already (its token updated). */
  app.post(registrationPath, async (request, reply) => {
    const params = request.params as Required<PassParams>;
    const pass = await authorizedPass(request, params);
    if (pass === undefined) {
      return reply.code(401).send();
    }
    const pushToken = (request.body as { pushToken?: unknown } | null | undefined)?.pushToken;
    if (typeof pushToken !== "string" || !PUSH_TOKEN.test(pushToken) || !DEVICE_LIBRARY_ID.test(params.deviceLibraryIdentifier)) {
      return reply.code(400).send();
    }
    const created = await withCafe(db, pass.cafe_id, async (trx) => {
      const row = await trx
        .insertInto("apple_pass_registrations")
        .values({ cafe_id: pass.cafe_id, pass_id: pass.id, device_library_hash: hashToken(params.deviceLibraryIdentifier), push_token: pushToken.toLowerCase() })
        .onConflict((conflict) => conflict.columns(["pass_id", "device_library_hash"]).doUpdateSet((update) => ({ push_token: update.ref("excluded.push_token") })))
        // xmax is 0 for a row this statement inserted, and set for one it updated.
        .returning(sql<boolean>`xmax = 0`.as("inserted"))
        .executeTakeFirstOrThrow();
      await trx
        .deleteFrom("apple_pass_registrations")
        .where("pass_id", "=", pass.id)
        .where(
          "device_library_hash",
          "not in",
          trx.selectFrom("apple_pass_registrations").select("device_library_hash").where("pass_id", "=", pass.id).orderBy("updated_at", "desc").limit(MAX_REGISTRATIONS_PER_PASS),
        )
        .execute();
      return row.inserted;
    });
    request.log.info({ cafeId: pass.cafe_id, created }, "apple pass registered");
    return reply.code(created ? 201 : 200).send();
  });

  /** Ends a device's registration for a pass. */
  app.delete(registrationPath, async (request, reply) => {
    const params = request.params as Required<PassParams>;
    const pass = await authorizedPass(request, params);
    if (pass === undefined) {
      return reply.code(401).send();
    }
    await withCafe(db, pass.cafe_id, (trx) =>
      trx.deleteFrom("apple_pass_registrations").where("pass_id", "=", pass.id).where("device_library_hash", "=", hashToken(params.deviceLibraryIdentifier)).execute(),
    );
    request.log.info({ cafeId: pass.cafe_id }, "apple pass unregistered");
    return reply.code(200).send();
  });

  /**
   * The serial numbers of the device's passes changed since `passesUpdatedSince` (all of them without it), and the
   * tag to ask with next time; 204 when none changed. The tag is the oldest transaction still running when the list
   * was read, so a change that commits later always has a later or equal tag, even when it started earlier. A tag
   * ahead of the database's transaction counter (one given out before a restore from a dump, which restarts it) lists
   * every pass, so no device waits for the counter to catch up.
   */
  app.get("/v1/devices/:deviceLibraryIdentifier/registrations/:passTypeIdentifier", async (request, reply) => {
    const { deviceLibraryIdentifier, passTypeIdentifier } = request.params as { deviceLibraryIdentifier: string; passTypeIdentifier: string };
    const { passesUpdatedSince } = request.query as { passesUpdatedSince?: string };
    if (!DEVICE_LIBRARY_ID.test(deviceLibraryIdentifier) || (passesUpdatedSince !== undefined && !isTag(passesUpdatedSince))) {
      return reply.code(400).send();
    }
    if (passTypeIdentifier !== apple.passTypeId) {
      return reply.code(204).send();
    }
    const deviceHash = hashToken(deviceLibraryIdentifier);
    const { serialNumbers, lastUpdated } = await withLookup(db, { secretHash: deviceHash }, async (trx) => {
      // Read first: each statement has its own snapshot, and a change the list below misses must not fall below the
      // tag. An earlier snapshot's xmin is never above a later one's.
      const { rows } = await sql<{ xmin: string }>`SELECT pg_snapshot_xmin(pg_current_snapshot())::text AS xmin`.execute(trx);
      const passes = await trx
        .selectFrom("apple_pass_registrations")
        .innerJoin("apple_passes", "apple_passes.id", "apple_pass_registrations.pass_id")
        .select("apple_passes.id")
        .where("apple_pass_registrations.device_library_hash", "=", deviceHash)
        .$if(passesUpdatedSince !== undefined, (query) =>
          query.where(sql<boolean>`(apple_passes.updated_xid >= ${passesUpdatedSince}::xid8 OR ${passesUpdatedSince}::xid8 > pg_snapshot_xmax(pg_current_snapshot()))`),
        )
        .orderBy("apple_passes.id")
        .execute();
      return { serialNumbers: passes.map((pass) => pass.id), lastUpdated: rows[0]?.xmin ?? "0" };
    });
    if (serialNumbers.length === 0) {
      return reply.code(204).send();
    }
    return reply.code(200).send({ serialNumbers, lastUpdated });
  });

  /**
   * The latest version of a pass: 304 when it has not changed since If-Modified-Since and was built on the current
   * layout. A pass of an earlier epoch than its card's is voided (the card moved to another phone, AC 8).
   */
  app.get("/v1/passes/:passTypeIdentifier/:serialNumber", async (request, reply) => {
    const params = request.params as PassParams;
    const pass = await authorizedPass(request, params);
    if (pass === undefined) {
      return reply.code(401).send();
    }
    const since = Date.parse(request.headers["if-modified-since"] ?? "");
    const found = await withCafe(db, pass.cafe_id, async (trx) => {
      let row = await trx.selectFrom("apple_passes").select(["modified_at", "layout_version"]).where("id", "=", pass.id).executeTakeFirstOrThrow();
      if (row.layout_version !== APPLE_PASS_LAYOUT_VERSION) {
        // Built on another layout: marked changed for every device of the pass, which Wallet fetches one by one (the
        // request names no device), and before this response, so a failed one is fetched again.
        row = await trx
          .updateTable("apple_passes")
          .set({
            layout_version: APPLE_PASS_LAYOUT_VERSION,
            updated_xid: sql<string>`pg_current_xact_id()`,
            modified_at: sql<Date>`greatest(date_trunc('second', now()), modified_at + interval '1 second')`,
          })
          .where("id", "=", pass.id)
          .returning(["modified_at", "layout_version"])
          .executeTakeFirstOrThrow();
      } else if (!Number.isNaN(since) && row.modified_at.getTime() <= since) {
        return undefined;
      }
      const card = await trx.selectFrom("cards").select(["epoch", "stamps"]).where("id", "=", pass.card_id).executeTakeFirstOrThrow();
      const cafe = await trx.selectFrom("cafes").select("name").where("id", "=", pass.cafe_id).executeTakeFirstOrThrow();
      const program = await trx.selectFrom("loyalty_programs").select(["stamps_required", "reward_name_ar", "reward_name_en"]).executeTakeFirst();
      return { modifiedAt: row.modified_at, card, cafeName: cafe.name, program };
    });
    if (found === undefined) {
      return reply.code(304).send();
    }
    const current = found.card.epoch === pass.epoch;
    const pkpass = buildApplePass(apple, options.publicUrl, {
      serialNumber: pass.id,
      authenticationToken: pass.token,
      cafeName: found.cafeName,
      stamps: found.card.stamps,
      program:
        found.program === undefined
          ? undefined
          : { stampsRequired: found.program.stamps_required, rewardNameAr: found.program.reward_name_ar, rewardNameEn: found.program.reward_name_en },
      qr: current ? signCardQr(options.secrets, { cardId: pass.card_id, cafeId: pass.cafe_id, epoch: pass.epoch }) : null,
    });
    request.log.info({ cafeId: pass.cafe_id, voided: !current }, "apple pass sent");
    return reply.code(200).header("content-type", "application/vnd.apple.pkpass").header("last-modified", found.modifiedAt.toUTCString()).send(pkpass);
  });

  /** Wallet's reports of problems with this service. Logged (a few per address per hour), never answered with an error. */
  app.post("/v1/log", { bodyLimit: 16 * 1024 }, async (request, reply) => {
    const logs = (request.body as { logs?: unknown } | null | undefined)?.logs;
    if (logsPerIp.hit(clientKey(request.ip)) === 0) {
      const messages = Array.isArray(logs) ? logs.filter((entry): entry is string => typeof entry === "string").slice(0, 10).map((entry) => entry.slice(0, 500)) : [];
      request.log.warn({ messages }, "apple wallet reported a web service problem");
    }
    return reply.code(200).send();
  });

  done();
}
