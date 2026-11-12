import { loadStampMask, removeCafeLogo, saveCafeLogo, withLookup, type CafeLogoImages, type Database } from "@cafe-loyalty/db";
import { ApiError, apiText, type StampShape } from "@cafe-loyalty/shared";
import type { FastifyInstance } from "fastify";
import type { Kysely, Transaction } from "kysely";
import { z } from "zod";
import { audit } from "./db-helpers.js";

/** Who changed a café's logo, for its audit entry. */
export interface LogoActor {
  actorType: "owner" | "operator";
  actorId: string;
}

const fileParams = z.object({ file: z.string().regex(/^[0-9a-f]{64}(?:-stamp)?\.png$/) });

/** The silhouette ("From logo" stamps) of the current logo with this hash, whatever its café, or undefined. */
export async function findStampMask(db: Kysely<Database>, hash: Buffer): Promise<Buffer | undefined> {
  const found = await withLookup(db, { secretHash: hash }, (trx) => trx.selectFrom("cafe_logos").select("stamp_mask").where("hash", "=", hash).limit(1).executeTakeFirst());
  return found?.stamp_mask ?? undefined;
}

/**
 * Serves café logos by the hash of their square PNG (`<hash>.png`): publicly, since Google fetches the class logo and
 * the web card shows it, and found through withLookup, so the address names no café. `<hash>-stamp.png` is the current
 * logo's silhouette, which the web card's and the dashboard's "From logo" stamps are masked with. Registered at the
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
        ? await findStampMask(db, hash)
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

/** Removes a café's logo, its cards going back to the product's; audited, with the removed image's hash, when there was one. */
export async function unsetLogo(trx: Transaction<Database>, cafeId: string, actor: LogoActor): Promise<void> {
  const removed = await removeCafeLogo(trx, cafeId);
  if (removed !== undefined) {
    await audit(trx, { cafeId, ...actor, action: "cafe.logo_removed", entityType: "cafe", entityId: cafeId, changes: { hash: removed.toString("hex") } });
  }
}

/**
 * Refuses "From logo" for a café whose logo has no silhouette (no logo, or one uploaded before migration 0037), inside
 * its withCafe: the stamps would have nothing to be drawn from.
 */
export async function refuseLogoStampWithoutLogo(trx: Transaction<Database>, cafeId: string, shape: StampShape | undefined): Promise<void> {
  if (shape === "logo" && (await loadStampMask(trx, cafeId)) === undefined) {
    const issue = apiText("Upload the logo first: these stamps are made from it.");
    throw new ApiError("VALIDATION_FAILED", issue, [{ path: "stampShape", issue }]);
  }
}
