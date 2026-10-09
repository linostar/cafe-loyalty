import { createPublicKey, randomInt, timingSafeEqual, verify, type KeyObject } from "node:crypto";
import { withCafe, withLookup, type Database } from "@cafe-loyalty/db";
import {
  ApiError,
  COUNTER_BUILT_AT_HEADER,
  COUNTER_SUPPORT_DAYS,
  PAIRING_CODE_ALPHABET,
  PAIRING_CODE_LENGTH,
  PAIRING_CODE_LOOKUP_LENGTH,
  devicePairProofPayload,
  deviceTokenSigningPayload,
  formatPairingCode,
  pairRequestSchema,
  pairingCodeCreateSchema,
  tokenRenewalRequestSchema,
  type DevicePublicKeyJwk,
  type Devices,
} from "@cafe-loyalty/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { sql, type Kysely, type Transaction } from "kysely";
import { z } from "zod";
import { deviceOf, ownerOf } from "./access.js";
import { hashToken, newToken } from "./credentials.js";
import { audit, isUniqueViolation, now, secondsAgo, secondsFromNow } from "./db-helpers.js";
import { parseInput, rateLimited } from "./http-errors.js";
import { RateLimiter, clientKey } from "./rate-limit.js";

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** A pairing code works for this long (AC 17). */
export const PAIRING_CODE_TTL_SECONDS = 10 * MINUTE;
/** Wrong secrets that delete a pairing code: the fifth wrong try burns it (AC 17). */
export const PAIRING_CODE_MAX_ATTEMPTS = 5;
/** A device access token works for this long; the device renews it with its key (AC 18). */
export const DEVICE_TOKEN_TTL_SECONDS = HOUR;
/** A device that has not renewed for this long must pair again (AC 18). */
export const DEVICE_RENEWAL_WINDOW_SECONDS = 7 * DAY;
/** How far a renewal's issuedAt may be from the server's clock. */
export const RENEWAL_CLOCK_SKEW_MS = 5 * MINUTE * 1000;

export interface DeviceRoutesOptions {
  db: Kysely<Database>;
  /** Public counter app address; pairing QR codes open its /pair page. */
  counterUrl: string;
  /** When this release was built; counter builds made more than COUNTER_SUPPORT_DAYS before it are too old (AC 26). */
  releaseBuiltAt: Date;
}

const idParams = z.object({ id: z.uuid("Use an id from the list.") });
const builtAtSchema = z.iso.datetime({ offset: false });

/**
 * Refuses a new action from a counter build made more than COUNTER_SUPPORT_DAYS before this release, or one that
 * does not say when it was built (AC 26). Pairing, renewing the token and syncing the queue never call this, so an old
 * build can always hand over what it recorded; once its queue is empty it updates itself.
 */
export function requireSupportedBuild(request: FastifyRequest, releaseBuiltAt: Date): void {
  const header = builtAtSchema.safeParse(request.headers[COUNTER_BUILT_AT_HEADER]);
  if (!header.success || Date.parse(header.data) < releaseBuiltAt.getTime() - COUNTER_SUPPORT_DAYS * DAY * 1000) {
    throw new ApiError("CLIENT_TOO_OLD", "This counter app is out of date. Keep the phone online: it sends its waiting stamps, then updates itself.");
  }
}

const invalidCode = () =>
  new ApiError("PAIRING_CODE_INVALID", "This pairing code is wrong, used or expired. Check it, or create a new code on the owner's dashboard.");
const pairingRequired = () => new ApiError("PAIRING_REQUIRED", "This device must be paired again. Create a pairing code on the owner's dashboard.");

/** A new pairing code: 12 characters drawn uniformly from the Crockford alphabet (60 bits; 40 in the secret part). */
export function newPairingCode(): string {
  return Array.from({ length: PAIRING_CODE_LENGTH }, () => PAIRING_CODE_ALPHABET[randomInt(PAIRING_CODE_ALPHABET.length)]).join("");
}

/** The device's public key as a key object, or undefined when the coordinates are not a valid P-256 point. */
export function importDeviceKey(jwk: DevicePublicKeyJwk): KeyObject | undefined {
  try {
    return createPublicKey({ key: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y }, format: "jwk" });
  } catch {
    return undefined;
  }
}

