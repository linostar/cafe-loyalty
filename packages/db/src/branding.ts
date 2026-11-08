import type { CardColors } from "@cafe-loyalty/shared";
import type { Transaction } from "kysely";
import type { Database } from "./schema.js";

/** What every card of a café shows of it: its name, its card colours and its logo's hash (null: the product's logo). */
export interface CafeBranding {
  id: string;
  name: string;
  colors: CardColors;
  logoHash: Buffer | null;
}

/** A café's logo in the sizes its cards use, with the SHA-256 of the square PNG. */
export interface CafeLogoImages {
  hash: Buffer;
  square: Buffer;
  apple1x: Buffer;
  apple2x: Buffer;
  apple3x: Buffer;
}

/** A café's branding, read inside its withCafe. */
export async function loadCafeBranding(trx: Transaction<Database>, cafeId: string): Promise<CafeBranding> {
  const cafe = await trx
    .selectFrom("cafes")
    .leftJoin("cafe_logos", "cafe_logos.cafe_id", "cafes.id")
    .select(["cafes.id", "cafes.name", "cafes.card_background", "cafes.card_foreground", "cafes.card_label", "cafe_logos.hash"])
    .where("cafes.id", "=", cafeId)
    .executeTakeFirstOrThrow();
  return { id: cafe.id, name: cafe.name, colors: { background: cafe.card_background, foreground: cafe.card_foreground, label: cafe.card_label }, logoHash: cafe.hash };
}

/** The Apple logo.png images of a café's logo, or undefined without one (the pass then has the product's). */
export async function loadAppleLogo(trx: Transaction<Database>, cafeId: string): Promise<{ apple1x: Buffer; apple2x: Buffer; apple3x: Buffer } | undefined> {
  const logo = await trx.selectFrom("cafe_logos").select(["apple_1x", "apple_2x", "apple_3x"]).where("cafe_id", "=", cafeId).executeTakeFirst();
  return logo === undefined ? undefined : { apple1x: logo.apple_1x, apple2x: logo.apple_2x, apple3x: logo.apple_3x };
}

/** Sets or replaces a café's logo, inside its withCafe; its triggers mark the café's passes changed (migration 0024). */
export async function saveCafeLogo(trx: Transaction<Database>, cafeId: string, images: CafeLogoImages): Promise<void> {
  const values = { hash: images.hash, square: images.square, apple_1x: images.apple1x, apple_2x: images.apple2x, apple_3x: images.apple3x };
  await trx
    .insertInto("cafe_logos")
    .values({ cafe_id: cafeId, ...values })
    .onConflict((conflict) => conflict.column("cafe_id").doUpdateSet(values))
    .execute();
}

/** Removes a café's logo (its cards go back to the product's); true when it had one. */
export async function removeCafeLogo(trx: Transaction<Database>, cafeId: string): Promise<boolean> {
  const removed = await trx.deleteFrom("cafe_logos").where("cafe_id", "=", cafeId).executeTakeFirst();
  return removed.numDeletedRows > 0n;
}

/** Where a café's logo is served, publicly (Google fetches it, the web card shows it): by its hash, naming no café. */
export const cafeLogoPath = (hash: Buffer): string => `/logos/${hash.toString("hex")}.png`;
