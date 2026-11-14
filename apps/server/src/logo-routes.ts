import { loadStampMask, removeCafeLogo, removeCafePicture, saveCafeLogo, saveCafePicture, withCafe, withLookup, type CafeLogoImages, type CafePictureImages, type Database } from "@cafe-loyalty/db";
import { ApiError, apiText, isSilhouetteShape, type StampShape } from "@cafe-loyalty/shared";
import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import { sql, type Kysely, type Transaction } from "kysely";
import { z } from "zod";
import { audit } from "./db-helpers.js";
import { STAMP_MASK_VERSION, silhouetteOf, stampPictureSilhouette, stampSilhouette } from "./logo-image.js";

/** Who changed a café's logo, for its audit entry. */
export interface LogoActor {
  actorType: "owner" | "operator";
  actorId: string;
}

const fileParams = z.object({ file: z.string().regex(/^[0-9a-f]{64}(?:-stamp)?\.png$/) });

/**
 * The silhouette ("From logo" or "From picture" stamps) with this hash (its own SHA-256), whatever its café, and whether
 * it is a picture's (whose empty stamps are drawn otherwise), or undefined. Addresses issued before migration 0039 named
 * the logo's hash instead: those still find the current logo's silhouette.
 */
export async function findStampMask(db: Kysely<Database>, hash: Buffer): Promise<{ stampMask: Buffer; picture: boolean } | undefined> {
  const found = await withLookup(db, { secretHash: hash }, async (trx) => {
    const logo = await trx
      .selectFrom("cafe_logos")
      .select("stamp_mask")
      .where((where) => where.or([where("stamp_mask_hash", "=", hash), where("hash", "=", hash)]))
      .where("stamp_mask", "is not", null)
      .limit(1)
      .executeTakeFirst();
    if (logo?.stamp_mask != null) {
      return { stampMask: logo.stamp_mask, picture: false };
    }
    const picture = await trx.selectFrom("cafe_pictures").select("stamp_mask").where("stamp_mask_hash", "=", hash).limit(1).executeTakeFirst();
    return picture === undefined ? undefined : { stampMask: picture.stamp_mask, picture: true };
  });
  return found;
}

/**
 * Serves café logos by the hash of their square PNG (`<hash>.png`): publicly, since Google fetches the class logo and
 * the web card shows it, and found through withLookup, so the address names no café. `<hash>-stamp.png` is a
 * silhouette, by its own hash (a re-cut is a new address), which the web card's and the dashboard's "From logo" stamps are masked with. Registered at the
 * root (the public domain; immutable, the address changing with the image) and under `/api` (the dashboard, whose own
 * domain only forwards `/api`; `config` then declares its public access).
 */
export function registerLogoFiles(app: FastifyInstance, db: Kysely<Database>, options: { config?: { access: "public" }; immutable: boolean }): void {
  app.get("/logos/:file", { ...(options.config === undefined ? {} : { config: options.config }) }, async (request, reply) => {
    const params = fileParams.safeParse(request.params);
    const hash = params.success ? Buffer.from(params.data.file.slice(0, 64), "hex") : undefined;
    const stamp = params.success && params.data.file.endsWith("-stamp.png");
    // The current logo, or the one it replaced (Google's class and open web cards show it until their update arrives).
    const found =
      hash === undefined || stamp
        ? undefined
        : await withLookup(db, { secretHash: hash }, (trx) =>
            trx
              .selectFrom("cafe_logos")
              .select(["hash", "square", "previous_square"])
              .where((where) => where.or([where("hash", "=", hash), where("previous_hash", "=", hash)]))
              .limit(1)
              .executeTakeFirst(),
          );
    const logo =
      hash !== undefined && stamp
        ? (await findStampMask(db, hash))?.stampMask
        : found === undefined
          ? undefined
          : hash !== undefined && found.hash?.equals(hash) === true
            ? found.square
            : found.previous_square;
    if (logo === undefined || logo === null) {
      return reply.code(404).header("content-type", "text/plain; charset=utf-8").send("Not found");
    }
    if (options.immutable) {
      void reply.header("cache-control", "public, max-age=31536000, immutable");
    }
    return reply.code(200).header("content-type", "image/png").header("x-content-type-options", "nosniff").send(logo);
  });
}

/** Sets a café's logo (already processed, outside the transaction), inside its withCafe, and audits it by its hash. */
export async function setLogo(trx: Transaction<Database>, cafeId: string, images: CafeLogoImages, actor: LogoActor): Promise<void> {
  await saveCafeLogo(trx, cafeId, images);
  await audit(trx, { cafeId, ...actor, action: "cafe.logo_set", entityType: "cafe", entityId: cafeId, changes: { hash: images.hash.toString("hex") } });
}

/**
 * Locks the café's row (FOR NO KEY UPDATE) for the rest of the transaction: a logo removal and a "From logo" pick take
 * it first, so one waits for the other and never decides on a silhouette the other is changing.
 */
const lockCafe = (trx: Transaction<Database>, cafeId: string) => trx.selectFrom("cafes").select("id").where("id", "=", cafeId).forNoKeyUpdate().execute();

/**
 * Removes a café's logo, its cards going back to the product's (and a "From logo" café to the circle, migration 0037);
 * audited, with the removed image's hash, when there was one.
 */