/** Verifies a WebCrypto ECDSA P-256 / SHA-256 signature (raw r||s, base64url) over `payload`. */
export function verifyDeviceSignature(key: KeyObject, payload: string, signature: string): boolean {
  try {
    return verify("sha256", Buffer.from(payload), { key, dsaEncoding: "ieee-p1363" }, Buffer.from(signature, "base64url"));
  } catch {
    return false;
  }
}

async function issueDeviceToken(trx: Transaction<Database>, cafeId: string, deviceId: string): Promise<{ accessToken: string; accessTokenExpiresAt: string }> {
  await trx.deleteFrom("device_tokens").where("device_id", "=", deviceId).where("expires_at", "<=", now()).execute();
  const accessToken = newToken();
  const issued = await trx
    .insertInto("device_tokens")
    .values({ cafe_id: cafeId, device_id: deviceId, token_hash: hashToken(accessToken), expires_at: secondsFromNow(DEVICE_TOKEN_TTL_SECONDS) })
    .returning("expires_at")
    .executeTakeFirstOrThrow();
  return { accessToken, accessTokenExpiresAt: issued.expires_at.toISOString() };
}

/**
 * The device a pairing request continues, when `previous` is signed, over this code and the new key, by one of that
 * device's keys in the café the transaction is set to; its row is locked, so renewals and other pairings of it wait. Undefined otherwise.
 */
async function provenDevice(
  trx: Transaction<Database>,
  code: string,
  previous: { deviceId: string; keyId: string; signature: string },
  publicKey: DevicePublicKeyJwk,
): Promise<{ deviceId: string; wasRevoked: boolean } | undefined> {
  const oldKey = await trx
    .selectFrom("device_keys")
    .select("public_key")
    .where("id", "=", previous.keyId)
    .where("device_id", "=", previous.deviceId)
    .executeTakeFirst();
  const verifier = oldKey === undefined ? undefined : importDeviceKey(oldKey.public_key);
  if (verifier === undefined || !verifyDeviceSignature(verifier, devicePairProofPayload(code, previous, publicKey), previous.signature)) {
    return undefined;
  }
  const device = await trx.selectFrom("devices").select("revoked_at").where("id", "=", previous.deviceId).forUpdate().executeTakeFirstOrThrow();
  return { deviceId: previous.deviceId, wasRevoked: device.revoked_at !== null };
}

async function listDevices(trx: Transaction<Database>): Promise<Devices> {
  const devices = await trx.selectFrom("devices").select(["id", "name", "paired_at", "last_seen_at", "revoked_at"]).orderBy("paired_at").execute();
  const codes = await trx.selectFrom("pairing_codes").select(["id", "device_name", "expires_at"]).where("expires_at", ">", now()).orderBy("created_at").execute();
  return {
    devices: devices.map((row) => ({
      id: row.id,
      name: row.name,
      pairedAt: row.paired_at.toISOString(),
      lastSeenAt: row.last_seen_at.toISOString(),
      revoked: row.revoked_at !== null,
    })),
    pairingCodes: codes.map((row) => ({ id: row.id, deviceName: row.device_name, expiresAt: row.expires_at.toISOString() })),
  };
}

/**
 * Counter devices: the owner's device list, pairing codes and revocation; pairing and token renewal (public, proved
 * by the code or the device key); and the routes a paired device calls (AC 17, 18, 21).
 */
