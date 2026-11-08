import { removeCafeLogo, saveCafeLogo, withLookup, type CafeLogoImages, type Database } from "@cafe-loyalty/db";
import type { FastifyInstance } from "fastify";
import type { Kysely, Transaction } from "kysely";
import { z } from "zod";
import { audit } from "./db-helpers.js";

/** Who changed a café's logo, for its audit entry. */
export interface LogoActor {
  actorType: "owner" | "operator";
  actorId: string;
}

const fileParams = z.object({ file: z.string().regex(/^[0-9a-f]{64}\.png$/) });

/**
 * Serves café logos by the hash of their square PNG (`<hash>.png`): publicly, since Google fetches the class logo and
 * the web card shows it, and found through withLookup, so the address names no café. Registered at the root (the
 * public domain; immutable, the address changing with the image) and under `/api` (the dashboard, whose own domain
 * only forwards `/api`; `config` then declares its public access).
 */
export function registerLogoFiles(app: FastifyInstance, db: Kysely<Database>, options: { config?: { access: "public" }; immutable: boolean }): void {
  app.get("/logos/:file", { ...(options.config === undefined ? {} : { config: options.config }) }, async (request, reply) => {
    const params = fileParams.safeParse(request.params);
    const hash = params.success ? Buffer.from(params.data.file.slice(0, 64), "hex") : undefined;
    const logo =
      hash === undefined
        ? undefined
        : await withLookup(db, { secretHash: hash }, (trx) => trx.selectFrom("cafe_logos").select("square").where("hash", "=", hash).limit(1).executeTakeFirst());
    if (logo === undefined) {
      return reply.code(404).header("content-type", "text/plain; charset=utf-8").send("Not found");
    }
    if (options.immutable) {
      void reply.header("cache-control", "public, max-age=31536000, immutable");
    }
    return reply.code(200).header("content-type", "image/png").header("x-content-type-options", "nosniff").send(logo.square);
  });
}

/** Sets a café's logo (already processed, outside the transaction), inside its withCafe, and audits it by its hash. */
export async function setLogo(trx: Transaction<Database>, cafeId: string, images: CafeLogoImages, actor: LogoActor): Promise<void> {
  await saveCafeLogo(trx, cafeId, images);
  await audit(trx, { cafeId, ...actor, action: "cafe.logo_set", entityType: "cafe", entityId: cafeId, changes: { hash: images.hash.toString("hex") } });
}

/** Removes a café's logo, its cards going back to the product's; audited when there was one. */
export async function unsetLogo(trx: Transaction<Database>, cafeId: string, actor: LogoActor): Promise<void> {
  if (await removeCafeLogo(trx, cafeId)) {
    await audit(trx, { cafeId, ...actor, action: "cafe.logo_removed", entityType: "cafe", entityId: cafeId, changes: {} });
  }
}