export async function unsetLogo(trx: Transaction<Database>, cafeId: string, actor: LogoActor): Promise<void> {
  await lockCafe(trx, cafeId);
  const removed = await removeCafeLogo(trx, cafeId);
  if (removed !== undefined) {
    await audit(trx, { cafeId, ...actor, action: "cafe.logo_removed", entityType: "cafe", entityId: cafeId, changes: { hash: removed.toString("hex") } });
  }
}

/**
 * Sets a café's "From picture" picture (already processed, outside the transaction) and picks it for the café's stamps,
 * inside its withCafe under the café's row lock; audited by the silhouette's hash.
 */
export async function setPicture(trx: Transaction<Database>, cafeId: string, picture: CafePictureImages, actor: LogoActor): Promise<void> {
  await lockCafe(trx, cafeId);
  await saveCafePicture(trx, cafeId, picture);
  await trx.updateTable("cafes").set({ stamp_shape: "picture" }).where("id", "=", cafeId).where("stamp_shape", "<>", "picture").execute();
  await audit(trx, { cafeId, ...actor, action: "cafe.picture_set", entityType: "cafe", entityId: cafeId, changes: { stampMaskHash: picture.stampMaskHash.toString("hex"), stampShape: "picture" } });
}

/** Removes a café's "From picture" picture (a café on it going back to the circle, migration 0040); audited when there was one. */
export async function unsetPicture(trx: Transaction<Database>, cafeId: string, actor: LogoActor): Promise<void> {
  await lockCafe(trx, cafeId);
  const removed = await removeCafePicture(trx, cafeId);
  if (removed !== undefined) {
    await audit(trx, { cafeId, ...actor, action: "cafe.picture_removed", entityType: "cafe", entityId: cafeId, changes: { stampMaskHash: removed.toString("hex") } });
  }
}

/**
 * Refuses "From logo" for a café whose logo has no silhouette (no logo, or one uploaded before migration 0037), and
 * "From picture" for one without a picture, inside its withCafe: the stamps would have nothing to be drawn from.
 */
export async function refuseLogoStampWithoutLogo(trx: Transaction<Database>, cafeId: string, shape: StampShape | undefined): Promise<void> {
  if (shape === undefined || !isSilhouetteShape(shape)) {
    return;
  }
  // Read after any removal the lock waited for, so the pick sees its committed result (or the removal, once this
  // commits, sees the shape and moves it to the circle).
  await lockCafe(trx, cafeId);
  if ((await loadStampMask(trx, cafeId, shape)) === undefined) {
    const issue = shape === "picture" ? apiText("Upload a picture first: these stamps are made from it.") : apiText("Upload the logo first: these stamps are made from it.");
    throw new ApiError("VALIDATION_FAILED", issue, [{ path: "stampShape", issue }]);
  }
}

/**
 * Cuts again, from its stored square, every logo whose silhouette is missing or cut by an older STAMP_MASK_VERSION, and
 * every "From picture" picture cut by an older one (cafes_with_outdated_stamp_masks, migrations 0039 and 0040), each
 * inside its café's withCafe under the café's row lock and only while the image is still the one read; a new silhouette
 * marks the passes of a café drawing its stamps from it (triggers, 0039 and 0040). Run in the background at start-up: a
 * café that fails is logged and left for the next start. Returns how many silhouettes were cut.
 */
export async function recutStampMasks(db: Kysely<Database>, log: FastifyBaseLogger): Promise<number> {
  const { rows } = await sql<{ cafe_id: string }>`SELECT cafe_id FROM app.cafes_with_outdated_stamp_masks(${STAMP_MASK_VERSION})`.execute(db);
  let recut = 0;
  for (const { cafe_id: cafeId } of rows) {
    try {
      const done = await withCafe(db, cafeId, async (trx) => {
        await lockCafe(trx, cafeId);
        let cut = 0;
        const logo = await trx.selectFrom("cafe_logos").select(["hash", "square", "stamp_mask_version"]).where("cafe_id", "=", cafeId).executeTakeFirst();
        if (logo?.hash != null && logo.square !== null && (logo.stamp_mask_version ?? 0) < STAMP_MASK_VERSION) {
          const silhouette = silhouetteOf(await stampSilhouette(logo.square));
          await trx
            .updateTable("cafe_logos")
            .set({ stamp_mask: silhouette.stampMask, stamp_mask_for: logo.hash, stamp_mask_hash: silhouette.stampMaskHash, stamp_mask_version: silhouette.stampMaskVersion })
            .where("cafe_id", "=", cafeId)
            .where("hash", "=", logo.hash)
            .execute();
          cut += 1;
        }
        // The "From picture" picture, while it is still the one read (its square is replaced with each upload).
        const picture = await trx.selectFrom("cafe_pictures").select(["square", "stamp_mask_hash", "stamp_mask_version"]).where("cafe_id", "=", cafeId).executeTakeFirst();
        if (picture !== undefined && picture.stamp_mask_version < STAMP_MASK_VERSION) {
          const silhouette = silhouetteOf(await stampPictureSilhouette(picture.square));
          await trx
            .updateTable("cafe_pictures")
            .set({ stamp_mask: silhouette.stampMask, stamp_mask_hash: silhouette.stampMaskHash, stamp_mask_version: silhouette.stampMaskVersion })
            .where("cafe_id", "=", cafeId)
            .where("stamp_mask_hash", "=", picture.stamp_mask_hash)
            .execute();
          cut += 1;
        }
        return cut;
      });
      recut += done;
    } catch (error) {
      log.error({ err: error, cafeId }, "stamp silhouette re-cut failed");
    }
  }
  return recut;
}