export function deviceRoutes(app: FastifyInstance, options: DeviceRoutesOptions, done: (error?: Error) => void): void {
  const { db } = options;
  const limits = {
    codesPerOwner: new RateLimiter(20, HOUR * 1000),
    // Failures only: the counters share the café's Wi-Fi (one address) with its customers, so counting every
    // request would let anyone there use up the budget and block pairing and renewals.
    pairFailuresPerIp: new RateLimiter(10, 15 * MINUTE * 1000),
    renewFailuresPerIp: new RateLimiter(30, 15 * MINUTE * 1000),
    // A paired device renews about once an hour; this only stops a runaway one.
    renewalsPerDevice: new RateLimiter(30, HOUR * 1000),
  };

  /**
   * Reserves a failure for `client` before the slow check, refunded when the attempt succeeds, so parallel attempts
   * cannot all pass a check made before any of them is counted.
   */
  function reserveFailure(limiter: RateLimiter, client: string, reply: FastifyReply): void {
    const wait = limiter.check(client);
    if (wait > 0) {
      throw rateLimited(reply, wait);
    }
    limiter.hit(client);
  }

  function enforce(limiter: RateLimiter, key: string, reply: FastifyReply): void {
    const wait = limiter.hit(key);
    if (wait > 0) {
      throw rateLimited(reply, wait);
    }
  }

  app.get("/devices", { config: { access: "owner" } }, async (request) => withCafe(db, ownerOf(request).cafeId, listDevices));

  /** A single-use code to pair a new device, shown once: as text and, through pairingUrl, as a QR. */
  app.post("/devices/pairing-codes", { config: { access: "owner" } }, async (request, reply) => {
    const owner = ownerOf(request);
    enforce(limits.codesPerOwner, owner.ownerId, reply);
    const body = parseInput(pairingCodeCreateSchema, request.body);
    // The 4-character lookup part only needs to be unique among stored codes; a rare clash just draws again.
    for (let attempt = 1; ; attempt += 1) {
      const code = newPairingCode();
      try {
        const created = await withCafe(db, owner.cafeId, async (trx) => {
          await trx.deleteFrom("pairing_codes").where("expires_at", "<=", now()).execute();
          const row = await trx
            .insertInto("pairing_codes")
            .values({
              cafe_id: owner.cafeId,
              owner_id: owner.ownerId,
              device_name: body.deviceName,
              lookup_hash: hashToken(code.slice(0, PAIRING_CODE_LOOKUP_LENGTH)),
              secret_hash: hashToken(code.slice(PAIRING_CODE_LOOKUP_LENGTH)),
              expires_at: secondsFromNow(PAIRING_CODE_TTL_SECONDS),
            })
            .returning(["id", "expires_at"])
            .executeTakeFirstOrThrow();
          await audit(trx, { cafeId: owner.cafeId, actorType: "owner", actorId: owner.ownerId, action: "pairing_code.created", entityType: "pairing_code", entityId: row.id });
          return row;
        });
        const pairingUrl = new URL("/pair", options.counterUrl);
        pairingUrl.hash = `code=${code}`;
        request.log.info({ cafeId: owner.cafeId }, "pairing code created");
        return await reply.code(201).send({
          id: created.id,
          deviceName: body.deviceName,
          code: formatPairingCode(code),
          pairingUrl: pairingUrl.toString(),
          expiresAt: created.expires_at.toISOString(),
        });
      } catch (error) {
        if (attempt >= 3 || !isUniqueViolation(error, "pairing_codes_lookup_hash_key")) {
          throw error;
        }
      }
    }
  });

  app.delete("/devices/pairing-codes/:id", { config: { access: "owner" } }, async (request, reply) => {
    const owner = ownerOf(request);
    const { id } = parseInput(idParams, request.params);
    await withCafe(db, owner.cafeId, async (trx) => {
      const deleted = await trx.deleteFrom("pairing_codes").where("id", "=", id).executeTakeFirst();
      if (deleted.numDeletedRows === 0n) {
        throw new ApiError("NOT_FOUND", "This pairing code was already used, cancelled or expired.");
      }
      await audit(trx, { cafeId: owner.cafeId, actorType: "owner", actorId: owner.ownerId, action: "pairing_code.cancelled", entityType: "pairing_code", entityId: id });
    });
    request.log.info({ cafeId: owner.cafeId }, "pairing code cancelled");
    return reply.code(204).send();
  });

  /**
   * Revokes a device: it can no longer renew or do anything new, and learns DEVICE_REVOKED on its next contact. Until
   * its current token expires it may still hand over its queue; those events, and any its keys signed, are held for
   * the owner's review (AC 21), even after the device is paired again.
   */
  app.post("/devices/:id/revoke", { config: { access: "owner" } }, async (request) => {
    const owner = ownerOf(request);
    const { id } = parseInput(idParams, request.params);
    return withCafe(db, owner.cafeId, async (trx) => {
      const current = await trx.selectFrom("devices").select("revoked_at").where("id", "=", id).forUpdate().executeTakeFirst();
      if (current === undefined) {
        throw new ApiError("NOT_FOUND", "This device does not exist. Reload the page to see the current list.");
      }
      if (current.revoked_at === null) {
        await trx.updateTable("devices").set({ revoked_at: now() }).where("id", "=", id).execute();
        await trx.updateTable("device_keys").set({ revoked_at: now() }).where("device_id", "=", id).where("revoked_at", "is", null).execute();
        await audit(trx, { cafeId: owner.cafeId, actorType: "owner", actorId: owner.ownerId, action: "device.revoked", entityType: "device", entityId: id });
        request.log.info({ cafeId: owner.cafeId, deviceId: id }, "device revoked");
      }
      return listDevices(trx);
    });
  });

  /**
   * Pairs a device: proves the code, registers the device's public key and issues an access token (AC 17). A device
   * that proves it holds one of its old keys (`previous`) keeps its id, so its queue still syncs (AC 18); its other
   * keys are retired and its old tokens dropped. A proof that fails, or names a device of another café, pairs a new
   * device instead. A phone whose old key belongs to another café is refused (PAIRED_ELSEWHERE) without using the
   * code, since it may still hold that café's unsent events; it pairs here only without `previous`. Any counter build
   * may pair, so an old one that must pair again can still hand over its queue (AC 26).
   */
  app.post("/device/pair", { config: { access: "public" } }, async (request, reply) => {
    const client = clientKey(request.ip);
    reserveFailure(limits.pairFailuresPerIp, client, reply);
    const body = parseInput(pairRequestSchema, request.body);
    if (importDeviceKey(body.publicKey) === undefined) {
      throw new ApiError("VALIDATION_FAILED", "The device's key is not valid. Reload the counter app and pair again.", [
        { path: "publicKey", issue: "Not a P-256 public key." },
      ]);
    }
    const lookupHash = hashToken(body.code.slice(0, PAIRING_CODE_LOOKUP_LENGTH));
    // The lookup part only finds the code's café; the secret is checked below, under the code's row lock.
    const found = await withLookup(db, { secretHash: lookupHash }, (trx) =>
      trx.selectFrom("pairing_codes").select(["id", "cafe_id"]).where("lookup_hash", "=", lookupHash).executeTakeFirst(),
    );
    if (found === undefined) {
      request.log.info("pairing refused: unknown code");
      throw invalidCode();
    }
    const previousKeyId = body.previous?.keyId;
    // Which café the phone's old key belongs to, whatever the code's café (only the key id is needed to look).
    const previousKey =
      previousKeyId === undefined
        ? undefined
        : await withLookup(db, { deviceKeyId: previousKeyId }, (trx) => trx.selectFrom("device_keys").select("cafe_id").where("id", "=", previousKeyId).executeTakeFirst());
    const outcome = await withCafe(db, found.cafe_id, async (trx) => {
      // Locked, so parallel guesses are checked and counted one at a time and the fifth wrong one always burns it.
      const code = await trx
        .selectFrom("pairing_codes")
        .select(["secret_hash", "device_name", "owner_id"])
        .where("id", "=", found.id)
        .where("expires_at", ">", now())
        .forUpdate()
        .executeTakeFirst();
      if (code === undefined) {
        return { kind: "invalid" } as const;
      }
      if (!timingSafeEqual(hashToken(body.code.slice(PAIRING_CODE_LOOKUP_LENGTH)), code.secret_hash)) {
        const counted = await trx
          .updateTable("pairing_codes")
          .set({ failed_attempts: sql<number>`failed_attempts + 1` })
          .where("id", "=", found.id)
          .returning("failed_attempts")
          .executeTakeFirstOrThrow();
        if (counted.failed_attempts < PAIRING_CODE_MAX_ATTEMPTS) {
          return { kind: "wrong" } as const;
        }
        await trx.deleteFrom("pairing_codes").where("id", "=", found.id).execute();
        await audit(trx, { cafeId: found.cafe_id, actorType: "system", actorId: null, action: "pairing_code.burned", entityType: "pairing_code", entityId: found.id });
        return { kind: "burned" } as const;
      }
      if (previousKey !== undefined && previousKey.cafe_id !== found.cafe_id) {
        return { kind: "elsewhere" } as const;
      }
      // Deleting the code is what uses it, so it pairs one device only.
      await trx.deleteFrom("pairing_codes").where("id", "=", found.id).execute();
      const previous = body.previous === undefined ? undefined : await provenDevice(trx, body.code, body.previous, body.publicKey);
      let deviceId: string;
      if (previous === undefined) {
        deviceId = (await trx.insertInto("devices").values({ cafe_id: found.cafe_id, name: code.device_name }).returning("id").executeTakeFirstOrThrow()).id;
      } else {
        deviceId = previous.deviceId;
        await trx
          .updateTable("devices")
          .set({ name: code.device_name, revoked_at: null, last_renewed_at: now(), last_seen_at: now() })
          .where("id", "=", deviceId)
          .execute();
        await trx.updateTable("device_keys").set({ retired_at: now() }).where("device_id", "=", deviceId).where("retired_at", "is", null).execute();
        await trx.deleteFrom("device_tokens").where("device_id", "=", deviceId).execute();
      }
      const { kty, crv, x, y } = body.publicKey;
      const key = await trx
        .insertInto("device_keys")
        .values({ cafe_id: found.cafe_id, device_id: deviceId, public_key: JSON.stringify({ kty, crv, x, y }) })
        .returning("id")
        .executeTakeFirstOrThrow();
      const token = await issueDeviceToken(trx, found.cafe_id, deviceId);
      const cafe = await trx.selectFrom("cafes").select(["id", "name"]).where("id", "=", found.cafe_id).executeTakeFirstOrThrow();
      await audit(trx, {
        cafeId: found.cafe_id,
        actorType: "device",
        actorId: deviceId,
        action: previous === undefined ? "device.paired" : "device.paired_again",
        entityType: "device",
        entityId: deviceId,
        changes: { pairingCodeId: found.id, approvedBy: code.owner_id, ...(previous === undefined ? {} : { wasRevoked: previous.wasRevoked }) },
      });
      return { kind: "paired", repaired: previous !== undefined, paired: { deviceId, keyId: key.id, deviceName: code.device_name, cafe, ...token } } as const;
    });
    if (outcome.kind === "elsewhere") {
      // The code was right: not a failed pairing from this address.
      limits.pairFailuresPerIp.refund(client);
      request.log.info({ cafeId: found.cafe_id }, "pairing refused: phone still paired with another café");
      throw new ApiError(
        "PAIRED_ELSEWHERE",
        "This phone is still paired with another café and may hold stamps it has not sent there. Pair it with that café first, or start over on the phone.",
      );
    }
    if (outcome.kind !== "paired") {
      const log = { cafeId: found.cafe_id, outcome: outcome.kind };
      if (outcome.kind === "burned") {
        request.log.warn(log, "pairing code burned after repeated wrong tries");
      } else {
        request.log.info(log, "pairing refused");
      }
      throw invalidCode();
    }
    const paired = outcome.paired;
    limits.pairFailuresPerIp.refund(client);
    request.log.info({ cafeId: found.cafe_id, deviceId: paired.deviceId, pairedAgain: outcome.repaired }, "device paired");
    return reply.code(201).send(paired);
  });

  /**
   * Renews a device's access token with a signature from its key (AC 18). A renewal must be signed after the last
   * accepted one (no replay), within the clock-skew window, and within 7 days of the last renewal.
   */
  app.post("/device/token", { config: { access: "public" } }, async (request, reply) => {
    const client = clientKey(request.ip);
    // An address over its failure budget is still checked: a correctly signed renewal always goes through, so junk
    // from the café's shared Wi-Fi cannot lock the counters out; only further failures are answered 429.
    const overLimitWait = limits.renewFailuresPerIp.check(client);
    if (overLimitWait === 0) {
      limits.renewFailuresPerIp.hit(client);
    }
    const body = parseInput(tokenRenewalRequestSchema, request.body);
    const issuedAt = new Date(body.issuedAt);
    if (Math.abs(Date.now() - issuedAt.getTime()) > RENEWAL_CLOCK_SKEW_MS) {
      throw new ApiError("VALIDATION_FAILED", "This device's clock is off by more than 5 minutes. Set the phone's date and time to automatic, then try again.", [
        { path: "issuedAt", issue: "Outside the accepted clock skew." },
      ]);
    }
    const key = await withLookup(db, { deviceKeyId: body.keyId }, (trx) =>
      trx.selectFrom("device_keys").select(["cafe_id", "device_id", "public_key"]).where("id", "=", body.keyId).executeTakeFirst(),
    );
    const publicKey = key?.device_id === body.deviceId ? importDeviceKey(key.public_key) : undefined;
    if (key === undefined || publicKey === undefined || !verifyDeviceSignature(publicKey, deviceTokenSigningPayload(body), body.signature)) {
      request.log.warn({ cafeId: key?.cafe_id ?? null }, "token renewal refused: unknown key or bad signature");
      throw overLimitWait > 0 ? rateLimited(reply, overLimitWait) : pairingRequired();
    }
    // Signed by the device's key: not a failure from this address, and from here on limited per device instead.
    if (overLimitWait === 0) {
      limits.renewFailuresPerIp.refund(client);
    }
    enforce(limits.renewalsPerDevice, key.device_id, reply);
    const token = await withCafe(db, key.cafe_id, async (trx) => {
      const device = await trx
        .selectFrom("devices")
        .select(["revoked_at", "last_renewal_issued_at", sql<boolean>`last_renewed_at < ${secondsAgo(DEVICE_RENEWAL_WINDOW_SECONDS)}`.as("stale")])
        .where("id", "=", key.device_id)
        .forUpdate()
        .executeTakeFirst();
      // Read under the device's lock, which pairing again also takes, so a key it retires never renews afterwards.
      const signingKey = await trx.selectFrom("device_keys").select("retired_at").where("id", "=", body.keyId).executeTakeFirstOrThrow();
      // A missing device row (undefined) counts as revoked too.
      if (device?.revoked_at !== null) {
        request.log.info({ cafeId: key.cafe_id, deviceId: key.device_id }, "token renewal refused: device revoked");
        throw new ApiError("DEVICE_REVOKED", "The owner removed this device. Pair it again from the owner's dashboard to use it.");
      }
      if (device.stale) {
        request.log.info({ cafeId: key.cafe_id, deviceId: key.device_id }, "token renewal refused: not renewed for 7 days");
        throw pairingRequired();
      }
      // The device paired again with a newer key; this one only verifies the events it signed (AC 18).
      if (signingKey.retired_at !== null) {
        request.log.info({ cafeId: key.cafe_id, deviceId: key.device_id }, "token renewal refused: not the device's newest key");
        throw pairingRequired();
      }
      // A stored issuedAt beyond the skew window means the server clock stepped back since; refusing on it would
      // lock the device out until the clock caught up, and a replay of that renewal fails the skew check anyway.
      const last = device.last_renewal_issued_at;
      if (last !== null && last.getTime() <= Date.now() + RENEWAL_CLOCK_SKEW_MS && issuedAt.getTime() <= last.getTime()) {
        request.log.info({ cafeId: key.cafe_id, deviceId: key.device_id }, "token renewal refused: issuedAt not after the last renewal");
        throw new ApiError("VALIDATION_FAILED", "This renewal was already used. The device signs a new one for each attempt; try again.", [
          { path: "issuedAt", issue: "Not later than the last accepted renewal." },
        ]);
      }
      await trx
        .updateTable("devices")
        .set({ last_renewed_at: now(), last_renewal_issued_at: issuedAt, last_seen_at: now() })
        .where("id", "=", key.device_id)
        .execute();
      return issueDeviceToken(trx, key.cafe_id, key.device_id);
    });
    request.log.info({ cafeId: key.cafe_id, deviceId: key.device_id }, "device token renewed");
    return token;
  });

  app.get("/device/me", { config: { access: "device" } }, async (request) => {
    requireSupportedBuild(request, options.releaseBuiltAt);
    const device = deviceOf(request);
    return withCafe(db, device.cafeId, async (trx) => {
      const row = await trx
        .selectFrom("devices")
        .innerJoin("cafes", "cafes.id", "devices.cafe_id")
        .select(["devices.id as deviceId", "devices.name as deviceName", "cafes.id as cafeId", "cafes.name as cafeName"])
        .where("devices.id", "=", device.deviceId)
        .executeTakeFirstOrThrow();
      return { deviceId: row.deviceId, deviceName: row.deviceName, cafe: { id: row.cafeId, name: row.cafeName } };
    });
  });

  /** Active staff with their PIN hashes, so the device can check PINs offline (AC 19). */
  app.get("/device/staff", { config: { access: "device" } }, async (request) => {
    requireSupportedBuild(request, options.releaseBuiltAt);
    const device = deviceOf(request);
    const rows = await withCafe(db, device.cafeId, (trx) =>
      trx.selectFrom("staff").select(["id", "name", "pin_salt", "pin_hash", "pin_iterations"]).where("revoked_at", "is", null).orderBy("name").execute(),
    );
    return {
      staff: rows.map((row) => ({
        id: row.id,
        name: row.name,
        pinSalt: row.pin_salt.toString("base64url"),
        pinHash: row.pin_hash.toString("base64url"),
        pinIterations: row.pin_iterations,
      })),
    };
  });

  done();
}
