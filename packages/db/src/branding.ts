import type { CardColors, StampShape } from "@cafe-loyalty/shared";
import type { Transaction } from "kysely";
import type { Database } from "./schema.js";

/**
 * What every card of a café shows of it: its name, its card colours, its logo's hash (null: the product's logo) and the
 * shape its stamps are drawn in.
 */
export interface CafeBranding {
  id: string;
  name: string;
  colors: CardColors;
  logoHash: Buffer | null;
  stampShape: StampShape;
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
    .select(["cafes.id", "cafes.name", "cafes.card_background", "cafes.card_foreground", "cafes.card_label", "cafes.stamp_shape", "cafe_logos.hash"])
    .where("cafes.id", "=", cafeId)
    .executeTakeFirstOrThrow();
  return {
    id: cafe.id,
    name: cafe.name,
    colors: { background: cafe.card_background, foreground: cafe.card_foreground, label: cafe.card_label },
    logoHash: cafe.hash,
    stampShape: cafe.stamp_shape,
  };
}

/** What a picture of a card's stamps shows: the shape, the card's background and text colours, and its count. */
export interface StampPicture {
  shape: StampShape;
  background: string;
  foreground: string;
  stamps: number;
  required: number;
}

/**
 * Where a picture of a card's stamps is served, publicly (Google fetches it for the pass's hero image): built only from
 * what it shows, so it names no card, café or customer, and a new count or look is a new address. A card past full
 * (stamps keep counting) shows every stamp full.
 */
export const stampPicturePath = (picture: StampPicture): string =>
  `/stamps/${picture.shape}-${picture.background.slice(1)}-${picture.foreground.slice(1)}-${String(Math.min(picture.stamps, picture.required))}-${String(picture.required)}.png`;

/** The Apple logo.png images of a café's logo, or undefined without one (the pass then has the product's). */
export async function loadAppleLogo(trx: Transaction<Database>, cafeId: string): Promise<{ apple1x: Buffer; apple2x: Buffer; apple3x: Buffer } | undefined> {
  const logo = await trx.selectFrom("cafe_logos").select(["apple_1x", "apple_2x", "apple_3x"]).where("cafe_id", "=", cafeId).executeTakeFirst();
  // A removed logo leaves its row, with no images.
  return logo?.apple_1x == null || logo.apple_2x === null || logo.apple_3x === null
    ? undefined
    : { apple1x: logo.apple_1x, apple2x: logo.apple_2x, apple3x: logo.apple_3x };
}

/**
 * Sets or replaces a café's logo, inside its withCafe; its triggers mark the café's passes changed and keep the logo it
 * replaces served until the next change (migration 0024).
 */
export async function saveCafeLogo(trx: Transaction<Database>, cafeId: string, images: CafeLogoImages): Promise<void> {
  const values = { hash: images.hash, square: images.square, apple_1x: images.apple1x, apple_2x: images.apple2x, apple_3x: images.apple3x };
  await trx
    .insertInto("cafe_logos")
    .values({ cafe_id: cafeId, ...values })
    .onConflict((conflict) => conflict.column("cafe_id").doUpdateSet(values))
    .execute();
}

/**
 * Removes a café's logo (its cards go back to the product's), still served as the previous one until the next change;
 * the removed logo's hash, or undefined when it had none.
 */
export async function removeCafeLogo(trx: Transaction<Database>, cafeId: string): Promise<Buffer | undefined> {
  const removed = await trx
    .updateTable("cafe_logos")
    .set({ hash: null, square: null, apple_1x: null, apple_2x: null, apple_3x: null })
    .where("cafe_id", "=", cafeId)
    .where("hash", "is not", null)
    // The row as keep_previous_logo left it: the removed logo is now the previous one.
    .returning("previous_hash")
    .executeTakeFirst();
  return removed?.previous_hash ?? undefined;
}

/** Where a café's logo is served, publicly (Google fetches it, the web card shows it): by its hash, naming no café. */
export const cafeLogoPath = (hash: Buffer): string => `/logos/${hash.toString("hex")}.png`;
